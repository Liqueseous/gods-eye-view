import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendering } from './rendering.js';

test('traffic heat-line batches are raised above later ground geometry', () => {
  const raised = [];
  const jamLines = {};
  const slowLines = {};
  const state = {
    _viewer: {
      scene: {
        groundPrimitives: {
          raiseToTop: (primitive) => raised.push(primitive),
        },
      },
    },
    _heatJamPrim: jamLines,
    _heatSlowPrim: slowLines,
  };
  const rendering = createRendering({
    state,
    services: {},
    parts: {},
    source: {},
  });

  rendering.raiseHeatLinesToTop();

  assert.deepEqual(raised, [jamLines, slowLines]);
});