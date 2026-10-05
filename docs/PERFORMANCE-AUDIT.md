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

| Family                                    |   Self-size |
| ----------------------------------------- | ----------: |
| Native external string data               |    24.6 MiB |
| Native ArrayBuffer data                   |    13.5 MiB |
| Plain objects                             |     9.7 MiB |
| Compiled code                             |    18.1 MiB |
| Strings                                   |    16.5 MiB |
| Arrays                                    |    11.9 MiB |
| Numbers                                   |     7.7 MiB |
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

1. Cache trail-cell lists per entry and invalidate them only when the trail or
   displayed pose changes.
2. Preserve selected-entry priority but cap selected trail cells separately
   from the ambient fleet budget.
3. Run a controlled same-scene browser trace to isolate GC and dropped-frame changes.

The capture also reinforces the Overpass deployment priority: failed road
queries and unavailable local service add network retries and cache churn while
the application is already performing expensive transit work.

### Implementation update: Transit floor rereads

The first mitigation slice is now implemented in
`src/layers/transit/height.js`:

- rereads process entries in resumable 6 ms slices;
- a new anchor or clear cancels the pending reread job;
- overlapping reread callbacks are ignored;
- the unconditional second `prepareEntry()` pass was removed; and
- `floorReread` diagnostics expose duration, candidate count, cell count, DEM
  admissions, mesh admissions, yield count, and running state.

The focused Transit and Developer diagnostics tests pass, and the production
build succeeds.

### Post-change diagnostic comparison

The post-change artifacts are:

- `diag/Trace-20260928T130157.json.gz`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-02-32-361Z.json`
- `diag/Trace-20260928T130819.json.gz`
- `diag/Heap-20260928T131007.heaptimeline`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-08-09-727Z.json`
- `diag/Trace-20260928T131824.json.gz`
- `diag/Heap-20260928T132014.heaptimeline`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-20-09-689Z.json`
- `diag/Trace-20260928T132945.json.gz`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-31-46-829Z.json`
- `diag/Trace-20260928T133920.json.gz`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-40-24-009Z.json`
- `diag/Trace-20260928T135500.json.gz`
- `diag/gods-eye-view-diagnostics-2026-09-28T17-55-19-163Z.json`

The maximum observed JavaScript timer slice decreased from approximately
3,593 ms in the original trace to approximately 530 ms in the post-change
trace. The post-change Gods Eye snapshot recorded one completed Transit floor
cycle with 377 candidates, 1,366 cells, 37 yields, and 448 ms total duration.
This confirms that the time-budgeting change removes the original multi-second
monolithic callback.

The traces are not identical workloads: the post-change recording is longer
and contains more frames and GC activity. Its 62 major-GC events and 58.3 ms
maximum major collection require a controlled same-scene rerun before being
classified as a regression. The next measurement should hold layer state,
camera path, capture duration, and enabled diagnostics constant.

### Latest trace: Transit visibility sweep is the next hotspot

The newest artifacts show that the floor-reread fix moved the dominant timer
work rather than eliminating all Transit cost:

- The latest diagnostic reports a valid rolling `35 FPS` measurement, a
  `28.6 ms` average frame interval, and a `93.3 ms` P95 interval.
- Transit floor reread duration is down to `320 ms` for 427 candidates and 355
  cells, with 8 yields.
- The newest trace's longest JavaScript callback is approximately `1,183 ms`.
  Its deployed bundle location maps to `refreshVisibility()` in
  `src/layers/transit/rendering.js`.
- `refreshVisibility()` scans every vehicle and can perform playback updates,
  Cartesian conversion, `camera.getPixelSize()`, horizon tests, frustum-plane
  tests, marker writes, scheduling, and conditional trail preparation for each
  entry. This is now the next confirmed Transit main-thread hotspot.

The visibility-sweep mitigations are now implemented:

1. Time-budget the visibility sweep and resume from an entry cursor.
2. Snapshot camera-derived pixel radius and frustum data for the sweep instead of
   recomputing expensive values for every unchanged entry.
3. Avoid `prepareEntry()` during the sweep unless visibility admission or
   surface state actually changed.
4. Keep selected and previously visible entries in a priority queue while
   processing the ambient fleet in bounded batches.

### Implementation update: Transit visibility sweep

The visibility sweep is now processed in resumable 6 ms slices over a stable
vehicle and camera/frustum snapshot. The sweep yields through zero-delay timer
callbacks instead of holding the main thread for the full fleet. Small fleets
still complete in one call, while large fleets retain selected/visible state
and converge to the same visibility result.

The focused Transit suite passes all 98 tests, including large-fleet fixtures.
The latest browser trace confirms that the previous approximately 1,183 ms
application callback no longer appears among the dominant calls.

The newest heap snapshot contains 3,198,512 nodes, 10,323,034 edges, and
157.3 MiB of node self-size. Native allocations account for 77.6 MiB in that
snapshot, while the diagnostic JSON reports 297 MiB of live JS heap. These
values are not a leak verdict because the enabled layers and capture point do
not exactly match the earlier snapshot, but they justify retaining heap
measurement in the next controlled run.

### Visibility-sweep result

The visibility-sweep implementation has now been measured:

- The prior trace contained a 1,183 ms application callback mapped to
  `refreshVisibility()`.
- In the newest trace, no comparable application-bundle callback appears in
  the top long calls. The largest non-tooling JavaScript slice is about 417 ms
  in Cesium itself.
- The latest diagnostic reports `53 FPS`, a `19.0 ms` average frame interval,
  and a `49.0 ms` P95 interval.
- Transit floor reread remains bounded at `287 ms` for 270 candidates and 993
  cells across 12 yields.
- The latest heap snapshot is `127.3 MiB` node self-size, down from `157.3 MiB`
  in the previous snapshot. The diagnostic reports `122 MiB` live JS heap,
  down from `297 MiB`; the captures still differ in enabled layers and timing,
  so this is a favorable observation rather than a controlled memory proof.

The trace's largest 602 ms slice is `CpuProfiler::StartProfiling`, which is
DevTools overhead and not application work. The next meaningful investigation
is therefore Cesium's approximately 417 ms render/geometry callback, followed
by a controlled same-scene capture without profiler-start overhead.

### Pan-only trace: Developer diagnostics projection cost

The pan-only trace `diag/Trace-20260928T134243.json.gz` contains 11,784 mouse
move events and repeated 120-158 ms application callbacks at the same deployed
bundle location. Mapping that location identifies the Developer Mode asset
refresh path, whose `countInView()` projection scans up to 10,000 objects per
enabled layer every refresh.

This is diagnostic overhead during camera movement, not Cesium rendering. The
asset list now caches the expensive in-view projection for 3 seconds while
invalidating immediately when enabled-layer populations or update timestamps
change. The Developer Mode test suite passes all 8 tests. A new pan trace is
still needed to measure the reduction directly.

The follow-up artifacts are `diag/Trace-20260928T134711.json.gz` and
`diag/gods-eye-view-diagnostics-2026-09-28T17-47-58-226Z.json`. The follow-up
trace no longer shows the repeated 120-158 ms named Developer asset-refresh
callbacks among its dominant long calls, which is consistent with the cache
working. It is not a clean A/B: the run is longer, contains 13,104 mouse moves,
12,918 flights, 6,844 vessels, five continuous holds, 16 FPS, and 488 MiB live
heap. Therefore the direct FPS improvement from this diagnostic change remains
unquantified.

### High-volume stress capture

The latest trace is a different stress scenario and must not be compared as a
like-for-like regression test. It enables:

- 13,037 flights;
- 12,000 live vessels;
- 263 military contacts;
- traffic, transit, bikeshare, radio, and other active layers; and
- five continuous-render holds: `ais-vessels`, `flights`, `military`,
  `traffic`, and `transit`.

Under that workload, the diagnostic reports `7 FPS`, a `140.5 ms` average frame
interval, a `246.9 ms` P95 interval, 1,252 long tasks, and 270 MiB live JS
heap. Transit has 608 vehicles and its floor job remains active after 7.8 s,
with 17 yields and 2,030 cells. The trace contains 3,870 dropped frames over
approximately 33.6 seconds.

This confirms the combined high-volume scene as a separate P0/P1 workload:
the individual Transit visibility callback is no longer the dominant isolated
application slice, but the aggregate continuous animation and Cesium work is
still overwhelming the frame budget. The next optimization should prioritize
cross-layer render-hold coordination and high-volume fleet update budgets,
especially for flights and vessels, rather than further tuning the already
sliced Transit visibility pass.

### Implementation update: hidden fleet frame budgets

Flights and Military now preserve visible and tracked contact updates while
rotating a bounded 4 ms budget across hidden contacts on each fleet tick. The
off-screen cursor advances across ticks so large hidden cohorts are not
permanently starved, while visible contacts continue through the existing
motion, horizon, model, and styling paths.

The focused flights and military suite passes 134 tests. A new high-volume
browser trace is still required to measure aggregate FPS and Cesium command
pressure under the 13,000-flight/12,000-vessel scenario.

### Shared scheduler result

The post-scheduler artifacts provide a partial stress comparison. The latest
diagnostic still has a similar high-volume population: 12,685 flights, 7,085
vessels, 254 military contacts, and five continuous holds. It reports `16 FPS`
and a `60.7 ms` average frame interval, effectively unchanged from the prior
16 FPS stress capture.

The trace tail improved: the prior capture contained 3.19 s and 811 ms
application/runtime slices, while the post-scheduler trace's largest
non-profiler task is approximately 172 ms. This indicates the shared budget
reduces long hidden-fleet bursts, but does not improve aggregate FPS under the
current workload. The next dominant limit is likely visible fleet work, AIS
visibility/label processing, or Cesium command/upload pressure.

The Developer budget readout recorded `flights-hidden` at 4.1 ms and
`military-hidden` at 0.7 ms in its latest sample. These are current-window
diagnostics, not cumulative trace totals.

### Implementation update: shared fleet frame budget

Flights and Military now join a shared 12 ms per-frame coordinator. Their
hidden-contact work is admitted only while shared budget remains, while visible
and tracked contacts retain their existing update path. Owner timings are
available through Developer performance diagnostics for `flights-hidden` and
`military-hidden`.

The scheduler and focused fleet tests pass. A controlled high-volume trace is
still required to measure aggregate FPS and confirm that vessel and Cesium
command pressure, rather than hidden aircraft work, is the remaining limit.

### Latest hidden-fleet trace

The newest capture is not a controlled A/B run: vessels decreased from 12,000
to 5,446, Transit no longer held continuous rendering, and the flight count
changed from 13,037 to 12,746. FPS rose from `7.1` to `8.8`, but that change
cannot be attributed to the hidden-fleet budget alone.

The latest diagnostic reports `604 MiB` live JS heap, 331 long tasks, and a
Transit floor cycle of `728 ms` for 528 candidates and 431 cells. The trace
still contains a 3.19 s unattributed `RunTask` and an 811 ms application
FunctionCall, so aggregate high-volume work remains unresolved. A controlled
capture with identical populations and holds is required before further fleet
budget tuning.

### Traffic recovery and diagnostics-export bottleneck

The latest Boston diagnostic confirms that the traffic data path is now
working: 2,703 roads are loaded, flow coverage is 95%, ten flow tiles were
fetched, and the local OSM cache is serving road/tunnel/transit requests with
local, disk, and memory hits. The remaining road-cache errors are limited and
are no longer the original all-requests-public-mirror failure.

The same diagnostic reports a 20.7-second maximum long task and 414 MiB live
heap while its exported Transit route data contains full line geometry. The
default Developer diagnostics snapshot was requesting
`includeGeometry: true`, copying thousands of route coordinates into the
export and creating avoidable serialization/allocation pressure. It now
requests route metadata and line counts without geometry; full geometry
remains available through the explicit route diagnostics API.

The focused Developer tests pass and the production build succeeds. A new
diagnostic export is required to quantify the reduction in export-time heap and
long-task cost.

### Root cause: uncapped, per-parse `scene.sampleHeight()` during traffic pans

A pan-only trace (`Trace-20260928T150347.json.gz`) captured multi-second
freezes reported as "still having the same performance issues related to
traffic": three `RunTask`/`RunMicrotasks` main-thread tasks of **11.57 s**,
**7.02 s**, and **4.33 s**. Reconstructing the CPU profile for the renderer
main thread showed the time was overwhelmingly spent in
`readPixels` — 66%, 63%, and 60% of samples respectively — reached through
Cesium's `Scene.sampleHeight()` via the stack `sampleHeight → ... → readPixels`.

`scene.sampleHeight()` is a synchronous GPU readback: it forces the render
pipeline to flush and blocks the main thread until the GPU replies. Traffic's
`parseRoads()` ([src/layers/traffic/model.js](../src/layers/traffic/model.js))
already deduplicated calls per ~111 m cell, but the dedup cache was recreated
on every `parseRoads()` invocation and had no cap on new samples per pass. A
pan that reveals hundreds of never-before-seen cells at once (a dense road
network, e.g. Boston) made every one of those cells pay for its own
synchronous GPU stall in a single tight loop — exactly the multi-second
main-thread block seen in the trace.

Fix: the height-cell cache is now persisted on `layerState._heightCellCache`
for the traffic layer's lifetime (session-scoped, mirroring the established
`meshFloorSampler.js` one-shot-cell pattern), and each `parseRoads()` pass is
capped at `MAX_HEIGHT_SAMPLES_PER_PARSE = 40` **new** `sampleHeight()` calls
([src/layers/traffic/policy.js](../src/layers/traffic/policy.js)). Cells
beyond the cap are left unsampled (height 0 for that pass only, not cached)
and retried on the next pass instead of latching a wrong height. The debug
timing twin (`parseRoadsTimed` in
[src/layers/traffic/timing.js](../src/layers/traffic/timing.js)) mirrors the
same cache/cap so causal-timing captures match production behavior.

New focused tests
([src/layers/traffic/model.test.mjs](../src/layers/traffic/model.test.mjs))
cover the cap, cross-pass cache reuse, and cap-skip retry. All 29 traffic
tests and the production build pass.

### Follow-up: count cap alone still stalled 300-560ms under GPU contention

A second dense-panning trace (`Trace-20260928T151258.json.gz`), captured
after the fix above, confirmed the worst-case main-thread stall dropped from
**11.57s to 563ms** — a ~20x reduction — but repeated stalls of 300-560ms
still appeared throughout the pan, still dominated by `readPixels` (60-66% of
samples in each) reached through the same
`sampleHeight → ... → readPixels` stack.

The fixed count cap (40 calls) doesn't adapt to how expensive each call
currently is: under the GPU contention in this capture, each `sampleHeight()`
call cost ~14ms, so 40 calls in one pass still cost ~560ms. Added
`MAX_HEIGHT_SAMPLE_MS_PER_PARSE = 8` in
[src/layers/traffic/policy.js](../src/layers/traffic/policy.js): the sampling
loop in `parseRoads()` now bails out once cumulative `sampleHeight()` time for
the pass exceeds 8ms, in addition to the existing 40-call ceiling — whichever
limit is hit first. On an idle/cheap GPU this still allows up to 40 calls per
pass; under contention it now bails after roughly one call instead of
continuing to the full count. The debug timing twin mirrors the same budget.

A new test (`parseRoads bails out early once cumulative sampleHeight time
exceeds budget`) simulates a costly `sampleHeight()` and asserts the pass
stops well short of the count ceiling. All 30 traffic tests and the
production build pass. A third trace under the same dense-panning scenario
would confirm the remaining stalls shrink further; the mechanism is
well-evidenced from the two captures already gathered.

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

| Area                  | Evidence                                                            |                                   Blocking risk | Priority |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------: | -------: |
| Local Overpass import | Current container is unhealthy and preprocessing an 18.1 GB extract |                         High operational impact |       P0 |
| CCTV activation       | 19,608 ms measured cold activation                                  | Main-thread bursts plus terrain/network latency |       P0 |
| Detection overlay     | 34.4 FPS at 100% density; 48k to 54k text draws in combined tests   |             Main-thread and canvas/GPU pressure |       P0 |
| AIS vessels           | 12,000-vessel test population; 22 to 30 FPS in keyed baseline       |          High per-frame and reconciliation cost |       P1 |
| FIRMS                 | 100,430 detections in the keyed baseline                            |           Memory, parsing, and overlay pressure |       P1 |
| Traffic               | 4,222 dots and 45 to 52 FPS in the keyed baseline                   |                     Geometry and animation cost |       P1 |
| Wind                  | Up to 7,200 curves with up to 33 points each                        |                   GPU upload and animation cost |       P1 |
| Weather               | Up to 4096x2048 images and detail windows                           |         Decode, upload, and GPU memory pressure |       P1 |
| Submarine cables      | 412 MiB heap in the documented baseline                             |                Retained geometry and GPU memory |       P1 |
| Datacenters           | 328 MiB heap in the documented baseline                             |   Large static GeoJSON and primitive allocation |       P1 |
| Startup bundle        | Approximately 2.6 MB main JS plus large Cesium/data assets          |                Startup parse/compile and memory |       P2 |

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

This has now been corrected: fresh memory hits refresh insertion order before
returning, and the focused proxy tests verify hot-entry promotion.

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

### P0/P1: Budget combined high-volume animation

The latest stress capture reaches 7 FPS with flights, vessels, military,
traffic, transit, bikeshare, and radio active together. Add cross-layer frame
budgets and render-hold diagnostics before optimizing another isolated layer:

- cap fleet interpolation work per frame and carry the remainder forward;
- prioritize on-screen and selected contacts;
- release or downgrade holds when a layer has no visible motion; and
- measure aggregate Cesium upload/command work separately from JavaScript
  callback time.

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

- Add hit, stale-hit, miss, and upstream latency accounting.
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

Use Chrome DevTools Performance and Memory panels together with the existing Puppeteer QA scripts. The September 28 captures now confirm the Transit timer improvement; a controlled same-scene rerun is still needed to isolate GC, dropped-frame, and retained-memory changes from workload differences.

## Bottom Line

The most important immediate issue is the unhealthy local Overpass deployment. Until the import completes or is replaced with a smaller development extract, network fallback will dominate map-data latency.

After that, prioritize:

1. Time-budget Transit floor rereads.
2. Fix local Overpass readiness and failed-road retry churn.
3. Profile CCTV activation and preserve visible-first loading.
4. Audit detection repaint and render-hold visibility.
5. Reprofile high-volume memory after the current traffic/cache optimizations.

The remaining geometry fade transition is visually useful, but lower priority than Overpass readiness, CCTV activation cost, detection frame time, and high-volume memory retention.
