import test from 'node:test';
import assert from 'node:assert/strict';
import { fitLandmarkGrid } from '../src/mapping/alignment.mjs';
import { mapPoint, validateGrid } from '../src/mapping/grid.mjs';

const corners = [
  { source: { u: 0, v: 0 }, target: { u: 0, v: 0 } },
  { source: { u: 1, v: 0 }, target: { u: 1, v: 0 } },
  { source: { u: 0, v: 1 }, target: { u: 0, v: 1 } },
];

test('fits identity landmarks to a valid regular grid', () => {
  const grid = fitLandmarkGrid(corners);
  assert.deepEqual(validateGrid(grid), { valid: true });
  assert.deepEqual(mapPoint(grid, { u: 0.37, v: 0.62 }), { u: 0.37, v: 0.62 });
});

test('fits affine landmarks and interpolates a local non-affine correction', () => {
  const affine = corners.map(({ target }) => ({
    target,
    source: { u: 0.1 + target.u * 0.7 + target.v * 0.1, v: 0.05 + target.v * 0.8 },
  }));
  const grid = fitLandmarkGrid(affine);
  const mapped = mapPoint(grid, { u: 0.2, v: 0.3 });
  assert.ok(Math.abs(mapped.u - 0.27) < 1e-8);
  assert.ok(Math.abs(mapped.v - 0.29) < 1e-8);

  const local = [...corners, { target: { u: 0.5, v: 0.5 }, source: { u: 0.58, v: 0.44 } }];
  const localGrid = fitLandmarkGrid(local);
  assert.ok(Math.abs(mapPoint(localGrid, local[3].target).u - 0.58) < 1e-8);
  assert.ok(Math.abs(mapPoint(localGrid, local[3].target).v - 0.44) < 1e-8);
});

test('rejects malformed, out of bounds, duplicate and collinear landmark pairs', () => {
  for (const pairs of [[], corners.slice(0, 2), [...corners, null],
    [...corners.slice(0, 2), { source: { u: 0, v: 1 }, target: { u: 2, v: 1 } }],
    [...corners.slice(0, 2), { source: { u: 0, v: 1 }, target: { u: 0, v: 0 } }],
    [...corners.slice(0, 2), { source: { u: 0, v: 1 }, target: { u: 0.5, v: 0 } }],
  ]) assert.throws(() => fitLandmarkGrid(pairs), RangeError);
});

test('rejects a folded correspondence grid with a useful reason', () => {
  const reversed = corners.map(({ source, target }) => ({
    target, source: { u: 1 - source.u, v: source.v },
  }));
  assert.throws(() => fitLandmarkGrid(reversed), /inverted|fold|collapsed/i);
});
