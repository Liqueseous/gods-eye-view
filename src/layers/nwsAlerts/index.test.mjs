import test from 'node:test';
import assert from 'node:assert/strict';
import { alertIdFromPickId, createNwsAlertsLayer } from './index.js';

const row = {
  stableId: 'urn:oid:test.1',
  event: 'Flash Flood Warning',
  severity: 'Severe',
  urgency: 'Immediate',
  certainty: 'Observed',
  headline: 'Flash Flood Warning issued',
  description: null,
  instruction: null,
  areaDesc: 'Travis, TX',
  senderName: 'NWS Austin/San Antonio',
  effective: '2026-09-23T20:00:00-04:00',
  expires: '2026-09-24T02:00:00-04:00',
  polygons: [
    [
      [
        [-97.9, 30.2],
        [-97.8, 30.2],
        [-97.8, 30.3],
        [-97.9, 30.2],
      ],
    ],
  ],
};

function viewerFixture() {
  const dataSources = [];
  return {
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
      },
      remove(dataSource, destroy) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        if (destroy) dataSource.destroy?.();
        return index >= 0;
      },
      get length() {
        return dataSources.length;
      },
      get(index) {
        return dataSources[index];
      },
    },
    scene: { canvas: {} },
  };
}

test('pick ids preserve NWS URNs when resolving selected alerts', () => {
  const id = 'urn:oid:test.1';
  assert.equal(
    alertIdFromPickId(`nws-alert:${id}:0`, new Set([id])),
    id,
  );
  assert.equal(
    alertIdFromPickId('nws-alert:missing:0', new Set([id])),
    null,
  );
});

test('the layer owns a refreshable Cesium data source lifecycle', async () => {
  const viewer = viewerFixture();
  const layer = createNwsAlertsLayer({
    source: { getSnapshot: async () => [row] },
  });

  layer.init(viewer);
  assert.equal(viewer.dataSources.length, 1);
  assert.equal(layer.getStats().count, 0);

  layer.enable();
  assert.equal(await layer.update(), true);
  assert.deepEqual(layer.getStats().count, 1);
  assert.equal(layer.getAnalystRecords()[0].id, row.stableId);
  assert.equal(viewer.dataSources.get(0).entities.values.length, 1);

  layer.disable();
  assert.equal(layer.getAnalystRecords().length, 0);
  assert.equal(viewer.dataSources.get(0).show, false);

  layer.destroy(viewer);
  assert.equal(viewer.dataSources.length, 0);
});
