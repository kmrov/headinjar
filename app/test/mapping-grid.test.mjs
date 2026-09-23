import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGrid,
  validateGrid,
  moveGridPoint,
  mapPoint,
  isInsideSource,
} from '../src/mapping/grid.mjs';

const closePoint = (actual, expected, epsilon = 1e-10) => {
  assert.ok(actual, 'expected a mapped point');
  assert.ok(Math.abs(actual.u - expected.u) <= epsilon, `u: expected ${expected.u}, got ${actual.u}`);
  assert.ok(Math.abs(actual.v - expected.v) <= epsilon, `v: expected ${expected.v}, got ${actual.v}`);
};

test('createGrid creates regular vertex coordinates and validates', () => {
  const grid = createGrid(3, 2);
  assert.deepEqual(grid, {
    columns: 3,
    rows: 2,
    points: [
      { u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 1, v: 0 },
      { u: 0, v: 1 }, { u: 0.5, v: 1 }, { u: 1, v: 1 },
    ],
  });
  assert.deepEqual(validateGrid(grid), { valid: true });
});

test('identity mapping is exact on corners, center, and cell diagonal', () => {
  const grid = createGrid(3, 3);
  for (const point of [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }, { u: 0.5, v: 0.5 }, { u: 0.25, v: 0.25 }]) {
    closePoint(mapPoint(grid, point), point);
  }
});

test('interpolates explicit affine source mapping throughout each triangle', () => {
  const grid = createGrid(3, 3);
  grid.points = grid.points.map(({ u, v }) => ({ u: 2 * u + 1, v: 3 * v - 1 }));
  closePoint(mapPoint(grid, { u: 0.25, v: 0.75 }), { u: 1.5, v: 1.25 });
  closePoint(mapPoint(grid, { u: 0.5, v: 0.5 }), { u: 2, v: 0.5 });
});

test('mapping stays continuous on both sides of the fixed diagonal', () => {
  const grid = createGrid(2, 2);
  grid.points[1] = { u: 1.2, v: -0.1 };
  grid.points[2] = { u: -0.1, v: 1.3 };
  const epsilon = 1e-8;
  const above = mapPoint(grid, { u: 0.5 + epsilon, v: 0.5 - epsilon });
  const below = mapPoint(grid, { u: 0.5 - epsilon, v: 0.5 + epsilon });
  assert.ok(Math.hypot(above.u - below.u, above.v - below.v) < 1e-6);
});

test('rejects inverted or collapsed triangles without mutating the input grid', () => {
  const valid = createGrid(2, 2);
  const snapshot = structuredClone(valid);
  assert.throws(() => moveGridPoint(valid, 1, { u: -0.1, v: 1 }), RangeError);
  assert.deepEqual(valid, snapshot);
  assert.throws(() => moveGridPoint(valid, 1, { u: 0, v: 0 }), RangeError);
  assert.deepEqual(valid, snapshot);
});

test('validates every triangle including cells away from a moved vertex', () => {
  const grid = createGrid(3, 3);
  grid.points[8] = { u: 0, v: 0 };
  assert.equal(validateGrid(grid).valid, false);
  const alreadyInvalid = createGrid(3, 3);
  alreadyInvalid.points[8] = { u: 0, v: 0 };
  const beforeMove = structuredClone(alreadyInvalid);
  assert.throws(() => moveGridPoint(alreadyInvalid, 0, { u: 0.01, v: 0 }), RangeError);
  assert.deepEqual(alreadyInvalid, beforeMove);
});

test('moveGridPoint returns an independent grid on success', () => {
  const grid = createGrid(2, 2);
  const moved = moveGridPoint(grid, 1, { u: 1.1, v: -0.1 });
  assert.deepEqual(grid, createGrid(2, 2));
  assert.deepEqual(moved.points[1], { u: 1.1, v: -0.1 });
  assert.notEqual(moved, grid);
  assert.notEqual(moved.points, grid.points);
});

test('rejects malformed grids, points, indices, and dimensions with explained errors', () => {
  for (const [columns, rows] of [[1, 2], [65, 2], [2.5, 2], [NaN, 2], [2, Infinity]]) {
    assert.throws(() => createGrid(columns, rows), (error) => error instanceof RangeError && error.message.length > 0);
  }
  for (const bad of [null, {}, { columns: 2, rows: 2, points: [] },
    { columns: 2, rows: 2, points: Array(4).fill({ u: NaN, v: 0 }) },
    { columns: 2, rows: 2, points: Array(4).fill({ u: 0, v: Infinity }) }]) {
    assert.equal(validateGrid(bad).valid, false);
    assert.equal(typeof validateGrid(bad).reason, 'string');
  }
  const grid = createGrid(2, 2);
  for (const index of [-1, 4, 1.5, NaN]) {
    assert.throws(() => moveGridPoint(grid, index, { u: 0, v: 0 }), (error) => error instanceof RangeError && error.message.length > 0);
  }
  for (const point of [null, {}, { u: NaN, v: 0 }, { u: 0, v: Infinity }]) {
    assert.throws(() => moveGridPoint(grid, 1, point), RangeError);
  }
});

test('mapPoint returns null outside front domain and source bounds are separate', () => {
  const grid = createGrid(2, 2);
  grid.points = grid.points.map(({ u, v }) => ({ u: 2 * u + 1, v: 3 * v - 1 }));
  assert.equal(mapPoint(grid, { u: -0.01, v: 0.5 }), null);
  assert.equal(mapPoint(grid, { u: 0.5, v: 1.01 }), null);
  const outside = mapPoint(grid, { u: 0.5, v: 0.5 });
  closePoint(outside, { u: 2, v: 0.5 });
  assert.equal(isInsideSource(outside), false);
  assert.equal(isInsideSource({ u: 0, v: 1 }), true);
  assert.equal(isInsideSource({ u: NaN, v: 0.5 }), false);
  assert.equal(isInsideSource({ u: 0.5, v: Infinity }), false);
});

test('reports sparse point arrays as explained invalid-grid errors', () => {
  const grid = createGrid(2, 2);
  delete grid.points[1];
  const result = validateGrid(grid);
  assert.equal(result.valid, false);
  assert.match(result.reason, /grid\.points\[1\]/);
  assert.throws(() => moveGridPoint(grid, 0, { u: 0, v: 0 }), (error) => error instanceof RangeError && /grid\.points\[1\]/.test(error.message));
  assert.throws(() => mapPoint(grid, { u: 0.2, v: 0.2 }), (error) => error instanceof RangeError && /grid\.points\[1\]/.test(error.message));
});

test('rejects non-finite triangle determinants caused by finite-coordinate overflow', () => {
  const collapsed = {
    columns: 2,
    rows: 2,
    points: [
      { u: 0, v: 0 },
      { u: 1e200, v: 1e200 },
      { u: 1e200, v: 1e200 },
      { u: -1e200, v: -1e200 },
    ],
  };
  const result = validateGrid(collapsed);
  assert.equal(result.valid, false);
  assert.match(result.reason, /determinant|triangle/i);
  assert.throws(() => moveGridPoint(collapsed, 0, { u: 0, v: 0 }), RangeError);
});

test('uses the declared TL-TR-BR and TL-BR-BL interpolation on each triangle', () => {
  const grid = createGrid(2, 2);
  grid.points = [
    { u: 0, v: 0 },
    { u: 2, v: 0 },
    { u: 0, v: 1 },
    { u: 3, v: 2 },
  ];
  assert.deepEqual(validateGrid(grid), { valid: true });
  closePoint(mapPoint(grid, { u: 0.75, v: 0.25 }), { u: 1.75, v: 0.5 });
  closePoint(mapPoint(grid, { u: 0.25, v: 0.75 }), { u: 0.75, v: 1 });
});
