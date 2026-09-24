import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@phosphor-icons/web/regular';
import './editor.css';
import { createViewport } from './viewport.mjs';
import { createAlignmentPanel } from './alignment-panel.mjs';
import { createPhysicalCalibration } from './physical-calibration.mjs';
import { createWebRTCPanel } from './webrtc-panel.mjs';
import { createEditorWebRTCSource } from './editor-webrtc-source.mjs';
import { createWebRTCReceiver } from './webrtc-receiver.mjs';
import { createFramePublisher } from './media-frame-channel.mjs';

const desktop = window.desktop;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ui = {
  name: $('#project-name'), saveState: $('#save-state'), feedback: $('#feedback'), error: $('#error-region'),
  modelName: $('#model-name'), modelState: $('#model-state'), modelCaption: $('#model-caption'),
  referenceName: $('#reference-name'), referenceState: $('#reference-state'), referenceThumb: $('#reference-thumb'),
  referenceEmpty: $('#reference-empty'), referenceEmptyLabel: $('#reference-empty-label'), referenceAction: $('#reference-action-label'), referenceWarning: $('#reference-warning'),
  sourceStatus: $('#source-status'), sourceDetail: $('#source-detail'), sourceHealth: $('#source-health'),
  footerDot: $('#footer-health-dot'), footerSource: $('#footer-source-label'), footerSourceDetail: $('#footer-source-detail'),
  outputStatus: $('#output-status'), outputDetail: $('#output-detail'), outputSwatch: $('#output-swatch'),
  resolution: $('#resolution-status'), canvasTitle: $('#canvas-title'), canvasBadge: $('#canvas-badge'),
  modelPreview: $('.model-preview'), loadedModelMark: $('#loaded-model-mark'),
  placementPanel: $('#placement-panel'), gridPanel: $('#grid-panel'), maskPanel: $('#mask-panel'), projectorPanel: $('#projector-panel'),
  alignmentPanel: $('#alignment-panel'), alignmentSource: $('#alignment-source-panel'), mappingMode: $('#mapping-mode'), alignmentModeNote: $('#alignment-mode-note'),
  placementX: $('#placement-x'), placementY: $('#placement-y'), placementScale: $('#placement-scale'), placementRotation: $('#placement-rotation'),
  gridSelection: $('#grid-selection'), maskCount: $('#mask-count'), maskNote: $('#mask-note'), maskMode: $('#mask-mode'), clearMask: $('#clear-mask'),
  displaySummary: $('#display-summary'), ctaHint: $('#cta-hint'), review: $('#review-projector'),
  blackout: $('#blackout'), hold: $('#hold-output'), resume: $('#resume-output'), stop: $('#stop-output'),
  displayDialog: $('#display-dialog'), displayList: $('#display-list'), confirmDisplay: $('#confirm-display'),
  viewport: $('#viewport'),
  webrtcPreviewCanvas: $('#webrtc-preview-canvas'), webrtcPreviewEmpty: $('#webrtc-preview-empty'),
  webrtcPreviewFreeze: $('#webrtc-preview-freeze'), webrtcPreviewStatus: $('#webrtc-preview-status'),
  webrtcVideo: $('#webrtc-video'),
};

let snapshot = null;
let activeMode = 'placement';
let activeTool = 'move';
let maskMode = 'keep';
let selectedPoint = null;
let selectedAlignment = null;
let pendingAlignmentSource = null;
let alignmentPanel;
let physicalCalibration;
let webrtcPanel;
let editorWebRTCSource;
let displays = [];
let selectedDisplayId = null;
let showGrid = true;
let wireframe = false;
let hasProjectFile = false;
let savedRevision = -1;
let feedbackTimer;
let lastSnapshotError = null;

alignmentPanel = createAlignmentPanel(ui.alignmentSource, ui.alignmentPanel, {
  onSourcePoint: (point) => {
    if (activeMode !== 'placement' || activeTool !== 'align') return;
    if (snapshot?.project?.placement?.mappingMode === 'uv') {
      showFeedback('Switch to Front mapping to place landmarks.');
      return;
    }
    if (alignmentPairs().length >= 12) {
      showFeedback('Alignment supports up to 12 landmark pairs.');
      return;
    }
    pendingAlignmentSource = point;
    alignmentPanel.render({ snapshot, pairs: alignmentPairs(), selected: selectedAlignment, pending: true, pendingSource: pendingAlignmentSource, mode: 'front' });
  },
  onSelect: (index) => {
    selectedAlignment = index;
    viewportApi?.setAlignmentSelection(index);
    renderAlignment();
  },
  onRemove: () => {
    if (selectedAlignment === null) return;
    const pairs = alignmentPairs().filter((_, index) => index !== selectedAlignment);
    selectedAlignment = pairs.length ? Math.min(selectedAlignment, pairs.length - 1) : null;
    pendingAlignmentSource = null;
    safely(() => commitAlignmentPairs(pairs));
  },
  onClear: () => {
    selectedAlignment = null;
    pendingAlignmentSource = null;
    viewportApi?.clearAlignmentPreview();
    safely(() => commitAlignmentPairs([]));
  },
});

const number = (value, label) => {
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed)) throw new RangeError(`${label} must be a finite number.`);
  return parsed;
};

function showFeedback(message, { error = false, persistent = false } = {}) {
  clearTimeout(feedbackTimer);
  ui.feedback.textContent = message;
  ui.feedback.classList.toggle('is-error', error);
  ui.feedback.classList.add('is-visible');
  ui.error.textContent = error ? message : '';
  if (!persistent) feedbackTimer = setTimeout(() => ui.feedback.classList.remove('is-visible'), 3200);
}

function clearFeedback() {
  ui.feedback.classList.remove('is-visible', 'is-error');
  ui.feedback.textContent = '';
  ui.error.textContent = '';
}

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error || 'The request failed.');
  showFeedback(message, { error: true, persistent: true });
}

function hasMethod(name) {
  return typeof desktop?.[name] === 'function';
}

async function callDesktop(method, ...args) {
  if (!hasMethod(method)) throw new Error(`“${method}” is not available in this desktop build yet.`);
  const result = await desktop[method](...args);
  if (result?.project) renderSnapshot(result);
  return result;
}

async function safely(action, successMessage) {
  clearFeedback();
  try {
    const result = await action();
    if (successMessage) showFeedback(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    return result;
  } catch (error) {
    reportError(error);
    return null;
  }
}

function statusLabel(source) {
  if (!source) return { label: 'Source disconnected', detail: 'No live source is connected', state: 'off' };
  const status = String(source.status || 'disconnected');
  const detail = source.detail || '';
  if (source.kind === 'webrtc') {
    const labels = {
      preparing: ['Creating WebRTC answer', detail || 'Waiting for ICE gathering…', 'working'],
      ready: ['WebRTC ready', detail || 'Waiting for video frames', 'ready'],
      running: ['WebRTC connected', detail || 'Receiving video', 'live'],
      stalled: ['WebRTC stream stalled', detail || 'Waiting for decoded frames', 'error'],
      error: ['WebRTC connection error', detail || 'Check the offer and sender connection', 'error'],
      disconnected: ['WebRTC disconnected', detail || 'Connect an offer to start receiving', 'off'],
    };
    const [label, message, state] = labels[status] || ['WebRTC status unavailable', detail || 'Connection state is unknown', 'off'];
    return { label, detail: message, state };
  }
  if (source.kind === 'reference') {
    return source.connected
      ? { label: 'Reference image ready', detail: detail || 'Static reference source', state: 'live' }
      : { label: 'Reference image unavailable', detail: detail || 'Import a reference image and model', state: 'off' };
  }
  const labels = {
    preparing: ['Preparing source', detail || 'Connecting to source…', 'working'],
    ready: ['Source ready', detail || 'Waiting for frames', 'ready'],
    running: ['Live source connected', detail || 'Receiving frames', 'live'],
    stalled: ['Source stalled', detail || 'No recent frames', 'warning'],
    error: ['Source error', detail || 'Check the source connection', 'error'],
    disconnected: ['Live source not connected', detail || 'No live source is connected', 'off'],
  };
  if (source.connected && status === 'disconnected') return { label: 'Live source connected', detail: detail || 'Source is active', state: 'live' };
  const [label, message, state] = labels[status] || ['Source status unavailable', detail || 'Connection state is unknown', 'off'];
  return { label, detail: message, state };
}

function outputReady(output) {
  return Boolean(output && output.sourceStatus === 'running' && output.sourceCompatible
    && output.displayConfirmed && output.rendererReady);
}

function isFieldFocused() {
  const active = document.activeElement;
  return active && (active.matches('input, textarea, select') || active.isContentEditable);
}

function setMode(mode) {
  pendingAlignmentSource=null;
  activeMode = mode === 'projector' ? 'projector' : 'placement';
  const projector = activeMode === 'projector';
  physicalCalibration?.setVisible(projector);
  $$('.mode-tab').forEach((tab) => {
    const selected = tab.dataset.mode === activeMode;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
  ui.placementPanel.hidden = projector;
  ui.gridPanel.hidden = projector;
  ui.maskPanel.hidden = projector;
  ui.projectorPanel.hidden = !projector;
  ui.alignmentSource.hidden = projector || activeTool !== 'align';
  ui.alignmentPanel.hidden = projector || activeTool !== 'align';
  ui.placementPanel.hidden = projector || activeTool === 'align';
  ui.gridPanel.hidden = projector || activeTool === 'align';
  ui.maskPanel.hidden = projector || activeTool === 'align';
  $('#mapping-mode').closest('.mapping-mode-control').hidden = projector;
  $('#mapping-uv-note').hidden=projector||snapshot?.project?.placement?.mappingMode!=='uv';
  ui.canvasTitle.textContent = projector ? 'Projector preview' : 'Model preview';
  ui.canvasBadge.textContent = projector ? 'Calibration' : 'Placement';
  ui.viewport.setAttribute('aria-label', projector ? 'Projector calibration preview' : '3D model and image placement preview');
  $$('.tool-switch').forEach((toolbar) => { toolbar.hidden = projector; });
  if (viewportApi) {viewportApi.setMode(activeMode);viewportApi.setTextureOpacity(!projector&&activeTool==='align'?Number($('#texture-opacity').value):1);}
  renderAlignment();
  updateCta();
}

function setTool(tool) {
  pendingAlignmentSource=null;
  activeTool = ['move', 'grid', 'mask', 'align'].includes(tool) ? tool : 'move';
  if (snapshot?.project?.placement?.mappingMode === 'uv' && activeTool !== 'move') {
    activeTool = 'move';
    showFeedback('Switch to Front mapping to use Align, Grid, or Mask tools.');
  }
  $$('.tool-button').forEach((button) => {
    const selected = button.dataset.tool === activeTool;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (viewportApi) {viewportApi.setTool(activeTool);viewportApi.setTextureOpacity(activeTool==='align'?Number($('#texture-opacity').value):1);}
  ui.alignmentSource.hidden = activeMode !== 'placement' || activeTool !== 'align';
  ui.alignmentPanel.hidden = activeMode !== 'placement' || activeTool !== 'align';
  $('#mapping-mode').closest('.mapping-mode-control').hidden = activeMode !== 'placement';
  ui.placementPanel.hidden = activeMode === 'projector' || activeTool === 'align';
  ui.gridPanel.hidden = activeMode === 'projector' || activeTool === 'align';
  ui.maskPanel.hidden = activeMode === 'projector' || activeTool === 'align';
  if (activeTool === 'align') {
    viewportApi?.fit();
    if (snapshot?.project?.placement?.mappingMode === 'uv') showFeedback('Switch to Front mapping to place landmarks.');
    else showFeedback('Click a point on the image, then the matching point on the model.');
  }
  else if (activeTool === 'grid' && selectedPoint === null) showFeedback('Select a point on the control grid to edit it.');
  else if (activeTool === 'mask') showFeedback(maskMode === 'exclude'
    ? 'Click around the surface to draw an excluded area, then double-click to finish.'
    : 'Click around the surface to draw the visible area, then double-click to finish.');
  renderAlignment();
}

function updateSavedState(project) {
  const saved = snapshot?.dirty !== undefined ? !snapshot.dirty : hasProjectFile && project.revision <= savedRevision;
  const icon = saved ? 'ph-check-circle' : 'ph-circle-dashed';
  const text = saved ? 'Saved' : 'Unsaved';
  ui.saveState.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i><span>${text}</span>`;
  ui.saveState.classList.toggle('is-unsaved', !saved);
}

function renderProject(project) {
  if (!project) return;
  ui.name.value = project.name || 'Untitled project';
  updateSavedState(project);
  $('#undo-project').disabled = !snapshot?.canUndo;
  $('#redo-project').disabled = !snapshot?.canRedo;

  const mesh = project.mesh;
  ui.modelName.textContent = mesh?.name || 'No model loaded';
  ui.modelState.textContent = mesh ? 'Loaded' : 'Required';
  ui.modelState.classList.toggle('is-ready', Boolean(mesh));
  ui.modelPreview.classList.toggle('has-model', Boolean(mesh));
  ui.loadedModelMark.querySelector('span').textContent = mesh ? 'OBJ model loaded' : 'No model loaded';
  ui.modelCaption.textContent = mesh ? '' : 'Import an OBJ to begin';

  const reference = project.reference;
  ui.referenceName.textContent = reference?.path?.split(/[\\/]/).at(-1) || 'Reference image';
  const referenceStatus = reference ? (snapshot?.referenceStatus || 'ready') : 'none';
  const referenceLabels = { ready: 'Ready', loading: 'Loading', missing: 'Missing', error: 'Error', none: 'None' };
  ui.referenceState.textContent = referenceLabels[referenceStatus] || 'Unknown';
  ui.referenceState.classList.toggle('is-ready', referenceStatus === 'ready');
  ui.referenceState.classList.toggle('is-error', ['missing', 'error'].includes(referenceStatus));
  ui.referenceAction.textContent = reference ? 'Replace image' : 'Add reference image';
  ui.referenceWarning.hidden = !reference || !['missing', 'error'].includes(referenceStatus);
  ui.referenceWarning.textContent = ui.referenceWarning.hidden ? ''
    : snapshot?.error || (referenceStatus === 'missing' ? 'The reference file is missing. Replace it to preview the image.' : 'The reference image could not be loaded.');
  const previewUrl = snapshot?.referencePreview;
  if (reference && typeof previewUrl === 'string' && previewUrl) {
    ui.referenceThumb.src = previewUrl;
    ui.referenceThumb.hidden = false;
    ui.referenceEmpty.hidden = true;
  } else if (!reference) {
    ui.referenceThumb.removeAttribute('src');
    ui.referenceThumb.hidden = true;
    ui.referenceEmpty.hidden = false;
    ui.referenceEmptyLabel.textContent = 'No reference image';
  } else {
    ui.referenceThumb.hidden = true;
    ui.referenceEmpty.hidden = false;
    ui.referenceEmptyLabel.textContent = referenceStatus === 'loading' ? 'Loading reference…'
      : referenceStatus === 'missing' ? 'Reference file missing'
        : referenceStatus === 'error' ? 'Preview unavailable' : 'Reference preview unavailable';
  }

  const transform = project.placement.transform;
  ui.placementX.value = formatNumber(transform.x, 3);
  ui.placementY.value = formatNumber(transform.y, 3);
  ui.placementScale.value = formatNumber(transform.scale * 100, 1);
  ui.placementRotation.value = formatNumber(transform.rotation, 1);
  const mask = project.placement.mask || [];
  ui.maskCount.textContent = String(mask.length);
  ui.maskNote.textContent = mask.length ? `${mask.length} mask ${mask.length === 1 ? 'region' : 'regions'} defined on the surface.` : maskMode === 'exclude' ? 'Use the Mask tool to draw areas to exclude from projection.' : 'Use the Mask tool to draw the area to keep visible on the surface.';
  ui.clearMask.disabled = mask.length === 0;

  renderProjector(project.projector);
  $('#resolution-status').textContent = `${project.output.width} × ${project.output.height}`;
  ui.sourceHealth.classList.toggle('is-ready', Boolean(snapshot?.source?.connected));
  if (viewportApi) viewportApi.setSnapshot(snapshot);
  renderAlignment(project);
}

function renderProjector(projector) {
  if (!projector) return;
  $('#projector-fov').value = formatNumber(projector.fov, 1);
  ['x', 'y', 'z'].forEach((axis, index) => {
    $(`#projector-${axis}`).value = formatNumber(projector.position[index], 3);
    $(`#camera-r${axis}`).value = formatNumber(projector.rotation[index], 2);
    $(`#model-${axis}`).value = formatNumber(projector.model.position[index], 3);
    $(`#model-r${axis}`).value = formatNumber(projector.model.rotation[index], 2);
  });
  $('#projector-offset-x').value = formatNumber(projector.offset[0], 3);
  $('#projector-offset-y').value = formatNumber(projector.offset[1], 3);
  $('#model-scale').value = formatNumber(projector.model.scale, 3);
}

function renderOutput(state, source) {
  const { label, detail, state: health } = statusLabel(source);
  ui.sourceStatus.textContent = label;
  ui.sourceDetail.textContent = detail;
  ui.sourceHealth.dataset.state = health;
  ui.footerSource.textContent = label;
  ui.footerSourceDetail.textContent = detail;
  ui.footerDot.dataset.state = health;
  const output = state || {};
  const mode = snapshot?.mode || (output.blackout || !output.armed ? 'black' : output.hold ? 'held' : 'live');
  const isBlackout = Boolean(output.blackout);
  ui.blackout.classList.toggle('is-active', isBlackout);
  ui.blackout.setAttribute('aria-pressed', String(isBlackout));
  ui.blackout.innerHTML = `<i class="ph ${isBlackout ? 'ph-sun' : 'ph-moon'}" aria-hidden="true"></i><span>${isBlackout ? 'Blackout on' : 'Blackout'}</span>`;
  const states = {
    black: [isBlackout ? 'Blackout active' : 'Output black', output.armed ? 'Blackout is holding output black' : 'Projector not armed', 'black'],
    held: ['Frame held', 'Output holding the last frame', 'held'],
    live: ['Output live', 'Projection is running', 'live'],
  };
  const [outputLabel, outputDetail, outputKind] = states[mode] || states.black;
  ui.outputStatus.textContent = outputLabel;
  ui.outputDetail.textContent = outputDetail;
  ui.outputSwatch.dataset.state = outputKind;
  const ready = outputReady(output);
  ui.resume.disabled = !ready || Boolean(output.armed);
  ui.resume.title = ready ? (output.armed ? 'Output is already armed' : 'Resume projection') : 'Connect a running source and confirm a display first';
  ui.hold.disabled = !ready || !output.armed;
  ui.hold.title = ui.hold.disabled ? 'Source must be running and output armed' : output.hold ? 'Release held frame' : 'Hold the current frame';
  ui.hold.innerHTML = `<i class="ph ${output.hold ? 'ph-play' : 'ph-pause'}" aria-hidden="true"></i>${output.hold ? 'Release hold' : 'Hold'}`;
  ui.stop.disabled = !output.armed && !output.hold;
  $('#reference-thumb').dataset.sourceStatus = health;
  const incoming = Number.isFinite(source?.incomingFps) ? `${source.incomingFps.toFixed(1)} fps` : '— fps';
  const presented = Number.isFinite(output.presentedFps) ? `${output.presentedFps.toFixed(1)} fps` : '— fps';
  $('#incoming-fps').textContent = incoming;
  $('#presented-fps').textContent = presented;
  updateCta();
}

function renderSnapshot(next) {
  if (!next || typeof next !== 'object') return;
  const previousProject=snapshot?.project;
  const nextProject=next.project;
  if(previousProject && nextProject && (previousProject.id!==nextProject.id ||
      previousProject.mesh?.obj!==nextProject.mesh?.obj || previousProject.reference?.path!==nextProject.reference?.path ||
      (previousProject.placement.alignment?.pairs?.length??0)!==(nextProject.placement.alignment?.pairs?.length??0))) {
    pendingAlignmentSource=null;
    selectedAlignment=null;
    viewportApi?.setAlignmentSelection(null);
  }
  snapshot = next;
  editorWebRTCSource?.updateSnapshot(snapshot);
  if (snapshot.project) renderProject(snapshot.project);
  physicalCalibration?.render(snapshot);
  webrtcPanel?.render(snapshot);
  renderOutput(snapshot.output, snapshot.source);
  if (snapshot.error && snapshot.error !== lastSnapshotError) reportError(new Error(snapshot.error));
  lastSnapshotError = snapshot.error || null;
  const currentDisplay = snapshot.displayId || snapshot.project?.output?.displayId;
  if (currentDisplay) selectedDisplayId = String(currentDisplay);
  renderDisplaySummary();
}

function formatNumber(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '0';
  const fixed = parsed.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

async function editProject(command, successMessage) {
  const result = await callDesktop('editProject', command);
  if (successMessage) showFeedback(successMessage);
  return result;
}

function alignmentPairs() {
  return snapshot?.project?.placement?.alignment?.pairs || [];
}

function renderAlignment(project = snapshot?.project) {
  if (!project || !alignmentPanel) return;
  const placement = project.placement || {};
  const mappingMode = placement.mappingMode === 'uv' ? 'uv' : 'front';
  ui.mappingMode.value = mappingMode;
  $('#mapping-uv-note').hidden=mappingMode!=='uv'||activeMode!=='placement';
  const uv = mappingMode === 'uv';
  $('#mapping-mode').closest('.mapping-mode-control').hidden = activeMode !== 'placement';
  ui.alignmentModeNote.textContent = uv
    ? 'Model UV maps the full texture atlas. Align, Grid, Mask, and image transform controls apply to Front mapping only.'
    : 'Pair matching points on the image and model. Use at least three landmarks.';
  $$('.tool-button[data-tool="grid"], .tool-button[data-tool="mask"], .tool-button[data-tool="align"]').forEach((button) => {
    button.disabled = uv;
    button.title = uv ? 'Available in Front mapping' : '';
  });
  ui.placementPanel.classList.toggle('is-uv-disabled', uv);
  [ui.placementX, ui.placementY, ui.placementScale, ui.placementRotation, $('#reset-placement')].forEach((control) => { control.disabled = uv; });
  ui.gridPanel.classList.toggle('is-uv-disabled', uv);
  ui.maskPanel.classList.toggle('is-uv-disabled', uv);
  if (uv && activeTool !== 'move') setTool('move');
  alignmentPanel.render({ snapshot, pairs: placement.alignment?.pairs || [], selected: selectedAlignment, pending: Boolean(pendingAlignmentSource), pendingSource: pendingAlignmentSource, mode: mappingMode });
  const dimensions = placement.grid;
  $('#grid-dimensions').textContent = dimensions ? `${dimensions.columns} × ${dimensions.rows} control points` : 'Control grid';
}

async function commitAlignmentPairs(pairs, apply = false) {
  const type = apply && pairs.length >= 3 ? 'alignment-apply' : 'alignment-pairs';
  return editProject({ type, value: pairs });
}

function updateAlignmentPreview(pairs) {
  viewportApi?.previewAlignment(pairs);
  alignmentPanel?.render({ snapshot, pairs, selected: selectedAlignment, pending: Boolean(pendingAlignmentSource), pendingSource: pendingAlignmentSource, mode: snapshot?.project?.placement?.mappingMode || 'front' });
}

function placementValueFromInputs() {
  return {
    x: number(ui.placementX.value, 'X position'),
    y: number(ui.placementY.value, 'Y position'),
    scale: number(ui.placementScale.value, 'Scale') / 100,
    rotation: number(ui.placementRotation.value, 'Rotation'),
  };
}

function commitPlacement() {
  if (!snapshot?.project) return;
  return safely(() => editProject({ type: 'placement-transform', value: placementValueFromInputs() }));
}

function vectorFromInputs(prefix, fields, separator = '-') {
  return fields.map((field) => number($(`#${prefix}${separator}${field}`).value, `${prefix} ${field.toUpperCase()}`));
}

function commitProjector() {
  if (!snapshot?.project?.projector) return;
  return safely(() => {
    const previous = snapshot.project.projector;
    const value = {
      ...(previous.calibration ? { calibration: previous.calibration } : {}),
      position: vectorFromInputs('projector', ['x', 'y', 'z']),
      rotation: vectorFromInputs('camera-r', ['x', 'y', 'z'], ''),
      fov: number($('#projector-fov').value, 'Field of view'),
      offset: [number($('#projector-offset-x').value, 'Image offset X'), number($('#projector-offset-y').value, 'Image offset Y')],
      model: {
        position: vectorFromInputs('model', ['x', 'y', 'z']),
        rotation: vectorFromInputs('model-r', ['x', 'y', 'z'], ''),
        scale: number($('#model-scale').value, 'Model scale'),
      },
    };
    if (JSON.stringify(value) === JSON.stringify(previous)) return null;
    return editProject({ type: 'projector', value });
  });
}

async function saveProject() {
  return safely(async () => {
    const result = await callDesktop('saveProject');
    if (result?.canceled) {
      showFeedback('Save canceled.');
      return result;
    }
    hasProjectFile = Boolean(result?.path || result?.saved || result === true);
    if (hasProjectFile && snapshot?.project) savedRevision = snapshot.project.revision;
    updateSavedState(snapshot?.project || {});
    showFeedback(hasProjectFile ? 'Project saved.' : 'Save completed, but no saved file was reported.');
    return result;
  });
}

async function openProject() {
  pendingAlignmentSource=null;selectedAlignment=null;viewportApi?.clearAlignmentPreview();viewportApi?.setAlignmentSelection(null);renderAlignment();
  return safely(async () => {
    const result = await callDesktop('openProject');
    if (result?.canceled) {
      showFeedback('Open canceled.');
      return result;
    }
    hasProjectFile = Boolean(result?.path || result?.opened || result === true);
    savedRevision = snapshot?.project?.revision ?? -1;
    updateSavedState(snapshot?.project || {});
    showFeedback(result?.recovered ? 'Recovered project opened.' : 'Project opened.');
    return result;
  });
}

async function newProject() {
  const name = window.prompt('Name your project', 'Untitled project');
  if (name === null) return;
  await safely(async () => {
    await callDesktop('newProject', name);
    hasProjectFile = false;
    savedRevision = -1;
    if (snapshot?.project) updateSavedState(snapshot.project);
    showFeedback('New project created.');
  });
}

async function importFile(method) {
  pendingAlignmentSource=null;selectedAlignment=null;viewportApi?.clearAlignmentPreview();viewportApi?.setAlignmentSelection(null);renderAlignment();
  await safely(async () => {
    const result = await callDesktop(method);
    if (result?.canceled) return result;
    showFeedback(method === 'importMesh' ? 'Model imported.' : 'Reference image added.');
    return result;
  });
}

async function toggleBlackout() {
  await safely(() => callDesktop('outputAction', { type: 'blackout', enabled: !snapshot?.output?.blackout }));
}

async function outputAction(type, enabled) {
  await safely(() => callDesktop('outputAction', enabled === undefined ? { type } : { type, enabled }));
}

function renderDisplaySummary() {
  if (!snapshot) return;
  const activeId = snapshot.displayId || snapshot.project?.output?.displayId;
  const display = displays.find((item) => String(item.id) === String(activeId));
  if (!activeId) {
    ui.displaySummary.innerHTML = '<i class="ph ph-monitor" aria-hidden="true"></i><span>No display selected</span>';
    return;
  }
  const dimensions = `${snapshot.project.output.width} × ${snapshot.project.output.height}`;
  const name = display ? `Display ${displays.indexOf(display) + 1}${display.primary ? ' · Primary' : ''}` : `Display ${activeId}`;
  ui.displaySummary.innerHTML = `<i class="ph ph-monitor" aria-hidden="true"></i><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(dimensions)} px</small></span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function openDisplayDialog() {
  await safely(async () => {
    const result = await callDesktop('listDisplays');
    if (!Array.isArray(result) || result.length === 0) throw new Error('No connected displays were found.');
    displays = result;
    selectedDisplayId = String(snapshot?.displayId || snapshot?.project?.output?.displayId || result[0].id);
    renderDisplayChoices();
    ui.displayDialog.showModal();
  });
}

function renderDisplayChoices() {
  ui.displayList.replaceChildren();
  for (const [index, display] of displays.entries()) {
    const id = String(display.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'display-choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(id === selectedDisplayId));
    button.innerHTML = `<span class="display-choice-icon"><i class="ph ph-monitor" aria-hidden="true"></i></span><span class="display-choice-copy"><strong>Display ${index + 1}${display.primary ? ' · Primary' : ''}</strong><small>Desktop: ${display.bounds.width} × ${display.bounds.height} logical · Render: ${snapshot.project.output.width} × ${snapshot.project.output.height} px</small></span><span class="radio-mark" aria-hidden="true"></span>`;
    button.addEventListener('click', () => {
      selectedDisplayId = id;
      renderDisplayChoices();
    });
    ui.displayList.append(button);
  }
  ui.confirmDisplay.disabled = !selectedDisplayId;
}

async function confirmDisplay() {
  const displayId = selectedDisplayId;
  if (!displayId) return;
  ui.confirmDisplay.disabled = true;
  await safely(async () => {
    await callDesktop('openOutput', displayId);
    ui.displayDialog.close();
    showFeedback('Output opened black. Click Resume to project the loaded reference image.');
  });
  ui.confirmDisplay.disabled = false;
}

function updateCta() {
  if (!snapshot) return;
  const project = snapshot.project || {};
  const needsModel = !project.mesh;
  const hasDisplay = Boolean(snapshot.displayId || project.output?.displayId);
  ui.ctaHint.textContent = needsModel ? 'Import an OBJ to preview and calibrate your model.'
    : !hasDisplay ? 'Choose a display. The output opens black until you explicitly resume.'
      : 'Review calibration. Output stays black until you explicitly resume.';
}

function bindEvents() {
  $('#new-project').addEventListener('click', newProject);
  $('#open-project').addEventListener('click', openProject);
  $('#save-project').addEventListener('click', saveProject);
  $('#undo-project').addEventListener('click', () => safely(() => callDesktop('undo')));
  $('#redo-project').addEventListener('click', () => safely(() => callDesktop('redo')));
  $('#import-mesh').addEventListener('click', () => importFile('importMesh'));
  $('#import-reference').addEventListener('click', () => importFile('importReference'));
  ui.blackout.addEventListener('click', toggleBlackout);
  ui.hold.addEventListener('click', () => outputAction('hold', !snapshot?.output?.hold));
  ui.resume.addEventListener('click', () => outputAction('resume'));
  ui.stop.addEventListener('click', () => outputAction('stop'));
  $('#mode-placement').addEventListener('click', () => setMode('placement'));
  $('#mode-projector').addEventListener('click', () => setMode('projector'));
  $$('.tool-button').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('#mapping-mode').addEventListener('change', (event) => {
    const next = event.currentTarget.value === 'uv' ? 'uv' : 'front';
    if (next === 'uv' && !viewportApi?.hasUV?.()) {
      event.currentTarget.value = 'front';
      reportError(new Error('Model UV mapping is unavailable. Every model part needs UV coordinates and a matching texture atlas.'));
      return;
    }
    safely(async () => {
      const result = await editProject({ type: 'mapping-mode', value: next });
      if (next === 'uv') setTool('move');
      return result;
    });
  });
  $('#texture-opacity').addEventListener('input', (event) => viewportApi?.setTextureOpacity(Number(event.currentTarget.value)));
  $('[data-alignment-apply]').addEventListener('click', () => {
    const pairs = alignmentPairs();
    if (pairs.length < 3) return;
    safely(async () => {
      try {
        await commitAlignmentPairs(pairs, true);
        viewportApi?.clearAlignmentPreview();
        showFeedback('Alignment applied.');
      } catch (error) {
        viewportApi?.clearAlignmentPreview();
        renderAlignment();
        throw error;
      }
    });
  });
  [ui.placementX, ui.placementY, ui.placementScale, ui.placementRotation].forEach((input) => input.addEventListener('change', commitPlacement));
  $$('#projector-panel input').forEach((input) => input.addEventListener('change', commitProjector));
  $('#reset-placement').addEventListener('click', () => safely(() => editProject({ type: 'reset-placement' }, 'Image placement reset.')));
  ui.clearMask.addEventListener('click', () => safely(() => editProject({ type: 'mask', value: [] }, 'Coverage mask cleared.')));
  ui.maskMode.addEventListener('change', (event) => {
    maskMode = event.currentTarget.value === 'exclude' ? 'exclude' : 'keep';
    viewportApi?.setMaskExcluded(maskMode === 'exclude');
    ui.maskNote.textContent = snapshot?.project?.placement?.mask?.length
      ? `${snapshot.project.placement.mask.length} mask ${snapshot.project.placement.mask.length === 1 ? 'region' : 'regions'} defined on the surface.`
      : maskMode === 'exclude' ? 'Use the Mask tool to draw areas to exclude from projection.' : 'Use the Mask tool to draw the area to keep visible on the surface.';
  });
  $('#toggle-grid').addEventListener('click', (event) => {
    showGrid = !showGrid;
    event.currentTarget.setAttribute('aria-pressed', String(showGrid));
    event.currentTarget.title = showGrid ? 'Hide grid' : 'Show grid';
    viewportApi?.setGridVisibility(showGrid);
  });
  $('#wireframe').addEventListener('click', (event) => {
    wireframe = !wireframe;
    event.currentTarget.setAttribute('aria-pressed', String(wireframe));
    viewportApi?.setWireframe(wireframe);
  });
  $('#fit-view').addEventListener('click', () => viewportApi?.fit());
  $('#choose-display').addEventListener('click', openDisplayDialog);
  ui.review.addEventListener('click', () => {
    setMode('projector');
    openDisplayDialog();
  });
  $('#cancel-display').addEventListener('click', () => ui.displayDialog.close());
  ui.confirmDisplay.addEventListener('click', confirmDisplay);
  document.addEventListener('keydown', (event) => {
    if (isFieldFocused() || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleBlackout();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveProject();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      safely(() => callDesktop(event.shiftKey ? 'redo' : 'undo'));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      safely(() => callDesktop('redo'));
    }
  });
}

let viewportApi;
try {
  viewportApi = createViewport(ui.viewport, {
    onPhysicalSource: point => physicalCalibration?.addSource(point),
    onPhysicalSelect: index => physicalCalibration?.select(index),
    onPhysicalDrag: (index, point, commit) => physicalCalibration?.dragTarget(index, point, commit),
    onPhysicalCancel: () => physicalCalibration?.cancelDrag(),
    onGridPoint: (index, point) => safely(() => editProject({ type: 'grid-point', index, point })),
    onMask: (polygons) => safely(() => editProject({ type: 'mask', value: polygons })),
    onAlignmentTarget: (target) => {
      if (!pendingAlignmentSource || alignmentPairs().length >= 12) return;
      const pairs = [...alignmentPairs(), { source: pendingAlignmentSource, target }];
      pendingAlignmentSource = null;
      selectedAlignment = pairs.length - 1;
      return safely(async () => {
        await commitAlignmentPairs(pairs);
        selectedAlignment=pairs.length-1;
        viewportApi?.setAlignmentSelection(selectedAlignment);
        renderAlignment();
      });
    },
    onAlignmentSelection: (index) => {
      selectedAlignment = index;
      renderAlignment();
    },
    onAlignmentDrag: (index, target, commit) => {
      const pairs = alignmentPairs().map((pair, pairIndex) => pairIndex === index ? { ...pair, target } : pair);
      if (!commit) {
        updateAlignmentPreview(pairs);
        return;
      }
      return safely(async () => {
        try {
          await commitAlignmentPairs(pairs, pairs.length >= 3);
          viewportApi?.clearAlignmentPreview();
        } catch (error) {
          viewportApi?.clearAlignmentPreview();
          renderAlignment();
          throw error;
        }
      });
    },
    onSelection: (index) => {
      selectedPoint = index;
      ui.gridSelection.innerHTML = index === null || index === undefined
        ? '<i class="ph ph-cursor-click" aria-hidden="true"></i><span>Select a grid point in the viewport</span>'
        : `<i class="ph ph-crosshair" aria-hidden="true"></i><span>Point ${Number(index) + 1} selected</span>`;
    },
    onError: reportError,
  });
} catch (error) {
  reportError(error);
}

physicalCalibration = createPhysicalCalibration(ui.projectorPanel, {
  onEdit: command => editProject(command),
  onState: state => viewportApi?.setPhysicalCalibration(state),
  onMarker: value => desktop.setCalibrationMarker?.(value),
  getLandmarks: () => viewportApi?.getPhysicalLandmarks() ?? [],
  onError: reportError,
});
webrtcPanel = createWebRTCPanel($('#webrtc-panel'), {
  desktop,
  run: action => safely(async () => {
    const result = await action();
    if (result?.project) renderSnapshot(result);
    return result;
  }),
  getSnapshot: () => snapshot,
  isReceiverReady: () => Boolean(editorWebRTCSource),
  getPreviewState: () => editorWebRTCSource?.getState(),
});
ui.webrtcPreviewFreeze.addEventListener('click', () => {
  const state = editorWebRTCSource?.getState();
  if (!state?.canFreeze) return;
  editorWebRTCSource.setFrozen(!state.frozen);
  renderWebRTCPreviewState(editorWebRTCSource.getState());
});
bindEvents();
setMode(activeMode);
if (viewportApi) {
  viewportApi.setTool(activeTool);
  viewportApi.setGridVisibility(showGrid);
  viewportApi.setWireframe(wireframe);
  viewportApi.setMaskExcluded(maskMode === 'exclude');
}

if (hasMethod('onSnapshot')) {
  const unsubscribe = desktop.onSnapshot(renderSnapshot);
  window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });
}

safely(async () => {
  const current = await callDesktop('getSnapshot');
  if (!current?.project) throw new Error('The desktop did not provide a project snapshot.');
  hasProjectFile = Boolean(current.path);
  savedRevision = hasProjectFile ? current.project.revision : -1;
  renderSnapshot(current);
  if (typeof current.mediaChannel === 'string' && current.mediaChannel) {
    editorWebRTCSource = createEditorWebRTCSource({
      desktop, mediaChannel: current.mediaChannel, videoElement: ui.webrtcVideo,
      createReceiver: options => createWebRTCReceiver(options),
      createPublisher: options => createFramePublisher(options),
      onPreviewFrame: (canvas, metadata) => {
        if (ui.webrtcPreviewCanvas.width !== canvas.width || ui.webrtcPreviewCanvas.height !== canvas.height) {
          ui.webrtcPreviewCanvas.width = canvas.width;
          ui.webrtcPreviewCanvas.height = canvas.height;
        }
        ui.webrtcPreviewCanvas.getContext('2d')?.drawImage(canvas, 0, 0);
        ui.webrtcPreviewCanvas.hidden = false;
        ui.webrtcPreviewEmpty.hidden = true;
        viewportApi?.setVideoFrame(canvas);
        alignmentPanel.setLiveFrame(canvas, metadata);
      },
      onClearPreview: () => {
        ui.webrtcPreviewCanvas.hidden = true;
        ui.webrtcPreviewEmpty.hidden = false;
        viewportApi?.clearVideoSource();
        alignmentPanel.setLiveFrame(null);
        pendingAlignmentSource = null;
        if (snapshot) renderAlignment();
      },
      onState: renderWebRTCPreviewState,
    });
    editorWebRTCSource.updateSnapshot(current);
    await editorWebRTCSource.ready();
    webrtcPanel.render(snapshot);
  }
});
window.addEventListener('beforeunload', () => {
  editorWebRTCSource?.close();
  alignmentPanel?.destroy();
}, { once: true });

function renderWebRTCPreviewState(state = editorWebRTCSource?.getState()) {
  if (!state) return;
  ui.webrtcPreviewFreeze.disabled = !state.canFreeze;
  ui.webrtcPreviewFreeze.setAttribute('aria-pressed', String(state.frozen));
  ui.webrtcPreviewFreeze.textContent = state.frozen ? 'Follow live preview' : 'Freeze preview';
  ui.webrtcPreviewStatus.textContent = state.frozen ? 'Preview frozen · stream continues'
    : state.status === 'running' && state.hasFrame ? 'Live preview'
      : state.status === 'error' ? 'Preview error' : snapshot?.source?.kind === 'webrtc' ? 'Waiting for live video' : 'No live video';
  webrtcPanel?.render(snapshot);
}
