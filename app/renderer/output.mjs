import { createScenePreview } from './scene-preview.mjs';

const canvas = document.querySelector('#projection');
const markerElement = document.querySelector('#calibration-marker');
let currentMode = 'black', marker = null;
function showMarker() {
  markerElement.hidden = failed || currentMode !== 'live' || !marker;
  if (!marker) return;
  markerElement.style.left = `${marker.point.u * 100}%`;
  markerElement.style.top = `${marker.point.v * 100}%`;
  markerElement.querySelector('span').textContent = String(marker.index + 1);
}
let failed = false;
function fail(error) {
  failed = true;
  canvas.hidden = true;
  markerElement.hidden = true;
  console.error(error);
  window.projection.failed();
}
try {
  const scene = createScenePreview(canvas, fail, { projection: true });
  scene.setMode('projector');
  scene.setNavigation(false);
  let revision = null;
  function present(value) {
    if (failed) return;
    try {
      currentMode = value.mode;
      marker = value.calibrationMarker ?? null;
      showMarker();
      canvas.hidden = value.mode === 'black';
      if (value.mode !== 'live') return;
      const key = `${value.project.id}:${value.project.revision}:${value.referencePreview}`;
      if (key !== revision) {
        scene.setSnapshot(value);
        revision = key;
      }
    } catch (error) { fail(error); }
  }
  window.projection.onSnapshot(present);
  window.projection.onMarker(value => { marker = value; showMarker(); });
  present(await window.projection.getSnapshot());
} catch (error) { fail(error); }
