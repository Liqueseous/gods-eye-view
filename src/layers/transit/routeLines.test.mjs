import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createTransitRouteLines,
  groupTransitStations,
  smoothTransitRouteLine,
  transitRouteBadgeShape,
  transitRouteBadgeText,
} from './routeLines.js';

test('sharp route vertices are replaced by a bounded smooth curve', () => {
  const line = smoothTransitRouteLine([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  assert.ok(line.length > 3);
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line.at(-1), [1, 1]);
  assert.ok(line.some(([lon, lat]) => lon < 1 && lat > 0));
  assert.deepEqual(
    smoothTransitRouteLine([
      [0, 0],
      [1, 0],
    ]),
    [
      [0, 0],
      [1, 0],
    ],
  );
});

test('matching station names merge nearby stops and retain both route identities', () => {
  const groups = groupTransitStations([
    {
      routeId: 'A',
      ref: 'A',
      name: 'A Line',
      color: '#0039A6',
      stops: [{ id: 'a-1', name: 'Central', lat: 40.75, lon: -73.99 }],
    },
    {
      routeId: 'B',
      ref: 'B',
      name: 'B Line',
      color: '#FF6319',
      stops: [{ id: 'b-1', name: 'Central', lat: 40.7505, lon: -73.9904 }],
    },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].routeIds, ['A', 'B']);
  assert.deepEqual(groups[0].routeRefs, ['A', 'B']);
  assert.deepEqual(groups[0].colors, ['#0039A6', '#FF6319']);
  assert.deepEqual(
    groups[0].badges.map(({ text }) => text),
    ['A', 'B'],
  );
  assert.deepEqual(
    groups[0].badges.map(({ shape }) => shape),
    ['circle', 'circle'],
  );
  const colorOnly = groupTransitStations([
    {
      routeId: 'orange-line',
      name: 'Orange Line',
      color: '#ED8B00',
      stops: [{ id: 'orange-1', name: 'Central', lat: 40.75, lon: -73.99 }],
    },
    {
      routeId: 'green-d',
      ref: 'Green-D',
      color: '#00843D',
      stops: [{ id: 'green-1', name: 'Central', lat: 40.7505, lon: -73.9904 }],
    },
  ]);
  assert.deepEqual(
    colorOnly[0].badges.map(({ text }) => text),
    ['', 'D'],
  );
  const express = groupTransitStations([
    {
      routeId: '6x',
      ref: '6X',
      name: 'Lexington Avenue Express',
      type: 'subway',
      color: '#00933C',
      stops: [{ id: '6x-1', name: '33 St', lat: 40.746, lon: -73.98 }],
    },
  ]);
  assert.deepEqual(express[0].badges[0], {
    key: '6:#00933C:diamond',
    text: '6',
    color: '#00933C',
    shape: 'diamond',
  });
  const namedLines = groupTransitStations([
    {
      routeId: 'lowell',
      ref: 'CR-Lowell',
      type: 'train',
      color: '#80276C',
      stops: [
        { id: 'lowell-1', name: 'North Station', lat: 42.365, lon: -71.06 },
      ],
    },
    {
      routeId: 'haverhill',
      ref: 'CR-Haverhill',
      type: 'train',
      color: '#D9A6FF',
      stops: [
        {
          id: 'haverhill-1',
          name: 'North Station',
          lat: 42.3652,
          lon: -71.0602,
        },
      ],
    },
  ]);
  assert.deepEqual(
    namedLines[0].lineEntries.map(({ label }) => label),
    ['Lowell Line', 'Haverhill Line'],
  );
  assert.deepEqual(
    namedLines[0].lineEntries.map(({ text, shape }) => ({ text, shape })),
    [
      { text: '', shape: 'rail' },
      { text: '', shape: 'rail' },
    ],
  );
  assert.deepEqual(namedLines[0].badges, []);
  const cleanedLine = groupTransitStations([
    {
      routeId: 'njcl',
      name: 'NJ Transit North Jersey Coast Line: New York <=> Bay Head Line',
      type: 'train',
      color: '#00AEEF',
      stops: [{ id: 'njcl-1', name: 'Penn Station', lat: 40.75, lon: -73.99 }],
    },
  ]);
  assert.equal(
    cleanedLine[0].lineEntries[0].label,
    'NJ Transit North Jersey Coast Line',
  );
  assert.equal(
    transitRouteBadgeShape({
      type: 'subway',
      ref: '6X',
      name: 'Lexington Express',
    }),
    'diamond',
  );
  assert.equal(transitRouteBadgeText({ type: 'subway', ref: '6X' }), '6');
  assert.equal(
    transitRouteBadgeText({ type: 'subway', ref: '6 Express' }),
    '6',
  );
  assert.equal(
    transitRouteBadgeShape({
      type: 'subway',
      ref: 'HOB',
      operator: 'Port Authority Trans-Hudson',
    }),
    'circle',
  );
  assert.equal(transitRouteBadgeText({ type: 'train', ref: 'HOB3' }), 'HOB');
  const pathVariant = groupTransitStations([
    {
      routeId: 'path-hob',
      ref: 'HOB3 via',
      type: 'subway',
      operator: 'Port Authority Trans-Hudson',
      color: '#009BDE',
      stops: [{ id: 'path-hob-1', name: '33 St', lat: 40.75, lon: -73.99 }],
    },
  ]);
  assert.deepEqual(
    pathVariant[0].badges.map(({ text }) => text),
    ['HOB'],
  );
  assert.equal(
    transitRouteBadgeShape({ type: 'train', name: 'MTA Subway 7 Express' }),
    'diamond',
  );
});

test('same station name stays separate when locations are far apart', () => {
  const groups = groupTransitStations([
    {
      routeId: 'A',
      stops: [{ id: 'a-1', name: '86 St', lat: 40.78, lon: -73.97 }],
    },
    {
      routeId: 'B',
      stops: [{ id: 'b-1', name: '86 St', lat: 40.62, lon: -74.03 }],
    },
  ]);
  assert.equal(groups.length, 2);
});

test('route lines render with a contrast outline and route color, then release on disable', async () => {
  const sceneEntities = [];
  const sourceCalls = [];
  let selectedRoute = null;
  const viewer = {
    scene: { requestRender() {} },
    entities: {
      add(entity) {
        sceneEntities.push(entity);
        return entity;
      },
      remove(entity) {
        const index = sceneEntities.indexOf(entity);
        if (index < 0) return false;
        sceneEntities.splice(index, 1);
        return true;
      },
    },
  };
  const layer = createTransitRouteLines({
    onSelectRoute(route) {
      selectedRoute = route;
    },
    routeSource: {
      async requestRoutes(bounds) {
        sourceCalls.push(bounds);
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return {
                'x-overpass-cache': 'HIT',
                'x-overpass-upstream': 'overpass.example',
              }[name];
            },
          },
          async json() {
            return {
              routes: [
                {
                  id: '12:99',
                  routeId: '12',
                  name: 'Blue Line',
                  ref: 'A',
                  type: 'light_rail',
                  color: '#1267B1',
                  stops: [
                    {
                      id: '1',
                      role: 'stop',
                      name: 'Central',
                      lat: 42.35,
                      lon: -71.1,
                    },
                  ],
                  lines: [
                    [
                      [-71.1, 42.35],
                      [-71.05, 42.35],
                    ],
                  ],
                },
              ],
            };
          },
        };
      },
    },
  });

  layer.init(viewer);
  layer.enable(viewer);
  layer.setVisible(true);
  const update = layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });

  await update;
  assert.equal(sourceCalls.length, 1);
  assert.ok(sourceCalls[0].north - sourceCalls[0].south <= 1);
  assert.ok(
    sourceCalls[0].south <= 42.3,
    'query includes the viewport south edge',
  );
  assert.ok(
    sourceCalls[0].west <= -71.2,
    'query includes the viewport west edge',
  );
  assert.ok(
    sourceCalls[0].north >= 42.4,
    'query includes the viewport north edge',
  );
  assert.ok(
    sourceCalls[0].east >= -71,
    'query includes the viewport east edge',
  );
  assert.ok(sourceCalls[0].north - sourceCalls[0].south <= 0.12);
  assert.ok(sourceCalls[0].east - sourceCalls[0].west <= 0.22);
  assert.equal(
    sceneEntities.length,
    6,
    'outline, colored route, station, placard, toggle, and line badge are drawn',
  );
  assert.equal(sceneEntities.filter((entity) => entity.point).length, 1);
  assert.equal(sceneEntities.filter((entity) => entity.billboard).length, 3);
  const station = sceneEntities.find((entity) => entity.point);
  assert.equal(station.label.disableDepthTestDistance, 0);
  assert.equal(station.label.pixelOffset.y, -42);
  assert.equal(
    station.label.eyeOffset.z,
    -100,
    'station depth is fixed; collection order handles overlay priority',
  );
  const badge = sceneEntities.find(
    (entity) => entity.billboard?.pixelOffset?.y === -30,
  ).billboard;
  assert.equal(badge.pixelOffset.y, -30);
  assert.equal(badge.disableDepthTestDistance, 0);
  assert.equal(badge.eyeOffset.z, -100);
  const stationId = 'transit-station:name:central:0';
  assert.equal(layer.selectFromPick(`${stationId}:toggle`), true);
  assert.equal(station.label.pixelOffset.y, -16);
  assert.equal(station.label.showBackground, true);
  assert.equal(badge.show, false);
  assert.equal(layer.selectFromPick(`${stationId}:toggle`), true);
  assert.equal(station.label.pixelOffset.y, -42);
  assert.equal(station.label.showBackground, false);
  assert.equal(badge.show, true);
  assert.equal(
    layer.diagnostics().count,
    1,
    'in-view routes draw before prefetch',
  );
  assert.deepEqual(layer.diagnostics().coverageBounds, sourceCalls[0]);
  assert.equal(layer.selectFromPick(sceneEntities[0].id), true);
  assert.equal(selectedRoute.routeId, '12');
  assert.equal(selectedRoute.name, 'Blue Line');
  assert.deepEqual(
    selectedRoute.stops.map(({ name }) => name),
    ['Central'],
  );
  assert.deepEqual(
    sceneEntities[0].polyline.material,
    Cesium.Color.fromCssColorString('#1267B1'),
  );
  assert.deepEqual(
    sceneEntities[1].polyline.material,
    Cesium.Color.fromCssColorString('#1267B1'),
  );
  assert.ok(
    sceneEntities
      .filter((entity) => entity.polyline)
      .every((entity) => entity.polyline.zIndex > 11),
    'transit route lines are ordered above tunnel fallback lines',
  );
  const routeDiagnostics = layer.diagnostics({ includeGeometry: true });
  assert.equal(routeDiagnostics.count, 1);
  assert.equal(routeDiagnostics.routes[0].stopCount, 1);
  assert.deepEqual(routeDiagnostics.routes[0].stops[0], {
    id: '1',
    role: 'stop',
    name: 'Central',
    lat: 42.35,
    lon: -71.1,
  });
  assert.equal(routeDiagnostics.lastStatus, 200);
  assert.equal(routeDiagnostics.cache, 'HIT');
  assert.equal(routeDiagnostics.upstream, 'overpass.example');
  assert.deepEqual(routeDiagnostics.bounds, sourceCalls[0]);
  assert.deepEqual(routeDiagnostics.routes[0].lines, [
    [
      [-71.1, 42.35],
      [-71.05, 42.35],
    ],
  ]);
  assert.equal(layer.diagnostics().routes[0].lines, undefined);
  await layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });
  assert.equal(
    sourceCalls.length,
    1,
    'cached coverage covers nearby view pans',
  );

  layer.setVisible(false);
  assert.equal(
    sceneEntities.every((entity) => entity.show === false),
    true,
  );
  layer.disable();
  assert.equal(sceneEntities.length, 0);
  assert.equal(layer.diagnostics().count, 0);
});

test('route lines draw as depth-tested primitives when the globe is hidden (Google 3D)', async (t) => {
  // Cesium's Primitive constructor reaches for the DOM when building.
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const prior = globalThis[name];
    globalThis[name] = class {};
    t.after(() => {
      if (prior === undefined) delete globalThis[name];
      else globalThis[name] = prior;
    });
  }

  const scenePrimitives = [];
  const layer = createTransitRouteLines({
    routeSource: {
      async requestRoutes() {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              routes: [
                {
                  id: '12:99',
                  routeId: '12',
                  name: 'Blue Line',
                  type: 'subway',
                  color: '#1267B1',
                  lines: [
                    [
                      [-71.1, 42.35],
                      [-71.05, 42.35],
                    ],
                  ],
                },
              ],
            };
          },
        };
      },
    },
  });
  layer.init({
    scene: {
      requestRender() {},
      primitives: {
        add(primitive) {
          scenePrimitives.push(primitive);
          return primitive;
        },
        remove(primitive) {
          const index = scenePrimitives.indexOf(primitive);
          if (index >= 0) scenePrimitives.splice(index, 1);
        },
      },
      // The Google 3D path: no globe at all, so ground primitives never run.
      globe: { show: false },
    },
    entities: { add: () => ({}), remove() {} },
  });
  layer.enable();
  layer.setVisible(true);
  await layer.update({ south: 42.3, west: -71.2, north: 42.4, east: -71 });

  assert.equal(layer.diagnostics().count, 1);
  assert.ok(
    scenePrimitives.length >= 2,
    'outline and colored route primitives exist in the scene',
  );
  assert.ok(
    scenePrimitives.every((primitive) => primitive.show === true),
    'primitives are shown once ready',
  );
  assert.equal(
    scenePrimitives.filter((primitive) => primitive.depthFailAppearance).length,
    1,
    'only the thin route outline receives the restrained under-building glow',
  );
  layer.destroy();
  assert.equal(scenePrimitives.length, 0);
});

test('a newly visible area supersedes an in-flight priority request', async () => {
  const calls = [];
  const priorityStarted = Promise.withResolvers();
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return { routes: [] };
    },
  };
  const layer = createTransitRouteLines({
    routeSource: {
      requestRoutes(bounds, { signal }) {
        calls.push(bounds);
        if (calls.length === 1) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('Aborted'), { name: 'AbortError' }),
                ),
              { once: true },
            );
          });
        }
        priorityStarted.resolve();
        return Promise.resolve(response);
      },
    },
  });
  layer.init({
    scene: { requestRender() {} },
    entities: { add: () => ({}), remove() {} },
  });
  layer.enable();
  layer.setVisible(true);

  const firstUpdate = layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });
  const secondUpdate = layer.update({
    south: 42.41,
    west: -71.2,
    north: 42.49,
    east: -71,
  });
  await priorityStarted.promise;
  await secondUpdate;
  await firstUpdate;

  assert.equal(calls.length, 2, 'new priority area replaces the stale request');
  assert.ok(calls[1].south <= 42.41);
  assert.ok(calls[1].north >= 42.49);
  assert.ok(calls[1].north - calls[1].south <= 0.12);
  layer.destroy();
});

test('route geometry remains through empty intermediate replacements', async () => {
  const secondRequest = Promise.withResolvers();
  let requestCount = 0;
  const entities = [];
  const layer = createTransitRouteLines({
    routeSource: {
      requestRoutes() {
        requestCount += 1;
        if (requestCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            async json() {
              return {
                routes: [
                  {
                    id: 'route-1',
                    routeId: '1',
                    name: 'Line 1',
                    type: 'subway',
                    color: '#FF0000',
                    lines: [
                      [
                        [-71.1, 42.35],
                        [-71.05, 42.35],
                      ],
                    ],
                  },
                ],
              };
            },
          });
        }
        return secondRequest.promise;
      },
    },
  });
  layer.init({
    scene: { requestRender() {} },
    entities: {
      add(entity) {
        entities.push(entity);
        return entity;
      },
      remove(entity) {
        const index = entities.indexOf(entity);
        if (index >= 0) entities.splice(index, 1);
      },
    },
  });
  layer.enable();
  layer.setVisible(true);
  await layer.update({ south: 42.3, west: -71.2, north: 42.4, east: -71 });
  assert.equal(layer.diagnostics().count, 1);

  const moved = layer.update({
    south: 40,
    west: -74,
    north: 40.1,
    east: -73.9,
  });
  assert.equal(layer.diagnostics().count, 1);
  assert.equal(entities.length, 2);
  secondRequest.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return { routes: [] };
    },
  });
  await moved;
  assert.equal(layer.diagnostics().count, 1);
  assert.equal(entities.length, 2);
});
