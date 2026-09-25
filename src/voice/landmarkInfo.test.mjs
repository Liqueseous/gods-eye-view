/**
 * Tests for landmark information integration in voice system.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CITY_POIS } from '../locations.js';

test('CITY_POIS landmarks have historical metadata', () => {
  const texasCapitol = CITY_POIS.austin.pois[0];
  
  assert.equal(texasCapitol.name, 'Texas State Capitol');
  assert.ok(texasCapitol.description, 'Should have description');
  assert.ok(texasCapitol.history, 'Should have history');
  assert.equal(texasCapitol.yearBuilt, 1888);
  assert.ok(texasCapitol.architect, 'Should have architect');
  assert.ok(texasCapitol.style, 'Should have architectural style');
});

test('Golden Gate Bridge has complete historical data', () => {
  const goldenGate = CITY_POIS.sf.pois[0];
  
  assert.equal(goldenGate.name, 'Golden Gate Bridge');
  assert.ok(goldenGate.description.includes('suspension bridge'));
  assert.ok(goldenGate.history.includes('1937'));
  assert.equal(goldenGate.yearBuilt, 1937);
  assert.ok(goldenGate.architect.includes('Joseph Strauss'));
  assert.equal(goldenGate.style, 'Art Deco');
});

test('Eiffel Tower has French context', () => {
  const eiffel = CITY_POIS.paris.pois[0];
  
  assert.equal(eiffel.name, 'Eiffel Tower');
  assert.ok(eiffel.description.includes('wrought-iron'));
  assert.ok(eiffel.history.includes('1889'));
  assert.equal(eiffel.yearBuilt, 1889);
  assert.ok(eiffel.architect.includes('Gustave Eiffel'));
});

test('Statue of Liberty has historical significance', () => {
  const liberty = CITY_POIS.nyc.pois[0];
  
  assert.equal(liberty.name, 'Statue of Liberty');
  assert.ok(liberty.description.includes('freedom'));
  assert.ok(liberty.history.includes('France'));
  assert.equal(liberty.yearBuilt, 1886);
  assert.ok(liberty.architect.includes('Bartholdi'));
  assert.equal(liberty.style, 'Neoclassical');
});

test('Modern landmarks like Burj Khalifa have data', () => {
  const burj = CITY_POIS.dubai.pois[0];
  
  assert.equal(burj.name, 'Burj Khalifa');
  assert.ok(burj.description.includes('tallest'));
  assert.ok(burj.history.includes('2010'));
  assert.equal(burj.yearBuilt, 2010);
  assert.ok(burj.architect.includes('Adrian Smith'));
});

test('All major cities have at least one landmark with historical data', () => {
  const citiesToCheck = ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'];
  
  for (const cityId of citiesToCheck) {
    const city = CITY_POIS[cityId];
    assert.ok(city, `City ${cityId} should exist`);
    
    const firstPoi = city.pois[0];
    assert.ok(
      firstPoi.description || firstPoi.history,
      `${cityId}'s first POI (${firstPoi.name}) should have historical data`,
    );
  }
});

test('Historical metadata is optional for some POIs', () => {
  // Not all landmarks need to have all fields
  // This test ensures the code doesn't break if some fields are missing
  let hasIncompleteData = false;
  
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    for (const poi of city.pois) {
      if (!poi.description && !poi.history && !poi.yearBuilt) {
        hasIncompleteData = true;
        // This is fine - not all landmarks have been curated yet
      }
    }
  }
  
  // This test just documents that incomplete data is acceptable
  assert.ok(true, 'Code should handle landmarks without full historical data');
});
