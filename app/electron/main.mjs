import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session } from 'electron';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOutputState, getOutputMode, transitionOutput } from '../src/output/state.mjs';
import { createProject } from '../src/project/model.mjs';
import { createProjectController } from './project-controller.mjs';
import { getProjectOutputImpact, isTrustedEditorSender, isValidDisplayId, isValidOutputAction, isValidProjectEditCommand, validateProjectName } from './ipc-policy.mjs';
import { createWebRTCSessionController } from './webrtc-session.mjs';
import { createSignalingOfferGate } from './signaling-integration.mjs';
import { startSignalingServer } from './signaling-server.mjs';

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
let webRTCSession;
let signalingGate;
let signalingServer;
let signalingStarting = null;
let signalingClosing = null;

const outputUrl = new URL('../renderer/output.html', import.meta.url).href;

function sourceSnapshot() {
  const sessionSource = webRTCSession?.snapshot();
  if (sessionSource?.kind === 'webrtc') return sessionSource;
  const project = projectController.snapshot();
  const available = Boolean(project.project.mesh && project.referencePreview);
  return {
    kind: 'reference', status: available ? 'running' : 'disconnected', connected: available,
    detail: available ? 'Static reference image' : 'Import a model and reference image.', sessionId: null, width: 0, height: 0,
  };
}

function signalingSnapshot() {
  return signalingServer
    ? { running: true, url: signalingServer.connectionUrl, origin: signalingServer.origin, whipUrl: signalingServer.whipUrl || null }
    : { running: false, url: null, origin: null, whipUrl: null };
}

function signalingTlsOptions() {
  const certPath = process.env.HEADINJAR_TLS_CERT;
  const keyPath = process.env.HEADINJAR_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error('HTTPS requires both HEADINJAR_TLS_CERT and HEADINJAR_TLS_KEY to be set.');
  }
  if (!certPath) return undefined;
  try {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (error) {
    throw new Error(`Could not read the HTTPS certificate or key configured by HEADINJAR_TLS_CERT and HEADINJAR_TLS_KEY: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snapshot({ includeSignaling = true } = {}) {
  const project = projectController.snapshot();
  return {
    ...project,
    output: { ...outputState },
    mode: getOutputMode(outputState),
    source: sourceSnapshot(),
    displayId: outputDisplayId,
    calibrationMarker,
    ...(includeSignaling ? { signaling: signalingSnapshot() } : {}),
  };
}

async function stopSignaling() {
  if (signalingClosing) return signalingClosing;
  if (signalingStarting) {
    try { await signalingStarting; } catch { /* A failed listen has nothing to stop. */ }
  }
  if (signalingClosing) return signalingClosing;
  const server = signalingServer;
  if (!server) return signalingSnapshot();
  signalingServer = null;
  signalingClosing = Promise.resolve(server.close()).then(() => {
    publish();
    return signalingSnapshot();
  }).finally(() => { signalingClosing = null; });
  return signalingClosing;
}

function startSignaling() {
  if (signalingStarting) return signalingStarting;
  const starting = startSignalingInner();
  signalingStarting = starting;
  void starting.then(
    () => { if (signalingStarting === starting) signalingStarting = null; },
    () => { if (signalingStarting === starting) signalingStarting = null; },
  );
  return starting;
}

async function startSignalingInner() {
  if (signalingClosing) await signalingClosing;
  if (signalingServer) return signalingSnapshot();
  if (webRTCSession.snapshot().kind !== 'webrtc') throw new Error('Select WebRTC as the source first.');
  const assets = new Map([
    ['/sender', { body: readFileSync(new URL('../examples/webrtc-sender.html', import.meta.url)), contentType: 'text/html; charset=utf-8' }],
    ['/webrtc-sender.mjs', { body: readFileSync(new URL('../examples/webrtc-sender.mjs', import.meta.url)), contentType: 'text/javascript; charset=utf-8' }],
  ]);
  const tls = signalingTlsOptions();
  return startSignalingServer({
    host: '127.0.0.1', port: 19840, assets,
    ...(tls ? { tls } : {}),
    isBusy: () => signalingGate.isBusy(),
    acceptOffer: (offer, options) => signalingGate.acceptOffer(offer, options),
    disconnect: () => { webRTCSession.reset('Signaling session disconnected.'); },
  }).then(server => {
    signalingServer = server;
    publish();
    return signalingSnapshot();
  });
}

function publish() {
  if (!projectController) return;
  const source = sourceSnapshot();
  const hasMesh = Boolean(projectController.snapshot().project.mesh);
  const compatible = source.kind === 'reference'
    ? Boolean(hasMesh && projectController.snapshot().referencePreview)
    : Boolean(hasMesh && outputWindow && !outputWindow.isDestroyed());
  outputState = transitionOutput(outputState, { type: 'source-status', status: source.status });
  outputState = transitionOutput(outputState, { type: 'source-compatible', compatible });
  if (editorWindow && !editorWindow.isDestroyed()) editorWindow.webContents.send('shell:snapshot', snapshot());
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.webContents.send('output:snapshot', snapshot({ includeSignaling: false }));
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
    if (window === editorWindow) {
      setCalibrationMarker(null);
      void stopSignaling();
      webRTCSession?.reset('Editor reloaded. Reconnect the source.');
    }
    if (window === outputWindow) {
      void stopSignaling();
      webRTCSession?.outputClosed();
      updateOutput({ type: 'renderer-ready', ready: false });
    }
  });
  contents.on('render-process-gone', () => {
    if (window === outputWindow) {
      void stopSignaling();
      webRTCSession?.outputClosed();
      updateOutput({ type: 'renderer-ready', ready: false });
    }
    if (window === editorWindow) {
      void stopSignaling();
      webRTCSession?.reset('Editor process stopped. Reconnect the source.');
    }
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function clearOutput(confirmed = false) {
  void stopSignaling();
  calibrationMarker = null;
  webRTCSession?.outputClosed();
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
    return snapshot({ includeSignaling: false });
  });
  ipcMain.on('output:failed', (event) => {
    if (outputWindow && event.sender === outputWindow.webContents && event.senderFrame === outputWindow.webContents.mainFrame) updateOutput({ type: 'renderer-ready', ready: false });
  });
  const trustedOutput = event => Boolean(outputWindow && !outputWindow.isDestroyed()
    && event.sender === outputWindow.webContents
    && event.senderFrame === outputWindow.webContents.mainFrame
    && event.senderFrame?.url === outputUrl);
  ipcMain.on('output:webrtc-answer', (event, payload) => {
    if (!trustedOutput(event)) return;
    try { webRTCSession.receiveAnswer(payload); }
    catch (error) { console.warn('Ignored invalid WebRTC answer:', error instanceof Error ? error.message : error); }
  });
  ipcMain.on('output:webrtc-status', (event, payload) => {
    if (!trustedOutput(event)) return;
    try { webRTCSession.receiveStatus(payload); }
    catch (error) { console.warn('Ignored invalid WebRTC status:', error instanceof Error ? error.message : error); }
  });
  const editorHandler = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    trusted(event);
    return handler(...args);
  });
  editorHandler('shell:get-snapshot', () => snapshot());
  editorHandler('shell:select-source', kind => {
    if (kind !== 'reference' && kind !== 'webrtc') throw new RangeError('Unsupported source kind');
    return Promise.resolve(kind === 'reference' ? stopSignaling() : null).then(() => {
      outputState = transitionOutput(outputState, { type: 'source-compatible', compatible: false });
      webRTCSession.selectSource(kind);
      publish();
      return snapshot();
    });
  });
  editorHandler('shell:webrtc-offer', offer => {
    return signalingGate.acceptOffer(offer);
  });
  editorHandler('shell:signaling-start', () => startSignaling());
  editorHandler('shell:signaling-stop', () => stopSignaling());
  editorHandler('shell:signaling-copy-url', () => {
    if (!signalingServer || !/^https?:\/\/127\.0\.0\.1:19840\/sender#token=[a-f0-9]{64}$/.test(signalingServer.connectionUrl)) {
      throw new Error('The signaling connection link is no longer available.');
    }
    clipboard.writeText(signalingServer.connectionUrl);
    return true;
  });
  editorHandler('shell:whip-copy-url', () => {
    if (!signalingServer || typeof signalingServer.whipUrl !== 'string') throw new Error('The WHIP endpoint is no longer available.');
    const endpoint = new URL(signalingServer.whipUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.origin !== signalingServer.origin || endpoint.pathname !== '/whip' || endpoint.search || endpoint.hash) {
      throw new Error('The WHIP endpoint is no longer available.');
    }
    clipboard.writeText(endpoint.href);
    return true;
  });
  editorHandler('shell:whip-copy-token', () => {
    if (!signalingServer || !/^[a-f0-9]{64}$/.test(signalingServer.token)) throw new Error('The WHIP bearer token is no longer available.');
    clipboard.writeText(signalingServer.token);
    return true;
  });
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
      webPreferences: { preload: fileURLToPath(new URL('./output-preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    const win = outputWindow;
    installSecurity(win, new URL('../renderer/output.html', import.meta.url).href);
    win.once('closed', () => {
      if (outputWindow !== win) return;
      void stopSignaling();
      webRTCSession?.outputClosed();
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
  editorWindow.on('closed', () => { editorWindow = null; void stopSignaling(); clearOutput(true); });
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
  webRTCSession = createWebRTCSessionController({
    sendOffer: payload => {
      if (!outputWindow || outputWindow.isDestroyed() || !outputState.rendererReady) throw new Error('Output window is not ready.');
      outputWindow.webContents.send('output:webrtc-offer', payload);
    },
    sendReset: payload => {
      if (outputWindow && !outputWindow.isDestroyed()) outputWindow.webContents.send('output:webrtc-reset', payload);
    },
    onStatus: publish,
    onDimensionsChanged: () => {
      outputState = transitionOutput(outputState, { type: 'source-compatible', compatible: false });
    },
  });
  signalingGate = createSignalingOfferGate({
    session: webRTCSession,
    isReady: () => Boolean(webRTCSession.snapshot().kind === 'webrtc'
      && projectController.snapshot().project.mesh
      && outputWindow && !outputWindow.isDestroyed()
      && outputDisplayId && outputState.rendererReady),
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
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || (!signalingServer && !signalingStarting)) return;
  event.preventDefault();
  quitting = true;
  void stopSignaling().finally(() => app.quit());
});
