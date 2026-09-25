import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createTunnelsLayer, midpointOfLine } from './index.js';

const road = {
  id: 'road-1',
  kind: 'road',
  name: 'Downtown Tunnel',
  coordinates: [
    [-71.1, 42.3],
    [-71.08, 42.32],
    [-71.06, 42.35],
  ],
};
const rail = {
  id: 'rail-2',
  kind: 'rail',
  name: 'Orange Line',
  coordinates: [
    [-71.09, 42.31],
    [-71.07, 42.34],
  ],
};
const unnamed = {
  id: 'road-3',
  kind: 'road',
  name: null,
  coordinates: [
    [-71.11, 42.3],
    [-71.1, 42.31],
  ],
};

function harness(t) {
  t.mock.method(Cesium.GroundPolylinePrimitive, 'isSupported', () => false);
  const overlays = new Map();
  const primitives = [];
  const entities = [];
  const moveEnd = new Cesium.Event();
  let rectangle = Cesium.Rectangle.fromDegrees(-71.2, 42.2, -70.9, 42.5);
  let pickedCenter = { lon: -71.08, lat: 42.35 };
  const viewer = {
    camera: {
      moveEnd,
      positionCartographic: {
        height: 5_000,
        latitude: Cesium.Math.toRadians(42.35),
        longitude: Cesium.Math.toRadians(-71.08),
      },
      computeViewRectangle: () => rectangle,
      pickEllipsoid: () =>
        Cesium.Cartesian3.fromDegrees(pickedCenter.lon, pickedCenter.lat),
    },
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      groundPrimitives: {
        add(primitive) {
          primitives.push(primitive);
          return primitive;
        },
        remove(primitive) {
          const index = primitives.indexOf(primitive);
          if (index >= 0) primitives.splice(index, 1);
          return index >= 0;
        },
      },
      requestRender() {},
    },
    entities: {
      add(entity) {
        entities.push(entity);
        return entity;
      },
      remove(entity) {
        const index = entities.indexOf(entity);
        if (index >= 0) entities.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const requests = [];
  const layer = createTunnelsLayer({
    source: {
      async requestTunnels(bounds) {
        requests.push(bounds);
        return {
          ok: true,
          json: async () => ({ tunnels: [road, rail, unnamed] }),
        };
      },
    },
    services: {
      overlays: {
        setVisible: (id, visible) => overlays.set(`${id}:visible`, visible),
        setEntries: (id, entries, options) =>
          overlays.set(id, { entries, options }),
        clearSource: (id) => overlays.delete(id),
      },
    },
  });
  layer.init(viewer);
  t.after(() => layer.destroy());
  return {
    layer,
    viewer,
    overlays,
    primitives,
    entities,
    requests,
    setRectangle(next) {
      rectangle = next;
    },
    setCameraCenter(lon, lat) {
      pickedCenter = { lon, lat };
    },
    moveEnd,
  };
}

test('tunnel labels anchor at the distance midpoint of their line', () => {
  assert.deepEqual(midpointOfLine(road.coordinates).length, 2);
  assert.deepEqual(
    midpointOfLine([
      [1, 2],
      [1, 2],
    ]),
    [1, 2],
  );
});

test('tunnel layer fetches bounded geometry, styles road and rail separately, and publishes named labels', async (t) => {
  const app = harness(t);
  await app.layer.enable(app.viewer);

  assert.equal(app.requests.length, 1);
  const bounds = app.requests[0];
  assert.ok(bounds.north - bounds.south <= 0.180001);
  assert.ok(bounds.east - bounds.west <= 0.180001);
  assert.equal(
    app.layer.getStats().error,
    null,
    app.layer.getStats().error || '',
  );
  assert.equal(app.primitives.length, 0);
  assert.equal(
    app.entities.length,
    6,
    'outline plus road and rail color passes',
  );
  assert.equal(app.entities[0].polyline.width, 5);
  assert.equal(app.entities[0].polyline.clampToGround, true);
  assert.equal(app.entities[3].polyline.width, 2.4);
  assert.equal(
    app.entities[3].polyline.material.toCssHexString().toLowerCase(),
    '#f5b942',
  );
  assert.equal(app.entities[5].polyline.width, 2.8);
  assert.equal(
    app.entities[5].polyline.material.toCssHexString().toLowerCase(),
    '#50d8f0',
  );
  const published = app.overlays.get('tunnels');
  assert.equal(
    published.entries.length,
    2,
    'unnamed ways have no fabricated label',
  );
  assert.deepEqual(
    published.entries.map(({ title }) => title),
    ['Downtown Tunnel', 'Orange Line'],
  );
  assert.equal(published.options.moving, false);
  assert.deepEqual(app.layer.getStats(), {
    count: 3,
    roadCount: 2,
    railCount: 1,
    namedCount: 2,
    loading: false,
    lastUpdate: app.layer.getStats().lastUpdate,
    error: null,
    zoomLimited: false,
  });
});

test('tunnel layer reloads after camera move and releases its geometry and labels on disable', async (t) => {
  const app = harness(t);
  await app.layer.enable(app.viewer);
  app.setRectangle(Cesium.Rectangle.fromDegrees(-70.8, 42.2, -70.5, 42.5));
  app.setCameraCenter(-70.65, 42.35);
  app.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.length, 2);

  app.layer.disable();
  assert.equal(app.entities.length, 0);
  assert.equal(app.overlays.has('tunnels'), false);
  assert.equal(app.overlays.get('tunnels:visible'), false);
  assert.equal(app.layer.getStats().count, 0);
});
