import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceFromHit, surfaceProjectionFrame } from '../src/mapping/surface.mjs';

test('places an image upright on a visible +X side and keeps its scale while dragging', () => {
  const first = surfaceFromHit([1, 0, 0], [1, 0, 0]);
  assert.deepEqual(first, {
    position: [1, 0, 0], normal: [1, 0, 0], up: [0, 1, 0], scale: 1, rotation: 0,
  });
  const moved = surfaceFromHit([0, 1, 0], [0, 1, 0], { ...first, scale: 1.5, rotation: 25 });
  assert.deepEqual(moved.position, [0, 1, 0]);
  assert.deepEqual(moved.normal, [0, 1, 0]);
  assert.equal(moved.scale, 1.5);
  assert.equal(moved.rotation, 25);
  assert.ok(Math.abs(moved.up[1]) < 1e-12);
});

test('surface placement supports a -Z side and rejects degenerate hit normals', () => {
  const back = surfaceFromHit([0, 0, -1], [0, 0, -2]);
  assert.deepEqual(back.normal, [0, 0, -1]);
  assert.deepEqual(back.up, [0, 1, 0]);
  const frame=surfaceProjectionFrame(back,{min:[-1,-1,-1],max:[1,1,1]});
  assert.deepEqual(frame.right,[-1,0,0]);
  assert.deepEqual(frame.up,[0,1,0]);
  assert.equal(surfaceFromHit([0, 0, 0], [0, 0, 0]), null);
});

test('surface projection frame covers the selected side and the model depth', () => {
  const surface = surfaceFromHit([1, 0, 0], [1, 0, 0]);
  assert.deepEqual(surfaceProjectionFrame(surface, { min: [-1, -1, -1], max: [1, 1, 1] }), {
    origin: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0], normal: [1, 0, 0],
    width: 2, height: 2, depthMin: -2, depthRange: 2,
  });
});

test('surface rotation turns the projection basis around the selected normal', () => {
  const surface={...surfaceFromHit([1,0,0],[1,0,0]),rotation:90};
  const frame=surfaceProjectionFrame(surface,{min:[-1,-1,-1],max:[1,1,1]});
  assert.deepEqual(frame.right,[0,1,0]);
  assert.deepEqual(frame.up,[0,0,1]);
});

test('extreme finite rotation keeps a usable projection basis', () => {
  const surface = { ...surfaceFromHit([1,0,0],[1,0,0]), rotation: 1e308 };
  const frame = surfaceProjectionFrame(surface, { min: [-1,-1,-1], max: [1,1,1] });
  assert.ok([...frame.right, ...frame.up].every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...frame.right) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...frame.up) - 1) < 1e-9);
});
