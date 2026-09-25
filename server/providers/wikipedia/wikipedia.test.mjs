/**
 * Tests for Wikipedia integration service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWikipediaSummary,
  getLandmarkInfo,
  clearWikipediaCache,
} from './wikipedia.js';

test('fetchWikipediaSummary returns valid data for known landmark', async () => {
  const result = await fetchWikipediaSummary('Golden Gate Bridge');
  
  assert.equal(result.ok, true);
  assert.ok(result.extract, 'Should have an extract');
  assert.ok(result.url, 'Should have a URL');
  assert.ok(result.extract.includes('bridge') || result.extract.includes('Golden Gate'));
});

test('fetchWikipediaSummary returns not_found for nonexistent article', async () => {
  const result = await fetchWikipediaSummary('ThisLandmarkDefinitelyDoesNotExist12345');
  
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_found');
});

test('fetchWikipediaSummary validates input', async () => {
  const result = await fetchWikipediaSummary('');
  
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Invalid'));
});

test('fetchWikipediaSummary caches results', async () => {
  clearWikipediaCache();
  
  const result1 = await fetchWikipediaSummary('Eiffel Tower');
  assert.equal(result1.ok, true);
  assert.equal(result1.cached, undefined);
  
  const result2 = await fetchWikipediaSummary('Eiffel Tower');
  assert.equal(result2.ok, true);
  assert.equal(result2.cached, true);
});

test('getLandmarkInfo prefers static info when available', async () => {
  const staticInfo = {
    description: 'Test landmark description',
    history: 'Test history',
    yearBuilt: 1937,
    architect: 'Test Architect',
    style: 'Art Deco',
  };
  
  const result = await getLandmarkInfo('Test Landmark', staticInfo);
  
  assert.equal(result.ok, true);
  assert.equal(result.source, 'static');
  assert.equal(result.description, staticInfo.description);
  assert.equal(result.history, staticInfo.history);
  assert.equal(result.yearBuilt, staticInfo.yearBuilt);
});

test('getLandmarkInfo falls back to Wikipedia when no static info', async () => {
  clearWikipediaCache();
  
  const result = await getLandmarkInfo('Statue of Liberty', null);
  
  assert.equal(result.ok, true);
  assert.equal(result.source, 'wikipedia');
  assert.ok(result.extract, 'Should have Wikipedia extract');
});

test('getLandmarkInfo handles missing landmark name', async () => {
  const result = await getLandmarkInfo('', null);
  
  assert.equal(result.ok, false);
  assert.ok(result.error, 'Should have an error message');
  // The error gets transformed by getLandmarkInfo's fallback logic
  assert.equal(result.error, 'Unable to fetch landmark information');
});

test('clearWikipediaCache empties the cache', async () => {
  clearWikipediaCache();
  
  const result1 = await fetchWikipediaSummary('Big Ben');
  assert.equal(result1.ok, true);
  
  clearWikipediaCache();
  
  const result2 = await fetchWikipediaSummary('Big Ben');
  assert.equal(result2.cached, undefined, 'Should not be cached after clear');
});
