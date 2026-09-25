import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createProjectionWarp } from './projection-warp.mjs';
import { surfaceFromHit, surfaceProjectionFrame } from '../src/mapping/surface.mjs';

const MIN_MODEL_ZOOM = 1;
const MAX_MODEL_ZOOM = 8;

// The shell owns arming; projection mode renders unlit color on black.
export function createScenePreview(canvas, onError, { projection = false } = {}) {
  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
  renderer.setPixelRatio(projection ? 1 : Math.min(devicePixelRatio, 2));
  renderer.setClearColor(projection ? 0x000000 : 0x0d1012);
  const projectionWarp = createProjectionWarp(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(0, 0, 3.5);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  const pivot = new THREE.Group();
  scene.add(pivot);
  let meshKey = null, model = null, snapshot = null, mode = 'placement', wireframe = false, navigation = true, calibrationEditing = false;
  let textureKey = null, sourceTexture = null, videoTexture = null, videoCanvas = null, videoContext = null, videoSourceActive = false, videoSourceRequired = false, gridTexture = null, frontDepthTarget = null, depthKey = null;
  let sourceGeneration = 0, disposed = false, hasModelUV = false, modelBounds = null;
  let panDepth = null;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = 1024;
  const maskContext = maskCanvas.getContext('2d');
  const maskTexture = new THREE.CanvasTexture(maskCanvas);
  const uniforms = {
    image: {value:null}, grid: {value:null}, coverage:{value:maskTexture}, frontDepth:{value:null}, hasImage:{value:false},
    gridSize:{value:new THREE.Vector2(5,5)}, boundsMin:{value:new THREE.Vector2()},
    boundsSize:{value:new THREE.Vector2(1,1)}, translation:{value:new THREE.Vector2()},
    imageScale:{value:1}, angle:{value:0}, textureOpacity:{value:1}, useModelUV:{value:false}, useSurface:{value:false}, surfacePlaced:{value:false}, uvAvailable:{value:false},
    planeOrigin:{value:new THREE.Vector3()}, planeRight:{value:new THREE.Vector3(1,0,0)}, planeUp:{value:new THREE.Vector3(0,1,0)},
    planeNormal:{value:new THREE.Vector3(0,0,1)}, planeSize:{value:new THREE.Vector2(1,1)}, depthMin:{value:0}, depthRange:{value:1},
  };
  const material = new THREE.ShaderMaterial({
    defines: projection ? { PROJECTION_OUTPUT: 1 } : {},
    uniforms, side:THREE.FrontSide,
    vertexShader:`varying vec3 surfaceNormal; varying vec3 localPosition; varying vec3 localNormal; varying vec2 modelUV; varying vec2 domain; uniform vec2 boundsMin; uniform vec2 boundsSize;
      void main(){modelUV=uv;surfaceNormal=normalize(normalMatrix*normal);localPosition=position;localNormal=normal;domain=vec2((position.x-boundsMin.x)/boundsSize.x,1.0-(position.y-boundsMin.y)/boundsSize.y);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`precision highp float;
      varying vec3 surfaceNormal; varying vec3 localPosition; varying vec3 localNormal; varying vec2 modelUV; varying vec2 domain; uniform sampler2D image; uniform sampler2D grid; uniform sampler2D coverage; uniform sampler2D frontDepth;
      uniform vec2 gridSize; uniform vec2 translation; uniform float imageScale; uniform float angle; uniform bool hasImage; uniform bool useModelUV; uniform bool useSurface; uniform bool surfacePlaced; uniform bool uvAvailable; uniform float textureOpacity;
      uniform vec3 planeOrigin; uniform vec3 planeRight; uniform vec3 planeUp; uniform vec3 planeNormal; uniform vec2 planeSize; uniform float depthMin; uniform float depthRange;
      // Two 8-bit channels keep the visibility bias below one tenth of a millimeter
      // on a two-meter-deep model, instead of leaking onto nearby inner layers.
      const float FRONT_DEPTH_EPSILON=2.0/65535.0;
      vec2 at(vec2 p){return texture2D(grid,(p+0.5)/gridSize).xy;}
      void main(){
        // Camera-space studio lighting keeps relief readable while orbiting.
        vec3 n=normalize(surfaceNormal);
        float light=0.24+0.64*max(dot(n,normalize(vec3(-0.6,0.8,1.0))),0.0)
          +0.20*max(dot(n,normalize(vec3(0.8,0.1,0.5))),0.0);
        #ifdef PROJECTION_OUTPUT
          light=1.0;
        #endif
        // Compare in original model space so orbit and projector poses do not change visibility.
        vec2 projectedDomain=domain;
        if(useSurface){vec3 relative=localPosition-planeOrigin;
          projectedDomain=vec2(0.5+dot(relative,planeRight)/planeSize.x,0.5-dot(relative,planeUp)/planeSize.y);
        }
        if(hasImage && !useModelUV){
          float facing=useSurface?dot(normalize(localNormal),planeNormal):localNormal.z;
          float modelDepth=(dot(localPosition-planeOrigin,planeNormal)-depthMin)/depthRange;
          vec4 front=texture2D(frontDepth,vec2(projectedDomain.x,1.0-projectedDomain.y));
          float nearestDepth=dot(front.rg,vec2(256.0,1.0))/257.0;
          if((useSurface && !surfacePlaced) || facing<=0.0 || front.a<0.5 || modelDepth<nearestDepth-FRONT_DEPTH_EPSILON){
            gl_FragColor=vec4(vec3(0.46,0.49,0.50)*light,1.0);
            #ifdef PROJECTION_OUTPUT
              gl_FragColor=vec4(0.,0.,0.,1.);
            #endif
            #include <colorspace_fragment>
            return;
          }
        }
        if(!hasImage || textureOpacity<=0.0 || (useModelUV && !uvAvailable)){
          gl_FragColor=vec4(vec3(0.46,0.49,0.50)*light,1.0);
          #ifdef PROJECTION_OUTPUT
            gl_FragColor=vec4(0.,0.,0.,1.);
          #endif
          #include <colorspace_fragment>
          return;
        }
        vec2 d=clamp(domain,0.0,1.0); vec2 g=d*(gridSize-1.0); vec2 cell=min(floor(g),gridSize-2.0); vec2 f=g-cell;
        vec2 tl=at(cell),tr=at(cell+vec2(1.,0.)),br=at(cell+vec2(1.,1.)),bl=at(cell+vec2(0.,1.));
        vec2 uv=f.y<=f.x ? tl*(1.-f.x)+tr*(f.x-f.y)+br*f.y : tl*(1.-f.y)+br*f.x+bl*(f.y-f.x);
        uv=(uv-0.5-translation)/imageScale; float c=cos(angle),s=sin(angle);
        uv=vec2(c*uv.x+s*uv.y,-s*uv.x+c*uv.y)+0.5;
        float mask=texture2D(coverage,vec2(d.x,1.-d.y)).r;
        if(useSurface){uv=projectedDomain;mask=1.0;}
        if(useModelUV){uv=vec2(modelUV.x,1.-modelUV.y);mask=1.0;}
        if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.)))||mask<0.5){gl_FragColor=vec4(vec3(0.46,0.49,0.50)*light*(1.-textureOpacity),1.);
          #include <colorspace_fragment>
          return;}
        gl_FragColor=texture2D(image,vec2(uv.x,1.-uv.y));
        gl_FragColor.rgb=mix(vec3(0.46,0.49,0.50),gl_FragColor.rgb,textureOpacity)*light;
        #include <colorspace_fragment>
      }`,
  });
  const frontCaptureMaterial = new THREE.ShaderMaterial({
    uniforms:{planeOrigin:uniforms.planeOrigin,planeRight:uniforms.planeRight,planeUp:uniforms.planeUp,
      planeNormal:uniforms.planeNormal,planeSize:uniforms.planeSize,depthMin:uniforms.depthMin,depthRange:uniforms.depthRange},
    vertexShader:`uniform vec3 planeOrigin; uniform vec3 planeRight; uniform vec3 planeUp; uniform vec2 planeSize; uniform vec3 planeNormal; uniform float depthMin; uniform float depthRange;
      varying float depthValue; varying float normalFacing;
      void main(){vec3 relative=position-planeOrigin;
        float x=0.5+dot(relative,planeRight)/planeSize.x;float y=0.5+dot(relative,planeUp)/planeSize.y;
        depthValue=(dot(relative,planeNormal)-depthMin)/depthRange;normalFacing=dot(normal,planeNormal);
        gl_Position=vec4(x*2.0-1.0,y*2.0-1.0,1.0-depthValue*2.0,1.0);}`,
    fragmentShader:`precision highp float; varying float depthValue; varying float normalFacing;
      void main(){
        if(normalFacing<=0.0)discard;
        float packed=floor(clamp(depthValue,0.0,1.0)*65535.0+0.5);
        float high=floor(packed/256.0);
        gl_FragColor=vec4(high/255.0,(packed-high*256.0)/255.0,0.0,1.0);
      }`,
    depthTest:true,depthWrite:true,side:THREE.DoubleSide,
  });
  const frontCaptureScene=new THREE.Scene();
  const frontCaptureCamera=new THREE.Camera();
  function captureFrontDepth(frame) {
    if (!model || !frame) return;
    const nextKey=JSON.stringify(frame);
    if (nextKey===depthKey) return;
    depthKey=nextKey;
    if (!frontDepthTarget) frontDepthTarget=new THREE.WebGLRenderTarget(2048,2048,{
      format:THREE.RGBAFormat,type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,
    });
    uniforms.planeOrigin.value.fromArray(frame.origin);
    uniforms.planeRight.value.fromArray(frame.right);
    uniforms.planeUp.value.fromArray(frame.up);
    uniforms.planeNormal.value.fromArray(frame.normal);
    uniforms.planeSize.value.set(frame.width,frame.height);
    uniforms.depthMin.value=frame.depthMin;
    uniforms.depthRange.value=frame.depthRange;
    model.traverse(child=>{if(child.isMesh){
      const captureMesh=new THREE.Mesh(child.geometry,frontCaptureMaterial);
      // The shader remaps raw position directly to clip space, so Three's CPU bounds are unrelated.
      captureMesh.frustumCulled=false;
      frontCaptureScene.add(captureMesh);
    }});
    const previousTarget=renderer.getRenderTarget(), previousColor=renderer.getClearColor(new THREE.Color()), previousAlpha=renderer.getClearAlpha();
    renderer.setRenderTarget(frontDepthTarget);renderer.setClearColor(0x000000,0);renderer.clear(true,true,true);
    renderer.render(frontCaptureScene,frontCaptureCamera);
    renderer.setRenderTarget(previousTarget);renderer.setClearColor(previousColor,previousAlpha);
    frontCaptureScene.clear();uniforms.frontDepth.value=frontDepthTarget.texture;
  }
  function releaseModel() {
    if (!model) return;
    model.traverse((child) => { if(child.isMesh) child.geometry.dispose(); });
    pivot.remove(model); model = null; modelBounds=null; hasModelUV=false;
    frontDepthTarget?.dispose();frontDepthTarget=null;depthKey=null;uniforms.frontDepth.value=null;
  }
  function loadModel(mesh) {
    if(mesh?.obj === meshKey) return;
    releaseModel(); meshKey = mesh?.obj ?? null;
    if(!mesh) return;
    const next = new OBJLoader().parse(mesh.obj);
    let count=0;
    hasModelUV=mesh.obj.split(/\r?\n/).filter(line=>/^\s*f\s/.test(line)).every(line=>line.split('#')[0].trim().split(/\s+/).slice(1).every(token=>/^-?\d+\/-?\d+(?:\/|$)/.test(token)));
    next.traverse((child) => {
      if(!child.isMesh) return;
      count += child.geometry.getAttribute('position').count;
      hasModelUV &&= child.geometry.hasAttribute('uv');
      if(!child.geometry.hasAttribute('normal')) child.geometry.computeVertexNormals();
      const originals=Array.isArray(child.material)?child.material:[child.material];
      originals.forEach((m)=>m.dispose()); child.material=material;
    });
    const box = new THREE.Box3().setFromObject(next);
    const size=box.getSize(new THREE.Vector3()), center=box.getCenter(new THREE.Vector3());
    if(!count || !Number.isFinite(size.length()) || Math.max(size.x,size.y,size.z)<=0){
      next.traverse(child=>{if(child.isMesh)child.geometry.dispose();});
      throw new RangeError('The OBJ has no usable surface geometry.');
    }
    modelBounds=box.clone();
    uniforms.uvAvailable.value=hasModelUV;
    uniforms.boundsMin.value.set(box.min.x,box.min.y);
    uniforms.boundsSize.value.set(Math.max(size.x,1e-9),Math.max(size.y,1e-9));
    const scale=2/Math.max(size.x,size.y,size.z);
    next.position.copy(center).multiplyScalar(-scale); next.scale.setScalar(scale);
    model=next; pivot.add(next);fit();
  }
  function applyImageSource() {
    const texture = videoSourceActive ? videoTexture : videoSourceRequired ? null : sourceTexture;
    uniforms.image.value=texture; uniforms.hasImage.value=Boolean(texture);
  }
  function updateSource(url) {
    if(url===textureKey) return;
    textureKey=url; const generation=++sourceGeneration;
    sourceTexture?.dispose(); sourceTexture=null;
    if(!videoSourceActive && !videoSourceRequired) applyImageSource();
    if(!url) return;
    new THREE.TextureLoader().load(url,(texture)=>{
      if(disposed || generation!==sourceGeneration){texture.dispose();return;}
      sourceTexture=texture; texture.colorSpace=THREE.SRGBColorSpace;
      if(!videoSourceActive && !videoSourceRequired) { applyImageSource(); draw(); }
    },undefined,()=>{if(generation===sourceGeneration && !videoSourceActive && !videoSourceRequired)onError(new Error('Reference image could not be decoded.'));});
  }
  function updateMapping(project) {
    const {grid,transform,mask}=project.placement;
    uniforms.useModelUV.value=project.placement.mappingMode==='uv';
    uniforms.useSurface.value=project.placement.mappingMode==='surface';
    uniforms.surfacePlaced.value=Boolean(project.placement.surface);
    if (model && modelBounds && project.placement.mappingMode !== 'uv') {
      const min=modelBounds.min,max=modelBounds.max;
      const frame=project.placement.mappingMode==='surface'
        ? project.placement.surface && surfaceProjectionFrame(project.placement.surface,
          {min:min.toArray(),max:max.toArray()})
        : {origin:[(min.x+max.x)/2,(min.y+max.y)/2,min.z],right:[1,0,0],up:[0,1,0],normal:[0,0,1],
          width:Math.max(max.x-min.x,1e-9),height:Math.max(max.y-min.y,1e-9),depthMin:0,depthRange:Math.max(max.z-min.z,1e-9)};
      if (frame) captureFrontDepth(frame);
    }
    const values=new Float32Array(grid.points.length*4);
    grid.points.forEach((point,i)=>{values[i*4]=point.u;values[i*4+1]=point.v;values[i*4+3]=1;});
    gridTexture?.dispose();
    gridTexture=new THREE.DataTexture(values,grid.columns,grid.rows,THREE.RGBAFormat,THREE.FloatType);
    gridTexture.minFilter=gridTexture.magFilter=THREE.NearestFilter; gridTexture.needsUpdate=true;
    uniforms.grid.value=gridTexture; uniforms.gridSize.value.set(grid.columns,grid.rows);
    uniforms.translation.value.set(transform.x,transform.y);uniforms.imageScale.value=transform.scale;
    uniforms.angle.value=THREE.MathUtils.degToRad(transform.rotation);
    maskContext.fillStyle=mask.some(p=>!p.excluded)?'#000':'#fff'; maskContext.fillRect(0,0,1024,1024);
    for(const polygon of [...mask.filter(p=>!p.excluded),...mask.filter(p=>p.excluded)]){
      maskContext.beginPath(); polygon.points.forEach(({u,v},i)=>maskContext[i?'lineTo':'moveTo'](u*1024,v*1024));
      maskContext.closePath();maskContext.fillStyle=polygon.excluded?'#000':'#fff';maskContext.fill();
    }
    maskTexture.needsUpdate=true;
    const pose=project.projector.model;
    pivot.position.fromArray(pose.position);pivot.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad));pivot.scale.setScalar(pose.scale);
  }
  // Raycast returns coordinates in the same original-model XY domain as the shader.
  function domainOf(point) {
    const local=model.worldToLocal(point.clone());
    return {u:THREE.MathUtils.clamp((local.x-modelBounds.min.x)/uniforms.boundsSize.value.x,0,1),
      v:THREE.MathUtils.clamp(1-(local.y-modelBounds.min.y)/uniforms.boundsSize.value.y,0,1)};
  }
  function pick(clientX,clientY) {
    if(!model) return null;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const rect=canvas.getBoundingClientRect();
    const ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2),camera);
    const hit=ray.intersectObject(model,true)[0];
    return hit ? domainOf(hit.point) : null;
  }
  function pickSurface(clientX,clientY,previous=null) {
    if (!model || mode!=='placement') return null;
    scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    const rect=canvas.getBoundingClientRect();
    const ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2),camera);
    const hit=ray.intersectObject(model,true)[0];
    if (!hit?.normal && !hit?.face?.normal) return null;
    const point=model.worldToLocal(hit.point.clone());
    const childToModel=new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(hit.object.matrixWorld);
    const normal=(hit.normal??hit.face.normal).clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(childToModel)).normalize();
    return surfaceFromHit(point.toArray(),normal.toArray(),previous);
  }
  function projectSurfacePosition(position) {
    if (!model || !Array.isArray(position)) return null;
    scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    const projected=model.localToWorld(new THREE.Vector3().fromArray(position)).project(camera);
    if(projected.z < -1 || projected.z > 1) return null;
    return {x:(projected.x+1)*canvas.clientWidth/2,y:(1-projected.y)*canvas.clientHeight/2};
  }
  function zoomAt(clientX,clientY,factor) {
    if(disposed || projection || mode!=='placement' || !model || !Number.isFinite(factor) || factor<=0) return false;
    const rect=canvas.getBoundingClientRect();
    if(!rect.width || !rect.height) return false;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const ndcX=(clientX-rect.left)/rect.width*2-1, ndcY=1-(clientY-rect.top)/rect.height*2;
    const raycaster=new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX,ndcY),camera);
    const hit=raycaster.intersectObject(model,true)[0];
    let anchor=hit?.point.clone()??null;
    if(!anchor){
      const normal=camera.getWorldDirection(new THREE.Vector3());
      const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,controls.target);
      anchor=raycaster.ray.intersectPlane(plane,new THREE.Vector3());
    }
    if(!anchor) return false;
    const targetZoom=THREE.MathUtils.clamp(camera.zoom*factor,MIN_MODEL_ZOOM,MAX_MODEL_ZOOM);
    if(targetZoom===camera.zoom) return false;
    const screenAnchor=anchor.clone().project(camera);
    zoomCameraAtPoint(camera,controls,anchor,screenAnchor.x,screenAnchor.y,targetZoom);
    draw();
    return true;
  }
  function beginPan(clientX,clientY) {
    if(disposed || projection || mode!=='placement' || !model) return false;
    const rect=canvas.getBoundingClientRect();
    if(!rect.width || !rect.height) return false;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const ndc=new THREE.Vector2((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2);
    const raycaster=new THREE.Raycaster();
    raycaster.setFromCamera(ndc,camera);
    const hit=raycaster.intersectObject(model,true)[0];
    let anchor=hit?.point.clone()??null;
    if(!anchor){
      const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()),controls.target);
      anchor=raycaster.ray.intersectPlane(plane,new THREE.Vector3());
    }
    panDepth=anchor?Math.max(1e-9,-camera.worldToLocal(anchor.clone()).z):camera.position.distanceTo(controls.target);
    return true;
  }
  function panBy(deltaX,deltaY,width,height) {
    if(disposed || projection || mode!=='placement' || !model || ![deltaX,deltaY,width,height].every(Number.isFinite) || width<=0 || height<=0) return false;
    panCameraByPixels(camera,controls,deltaX,deltaY,width,height,panDepth);
    draw();
    return true;
  }
  function endPan() { panDepth=null; }
  function projectDomain(point) {
    if(!model || !modelBounds) return null;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const origin=new THREE.Vector3(modelBounds.min.x+point.u*uniforms.boundsSize.value.x,
      modelBounds.min.y+(1-point.v)*uniforms.boundsSize.value.y,modelBounds.max.z+Math.max(1,modelBounds.max.z-modelBounds.min.z));
    model.localToWorld(origin);
    const direction=new THREE.Vector3(0,0,-1).transformDirection(model.matrixWorld);
    const hit=new THREE.Raycaster(origin,direction).intersectObject(model,true)[0];
    if(!hit) return null;
    const projected=hit.point.clone().project(camera);
    return {x:(projected.x+1)*canvas.clientWidth/2,y:(1-projected.y)*canvas.clientHeight/2};
  }
  function projectDomainNormalized(point) {
    if(!model || !modelBounds || !point || !Number.isFinite(point.u) || !Number.isFinite(point.v)
      || point.u<0 || point.u>1 || point.v<0 || point.v>1) return null;
    updateCamera(); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const origin=new THREE.Vector3(modelBounds.min.x+point.u*uniforms.boundsSize.value.x,
      modelBounds.min.y+(1-point.v)*uniforms.boundsSize.value.y,modelBounds.max.z+Math.max(1,modelBounds.max.z-modelBounds.min.z));
    model.localToWorld(origin);
    const direction=new THREE.Vector3(0,0,-1).transformDirection(model.matrixWorld);
    const hit=new THREE.Raycaster(origin,direction).intersectObject(model,true)[0];
    if(!hit) return null;
    const projected=hit.point.clone().project(camera);
    if(projected.z < -1 || projected.z > 1 || projected.x < -1 || projected.x > 1 || projected.y < -1 || projected.y > 1) return null;
    return {u:(projected.x+1)/2,v:(1-projected.y)/2};
  }
  function updateCamera() {
    controls.enabled=navigation&&mode==='placement';
    if(mode==='projector'&&snapshot){
      camera.zoom=1;
      const p=snapshot.project.projector;
      camera.position.fromArray(p.position);camera.rotation.set(...p.rotation.map(THREE.MathUtils.degToRad));camera.fov=p.fov;
    }
    const width=mode==='projector'&&snapshot?snapshot.project.output.width:Math.max(1,canvas.clientWidth),height=mode==='projector'&&snapshot?snapshot.project.output.height:Math.max(1,canvas.clientHeight);
    camera.aspect=width/height;camera.clearViewOffset();
    if(mode==='projector'&&snapshot){
      const [x,y]=snapshot.project.projector.offset;
      camera.setViewOffset(width,height,-x*width,-y*height,width,height);
    }
    camera.updateProjectionMatrix();
  }
  function draw() {
    if(disposed)return;
    updateCamera();
    const calibration = snapshot?.project?.projector?.calibration?.grid;
    const activeWarp = mode === 'projector' && !calibrationEditing && Boolean(calibration);
    if(projectionWarp) {
      const drawingBufferSize=renderer.getDrawingBufferSize(new THREE.Vector2());
      const width=drawingBufferSize.x, height=drawingBufferSize.y;
      projectionWarp.setGrid(activeWarp ? calibration : null);
      projectionWarp.render(scene,camera,width,height,activeWarp);
    } else renderer.render(scene,camera);
  }
  function resize() {renderer.setSize(projection&&snapshot?snapshot.project.output.width:Math.max(1,canvas.clientWidth),projection&&snapshot?snapshot.project.output.height:Math.max(1,canvas.clientHeight),false);draw();}
  function fit(){camera.zoom=1;camera.position.set(0,0,3.5);camera.fov=45;controls.target.set(0,0,0);controls.update();draw();}
  controls.addEventListener('change',draw);
  const observer=new ResizeObserver(resize);observer.observe(canvas);
  return {
    setSnapshot(value){snapshot=value;loadModel(value.project.mesh);updateSource(value.referencePreview);updateMapping(value.project);if(projection)resize();else draw();},
    setVideoFrame(video){
      const width=video?.videoWidth||video?.displayWidth||video?.width||0;
      const height=video?.videoHeight||video?.displayHeight||video?.height||0;
      if(disposed || !video || width<=0 || height<=0) return;
      if(!videoCanvas){videoCanvas=document.createElement('canvas');videoContext=videoCanvas.getContext('2d',{alpha:false});}
      if(videoCanvas.width!==width || videoCanvas.height!==height){videoCanvas.width=width;videoCanvas.height=height;}
      videoContext.drawImage(video,0,0,videoCanvas.width,videoCanvas.height);
      if(!videoTexture){videoTexture=new THREE.CanvasTexture(videoCanvas);videoTexture.colorSpace=THREE.SRGBColorSpace;videoTexture.minFilter=THREE.LinearFilter;videoTexture.magFilter=THREE.LinearFilter;}
      videoTexture.needsUpdate=true;videoSourceActive=true;applyImageSource();draw();
    },
    setVideoSourceRequired(value){videoSourceRequired=Boolean(value);applyImageSource();draw();},
    clearVideoSource(){if(!videoSourceActive)return;videoSourceActive=false;applyImageSource();draw();},
    setMode(value){if(value===mode)return;mode=value;if(mode==='placement')fit();else draw();},
    setWireframe(value){wireframe=value;material.wireframe=wireframe;draw();},
    setNavigation(value){navigation=value;controls.enabled=value&&mode==='placement';},
    setCalibrationEditing(value){calibrationEditing=Boolean(value);draw();},
    pick, pickSurface, projectSurfacePosition, projectDomain, projectDomainNormalized, zoomAt, beginPan, panBy, endPan,
    hasUV(){return hasModelUV;},
    setTextureOpacity(value){uniforms.textureOpacity.value=Math.max(0,Math.min(1,Number(value)));draw();},
    previewPlacement(placement){if(snapshot){updateMapping({...snapshot.project,placement});draw();}},
    clearPreview(){if(snapshot){updateMapping(snapshot.project);draw();}},
    fit,
    destroy(){disposed=true;sourceGeneration++;observer.disconnect();controls.dispose();releaseModel();sourceTexture?.dispose();videoTexture?.dispose();gridTexture?.dispose();maskTexture.dispose();frontCaptureMaterial.dispose();material.dispose();projectionWarp?.destroy();renderer.dispose();},
  };
}

/** Set perspective zoom while translating the view so a world point stays under the same cursor. */
export function zoomCameraAtPoint(camera,controls,worldPoint,ndcX,ndcY,requestedZoom) {
  camera.zoom=THREE.MathUtils.clamp(requestedZoom,MIN_MODEL_ZOOM,MAX_MODEL_ZOOM);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const projected=worldPoint.clone().project(camera);
  const local=camera.worldToLocal(worldPoint.clone());
  const distance=Math.max(1e-9,-local.z);
  const focal=camera.zoom/Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
  const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0);
  const up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
  const shift=right.multiplyScalar((projected.x-ndcX)*distance*camera.aspect/focal)
    .add(up.multiplyScalar((projected.y-ndcY)*distance/focal));
  camera.position.add(shift);
  controls.target.add(shift);
  controls.update();
  camera.updateMatrixWorld(true);
  return camera.zoom;
}

/** Pan the view by CSS-pixel deltas at the controls target's depth. */
export function panCameraByPixels(camera,controls,deltaX,deltaY,width,height,anchorDepth=null) {
  const distance=Number.isFinite(anchorDepth)&&anchorDepth>0?anchorDepth:camera.position.distanceTo(controls.target);
  const visibleHeight=2*distance*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)/camera.zoom;
  const worldPerPixelX=visibleHeight*camera.aspect/width;
  const worldPerPixelY=visibleHeight/height;
  const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0);
  const up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
  const shift=right.multiplyScalar(-deltaX*worldPerPixelX).add(up.multiplyScalar(deltaY*worldPerPixelY));
  camera.position.add(shift);
  controls.target.add(shift);
  controls.update();
  camera.updateMatrixWorld(true);
}
