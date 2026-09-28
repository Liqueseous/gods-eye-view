# Performance Audit

**Audit date:** September 28, 2026  
**Scope:** Browser runtime, Cesium rendering, data layers, server providers, caches, Docker deployment, startup/shutdown, performance tooling, and documented baselines.

## Executive Summary

The largest performance risks are:

1. The local Overpass container is still importing and unhealthy. Road, transit, tunnel, and infrastructure queries therefore fall back to public mirrors.
2. CCTV cold activation is the largest documented activation cost: 19.6 seconds for 48 cameras.
3. Detection overlays are the largest documented steady-state rendering cost: approximately 34 FPS at 100% density.
4. Combined scenes can exceed 872 MiB of JavaScript heap.
5. AIS and live FIRMS populations create high-volume rendering and reconciliation pressure.
6. Any active continuous-render hold keeps Cesium rendering continuously, even if only one layer is animating.
7. Large weather images, wind curves, and Cesium geometry uploads can create bursty main-thread and GPU work.

The project already has strong foundations: request-render mode, bounded caches, staggered queues, cancellation, LOD filtering, geometry simplification, center-first loading, and adaptive traffic dot limits.

## Captured Diagnostics: September 28, 2026

Artifacts analyzed:

- `diag/Trace-20260928T123653.json.gz`
- `diag/Heap-20260928T123908.heaptimeline`

The trace contains 233,397 events over approximately 23.8 seconds. The heap
snapshot contains 3,309,831 nodes and 10,534,408 edges with approximately
129.7 MiB of node self-size. This is a single snapshot, so it identifies
retained memory families but cannot prove a leak without a before/after or
post-GC comparison.

### Trace findings

- The trace contains 2,158 `DroppedFrame` events.
- There are 329 main-thread frame events and 2,869 begin-frame events, showing
  substantial frame production pressure and missed presentation opportunities.
- Repeated timer callbacks run for approximately 3.59 s, 1.79 s, 1.61 s,
  0.99 s, and 0.70 s. These are application JavaScript callbacks, not network
  waits.
- The longest callbacks execute the deployed bundle's minified function `C`.
  Mapping the recorded bundle location to the source implementation identifies
  Transit floor rereads in `src/layers/transit/height.js`.
- `rereadFloors()` filters the fleet, sorts entries, calls
  `parts.trails.prepareEntry()` for every candidate, builds per-entry Maps and
  arrays, performs DEM and mesh-floor admission, and then prepares the trail
  entries again. With many visible or in-view vehicles, this is an expensive
  repeated O(entries × trail-samples) timer path.
- The same path is retried through `FLOOR_REREAD_MS`, so a slow pass can overlap
  user interaction and consume several seconds of the trace window.
- `Paint` totals approximately 73 ms and raster work approximately 30 ms in the
  trace. The dominant stall is therefore JavaScript timer work, not CSS paint.
- The trace records 318 minor GCs and 11 major GCs. Minor GC totals about 208
  ms; major GC totals about 44 ms, with a maximum major collection of about
  11.4 ms. Garbage collection contributes pressure but does not explain the
  multi-second stalls by itself.

### Heap findings

Largest self-size families in the captured heap:

| Family | Self-size |
|---|---:|
| Native external string data | 24.6 MiB |
| Native ArrayBuffer data | 13.5 MiB |
| Plain objects | 9.7 MiB |
| Compiled code | 18.1 MiB |
| Strings | 16.5 MiB |
| Arrays | 11.9 MiB |
| Numbers | 7.7 MiB |
| Maps/object shapes and related structures | several MiB |

There are approximately 397,000 plain `Object` instances and 52,000 Maps.
The heap also contains 217,218 copies of the string `way`, consistent with
large OSM/Overpass geometry and route payload activity. This should be
verified against retained paths in a second snapshot before treating it as a
leak.

The snapshot's captured Developer Mode DOM text reports `roads-major` with 36
errors and no upstream hits while transit route tiles show memory and disk
hits. This is consistent with the local Overpass instance being unavailable
and road requests repeatedly failing or falling back during the capture.

### New diagnosis

The primary freeze mechanism in this capture is Transit floor rereading, not
the detection canvas or GPU paint path. The existing audit's Transit section
should therefore be treated as P0/P1 work:

1. Make floor rereads time-budgeted and resumable, yielding after a bounded
   number of entries or milliseconds.
2. Avoid calling `parts.trails.prepareEntry()` twice for the same entry in one
   reread unless the first call changed the floor state.
3. Cache trail-cell lists per entry and invalidate them only when the trail or
   displayed pose changes.
4. Preserve selected-entry priority but cap selected trail cells separately
   from the ambient fleet budget.
5. Coalesce a pending reread rather than scheduling another timer while a prior
   pass is still executing.
6. Record `transit-floor-reread` duration, candidate count, cell count, DEM
   admissions, mesh admissions, and yield count in the Developer diagnostics.

The capture also reinforces the Overpass deployment priority: failed road
queries and unavailable local service add network retries and cache churn while
the application is already performing expensive transit work.

## Runtime Model

### Browser

- Cesium scene and most layer rendering run on the browser main thread.
- Data layers own lifecycle, ingestion, rendering, selection, and cache state.
- Detection uses a shared canvas/world-overlay host.
- Cesium animation is coordinated by `src/renderGovernor.js`.
- Most animations use `preRender`, `postRender`, `setTimeout`, or `requestAnimationFrame`.
- Heavy parsing and geometry construction generally happen on the main thread.

### Server

- Vite middleware provides API providers and caching.
- Overpass uses in-memory cache, persistent disk cache, in-flight request coalescing, stale-data fallback, and concurrency/request-size limits.
- The local Overpass Docker container is a separate process with a mounted database volume.
- There is no conventional application database; the Overpass database is the main database-like workload.

### Major Data Flow

```text
Camera or layer activation
  -> viewport calculation
  -> cache lookup
  -> network/provider request
  -> response parsing
  -> normalization/simplification
  -> Cesium object construction
  -> render/update scheduling
  -> animation or idle render
```

## Hotspot Map

| Area | Evidence | Blocking risk | Priority |
|---|---|---:|---:|
| Local Overpass import | Current container is unhealthy and preprocessing an 18.1 GB extract | High operational impact | P0 |
| CCTV activation | 19,608 ms measured cold activation | Main-thread bursts plus terrain/network latency | P0 |
| Detection overlay | 34.4 FPS at 100% density; 48k to 54k text draws in combined tests | Main-thread and canvas/GPU pressure | P0 |
| AIS vessels | 12,000-vessel test population; 22 to 30 FPS in keyed baseline | High per-frame and reconciliation cost | P1 |
| FIRMS | 100,430 detections in the keyed baseline | Memory, parsing, and overlay pressure | P1 |
| Traffic | 4,222 dots and 45 to 52 FPS in the keyed baseline | Geometry and animation cost | P1 |
| Wind | Up to 7,200 curves with up to 33 points each | GPU upload and animation cost | P1 |
| Weather | Up to 4096x2048 images and detail windows | Decode, upload, and GPU memory pressure | P1 |
| Submarine cables | 412 MiB heap in the documented baseline | Retained geometry and GPU memory | P1 |
| Datacenters | 328 MiB heap in the documented baseline | Large static GeoJSON and primitive allocation | P1 |
| Startup bundle | Approximately 2.6 MB main JS plus large Cesium/data assets | Startup parse/compile and memory | P2 |

The documented baseline is from August 22, 2026 on an Apple M5. It is historical evidence, not a current Windows measurement.

## Likely Freeze and Stall Mechanisms

### Local Overpass readiness

Until the local import finishes:

- the local Overpass server does not listen on port 80;
- Docker healthchecks fail;
- the app proxy falls back to public Overpass mirrors; and
- road, transit, and tunnel requests become network-bound and unpredictable.

This is currently the clearest deployment-level performance problem.

### CCTV activation bursts

The CCTV queue is already staggered and yields between batches in `src/layers/cctv/geometryQueue.js`. The documented 19.6-second activation should not automatically be treated as one continuous 19-second freeze.

The remaining cost likely combines catalog acquisition, terrain warming, synchronous per-record projection, Cesium object construction, coverage geometry, and first-card image work. Phase-level timing is needed before parallelization.

### Detection canvas work

Dense detection performs candidate projection, occlusion checks, label arbitration, placement collision checks, bracket drawing, text drawing, and fade animation. The current implementation already avoids the older per-label `measureText()` path through fixed-width calculations in `src/data/detectionDraw.js`.

### Continuous-render hold interactions

The render governor is globally binary:

- one active hold means continuous Cesium rendering;
- zero holds means request-render mode.

A single enabled animated layer can therefore keep the entire scene in continuous mode. Holds should be audited when layers have no visible animated objects or are outside their active camera range.

### High-volume object animation

Flights, military flights, vessels, traffic, satellites, and other moving layers perform repeated Cartesian updates, visibility checks, label candidate collection, property writes, and temporary allocations. Combined scenes are more concerning than any one layer in isolation.

## Existing Optimizations That Are Working

- Render governor and request-render mode
- Identity-keyed render holds
- Staggered CCTV geometry queues
- Camera-priority CCTV geometry loading
- Overpass request cancellation
- In-flight request coalescing
- Memory and disk cache caps
- Stale Overpass response fallback
- OSM tile chunking
- Center-first tile admission
- Traffic road geometry simplification
- Traffic adaptive dot caps
- Transit route retention-margin unloading
- Weather staged replacement
- Weather cancellation and cache eviction
- Wind batch culling
- Detection frame skipping under expensive paint
- Stable label cohorts and deterministic selection

## Existing Issues and Assumptions

### Overpass cache is not a true LRU

`server/providers/overpass/cache.js` evicts the oldest inserted map entry. Cache hits do not refresh insertion order, so the memory cache is FIFO-like rather than true LRU.

### Large disk-cache serialization can block Node

`JSON.stringify(payload)` occurs before the asynchronous disk write. Large responses can therefore block the Node event loop even though the filesystem write is asynchronous.

### Cache status is not directly exposed

The client receives cache headers, but there is no simple diagnostics endpoint showing memory entries, disk entries, hit/miss rates, stale responses, upstream latency, active requests, and local Overpass health together.

### Some traffic documentation is stale

Older traffic issue text describes one viewport tile at a time, while the current implementation now includes OSM chunking, flow-tile caching, center-first ordering, geometry simplification, and adaptive dot budgets. The traffic baseline should be rerun.

## Prioritized Recommendations

### P0: Fix local Overpass deployment

1. Make initialization progress persistent and observable.
2. Confirm whether the container is restarting during preprocessing.
3. Separate `importing` from `unhealthy` in health reporting.
4. Do not route requests to the local instance until `/api/status` succeeds.
5. Consider a smaller regional extract for development.
6. Add a provider/cache health endpoint to the app.

This improves road, traffic, transit, tunnel, ALPR, and infrastructure loading together.

### P0: Add phase timing to CCTV activation

Measure catalog fetch, normalization, terrain warmup, geometry projection, Cesium construction, first-card fetch, and final queue drain separately. Then choose between larger batches, device-adaptive batches, worker-based pure projection, stronger visible-first prioritization, or deferred off-screen geometry.

### P0: Time-budget Transit floor rereads

The captured trace shows the Transit floor reread timer monopolizing the main
thread for multi-second intervals. Apply the six mitigations in the captured
diagnostics section before tuning visual density or GPU effects.

### P1: Reduce detection repaint work

- Cache composed label text by record/version.
- Cache label-card measurements by text/font/character width.
- Rebuild placements only when camera, layout, or cohort changes.
- Keep bracket geometry on a cheaper per-frame path.
- Use an adaptive label budget when frame time exceeds 16.7 ms.

### P1: Audit continuous-render ownership

Add diagnostics for active hold owner, hold duration, last mutation time, visible animated object count, and active camera-range status. Release holds when a layer has no visible animation work.

### P1: Reprofile live high-volume scenes

Use:

- `scripts/qa-perf.mjs`
- `scripts/qa-traffic-baseline.mjs`
- `scripts/qa-weather-perf.mjs`
- `scripts/qa-transit-scenes.mjs`
- `scripts/qa-labels.mjs`

Record renderer, viewport, device pixel ratio, live population counts, heap before/after enable/disable, motion/rest FPS, cache state, and network concurrency.

### P2: Improve cache accounting

- Convert the Overpass memory cache to true LRU.
- Track cache hits, stale hits, misses, and upstream latency.
- Bound refusal-cooldown state independently.
- Avoid repeated large JSON parsing when a canonical serialized payload can be reused.
- Expose cache health in developer diagnostics and a server endpoint.

### P2: Reduce large static-layer memory

For cables, datacenters, dams, and similar layers:

- release raw GeoJSON after normalization;
- use typed coordinate buffers where practical;
- load regionally instead of globally;
- avoid duplicate geographic and Cartesian coordinate copies;
- release source payloads after primitive construction; and
- verify disable/destroy releases primitives and arrays.

### P2: Make weather and wind adaptive

Scale image size, wind curve count, detail-window resolution, and playback work based on device limits, camera altitude, camera motion, and recent frame time.

## Measurement Plan

Record the following for startup and every major layer:

```text
startup:
  bundle fetch
  parse/compile
  Cesium viewer init
  first render
  settled render

layer activation:
  request latency
  parse/normalize time
  geometry construction time
  primitive upload time
  first visible object
  final settled state
  heap delta
  retained heap after disable

steady state:
  FPS
  main-thread frame time
  GPU frame time where available
  JS heap
  object count
  label count
  draw/text counts
  active render holds
  network concurrency
  cache hit/miss/stale state
```

Use Chrome DevTools Performance and Memory panels together with the existing Puppeteer QA scripts. The September 28 capture now provides a current trace-backed Transit diagnosis, but a before/after capture is still needed to confirm the effect of the fix and to distinguish retained memory from normal Cesium/browser allocations.

## Bottom Line

The most important immediate issue is the unhealthy local Overpass deployment. Until the import completes or is replaced with a smaller development extract, network fallback will dominate map-data latency.

After that, prioritize:

1. Time-budget Transit floor rereads.
2. Fix local Overpass readiness and failed-road retry churn.
3. Profile CCTV activation and preserve visible-first loading.
4. Audit detection repaint and render-hold visibility.
5. Reprofile high-volume memory after the current traffic/cache optimizations.

The remaining geometry fade transition is visually useful, but lower priority than Overpass readiness, CCTV activation cost, detection frame time, and high-volume memory retention.
