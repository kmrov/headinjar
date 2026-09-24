import { createScenePreview } from './scene-preview.mjs';
import { createWebRTCReceiver } from './webrtc-receiver.mjs';

const canvas = document.querySelector('#projection');
const markerElement = document.querySelector('#calibration-marker');
const videoElement = document.querySelector('#webrtc-video');
let currentMode = 'black', marker = null, failed = false, sourceKind = 'reference';
let currentSnapshot = null, revision = null, activeSessionId = null, receiverStatus = 'disconnected';
let localLatch = false, sawBlackAfterLatch = false, lastVideoSize = null, hasCopiedVideoFrame = false;
function showMarker() {
  markerElement.hidden = failed || currentMode !== 'live' || localLatch
    || (sourceKind === 'webrtc' && !hasCopiedVideoFrame) || !marker;
  if (!marker) return;
  markerElement.style.left = `${marker.point.u * 100}%`;
  markerElement.style.top = `${marker.point.v * 100}%`;
  markerElement.querySelector('span').textContent = String(marker.index + 1);
}
function fail(error) {
  failed = true;
  receiver?.setAudible(false);
  canvas.hidden = true;
  markerElement.hidden = true;
  console.error(error);
  window.projection.failed();
}
let scene;
let receiver;
function silenceAndLatch(status) {
  receiver?.setAudible(false);
  if (status !== 'running') {
    localLatch = true;
    sawBlackAfterLatch = false;
    canvas.hidden = true;
  }
  showMarker();
}
function statusUpdate(value) {
  if (value.sessionId !== activeSessionId) return;
  receiverStatus = value.status;
  if (value.status !== 'running') silenceAndLatch(value.status);
  else if (sourceKind === 'webrtc' && invalidateForResize(value.width, value.height)) return;
  window.projection.reportWebRTCStatus(value);
}
function invalidateForResize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const size = `${width}x${height}`;
  if (!lastVideoSize) { lastVideoSize = size; return false; }
  if (lastVideoSize === size) return false;
  lastVideoSize = size;
  hasCopiedVideoFrame = false;
  silenceAndLatch('stalled');
  const value = { sessionId: activeSessionId, status: 'running', width, height, detail: 'Video dimensions changed; output requires Resume.' };
  window.projection.reportWebRTCStatus(value);
  return true;
}
try {
  scene = createScenePreview(canvas, fail, { projection: true });
  receiver = createWebRTCReceiver({
    onStatus: statusUpdate,
    onFrame(video) {
      if (failed || sourceKind !== 'webrtc') return;
      if (invalidateForResize(video.videoWidth, video.videoHeight)) return;
      if (currentMode !== 'live' || receiverStatus !== 'running') return;
      const source = currentSnapshot?.source;
      if (!source || source.kind !== 'webrtc' || source.status !== 'running') return;
      if (localLatch) return;
      scene.setVideoFrame(video);
      hasCopiedVideoFrame = true;
      canvas.hidden = false;
      receiver.setAudible(true);
      showMarker();
    },
    createVideoElement: () => videoElement,
  });
  scene.setMode('projector');
  scene.setNavigation(false);
  function present(value) {
    if (failed) return;
    try {
      currentSnapshot = value;
      currentMode = value.mode;
      marker = value.calibrationMarker ?? null;
      if (value.mode !== 'live') receiver.setAudible(false);
      if (localLatch) {
        if (value.mode !== 'live') sawBlackAfterLatch = true;
        else if (sawBlackAfterLatch && value.source?.status === 'running') localLatch = false;
      }
      const nextSourceKind = value.source?.kind ?? 'reference';
      if (nextSourceKind !== sourceKind) {
        sourceKind = nextSourceKind;
        localLatch = true; sawBlackAfterLatch = value.mode !== 'live';
        hasCopiedVideoFrame = false;
        canvas.hidden = true;
        if (sourceKind === 'reference') {
          activeSessionId = null; receiverStatus = 'disconnected'; lastVideoSize = null;
          receiver.close(); scene.clearVideoSource();
        } else {
          receiver.setAudible(false);
        }
      }
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
  window.projection.onWebRTCOffer(async ({ sessionId, offer }) => {
    activeSessionId = sessionId;
    receiverStatus = 'preparing';
    lastVideoSize = null;
    hasCopiedVideoFrame = false;
    localLatch = true; sawBlackAfterLatch = currentMode !== 'live';
    receiver.setAudible(false);
    try {
      const answer = await receiver.acceptOffer(offer, sessionId);
      window.projection.answerWebRTC({ sessionId, answer });
    } catch (error) {
      window.projection.answerWebRTC({ sessionId, error: error?.message || String(error) });
    }
  });
  window.projection.onWebRTCReset(() => {
    activeSessionId = null; receiverStatus = 'disconnected'; lastVideoSize = null; hasCopiedVideoFrame = false;
    currentMode = 'black'; canvas.hidden = true; markerElement.hidden = true;
    localLatch = true; sawBlackAfterLatch = false;
    receiver.setAudible(false); receiver.close(); scene.clearVideoSource();
  });
  window.projection.onSnapshot(present);
  window.projection.onMarker(value => { marker = value; showMarker(); });
  present(await window.projection.getSnapshot());
} catch (error) { fail(error); }
