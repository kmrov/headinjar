import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createProject } from '../src/project/model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mapping-projector-landmarks-'));
const projectPath = join(temporary, 'plane.mapping.json');
const project = createProject({ id: 'projector-landmark-test', name: 'Projector landmarks', now: new Date().toISOString() });
project.mesh = {
  name: 'plane.obj',
  obj: 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3\nf 1 3 4\n',
};
project.projector.offset = [0.08, -0.04];
project.placement.alignment = { pairs: [
  { source: { u: 0.2, v: 0.2 }, target: { u: 0.2, v: 0.2 } },
  { source: { u: 0.8, v: 0.2 }, target: { u: 0.8, v: 0.2 } },
  { source: { u: 0.5, v: 0.8 }, target: { u: 0.5, v: 0.8 } },
] };
await writeFile(projectPath, JSON.stringify(project));

// The plane spans [-1, 1] after model fitting and is three units from the camera.
// Compute its screen position directly, independently of the renderer's raycaster.
const halfHeight = 3 * Math.tan(Math.PI / 8);
const aspect = project.output.width / project.output.height;
const expected = project.placement.alignment.pairs.map(({ target }) => ({
  u: 0.5 + (2 * target.u - 1) / (2 * halfHeight * aspect) + project.projector.offset[0],
  v: 0.5 - (1 - 2 * target.v) / (2 * halfHeight) + project.projector.offset[1],
}));
let application;
try {
  application = await electron.launch({ args: [root, '--ozone-platform=x11', `--user-data-dir=${temporary}/profile`] });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop));
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, projectPath);
  const snapshot = () => page.evaluate(() => window.desktop.getSnapshot());
  await page.evaluate(() => window.desktop.openProject());
  await page.locator('#mode-projector').click();
  await page.waitForFunction(async () => (await window.desktop.getSnapshot()).project.projector.calibration.pairs.length === 3);
  const seeded = (await snapshot()).project.projector.calibration.pairs;
  seeded.forEach((pair, index) => {
    assert.ok(Math.hypot(pair.source.u - expected[index].u, pair.source.v - expected[index].v) < 1e-5,
      `Align point ${index + 1} appears at its projector-camera position`);
    assert.deepEqual(pair.target, pair.source);
  });

  const stale = seeded.map(pair => ({ source: pair.source, target: { u: pair.source.u + 0.05, v: pair.source.v } }));
  await page.evaluate(value => window.desktop.editProject({ type: 'calibration-apply', value }), stale);
  const before = (await snapshot()).project.projector.calibration;
  assert.equal(before.grid.columns, 33);
  await page.locator('#physical-reseed').click();
  await page.waitForFunction(async () => (await window.desktop.getSnapshot()).project.projector.calibration.grid.columns === 2);
  const recreated = (await snapshot()).project.projector.calibration;
  assert.equal(recreated.pairs.length, expected.length);
  recreated.pairs.forEach((pair, index) => {
    assert.ok(Math.hypot(pair.source.u - expected[index].u, pair.source.v - expected[index].v) < 1e-5);
    assert.deepEqual(pair.target, pair.source);
  });
  await page.evaluate(() => window.desktop.undo());
  assert.deepEqual((await snapshot()).project.projector.calibration, before, 'Undo restores the previous physical calibration');
  console.log('PASS: projector landmarks use projector coordinates; Recreate from Align resets the warp and Undo restores it.');
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
