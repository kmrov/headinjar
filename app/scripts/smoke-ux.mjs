import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const temporary = await mkdtemp(join(tmpdir(), 'headinjar-ux-'));
let application;
try {
  application = await electron.launch({
    args: [new URL('..', import.meta.url).pathname, '--ozone-platform=x11', `--user-data-dir=${temporary}/profile`],
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  const capture = async name => {
    if (!process.env.UX_CAPTURE_DIR) return;
    await mkdir(process.env.UX_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UX_CAPTURE_DIR, `${name}.png`), scale: 'css' });
  };
  await page.locator('#workflow-guide').waitFor({ state: 'visible' });
  assert.match(await page.locator('#workflow-guide').innerText(), /3D model/i);
  await capture('01-start');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 760));
  await capture('01-start-compact');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('#workflow-action').isVisible(), true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await page.locator('#open-example').click();
  await page.waitForFunction(async () => Boolean((await window.desktop.getSnapshot()).project.mesh));
  await page.waitForFunction(async () => Boolean((await window.desktop.getSnapshot()).referencePreview));
  assert.match(await page.locator('#project-name').inputValue(), /Practice/i);
  assert.equal(await page.locator('#workflow-guide').getAttribute('data-step'), 'align');
  await page.locator('#workflow-action').click();
  await page.locator('#alignment-source-panel').waitFor({ state: 'visible' });
  await capture('02-practice-align');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, join(temporary, 'practice.mapping.json'));
  await page.locator('#save-project').click();
  await page.waitForFunction(async () => !(await window.desktop.getSnapshot()).dirty);
  const before = await page.evaluate(async () => (await window.desktop.getSnapshot()).project.revision);
  await page.locator('#mode-projector').click();
  assert.equal(await page.locator('#workflow-guide').getAttribute('data-step'), 'display');
  assert.equal(await page.locator('#physical-pairs button').count(), 0);
  assert.equal(await page.evaluate(async () => (await window.desktop.getSnapshot()).project.revision), before);
  assert.equal(await page.evaluate(async () => (await window.desktop.getSnapshot()).dirty), false);
  assert.match(await page.locator('#physical-status').innerText(), /Choose a screen/i);
  await capture('03-calibration');
  await page.locator('#mode-placement').click();
  const pairs = [
    { source: { u: .35, v: .34 }, target: { u: .35, v: .34 } },
    { source: { u: .65, v: .34 }, target: { u: .65, v: .34 } },
    { source: { u: .5, v: .66 }, target: { u: .5, v: .66 } },
  ];
  await page.evaluate(value => window.desktop.editProject({ type: 'alignment-apply', value }), pairs);
  await page.waitForFunction(async () => (await window.desktop.getSnapshot()).project.placement.grid.columns === 17);
  assert.match(await page.locator('#alignment-result').innerText(), /updated automatically/i);
  await page.locator('#source-kind').selectOption('webrtc');
  assert.equal(await page.locator('#workflow-guide').getAttribute('data-step'), 'connect');
  assert.equal(await page.locator('.alignment-marker:visible').count(), 0);
  assert.equal(await page.locator('#webrtc-preview-canvas').isVisible(), false);
  assert.equal(await page.locator('#signaling-start').isVisible(), true);
  assert.equal(await page.locator('#whip-url').isVisible(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('04-video');
  console.log('PASS: first steps, practice scene, read-only calibration navigation, and compact video setup.');
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
