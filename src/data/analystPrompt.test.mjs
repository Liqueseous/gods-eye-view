import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalystPrompt } from './analystPrompt.js';

test('parses a regional flight question', () => {
  assert.deepEqual(parseAnalystPrompt('How many flights over Texas?').spec, {
    layers: ['flights'],
    scope: { kind: 'region', name: 'Texas' },
    filters: [],
    sortBy: null,
    sortDir: undefined,
    limit: 10,
  });
});

test('parses a named landmark explanation', () => {
  const parsed = parseAnalystPrompt('Tell me about the Golden Gate Bridge');
  assert.equal(parsed.kind, 'landmark');
  assert.equal(parsed.landmarkName, 'the Golden Gate Bridge');
});

test('parses a direct landmark identification question', () => {
  const parsed = parseAnalystPrompt('What is the Eiffel Tower?');
  assert.equal(parsed.kind, 'landmark');
  assert.equal(parsed.landmarkName, 'the Eiffel Tower');
});

test('parses a current-view landmark explanation without a name', () => {
  const parsed = parseAnalystPrompt('What am I looking at?');
  assert.equal(parsed.kind, 'landmark');
  assert.equal(parsed.landmarkName, '');
});

test('parses a distance query and converts miles to kilometers', () => {
  const parsed = parseAnalystPrompt('Show flights within 25 miles');
  assert.equal(parsed.spec.layers[0], 'flights');
  assert.equal(parsed.spec.scope.kind, 'radius');
  assert.equal(parsed.spec.scope.km, 40.2);
});

test('parses a ship destination query', () => {
  const parsed = parseAnalystPrompt('Which ships are headed to Oakland?');
  assert.deepEqual(parsed.spec.filters, [
    { field: 'destination', op: 'contains', value: 'Oakland' },
  ]);
  assert.equal(parsed.spec.layers[0], 'ais-live-vessels');
});

test('keeps an explicit in-view query camera-scoped', () => {
  const parsed = parseAnalystPrompt('Show the biggest fires in view');
  assert.deepEqual(parsed.spec.scope, { kind: 'view' });
  assert.equal(parsed.spec.sortBy, 'frp');
});

test('rejects a named radius target until target-centering is available', () => {
  const parsed = parseAnalystPrompt('Show flights within 25 km of the wildfire');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Targeted radius/);
});

test('rejects ambiguous prompts instead of guessing a layer', () => {
  const parsed = parseAnalystPrompt('What is happening near Texas?');
  assert.equal(parsed.ok, false);
});

test('a "military flights" ask resolves the dedicated military layer, not generic flights', () => {
  const parsed = parseAnalystPrompt('How many military flights over Texas?');
  assert.equal(parsed.spec.layers[0], 'military');
  assert.equal(parsed.spec.scope.name, 'Texas');
});

test('parses fire perimeters distinctly from fire hotspots', () => {
  const parsed = parseAnalystPrompt('Show the biggest wildfire perimeters in view');
  assert.equal(parsed.spec.layers[0], 'fire-perimeters');
  assert.equal(parsed.spec.sortBy, 'acres');
});

test('parses dams and datacenters as OSM-backed infrastructure layers', () => {
  assert.equal(parseAnalystPrompt('How many dams in view?').spec.layers[0], 'local-dams');
  assert.equal(
    parseAnalystPrompt('How many datacenters in view?').spec.layers[0],
    'local-datacenters',
  );
});

test('parses ALPR camera questions', () => {
  const parsed = parseAnalystPrompt('How many ALPR cameras in view?');
  assert.equal(parsed.spec.layers[0], 'alpr-cameras');
  assert.equal(parsed.layerLabel, 'ALPR cameras');
});

test('parses an earthquake magnitude filter', () => {
  const parsed = parseAnalystPrompt('Earthquakes above magnitude 5 in view');
  assert.equal(parsed.spec.layers[0], 'earthquakes');
  assert.deepEqual(parsed.spec.filters, [
    { field: 'magnitude', op: 'gt', value: 5 },
  ]);
});

test('parses an altitude filter and converts feet to meters', () => {
  const parsed = parseAnalystPrompt('Show flights above 40,000 feet');
  assert.deepEqual(parsed.spec.filters, [
    { field: 'altitudeM', op: 'gt', value: 12192 },
  ]);
});

test('parses a below-altitude filter', () => {
  const parsed = parseAnalystPrompt('Show flights below 10,000 feet');
  assert.deepEqual(parsed.spec.filters, [
    { field: 'altitudeM', op: 'lt', value: 3048 },
  ]);
});

test('parses a ship speed filter', () => {
  const parsed = parseAnalystPrompt('Which ships are faster than 15 knots?');
  assert.deepEqual(parsed.spec.filters, [
    { field: 'speedKts', op: 'gt', value: 15 },
  ]);
});

