import * as THREE from 'three';

// Calibration grids use top-down normalized coordinates, matching mapping/grid.mjs.
export function createProjectionWarp(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { image: { value: null }, grid: { value: null }, gridSize: { value: new THREE.Vector2(2, 2) } },
    vertexShader: `varying vec2 screenUv; void main(){screenUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
    fragmentShader: `precision highp float;
      varying vec2 screenUv; uniform sampler2D image; uniform sampler2D grid; uniform vec2 gridSize;
      vec2 at(vec2 p){return texture2D(grid,(p+0.5)/gridSize).xy;}
      void main(){
        // screenUv and the calibration API both describe the output from its top-left.
        vec2 target=vec2(screenUv.x,1.0-screenUv.y);
        vec2 g=target*(gridSize-1.0); vec2 cell=min(floor(g),gridSize-2.0); vec2 f=g-cell;
        vec2 tl=at(cell),tr=at(cell+vec2(1.0,0.0)),br=at(cell+vec2(1.0,1.0)),bl=at(cell+vec2(0.0,1.0));
        vec2 source=f.y<=f.x ? tl*(1.0-f.x)+tr*(f.x-f.y)+br*f.y : tl*(1.0-f.y)+br*f.x+bl*(f.y-f.x);
        if(any(lessThan(source,vec2(0.0)))||any(greaterThan(source,vec2(1.0)))){gl_FragColor=vec4(0.0,0.0,0.0,1.0);}
        else {gl_FragColor=texture2D(image,vec2(source.x,1.0-source.y));}
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  let gridTexture = null;
  let gridKey = null;
  let target = null;
  let disposed = false;

  function setGrid(grid) {
    if (!grid && gridKey === null) return false;
    if (grid && Number.isInteger(grid.columns) && Number.isInteger(grid.rows) && Array.isArray(grid.points)
        && gridKey === `${grid.columns}x${grid.rows}:${grid.points.map((point) => `${point?.u},${point?.v}`).join(';')}`) return true;
    gridTexture?.dispose(); gridTexture = null; material.uniforms.grid.value = null;
    gridKey = null;
    if (!grid || !Number.isInteger(grid.columns) || !Number.isInteger(grid.rows)
        || grid.columns < 2 || grid.rows < 2 || !Array.isArray(grid.points)
        || grid.points.length !== grid.columns * grid.rows) return false;
    const values = new Float32Array(grid.points.length * 4);
    for (let i = 0; i < grid.points.length; i += 1) {
      const point = grid.points[i];
      if (!Number.isFinite(point?.u) || !Number.isFinite(point?.v)) return false;
      values[i * 4] = point.u; values[i * 4 + 1] = point.v; values[i * 4 + 3] = 1;
    }
    gridTexture = new THREE.DataTexture(values, grid.columns, grid.rows, THREE.RGBAFormat, THREE.FloatType);
    gridTexture.minFilter = gridTexture.magFilter = THREE.NearestFilter;
    gridTexture.generateMipmaps = false;
    gridTexture.needsUpdate = true;
    material.uniforms.grid.value = gridTexture;
    material.uniforms.gridSize.value.set(grid.columns, grid.rows);
    gridKey = `${grid.columns}x${grid.rows}:${grid.points.map(({ u, v }) => `${u},${v}`).join(';')}`;
    return true;
  }

  function resize(width, height) {
    const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    if (target && target.width === w && target.height === h) return;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
    });
    // The scene shader writes output-space sRGB; sampling this target decodes it for the final pass.
    target.texture.colorSpace = THREE.SRGBColorSpace;
  }

  function render(sourceScene, sourceCamera, width, height, enabled) {
    if (disposed || !enabled || !gridTexture) {
      renderer.setRenderTarget(null);
      renderer.render(sourceScene, sourceCamera);
      return;
    }
    resize(width, height);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(sourceScene, sourceCamera);
    material.uniforms.image.value = target.texture;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
  }

  return {
    setGrid,
    render,
    destroy() {
      if (disposed) return;
      disposed = true; target?.dispose(); target = null; gridTexture?.dispose(); gridTexture = null; gridKey = null;
      quad.geometry.dispose(); material.dispose();
    },
  };
}
