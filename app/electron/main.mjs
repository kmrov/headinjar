import { app, BrowserWindow, dialog, ipcMain, screen, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOutputState, getOutputMode, transitionOutput } from '../src/output/state.mjs';
import { createProject } from '../src/project/model.mjs';
import { createProjectController } from './project-controller.mjs';
import { getProjectOutputImpact, isTrustedEditorSender, isValidDisplayId, isValidOutputAction, isValidProjectEditCommand, validateProjectName } from './ipc-policy.mjs';

const editorUrl = new URL('../renderer/editor.html', import.meta.url).href;
let editorWindow;
let outputWindow;
let projectController;
const initialProject = createProject({ id: randomUUID(), name: 'Untitled project', now: new Date().toISOString() });
let outputState = createOutputState();
let outputDisplayId = null;
let outputBounds = null;
let calibrationMarker = null;
let lastControllerProject = initialProject;

function snapshot() {
  const project = projectController.snapshot();
  const available = Boolean(project.project.mesh && project.referencePreview);
  return {
    ...project,
    output: { ...outputState },
    mode: getOutputMode(outputState),
    source: { status: available ? 'running' : 'disconnected', connected: available, detail: available ? 'Static reference image' : 'Import a model and reference image.' },
    displayId: outputDisplayId,
    calibrationMarker,
  };
}

function publish() {
  const available = Boolean(projectController?.snapshot().project.mesh && projectController?.snapshot().referencePreview);
  outputState = transitionOutput(outputState, { type: 'source-status', status: available ? 'running' : 'disconnected' });
  outputState = transitionOutput(outputState, { type: 'source-compatible', compatible: available });
  if (editorWindow && !editorWindow.isDestroyed()) editorWindow.webContents.send('shell:snapshot', snapshot());
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.webContents.send('output:snapshot', snapshot());
}

function updateOutput(event) {
  outputState = transitionOutput(outputState, event);
  publish();
}

function trusted(event) {
  if (!editorWindow || editorWindow.isDestroyed()
    || !isTrustedEditorSender(event, editorWindow.webContents, editorUrl)) {
    throw new Error('Untrusted editor request');
  }
}

function installSecurity(window, expectedUrl) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('did-start-loading', () => {
    if (window === editorWindow) setCalibrationMarker(null);
    if (window === outputWindow) updateOutput({ type: 'renderer-ready', ready: false });
  });
  contents.on('render-process-gone', () => {
    if (window === outputWindow) updateOutput({ type: 'renderer-ready', ready: false });
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function clearOutput(confirmed = false) {
  calibrationMarker = null;
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.destroy();
  outputWindow = null;
  outputDisplayId = null;
  outputBounds = null;
  outputState = transitionOutput(outputState, { type: 'renderer-ready', ready: false });
  if (confirmed) outputState = transitionOutput(outputState, { type: 'display-confirmed', confirmed: false });
  publish();
}

function disarmForProjectChange() {
  setCalibrationMarker(null);
  outputState = transitionOutput(outputState, { type: 'source-compatible', compatible: false });
  publish();
}

function setCalibrationMarker(value) {
  if (value !== null && (!value || typeof value !== 'object' || Object.keys(value).length !== 2
      || !Number.isInteger(value.index) || value.index < 0 || value.index > 11
      || !value.point || typeof value.point !== 'object' || Object.keys(value.point).length !== 2
      || !['u', 'v'].every(axis => Number.isFinite(value.point[axis]) && value.point[axis] >= 0 && value.point[axis] <= 1))) {
    throw new RangeError('Invalid calibration marker');
  }
  calibrationMarker = value;
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.webContents.send('output:marker', calibrationMarker);
}

function registerIpc() {
  ipcMain.handle('output:get-snapshot', (event) => {
    if (!outputWindow || event.sender !== outputWindow.webContents || event.senderFrame !== outputWindow.webContents.mainFrame) throw new Error('Untrusted output request');
    return snapshot();
  });
  ipcMain.on('output:failed', (event) => {
    if (outputWindow && event.sender === outputWindow.webContents && event.senderFrame === outputWindow.webContents.mainFrame) updateOutput({ type: 'renderer-ready', ready: false });
  });
  const editorHandler = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    trusted(event);
    return handler(...args);
  });
  editorHandler('shell:get-snapshot', () => snapshot());
  editorHandler('shell:calibration-marker', value => { setCalibrationMarker(value); });
  editorHandler('shell:list-displays', () => screen.getAllDisplays().map((display) => ({
    id: String(display.id), bounds: { ...display.bounds }, scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id,
  })));
  editorHandler('shell:open-output', async (displayId) => {
    const displays = screen.getAllDisplays();
    if (!isValidDisplayId(displayId, displays)) throw new RangeError('Choose a connected display');
    const display = displays.find((item) => String(item.id) === displayId);
    const output = projectController.snapshot().project.output;
    if (output.displayId !== displayId) {
      projectController.editProject({
        type: 'output', value: { ...output, displayId },
      });
    }
    clearOutput();
    outputDisplayId = displayId;
    outputBounds = { ...display.bounds, scaleFactor: display.scaleFactor, rotation: display.rotation };
    outputState = transitionOutput(outputState, { type: 'display-confirmed', confirmed: true });
    outputWindow = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
      show: false, frame: false, backgroundColor: '#000000', autoHideMenuBar: true,
      webPreferences: { preload: fileURLToPath(new URL('./output-preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
    });
    const win = outputWindow;
    installSecurity(win, new URL('../renderer/output.html', import.meta.url).href);
    win.once('closed', () => {
      if (outputWindow !== win) return;
      outputWindow = null;
      outputDisplayId = null;
      outputBounds = null;
      outputState = transitionOutput(outputState, { type: 'renderer-ready', ready: false });
      outputState = transitionOutput(outputState, { type: 'display-confirmed', confirmed: false });
      publish();
    });
    win.webContents.on('did-finish-load', () => {
      if (outputWindow === win && !win.isDestroyed()) updateOutput({ type: 'renderer-ready', ready: true });
    });
    try {
      await win.loadFile(fileURLToPath(new URL('../renderer/output.html', import.meta.url)));
    } catch (error) {
      if (outputWindow !== win || win.isDestroyed()) return snapshot();
      throw error;
    }
    if (outputWindow !== win || win.isDestroyed()) return snapshot();
    win.setBounds(display.bounds);
    win.setFullScreen(true);
    win.show();
    publish();
    return snapshot();
  });
  editorHandler('shell:output-action', (action) => {
    if (!isValidOutputAction(action)) throw new RangeError('Unsupported output action');
    updateOutput(action);
    return snapshot();
  });
  editorHandler('shell:edit-project', (command) => {
    if (!isValidProjectEditCommand(command)) throw new RangeError('Unsupported project edit');
    if (command.type === 'output' && command.value.displayId !== null
      && !isValidDisplayId(command.value.displayId, screen.getAllDisplays())) {
      throw new RangeError('Output display must be connected');
    }
    projectController.editProject(command);
    return snapshot();
  });
  editorHandler('shell:undo', () => { projectController.undo(); return snapshot(); });
  editorHandler('shell:redo', () => { projectController.redo(); return snapshot(); });
  editorHandler('shell:import-mesh', async () => {
    const result = await projectController.importMesh();
    return result.canceled ? result : snapshot();
  });
  editorHandler('shell:import-reference', async () => {
    const result = await projectController.importReference();
    return result.canceled ? result : snapshot();
  });
  editorHandler('shell:new-project', async (name) => {
    const safeName = validateProjectName(name);
    const freshProject = createProject({ id: randomUUID(), name: safeName, now: new Date().toISOString() });
    await projectController.replaceProject(freshProject);
    return snapshot();
  });
  editorHandler('shell:save-project', async () => {
    const result = await projectController.saveProject();
    return result.canceled ? result : { ...snapshot(), canceled: false, path: result.path, revision: result.revision };
  });
  editorHandler('shell:open-project', async () => {
    const result = await projectController.openProject();
    return result.canceled ? result : { ...snapshot(), canceled: false, recovered: result.recovered, path: result.path };
  });
}

function createEditor() {
  editorWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 640, show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  });
  installSecurity(editorWindow, editorUrl);
  editorWindow.once('ready-to-show', () => editorWindow?.show());
  editorWindow.webContents.once('did-finish-load', publish);
  editorWindow.on('closed', () => { editorWindow = null; clearOutput(true); });
  editorWindow.loadURL(editorUrl);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  projectController = createProjectController({
    initialProject,
    dialog,
    getOwnerWindow: () => editorWindow,
    onChange: (next, event) => {
      const impact = getProjectOutputImpact(lastControllerProject, next.project, event.reason);
      lastControllerProject = next.project;
      if (impact === 'reset-display') clearOutput(true);
      else if (impact === 'disarm-source') disarmForProjectChange();
      else publish();
    },
  });
  registerIpc();
  createEditor();
  screen.on('display-removed', (_event, display) => {
    if (String(display.id) === outputDisplayId) clearOutput(true);
  });
  screen.on('display-metrics-changed', (event, display) => {
    if (String(display.id) !== outputDisplayId) return;
    const bounds = display.bounds;
    if (!outputBounds || ['x', 'y', 'width', 'height'].some((key) => outputBounds[key] !== bounds[key])
      || display.scaleFactor !== outputBounds.scaleFactor || display.rotation !== outputBounds.rotation) clearOutput(true);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createEditor(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
