import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';
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
  assert.deepEqual(routes[0].lines, [[[-71.2, 42.35], [-71.1, 42.35], [-71, 42.35]]]);
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