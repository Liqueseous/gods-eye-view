import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSharedFrameBudget,
  getSharedFrameBudgetDiagnostics,
  recordSharedFrameBudget,
  resetSharedFrameBudgetForTest,
  sharedFrameBudgetAllows,
} from './frameBudget.js';

test.afterEach(() => resetSharedFrameBudgetForTest());

test('shared frame budget is shared across owners and records diagnostics', () => {
  beginSharedFrameBudget(10, 12);
  assert.equal(sharedFrameBudgetAllows(8), true);
  recordSharedFrameBudget('flights-hidden', 3);
  recordSharedFrameBudget('military-hidden', 2);
  const diagnostics = getSharedFrameBudgetDiagnostics();
  assert.deepEqual(diagnostics.owners, {
    'flights-hidden': { calls: 1, elapsedMs: 3 },
    'military-hidden': { calls: 1, elapsedMs: 2 },
  });
});

test('a new frame token resets the shared budget window', () => {
  beginSharedFrameBudget(10, 1);
  recordSharedFrameBudget('flights-hidden', 1);
  beginSharedFrameBudget(11, 8);
  assert.equal(getSharedFrameBudgetDiagnostics().budgetMs, 8);
  assert.deepEqual(getSharedFrameBudgetDiagnostics().owners, {});
});
