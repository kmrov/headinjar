import { readFile as defaultReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHistory, editHistory, redoHistory, undoHistory } from '../src/project/history.mjs';
import { saveProject as defaultSave, loadProject as defaultLoad, loadNewerRecovery as defaultRecovery, writeRecovery as defaultWriteRecovery } from '../src/project/storage.mjs';
import { isValidProjectEditCommand } from './ipc-policy.mjs';

const MAX_OBJ_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

export function createProjectController({
  initialProject,
  initialPath = null,
  dialog,
  getOwnerWindow = () => undefined,
  readFile = defaultReadFile,
  storage = {},
  now = () => new Date().toISOString(),
  onChange = () => {},
}) {
  if (!dialog || typeof dialog.showOpenDialog !== 'function' || typeof dialog.showSaveDialog !== 'function') {
    throw new TypeError('Native dialogs are required');
  }
  const io = {
    saveProject: storage.saveProject ?? defaultSave,
    loadProject: storage.loadProject ?? defaultLoad,
    loadNewerRecovery: storage.loadNewerRecovery ?? defaultRecovery,
    writeRecovery: storage.writeRecovery ?? defaultWriteRecovery,
  };
  let history = createHistory(withResolvedReference(initialProject, initialPath));
  let projectPath = initialPath;
  let savedRevision = initialPath ? initialProject.revision : null;
  let recoveryEligiblePath = null;
  let referenceFilePath = history.project.reference?.path ?? null;
  let referencePreview = null;
  let referenceStatus = initialProject.reference ? 'loading' : 'none';
  let backgroundError = null;
  let generation = 0;
  let openRequest = 0;
  let saveRequest = 0;
  let referenceRequest = 0;
  let writeTail = Promise.resolve();

  const currentProject = () => history.project;
  const snapshot = () => ({
    project: structuredClone(currentProject()),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty: savedRevision === null || currentProject().revision !== savedRevision,
    referencePreview,
    referenceStatus,
    error: backgroundError,
  });
  const notify = (reason, detail) => onChange(snapshot(), { reason, ...detail });
  const enqueueWrite = (operation) => {
    const task = writeTail.then(operation);
    writeTail = task.catch((error) => {
      backgroundError = error instanceof Error ? error.message : String(error);
      notify('error');
    });
    return task;
  };
  const queueRecovery = () => {
    if (!projectPath || recoveryEligiblePath !== projectPath) return;
    const filePath = projectPath;
    const detached = structuredClone(currentProject());
    const savedReferencePath = referenceFilePath;
    enqueueWrite(() => io.writeRecovery(filePath, serializeForPath(detached, filePath, savedReferencePath))).catch(() => {});
  };
  const commit = (nextHistory, reason, detail = {}) => {
    history = nextHistory;
    backgroundError = null;
    notify(reason, detail);
    if (reason === 'undo' || reason === 'redo') syncReference();
    queueRecovery();
    return snapshot();
  };
  const syncReference = () => {
    const storedPath = currentProject().reference?.path ?? null;
    const nextPath = storedPath ? resolveReference(storedPath, projectPath) : null;
    if (nextPath === referenceFilePath) return;
    const token = generation;
    referenceStatus = nextPath ? 'loading' : 'none';
    referencePreview = null;
    referenceFilePath = nextPath;
    notify('reference-loading');
    loadReference(nextPath, token).then(() => {
      if (token === generation) notify('reference-loaded');
    });
  };
  const loadReference = async (path, token) => {
    const request = ++referenceRequest;
    const isCurrent = () => token === generation && request === referenceRequest && path === referenceFilePath;
    if (!path) {
      referenceFilePath = null;
      referencePreview = null;
      referenceStatus = 'none';
      return;
    }
    referenceFilePath = path;
    referencePreview = null;
    referenceStatus = 'loading';
    try {
      const bytes = await readFile(path);
      if (!isCurrent()) return;
      const detected = detectImage(bytes);
      if (!detected) throw new RangeError('Reference must be a PNG, JPEG, or WebP image');
      if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new RangeError('Reference image must be at most 16 MiB');
      referencePreview = `data:${detected};base64,${bytes.toString('base64')}`;
      referenceStatus = 'ready';
    } catch (error) {
      if (!isCurrent()) return;
      referenceStatus = error?.code === 'ENOENT' ? 'missing' : 'error';
      backgroundError = error instanceof Error ? error.message : String(error);
    }
  };

  if (initialProject.reference) {
    const token = generation;
    loadReference(referenceFilePath, token).then(() => notify('reference-loaded'));
  }

  function editProject(command) {
    if (!isValidProjectEditCommand(command)) throw new RangeError('Unsupported project command');
    return commit(editHistory(history, command, now()), 'edit', { command: structuredClone(command) });
  }

  function undo() {
    const next = undoHistory(history, now());
    return next === history ? snapshot() : commit(next, 'undo');
  }

  function redo() {
    const next = redoHistory(history, now());
    return next === history ? snapshot() : commit(next, 'redo');
  }

  async function replaceProject(project, path = null, { baselineRevision = null, recoveryOffered = false } = {}) {
    const token = ++generation;
    history = createHistory(withResolvedReference(project, path));
    projectPath = path;
    savedRevision = path ? baselineRevision ?? project.revision : null;
    recoveryEligiblePath = recoveryOffered ? path : null;
    backgroundError = null;
    referencePreview = null;
    referenceStatus = project.reference ? 'loading' : 'none';
    referenceFilePath = history.project.reference?.path ?? null;
    notify('replace');
    await loadReference(referenceFilePath, token);
    if (token === generation) notify('reference-loaded');
    return snapshot();
  }

  async function openProject() {
    const token = generation;
    const request = ++openRequest;
    const selected = await dialog.showOpenDialog(getOwnerWindow(), {
      title: 'Open project', properties: ['openFile'],
      filters: [{ name: 'Mapping project', extensions: ['json'] }],
    });
    if (request !== openRequest || token !== generation || selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    const selectedPath = selected.filePaths[0];
    const loaded = await io.loadProject(selectedPath);
    const recovery = await io.loadNewerRecovery(selectedPath, loaded);
    let chosen = loaded;
    if (recovery) {
      const choice = await dialog.showMessageBox(getOwnerWindow(), {
        type: 'question', title: 'Recover project?',
        message: 'A newer recovery copy is available. Load it before continuing?',
        buttons: ['Recover', 'Use saved project'], defaultId: 0, cancelId: 1,
      });
      if (request !== openRequest || token !== generation) return { canceled: true };
      if (choice.response === 0) chosen = recovery;
    }
    if (request !== openRequest || token !== generation) return { canceled: true };
    await replaceProject(chosen, selectedPath, {
      baselineRevision: loaded.revision, recoveryOffered: true,
    });
    return { canceled: false, recovered: chosen === recovery, path: selectedPath, ...snapshot() };
  }

  async function saveProject() {
    const token = generation;
    const request = ++saveRequest;
    const selected = await dialog.showSaveDialog(getOwnerWindow(), {
      title: 'Save project', defaultPath: `${currentProject().name}.mapping.json`,
      filters: [{ name: 'Mapping project', extensions: ['json'] }],
    });
    if (request !== saveRequest || token !== generation || selected.canceled || !selected.filePath) return { canceled: true };
    const path = selected.filePath;
    if (recoveryEligiblePath !== path) {
      const offeredRevision = currentProject().revision;
      const recovery = await io.loadNewerRecovery(path, currentProject());
      if (request !== saveRequest || token !== generation) return { canceled: true };
      if (recovery) {
        const choice = await dialog.showMessageBox(getOwnerWindow(), {
          type: 'question', title: 'Recover project?',
          message: 'A newer recovery copy for this project exists at the selected path. Load it before saving?',
          buttons: ['Recover', 'Keep current project'], defaultId: 0, cancelId: 1,
        });
        if (request !== saveRequest || token !== generation || currentProject().revision !== offeredRevision) {
          return { canceled: true };
        }
        if (choice.response === 0) {
          history = createHistory(withResolvedReference(recovery, path));
          savedRevision = offeredRevision;
          referenceFilePath = history.project.reference?.path ?? null;
          referencePreview = null;
          referenceStatus = referenceFilePath ? 'loading' : 'none';
          notify('replace');
          const referenceToken = generation;
          loadReference(referenceFilePath, referenceToken).then(() => {
            if (referenceToken === generation) notify('reference-loaded');
          });
        }
      }
    }
    const captured = structuredClone(currentProject());
    const capturedReferencePath = referenceFilePath;
    await enqueueWrite(() => io.saveProject(path, serializeForPath(captured, path, capturedReferencePath)));
    if (request === saveRequest && token === generation) {
      projectPath = path;
      savedRevision = captured.revision;
      recoveryEligiblePath = path;
      notify('saved');
      if (snapshot().dirty) queueRecovery();
    }
    return { canceled: false, path, revision: captured.revision, ...snapshot() };
  }

  async function importMesh() {
    const token = generation;
    const selected = await dialog.showOpenDialog(getOwnerWindow(), {
      title: 'Import head mesh', properties: ['openFile'],
      filters: [{ name: 'Wavefront OBJ', extensions: ['obj'] }],
    });
    if (token !== generation || selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    const path = selected.filePaths[0];
    const bytes = await readFile(path);
    if (token !== generation) return { canceled: true };
    if (bytes.byteLength > MAX_OBJ_BYTES) throw new RangeError('OBJ file must be at most 32 MiB');
    let obj;
    try { obj = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new RangeError('OBJ file must be valid UTF-8 text'); }
    if (!/^\s*v\s+[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+(?:\s|$)/m.test(obj)
      || !/^\s*f\s+\S+\s+\S+\s+\S+(?:\s|$)/m.test(obj)) {
      throw new RangeError('OBJ must contain vertex and face records');
    }
    const snapshotValue = commit(editHistory(history, {
      type: 'mesh', value: { name: basename(path), obj },
    }, now()), 'import-mesh');
    return { canceled: false, ...snapshotValue };
  }

  async function importReference() {
    const token = generation;
    const selected = await dialog.showOpenDialog(getOwnerWindow(), {
      title: 'Choose reference image', properties: ['openFile'],
      filters: [{ name: 'Reference image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (token !== generation || selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    const path = selected.filePaths[0];
    const bytes = await readFile(path);
    if (token !== generation) return { canceled: true };
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new RangeError('Reference image must be at most 16 MiB');
    const mime = detectImage(bytes);
    if (!mime) throw new RangeError('Reference must be a PNG, JPEG, or WebP image');
    history = editHistory(history, { type: 'reference', value: { path } }, now());
    referenceFilePath = path;
    referencePreview = `data:${mime};base64,${bytes.toString('base64')}`;
    referenceStatus = 'ready';
    backgroundError = null;
    notify('import-reference');
    queueRecovery();
    return { canceled: false, ...snapshot() };
  }

  return {
    snapshot,
    editProject,
    undo,
    redo,
    replaceProject,
    openProject,
    saveProject,
    importMesh,
    importReference,
    flush: () => writeTail,
  };
}

function detectImage(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function resolveReference(referencePath, projectFilePath) {
  return isAbsolute(referencePath) ? resolve(referencePath)
    : resolve(projectFilePath ? dirname(projectFilePath) : process.cwd(), referencePath);
}

function withResolvedReference(project, projectFilePath) {
  const copy = structuredClone(project);
  if (copy.reference?.path) copy.reference.path = resolveReference(copy.reference.path, projectFilePath);
  return copy;
}

function serializeForPath(project, projectFilePath, runtimeReferencePath = null) {
  if (!project.reference || !project.reference.path) return project;
  const copy = structuredClone(project);
  const absoluteReference = runtimeReferencePath ? resolve(runtimeReferencePath) : isAbsolute(copy.reference.path)
    ? resolve(copy.reference.path) : resolve(projectFilePath ? dirname(projectFilePath) : process.cwd(), copy.reference.path);
  const relativeReference = relative(dirname(projectFilePath), absoluteReference);
  copy.reference.path = relativeReference && !relativeReference.startsWith(`..${sep}`) && relativeReference !== '..'
    ? relativeReference : relativeReference || '.';
  return copy;
}
