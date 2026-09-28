import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OVERPASS_SELF_HOSTED_URL = 'http://overpass:80/api/interpreter';
process.env.OVERPASS_SELF_HOSTED_BBOX = '40.9,-73.8,47.6,-66.7';

const { resolveOverpassEndpoints } = await import('./selfHosted.js');

test('form-encoded in-coverage bboxes select the self-hosted Overpass first', () => {
  const body = new URLSearchParams({
    data: '[out:json];way["highway"](42.3,-71.1,42.4,-71.0);out geom qt;',
  }).toString();
  assert.equal(resolveOverpassEndpoints(body)[0], process.env.OVERPASS_SELF_HOSTED_URL);
});

test('out-of-coverage bboxes skip the regional database', () => {
  const body = new URLSearchParams({
    data: '[out:json];way["highway"](30,-98,30.1,-97.9);out geom qt;',
  }).toString();
  assert.notEqual(resolveOverpassEndpoints(body)[0], process.env.OVERPASS_SELF_HOSTED_URL);
});