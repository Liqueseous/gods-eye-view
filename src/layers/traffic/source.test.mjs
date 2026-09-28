import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  RoadRequestError,
  createTrafficSource,
  roadRequestError,
} from './source.js';
import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';
import {
  clearOsmTileLocalCache,
  fetchOsmCacheTiles,
  getOsmTileCacheDiagnostics,
  osmCacheTiles,
} from '../../data/osmCacheBounds.js';
const bounds = { south: 30.267, west: -97.744, north: 30.268, east: -97.743 };
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/tomtom-flow-austin-12-935-1686.pbf',
    import.meta.url,
  ),
);

test.beforeEach(() => {
  clearOsmTileLocalCache();
});

test('flow caches and diagnostics belong to their constructed source', async () => {
  let requestsA = 0,
    requestsB = 0;
  const a = createTrafficSource({
    fetchImpl: async () => {
      requestsA++;
      return new Response(fixture);
    },
  });
  const b = createTrafficSource({
    fetchImpl: async () => {
      requestsB++;
      return new Response(fixture);
    },
  });
  const first = await a.fetchFlowForBounds(bounds);
  assert.ok(first.length > 0);
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  assert.equal(b.getFlowSessionStats().tilesFetched, 0);
  b.resetFlowTileCache();
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  await b.fetchFlowForBounds(bounds);
  assert.equal(requestsB, 1);
});
test('a cancelled flow body cannot refill its source cache', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => {
        calls++;
        if (calls === 1) controller.abort();
        return fixture;
      },
    }),
  });
  await assert.rejects(
    source.fetchFlowForBounds(bounds, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await source.fetchFlowForBounds(bounds);
  assert.equal(
    calls,
    2,
    'cancelled bytes were not admitted to the decode cache',
  );
});
test('road requests have finite bounds and retain the two-pass query', async () => {
  const calls = [];
  const source = createTrafficSource({
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response('{"elements":[]}');
    },
  });
  await assert.rejects(
    source.requestRoads({ ...bounds, north: Infinity }),
    /bounded road viewport/,
  );
  await assert.rejects(
    source.requestRoads(bounds, { timeoutSec: '25];out;' }),
    /bounded road viewport/,
  );
  assert.equal(calls.length, 0);
  await source.requestRoads(bounds, { majorOnly: true, timeoutSec: 8 });
  assert.equal(calls[0][0], '/api/overpass');
  const query = new URLSearchParams(calls[0][1].body).get('data');
  assert.match(query, /\[timeout:8\]/);
  assert.doesNotMatch(query, /residential/);
  await source.requestRoads(bounds);
  assert.match(
    new URLSearchParams(calls[1][1].body).get('data'),
    /residential/,
  );
});
test('traffic road queries use small center-first cache chunks', async () => {
  const tiles = [];
  const source = createTrafficSource({
    fetchImpl: async (_url, options) => {
      tiles.push(new URLSearchParams(options.body).get('data'));
      return Response.json({ elements: [] });
    },
  });
  await source.requestRoads({
    south: 30.2,
    west: -97.8,
    north: 30.4,
    east: -97.6,
  });
  assert.ok(tiles.length > 1);
  assert.match(tiles[0], /\(30\.25,-97\.(65|7),30\.3,-97\.(6|65)\)/);
});
test('nearby road viewports share cached OSM tiles without a second server call', async () => {
  const queries = [];
  const source = createTrafficSource({
    fetchImpl: async (_url, options) => {
      queries.push(new URLSearchParams(options.body).get('data'));
      return new Response('{"elements":[]}');
    },
  });
  await source.requestRoads(bounds);
  await source.requestRoads({
    south: 30.271,
    west: -97.739,
    north: 30.272,
    east: -97.738,
  });
  assert.equal(queries.length, 1);
});
test('OSM tile batches deduplicate elements and fall back for broad bounds', async () => {
  const bounds = { south: 42.35, west: -71.05, north: 42.45, east: -70.95 };
  const requests = [];
  const response = await fetchOsmCacheTiles(bounds, {
    buildQuery: (tile) => JSON.stringify(tile),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(new URLSearchParams(options.body).get('data')));
      return Response.json({
        elements: [
          { type: 'way', id: 1 },
          { type: 'node', id: requests.length + 10 },
        ],
      });
    },
  });
  const payload = await response.json();
  assert.equal(requests.length, 4);
  assert.equal(
    new Set(requests.map((tile) => `${tile.south}/${tile.west}`)).size,
    4,
  );
  assert.equal(payload.elements.length, 5);
  assert.deepEqual(
    osmCacheTiles({ south: 0.01, west: 0.01, north: 0.41, east: 0.41 }),
    [{ south: 0.01, west: 0.01, north: 0.41, east: 0.41 }],
  );
});
test('OSM tile fetches stay below the shared Overpass concurrency limit', async () => {
  let active = 0;
  let maximumActive = 0;
  const options = {
    buildQuery: (tile) => JSON.stringify(tile),
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return Response.json({ elements: [] });
    },
  };
  const bounds = { south: 0.01, west: 0.01, north: 0.31, east: 0.31 };
  await Promise.all([
    fetchOsmCacheTiles(bounds, options),
    fetchOsmCacheTiles(bounds, options),
  ]);
  assert.equal(maximumActive, 3);
});
test('OSM tile diagnostics count requests and cache outcomes once', async () => {
  let calls = 0;
  const bounds = { south: 41.21, west: -72.31, north: 41.22, east: -72.3 };
  const options = {
    sourceId: 'diagnostics-test',
    buildQuery: (tile) => JSON.stringify(tile),
    useLocalCache: true,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { elements: [] },
        {
          headers: {
            'x-overpass-cache': calls === 1 ? 'HIT' : 'DISK',
          },
        },
      );
    },
  };
  await fetchOsmCacheTiles(bounds, options);
  await fetchOsmCacheTiles(bounds, options);
  const source = getOsmTileCacheDiagnostics().sources.find(
    (entry) => entry.id === 'diagnostics-test',
  );
  assert.equal(calls, 1);
  assert.equal(source.tileCount, 1);
  assert.equal(source.requests, 2);
  assert.equal(source.cacheHits, 2);
  assert.equal(source.diskHits, 0);
});
test('antimeridian clamps produce road tiles accepted on either side', async () => {
  const calls = [];
  const source = createTrafficSource({
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response('{"elements":[]}');
    },
  });
  for (const centerLon of [179.99, -179.99]) {
    const clamped = clampBoundsAroundCenter(
      {
        south: -0.02,
        north: 0.02,
        west: 179.98,
        east: -179.98,
      },
      { lat: 0, lon: centerLon },
    );
    await source.requestRoads(clamped);
  }
  assert.equal(calls.length, 4);
});
test('malformed availability is an unavailable source rather than a keyless response', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(source.getStatus(), /Malformed traffic status/);
});

test('traffic construction is inert and parameters belong to each layer', async () => {
  const { createTrafficLayer } = await import('./index.js');
  const source = createTrafficSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });
  const services = { credits: {}, render: {} };
  const a = createTrafficLayer({ services, source });
  const b = createTrafficLayer({ services, source });
  a.setParams({ densityScale: 2, speedScale: 3, uncoveredRoads: 'hide' });
  assert.equal(a.getParams().densityScale, 2);
  assert.equal(b.getParams().densityScale, 1);
  assert.equal(b.getParams().speedScale, 1);
  assert.equal(b.getParams().uncoveredRoads, 'sim');
});

test('road body parsing retains the source request cancellation signal', async () => {
  const controller = new AbortController();
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        controller.abort();
        return { elements: [] };
      },
    }),
  });
  const response = await source.requestRoads(bounds, {
    signal: controller.signal,
  });
  await assert.rejects(response.json(), { name: 'AbortError' });
});

test('road sources decode direction and coordinates before scene construction', async () => {
  const geometry = [
    { lat: 30, lon: -97 },
    { lat: 30.001, lon: -97.001 },
  ];
  const source = createTrafficSource({
    fetchImpl: async () =>
      Response.json({
        elements: [
          { type: 'node', id: 1 },
          { type: 'way', geometry, tags: { highway: 'primary', oneway: '-1' } },
          { type: 'way', geometry, tags: { junction: 'roundabout' } },
          { type: 'way', geometry: [geometry[0]] },
        ],
      }),
  });
  assert.deepEqual(await (await source.requestRoads(bounds)).json(), {
    roads: [
      {
        coordinates: [
          [-97, 30],
          [-97.001, 30.001],
        ],
        type: 'primary',
        oneway: -1,
      },
      {
        coordinates: [
          [-97, 30],
          [-97.001, 30.001],
        ],
        type: 'unclassified',
        oneway: 1,
      },
    ],
  });
});

test('an Overpass refusal is named by status, and keeps the status beside the words', () => {
  // The panel prints this string verbatim, so the mapping is part of the
  // layer's contract with the reader, not an implementation detail.
  assert.equal(roadRequestError(429).message, 'Overpass rate-limited');
  assert.equal(roadRequestError(504).message, 'Overpass timed out');
  assert.equal(
    roadRequestError(406).message,
    'Overpass refused the road query (HTTP 406)',
  );
  assert.equal(
    roadRequestError(500).message,
    'Overpass refused the road query (HTTP 500)',
  );

  // 502 and 503 come from the local proxy (mirrors unreachable, local
  // limiter busy), so they must not read as a mirror refusing the query.
  assert.equal(roadRequestError(502).message, 'Overpass mirrors unreachable');
  assert.equal(
    roadRequestError(503).message,
    'Overpass temporarily unavailable',
  );
  assert.equal(roadRequestError(503).status, 503);

  // An injected source may refuse without a readable code; a row must never
  // print "HTTP undefined" at a reader.
  for (const missing of [undefined, null, NaN, 'four-oh-six']) {
    const vague = roadRequestError(missing);
    assert.equal(vague.message, 'Overpass temporarily unavailable');
    assert.equal(vague.status, null, 'an unreadable code is absent, not zero');
  }

  const refused = roadRequestError(406);
  assert.ok(refused instanceof RoadRequestError);
  assert.ok(refused instanceof Error);
  assert.equal(refused.name, 'RoadRequestError');
  assert.equal(
    refused.status,
    406,
    'a caller must be able to branch on the code without parsing English',
  );
});
