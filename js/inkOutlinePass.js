// Full-screen ink outlines — depth + normal edge detection (abeto gInfo style).
// Draws hand-drawn dark lines on ALL opaque world geometry + character:
// silhouettes (depth jumps) AND interior creases (normal breaks: wall corners,
// roof seams). Foliage / water / sky are excluded from the normal buffer
// (they keep their own alpha shapes / inverted-hull silhouettes).
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const EXCLUDE_NAMES = new Set(['water', 'sky', 'grass-blades', 'tree-leaves']);

export function createInkOutline(renderer, scene, camera, opts = {}) {
  const inkColor = new THREE.Color(opts.color ?? 0x0a0908);

  const makeRT = (w, h) => {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      generateMipmaps: false,
    });
    rt.texture.generateMipmaps = false;
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.type = THREE.UnsignedIntType;
    rt.depthTexture.generateMipmaps = false;
    return rt;
  };

  // Render the normal/depth pass at reduced resolution — the outline edge detect
  // tolerates it well and it roughly halves the cost of this extra full render.
  const NRES = opts.normalScale ?? 0.55;
  const dpr = renderer.getPixelRatio();
  let rt = makeRT(
    Math.max(1, Math.floor(innerWidth * dpr * NRES)),
    Math.max(1, Math.floor(innerHeight * dpr * NRES)),
  );

  const normalMat = new THREE.MeshNormalMaterial();

  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      tNormal: { value: rt.texture },
      tDepth: { value: rt.depthTexture },
      uTexel: { value: new THREE.Vector2(1 / rt.width, 1 / rt.height) },
      uThickness: { value: opts.thickness ?? 1.25 },
      uInk: { value: inkColor },
      uInkStrength: { value: opts.strength ?? 0.95 },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uDepthSens: { value: opts.depthSens ?? 0.018 },
      uNormalSens: { value: opts.normalSens ?? 0.55 },
      uHue: { value: 0.0 },     // psychedelic world hue drift (radians)
      uSat: { value: 1.0 },     // saturation multiplier
      // Assembly fade — ink appears as the world materializes near the player and
      // vanishes as it disassembles behind. Reconstructs world pos from depth.
      uInvViewProj: { value: new THREE.Matrix4() },
      uPlayerPos: { value: new THREE.Vector3() },
      uBuildInner: { value: 4.0 },
      uBuildOuter: { value: 28.0 },
      uAssemblyOn: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tNormal;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform float uThickness;
      uniform vec3 uInk;
      uniform float uInkStrength;
      uniform float uNear;
      uniform float uFar;
      uniform float uDepthSens;
      uniform float uNormalSens;
      uniform float uHue;
      uniform float uSat;
      uniform mat4 uInvViewProj;
      uniform vec3 uPlayerPos;
      uniform float uBuildInner;
      uniform float uBuildOuter;
      uniform float uAssemblyOn;
      varying vec2 vUv;

      // Hue rotation about the luminance axis (Rodrigues).
      vec3 hueRotate(vec3 col, float a) {
        const vec3 k = vec3(0.57735);
        float c = cos(a), s = sin(a);
        return col * c + cross(k, col) * s + k * dot(k, col) * (1.0 - c);
      }

      float viewZ(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return (uNear * uFar) / ((uFar - uNear) * d - uFar);
      }
      vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }

      void main() {
        vec2 o = uTexel * uThickness;
        vec2 uvN = vUv + vec2(0.0, o.y);
        vec2 uvS = vUv - vec2(0.0, o.y);
        vec2 uvE = vUv + vec2(o.x, 0.0);
        vec2 uvW = vUv - vec2(o.x, 0.0);

        float zc = abs(viewZ(vUv));
        float zEdge = abs(abs(viewZ(uvN)) - zc)
                    + abs(abs(viewZ(uvS)) - zc)
                    + abs(abs(viewZ(uvE)) - zc)
                    + abs(abs(viewZ(uvW)) - zc);
        zEdge /= max(0.0001, zc);
        float depthEdge = smoothstep(uDepthSens, uDepthSens * 1.6, zEdge);

        vec3 nc = nrm(vUv);
        float nEdge = (1.0 - max(0.0, dot(nc, nrm(uvN))))
                    + (1.0 - max(0.0, dot(nc, nrm(uvS))))
                    + (1.0 - max(0.0, dot(nc, nrm(uvE))))
                    + (1.0 - max(0.0, dot(nc, nrm(uvW))));
        // High threshold — skip terrain triangle facets, keep wall corners only.
        float normalEdge = smoothstep(uNormalSens, uNormalSens * 1.4, nEdge);

        // Silhouettes (depth) dominate; normal creases are subtle (no mesh wireframe look).
        float edge = (depthEdge * 0.92 + normalEdge * 0.28) * uInkStrength;
        edge = edge / (edge + 0.62);
        edge = smoothstep(0.10, 0.82, edge);

        // Kill false outlines at screen edges (stale depth / letterbox artifacts).
        float border = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
        edge *= smoothstep(0.0, 0.018, border);

        // Assembly fade: ink follows the reality bubble — present where the world
        // is built (near player), gone where it has disassembled (far behind).
        if (uAssemblyOn > 0.5) {
          float dc = texture2D(tDepth, vUv).x;
          vec4 clip = vec4(vUv * 2.0 - 1.0, dc * 2.0 - 1.0, 1.0);
          vec4 wp = uInvViewProj * clip;
          vec3 worldPos = wp.xyz / wp.w;
          float dist = distance(worldPos, uPlayerPos);
          float prog = 1.0 - smoothstep(uBuildInner, uBuildOuter, dist);
          edge *= smoothstep(0.10, 0.50, prog);
        }

        vec3 col = mix(texture2D(tDiffuse, vUv).rgb, uInk, edge * 0.9);
        // Psychedelic world hue drift — advances with player movement.
        col = hueRotate(col, uHue);
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col = clamp(mix(vec3(l), col, uSat), 0.0, 1.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const _hidden = [];
  const _cachedExclude = [];
  const _prevClear = new THREE.Color();

  function collectExclude() {
    _cachedExclude.length = 0;
    scene.traverse((o) => {
      if (o.userData?.isInk || o.userData?.skipNormal || EXCLUDE_NAMES.has(o.name)) {
        _cachedExclude.push(o);
      }
    });
  }

  function renderNormalDepth(frame = 0) {
    // Re-scan scene occasionally — not every frame (traverse is expensive).
    if (_cachedExclude.length === 0 || (frame & 127) === 0) collectExclude();

    _hidden.length = 0;
    for (const o of _cachedExclude) {
      if (o.visible) { _hidden.push(o); o.visible = false; }
    }

    const prevRT = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    renderer.getClearColor(_prevClear);
    const prevAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = normalMat;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x8080ff, 1); // encodes view normal (0,0,1) on background
    renderer.clear();
    renderer.render(scene, camera);

    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(_prevClear, prevAlpha);

    for (const o of _hidden) o.visible = true;

    pass.uniforms.uNear.value = camera.near;
    pass.uniforms.uFar.value = camera.far;
    // world-pos reconstruction matrix + live assembly state for the ink fade
    pass.uniforms.uInvViewProj.value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    const a = opts.getAssembly ? opts.getAssembly() : null;
    if (a) {
      pass.uniforms.uAssemblyOn.value = a.on ? 1.0 : 0.0;
      if (a.playerPos) pass.uniforms.uPlayerPos.value.copy(a.playerPos);
      if (a.inner != null) pass.uniforms.uBuildInner.value = a.inner;
      if (a.outer != null) pass.uniforms.uBuildOuter.value = a.outer;
    }
  }

  function resize(w, h) {
    const ratio = renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(w * ratio * NRES));
    const H = Math.max(1, Math.floor(h * ratio * NRES));
    rt.setSize(W, H);
    pass.uniforms.tNormal.value = rt.texture;
    pass.uniforms.tDepth.value = rt.depthTexture;
    pass.uniforms.uTexel.value.set(1 / W, 1 / H);
  }

  return { pass, render: renderNormalDepth, resize, invalidateCache: collectExclude };
}
