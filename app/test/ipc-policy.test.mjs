import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedEditorSender,
  isValidDisplayId,
  isValidOutputAction,
  isValidProjectEditCommand,
  getProjectOutputImpact,
  validateProjectName,
} from '../electron/ipc-policy.mjs';
import { createProject } from '../src/project/model.mjs';

const editor = { mainFrame: { url: 'file:///app/renderer/harness.html' } };
const trustedEvent = {
  sender: editor,
  senderFrame: editor.mainFrame,
};

test('trusts only the editor main frame at the expected local URL', () => {
  assert.equal(isTrustedEditorSender(trustedEvent, editor, editor.mainFrame.url), true);
  assert.equal(isTrustedEditorSender({ ...trustedEvent, sender: {} }, editor, editor.mainFrame.url), false);
  assert.equal(isTrustedEditorSender({ ...trustedEvent, senderFrame: { url: editor.mainFrame.url } }, editor, editor.mainFrame.url), false);
  assert.equal(isTrustedEditorSender(trustedEvent, editor, 'https://example.com'), false);
});

test('allows only exact resume, stop, blackout, and hold events', () => {
  for (const event of [{ type: 'resume' }, { type: 'stop' }, { type: 'blackout', enabled: true }, { type: 'hold', enabled: false }]) {
    assert.equal(isValidOutputAction(event), true);
  }
  for (const event of [
    { type: 'renderer-ready', ready: true },
    { type: 'scene-revision', revision: 2 },
    { type: 'health', status: 'running' },
    { type: 'resume', armed: true },
    { type: 'blackout', enabled: 'false' },
    null,
  ]) assert.equal(isValidOutputAction(event), false);
});

test('accepts only ids from the current display list', () => {
  const displays = [{ id: 1 }, { id: 2 }];
  assert.equal(isValidDisplayId('2', displays), true);
  assert.equal(isValidDisplayId('3', displays), false);
  assert.equal(isValidDisplayId('../2', displays), false);
  assert.equal(isValidDisplayId('', displays), false);
  assert.equal(isValidDisplayId(2, displays), false);
});

test('allows only renderer-owned project commands and rejects imported file commands', () => {
  assert.equal(isValidProjectEditCommand({ type: 'reset-placement' }), true);
  assert.equal(isValidProjectEditCommand({ type: 'placement-transform', value: { x: 0, y: 0, scale: 1, rotation: 0 } }), true);
  assert.equal(isValidProjectEditCommand({ type: 'mesh', value: { name: 'head.obj', obj: 'v 0 0 0' } }), false);
  assert.equal(isValidProjectEditCommand({ type: 'reference', value: { path: '/tmp/image.png' } }), false);
  assert.equal(isValidProjectEditCommand({ type: 'output', value: { width: 0, height: 1, displayId: null } }), true);
  assert.equal(isValidProjectEditCommand({ type: 'placement-transform', value: { x: 0, y: 0, scale: 0, rotation: 0 } }), false);
});

test('validates exact alignment pair and mapping mode IPC commands', () => {
  const pairs = [
    { source: { u: 0, v: 0 }, target: { u: 0, v: 0 } },
    { source: { u: 1, v: 0 }, target: { u: 1, v: 0 } },
    { source: { u: 0, v: 1 }, target: { u: 0, v: 1 } },
  ];
  assert.equal(isValidProjectEditCommand({ type: 'alignment-pairs', value: [] }), true);
  assert.equal(isValidProjectEditCommand({ type: 'alignment-pairs', value: pairs }), true);
  assert.equal(isValidProjectEditCommand({ type: 'alignment-apply', value: pairs }), true);
  assert.equal(isValidProjectEditCommand({ type: 'mapping-mode', value: 'uv' }), true);
  assert.equal(isValidProjectEditCommand({ type: 'alignment-apply', value: pairs.slice(0, 2) }), false);
  assert.equal(isValidProjectEditCommand({ type: 'mapping-mode', value: 'side' }), false);
  assert.equal(isValidProjectEditCommand({ type: 'alignment-pairs', value: pairs, extra: 1 }), false);
  assert.equal(isValidProjectEditCommand({ type: 'alignment-pairs', value: [...pairs, { source: { u: NaN, v: 0 }, target: { u: 0, v: 0 } }] }), false);
  let reads = 0;
  const accessorPoint = { v: 0 };
  Object.defineProperty(accessorPoint, 'u', { enumerable: true, get() { reads += 1; return 0; } });
  assert.equal(isValidProjectEditCommand({ type: 'alignment-pairs', value: [{ source: accessorPoint, target: { u: 0, v: 0 } }] }), false);
  assert.equal(reads, 0);
});

test('preserves output for scene edits and resets it only for output-affecting project changes', () => {
  const before = createProject({ id: 'test-project', name: 'Head', now: '2026-09-24T12:00:00.000Z' });
  const placement = structuredClone(before);
  placement.placement.transform.x = 0.2;
  assert.equal(getProjectOutputImpact(before, placement, 'undo'), 'none');

  const reference = structuredClone(before);
  reference.reference = { path: '/tmp/reference.png' };
  assert.equal(getProjectOutputImpact(before, reference, 'import-reference'), 'disarm-source');

  const output = structuredClone(before);
  output.output.width = 1280;
  assert.equal(getProjectOutputImpact(before, output, 'undo'), 'reset-display');
  assert.equal(getProjectOutputImpact(before, placement, 'replace'), 'reset-display');
});

test('validates bounded nonempty project names', () => {
  assert.equal(validateProjectName('Head setup'), 'Head setup');
  for (const name of ['', '  ', 'x'.repeat(257), 123, null]) {
    assert.throws(() => validateProjectName(name), RangeError);
  }
});

test('validates exact physical calibration commands over IPC', () => {
  const pairs = [
    { source: { u: 0, v: 0 }, target: { u: 0, v: 0 } },
    { source: { u: 1, v: 0 }, target: { u: 1, v: 0 } },
    { source: { u: 0, v: 1 }, target: { u: 0, v: 1 } },
  ];
  assert.equal(isValidProjectEditCommand({ type: 'calibration-pairs', value: [] }), true);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-pairs', value: pairs }), true);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-apply', value: pairs }), true);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-reset' }), true);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-apply', value: pairs.slice(0, 2) }), false);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-pairs', value: pairs, extra: true }), false);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-reset', value: null }), false);
  assert.equal(isValidProjectEditCommand({ type: 'calibration-pairs', value: [{ source: { u: NaN, v: 0 }, target: { u: 0, v: 0 } }] }), false);
});
