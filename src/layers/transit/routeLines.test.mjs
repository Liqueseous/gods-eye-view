import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitRouteLines } from './routeLines.js';

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
                    { id: '1', role: 'stop', name: 'Central', lat: 42.35, lon: -71.1 },
                  ],
                  lines: [[[-71.1, 42.35], [-71.05, 42.35]]],
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
  assert.ok(sourceCalls[0].south <= 42.3, 'query includes the viewport south edge');
  assert.ok(sourceCalls[0].west <= -71.2, 'query includes the viewport west edge');
  assert.ok(sourceCalls[0].north >= 42.4, 'query includes the viewport north edge');
  assert.ok(sourceCalls[0].east >= -71, 'query includes the viewport east edge');
  assert.ok(sourceCalls[0].north - sourceCalls[0].south <= 0.12);
  assert.ok(sourceCalls[0].east - sourceCalls[0].west <= 0.22);
  assert.equal(sceneEntities.length, 2, 'outline and colored route are drawn');
  assert.equal(layer.diagnostics().count, 1, 'in-view routes draw before prefetch');
  assert.deepEqual(layer.diagnostics().coverageBounds, sourceCalls[0]);
  assert.equal(layer.selectFromPick(sceneEntities[0].id), true);
  assert.equal(selectedRoute.routeId, '12');
  assert.equal(selectedRoute.name, 'Blue Line');
  assert.deepEqual(selectedRoute.stops.map(({ name }) => name), ['Central']);
  assert.deepEqual(sceneEntities[0].polyline.material, Cesium.Color.fromCssColorString('#1267B1'));
  assert.deepEqual(sceneEntities[1].polyline.material, Cesium.Color.fromCssColorString('#1267B1'));
  assert.ok(
    sceneEntities.every((entity) => entity.polyline.zIndex > 11),
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
  assert.deepEqual(routeDiagnostics.routes[0].lines, [[[-71.1, 42.35], [-71.05, 42.35]]]);
  assert.equal(layer.diagnostics().routes[0].lines, undefined);
  await layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });
  assert.equal(sourceCalls.length, 1, 'cached coverage covers nearby view pans');

  layer.setVisible(false);
  assert.equal(sceneEntities.every((entity) => entity.show === false), true);
  layer.disable();
  assert.equal(sceneEntities.length, 0);
  assert.equal(layer.diagnostics().count, 0);
});

test('route lines draw as depth-tested primitives when the globe is hidden (Google 3D)', async (t) => {
  // Cesium's Primitive constructor reaches for the DOM when building.
  for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
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
                  lines: [[[-71.1, 42.35], [-71.05, 42.35]]],
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
              () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
        }
        priorityStarted.resolve();
        return Promise.resolve(response);
      },
    },
  });
  layer.init({ scene: { requestRender() {} }, entities: { add: () => ({}), remove() {} } });
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
                routes: [{
                  id: 'route-1',
                  routeId: '1',
                  name: 'Line 1',
                  type: 'subway',
                  color: '#FF0000',
                  lines: [[[-71.1, 42.35], [-71.05, 42.35]]],
                }],
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
