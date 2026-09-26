import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/project/model.mjs';
import { createHistory, editHistory, undoHistory } from '../src/project/history.mjs';
import { commandForAddedAlignmentPair } from '../renderer/alignment-addition.mjs';

const now = '2026-09-26T00:00:00.000Z';
const pair = (u, v, source = { u, v }) => ({ source, target: { u, v } });
const corners = [pair(0, 0), pair(1, 0), pair(0, 1)];
const history = () => createHistory(createProject({ id: 'auto-align', name: 'Auto align', now }));

test('adding the third valid pair applies the grid in the same undo step', () => {
  let state = history();
  for (let count = 1; count <= 3; count += 1) {
    const { command, warning } = commandForAddedAlignmentPair(corners.slice(0, count));
    assert.equal(warning, null);
    state = editHistory(state, command, now);
    assert.equal(state.project.revision, count);
    assert.equal(state.project.placement.grid.columns, count < 3 ? 5 : 17);
  }
  const undone = undoHistory(state, now);
  assert.equal(undone.project.placement.alignment.pairs.length, 2);
  assert.equal(undone.project.placement.grid.columns, 5);
});

test('adding a later valid pair refits the grid', () => {
  const before = editHistory(history(), commandForAddedAlignmentPair(corners).command, now);
  const shifted = pair(0.5, 0.5, { u: 0.6, v: 0.5 });
  const after = editHistory(before, commandForAddedAlignmentPair([...corners, shifted]).command, now);
  assert.equal(after.project.placement.grid.columns, 17);
  assert.notDeepEqual(after.project.placement.grid, before.project.placement.grid);
  assert.equal(after.project.revision, before.project.revision + 1);
});

test('an invalid third pair is saved without replacing the current grid', () => {
  const invalid = [pair(0, 0), pair(1, 0), pair(0.5, 0)];
  const { command, warning } = commandForAddedAlignmentPair(invalid);
  assert.match(warning, /collinear/i);
  const before = history();
  const after = editHistory(before, command, now);
  assert.deepEqual(after.project.placement.alignment.pairs, invalid);
  assert.deepEqual(after.project.placement.grid, before.project.placement.grid);
});
