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

function createFetchStub(response) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url, options });
    return typeof response === 'function'
      ? response({ url, options, callCount: calls.length })
      : response;
  };
  stub.calls = calls;
  return stub;
}

function createWikipediaResponse({
  ok = true,
  status = 200,
  extract = 'A landmark summary',
  url = 'https://en.wikipedia.org/wiki/Test',
  description = 'Landmark description',
  thumbnail = 'https://upload.wikimedia.org/example.jpg',
} = {}) {
  return {
    ok,
    status,
    async json() {
      return {
        extract,
        description,
        thumbnail: thumbnail ? { source: thumbnail } : undefined,
        content_urls: { desktop: { page: url } },
      };
    },
  };
}

test('fetchWikipediaSummary returns valid data for known landmark', async () => {
  const fetchImpl = createFetchStub(
    createWikipediaResponse({
      extract: 'Golden Gate Bridge is a suspension bridge in San Francisco.',
      url: 'https://en.wikipedia.org/wiki/Golden_Gate_Bridge',
      description: 'Suspension bridge in California',
    }),
  );
  const result = await fetchWikipediaSummary('Golden Gate Bridge', { fetchImpl });

  assert.equal(result.ok, true);
  assert.ok(result.extract, 'Should have an extract');
  assert.ok(result.url, 'Should have a URL');
  assert.ok(result.extract.includes('bridge') || result.extract.includes('Golden Gate'));
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchWikipediaSummary returns not_found for nonexistent article', async () => {
  const fetchImpl = createFetchStub({ ok: false, status: 404 });
  const result = await fetchWikipediaSummary(
    'ThisLandmarkDefinitelyDoesNotExist12345',
    { fetchImpl },
  );

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

  const fetchImpl = createFetchStub(
    createWikipediaResponse({
      extract: 'The Eiffel Tower is an iron lattice tower in Paris.',
      url: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
    }),
  );
  const result1 = await fetchWikipediaSummary('Eiffel Tower', { fetchImpl });
  assert.equal(result1.ok, true);
  assert.equal(result1.cached, undefined);

  const result2 = await fetchWikipediaSummary('Eiffel Tower', { fetchImpl });
  assert.equal(result2.ok, true);
  assert.equal(result2.cached, true);
  assert.equal(fetchImpl.calls.length, 1);
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

  const fetchImpl = createFetchStub(
    createWikipediaResponse({
      extract: 'The Statue of Liberty is a colossal neoclassical sculpture.',
      url: 'https://en.wikipedia.org/wiki/Statue_of_Liberty',
      description: 'Colossal neoclassical sculpture on Liberty Island',
    }),
  );
  const result = await getLandmarkInfo('Statue of Liberty', null, { fetchImpl });

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

  const fetchImpl = createFetchStub(
    createWikipediaResponse({
      extract: 'Big Ben is the nickname for the Great Bell of the clock.',
      url: 'https://en.wikipedia.org/wiki/Big_Ben',
    }),
  );
  const result1 = await fetchWikipediaSummary('Big Ben', { fetchImpl });
  assert.equal(result1.ok, true);

  clearWikipediaCache();

  const result2 = await fetchWikipediaSummary('Big Ben', { fetchImpl });
  assert.equal(result2.cached, undefined, 'Should not be cached after clear');
  assert.equal(fetchImpl.calls.length, 2);
});
