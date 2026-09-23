import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  parseProject,
  serializeProject,
  validateProject,
} from '../src/project/model.mjs';
import {
  loadNewerRecovery,
  loadProject,
  saveProject,
  writeRecovery,
} from '../src/project/storage.mjs';

const now = '2026-09-24T12:00:00.000Z';

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mapping-project-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('creates and round-trips the complete v1 project schema', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  assert.equal(project.version, 1);
  assert.deepEqual(project.placement.grid.points[0], { u: 0, v: 0 });
  assert.deepEqual(parseProject(serializeProject(project)), project);
  assert.notEqual(parseProject(serializeProject(project)), project);
});

test('round-trips optional alignment and mapping mode while accepting legacy projects', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  assert.equal(validateProject(project).valid, true);
  project.placement.alignment = { pairs: [{ source: { u: 0.2, v: 0.3 }, target: { u: 0.4, v: 0.5 } }] };
  project.placement.mappingMode = 'uv';
  assert.deepEqual(parseProject(serializeProject(project)).placement, project.placement);
  const legacy = structuredClone(project);
  delete legacy.placement.alignment;
  delete legacy.placement.mappingMode;
  assert.deepEqual(parseProject(serializeProject(legacy)).placement, legacy.placement);
  for (const invalid of [
    { ...project.placement, alignment: { pairs: [{ source: { u: 2, v: 0 }, target: { u: 0, v: 0 } }] } },
    { ...project.placement, alignment: { pairs: [], extra: true } },
    { ...project.placement, mappingMode: 'side' },
  ]) assert.equal(validateProject({ ...project, placement: invalid }).valid, false);
});

test('alignment schema rejects accessors, sparse arrays, unknown keys, and invalid coordinates', () => {
  const make = () => createProject({ id: 'p-1', name: 'Head', now });
  const withThreePairs = make();
  withThreePairs.placement.alignment.pairs = [
    { source: { u: 0, v: 0 }, target: { u: 0, v: 0 } },
    { source: { u: 1, v: 0 }, target: { u: 1, v: 0 } },
    { source: { u: 0, v: 1 }, target: { u: 0, v: 1 } },
  ];
  let reads = 0;
  Object.defineProperty(withThreePairs.placement.alignment.pairs[0].source, 'u', { enumerable: true, get() { reads += 1; return 0; } });
  assert.equal(validateProject(withThreePairs).valid, false);
  assert.equal(reads, 0);

  const sparse = make();
  sparse.placement.alignment.pairs = new Array(1);
  assert.equal(validateProject(sparse).valid, false);
  const unknown = make();
  unknown.placement.alignment.extra = true;
  assert.equal(validateProject(unknown).valid, false);
  const outOfBounds = make();
  outOfBounds.placement.alignment.pairs = [{ source: { u: -0.1, v: 0 }, target: { u: 0, v: 0 } }];
  assert.equal(validateProject(outOfBounds).valid, false);
});

test('rejects malformed schema, unsupported versions, unknown keys, and runtime state', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  assert.equal(validateProject({ ...project, runtime: { armed: true } }).valid, false);
  assert.throws(() => serializeProject({ ...project, runtime: { armed: true } }), RangeError);
  assert.throws(() => parseProject('{'), RangeError);
  assert.throws(() => parseProject(JSON.stringify({ ...project, version: 2 })), RangeError);
});

test('validates bounded project fields, transform values, timestamps, and mask coordinates', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  const invalidProjects = [
    { ...project, id: '' },
    { ...project, name: 'x'.repeat(257) },
    { ...project, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...project, createdAt: 'yesterday' },
    { ...project, createdAt: '2026-02-31T12:00:00.000Z' },
    { ...project, placement: { ...project.placement, transform: { ...project.placement.transform, scale: 0 } } },
    { ...project, projector: { ...project.projector, fov: 180 } },
    { ...project, output: { ...project.output, width: 16385 } },
    { ...project, placement: { ...project.placement, mask: [{ excluded: true, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1.1, v: 1 }] }] } },
  ];
  for (const invalid of invalidProjects) assert.equal(validateProject(invalid).valid, false);
});

test('serialization contains only schema fields and parse returns detached nested data', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  const copy = parseProject(serializeProject(project));
  copy.placement.grid.points[0].u = 0.1;
  assert.equal(project.placement.grid.points[0].u, 0);
  assert.equal(serializeProject(project).includes('runtime'), false);
});

test('rejects hidden and symbol properties at schema object boundaries', () => {
  const hiddenRuntime = createProject({ id: 'p-1', name: 'Head', now });
  Object.defineProperty(hiddenRuntime, 'runtime', { value: { armed: true } });
  assert.equal(validateProject(hiddenRuntime).valid, false);

  const symbolRuntime = createProject({ id: 'p-1', name: 'Head', now });
  symbolRuntime[Symbol('runtime')] = { armed: true };
  assert.equal(validateProject(symbolRuntime).valid, false);

  const hiddenNestedRuntime = createProject({ id: 'p-1', name: 'Head', now });
  Object.defineProperty(hiddenNestedRuntime.output, 'runtime', { value: { armed: true } });
  assert.equal(validateProject(hiddenNestedRuntime).valid, false);
});

test('rejects accessors and sparse arrays instead of validating a different serialized snapshot', () => {
  const accessorProject = createProject({ id: 'p-1', name: 'Head', now });
  let reads = 0;
  Object.defineProperty(accessorProject.projector, 'fov', {
    get() {
      reads += 1;
      return reads > 2 ? 180 : 45;
    },
    enumerable: true,
  });
  assert.equal(validateProject(accessorProject).valid, false);
  assert.throws(() => serializeProject(accessorProject), RangeError);
  assert.equal(reads, 0);

  const accessorArray = createProject({ id: 'p-1', name: 'Head', now });
  Object.defineProperty(accessorArray.projector.position, '0', { get: () => 0, enumerable: true });
  assert.equal(validateProject(accessorArray).valid, false);

  const sparseVector = createProject({ id: 'p-1', name: 'Head', now });
  sparseVector.projector.position = new Array(3);
  assert.equal(validateProject(sparseVector).valid, false);
  assert.throws(() => serializeProject(sparseVector), RangeError);
});

test('rejects sparse masks, mask points, and grid point arrays', () => {
  const sparseMask = createProject({ id: 'p-1', name: 'Head', now });
  sparseMask.placement.mask = new Array(1);
  assert.equal(validateProject(sparseMask).valid, false);

  const sparseMaskPoints = createProject({ id: 'p-1', name: 'Head', now });
  sparseMaskPoints.placement.mask = [{ excluded: true, points: new Array(3) }];
  assert.equal(validateProject(sparseMaskPoints).valid, false);

  const sparseGrid = createProject({ id: 'p-1', name: 'Head', now });
  sparseGrid.placement.grid.points = new Array(25);
  assert.equal(validateProject(sparseGrid).valid, false);
});

test('rejects Array subclasses whose custom iterator can change serialized values', () => {
  class MisleadingVector extends Array {
    *[Symbol.iterator]() {
      yield null;
      yield null;
      yield null;
    }
  }
  const project = createProject({ id: 'p-1', name: 'Head', now });
  project.projector.position = new MisleadingVector(0, 0, 3);
  assert.equal(validateProject(project).valid, false);
  assert.throws(() => serializeProject(project), RangeError);
});

test('retains embedded OBJ text independently of the original asset path', async () => {
  await withTempDir(async (directory) => {
    const project = createProject({ id: 'p-1', name: 'Head', now });
    project.mesh = { name: 'head.obj', obj: 'v 0 0 0\nvt 0.2 0.4\nf 1/1 1/1 1/1\n' };
    const filePath = join(directory, 'head.mapping.json');
    await saveProject(filePath, project);
    assert.equal((await loadProject(filePath)).mesh.obj, project.mesh.obj);
  });
});

test('writes and returns only a newer recovery with matching project identity', async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, 'head.mapping.json');
    const project = createProject({ id: 'p-1', name: 'Head', now });
    await saveProject(filePath, project);
    const recovered = { ...project, revision: 2, updatedAt: '2026-09-24T12:01:00.000Z' };
    await writeRecovery(filePath, recovered);
    assert.deepEqual(await loadNewerRecovery(filePath, project), recovered);
    assert.equal(await loadNewerRecovery(filePath, { ...project, id: 'other' }), null);
    assert.equal(await loadNewerRecovery(filePath, { ...project, revision: 2 }), null);
    await assert.rejects(loadNewerRecovery(filePath, { ...project, unexpected: true }), RangeError);
  });
});

test('ignores missing recovery and rejects malformed recovery data', async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, 'head.mapping.json');
    const project = createProject({ id: 'p-1', name: 'Head', now });
    assert.equal(await loadNewerRecovery(filePath, project), null);
    await writeFile(`${filePath}.recovery.json`, '{bad');
    await assert.rejects(loadNewerRecovery(filePath, project), RangeError);
  });
});

test('validates before touching the destination during explicit save', async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, 'head.mapping.json');
    await writeFile(filePath, 'keep this');
    const project = createProject({ id: 'p-1', name: 'Head', now });
    await assert.rejects(saveProject(filePath, { ...project, output: { ...project.output, surprise: true } }), RangeError);
    assert.equal(await readFile(filePath, 'utf8'), 'keep this');
  });
});

test('atomic write failure leaves existing destination content intact and cleans temporary files', async () => {
  await withTempDir(async (directory) => {
    const target = join(directory, 'destination');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'untouched');
    const project = createProject({ id: 'p-1', name: 'Head', now });
    await assert.rejects(saveProject(target, project));
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'untouched');
    assert.deepEqual(await readdir(directory), ['destination']);
  });
});

test('creates and round-trips projector calibration while preserving legacy projects without it', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  assert.deepEqual(project.projector.calibration, {
    pairs: [],
    grid: { columns: 2, rows: 2, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }] },
  });
  assert.deepEqual(parseProject(serializeProject(project)), project);
  const legacy = structuredClone(project);
  delete legacy.projector.calibration;
  assert.equal(validateProject(legacy).valid, true);
  assert.deepEqual(parseProject(serializeProject(legacy)).projector, legacy.projector);
});

test('rejects invalid projector calibration pairs and grids', () => {
  const project = createProject({ id: 'p-1', name: 'Head', now });
  const invalid = [
    { pairs: [{ source: { u: 2, v: 0 }, target: { u: 0, v: 0 } }], grid: { columns: 2, rows: 2, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }] } },
    { pairs: [], grid: { columns: 2, rows: 2, points: [{ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }] } },
    { pairs: [], grid: { columns: 2, rows: 2, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }] }, extra: true },
  ];
  for (const calibration of invalid) assert.equal(validateProject({ ...project, projector: { ...project.projector, calibration } }).valid, false);
});
