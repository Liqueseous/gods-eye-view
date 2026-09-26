import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitRouteLines } from './routeLines.js';

test('route lines render with a contrast outline and route color, then release on disable', async () => {
  const sceneEntities = [];
  const sourceCalls = [];
  const prefetchStarted = Promise.withResolvers();
  const releasePrefetch = Promise.withResolvers();
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
    routeSource: {
      async requestRoutes(bounds) {
        sourceCalls.push(bounds);
        if (sourceCalls.length === 2) {
          prefetchStarted.resolve();
          await releasePrefetch.promise;
        }
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

  layer.init(viewer);
  layer.enable(viewer);
  layer.setVisible(true);
  const update = layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });
  await prefetchStarted.promise;

  assert.equal(sourceCalls.length, 2);
  assert.ok(sourceCalls[0].north - sourceCalls[0].south <= 1);
  assert.ok(sourceCalls[0].south <= 42.3, 'query includes the viewport south edge');
  assert.ok(sourceCalls[0].west <= -71.2, 'query includes the viewport west edge');
  assert.ok(sourceCalls[0].north >= 42.4, 'query includes the viewport north edge');
  assert.ok(sourceCalls[0].east >= -71, 'query includes the viewport east edge');
  assert.ok(sourceCalls[0].north - sourceCalls[0].south <= 0.12);
  assert.ok(sourceCalls[0].east - sourceCalls[0].west <= 0.22);
  assert.ok(sourceCalls[1].south < sourceCalls[0].south);
  assert.ok(sourceCalls[1].west < sourceCalls[0].west);
  assert.ok(sourceCalls[1].north > sourceCalls[0].north);
  assert.ok(sourceCalls[1].east > sourceCalls[0].east);
  assert.equal(sceneEntities.length, 2, 'outline and colored route are drawn');
  assert.equal(layer.diagnostics().count, 1, 'in-view routes draw before prefetch');
  assert.equal(layer.diagnostics().requestStage, 'prefetch');
  assert.deepEqual(layer.diagnostics().coverageBounds, sourceCalls[0]);
  releasePrefetch.resolve();
  await update;

  assert.deepEqual(sceneEntities[0].polyline.material, Cesium.Color.fromCssColorString('#07131B'));
  assert.deepEqual(sceneEntities[1].polyline.material, Cesium.Color.fromCssColorString('#1267B1'));
  const routeDiagnostics = layer.diagnostics({ includeGeometry: true });
  assert.equal(routeDiagnostics.count, 1);
  assert.equal(routeDiagnostics.lastStatus, 200);
  assert.equal(routeDiagnostics.cache, 'HIT');
  assert.equal(routeDiagnostics.upstream, 'overpass.example');
  assert.deepEqual(routeDiagnostics.bounds, sourceCalls[1]);
  assert.deepEqual(routeDiagnostics.routes[0].lines, [[[-71.1, 42.35], [-71.05, 42.35]]]);
  assert.equal(layer.diagnostics().routes[0].lines, undefined);
  await layer.update({
    south: 42.3,
    west: -71.2,
    north: 42.4,
    east: -71,
  });
  assert.equal(sourceCalls.length, 2, 'cached prefetch covers nearby view pans');

  layer.setVisible(false);
  assert.equal(sceneEntities.every((entity) => entity.show === false), true);
  layer.disable();
  assert.equal(sceneEntities.length, 0);
  assert.equal(layer.diagnostics().count, 0);
});

test('a newly visible area supersedes an in-flight surrounding prefetch', async () => {
  const calls = [];
  const prefetchStarted = Promise.withResolvers();
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
        if (calls.length === 2) {
          prefetchStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
        }
        if (calls.length === 3) priorityStarted.resolve();
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
  await prefetchStarted.promise;
  const secondUpdate = layer.update({
    south: 42.41,
    west: -71.2,
    north: 42.49,
    east: -71,
  });
  await priorityStarted.promise;
  await secondUpdate;
  await firstUpdate;

  assert.equal(calls.length, 4, 'new priority area loads before its prefetch');
  assert.ok(calls[2].south <= 42.41);
  assert.ok(calls[2].north >= 42.49);
  assert.ok(calls[2].north - calls[2].south <= 0.12);
  layer.destroy();
});