import test from 'node:test';
import assert from 'node:assert/strict';
import { fittedSourceRect, sourcePointAt, zoomAtCursor } from '../renderer/alignment-source-view.mjs';

test('fitted source rectangle maps normalized points and rejects letterbox clicks', () => {
  const frame = { left: 10, top: 20, width: 300, height: 300 };
  const source = { width: 640, height: 360 };
  const rect = fittedSourceRect(frame.width, frame.height, source.width, source.height);
  assert.deepEqual(rect, { left: 0, top: 65.625, width: 300, height: 168.75 });
  assert.deepEqual(sourcePointAt({ clientX: 160, clientY: 170 }, frame, source, {}), { u: 0.5, v: 0.5 });
  assert.equal(sourcePointAt({ clientX: 160, clientY: 40 }, frame, source, {}), null);
});

test('cursor-anchored zoom preserves the normalized source point under the cursor', () => {
  const frame = { left: 10, top: 20, width: 320, height: 240 };
  const source = { width: 640, height: 360 };
  const state = { zoom: 2.4, panX: -47, panY: 31 };
  const cursor = { clientX: 155, clientY: 126 };
  const before = sourcePointAt(cursor, frame, source, state);
  assert.ok(before);
  const next = zoomAtCursor(state, 4.5, cursor.clientX - frame.left, cursor.clientY - frame.top);
  assert.deepEqual(sourcePointAt(cursor, frame, source, next), before);
  assert.equal(zoomAtCursor(state, 20, 10, 10).zoom, 8);
  assert.equal(zoomAtCursor(state, 0.25, 10, 10).zoom, 1);
});

test('source marker positions use the same transformed fitted content rectangle', () => {
  const rect = fittedSourceRect(300, 200, 640, 360, { zoom: 3, panX: -20, panY: 15 });
  assert.deepEqual(rect, { left: -20, top: 61.875, width: 900, height: 506.25 });
  assert.deepEqual({ x: rect.left + 0.25 * rect.width, y: rect.top + 0.75 * rect.height }, { x: 205, y: 441.5625 });
});
