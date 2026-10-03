import test from 'node:test';
import assert from 'node:assert/strict';
import { simplifyFlowLine } from './flowDecode.js';

test('traffic flow geometry keeps endpoints while removing near-collinear vertices', () => {
  const line = [
    [-71, 42],
    [-70.99999, 42.00001],
    [-70.99998, 42.00002],
    [-70.999, 42.001],
    [-70.998, 42.002],
  ];
  const simplified = simplifyFlowLine(line, 0.00005);
  assert.deepEqual(simplified[0], line[0]);
  assert.deepEqual(simplified.at(-1), line.at(-1));
  assert.ok(simplified.length < line.length);
});
