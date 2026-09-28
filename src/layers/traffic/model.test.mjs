import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import {
  MAX_HEIGHT_SAMPLES_PER_PARSE,
  MAX_HEIGHT_SAMPLE_MS_PER_PARSE,
} from './policy.js';

function roadAt(lon, lat) {
  return {
    type: 'primary',
    oneway: 0,
    coordinates: [
      [lon, lat],
      [lon + 0.02, lat + 0.02],
    ],
  };
}

function busyWaitMs(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* burn time to simulate a costly GPU readback */
  }
}

function makeLayerState(sampleHeight) {
  return {
    _viewer: {
      scene: { sampleHeightSupported: true, sampleHeight },
    },
    _heightCellCache: new Map(),
  };
}

test('parseRoads caps new scene.sampleHeight() calls per pass', () => {
  let calls = 0;
  const layerState = makeLayerState(() => {
    calls += 1;
    return 42;
  });
  const { parseRoads } = createModel({ state: layerState });

  // Distinct cells (~111 m apart, well beyond the 3-decimal cell rounding),
  // more than the per-pass cap.
  const roadCount = MAX_HEIGHT_SAMPLES_PER_PARSE + 25;
  const roads = { roads: [] };
  for (let i = 0; i < roadCount; i++) {
    roads.roads.push(roadAt(-97.7 + i * 0.01, 30.2 + i * 0.01));
  }

  const parsed = parseRoads(roads);

  assert.equal(parsed.length, roadCount);
  assert.equal(calls, MAX_HEIGHT_SAMPLES_PER_PARSE);
});

test('parseRoads persists sampled cell heights across passes instead of re-sampling', () => {
  let calls = 0;
  const layerState = makeLayerState(() => {
    calls += 1;
    return 42;
  });
  const { parseRoads } = createModel({ state: layerState });

  const roads = {
    roads: [roadAt(-97.7, 30.2), roadAt(-97.7, 30.2)],
  };

  parseRoads(roads);
  assert.equal(calls, 1, 'first pass samples the new cell once');

  parseRoads(roads);
  assert.equal(
    calls,
    1,
    'second pass reuses the cached cell height instead of re-sampling',
  );
});

test('parseRoads retries an uncapped cell on a later pass instead of latching height 0', () => {
  let calls = 0;
  const layerState = makeLayerState(() => {
    calls += 1;
    return 42;
  });
  const { parseRoads } = createModel({ state: layerState });

  const roads = { roads: [] };
  for (let i = 0; i < MAX_HEIGHT_SAMPLES_PER_PARSE + 1; i++) {
    roads.roads.push(roadAt(-97.7 + i * 0.01, 30.2 + i * 0.01));
  }

  parseRoads(roads);
  assert.equal(calls, MAX_HEIGHT_SAMPLES_PER_PARSE);

  // Re-parsing the same data should sample the one cell that was skipped last
  // time (its height was never cached), not silently accept 0 forever.
  parseRoads(roads);
  assert.equal(calls, MAX_HEIGHT_SAMPLES_PER_PARSE + 1);
});

test('parseRoads bails out early once cumulative sampleHeight time exceeds budget', () => {
  let calls = 0;
  const perCallMs = MAX_HEIGHT_SAMPLE_MS_PER_PARSE; // one call alone spends the whole budget
  const layerState = makeLayerState(() => {
    calls += 1;
    busyWaitMs(perCallMs);
    return 42;
  });
  const { parseRoads } = createModel({ state: layerState });

  // Far more distinct cells than the count cap would ever allow, but each
  // sample alone exhausts the time budget — expensive GPU contention should
  // stop the pass well short of MAX_HEIGHT_SAMPLES_PER_PARSE.
  const roadCount = MAX_HEIGHT_SAMPLES_PER_PARSE + 10;
  const roads = { roads: [] };
  for (let i = 0; i < roadCount; i++) {
    roads.roads.push(roadAt(-97.7 + i * 0.01, 30.2 + i * 0.01));
  }

  parseRoads(roads);

  assert.ok(
    calls < MAX_HEIGHT_SAMPLES_PER_PARSE,
    `expected the time budget to stop the pass early, got ${calls} calls`,
  );
  assert.ok(calls >= 1, 'at least one sample should still happen');
});
