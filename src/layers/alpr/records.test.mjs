// Focused tests for the pure ALPR analyst-record mapper (analyst query engine seam).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalystRecord } from './records.js';

const FULL_CAMERA = {
  id: 'alpr:123',
  osmId: 123,
  latitude: 30.27,
  longitude: -97.74,
  operator: 'City of Austin',
  manufacturer: 'Flock Safety',
  cameraType: 'fixed',
  zone: 'downtown',
  directionDeg: 180,
};

test('alpr analyst record: full record maps every contract field', () => {
  assert.deepEqual(mapAnalystRecord(FULL_CAMERA), {
    id: 'alpr:123',
    lat: 30.27,
    lon: -97.74,
    operator: 'City of Austin',
    manufacturer: 'Flock Safety',
    cameraType: 'fixed',
    zone: 'downtown',
    directionDeg: 180,
  });
});

test('alpr analyst record: missing optional fields are null, never undefined', () => {
  const r = mapAnalystRecord({ id: 'alpr:9', latitude: 1, longitude: 2 });
  assert.equal(r.operator, null);
  assert.equal(r.manufacturer, null);
  assert.equal(r.cameraType, null);
  assert.equal(r.zone, null);
  assert.equal(r.directionDeg, null);
});

test('alpr analyst record: a missing id falls back to a readable label', () => {
  assert.equal(mapAnalystRecord({ latitude: 1, longitude: 2 }).id, 'ALPR camera');
});
