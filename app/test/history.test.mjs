import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/project/model.mjs';
import { createHistory, editHistory, redoHistory, undoHistory } from '../src/project/history.mjs';
import { createGrid } from '../src/mapping/grid.mjs';

const time = (second = 0) => new Date(Date.parse('2026-09-24T12:00:00.000Z') + second * 1000).toISOString();
const project = () => createProject({ id: 'head-1', name: 'Head', now: time() });
const transform = (x) => ({ x, y: 0, scale: 1, rotation: 0 });
const edit = (history, command, second = 1) => editHistory(history, command, time(second));

test('creates a detached history from a valid project', () => {
  const original = project();
  const history = createHistory(original);
  assert.deepEqual(history, { project: original, past: [], future: [] });
  assert.notStrictEqual(history.project, original);
  assert.notStrictEqual(history.project.placement, original.placement);
  assert.throws(() => createHistory({ ...original, runtime: {} }), RangeError);
});

test('placement transform edit increments revision and leaves projector untouched', () => {
  const initial = createHistory(project());
  const next = edit(initial, { type: 'placement-transform', value: transform(0.2) });
  assert.equal(next.project.revision, 1);
  assert.equal(next.project.updatedAt, time(1));
  assert.deepEqual(next.project.placement.transform, transform(0.2));
  assert.deepEqual(next.project.projector, initial.project.projector);
  assert.deepEqual(initial.project.placement.transform, transform(0));
  assert.equal(next.past.length, 1);
});

test('grid point, mask, reset placement, projector, reference, and output commands apply', () => {
  let history = createHistory(project());
  history = edit(history, { type: 'grid-point', index: 6, point: { u: 0.24, v: 0.24 } });
  assert.deepEqual(history.project.placement.grid.points[6], { u: 0.24, v: 0.24 });
  const mask = [{ excluded: true, points: [{ u: 0, v: 0 }, { u: 0.2, v: 0 }, { u: 0.2, v: 0.2 }] }];
  history = edit(history, { type: 'mask', value: mask });
  assert.deepEqual(history.project.placement.mask, mask);
  history = edit(history, { type: 'placement-transform', value: transform(0.3) });
  history = edit(history, { type: 'reset-placement' });
  assert.deepEqual(history.project.placement, project().placement);

  const projector = structuredClone(history.project.projector);
  projector.position[2] = 4;
  history = edit(history, { type: 'projector', value: projector });
  assert.deepEqual(history.project.projector, projector);
  assert.deepEqual(history.project.placement, project().placement);

  history = edit(history, { type: 'reference', value: { path: 'face.png' } });
  assert.deepEqual(history.project.reference, { path: 'face.png' });
  history = edit(history, { type: 'output', value: { width: 1280, height: 720, displayId: 'display-2' } });
  assert.deepEqual(history.project.output, { width: 1280, height: 720, displayId: 'display-2' });
});

test('mesh replacement resets placement and projector defaults, while preserving reference/output/source', () => {
  let base = project();
  base.reference = { path: 'ref.png' };
  base.output = { width: 1280, height: 720, displayId: 'd2' };
  base.source = { width: 640, height: 480, orientation: 'normal', framing: 'center' };
  const history = createHistory(base);
  const changed = edit(history, { type: 'mesh', value: { name: 'head.obj', obj: 'v 0 0 0\n' } });
  assert.deepEqual(changed.project.mesh, { name: 'head.obj', obj: 'v 0 0 0\n' });
  assert.deepEqual(changed.project.placement, project().placement);
  assert.deepEqual(changed.project.projector, project().projector);
  assert.deepEqual(changed.project.reference, base.reference);
  assert.deepEqual(changed.project.output, base.output);
  assert.deepEqual(changed.project.source, base.source);
});

test('reference changes preserve image placement and projector calibration', () => {
  let history = edit(createHistory(project()), { type: 'placement-transform', value: transform(0.2) });
  history = edit(history, { type: 'projector', value: { ...history.project.projector, fov: 60 } });
  const placement = structuredClone(history.project.placement);
  const projector = structuredClone(history.project.projector);
  history = edit(history, { type: 'reference', value: { path: 'new.png' } });
  assert.deepEqual(history.project.placement, placement);
  assert.deepEqual(history.project.projector, projector);
});

test('alignment commands preserve mapping state, apply atomically, and survive undo/redo', () => {
  let base = project();
  base.placement.mask = [{ excluded: true, points: [{ u: 0, v: 0 }, { u: 0.2, v: 0 }, { u: 0.2, v: 0.2 }] }];
  base.projector.fov = 61;
  let history = createHistory(base);
  const pairs = [
    { source: { u: 0, v: 0 }, target: { u: 0, v: 0 } },
    { source: { u: 1, v: 0 }, target: { u: 1, v: 0 } },
    { source: { u: 0, v: 1 }, target: { u: 0, v: 1 } },
  ];
  history = edit(history, { type: 'alignment-pairs', value: pairs });
  assert.deepEqual(history.project.placement.alignment.pairs, pairs);
  history = edit(history, { type: 'alignment-apply', value: pairs });
  assert.deepEqual(history.project.placement.alignment.pairs, pairs);
  assert.deepEqual(history.project.placement.transform, transform(0));
  assert.deepEqual(history.project.placement.mask, base.placement.mask);
  assert.equal(history.project.projector.fov, 61);
  assert.deepEqual(history.project.placement.grid.points[6], { u: 0.375, v: 0 });
  assert.deepEqual(undoHistory(history, time(3)).project.placement.alignment.pairs, pairs);
  assert.equal(redoHistory(undoHistory(history, time(4)), time(5)).project.placement.alignment.pairs.length, 3);
  history = edit(history, { type: 'mapping-mode', value: 'uv' });
  assert.equal(history.project.placement.mappingMode, 'uv');
  assert.throws(() => edit(history, { type: 'alignment-apply', value: pairs }), /front mapping mode/i);
  history = edit(history, { type: 'reset-placement' });
  assert.deepEqual(history.project.placement.alignment, { pairs: [] });
  assert.equal(history.project.placement.mappingMode, 'front');
});

test('reference and mesh replacements clear alignment pairs', () => {
  let base = project();
  base.placement.alignment = { pairs: [{ source: { u: 0.2, v: 0.3 }, target: { u: 0.4, v: 0.5 } }] };
  const before = createHistory(base);
  const reference = edit(before, { type: 'reference', value: { path: 'new.png' } });
  assert.deepEqual(reference.project.placement.alignment, { pairs: [] });
  const mesh = edit(before, { type: 'mesh', value: { name: 'new.obj', obj: 'v 0 0 0\n' } });
  assert.deepEqual(mesh.project.placement.alignment, { pairs: [] });
});

test('undo and redo restore project content with monotonically increasing revisions', () => {
  const start = createHistory(project());
  const once = edit(start, { type: 'placement-transform', value: transform(0.2) }, 1);
  const twice = edit(once, { type: 'reference', value: { path: 'face.png' } }, 2);
  const undone = undoHistory(twice, time(3));
  assert.equal(undone.project.revision, 3);
  assert.equal(undone.project.updatedAt, time(3));
  assert.equal(undone.project.reference, null);
  assert.deepEqual(undone.project.placement.transform, transform(0.2));
  assert.equal(undone.future.length, 1);
  const redone = redoHistory(undone, time(4));
  assert.equal(redone.project.revision, 4);
  assert.equal(redone.project.updatedAt, time(4));
  assert.deepEqual(redone.project.reference, { path: 'face.png' });
});

test('undo and redo do not mutate the input snapshots', () => {
  const start = createHistory(project());
  const edited = edit(start, { type: 'placement-transform', value: transform(0.2) });
  const editedSnapshot = structuredClone(edited);
  const undone = undoHistory(edited, time(2));
  assert.deepEqual(edited, editedSnapshot);
  const undoneSnapshot = structuredClone(undone);
  const redone = redoHistory(undone, time(3));
  assert.deepEqual(undone, undoneSnapshot);
  assert.equal(redone.project.revision, 3);
});

test('new edits clear redo and unavailable undo/redo return the same history', () => {
  const start = createHistory(project());
  assert.strictEqual(undoHistory(start, time(1)), start);
  assert.strictEqual(redoHistory(start, time(1)), start);
  const first = edit(start, { type: 'placement-transform', value: transform(0.2) });
  const undone = undoHistory(first, time(2));
  const branched = edit(undone, { type: 'placement-transform', value: transform(0.5) }, 3);
  assert.deepEqual(branched.future, []);
});

test('history stacks keep only the latest 30 snapshots', () => {
  let history = createHistory(project());
  for (let index = 1; index <= 35; index += 1) {
    history = edit(history, { type: 'placement-transform', value: transform(index / 100) }, index);
  }
  assert.equal(history.project.revision, 35);
  assert.equal(history.past.length, 30);
  for (let index = 36; index <= 65; index += 1) history = undoHistory(history, time(index));
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 30);
});

test('rejects invalid commands and values without mutating the input history', () => {
  const history = createHistory(project());
  const snapshot = structuredClone(history);
  const invalid = [
    null, { type: 'unknown' }, { type: 'stop' },
    { type: 'placement-transform', value: { x: 1, y: 2, scale: 0, rotation: 0 } },
    { type: 'placement-transform', value: { x: 1, y: 2, scale: 1, rotation: 0, extra: 1 } },
    { type: 'grid-point', index: 24, point: { u: 0, v: 0 } },
    { type: 'mask', value: [{ excluded: true, points: [] }] },
    { type: 'projector', value: { fov: 181 } },
    { type: 'mesh', value: { name: 'bad.obj', obj: '', extra: true } },
    { type: 'reference', value: { path: '' } },
    { type: 'output', value: { width: 0, height: 720, displayId: null } },
    { type: 'output', value: { width: 720, height: 720, displayId: null, armed: true } },
    { type: 'placement-transform', value: transform(0.2), extra: true },
  ];
  for (const command of invalid) assert.throws(() => edit(history, command), RangeError);
  assert.deepEqual(history, snapshot);
  assert.throws(() => edit(history, { type: 'placement-transform', value: transform(0.2) }, 'yesterday'), RangeError);
});

test('rejects invalid history and revision overflow', () => {
  const initial = createHistory(project());
  assert.throws(() => createHistory({ ...initial.project, revision: -1 }), RangeError);
  assert.throws(() => undoHistory({ ...initial, past: [null] }, time(1)), RangeError);
  const maxed = createProject({ id: 'max', name: 'Max', now: time() });
  maxed.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => editHistory(createHistory(maxed), { type: 'reset-placement' }, time(1)), RangeError);
});

test('calibration pairs, apply, reset, undo, and redo use independent projector state', () => {
  let history = createHistory(project());
  const pairs = [
    { source: { u: 0.1, v: 0.1 }, target: { u: 0.1, v: 0.1 } },
    { source: { u: 0.9, v: 0.1 }, target: { u: 0.9, v: 0.1 } },
    { source: { u: 0.1, v: 0.9 }, target: { u: 0.1, v: 0.9 } },
  ];
  history = edit(history, { type: 'calibration-pairs', value: pairs });
  assert.deepEqual(history.project.projector.calibration.pairs, pairs);
  history = edit(history, { type: 'calibration-apply', value: pairs });
  assert.deepEqual(history.project.projector.calibration.pairs, pairs);
  assert.equal(history.project.projector.calibration.grid.columns, 33);
  assert.equal(history.project.projector.calibration.grid.rows, 33);
  const applied = structuredClone(history.project.projector.calibration);
  history = edit(history, { type: 'calibration-reset' });
  assert.equal(history.project.projector.calibration.pairs.length, 0);
  assert.deepEqual(history.project.projector.calibration.grid.points[3], { u: 1, v: 1 });
  assert.deepEqual(undoHistory(history, time(5)).project.projector.calibration, applied);
  assert.deepEqual(redoHistory(undoHistory(history, time(6)), time(7)).project.projector.calibration.grid, history.project.projector.calibration.grid);
});

test('calibration reset upgrades a legacy projector without changing old-file parsing', () => {
  const legacy = project();
  delete legacy.projector.calibration;
  const history = edit(createHistory(legacy), { type: 'calibration-reset' });
  assert.deepEqual(history.project.projector.calibration, {
    pairs: [],
    grid: { columns: 2, rows: 2, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }] },
  });
});

test('recreating projector points from Align replaces old pairs and warp in one undo step', () => {
  const oldPairs = [
    { source: { u: 0.1, v: 0.1 }, target: { u: 0.15, v: 0.1 } },
    { source: { u: 0.8, v: 0.1 }, target: { u: 0.85, v: 0.1 } },
    { source: { u: 0.1, v: 0.8 }, target: { u: 0.15, v: 0.8 } },
  ];
  const newPairs = [
    { source: { u: 0.25, v: 0.3 }, target: { u: 0.25, v: 0.3 } },
    { source: { u: 0.7, v: 0.3 }, target: { u: 0.7, v: 0.3 } },
  ];
  const before = edit(createHistory(project()), { type: 'calibration-apply', value: oldPairs });
  const after = edit(before, { type: 'calibration-reseed', value: newPairs });
  assert.deepEqual(after.project.projector.calibration.pairs, newPairs);
  assert.deepEqual(after.project.projector.calibration.grid, createGrid(2, 2));
  assert.deepEqual(undoHistory(after, time(3)).project.projector.calibration, before.project.projector.calibration);
  assert.throws(() => edit(before, { type: 'calibration-reseed', value: [{ source: { u: -1, v: 0 }, target: { u: 0, v: 0 } }] }), RangeError);
});

test('invalid calibration edits reject atomically and geometry changes reset calibration', () => {
  const pairs = [
    { source: { u: 0.1, v: 0.1 }, target: { u: 0.1, v: 0.1 } },
    { source: { u: 0.9, v: 0.1 }, target: { u: 0.9, v: 0.1 } },
    { source: { u: 0.1, v: 0.9 }, target: { u: 0.1, v: 0.9 } },
  ];
  let history = edit(createHistory(project()), { type: 'calibration-apply', value: pairs });
  const snapshot = structuredClone(history);
  for (const command of [
    { type: 'calibration-apply', value: pairs.slice(0, 2) },
    { type: 'calibration-apply', value: pairs.map((pair) => ({ ...pair, target: { u: 0.2, v: 0.2 } })) },
    { type: 'calibration-pairs', value: [{ source: { u: -1, v: 0 }, target: { u: 0, v: 0 } }] },
  ]) assert.throws(() => edit(history, command), RangeError);
  assert.deepEqual(history, snapshot);

  const projectorEdits = [
    { ...history.project.projector, position: [0, 0, 4] },
    { ...history.project.projector, rotation: [0.1, 0, 0] },
    { ...history.project.projector, fov: 60 },
    { ...history.project.projector, offset: [0.1, 0] },
    { ...history.project.projector, model: { ...history.project.projector.model, position: [0.1, 0, 0] } },
  ];
  for (const value of projectorEdits) {
    assert.deepEqual(edit(history, { type: 'projector', value }).project.projector.calibration, project().projector.calibration);
  }
  const attemptedCalibrationBypass = edit(history, { type: 'projector', value: { ...history.project.projector, calibration: project().projector.calibration } });
  assert.deepEqual(attemptedCalibrationBypass.project.projector.calibration, history.project.projector.calibration);
  const output = edit(history, { type: 'output', value: { width: 1280, height: 720, displayId: 'd2' } });
  assert.deepEqual(output.project.projector.calibration, project().projector.calibration);
  const display = edit(history, { type: 'output', value: { ...history.project.output, displayId: 'd3' } });
  assert.deepEqual(display.project.projector.calibration, history.project.projector.calibration);
  const reference = edit(history, { type: 'reference', value: { path: 'face.png' } });
  assert.deepEqual(reference.project.projector.calibration, history.project.projector.calibration);
  const mesh = edit(history, { type: 'mesh', value: { name: 'new.obj', obj: 'v 0 0 0\n' } });
  assert.deepEqual(mesh.project.projector.calibration, project().projector.calibration);
});
