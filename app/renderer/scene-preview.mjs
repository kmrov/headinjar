import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createProjectionWarp } from './projection-warp.mjs';

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
  let textureKey = null, sourceTexture = null, videoTexture = null, videoCanvas = null, videoContext = null, videoSourceActive = false, gridTexture = null, frontDepthTarget = null;
  let sourceGeneration = 0, disposed = false, hasModelUV = false, modelBounds = null;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = 1024;
  const maskContext = maskCanvas.getContext('2d');
  const maskTexture = new THREE.CanvasTexture(maskCanvas);
  const uniforms = {
    image: {value:null}, grid: {value:null}, coverage:{value:maskTexture}, frontDepth:{value:null}, hasImage:{value:false},
    gridSize:{value:new THREE.Vector2(5,5)}, boundsMin:{value:new THREE.Vector2()},
    boundsSize:{value:new THREE.Vector2(1,1)}, boundsDepth:{value:new THREE.Vector2()}, translation:{value:new THREE.Vector2()},
    imageScale:{value:1}, angle:{value:0}, textureOpacity:{value:1}, useModelUV:{value:false}, uvAvailable:{value:false},
  };
  const material = new THREE.ShaderMaterial({
    defines: projection ? { PROJECTION_OUTPUT: 1 } : {},
    uniforms, side:THREE.FrontSide,
    vertexShader:`varying vec3 surfaceNormal; varying vec2 modelUV; varying vec2 domain; varying float modelDepth; varying float modelNormalZ; uniform vec2 boundsMin; uniform vec2 boundsSize; uniform vec2 boundsDepth;
      void main(){modelUV=uv;surfaceNormal=normalize(normalMatrix*normal);modelNormalZ=normal.z;domain=vec2((position.x-boundsMin.x)/boundsSize.x,1.0-(position.y-boundsMin.y)/boundsSize.y);modelDepth=(position.z-boundsDepth.x)/boundsDepth.y;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`precision highp float;
      varying vec3 surfaceNormal; varying vec2 modelUV; varying vec2 domain; varying float modelDepth; varying float modelNormalZ; uniform sampler2D image; uniform sampler2D grid; uniform sampler2D coverage; uniform sampler2D frontDepth;
      uniform vec2 gridSize; uniform vec2 translation; uniform float imageScale; uniform float angle; uniform bool hasImage; uniform bool useModelUV; uniform bool uvAvailable; uniform float textureOpacity;
      const float FRONT_DEPTH_EPSILON=0.004;
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
        if(hasImage && !useModelUV){vec4 front=texture2D(frontDepth,vec2(domain.x,1.0-domain.y));
          if(modelNormalZ<=0.0 || front.a<0.5 || modelDepth<front.r-FRONT_DEPTH_EPSILON){
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
    uniforms:{boundsMin:{value:uniforms.boundsMin.value},boundsSize:{value:uniforms.boundsSize.value},boundsDepth:{value:uniforms.boundsDepth.value}},
    vertexShader:`uniform vec2 boundsMin; uniform vec2 boundsSize; uniform vec2 boundsDepth; varying float depthValue;
      void main(){float x=(position.x-boundsMin.x)/boundsSize.x;float y=(position.y-boundsMin.y)/boundsSize.y;
        depthValue=(position.z-boundsDepth.x)/boundsDepth.y;gl_Position=vec4(x*2.0-1.0,y*2.0-1.0,1.0-depthValue*2.0,1.0);}`,
    fragmentShader:`precision highp float; varying float depthValue; void main(){gl_FragColor=vec4(depthValue,0.0,0.0,1.0);}`,
    depthTest:true,depthWrite:true,
  });
  const frontCaptureScene=new THREE.Scene();
  const frontCaptureCamera=new THREE.Camera();
  function captureFrontDepth(source) {
    frontDepthTarget?.dispose();
    frontDepthTarget=new THREE.WebGLRenderTarget(2048,2048,{
      format:THREE.RGBAFormat,type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,
    });
    source.traverse(child=>{if(child.isMesh){
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
    frontDepthTarget?.dispose();frontDepthTarget=null;uniforms.frontDepth.value=null;
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
    uniforms.boundsDepth.value.set(box.min.z,Math.max(size.z,1e-9));
    const scale=2/Math.max(size.x,size.y,size.z);
    next.position.copy(center).multiplyScalar(-scale); next.scale.setScalar(scale);
    model=next; pivot.add(next);captureFrontDepth(next);fit();
  }
  function applyImageSource() {
    const texture = videoSourceActive ? videoTexture : sourceTexture;
    uniforms.image.value=texture; uniforms.hasImage.value=Boolean(texture);
  }
  function updateSource(url) {
    if(url===textureKey) return;
    textureKey=url; const generation=++sourceGeneration;
    sourceTexture?.dispose(); sourceTexture=null;
    if(!videoSourceActive) applyImageSource();
    if(!url) return;
    new THREE.TextureLoader().load(url,(texture)=>{
      if(disposed || generation!==sourceGeneration){texture.dispose();return;}
      sourceTexture=texture; texture.colorSpace=THREE.SRGBColorSpace;
      if(!videoSourceActive) { applyImageSource(); draw(); }
    },undefined,()=>{if(generation===sourceGeneration && !videoSourceActive)onError(new Error('Reference image could not be decoded.'));});
  }
  function updateMapping(project) {
    const {grid,transform,mask}=project.placement;
    uniforms.useModelUV.value=project.placement.mappingMode==='uv';
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
  function fit(){camera.position.set(0,0,3.5);camera.fov=45;controls.target.set(0,0,0);controls.update();draw();}
  controls.addEventListener('change',draw);
  const observer=new ResizeObserver(resize);observer.observe(canvas);
  return {
    setSnapshot(value){snapshot=value;loadModel(value.project.mesh);updateSource(value.referencePreview);updateMapping(value.project);if(projection)resize();else draw();},
    setVideoFrame(video){
      if(disposed || !video || video.videoWidth<=0 || video.videoHeight<=0) return;
      if(!videoCanvas){videoCanvas=document.createElement('canvas');videoContext=videoCanvas.getContext('2d',{alpha:false});}
      if(videoCanvas.width!==video.videoWidth || videoCanvas.height!==video.videoHeight){videoCanvas.width=video.videoWidth;videoCanvas.height=video.videoHeight;}
      videoContext.drawImage(video,0,0,videoCanvas.width,videoCanvas.height);
      if(!videoTexture){videoTexture=new THREE.CanvasTexture(videoCanvas);videoTexture.colorSpace=THREE.SRGBColorSpace;videoTexture.minFilter=THREE.LinearFilter;videoTexture.magFilter=THREE.LinearFilter;}
      videoTexture.needsUpdate=true;videoSourceActive=true;applyImageSource();draw();
    },
    clearVideoSource(){if(!videoSourceActive)return;videoSourceActive=false;applyImageSource();draw();},
    setMode(value){if(value===mode)return;mode=value;if(mode==='placement')fit();else draw();},
    setWireframe(value){wireframe=value;material.wireframe=wireframe;draw();},
    setNavigation(value){navigation=value;controls.enabled=value&&mode==='placement';},
    setCalibrationEditing(value){calibrationEditing=Boolean(value);draw();},
    pick, projectDomain, projectDomainNormalized,
    hasUV(){return hasModelUV;},
    setTextureOpacity(value){uniforms.textureOpacity.value=Math.max(0,Math.min(1,Number(value)));draw();},
    previewPlacement(placement){if(snapshot){updateMapping({...snapshot.project,placement});draw();}},
    clearPreview(){if(snapshot){updateMapping(snapshot.project);draw();}},
    fit,
    destroy(){disposed=true;sourceGeneration++;observer.disconnect();controls.dispose();releaseModel();sourceTexture?.dispose();videoTexture?.dispose();gridTexture?.dispose();maskTexture.dispose();frontCaptureMaterial.dispose();material.dispose();projectionWarp?.destroy();renderer.dispose();},
  };
}
