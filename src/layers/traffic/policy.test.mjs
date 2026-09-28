import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptTrafficDotCap,
  MAX_DOTS,
  MIN_ADAPTIVE_DOTS,
} from './policy.js';

test('traffic dot cap backs off under expensive construction', () => {
  assert.equal(adaptTrafficDotCap(MAX_DOTS, 20), 4800);
  assert.equal(adaptTrafficDotCap(MIN_ADAPTIVE_DOTS, 20), MIN_ADAPTIVE_DOTS);
});

test('traffic dot cap recovers gradually when construction is cheap', () => {
  assert.equal(adaptTrafficDotCap(3000, 2), 3301);
  assert.equal(adaptTrafficDotCap(MAX_DOTS, 2), MAX_DOTS);
});