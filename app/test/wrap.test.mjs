import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapDomain, wrapFade, movedWrapTransform, rotatedWrapTransform } from '../src/mapping/wrap.mjs';
import { createProject, parseProject, serializeProject, validateProject } from '../src/project/model.mjs';
import { createHistory, editHistory, undoHistory } from '../src/project/history.mjs';

const bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
const now = '2026-09-26T12:00:00.000Z';
const pair = (u, v, source = { u, v }) => ({ source, target: { u, v } });

test('wrap coordinates follow the front and both sides, and exclude the back', () => {
  assert.deepEqual(wrapDomain([0, 0, 1], bounds), { u: 0.5, v: 0.5 });
  assert.ok(Math.abs(wrapDomain([1, 0, 0], bounds).u - 0.95) < 1e-12);
  assert.ok(Math.abs(wrapDomain([-1, 0, 0], bounds).u - 0.05) < 1e-12);
  assert.equal(wrapDomain([0, 0, -1], bounds), null);
  assert.equal(wrapFade(0), 1);
  assert.ok(wrapFade(90 * Math.PI / 180) > 0.999999);
  assert.ok(wrapFade(100 * Math.PI / 180) < 0.000001);
});

test('dragging the image across wrap coordinates keeps scale and rotation', () => {
  const original = { x: 0.125, y: -0.125, scale: 1.3, rotation: 20 };
  assert.deepEqual(movedWrapTransform(original, { u: 0.5, v: 0.5 }, { u: 0.625, v: 0.5625 }),
    { x: 0.25, y: -0.0625, scale: 1.3, rotation: 20 });
});

test('horizontal right drag rotates the image without moving or scaling it', () => {
  const original = { x: 0.125, y: -0.125, scale: 1.3, rotation: 20 };
  assert.deepEqual(rotatedWrapTransform(original, 200, 300),
    { x: 0.125, y: -0.125, scale: 1.3, rotation: 70 });
  assert.equal(rotatedWrapTransform(original, 200, 150).rotation, -5);
  assert.equal(rotatedWrapTransform({ ...original, rotation: 170 }, 200, 250).rotation, -165);
});

test('wrap placement has independent undoable alignment and round-trips with old projects', () => {
  const project = createProject({ id: 'wrap-head', name: 'Wrap head', now });
  const front = structuredClone(project.placement.grid);
  let history = createHistory(project);
  history = editHistory(history, { type: 'mapping-mode', value: 'wrap' }, now);
  history = editHistory(history, { type: 'placement-transform', value: { x: 0.1, y: 0, scale: 1, rotation: 0 } }, now);
  assert.equal(history.project.placement.wrap.transform.x, 0.1);
  assert.equal(history.project.placement.transform.x, 0);
  const pairs = [pair(0.2, 0.2), pair(0.8, 0.2), pair(0.5, 0.8)];
  history = editHistory(history, { type: 'alignment-apply', value: pairs }, now);
  assert.equal(history.project.placement.wrap.grid.columns, 17);
  assert.deepEqual(history.project.placement.grid, front);
  assert.deepEqual(history.project.placement.wrap.alignment.pairs, pairs);
  assert.equal(history.project.placement.wrap.transform.x, 0);
  assert.equal(undoHistory(history, now).project.placement.wrap.transform.x, 0.1);
  assert.deepEqual(parseProject(serializeProject(history.project)).placement.wrap, history.project.placement.wrap);
  const legacy = structuredClone(project);
  delete legacy.placement.wrap;
  assert.equal(validateProject(legacy).valid, true);
  assert.deepEqual(parseProject(serializeProject(legacy)).placement, legacy.placement);
});
