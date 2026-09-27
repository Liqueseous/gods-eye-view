export const OSM_CACHE_TILE_DEGREES = 0.1;
export const OSM_CACHE_MAX_TILES_PER_QUERY = 16;
const OSM_CACHE_FETCH_CONCURRENCY = 3;
const OSM_CACHE_DIAGNOSTICS_MAX_TILES = 256;
const OSM_LOCAL_TILE_CACHE_TTL_MS = 15 * 60 * 1000;
const OSM_LOCAL_TILE_CACHE_MAX_ENTRIES = 256;
let activeOsmTileRequests = 0;
const pendingOsmTileRequests = [];
const observedOsmTiles = new Map();
const localOsmTileCache = new Map();

function trimLocalOsmTileCache() {
  while (localOsmTileCache.size > OSM_LOCAL_TILE_CACHE_MAX_ENTRIES) {
    const oldestKey = localOsmTileCache.keys().next().value;
    if (!oldestKey) break;
    localOsmTileCache.delete(oldestKey);
  }
}

function localOsmTileCacheKey(sourceId, queryBody) {
  return `${sourceId}:${queryBody}`;
}

function readLocalOsmTileCache(key, now = Date.now()) {
  const entry = localOsmTileCache.get(key);
  if (!entry) return null;
  if (now - entry.cachedAt > OSM_LOCAL_TILE_CACHE_TTL_MS) {
    localOsmTileCache.delete(key);
    return null;
  }
  // Refresh insertion order for oldest-first eviction.
  localOsmTileCache.delete(key);
  localOsmTileCache.set(key, entry);
  return new Response(JSON.stringify(entry.payload), {
    status: entry.status,
    headers: {
      'content-type': 'application/json',
      'x-overpass-cache': 'LOCAL',
      'x-overpass-upstream': entry.upstream || 'local-cache',
    },
  });
}

async function maybeWriteLocalOsmTileCache(key, response) {
  if (!response?.ok || typeof response.clone !== 'function') return;
  try {
    const payload = await response.clone().json();
    if (!Array.isArray(payload?.elements)) return;
    localOsmTileCache.set(key, {
      status: Number(response.status) || 200,
      payload,
      upstream: response.headers?.get?.('x-overpass-upstream') || null,
      cachedAt: Date.now(),
    });
    trimLocalOsmTileCache();
  } catch {
    // Ignore local-cache write failures and keep the network response path.
  }
}

function tileBoundsKey(bounds) {
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((value) => Number(value.toFixed(3)))
    .join(',');
}

function observeOsmTile(sourceId, bounds, response, error = null) {
  const key = `${sourceId}:${tileBoundsKey(bounds)}`;
  const previous = observedOsmTiles.get(key);
  const entry = previous || {
    sourceId,
    bounds: { ...bounds },
    requests: 0,
    cacheHits: 0,
    diskHits: 0,
    upstreamFetches: 0,
    staleResponses: 0,
    errors: 0,
  };
  entry.lastRequestedAt = Date.now();
  if (!response && !error) {
    entry.requests += 1;
    entry.error = null;
    entry.lastStatus = 'LOADING';
  } else {
    entry.error = error
      ? String(error.message || error)
      : response && !response.ok
        ? `HTTP ${response.status || 'ERROR'}`
        : null;
    if (error || (response && !response.ok)) {
      entry.lastStatus = error ? 'ERROR' : `HTTP ${response.status || 'ERROR'}`;
      entry.errors += 1;
    } else if (response) {
      entry.lastStatus =
        response.headers?.get?.('x-overpass-cache') || 'UNKNOWN';
      if (entry.lastStatus === 'DISK') entry.diskHits += 1;
      else if (entry.lastStatus === 'STALE') entry.staleResponses += 1;
      else if (['HIT', 'INFLIGHT', 'LOCAL'].includes(entry.lastStatus))
        entry.cacheHits += 1;
      else if (['MISS', 'UPSTREAM'].includes(entry.lastStatus))
        entry.upstreamFetches += 1;
    }
  }
  observedOsmTiles.delete(key);
  observedOsmTiles.set(key, entry);
  while (observedOsmTiles.size > OSM_CACHE_DIAGNOSTICS_MAX_TILES) {
    observedOsmTiles.delete(observedOsmTiles.keys().next().value);
  }
}

export function getOsmTileCacheDiagnostics() {
  const sources = new Map();
  const totals = {
    requests: 0,
    cacheHits: 0,
    diskHits: 0,
    upstreamFetches: 0,
    staleResponses: 0,
    errors: 0,
  };
  for (const entry of observedOsmTiles.values()) {
    let source = sources.get(entry.sourceId);
    if (!source) {
      source = {
        id: entry.sourceId,
        tileCount: 0,
        requests: 0,
        cacheHits: 0,
        diskHits: 0,
        upstreamFetches: 0,
        staleResponses: 0,
        errors: 0,
        tiles: [],
      };
      sources.set(entry.sourceId, source);
    }
    source.tileCount += 1;
    source.tiles.push({ ...entry, bounds: { ...entry.bounds } });
    for (const key of Object.keys(totals)) {
      source[key] += entry[key] || 0;
      totals[key] += entry[key] || 0;
    }
  }
  return {
    tileDegrees: OSM_CACHE_TILE_DEGREES,
    maxTilesPerRequest: OSM_CACHE_MAX_TILES_PER_QUERY,
    activeRequests: activeOsmTileRequests,
    pendingRequests: pendingOsmTileRequests.length,
    knownTiles: observedOsmTiles.size,
    totals,
    sources: [...sources.values()]
      .map((source) => ({
        ...source,
        tiles: source.tiles.sort(
          (a, b) => b.lastRequestedAt - a.lastRequestedAt,
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function clearOsmTileLocalCache() {
  localOsmTileCache.clear();
}

function abortReason(signal) {
  try {
    signal?.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}

function makeOsmTileRequestRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    while (pendingOsmTileRequests.length) {
      const waiter = pendingOsmTileRequests.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve(makeOsmTileRequestRelease());
      return;
    }
    activeOsmTileRequests -= 1;
  };
}

function acquireOsmTileRequest(signal) {
  signal?.throwIfAborted();
  if (activeOsmTileRequests < OSM_CACHE_FETCH_CONCURRENCY) {
    activeOsmTileRequests += 1;
    return Promise.resolve(makeOsmTileRequestRelease());
  }
  return new Promise((resolve, reject) => {
    const waiter = { signal, resolve, reject, onAbort: null };
    waiter.onAbort = () => {
      const index = pendingOsmTileRequests.indexOf(waiter);
      if (index !== -1) pendingOsmTileRequests.splice(index, 1);
      reject(abortReason(signal));
    };
    pendingOsmTileRequests.push(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    if (signal?.aborted) waiter.onAbort();
  });
}

async function fetchOsmTile(
  tile,
  { buildQuery, fetchImpl, signal, sourceId, useLocalCache = false },
) {
  observeOsmTile(sourceId, tile);
  const queryBody = `data=${encodeURIComponent(buildQuery(tile))}`;
  const localCacheKey = localOsmTileCacheKey(sourceId, queryBody);
  if (useLocalCache) {
    const localHit = readLocalOsmTileCache(localCacheKey);
    if (localHit) {
      signal?.throwIfAborted();
      observeOsmTile(sourceId, tile, localHit);
      return localHit;
    }
  }
  let release;
  try {
    release = await acquireOsmTileRequest(signal);
    const response = await fetchImpl('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: queryBody,
      signal,
    });
    if (useLocalCache)
      await maybeWriteLocalOsmTileCache(localCacheKey, response);
    observeOsmTile(sourceId, tile, response);
    return response;
  } catch (error) {
    observeOsmTile(sourceId, tile, null, error);
    throw error;
  } finally {
    release?.();
  }
}

/** Return fixed-grid tiles intersecting a viewport, or one bounded fallback for broad views. */
export function osmCacheTiles(
  bounds,
  {
    step = OSM_CACHE_TILE_DEGREES,
    maxTiles = OSM_CACHE_MAX_TILES_PER_QUERY,
  } = {},
) {
  const firstRow = Math.floor(bounds.south / step + 1e-9);
  const lastRow = Math.ceil(bounds.north / step - 1e-9) - 1;
  const firstColumn = Math.floor(bounds.west / step + 1e-9);
  const lastColumn = Math.ceil(bounds.east / step - 1e-9) - 1;
  const tileCount = (lastRow - firstRow + 1) * (lastColumn - firstColumn + 1);
  if (tileCount < 1 || tileCount > maxTiles) return [{ ...bounds }];

  const rounded = (value) => Number(value.toFixed(6)) || 0;
  const tiles = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      tiles.push({
        south: rounded(Math.max(-90, row * step)),
        west: rounded(Math.max(-180, column * step)),
        north: rounded(Math.min(90, (row + 1) * step)),
        east: rounded(Math.min(180, (column + 1) * step)),
      });
    }
  }
  return tiles;
}

/** Fetch and combine tile responses; each exact tile query gets its own proxy disk entry. */
export async function fetchOsmCacheTiles(
  bounds,
  {
    buildQuery,
    fetchImpl,
    signal,
    sourceId = 'osm',
    useLocalCache = false,
  } = {},
) {
  const tiles = osmCacheTiles(bounds);
  signal?.throwIfAborted();
  const responses = [];
  let cancelled = false;
  const cancelResponses = async () => {
    if (cancelled) return;
    cancelled = true;
    await Promise.allSettled(
      responses.map((response) => response.body?.cancel?.()),
    );
  };
  for (
    let offset = 0;
    offset < tiles.length;
    offset += OSM_CACHE_FETCH_CONCURRENCY
  ) {
    const settled = await Promise.allSettled(
      tiles.slice(offset, offset + OSM_CACHE_FETCH_CONCURRENCY).map((tile) =>
        fetchOsmTile(tile, {
          buildQuery,
          fetchImpl,
          signal,
          sourceId,
          useLocalCache,
        }),
      ),
    );
    responses.push(
      ...settled
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value),
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected || signal?.aborted) {
      await cancelResponses();
      if (signal?.aborted) signal.throwIfAborted();
      throw rejected.reason;
    }
    if (responses.some((response) => !response.ok)) break;
  }
  const failed = responses.find((response) => !response.ok);
  if (failed) await cancelResponses();
  const headers = {
    get(name) {
      const values = [
        ...new Set(
          responses
            .map((response) => response.headers?.get?.(name))
            .filter(Boolean),
        ),
      ];
      if (name.toLowerCase() === 'x-overpass-cache' && values.includes('STALE'))
        return 'STALE';
      return values.length > 1 ? 'MIXED' : (values[0] ?? null);
    },
  };
  return {
    ok: !failed,
    status: failed?.status ?? responses[0]?.status ?? 200,
    headers,
    body: { cancel: cancelResponses },
    async json() {
      const payloads = await Promise.all(
        responses.map((response) => response.json()),
      );
      signal?.throwIfAborted();
      if (payloads.some((payload) => !Array.isArray(payload?.elements)))
        throw new Error('Malformed Overpass tile response');
      const elements = new Map();
      const unkeyed = [];
      for (const element of payloads.flatMap((payload) => payload.elements)) {
        if (element?.type == null || element?.id == null) {
          unkeyed.push(element);
          continue;
        }
        elements.set(`${element.type}:${element.id}`, element);
      }
      const result = { elements: [...elements.values(), ...unkeyed] };
      const remark = payloads.find((payload) => payload.remark)?.remark;
      if (remark) result.remark = remark;
      return result;
    },
  };
}
