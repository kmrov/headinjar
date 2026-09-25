import { createScenePreview } from './scene-preview.mjs';
import { moveGridPoint } from '../src/mapping/grid.mjs';
import { fitLandmarkGrid } from '../src/mapping/alignment.mjs';

export function createViewport(host, callbacks={}) {
  host.style.position='relative';host.style.overflow='hidden';
  const empty=document.createElement('div');empty.textContent='Import an OBJ to preview your model';
  Object.assign(empty.style,{position:'absolute',inset:'0',display:'grid',placeItems:'center',color:'#88948e',fontSize:'14px',pointerEvents:'none'});
  const canvas=document.createElement('canvas');
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'none'});
  const overlay=document.createElement('canvas');
  Object.assign(overlay.style,{position:'absolute',inset:'0',width:'100%',height:'100%',touchAction:'none',pointerEvents:'none'});
  const label=document.createElement('span');
  Object.assign(label.style,{position:'absolute',bottom:'68px',left:'24px',fontSize:'11px',letterSpacing:'.08em',textTransform:'uppercase',color:'#a8b2af',pointerEvents:'none'});
  const hint=document.createElement('span');
  Object.assign(hint.style,{position:'absolute',bottom:'68px',right:'24px',fontSize:'11px',color:'#88948e',pointerEvents:'none'});
  host.append(empty,canvas,overlay,label,hint);
  const context=overlay.getContext('2d');
  let snapshot=null,tool='move',mode='placement',showGrid=true,selected=null,drag=null,maskPoints=[],maskExcluded=false,scene=null;
  let alignmentSelection=null, alignmentDrag=null, alignmentPan=null, previewPairs=null, previewGrid=null, textureOpacity=1, uvWarning=false;
  let physical={active:false,picking:false,pairs:[],selected:null},physicalDrag=null;
  host.tabIndex=0;
  function physicalUV(event){const b=canvas.getBoundingClientRect();return {u:Math.max(0,Math.min(1,(event.clientX-b.left)/b.width)),v:Math.max(0,Math.min(1,(event.clientY-b.top)/b.height))};}
  function rect(){const size=Math.max(100,Math.min(240,host.clientWidth-80,host.clientHeight-150));return {x:host.clientWidth-size-36,y:66,w:size,h:size};}
  function xy(point){const r=rect();return {x:r.x+point.u*r.w,y:r.y+point.v*r.h};}
  function uv(event){const box=overlay.getBoundingClientRect(),r=rect();return {u:(event.clientX-box.left-r.x)/r.w,v:(event.clientY-box.top-r.y)/r.h};}
  function draw(){
    const w=host.clientWidth,h=host.clientHeight,dpr=devicePixelRatio||1;
    if(mode==='projector'&&snapshot){
      const aspect=snapshot.project.output.width/snapshot.project.output.height;
      const width=Math.min(w,h*aspect),height=width/aspect;
      Object.assign(canvas.style,{inset:'auto',left:`${(w-width)/2}px`,top:`${(h-height)/2}px`,width:`${width}px`,height:`${height}px`});
    }else Object.assign(canvas.style,{inset:'0',left:'0',top:'0',width:'100%',height:'100%'});
    overlay.width=Math.max(1,w*dpr);overlay.height=Math.max(1,h*dpr);context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
    const hasMesh=Boolean(snapshot?.project.mesh);
    label.textContent=hasMesh?'OBJ preview · normalized fit':'No model loaded';
    label.style.display=tool==='align'?'none':'';
    hint.textContent=!hasMesh?'':mode==='projector'?'Projection preview':tool==='align'?'Pick image points · wheel zoom · middle-drag pan · drag markers':tool==='grid'?'Image warp grid · drag a point':tool==='mask'?'Click outline · double-click to finish':'Drag to orbit · scroll to zoom';
    if(mode==='projector'&&physical.active){
      label.textContent='Projector preview';
      hint.textContent=physical.picking?'Click a point on the model':'Drag points to match the real surface';
      const b=canvas.getBoundingClientRect(),hostBox=host.getBoundingClientRect();
      const at=p=>({x:b.left-hostBox.left+p.u*b.width,y:b.top-hostBox.top+p.v*b.height});
      physical.pairs.forEach((pair,index)=>{
        const s=at(pair.source),t=at(pair.target);
        context.strokeStyle='#77baff';context.lineWidth=1;context.beginPath();context.moveTo(s.x,s.y);context.lineTo(t.x,t.y);context.stroke();
        context.beginPath();context.arc(s.x,s.y,4,0,Math.PI*2);context.fillStyle='#77baff';context.fill();
        context.strokeStyle=index===physical.selected?'#fff070':'#ffb955';context.lineWidth=index===physical.selected?3:1.5;
        context.beginPath();context.arc(t.x,t.y,9,0,Math.PI*2);context.moveTo(t.x-14,t.y);context.lineTo(t.x+14,t.y);context.moveTo(t.x,t.y-14);context.lineTo(t.x,t.y+14);context.stroke();
        context.font='bold 12px Inter, sans-serif';context.fillStyle='#fff070';context.fillText(String(index+1),t.x+14,t.y-12);
      });
    }
    if(!snapshot || mode!=='placement'||tool==='move')return;
    if(tool==='align') {
      const pairs=previewPairs??snapshot.project.placement.alignment?.pairs??[];
      pairs.forEach((pair,index)=>{
        const p=scene?.projectDomain(pair.target); if(!p)return;
        context.beginPath();context.arc(p.x,p.y,10,0,Math.PI*2);
        context.fillStyle=index===alignmentSelection?'#f2faf5':'#afe4c9';context.fill();
        context.strokeStyle='#12251d';context.lineWidth=2;context.stroke();
        context.fillStyle='#12251d';context.font='bold 11px Inter, sans-serif';context.textAlign='center';context.textBaseline='middle';
        context.fillText(String(index+1),p.x,p.y);context.textAlign='start';context.textBaseline='alphabetic';
      });
      return;
    }
    const r=rect();
    context.fillStyle='#151b1c';context.fillRect(r.x-18,r.y-42,r.w+36,r.h+62);
    context.strokeStyle='#52645c';context.strokeRect(r.x-18,r.y-42,r.w+36,r.h+62);
    context.fillStyle='#b8dace';context.font='12px Inter, sans-serif';context.fillText(tool==='mask'?'Coverage domain · 2D':'Source coordinates · 2D',r.x,r.y-20);
    context.strokeStyle='#596b63';context.strokeRect(r.x,r.y,r.w,r.h);
    const {mask}=snapshot.project.placement;
    const grid=previewGrid??snapshot.project.placement.grid;
    if(showGrid){
      const points=grid.points.map(xy);
      context.strokeStyle='rgba(169,226,197,.52)';context.lineWidth=1;
      for(let row=0;row<grid.rows;row++)for(let col=0;col<grid.columns;col++){
        const i=row*grid.columns+col,p=points[i];
        for(const j of [col+1<grid.columns?i+1:-1,row+1<grid.rows?i+grid.columns:-1])if(j>=0){
          context.beginPath();context.moveTo(p.x,p.y);context.lineTo(points[j].x,points[j].y);context.stroke();
        }
        context.beginPath();context.arc(p.x,p.y,i===selected?5:3,0,Math.PI*2);context.fillStyle=i===selected?'#fff':'#afe4c9';context.fill();
      }
    }
    for(const polygon of [...mask,{points:maskPoints,excluded:maskExcluded}]){
      if(!polygon.points.length)continue;
      context.beginPath();polygon.points.map(xy).forEach((p,i)=>context[i?'lineTo':'moveTo'](p.x,p.y));
      if(polygon.points.length>=3)context.closePath();
      context.strokeStyle=polygon.excluded?'#f29b92':'#b4e5cc';context.lineWidth=2;context.stroke();
    }
  }
  function updateInput(){overlay.style.pointerEvents=mode==='placement'&&tool!=='move'||mode==='projector'&&physical.active?'auto':'none';scene?.setNavigation(tool==='move'&&!physical.active);draw();}
  function clearPreview() {previewPairs=null;previewGrid=null;scene?.clearPreview();draw();}
  function report(error){callbacks.onError?.(error);}
  function endAlignmentPan(){if(!alignmentPan)return;alignmentPan=null;scene?.endPan();}
  overlay.addEventListener('wheel',(event)=>{
    if(mode!=='placement'||tool!=='align')return;
    event.preventDefault();
    const multiplier=event.deltaMode===1?16:event.deltaMode===2?host.clientHeight:1;
    scene?.zoomAt(event.clientX,event.clientY,Math.exp(-event.deltaY*multiplier*0.0015));
    draw();
  },{passive:false});
  overlay.addEventListener('contextmenu',(event)=>{if(mode==='placement'&&tool==='align')event.preventDefault();});
  overlay.addEventListener('pointerdown',(event)=>{
    if(snapshot&&mode==='projector'&&physical.active){
      event.preventDefault();host.focus({preventScroll:true});
      const b=canvas.getBoundingClientRect();
      if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)return;
      if(physical.picking){if(scene?.pick(event.clientX,event.clientY))Promise.resolve(callbacks.onPhysicalSource?.(physicalUV(event))).catch(report);return;}
      const nearest=physical.pairs.map((pair,index)=>({index,d:Math.hypot(b.left+pair.target.u*b.width-event.clientX,b.top+pair.target.v*b.height-event.clientY)})).sort((a,b)=>a.d-b.d)[0];
      if(nearest?.d<20){physicalDrag={index:nearest.index,point:null};callbacks.onPhysicalSelect?.(nearest.index);overlay.setPointerCapture(event.pointerId);}
      return;
    }
    if(!snapshot || mode!=='placement')return;
    if(tool==='align') {
      if(event.button===1){
        event.preventDefault();host.focus({preventScroll:true});
        if(snapshot.project.mesh&&scene?.beginPan(event.clientX,event.clientY)){
          alignmentPan={x:event.clientX,y:event.clientY};overlay.setPointerCapture(event.pointerId);
        }
        return;
      }
      if(event.button!==0)return;
      const source=snapshot.source;
      const hasSource=source?.kind==='webrtc'
        ? source.status==='running' && source.width>0 && source.height>0
        : Boolean(snapshot.referencePreview);
      if(!hasSource || !snapshot.project.mesh)return;
      const box=overlay.getBoundingClientRect();
      const pairs=snapshot.project.placement.alignment?.pairs??[];
      const nearest=pairs.map((pair,index)=>({index,p:scene?.projectDomain(pair.target)}))
        .filter(item=>item.p).map(item=>({...item,d:Math.hypot(item.p.x-event.clientX+box.left,item.p.y-event.clientY+box.top)})).sort((a,b)=>a.d-b.d)[0];
      if(nearest?.d<16){
        alignmentSelection=nearest.index;alignmentDrag={index:nearest.index,point:null,moved:false};
        callbacks.onAlignmentSelection?.(nearest.index);overlay.setPointerCapture(event.pointerId);draw();
      }else {
        const point=scene?.pick(event.clientX,event.clientY);
        if(point)Promise.resolve(callbacks.onAlignmentTarget?.(point)).catch(report);
      }
      return;
    }
    if(tool!=='grid')return;
    const box=overlay.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
    const nearest=snapshot.project.placement.grid.points.map((p,index)=>({index,d:Math.hypot(xy(p).x-x,xy(p).y-y)})).sort((a,b)=>a.d-b.d)[0];
    if(nearest.d>18)return; selected=nearest.index;drag=nearest.index;overlay.setPointerCapture(event.pointerId);callbacks.onSelection?.(selected);draw();
  });
  overlay.addEventListener('pointermove',(event)=>{
    if(physicalDrag){physicalDrag.point=physicalUV(event);callbacks.onPhysicalDrag?.(physicalDrag.index,physicalDrag.point,false);return;}
    if(alignmentPan){
      const dx=event.clientX-alignmentPan.x,dy=event.clientY-alignmentPan.y;
      alignmentPan={x:event.clientX,y:event.clientY};
      scene?.panBy(dx,dy,host.clientWidth,host.clientHeight);draw();return;
    }
    if(alignmentDrag){
      const point=scene?.pick(event.clientX,event.clientY);if(!point)return;
      alignmentDrag.point=point;alignmentDrag.moved=true;
      Promise.resolve(callbacks.onAlignmentDrag?.(alignmentDrag.index,point,false)).catch(report);
    }else if(drag!==null){
      try{previewGrid=moveGridPoint(snapshot.project.placement.grid,drag,uv(event));
        scene?.previewPlacement({...snapshot.project.placement,grid:previewGrid});draw();
      }catch{ /* Keep the last valid preview; final release reports a rejected fold. */ }
    }
  });
  overlay.addEventListener('pointerup',(event)=>{
    if(physicalDrag){const current=physicalDrag;physicalDrag=null;if(current.point)Promise.resolve(callbacks.onPhysicalDrag?.(current.index,current.point,true)).catch(report);return;}
    if(alignmentPan){endAlignmentPan();return;}
    if(alignmentDrag){
      const current=alignmentDrag;alignmentDrag=null;
      if(current.moved&&current.point){
        Promise.resolve(callbacks.onAlignmentDrag?.(current.index,current.point,true)).catch(report).finally(clearPreview);
      }else clearPreview();
      return;
    }
    if(drag===null)return;const index=drag;drag=null;
    Promise.resolve(callbacks.onGridPoint?.(index,uv(event))).catch(report).finally(clearPreview);
  });
  overlay.addEventListener('pointercancel',()=>{physicalDrag=null;endAlignmentPan();callbacks.onPhysicalCancel?.();drag=null;alignmentDrag=null;clearPreview();});
  overlay.addEventListener('lostpointercapture',endAlignmentPan);
  overlay.addEventListener('click',(event)=>{
    if(mode!=='placement'||tool!=='mask'||!snapshot||event.detail>1)return;
    const point=uv(event);if(point.u<0||point.u>1||point.v<0||point.v>1)return;maskPoints.push({u:Math.max(0,Math.min(1,point.u)),v:Math.max(0,Math.min(1,point.v))});draw();
  });
  overlay.addEventListener('dblclick',(event)=>{
    const point=uv(event);if(point.u<0||point.u>1||point.v<0||point.v>1)return;
    if(mode!=='placement'||tool!=='mask'||maskPoints.length<3)return;
    const polygons=[...snapshot.project.placement.mask,{excluded:maskExcluded,points:maskPoints}];maskPoints=[];
    Promise.resolve(callbacks.onMask?.(polygons)).catch(callbacks.onError);draw();
  });
  const observer=new ResizeObserver(draw);observer.observe(host);
  return {
    setSnapshot(value){
      if(snapshot?.project.id!==value.project.id || snapshot?.project.revision!==value.project.revision){
        drag=null;alignmentDrag=null;
      }
      snapshot=value;previewPairs=null;previewGrid=null;
      const hasMesh=Boolean(value.project.mesh);empty.style.display=hasMesh?'none':'grid';canvas.style.display=hasMesh?'block':'none';
      if(hasMesh){
        try{scene??=createScenePreview(canvas,callbacks.onError??(()=>{}));scene.setVideoSourceRequired(value.source?.kind==='webrtc');scene.setSnapshot(value);scene.setMode(mode);scene.setTextureOpacity(textureOpacity);
          if(value.project.placement.mappingMode==='uv'&&!scene.hasUV()){if(!uvWarning)report(new Error('This OBJ has no complete UV coordinates. Choose Front mapping.'));uvWarning=true;}else uvWarning=false;}
        catch(error){callbacks.onError?.(error);}
      }else if(scene){scene.setVideoSourceRequired(value.source?.kind==='webrtc');scene.setSnapshot(value);}
      updateInput();
    },
    setMaskExcluded(value){maskExcluded=Boolean(value);maskPoints=[];draw();},
    setTool(value){endAlignmentPan();tool=value;maskPoints=[];drag=null;alignmentDrag=null;clearPreview();if(tool==='align')scene?.fit();updateInput();},
    setMode(value){endAlignmentPan();mode=value;scene?.setMode(value);updateInput();},
    setPhysicalCalibration(value){physical=value;scene?.setCalibrationEditing(value.active);updateInput();},
    getPhysicalLandmarks(){return (snapshot?.project.placement.alignment?.pairs??[]).map(pair=>scene?.projectDomainNormalized(pair.target)).filter(Boolean);},
    setWireframe(value){scene?.setWireframe(value);},
    setGridVisibility(value){showGrid=value;draw();},
    setAlignmentSelection(index){alignmentSelection=index;draw();},
    setTextureOpacity(value){textureOpacity=value;scene?.setTextureOpacity(value);},
    setVideoFrame(source){scene?.setVideoFrame(source);},
    clearVideoSource(){scene?.clearVideoSource();},
    setVideoSourceRequired(value){scene?.setVideoSourceRequired(value);},
    hasUV(){return scene?.hasUV()??false;},
    previewAlignment(pairs){
      previewPairs=pairs;
      if(pairs.length>=3){
        try{const grid=fitLandmarkGrid(pairs);scene?.previewPlacement({...snapshot.project.placement,grid,transform:{x:0,y:0,scale:1,rotation:0}});}
        catch{scene?.clearPreview();}
      }
      draw();
    },
    clearAlignmentPreview:clearPreview,
    fit(){endAlignmentPan();scene?.fit();draw();},
    destroy(){observer.disconnect();scene?.destroy();host.replaceChildren();},
  };
}
