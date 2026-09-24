import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncidentForm } from './incidentCommand.js';

test('incident form parsing normalizes a valid incident', () => {
  assert.deepEqual(
    parseIncidentForm({
      label: ' Port fire ',
      latitude: '30.2672',
      longitude: '-97.7431',
      severity: 'high',
    }),
    {
      ok: true,
      incident: {
        label: 'Port fire',
        latitude: 30.2672,
        longitude: -97.7431,
        severity: 'high',
      },
    },
  );
});

test('incident form parsing rejects invalid coordinates and labels', () => {
  assert.equal(
    parseIncidentForm({
      label: '',
      latitude: '30',
      longitude: '-97',
      severity: 'low',
    }).ok,
    false,
  );
  assert.equal(
    parseIncidentForm({
      label: 'Fire',
      latitude: '91',
      longitude: '-97',
      severity: 'low',
    }).ok,
    false,
  );
});

test('incident form parsing falls back to medium for unknown severity', () => {
  const result = parseIncidentForm({
    label: 'Road closure',
    latitude: '0',
    longitude: '0',
    severity: 'urgent',
  });
  assert.equal(result.ok, true);
  assert.equal(result.incident.severity, 'medium');
});
