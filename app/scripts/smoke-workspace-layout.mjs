import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mapping-layout-smoke-'));
let application;
const near = (actual, expected, tolerance = 3) => Math.abs(actual - expected) <= tolerance;

try {
  application = await electron.launch({
    args: [root, '--ozone-platform=x11', `--user-data-dir=${temporary}/profile`],
    timeout: 30000,
  });
  const editor = await application.firstWindow();
  const errors = [];
  editor.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await editor.locator('#toggle-sources').waitFor({ state: 'visible' });
  const initialRevision = await editor.evaluate(async () => (await window.desktop.getSnapshot()).project.revision);

  const expandedToggle = editor.locator('#toggle-sources');
  const collapsedToggle = editor.locator('#show-sources');
  assert.equal(await editor.locator('.source-rail').locator('#toggle-sources').count(), 1, 'hide control belongs to sources panel');
  assert.equal(await expandedToggle.isVisible(), true);
  assert.equal(await collapsedToggle.isVisible(), false, 'show control stays hidden while sources are open');
  const headingBox = await editor.locator('.model-section .section-heading').boundingBox();
  const hideBox = await expandedToggle.boundingBox();
  assert.ok(hideBox.x >= headingBox.x && hideBox.x + hideBox.width <= headingBox.x + headingBox.width, 'hide control sits in Model heading');

  const width = selector => editor.locator(selector).evaluate(element => element.getBoundingClientRect().width);
  const dragBy = async (selector, pixels) => {
    const box = await editor.locator(selector).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await editor.mouse.move(x, y);
    await editor.mouse.down();
    await editor.mouse.move(x + pixels, y, { steps: 8 });
    await editor.mouse.up();
  };

  const initialSource = await width('.source-rail');
  const initialInspector = await width('.inspector');
  await dragBy('#source-divider', 40);
  const expandedSource = await width('.source-rail');
  assert.ok(near(expandedSource, initialSource + 40), 'dragging the left divider expands sources');
  await dragBy('#inspector-divider', -16);
  const expandedInspector = await width('.inspector');
  assert.ok(near(expandedInspector, initialInspector + 16), `dragging the right divider expands inspector: ${initialInspector} → ${expandedInspector}, source ${expandedSource}, canvas ${await width('.canvas-column')}`);
  assert.ok((await width('.canvas-column')) >= 560, 'preview keeps its minimum width');

  await editor.locator('#inspector-divider').focus();
  await editor.keyboard.press('ArrowRight');
  assert.ok(near(await width('.inspector'), expandedInspector - 16), 'keyboard adjusts inspector width');
  if (process.env.MAPPING_LAYOUT_CAPTURE === '1') await editor.screenshot({ path: join(tmpdir(), 'mapping-layout-resized.png'), scale: 'css' });

  await editor.locator('#toggle-sources').click();
  assert.equal(await editor.locator('.source-rail').isVisible(), false);
  assert.equal(await expandedToggle.isVisible(), false);
  assert.equal(await collapsedToggle.isVisible(), true, 'show control appears when sources are hidden');
  assert.equal(await collapsedToggle.getAttribute('aria-expanded'), 'false');
  const showBox = await collapsedToggle.boundingBox();
  const canvasBox = await editor.locator('.canvas-column').boundingBox();
  assert.ok(showBox.x >= canvasBox.x && showBox.x < canvasBox.x + 45, 'show control sits at preview left edge');
  if (process.env.MAPPING_LAYOUT_CAPTURE === '1') await editor.screenshot({ path: join(tmpdir(), 'mapping-layout-collapsed.png'), scale: 'css' });
  await editor.reload();
  await collapsedToggle.waitFor({ state: 'visible' });
  assert.equal(await editor.locator('.source-rail').isVisible(), false, 'hidden sidebar survives reload');
  await collapsedToggle.click();
  assert.equal(await expandedToggle.isVisible(), true);
  assert.equal(await collapsedToggle.isVisible(), false);
  assert.ok(near(await width('.source-rail'), expandedSource), 'sidebar width survives reload');
  assert.ok(near(await width('.inspector'), expandedInspector - 16), 'inspector width survives reload');

  await dragBy('#source-divider', 1000);
  assert.ok((await width('.canvas-column')) >= 560, 'divider cannot squeeze the preview below minimum');
  if (process.env.MAPPING_LAYOUT_CAPTURE === '1') await editor.screenshot({ path: join(tmpdir(), 'mapping-layout-minimum.png'), scale: 'css' });
  assert.equal(await editor.evaluate(async () => (await window.desktop.getSnapshot()).project.revision), initialRevision, 'layout changes do not edit the project');
  assert.deepEqual(errors, [], 'editor has no uncaught page errors');
  console.log('PASS: sidebar collapse, pointer and keyboard resizing, minimum preview width, and persistence.');
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
