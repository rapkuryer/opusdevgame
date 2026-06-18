// Sky — dramatic sunset dome; hue shifts every 10–22 m while sprinting.
import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

export const SKY_RADIUS = 55;

/** Sunset base — deep indigo zenith, magenta mid, fiery orange horizon. */
const BASE = {
  c1: new THREE.Color('#f04a18'),
  c2: new THREE.Color('#c42a5a'),
  c3: new THREE.Color('#1a0e32'),
};

/** Gentle hue steps — smooth spectrum while sprinting. */
const RUN_HUE_STEPS = [
  0.00, 0.08, 0.16, 0.24, 0.32, 0.40, 0.48, 0.56, 0.64, 0.72, 0.80, 0.88,
];

const STEP_MIN_M = 10;
const STEP_MAX_M = 22;

const SKY_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = `
  varying vec2 vUv;
  uniform sampler2D tCloudNoise;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uColor3;
  uniform vec2 resolution;
  uniform float time;

  void main() {
    vec2 screenUv = gl_FragCoord.xy / resolution;
    float height = clamp(screenUv.y, 0.0, 1.0);
    float t = time * 0.00035;

    vec3 horizonBand = mix(uColor1, uColor2, smoothstep(0.0, 0.28, height));
    vec3 upperSky = mix(uColor2, uColor3, smoothstep(0.18, 1.0, height));
    vec3 skyBase = mix(horizonBand, upperSky, smoothstep(0.06, 0.62, height));

    float glow = smoothstep(0.28, 0.0, height);
    skyBase = mix(skyBase, uColor1 * 1.22, glow * 0.72);
    float sunBand = smoothstep(0.14, 0.0, height) * smoothstep(-0.02, 0.08, height);
    skyBase += uColor1 * sunBand * 0.38;

    vec2 uv = vUv;
    float n1 = texture2D(tCloudNoise, uv * vec2(1.15, 2.6) + vec2(t * 0.35, t * 0.12)).r;
    float n2 = texture2D(tCloudNoise, uv * vec2(0.75, 1.7) + vec2(-t * 0.22, t * 0.08)).r;
    float cloudMask = n1 * n2;
    cloudMask *= smoothstep(0.02, 0.42, height);

    vec3 cloudDark = uColor3 * 0.42 + vec3(0.06, 0.01, 0.10);
    vec3 cloudLit = mix(uColor2, uColor1, 0.42) * 1.14;
    float cloudCut = smoothstep(0.30, 0.58, cloudMask);
    float cloudHeight = smoothstep(0.92, 0.32, height);
    vec3 clouds = mix(cloudDark, cloudLit, smoothstep(0.42, 0.74, cloudMask));
    vec3 color = mix(skyBase, clouds, cloudCut * cloudHeight * 0.82);

    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 1.42);
    color = clamp(color, 0.0, 1.0);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const _live1 = new THREE.Color();
const _live2 = new THREE.Color();
const _live3 = new THREE.Color();
const _shifted1 = new THREE.Color();
const _shifted2 = new THREE.Color();
const _shifted3 = new THREE.Color();
const _lastRunPos = new THREE.Vector3();
const _hsl = { h: 0, s: 0, l: 0 };

function colorLuminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function hueShift(src, hueDelta, out) {
  src.getHSL(_hsl);
  out.setHSL((_hsl.h + hueDelta + 1) % 1, Math.min(_hsl.s * 1.05, 1), _hsl.l);
  const srcL = colorLuminance(src);
  const outL = colorLuminance(out);
  if (outL > 1e-6) out.multiplyScalar(srcL / outL);
}

function applySkyColors(uniforms, blend, huePhase) {
  const s = THREE.MathUtils.clamp(blend, 0, 1);
  hueShift(BASE.c1, huePhase * 0.9, _shifted1);
  hueShift(BASE.c2, huePhase, _shifted2);
  hueShift(BASE.c3, huePhase * 1.08, _shifted3);

  _live1.copy(BASE.c1).lerp(_shifted1, s);
  _live2.copy(BASE.c2).lerp(_shifted2, s);
  _live3.copy(BASE.c3).lerp(_shifted3, s);

  uniforms.uColor1.value.copy(_live1);
  uniforms.uColor2.value.copy(_live2);
  uniforms.uColor3.value.copy(_live3);
  // World atmosphere (fog/terrain/walls) stays on the BASE sunset palette —
  // the running hue-cycle must only recolor the visible sky, never tint the
  // road/walls green. (bot/top feed syncWorldAtmosphere, not the sky shader.)
  uniforms.bot.value.copy(BASE.c1);
  uniforms.top.value.copy(BASE.c3);
}

function nextStepDistance() {
  return STEP_MIN_M + Math.random() * (STEP_MAX_M - STEP_MIN_M);
}

export function createSkyUniforms() {
  return {
    top: { value: BASE.c3.clone() },
    bot: { value: BASE.c1.clone() },
    uColor1: { value: BASE.c1.clone() },
    uColor2: { value: BASE.c2.clone() },
    uColor3: { value: BASE.c3.clone() },
    tCloudNoise: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  };
}

function setupSkyCloudTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function createProceduralCloudNoise(size = 512) {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = Math.sin(x * 0.04) * Math.cos(y * 0.05) + Math.sin((x + y) * 0.02) * 0.5;
      data[y * size + x] = Math.floor((n * 0.5 + 0.5) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export async function createSkyDome(scene, renderer) {
  const uniforms = createSkyUniforms();
  uniforms.resolution.value.set(
    renderer?.domElement?.width || innerWidth,
    renderer?.domElement?.height || innerHeight,
  );

  try {
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('assets/libs/basis/');
    ktx2.detectSupport(renderer);
    uniforms.tCloudNoise.value = setupSkyCloudTexture(
      await ktx2.loadAsync('assets/images/clouds_noise_512.ktx2'),
    );
  } catch (e) {
    console.warn('Sky cloud noise failed, procedural fallback', e);
    uniforms.tCloudNoise.value = createProceduralCloudNoise();
  }

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 48, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
    }),
  );
  mesh.name = 'sky';
  mesh.rotation.x = 1;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  scene.add(mesh);

  let colorBlend = 0;
  let displayHue = 0;
  let targetHue = 0;
  let hueIndex = 0;
  let runDistance = 0;
  let stepDistance = nextStepDistance();
  let hasRunPos = false;

  return {
    mesh,
    uniforms,
    update(elapsed, character, dt = 0.016) {
      uniforms.time.value = elapsed;

      const playerPos = character?.position;
      if (playerPos) mesh.position.copy(playerPos);

      const targetBlend = character?.running ? 1 : 0;
      const blendRate = targetBlend > colorBlend ? 1.1 : 1.4;
      colorBlend = THREE.MathUtils.lerp(colorBlend, targetBlend, Math.min(1, dt * blendRate));

      if (character?.running && playerPos) {
        if (hasRunPos) {
          const moved = playerPos.distanceTo(_lastRunPos);
          runDistance += moved;
          while (runDistance >= stepDistance) {
            runDistance -= stepDistance;
            stepDistance = nextStepDistance();
            hueIndex = (hueIndex + 1) % RUN_HUE_STEPS.length;
            targetHue = RUN_HUE_STEPS[hueIndex];
          }
        }
        _lastRunPos.copy(playerPos);
        hasRunPos = true;
      } else {
        hasRunPos = false;
        runDistance = 0;
        stepDistance = nextStepDistance();
        targetHue = 0;
        hueIndex = 0;
      }

      const hueRate = character?.running ? 1.2 : 2.0;
      const hueSmooth = 1.0 - Math.exp(-dt * hueRate);
      displayHue += (targetHue - displayHue) * hueSmooth;

      applySkyColors(uniforms, colorBlend, displayHue);
    },
    setColors({ c1, c2, c3, top, bot }) {
      if (c1 != null) BASE.c1.set(c1);
      if (c2 != null) BASE.c2.set(c2);
      if (c3 != null) BASE.c3.set(c3);
      applySkyColors(uniforms, colorBlend, displayHue);
      if (top != null) uniforms.top.value.set(top);
      if (bot != null) uniforms.bot.value.set(bot);
    },
    onResize(w, h) {
      uniforms.resolution.value.set(w, h);
    },
  };
}
