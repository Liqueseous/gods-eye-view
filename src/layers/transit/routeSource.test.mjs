import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';
import { clearOsmTileLocalCache } from '../../data/osmCacheBounds.js';
import {
  buildTransitRouteQuery,
  clampTransitRouteBounds,
  createTransitRouteSource,
  normalizeTransitRoutes,
  transitRouteMatchesVehicle,
} from './routeSource.js';

const BOUNDS = { south: 42.3, west: -71.2, north: 42.4, east: -71.0 };

test('route query is bounded and includes heavy and light rail relation types', () => {
  const query = buildTransitRouteQuery(BOUNDS);
  assert.match(query, /relation\["route"~"\^\(train\|subway\|light_rail\|tram/);
  assert.match(query, /\(42\.3,-71\.2,42\.4,-71\)/);
  assert.match(query, /\.routes out body;way\(r\.routes\)\(/);
  assert.match(query, /\.routeways out geom qt;node\(r\.routes\)/);
  assert.match(query, /\.routenodes out body qt;$/);
  assert.doesNotMatch(query, /relation[^;]*out geom/);
  assert.equal(
    sanitizeOverpassBody(`data=${encodeURIComponent(query)}`).ok,
    true,
    'the route query passes the production Overpass guard',
  );
  assert.throws(
    () => buildTransitRouteQuery({ ...BOUNDS, east: 181 }),
    /bounded transit-route viewport/,
  );
});

test('route bounds are clamped to one degree and remain monotonic at the dateline', () => {
  const wide = clampTransitRouteBounds({
    south: 40,
    west: 170,
    north: 45,
    east: -170,
  });
  assert.ok(wide.north - wide.south <= 1);
  assert.ok(wide.east > wide.west);
  assert.ok(wide.east - wide.west <= 1);
});

test('route relations expose clipped member geometry and preserve route colors', () => {
  const routes = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 12,
          tags: {
            route: 'light_rail',
            name: 'Blue Line',
            ref: 'A',
            colour: '#1267B1',
            network: 'Metro Example',
            operator: 'Transit Example',
            from: 'North Station',
            to: 'Harbor Point',
          },
          members: [
            { type: 'way', ref: 99 },
            { type: 'node', ref: 77, role: 'stop' },
          ],
        },
        {
          type: 'way',
          id: 99,
          tags: { railway: 'light_rail' },
          geometry: [
            { lon: -72, lat: 42.35 },
            { lon: -71.1, lat: 42.35 },
            { lon: -70, lat: 42.35 },
          ],
        },
        {
          type: 'node',
          id: 77,
          lat: 42.36,
          lon: -71.1,
          tags: { name: 'Central Square', public_transport: 'stop_position' },
        },
        {
          type: 'relation',
          id: 13,
          tags: { route: 'bus', name: 'Blue Bus' },
          members: [],
        },
      ],
    },
    BOUNDS,
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].color, '#1267B1');
  assert.equal(routes[0].network, 'Metro Example');
  assert.equal(routes[0].operator, 'Transit Example');
  assert.equal(routes[0].from, 'North Station');
  assert.equal(routes[0].to, 'Harbor Point');
  assert.deepEqual(routes[0].stops, [
    {
      id: '77',
      role: 'stop',
      name: 'Central Square',
      lat: 42.36,
      lon: -71.1,
    },
  ]);
  assert.deepEqual(routes[0].lines, [[[-71.2, 42.35], [-71, 42.35]]]);
});

test('route geometry simplifies dense points while preserving endpoints', () => {
  const geometry = Array.from({ length: 1000 }, (_value, index) => ({
    lon: -71.2 + index * 0.0002,
    lat: 42.35,
  }));
  const [line] = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 14,
          tags: { route: 'subway', ref: 'Blue' },
          members: [{ type: 'way', ref: 1400 }],
        },
        { type: 'way', id: 1400, geometry },
      ],
    },
    { south: 42.3, west: -71.2, north: 42.4, east: -71 },
  )[0].lines;

  assert.deepEqual(line, [
    [-71.2, 42.35],
    [-71.0002, 42.35],
  ]);
});

test('route normalization bounds oversized relation geometry', () => {
  const elements = [];
  for (let relationId = 1; relationId <= 20; relationId += 1) {
    const members = [];
    for (let wayIndex = 0; wayIndex < 90; wayIndex += 1) {
      const wayId = relationId * 1000 + wayIndex;
      members.push({ type: 'way', ref: wayId });
      elements.push({
        type: 'way',
        id: wayId,
        geometry: [
          { lon: -71.1, lat: 42.35 },
          { lon: -71.05, lat: 42.35 },
        ],
      });
    }
    elements.push({
      type: 'relation',
      id: relationId,
      tags: { route: 'tram', ref: `T${relationId}` },
      members,
    });
  }

  const routes = normalizeTransitRoutes({ elements }, BOUNDS);
  assert.equal(routes.length, 20);
  assert.equal(new Set(routes.map((route) => route.ref)).size, 20);
  assert.ok(routes.every((route) => route.lines.length > 0));
});

test('line overviews keep distinct branches without restoring parallel tracks', () => {
  const routes = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 21,
          tags: { route: 'light_rail', ref: 'Green', network: 'MBTA' },
          members: [
            { type: 'way', ref: 2101 },
            { type: 'way', ref: 2102 },
          ],
        },
        {
          type: 'way',
          id: 2101,
          geometry: [
            { lon: -71.2, lat: 42.35 },
            { lon: -71.1, lat: 42.35 },
          ],
        },
        {
          type: 'way',
          id: 2102,
          geometry: [
            { lon: -71.2, lat: 42.4 },
            { lon: -70.9, lat: 42.4 },
          ],
        },
      ],
    },
    BOUNDS,
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].ref, 'Green');
  assert.equal(routes[0].lines.length, 2);
  assert.ok(routes[0].lines.every((line) => line.length === 2));
});

test('line overviews retain every disconnected corridor including short branches', () => {
  const members = [];
  const ways = [];
  const corridors = [
    [-71.19, 42.31, -71.02, 42.31],
    [-71.19, 42.33, -71.04, 42.33],
    [-71.18, 42.35, -71.05, 42.35],
    [-71.17, 42.37, -71.06, 42.37],
    [-71.1, 42.39, -71.09, 42.39],
  ];
  for (let index = 0; index < corridors.length; index++) {
    const id = 2301 + index;
    const [west, south, east, north] = corridors[index];
    members.push({ type: 'way', ref: id });
    ways.push({
      type: 'way',
      id,
      geometry: [
        { lon: west, lat: south },
        { lon: east, lat: north },
      ],
    });
  }

  const routes = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 23,
          tags: { route: 'light_rail', ref: 'Branching', network: 'Test' },
          members,
        },
        ...ways,
      ],
    },
    BOUNDS,
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].lines.length, corridors.length);
  assert.ok(
    routes[0].lines.some(
      (line) => Math.abs(line[0][0] - line.at(-1)[0]) < 0.011,
    ),
    'the short branch must not be discarded relative to the longest corridor',
  );
});

test('line overviews collapse nearby parallel tracks', () => {
  const routes = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 22,
          tags: { route: 'subway', ref: 'Blue', network: 'MBTA' },
          members: [
            { type: 'way', ref: 2201 },
            { type: 'way', ref: 2202 },
          ],
        },
        {
          type: 'way',
          id: 2201,
          geometry: [
            { lon: -71.2, lat: 42.35 },
            { lon: -71.0, lat: 42.35 },
          ],
        },
        {
          type: 'way',
          id: 2202,
          geometry: [
            { lon: -71.2, lat: 42.3501 },
            { lon: -71.0, lat: 42.3501 },
          ],
        },
      ],
    },
    BOUNDS,
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].lines.length, 1);
});

test('route colors fall back to line name, then route type', () => {
  const routes = normalizeTransitRoutes(
    {
      elements: [
        {
          type: 'relation',
          id: 1,
          tags: { route: 'train', name: 'Red Line' },
          members: [{ type: 'way', ref: 1, geometry: [{ lon: -71.1, lat: 42.35 }, { lon: -71.05, lat: 42.35 }] }],
        },
        {
          type: 'relation',
          id: 2,
          tags: { route: 'subway', name: 'Metro' },
          members: [{ type: 'way', ref: 2, geometry: [{ lon: -71.1, lat: 42.35 }, { lon: -71.05, lat: 42.35 }] }],
        },
      ],
    },
    BOUNDS,
  );
  assert.deepEqual(routes.map((route) => route.color), ['#DA291C', '#FF4538']);
});

test('live vehicles match only explicit route refs or agency-prefixed IDs', () => {
  assert.equal(
    transitRouteMatchesVehicle({ ref: 'M15', name: 'M15 Crosstown' }, 'MTA NYCT_M15'),
    true,
  );
  assert.equal(
    transitRouteMatchesVehicle({ name: 'Red Line' }, 'Red'),
    true,
  );
  assert.equal(
    transitRouteMatchesVehicle({ ref: 'Green' }, 'Green-C'),
    true,
  );
  assert.equal(transitRouteMatchesVehicle({ ref: '1' }, 'M15'), false);
  assert.equal(transitRouteMatchesVehicle({ ref: 'M15' }, null), false);
});

test('route source uses the local Overpass proxy and validates the decoded payload', async () => {
  let request;
  const source = createTransitRouteSource({
    fetchImpl: async (...args) => {
      request = args;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ elements: [] }),
      };
    },
  });
  const response = await source.requestRoutes(BOUNDS);
  assert.equal(request[0], '/api/overpass');
  assert.match(decodeURIComponent(request[1].body), /route/);
  assert.deepEqual(await response.json(), { routes: [] });
});

test('nearby transit viewports share cached OSM tiles without repeat server calls', async () => {
  clearOsmTileLocalCache();
  const queries = [];
  const source = createTransitRouteSource({
    fetchImpl: async (_url, options) => {
      queries.push(new URLSearchParams(options.body).get('data'));
      return Response.json({ elements: [] });
    },
  });
  await source.requestRoutes(BOUNDS);
  const firstTileQueries = queries.splice(0);
  await source.requestRoutes({
    south: 42.31,
    west: -71.19,
    north: 42.39,
    east: -71.01,
  });
  assert.deepEqual(queries, []);
  assert.ok(firstTileQueries.length > 0);
});
