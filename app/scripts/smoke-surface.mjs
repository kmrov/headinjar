import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mapping-surface-smoke-'));
const screenshots = resolve(root, 'test-results');
await mkdir(screenshots, { recursive: true });
let application;
try {
  application = await electron.launch({ args: [root, '--ozone-platform=x11', `--user-data-dir=${temporary}/profile`], timeout: 30000 });
  const editor = await application.firstWindow();
  const errors = [];
  editor.on('pageerror', error => errors.push(error.message));
  editor.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await editor.waitForFunction(() => Boolean(window.desktop));
  await editor.evaluate(() => document.fonts.ready);
  const invoke = (method, argument) => editor.evaluate(async ({ method, argument }) => window.desktop[method](argument), { method, argument });
  const pixelAt = (path, x, y) => application.evaluate(({ nativeImage }, point) => {
    const image = nativeImage.createFromPath(point.path);
    const pixels = image.toBitmap();
    const offset = (point.y * image.getSize().width + point.x) * 4;
    return [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
  }, { path, x: Math.round(x), y: Math.round(y) });
  await invoke('newProject', 'Surface placement smoke');
  await editor.waitForFunction(()=>document.querySelector('#mapping-mode option[value="surface"]').disabled);
  assert.equal(await editor.locator('#mapping-mode option[value="surface"]').evaluate(option=>option.disabled),true,'Surface mode needs an imported mesh');
  const meshPath = join(temporary, 'cube.obj');
  const imagePath = join(temporary, 'white.png');
  const savePath = join(temporary, 'surface.mapping.json');
  await writeFile(meshPath, [
    'v -1 -1 -1','v 1 -1 -1','v 1 1 -1','v -1 1 -1',
    'v -1 -1 1','v 1 -1 1','v 1 1 1','v -1 1 1',
    'f 5 6 7 8','f 2 3 7 6','f 4 3 2 1','f 1 5 8 4','f 4 8 7 3','f 1 2 6 5',
  ].join('\n') + '\n');
  const imageBase64=await editor.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
    const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,8,8);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.title.includes('project') ? paths.save : options.title.includes('mesh') ? paths.mesh : paths.image] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { mesh: meshPath, image: imagePath, save: savePath });
  await editor.locator('#import-mesh').click();
  await editor.waitForFunction(async () => Boolean((await window.desktop.getSnapshot()).project.mesh));
  await editor.locator('#import-reference').click();
  await editor.waitForFunction(async () => Boolean((await window.desktop.getSnapshot()).referencePreview));
  await editor.locator('#mapping-mode').selectOption('surface');
  await editor.waitForFunction(async () => (await window.desktop.getSnapshot()).project.placement.mappingMode === 'surface');
  assert.equal(await editor.locator('[data-tool="place"]').getAttribute('aria-pressed'), 'true');
  const box = await editor.locator('#viewport').boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await editor.mouse.click(center.x, center.y);
  await editor.waitForFunction(async () => Boolean((await window.desktop.getSnapshot()).project.placement.surface));
  let snapshot = await invoke('getSnapshot');
  assert.ok(snapshot.project.placement.surface.normal[2] > 0.9, 'initial visible face is +Z');
  await editor.locator('[data-tool="move"]').click();
  await editor.mouse.move(center.x, center.y);
  await editor.mouse.down();
  await editor.mouse.move(center.x - box.height / 4, center.y, { steps: 12 });
  await editor.mouse.up();
  await editor.locator('[data-tool="place"]').click();
  await editor.mouse.click(center.x, center.y);
  await editor.waitForFunction(async () => (await window.desktop.getSnapshot()).project.placement.surface?.normal[0] > 0.7);
  snapshot = await invoke('getSnapshot');
  const beforeDrag = snapshot.project.placement.surface;
  const revision = snapshot.project.revision;
  await editor.mouse.move(center.x, center.y);
  await editor.mouse.down();
  await editor.mouse.move(center.x + 35, center.y + 15, { steps: 8 });
  await editor.mouse.up();
  await editor.waitForFunction(async revision => (await window.desktop.getSnapshot()).project.revision > revision, revision);
  snapshot = await invoke('getSnapshot');
  assert.equal(snapshot.project.revision, revision + 1, 'one drag creates one history edit');
  assert.notDeepEqual(snapshot.project.placement.surface.position, beforeDrag.position);
  const placed = structuredClone(snapshot.project.placement.surface);
  const sideShot=join(screenshots, 'surface-side.png');
  await editor.screenshot({ scale: 'css', path: sideShot });
  const textured=await pixelAt(sideShot,center.x+80,center.y);
  assert.ok(textured.every(channel=>channel>150),`placed white image is visible on the selected side: ${textured}`);
  await editor.locator('#fit-view').click();
  const otherSideShot=join(screenshots, 'surface-other-side.png');
  await editor.screenshot({ scale: 'css', path: otherSideShot });
  const untextured=await pixelAt(otherSideShot,center.x,center.y);
  assert.ok(untextured[0]<textured[0]-50,`the adjacent side does not receive a second image: ${untextured}`);
  await invoke('undo');
  assert.deepEqual((await invoke('getSnapshot')).project.placement.surface, beforeDrag);
  await invoke('redo');
  assert.deepEqual((await invoke('getSnapshot')).project.placement.surface, placed);
  const revisionAfterRedo=(await invoke('getSnapshot')).project.revision;
  await editor.mouse.click(box.x+5,box.y+5);
  assert.equal((await invoke('getSnapshot')).project.revision,revisionAfterRedo,'clicking empty space does not edit placement');
  await editor.evaluate(()=>{
    document.querySelector('#viewport canvas:last-of-type').addEventListener('pointerdown',event=>{
      window.__surfaceTestPointerId=event.pointerId;
    },{once:true});
  });
  await editor.mouse.move(center.x,center.y);
  await editor.mouse.down();
  await editor.mouse.move(center.x+20,center.y+10,{steps:4});
  await editor.evaluate(()=>{
    document.querySelector('#viewport canvas:last-of-type').dispatchEvent(new PointerEvent('pointercancel',{
      bubbles:true,pointerId:window.__surfaceTestPointerId,
    }));
  });
  const retainedCapture=await editor.evaluate(()=>{
    const overlay=document.querySelector('#viewport canvas:last-of-type');
    const retained=overlay.hasPointerCapture(window.__surfaceTestPointerId);
    if(retained)overlay.releasePointerCapture(window.__surfaceTestPointerId);
    return retained;
  });
  await editor.mouse.up();
  assert.equal(retainedCapture,false,'pointer cancellation releases capture');
  assert.equal((await invoke('getSnapshot')).project.revision,revisionAfterRedo,'canceled drag does not edit placement');
  assert.deepEqual((await invoke('getSnapshot')).project.placement.surface,placed);
  await editor.locator('#surface-scale').fill('50');
  await editor.locator('#surface-scale').press('Tab');
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).project.placement.surface?.scale===0.5);
  await invoke('undo');
  assert.deepEqual((await invoke('getSnapshot')).project.placement.surface,placed,'undo restores the previous scale');
  await invoke('saveProject');
  assert.deepEqual(JSON.parse(await readFile(savePath, 'utf8')).placement.surface, placed);
  const projector=structuredClone((await invoke('getSnapshot')).project.projector);
  projector.position=[3,0,0];projector.rotation=[0,90,0];
  await invoke('editProject',{type:'projector',value:projector});
  const displays=await invoke('listDisplays');
  await invoke('openOutput',displays[0].id);
  const output=application.windows().find(page=>page!==editor);
  assert.ok(output,'projector output window opened');
  await output.waitForLoadState();
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).output.rendererReady);
  await invoke('outputAction',{type:'resume'});
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).mode==='live');
  const outputShot=join(screenshots,'surface-output.png');
  await output.screenshot({path:outputShot});
  const outputSize=await application.evaluate(({nativeImage},path)=>nativeImage.createFromPath(path).getSize(),outputShot);
  const projected=await pixelAt(outputShot,outputSize.width/2,outputSize.height/2);
  assert.ok(projected.every(channel=>channel>150),`Surface image reaches output: ${projected}`);
  await invoke('outputAction',{type:'stop'});
  await output.close();
  await invoke('openProject');
  assert.deepEqual((await invoke('getSnapshot')).project.placement.surface,placed,'reopen restores Surface placement');

  // A rear face only 7 mm behind a front face must stay untextured even when
  // viewed obliquely, where both faces are visible to the projector camera.
  const closeLayerMesh = (rear) => [
    'v -0.2 -1 1','v 0.2 -1 1','v 0.2 1 1','v -0.2 1 1',
    'v -0.01 -0.99 -1','v 0.01 -0.99 -1','v 0 -0.97 -1',
    'f 1 2 3 4','f 5 6 7',
    ...(rear ? ['v -0.2 -1 0.993','v 0.2 -1 0.993','v 0.2 1 0.993','v -0.2 1 0.993','f 8 9 10 11'] : []),
  ].join('\n') + '\n';
  await writeFile(meshPath, closeLayerMesh(false));
  await editor.locator('#import-mesh').click();
  const closeSurface={position:[0,0,1],normal:[0,0,1],up:[0,1,0],scale:1,rotation:0};
  await invoke('editProject',{type:'mapping-mode',value:'surface'});
  await invoke('editProject',{type:'surface-placement',value:closeSurface});
  const edgeProjector=structuredClone((await invoke('getSnapshot')).project.projector);
  edgeProjector.position=[1,0,1.1];edgeProjector.rotation=[0,84.29,0];
  await invoke('editProject',{type:'projector',value:edgeProjector});
  await invoke('openOutput',displays[0].id);
  const edgeOutput=application.windows().find(page=>page!==editor);
  edgeOutput.on('pageerror',error=>errors.push(`output: ${error.message}`));
  edgeOutput.on('console',message=>{if(message.type()==='error')errors.push(`output: ${message.text()}`);});
  await edgeOutput.waitForLoadState();
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).output.rendererReady);
  await invoke('outputAction',{type:'resume'});
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).mode==='live');
  const frontOnlyShot=join(screenshots,'surface-depth-front-only.png');
  await edgeOutput.screenshot({path:frontOnlyShot});
  await writeFile(meshPath,closeLayerMesh(true));
  await editor.locator('#import-mesh').click();
  await invoke('editProject',{type:'mapping-mode',value:'surface'});
  await invoke('editProject',{type:'surface-placement',value:closeSurface});
  await invoke('editProject',{type:'projector',value:edgeProjector});
  await invoke('outputAction',{type:'resume'});
  await editor.waitForFunction(async()=>(await window.desktop.getSnapshot()).mode==='live');
  await edgeOutput.waitForFunction(()=>!document.querySelector('#projection').hidden);
  await edgeOutput.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const closeLayersShot=join(screenshots,'surface-depth-close-layers.png');
  await edgeOutput.screenshot({path:closeLayersShot});
  const comparison=await application.evaluate(({nativeImage},paths)=>{
    const before=nativeImage.createFromPath(paths.before).toBitmap();
    const after=nativeImage.createFromPath(paths.after).toBitmap();
    let newBright=0;
    for(let i=0;i<after.length;i+=4){
      const base=Math.max(before[i],before[i+1],before[i+2]);
      const next=Math.min(after[i],after[i+1],after[i+2]);
      if(base<140&&next>180)newBright++;
    }
    const a=nativeImage.createFromPath(paths.before),b=nativeImage.createFromPath(paths.after);
    const center=(Math.floor(a.getSize().height/2)*a.getSize().width+Math.floor(a.getSize().width/2))*4;
    return {newBright,beforeCenter:[...before.subarray(center,center+4)],afterCenter:[...after.subarray(center,center+4)]};
  },{before:frontOnlyShot,after:closeLayersShot});
  assert.ok(comparison.beforeCenter.slice(0,3).every(channel=>channel>180),'the exposed front surface receives the image');
  assert.ok(comparison.afterCenter.slice(0,3).every(channel=>channel>180),'adding an inner layer keeps the front image');
  assert.ok(comparison.newBright<10,`occluded rear layer must not receive the image: ${JSON.stringify(comparison)}`);
  await invoke('outputAction',{type:'stop'});
  await edgeOutput.close();
  assert.deepEqual(errors, []);
  console.log('PASS: Surface place, orbit, side drag, one undo step, redo, save, editor and output pixels.');
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
