import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { panCameraByPixels, zoomCameraAtPoint } from '../renderer/scene-preview.mjs';

function cameraHarness() {
  const camera = new THREE.PerspectiveCamera(45, 800 / 500, 0.01, 1000);
  camera.position.set(0, 0, 3.5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const controls = { target: new THREE.Vector3(), update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } };
  return { camera, controls };
}

test('camera zoom keeps the chosen surface point at the same screen coordinate and clamps to 8x', () => {
  const { camera, controls } = cameraHarness();
  const anchor = new THREE.Vector3(0.4, -0.2, 0.15);
  const screenPoint = anchor.clone().project(camera);
  zoomCameraAtPoint(camera, controls, anchor, screenPoint.x, screenPoint.y, 5);
  const after = anchor.clone().project(camera);
  assert.ok(Math.abs(after.x - screenPoint.x) < 1e-9);
  assert.ok(Math.abs(after.y - screenPoint.y) < 1e-9);
  assert.equal(camera.zoom, 5);

  zoomCameraAtPoint(camera, controls, anchor, screenPoint.x, screenPoint.y, 50);
  assert.equal(camera.zoom, 8);
});

test('camera pan follows pointer motion at the controls-target depth', () => {
  const { camera, controls } = cameraHarness();
  const anchor = controls.target.clone();
  const before = anchor.clone().project(camera);
  panCameraByPixels(camera, controls, 100, 50, 800, 500);
  const after = anchor.clone().project(camera);
  assert.ok(Math.abs((after.x - before.x) - 0.25) < 1e-9);
  assert.ok(Math.abs((after.y - before.y) + 0.2) < 1e-9);
});

test('pan uses the grabbed surface depth so relief points follow the cursor', () => {
  const { camera, controls } = cameraHarness();
  const grabbedSurfacePoint = new THREE.Vector3(0.35, -0.2, 0.45);
  const before = grabbedSurfacePoint.clone().project(camera);
  const cameraLocal = camera.worldToLocal(grabbedSurfacePoint.clone());
  const depth = -cameraLocal.z;
  panCameraByPixels(camera, controls, 64, -30, 800, 500, depth);
  const after = grabbedSurfacePoint.clone().project(camera);
  assert.ok(Math.abs((after.x - before.x) - 0.16) < 1e-9);
  assert.ok(Math.abs((after.y - before.y) - 0.12) < 1e-9);
});
