import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incidentMarkerSpec,
  parseIncidentForm,
  readStoredIncidents,
} from './incidentCommand.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

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

  test('stored incidents restore only valid command records', () => {
    const storage = memoryStorage({
      'gev.command.incidents.v1': JSON.stringify([
        {
          label: 'Saved fire',
          latitude: 30,
          longitude: -97,
          severity: 'critical',
          status: 'active',
          createdAt: 10,
          updatedAt: 20,
        },
        {
          label: 'Invalid',
          latitude: 95,
          longitude: 0,
          severity: 'low',
          status: 'new',
        },
      ]),
    });
    assert.deepEqual(readStoredIncidents(storage), [
      {
        label: 'Saved fire',
        latitude: 30,
        longitude: -97,
        severity: 'critical',
        status: 'active',
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
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

  test('event area marker specs preserve the drawn ring', () => {
    const ring = [
      [-97.75, 30.26],
      [-97.74, 30.26],
      [-97.74, 30.27],
    ];
    const spec = incidentMarkerSpec({
      kind: 'area',
      label: 'Flood zone',
      severity: 'high',
      status: 'new',
      ring,
    });
    assert.equal(spec.type, 'area');
    assert.equal(spec.manual, true);
    assert.deepEqual(spec.ring, ring);
    assert.equal(spec.color, 'red');
    assert.match(spec.markerIcon, /^data:image\/svg\+xml/);
  });
  assert.equal(result.ok, true);
  assert.equal(result.incident.severity, 'medium');
});
