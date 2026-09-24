import { createScenePreview } from './scene-preview.mjs';
import { createFrameConsumer } from './media-frame-channel.mjs';

const canvas = document.querySelector('#projection');
const markerElement = document.querySelector('#calibration-marker');
let currentMode = 'black', marker = null, failed = false, sourceKind = 'reference';
let currentSnapshot = null, revision = null, activeSessionId = null;
let localLatch = false, sawBlackAfterLatch = false, lastVideoSize = null, hasCopiedVideoFrame = false;
let scene, frameConsumer, channelName = null;

function showMarker() {
  markerElement.hidden = failed || currentMode !== 'live' || localLatch
    || (sourceKind === 'webrtc' && !hasCopiedVideoFrame) || !marker;
  if (!marker) return;
  markerElement.style.left = `${marker.point.u * 100}%`;
  markerElement.style.top = `${marker.point.v * 100}%`;
  markerElement.querySelector('span').textContent = String(marker.index + 1);
}

function fail(error) {
  if (failed) return;
  failed = true;
  frameConsumer?.setEnabled(false);
  canvas.hidden = true;
  markerElement.hidden = true;
  console.error(error);
  window.projection.failed();
}

function invalidateForResize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const size = `${width}x${height}`;
  if (!lastVideoSize) { lastVideoSize = size; return false; }
  if (lastVideoSize === size) return false;
  lastVideoSize = size;
  hasCopiedVideoFrame = false;
  localLatch = true;
  sawBlackAfterLatch = false;
  canvas.hidden = true;
  scene.clearVideoSource();
  showMarker();
  return true;
}

function receiveFrame(bitmap, metadata) {
  if (failed || !currentSnapshot || sourceKind !== 'webrtc' || metadata.sessionId !== activeSessionId) return;
  const source = currentSnapshot.source;
  // IPC snapshots and BroadcastChannel frames are independently ordered. A
  // delayed frame must not rewrite the size latch after the source resized.
  if (source?.sessionId !== metadata.sessionId || source?.width !== metadata.width || source?.height !== metadata.height) return;
  if (invalidateForResize(metadata.width, metadata.height)) return;
  const outputReady = Boolean(currentSnapshot.output?.ready ?? currentSnapshot.output?.rendererReady);
  if (currentMode !== 'live' || !outputReady || localLatch || source?.status !== 'running'
    || source?.sessionId !== metadata.sessionId || source?.width !== metadata.width || source?.height !== metadata.height) return;
  scene.setVideoFrame(bitmap);
  hasCopiedVideoFrame = true;
  canvas.hidden = false;
  showMarker();
}

function ensureFrameConsumer(nextChannelName) {
  if (typeof nextChannelName !== 'string' || !nextChannelName) throw new Error('Live media channel is unavailable.');
  if (frameConsumer && channelName === nextChannelName) return;
  frameConsumer?.close();
  channelName = nextChannelName;
  frameConsumer = createFrameConsumer({ channelName, onFrame: receiveFrame, onError: fail });
}

function updateFrameConsumer(snapshot) {
  if (!frameConsumer) return;
  const source = snapshot.source;
  const nextKind = source?.kind ?? 'reference';
  const nextSessionId = nextKind === 'webrtc' && typeof source?.sessionId === 'string' ? source.sessionId : null;
  if (nextKind !== sourceKind || nextSessionId !== activeSessionId) {
    sourceKind = nextKind;
    activeSessionId = nextSessionId;
    lastVideoSize = null;
    hasCopiedVideoFrame = false;
    localLatch = true;
    sawBlackAfterLatch = snapshot.mode !== 'live';
    canvas.hidden = true;
    scene.clearVideoSource();
    frameConsumer.setSource(activeSessionId);
  }

  if (sourceKind === 'webrtc') {
    if (source?.status !== 'running') {
      if (hasCopiedVideoFrame || !localLatch) {
        localLatch = true;
        sawBlackAfterLatch = snapshot.mode !== 'live';
        hasCopiedVideoFrame = false;
        canvas.hidden = true;
        scene.clearVideoSource();
      }
    } else if (invalidateForResize(source.width, source.height)) {
      // A black authoritative snapshot counts as the black phase of this latch;
      // the next explicit Resume can release it without requiring a second one.
      if (snapshot.mode !== 'live') sawBlackAfterLatch = true;
    }
  } else {
    activeSessionId = null;
    lastVideoSize = null;
    hasCopiedVideoFrame = false;
    scene.clearVideoSource();
  }

  const outputReady = Boolean(snapshot.output?.ready ?? snapshot.output?.rendererReady);
  const enabled = sourceKind === 'webrtc' && Boolean(activeSessionId) && source?.status === 'running'
    && Number.isFinite(source.width) && source.width > 0 && Number.isFinite(source.height) && source.height > 0
    && snapshot.mode === 'live' && outputReady && !localLatch;
  frameConsumer.setEnabled(enabled);
}

function present(value) {
  if (failed) return;
  try {
    currentSnapshot = value;
    currentMode = value.mode;
    marker = value.calibrationMarker ?? null;
    ensureFrameConsumer(value.mediaChannel);
    if (localLatch) {
      if (value.mode !== 'live') sawBlackAfterLatch = true;
      else if (sawBlackAfterLatch && value.source?.status === 'running') localLatch = false;
    }
    updateFrameConsumer(value);
    const key = `${value.project.id}:${value.project.revision}:${value.referencePreview}`;
    if (key !== revision && value.mode === 'live' && !localLatch) {
      scene.setSnapshot(value);
      revision = key;
    }
    canvas.hidden = value.mode === 'black' || (value.mode === 'live' && localLatch)
      || (value.source?.kind === 'webrtc' && !hasCopiedVideoFrame);
    showMarker();
  } catch (error) { fail(error); }
}

try {
  scene = createScenePreview(canvas, fail, { projection: true });
  scene.setMode('projector');
  scene.setNavigation(false);
  window.projection.onSnapshot(present);
  window.projection.onMarker(value => { marker = value; showMarker(); });
  present(await window.projection.getSnapshot());
} catch (error) { fail(error); }

window.addEventListener('beforeunload', () => frameConsumer?.close(), { once: true });
