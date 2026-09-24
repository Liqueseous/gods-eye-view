import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNwsAlertSnapshot } from './records.js';

const ring = [
  [-97.9, 30.2],
  [-97.8, 30.2],
  [-97.8, 30.3],
  [-97.9, 30.2],
];

function feature(overrides = {}) {
  return {
    id: 'urn:oid:test.1',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      status: 'Actual',
      event: 'Flash Flood Warning',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'Flash Flood Warning issued',
      areaDesc: 'Travis, TX',
      senderName: 'NWS Austin/San Antonio',
      effective: '2026-09-23T20:00:00-04:00',
      expires: '2026-09-24T02:00:00-04:00',
      ...overrides,
    },
  };
}

test('a valid feature collection yields normalized alert rows', () => {
  const rows = normalizeNwsAlertSnapshot({ features: [feature()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'Flash Flood Warning');
  assert.equal(rows[0].severity, 'Severe');
  assert.equal(rows[0].polygons.length, 1);
});

test('alerts without geometry are dropped, not rejected', () => {
  const rows = normalizeNwsAlertSnapshot({
    features: [feature({}), { ...feature(), geometry: null }],
  });
  assert.equal(rows.length, 1);
});

test('non-Actual status and missing event are dropped', () => {
  const rows = normalizeNwsAlertSnapshot({
    features: [
      feature({ status: 'Exercise' }),
      feature({ event: undefined }),
    ],
  });
  assert.equal(rows.length, 0);
});

test('an unknown severity falls back to Unknown rather than rejecting the row', () => {
  const rows = normalizeNwsAlertSnapshot({
    features: [feature({ severity: 'Weird' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'Unknown');
});

test('duplicate ids keep only the first occurrence', () => {
  const rows = normalizeNwsAlertSnapshot({
    features: [feature(), feature()],
  });
  assert.equal(rows.length, 1);
});

test('malformed ring geometry rejects only that feature', () => {
  const rows = normalizeNwsAlertSnapshot({
    features: [
      feature(),
      {
        ...feature({ id: 'urn:oid:test.2' }),
        geometry: { type: 'Polygon', coordinates: [[[200, 999]]] },
      },
    ],
  });
  assert.equal(rows.length, 1);
});

test('a payload that is not a feature collection at all is rejected', () => {
  assert.equal(normalizeNwsAlertSnapshot({}), null);
  assert.equal(normalizeNwsAlertSnapshot({ features: 'nope' }), null);
});
