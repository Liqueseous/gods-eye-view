import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentMarkerSpec, parseIncidentForm } from './incidentCommand.js';

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

  test('incident marker spec exposes status and severity on the pin', () => {
    const spec = incidentMarkerSpec({
      label: 'Port fire',
      latitude: 30,
      longitude: -97,
      severity: 'high',
      status: 'active',
    });
    assert.equal(spec.type, 'pin');
    assert.equal(spec.label, '[ACTIVE] [HIGH] Port fire');
    assert.equal(spec.color, 'red');
    assert.match(spec.markerIcon, /^data:image\/svg\+xml/);
    assert.equal(spec.latitude, 30);
    assert.equal(spec.longitude, -97);
  });

  test('incident marker severity remains the pin color after status changes', () => {
    assert.equal(
      incidentMarkerSpec({
        label: 'Shelter',
        latitude: 30,
        longitude: -97,
        severity: 'critical',
        status: 'contained',
      }).color,
      'red',
    );
  });
  assert.equal(result.ok, true);
  assert.equal(result.incident.severity, 'medium');
});
