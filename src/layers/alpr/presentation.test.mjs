// Regression test: the analyst must read what renderRecords() actually shows
// on screen, not the wider, snapped-outward fetch cache in state.records.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAlprPresentation } from './presentation.js';

function noop() {}

function makeState(records) {
  return {
    enabled: true,
    records,
    recordById: new Map(records.map((r) => [r.id, r])),
    selectedId: null,
    credit: null,
    creditPresented: false,
    dataSource: { entities: new Cesium.EntityCollection() },
    viewer: {
      camera: {
        positionWC: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 5000),
        pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-97.74, 30.27),
      },
      scene: {
        canvas: { clientWidth: 800, clientHeight: 600 },
        globe: { show: true, ellipsoid: Cesium.Ellipsoid.WGS84 },
      },
    },
    lastAnchorSampleAt: 0,
  };
}

const services = {
  render: { governorRequestRender: noop },
  context: {
    clearSelectedEntityContextForLayer: noop,
    getSelectedEntityContext: () => null,
    registerEntityContext: noop,
    removeEntityContextsForLayer: noop,
    selectEntityContext: noop,
  },
  groundFloor: { cachedGroundFloor: () => null },
};

test('getVisibleRecords reflects the current viewport, not the wider fetch cache', (t) => {
  const nearby = { id: 'near-1', latitude: 30.271, longitude: -97.74, operator: 'Near' };
  const nearButOffscreen = {
    id: 'near-2',
    latitude: 30.269,
    longitude: -97.741,
    operator: 'Near but outside the camera view cone',
  };
  const far = { id: 'far-1', latitude: 40, longitude: -80, operator: 'Far' };
  const state = makeState([nearby, nearButOffscreen, far]);
  const { renderRecords, getVisibleRecords } = createAlprPresentation({
    state,
    services,
    source: { label: 'Test', attribution: null },
  });

  // Both `nearby` and `nearButOffscreen` fall inside the loose ground-radius
  // box; only the first should also project inside the canvas — simulating
  // the box being wider than the camera's actual view cone (the bug report:
  // a generous count with far fewer pins actually on screen).
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;
  let projections = 0;
  Cesium.SceneTransforms.worldToWindowCoordinates = () => {
    projections += 1;
    return projections === 1 ? { x: 400, y: 300 } : { x: -50, y: 300 };
  };
  t.after(() => {
    Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
  });

  renderRecords();

  assert.equal(state.records.length, 3, 'the fetch cache still holds every record');
  assert.deepEqual(
    getVisibleRecords().map((r) => r.id),
    ['near-1'],
    'only the record that actually projects onto the canvas counts as visible',
  );
});
