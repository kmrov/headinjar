import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputState, getOutputMode, transitionOutput } from '../src/output/state.mjs';

const readyState = () => {
  let state = createOutputState();
  state = transitionOutput(state, { type: 'source-status', status: 'running' });
  state = transitionOutput(state, { type: 'source-compatible', compatible: true });
  state = transitionOutput(state, { type: 'display-confirmed', confirmed: true });
  return transitionOutput(state, { type: 'renderer-ready', ready: true });
};
const resume = (state) => transitionOutput(state, { type: 'resume' });

test('starts disconnected, disarmed, and black', () => {
  assert.deepEqual(createOutputState(), {
    sourceStatus: 'disconnected', sourceCompatible: false, displayConfirmed: false,
    rendererReady: false, armed: false, blackout: false, hold: false, sceneRevision: 0,
  });
  assert.equal(getOutputMode(createOutputState()), 'black');
});

test('readiness signals do not arm; resume needs every readiness condition', () => {
  let state = createOutputState();
  for (const event of [
    { type: 'source-status', status: 'running' },
    { type: 'source-compatible', compatible: true },
    { type: 'display-confirmed', confirmed: true },
    { type: 'renderer-ready', ready: true },
  ]) {
    state = transitionOutput(state, event);
    assert.equal(state.armed, false);
    assert.equal(getOutputMode(state), 'black');
  }
  assert.equal(getOutputMode(resume(state)), 'live');
  assert.throws(() => transitionOutput(createOutputState(), { type: 'resume' }), RangeError);
});

test('unhealthy source states disarm, clear hold, and require explicit recovery resume', () => {
  for (const status of ['preparing', 'ready', 'stalled', 'disconnected', 'error']) {
    let state = transitionOutput(resume(readyState()), { type: 'hold', enabled: true });
    state = transitionOutput(state, { type: 'source-status', status });
    assert.equal(state.armed, false, status);
    assert.equal(state.hold, false, status);
    assert.equal(getOutputMode(state), 'black', status);
    state = transitionOutput(state, { type: 'source-status', status: 'running' });
    assert.equal(state.armed, false, status);
    assert.equal(getOutputMode(state), 'black', status);
  }
});

test('invalidating any readiness condition disarms and clears hold', () => {
  const cases = [
    [{ type: 'source-compatible', compatible: false }, { type: 'source-compatible', compatible: true }],
    [{ type: 'display-confirmed', confirmed: false }, { type: 'display-confirmed', confirmed: true }],
    [{ type: 'renderer-ready', ready: false }, { type: 'renderer-ready', ready: true }],
  ];
  for (const [invalidate, restore] of cases) {
    let state = transitionOutput(resume(readyState()), { type: 'hold', enabled: true });
    state = transitionOutput(state, invalidate);
    assert.equal(state.armed, false);
    assert.equal(state.hold, false);
    state = transitionOutput(state, restore);
    assert.equal(state.armed, false);
    assert.equal(getOutputMode(state), 'black');
  }
});

test('hold requires a resumed ready output; disable is always allowed', () => {
  assert.throws(() => transitionOutput(readyState(), { type: 'hold', enabled: true }), RangeError);
  let state = transitionOutput(resume(readyState()), { type: 'hold', enabled: true });
  assert.equal(getOutputMode(state), 'held');
  state = transitionOutput(state, { type: 'hold', enabled: false });
  assert.equal(getOutputMode(state), 'live');
  assert.equal(getOutputMode(transitionOutput(state, { type: 'stop' })), 'black');
});

test('blackout overrides live and held output and remains set through stop/resume/scene changes', () => {
  const current = resume(readyState());
  let state = transitionOutput(current, { type: 'blackout', enabled: true });
  assert.equal(getOutputMode(state), 'black');
  state = transitionOutput(state, { type: 'scene-revision', revision: 3 });
  state = transitionOutput(state, { type: 'stop' });
  state = resume(state);
  assert.equal(state.blackout, true);
  assert.equal(getOutputMode(state), 'black');
  state = transitionOutput(state, { type: 'blackout', enabled: false });
  assert.equal(getOutputMode(state), 'live');
});

test('stop disarms and clears hold while preserving blackout', () => {
  let state = transitionOutput(resume(readyState()), { type: 'hold', enabled: true });
  state = transitionOutput(state, { type: 'blackout', enabled: true });
  state = transitionOutput(state, { type: 'stop' });
  assert.equal(state.armed, false);
  assert.equal(state.hold, false);
  assert.equal(state.blackout, true);
});

test('scene revisions are monotonic safe integers and leave output flags unchanged', () => {
  let state = transitionOutput(resume(readyState()), { type: 'scene-revision', revision: 9 });
  const before = { ...state };
  state = transitionOutput(state, { type: 'scene-revision', revision: 4 });
  assert.deepEqual(state, before);
  state = transitionOutput(state, { type: 'scene-revision', revision: 12 });
  assert.equal(state.sceneRevision, 12);
});

test('reducers return a new state without mutating input', () => {
  const original = readyState();
  const snapshot = { ...original };
  const result = resume(original);
  assert.notStrictEqual(result, original);
  assert.deepEqual(original, snapshot);
  assert.equal(original.armed, false);
  assert.equal(result.armed, true);
});

test('rejects malformed state and event values with RangeError', () => {
  const state = createOutputState();
  for (const invalid of [null, [], { ...state, armed: 'false' }, { ...state, surprise: true }, { ...state, armed: true }]) {
    assert.throws(() => getOutputMode(invalid), RangeError);
    assert.throws(() => transitionOutput(invalid, { type: 'stop' }), RangeError);
  }
  for (const event of [
    null, {}, { type: 'unknown' }, { type: 'source-status', status: 'stopped' },
    { type: 'blackout', enabled: 1 }, { type: 'scene-revision', revision: -1 },
    { type: 'scene-revision', revision: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'stop', extra: true },
  ]) assert.throws(() => transitionOutput(state, event), RangeError);
});
