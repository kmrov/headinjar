import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/project/model.mjs';
import { createProjectController } from '../electron/project-controller.mjs';

const now = '2026-09-24T12:00:00.000Z';
const makeProject = (name = 'Head') => createProject({ id: `id-${name}`, name, now });

function dependencies(overrides = {}) {
  const calls = [];
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
    ...overrides.dialog,
  };
  const storage = {
    saveProject: async (...args) => calls.push(['saveProject', ...args]),
    loadProject: async () => makeProject(),
    loadNewerRecovery: async () => null,
    writeRecovery: async (...args) => calls.push(['writeRecovery', ...args]),
    ...overrides.storage,
  };
  const controller = createProjectController({
    initialProject: makeProject(), dialog, storage,
    readFile: async () => Buffer.alloc(0), now: () => now,
    ...overrides.options,
  });
  return { controller, calls, dialog, storage };
}

test('routes edits through undo and redo and reports dirty history state', () => {
  const { controller } = dependencies();
  const first = controller.editProject({ type: 'placement-transform', value: { x: 0.2, y: 0, scale: 1, rotation: 0 } });
  assert.equal(first.project.placement.transform.x, 0.2);
  assert.equal(first.canUndo, true);
  assert.equal(first.dirty, true);
  assert.equal(first.project.revision, 1);
  const undone = controller.undo();
  assert.equal(undone.project.placement.transform.x, 0);
  assert.equal(undone.project.revision, 2);
  assert.equal(undone.canRedo, true);
  assert.equal(controller.redo().project.placement.transform.x, 0.2);
});

test('cancels a pending save dialog when the active project is replaced', async () => {
  let resolveDialog;
  let writes = 0;
  const { controller } = dependencies({
    dialog: { showSaveDialog: () => new Promise((resolve) => { resolveDialog = resolve; }) },
    storage: { saveProject: async () => { writes += 1; } },
  });
  const save = controller.saveProject();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.replaceProject(makeProject('Replacement'));
  resolveDialog({ canceled: false, filePath: '/tmp/stale.mapping.json' });
  assert.deepEqual(await save, { canceled: true });
  assert.equal(writes, 0);
  assert.equal(controller.snapshot().project.name, 'Replacement');
});

test('rejects renderer commands for imported mesh and reference', () => {
  const { controller } = dependencies();
  assert.throws(() => controller.editProject({ type: 'mesh', value: { name: 'x.obj', obj: 'v 0 0 0\nf 1 1 1' } }), RangeError);
  assert.throws(() => controller.editProject({ type: 'reference', value: { path: '/tmp/a.png' } }), RangeError);
});

test('imports a native-selected image as a validated data URL without changing placement', async () => {
  const selectedPath = '/tmp/reference.png';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const { controller } = dependencies({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }) },
    options: { readFile: async () => png },
  });
  const before = controller.snapshot().project.placement;
  const snapshot = await controller.importReference();
  assert.equal(snapshot.project.reference.path, selectedPath);
  assert.equal(snapshot.referencePreview, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(snapshot.project.placement, before);
  assert.equal(snapshot.referenceStatus, 'ready');
});

test('undo and redo restore the matching reference preview', async () => {
  const selectedPath = '/tmp/reference.png';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { controller } = dependencies({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }) },
    options: { readFile: async () => png },
  });
  await controller.importReference();
  assert.ok(controller.snapshot().referencePreview);
  controller.undo();
  assert.equal(controller.snapshot().project.reference, null);
  assert.equal(controller.snapshot().referenceStatus, 'none');
  controller.redo();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().project.reference.path, selectedPath);
  assert.ok(controller.snapshot().referencePreview?.startsWith('data:image/png;base64,'));
});

test('rejects a selected reference whose bytes do not match an image format', async () => {
  const { controller } = dependencies({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/fake.png'] }) },
    options: { readFile: async () => Buffer.from('not an image') },
  });
  await assert.rejects(controller.importReference(), /PNG, JPEG, or WebP/);
  assert.equal(controller.snapshot().project.reference, null);
});

test('imports only a basic valid OBJ and enforces the 32 MiB bound', async () => {
  const obj = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const { controller } = dependencies({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/head.obj'] }) },
    options: { readFile: async () => obj },
  });
  const snapshot = await controller.importMesh();
  assert.deepEqual(snapshot.project.mesh, { name: 'head.obj', obj: obj.toString() });

  const tooLarge = dependencies({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/huge.obj'] }) },
    options: { readFile: async () => Buffer.alloc(32 * 1024 * 1024 + 1) },
  });
  await assert.rejects(tooLarge.controller.importMesh(), /32 MiB/);
});

test('offers newer recovery before replacing the project and tolerates a missing reference', async () => {
  const saved = makeProject('Saved');
  saved.reference = { path: 'not-here.png' };
  const recovered = makeProject('Recovered');
  recovered.revision = 2;
  recovered.reference = { path: 'not-here.png' };
  let offered = false;
  const { controller } = dependencies({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/saved.mapping.json'] }),
      showMessageBox: async () => { offered = true; return { response: 0 }; },
    },
    storage: {
      loadProject: async () => saved,
      loadNewerRecovery: async () => recovered,
    },
    options: { readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
  });
  const snapshot = await controller.openProject();
  assert.equal(offered, true);
  assert.equal(snapshot.project.name, 'Recovered');
  assert.equal(snapshot.dirty, true);
  assert.equal(snapshot.referencePreview, null);
  assert.equal(snapshot.referenceStatus, 'missing');
});

test('offers a matching recovery before the first Save and saves the chosen recovery', async () => {
  const recovered = makeProject();
  recovered.revision = 2;
  const saved = [];
  let promptCount = 0;
  const { controller } = dependencies({
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/new.mapping.json' }),
      showMessageBox: async () => { promptCount += 1; return { response: 0 }; },
    },
    storage: {
      loadNewerRecovery: async () => recovered,
      saveProject: async (path, project) => saved.push(project),
    },
  });
  const result = await controller.saveProject();
  assert.equal(promptCount, 1);
  assert.equal(saved[0].revision, 2);
  assert.equal(result.dirty, false);
});

test('enables recovery only after first Save inspected the selected path', async () => {
  const savedRevisions = [];
  const { controller } = dependencies({
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/brand-new.mapping.json' }) },
    storage: {
      loadNewerRecovery: async () => null,
      saveProject: async () => {},
      writeRecovery: async (_path, project) => savedRevisions.push(project.revision),
    },
  });
  await controller.saveProject();
  controller.editProject({ type: 'placement-transform', value: { x: 0.3, y: 0, scale: 1, rotation: 0 } });
  await controller.flush();
  assert.deepEqual(savedRevisions, [1]);
});

test('Save As keeps a loaded reference anchored to its original file location', async () => {
  const loaded = makeProject();
  loaded.reference = { path: 'assets/reference.png' };
  let savedProject;
  const { controller } = dependencies({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/original/project.json'] }),
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/save/copy.json' }),
    },
    storage: {
      loadProject: async () => loaded,
      saveProject: async (_path, project) => { savedProject = project; },
    },
    options: { readFile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  });
  await controller.openProject();
  await controller.saveProject();
  assert.equal(savedProject.reference.path, '../original/assets/reference.png');
});

test('undo after Save As keeps the original absolute reference origin', async () => {
  const loaded = makeProject();
  loaded.reference = { path: 'assets/a.png' };
  const requestedPaths = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { controller } = dependencies({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/original/project.json'] }),
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/save/copy.json' }),
    },
    storage: { loadProject: async () => loaded },
    options: { readFile: async (path) => { requestedPaths.push(path); return png; } },
  });
  await controller.openProject();
  controller.editProject({ type: 'placement-transform', value: { x: 0.1, y: 0, scale: 1, rotation: 0 } });
  await controller.saveProject();
  controller.undo();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requestedPaths.every((path) => path === '/tmp/original/assets/a.png'));
  assert.equal(controller.snapshot().project.reference.path, '/tmp/original/assets/a.png');
});

test('a late reference read cannot overwrite the preview from a newer undo/redo state', async () => {
  const firstPath = '/tmp/a.png';
  const secondPath = '/tmp/b.png';
  const png = (tag) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag),
  ]);
  let selection = 0;
  let aReads = 0;
  let bReads = 0;
  let finishA;
  let finishB;
  const { controller } = dependencies({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selection++ === 0 ? firstPath : secondPath] }),
    },
    options: {
      readFile: async (path) => {
        if (path === firstPath && ++aReads === 2) return new Promise((resolve) => { finishA = resolve; });
        if (path === secondPath && ++bReads === 2) return new Promise((resolve) => { finishB = resolve; });
        return png(path === firstPath ? 'first' : 'second');
      },
    },
  });
  await controller.importReference();
  await controller.importReference();
  controller.undo();
  controller.redo();
  finishB(png('newer-b'));
  await new Promise((resolve) => setImmediate(resolve));
  finishA(png('stale-a'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().project.reference.path, secondPath);
  assert.equal(controller.snapshot().referencePreview, `data:image/png;base64,${png('newer-b').toString('base64')}`);
});

test('serializes recovery writes and stores references relative to the project file', async () => {
  const writes = [];
  const savedCopies = [];
  const loaded = makeProject();
  loaded.reference = { path: '/tmp/project/assets/reference.png' };
  let unblock;
  const firstWrite = new Promise((resolve) => { unblock = resolve; });
  const { controller } = dependencies({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/project/main.mapping.json'] }),
    },
    storage: {
      loadProject: async () => loaded,
      writeRecovery: async (filePath, project) => {
        writes.push(project.revision);
        savedCopies.push(project);
        if (project.revision === 1) await firstWrite;
      },
    },
    options: { readFile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  });
  await controller.openProject();
  controller.editProject({ type: 'placement-transform', value: { x: 0.1, y: 0, scale: 1, rotation: 0 } });
  controller.editProject({ type: 'placement-transform', value: { x: 0.2, y: 0, scale: 1, rotation: 0 } });
  unblock();
  await controller.flush();
  assert.deepEqual(writes, [1, 2]);
  assert.equal(savedCopies[0].reference.path, 'assets/reference.png');
});
