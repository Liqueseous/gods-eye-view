import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';
import { createTunnelsSource } from './source.js';

const bounds = {
  south: 42.35,
  west: -71.1,
  north: 42.37,
  east: -71.05,
};

test('tunnel query is bounded, accepted by the proxy, and selects road and rail ways', async () => {
  const calls = [];
  const source = createTunnelsSource({
    fetchImpl: async (...args) => {
      calls.push(args);
      return Response.json({ elements: [] });
    },
  });
  const response = await source.requestTunnels(bounds);
  assert.equal(response.ok, true);
  assert.equal(calls[0][0], '/api/overpass');

  const body = new URLSearchParams(calls[0][1].body);
  const query = body.get('data');
  assert.equal(sanitizeOverpassBody(calls[0][1].body).ok, true);
  assert.match(query, /way\["highway"\]\["tunnel"\]/);
  assert.match(query, /way\["railway"~"\^\(rail\|light_rail/);
  assert.match(query, /out geom qt/);
  assert.match(query, /42\.35,-71\.1,42\.37,-71\.05/);
});

test('tunnel source rejects invalid or overwide bounds before fetching', async () => {
  let calls = 0;
  const source = createTunnelsSource({
    fetchImpl: async () => {
      calls++;
      return Response.json({ elements: [] });
    },
  });
  await assert.rejects(
    source.requestTunnels({ ...bounds, east: 180 }),
    /bounded tunnel viewport/,
  );
  await assert.rejects(
    source.requestTunnels({ ...bounds, south: Number.NaN }),
    /bounded tunnel viewport/,
  );
  assert.equal(calls, 0);
});

test('tunnel normalization retains road and rail names and ignores non-tunnel ways', async () => {
  const geometry = [
    { lat: 42.35, lon: -71.09 },
    { lat: 42.36, lon: -71.08 },
  ];
  const source = createTunnelsSource({
    fetchImpl: async () =>
      Response.json({
        elements: [
          {
            type: 'way',
            id: 101,
            geometry,
            tags: { highway: 'motorway', tunnel: 'yes', name: 'Big Dig' },
          },
          {
            type: 'way',
            id: 202,
            geometry,
            tags: { railway: 'subway', tunnel: 'yes', ref: 'Orange Line' },
          },
          {
            type: 'way',
            id: 303,
            geometry,
            tags: { highway: 'primary' },
          },
          {
            type: 'way',
            id: 404,
            geometry,
            tags: { railway: 'platform', tunnel: 'yes' },
          },
        ],
      }),
  });
  const { tunnels } = await (await source.requestTunnels(bounds)).json();
  assert.deepEqual(
    tunnels.map(({ id, kind, name, coordinates }) => ({
      id,
      kind,
      name,
      coordinates,
    })),
    [
      {
        id: '101',
        kind: 'road',
        name: 'Big Dig',
        coordinates: [
          [-71.09, 42.35],
          [-71.08, 42.36],
        ],
      },
      {
        id: '202',
        kind: 'rail',
        name: 'Orange Line',
        coordinates: [
          [-71.09, 42.35],
          [-71.08, 42.36],
        ],
      },
    ],
  );
});

test('aborting after response decode prevents admitting stale tunnel data', async () => {
  const controller = new AbortController();
  const source = createTunnelsSource({
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
  const response = await source.requestTunnels(bounds, {
    signal: controller.signal,
  });
  await assert.rejects(response.json(), { name: 'AbortError' });
});
