// ---------------------------------------------------------------------------
// Abeto "present" planet — sculpted Draco meshes + hitmesh collider + water.
// Mirrors messenger.abeto.co architecture: 10 terrain chunks, merged hitmesh,
// atlas palette + triplanar noise terrain shader, distance-based chunk culling.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ensureSkipCollision } from './collisionUtils.js';
import { setupAtlasTexture, setupNoiseTexture, setupNatureMaskTexture } from './graphics.js';
import { createFogUniforms, fogGLSL, celShadeGLSL, worldSurfaceGLSL, inkAccentGLSL, colorSpaceGLSL, messengerManmadeGLSL, abetoTerrainShadeGLSL } from './worldGraphics.js';
import { createWaterMaterial } from './waterGraphics.js';
import { inkify } from './outline.js';
import { loadNatureDecor } from './natureDecor.js';
import { installCitySignOverlays } from './citySigns.js';
import {
  assemblyProgFromDist, assemblyRevealT,
  ASSEMBLY_VISIBILITY, ASSEMBLY_INNER, ASSEMBLY_OUTER,
  assemblyUniformDeclGLSL, assemblyCoreGLSL, assemblyGlowGLSL,
} from './assemblyShader.js';

const CHUNKS = 10;
const HIT_PARTS = 5;
const LOD1 = 6;
const LOD2 = 12;
const LOD3 = 20;
const LOD_H = 0.8; // hysteresis — prevents LOD flicker hitches while walking
const DOT_THRESHOLD = 0.45;
const DRACO_PATH = 'assets/libs/draco/';
const LOD_FILES = [
  (i) => `assets/planet/full_${i}.drc`,
  (i) => `assets/planet/full-lod-1_${i}.drc`,
  (i) => `assets/planet/full-lod-2_${i}.drc`,
  (i) => `assets/planet/full-lod-3_${i}.drc`,
];
const RAY_PAD = 50;
const FLOOR_DOT = 0.65;
const GROUND_CAST_UP = 2.5;
const GROUND_CAST_DOWN = 10;

const _frustum = new THREE.Frustum();
const _proj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _surfOut = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

function ensureAttr(geo, name, value, itemSize = 1) {
  if (!geo.getAttribute(name)) {
    const arr = new Float32Array(geo.attributes.position.count * itemSize);
    arr.fill(value);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
}

/** Sample 16×16 atlas — classify manmade (paths/wood) vs natural (rock/grass). */
function readAtlasPixels(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function sampleAtlasRGB(pixels, u, v) {
  const w = pixels.width;
  const h = pixels.height;
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
  const y = Math.min(h - 1, Math.max(0, Math.floor((1.0 - v) * h)));
  const i = (y * w + x) * 4;
  return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
}

/** Sidewalk / concrete / plaster — low-saturation light palette texels. */
function isManmadeTerrainColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 120) return false;
  if (max - min > 38) return false;
  return max > 145;
}

/** Natural terrain palette texels — grass, rock, cliff (not roads/buildings). */
function isMountainTerrainColor(r, g, b) {
  if (isManmadeTerrainColor(r, g, b)) return false;
  if (g > 115 && g > r + 22 && g > b + 12) return true;
  if (r > 210 && g > 165 && g < 225 && b > 155 && b < 215 && r > g + 8) return true;
  if (r > 145 && r < 205 && g > 130 && g < 190 && b > 110 && b < 175
    && Math.abs(r - g) < 22 && g >= b - 8) return true;
  return false;
}

function assignSurfaceIds(geo) {
  const existing = geo.getAttribute('surfaceId');
  if (existing) {
    const arr = existing.array;
    for (let i = 0; i < Math.min(arr.length, 500); i++) {
      if (arr[i] !== 0) return;
    }
  }
  const pos = geo.attributes.position;
  const ids = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    ids[v] = Math.abs((x * 12.9898 + y * 78.233 + z * 37.719) % 100000);
  }
  geo.setAttribute('surfaceId', new THREE.BufferAttribute(ids, 1));
}

function assignElementIdsFromAtlas(geo, atlasPixels) {
  const uv = geo.getAttribute('uv');
  if (!uv || !atlasPixels) {
    ensureAttr(geo, 'elementId', 0);
    return;
  }
  const ids = new Float32Array(uv.count);
  for (let v = 0; v < uv.count; v++) {
    const [r, g, b] = sampleAtlasRGB(atlasPixels, uv.getX(v), uv.getY(v));
    ids[v] = isMountainTerrainColor(r, g, b) ? 1 : 0;
  }
  geo.setAttribute('elementId', new THREE.BufferAttribute(ids, 1));
}

/** Terrain prep — UV fix + elementId/surfaceId (preserve mesh attrs when present). */
function prepTerrainAttrs(geo, atlasPixels) {
  const uv = geo.attributes.uv;
  if (uv) {
    const arr = uv.array;
    let bad = 0;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) bad++;
    }
    if (bad > arr.length * 0.5) geo.deleteAttribute('uv');
  }
  if (!geo.getAttribute('uv')) {
    const pos = geo.attributes.position;
    geo.computeBoundingSphere();
    const r = geo.boundingSphere.radius || 1;
    const uvs = new Float32Array(pos.count * 2);
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      uvs[v * 2] = Math.atan2(z, x) * 0.15 + 0.5;
      uvs[v * 2 + 1] = Math.asin(THREE.MathUtils.clamp(y / r, -1, 1)) * 0.5 + 0.5;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (!geo.getAttribute('elementId')) {
    assignElementIdsFromAtlas(geo, atlasPixels);
  } else {
    // Re-classify if every vertex is 0 (bad fallback) — keep baked ids otherwise.
    const eid = geo.getAttribute('elementId');
    const arr = eid.array;
    let anyNatural = false;
    for (let i = 0; i < Math.min(arr.length, 8000); i++) {
      if (arr[i] > 0.5) { anyNatural = true; break; }
    }
    if (!anyNatural && atlasPixels) assignElementIdsFromAtlas(geo, atlasPixels);
  }
  assignSurfaceIds(geo);
  return geo;
}

function makeTerrainMesh(geo, i, lod, terrainMat, group, chunkMeshes, atlasPixels, share) {
  prepTerrainAttrs(geo, atlasPixels);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mat = terrainMat.clone();
  mat.uniforms = THREE.UniformsUtils.clone(terrainMat.uniforms);
  // Share hot uniforms across all chunks — one write per frame, not N loops.
  if (share) {
    mat.uniforms.uAssemblyOn = share.asm.uAssemblyOn;
    mat.uniforms.uPlayerPos = share.asm.uPlayerPos;
    mat.uniforms.uBuildInner = share.asm.uBuildInner;
    mat.uniforms.uBuildOuter = share.asm.uBuildOuter;
    mat.uniforms.uLightDir = share.lightDir;
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `terrain-${i}-lod${lod}`;
  mesh.userData.lod = lod;
  mesh.userData.isTerrainChunk = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = true;
  mesh.scale.setScalar(1);
  group.add(mesh);
  chunkMeshes.push(mesh);
  return mesh;
}

function createProceduralNoise(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = Math.sin(x * 0.17 + y * 0.11) * 0.5
        + Math.sin((x + y) * 0.09) * 0.35
        + Math.cos(x * 0.07 - y * 0.13) * 0.25;
      const r = Math.floor((n * 0.5 + 0.5) * 255);
      const g = Math.floor((Math.sin(n * 3.1 + 1.2) * 0.5 + 0.5) * 255);
      const b = Math.floor((Math.cos(n * 2.7 + 0.4) * 0.5 + 0.5) * 255);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function triplanarGLSL() {
  return `
    vec4 triplanar(sampler2D tex, vec3 n, vec3 p, float scale) {
      vec3 an = abs(n) + 0.0001;
      an /= an.x + an.y + an.z;
      vec4 cx = texture2D(tex, p.yz * scale);
      vec4 cy = texture2D(tex, p.xz * scale);
      vec4 cz = texture2D(tex, p.xy * scale);
      return cx * an.x + cy * an.y + cz * an.z;
    }
  `;
}

function createTerrainMaterial(textures, fogUniforms) {
  const { atlas, noise, noiseBlur, noiseTerrain } = textures;
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    lights: false,
    transparent: false,
    depthWrite: true,
    uniforms: {
      tColors: { value: atlas },
      tNoise: { value: noise },
      tNoiseBlur: { value: noiseBlur || noise },
      tNoiseTerrain: { value: noiseTerrain },
      uLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.4).normalize() },
      uWorldUp: { value: new THREE.Vector3(0, 1, 0) },
      // Animus "reality bubble": world is solid within uBuildInner of the
      // player and fragments into flying blocks past uBuildOuter. uAssemblyOn
      // 0 = always-solid normal world, 1 = bubble active.
      uAssemblyOn: { value: 0.0 },
      uPlayerPos: { value: new THREE.Vector3() },
      // Reality bubble: tight around the player — world builds only when close.
      uBuildInner: { value: ASSEMBLY_INNER },
      uBuildOuter: { value: ASSEMBLY_OUTER },
      ...fogUniforms,
    },
    vertexShader: `
      ${assemblyUniformDeclGLSL}
      ${assemblyCoreGLSL}
      attribute float surfaceId;
      attribute float elementId;
      varying vec2 vUv;
      varying vec3 wPos;
      varying vec3 wNormal;
      varying vec3 vNormal;
      varying vec3 vLocalNormal;
      varying float vSurfaceId;
      varying float vElementId;
      varying float vAssembly;

      void main() {
        vUv = uv;
        vElementId = elementId;
        vSurfaceId = fract(surfaceId / 100000.0);
        vLocalNormal = normal;

        vec3 pos = assemblyTerrainDisplace(position, elementId, modelMatrix, vAssembly);

        vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
        wPos = worldPosition.xyz;
        vec3 transformedNormal = normalMatrix * normal;
        vNormal = transformedNormal;
        wNormal = normalize(mat3(viewMatrix) * transformedNormal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      ${colorSpaceGLSL()}
      ${triplanarGLSL()}
      ${worldSurfaceGLSL()}
      ${inkAccentGLSL()}
      ${fogGLSL()}
      ${celShadeGLSL()}
      ${messengerManmadeGLSL()}
      ${abetoTerrainShadeGLSL()}

      uniform sampler2D tColors;
      uniform sampler2D tNoise;
      uniform sampler2D tNoiseBlur;
      uniform sampler2D tNoiseTerrain;
      uniform vec3 uLightDir;
      uniform float uAssemblyOn;
      varying vec2 vUv;
      varying vec3 wPos;
      varying vec3 wNormal;
      varying vec3 vNormal;
      varying vec3 vLocalNormal;
      varying float vSurfaceId;
      varying float vElementId;
      varying float vAssembly;

      vec3 applyTerrainColor(vec3 norm, vec3 pos, vec3 color) {
        vec4 triplanarGrass = triplanar(tNoiseTerrain, norm, pos, 0.035);
        color = rgb2hsv(color);
        color.b -= step(0.7, triplanarGrass.r) * 0.03;
        color.b += step(triplanarGrass.g, 0.8) * 0.05;
        color = hsv2rgb(color);
        return color;
      }

      void main() {
        // Far / unassembled blocks are invisible — city materializes as you approach.
        if (uAssemblyOn > 0.5 && vAssembly > 0.82) discard;

        vec3 wNorm = normalize(wNormal);
        vec4 triplanarNoise = triplanar(tNoise, wNorm, wPos * 0.4, 1.0);
        float height = length(wPos);
        vec3 baseColor;
        float grassMask = 0.0;
        float wetMask = 0.0;
        float flatGround = isFlatGround(wNorm, wPos);

        if (vElementId > 0.5) {
          float slope = slopeFacing(wNorm, wPos);
          grassMask = step(0.15, max(0.0, -triplanarNoise.r * 1.5 + slope - triplanarNoise.g * 0.35 + 0.1 - triplanarNoise.b * 0.05));
          // grass only on slopes — not flat roads mis-tagged as natural
          grassMask *= step(0.72, slope);
          wetMask = 1.0 - step(0.334, height * 0.015 + triplanarNoise.g * 0.006);
          vec2 colorUV = vUv;
          if (grassMask > 0.5) colorUV = vec2(0.15, 0.95);
          if (wetMask > 0.5) colorUV = vec2(0.21, 0.54);
          baseColor = applyTerrainColor(wNorm, wPos, texture2D(tColors, colorUV).rgb);
          baseColor = applyAtlasInk(baseColor, tColors, colorUV, 0.12);

          float n1 = sin(height * 0.1 + (vLocalNormal.x + vLocalNormal.y + vLocalNormal.z) * 0.5 + (wPos.x + wPos.y + wPos.z) * 2.0);
          float striationNoise = texture2D(tNoise, vec2(n1 * 0.01, height * 0.07 - n1 * 0.02)).g;
          float striations = step(0.47, striationNoise + triplanarNoise.r * 0.2 + triplanarNoise.g * 0.05);
          if (striations > 0.5 && grassMask < 0.5) {
            vec3 hs = rgb2hsv(baseColor);
            hs.z *= 0.82;
            hs.y *= 0.94;
            baseColor = hsv2rgb(hs);
          }
          if (wetMask > 0.5) {
            vec3 wet = rgb2hsv(baseColor);
            wet.y += 0.03;
            wet.z += 0.05;
            baseColor = hsv2rgb(wet);
          }

          float ao = 1.0 - triplanarNoise.g * 0.14 - (1.0 - slopeFacing(wNorm, wPos)) * 0.09;
          baseColor *= clamp(ao, 0.76, 1.0);
        } else {
          baseColor = applyAtlasInk(texture2D(tColors, vUv).rgb, tColors, vUv, 0.08);
        }

        // Lush grass tint: turn EARTHY ground & hills (beige/tan soil) into grass
        // like the reference. Uses a robust world normal (screen-space derivatives)
        // so hills green correctly; skips grey roads, bright walls, vertical faces.
        {
          vec3 worldN = normalize(cross(dFdx(wPos), dFdy(wPos)));
          float facing = abs(dot(worldN, normalize(wPos)));   // 1 = up, 0 = vertical
          float groundFace = smoothstep(0.32, 0.68, facing);
          vec3 ghsv = rgb2hsv(baseColor);
          float earthy = smoothstep(0.04, 0.20, ghsv.y) * (1.0 - smoothstep(0.90, 0.99, ghsv.z));
          float tanHue = 1.0 - smoothstep(0.16, 0.36, abs(ghsv.x - 0.115));
          float grassAmt = groundFace * earthy * tanHue;
          vec3 grassCol = texture2D(tColors, vec2(0.15, 0.95)).rgb;
          float gv = triplanar(tNoiseTerrain, worldN, wPos, 0.05).r;
          grassCol *= 0.80 + gv * 0.38;
          baseColor = mix(baseColor, grassCol, clamp(grassAmt, 0.0, 1.0) * 0.88);
        }

        vec3 nv = normalize(vNormal);
        float ndl = max(0.0, dot(nv, normalize(uLightDir)));
        vec3 outCol;
        if (vElementId < 0.5) {
          outCol = shadeManmade(baseColor, ndl, wPos, flatGround);
        } else {
          outCol = shadeTerrainNatural(baseColor, ndl, wNorm, wPos);
        }
        outCol = applyWorldFog(outCol, wPos);

        // Animus materialization — blocks keep their own texture colour + dark NPR.
        ${assemblyGlowGLSL}

        gl_FragColor = vec4(outCol, 1.0);
      }
    `,
  });
}

function prepWaterAttrs(geo) {
  ensureAttr(geo, 'uv', 0, 2);
  return geo;
}

export async function loadAbetoPlanet(scene, camera, onProgress) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  draco.setWorkerLimit(2);
  draco.preload();

  const DRACO_TIMEOUT_MS = 90000;
  const loadDrc = async (url, retries = 2) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Draco timeout: ${url}`)), DRACO_TIMEOUT_MS);
          draco.load(url, (g) => { clearTimeout(timer); resolve(g); }, undefined, (e) => {
            clearTimeout(timer);
            reject(e);
          });
        });
      } catch (e) {
        if (attempt >= retries) throw e;
        console.warn(`[planet] Draco retry ${attempt + 1}/${retries} for ${url}`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    return null;
  };

  /** Draco WASM deadlocks when 15+ files decode at once — queue 2 at a time. */
  async function loadDrcBatch(jobs) {
    const out = [];
    for (let i = 0; i < jobs.length; i += 2) {
      const pair = jobs.slice(i, i + 2);
      const part = await Promise.all(pair.map(async ({ url, label, optional }) => {
        try {
          const g = await loadDrc(url);
          tick(label);
          return g;
        } catch (e) {
          console.warn(`${label} failed`, e);
          tick(`${label}-skip`);
          if (!optional) throw e;
          return null;
        }
      }));
      out.push(...part);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }

  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath('assets/libs/basis/');
  ktx2.detectSupport(rendererFromScene(scene));

  const renderer = rendererFromScene(scene);
  const texLoader = new THREE.TextureLoader();

  const total = HIT_PARTS + CHUNKS + 1;
  let done = 0;
  const tick = (label) => {
    done++;
    onProgress?.(done / total, label);
  };

  const jobs = [
    ...Array.from({ length: HIT_PARTS }, (_, i) => ({
      url: `assets/planet/hitmesh_${i}.drc`,
      label: `hitmesh_${i}`,
      optional: false,
    })),
    ...Array.from({ length: CHUNKS }, (_, i) => ({
      url: `assets/planet/full_${i}.drc`,
      label: `terrain_${i}`,
      optional: true,
    })),
    { url: 'assets/planet/water.drc', label: 'water', optional: true },
  ];

  async function loadNoiseTextures() {
    try {
      const ktxTimeout = (p, ms = 10000) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('KTX2 timeout')), ms)),
      ]);
      const [noiseRaw, terrainRaw, waterRaw, blurRaw] = await Promise.all([
        ktxTimeout(ktx2.loadAsync('assets/images/noise-simplex-layered-pixellated-highq.ktx2')),
        ktxTimeout(ktx2.loadAsync('assets/images/noises-terrain.ktx2')),
        ktxTimeout(ktx2.loadAsync('assets/images/water-noises-highq.ktx2')),
        ktxTimeout(ktx2.loadAsync('assets/images/noise-simplex-layered-blur-highq.ktx2')).catch(() => null),
      ]);
      const noise = setupNoiseTexture(noiseRaw, renderer);
      const noiseTerrain = setupNoiseTexture(terrainRaw, renderer);
      const waterNoise = setupNoiseTexture(waterRaw, renderer);
      const noiseBlur = blurRaw ? setupNoiseTexture(blurRaw, renderer) : noise;
      return { noise, noiseBlur, noiseTerrain, waterNoise, waterNoiseBlur: noiseBlur };
    } catch (e) {
      console.warn('KTX2 textures failed, using procedural noise fallback', e);
      const n = createProceduralNoise();
      return { noise: n, noiseBlur: n, noiseTerrain: n, waterNoise: n, waterNoiseBlur: n };
    }
  }

  onProgress?.(0, 'textures');
  console.log('[planet] decoding', jobs.length, 'Draco meshes (parallel with textures)…');

  const atlasPromise = (async () => {
    const atlas = setupAtlasTexture(await new Promise((res, rej) => {
      texLoader.load('assets/images/atlas.png', res, undefined, rej);
    }));
    await new Promise((resolve) => {
      if (atlas.image?.complete) resolve();
      else atlas.image.onload = resolve;
    });
    return { atlas, atlasPixels: readAtlasPixels(atlas.image) };
  })();

  const [atlasPack, decoded, noiseTextures] = await Promise.all([
    atlasPromise,
    loadDrcBatch(jobs),
    loadNoiseTextures(),
  ]);
  const { atlas, atlasPixels } = atlasPack;
  const textures = { atlas, ...noiseTextures };
  console.log('[planet] Draco done');

  const fogUniforms = createFogUniforms();
  const terrainMat = createTerrainMaterial(textures, fogUniforms);
  const waterMat = createWaterMaterial(textures, fogUniforms);
  // Shared assembly + light refs — all world materials point at the same objects.
  const share = {
    asm: {
      uAssemblyOn: terrainMat.uniforms.uAssemblyOn,
      uPlayerPos: terrainMat.uniforms.uPlayerPos,
      uBuildInner: terrainMat.uniforms.uBuildInner,
      uBuildOuter: terrainMat.uniforms.uBuildOuter,
    },
    lightDir: terrainMat.uniforms.uLightDir,
  };
  function wireAsmUniforms(mat) {
    if (!mat?.uniforms) return;
    mat.uniforms.uAssemblyOn = share.asm.uAssemblyOn;
    mat.uniforms.uPlayerPos = share.asm.uPlayerPos;
    mat.uniforms.uBuildInner = share.asm.uBuildInner;
    mat.uniforms.uBuildOuter = share.asm.uBuildOuter;
  }
  wireAsmUniforms(waterMat);

  const group = new THREE.Group();
  group.name = 'planet-present';
  scene.add(group);

  const hitParts = decoded.slice(0, HIT_PARTS);
  const terrainGeos = decoded.slice(HIT_PARTS, HIT_PARTS + CHUNKS);
  const waterGeoRaw = decoded[HIT_PARTS + CHUNKS] ?? null;
  const validHit = hitParts.filter((g) => g.attributes.position?.count > 3);
  const hitGeo = mergeGeometries(validHit, false);
  hitGeo.computeVertexNormals();
  ensureSkipCollision(hitGeo);
  const collider = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
  collider.name = 'hitmesh';
  collider.receiveShadow = false;
  collider.castShadow = false;
  group.add(collider);

  hitGeo.computeBoundingSphere();
  const radius = hitGeo.boundingSphere.radius;

  // --- visual terrain LOD0 only (LOD1–3 stream in after BEGIN) ---
  const chunkMeshes = [];
  const chunkData = [];
  for (let i = 0; i < CHUNKS; i++) {
    const geo = terrainGeos[i];
    if (!geo) continue;
    const mesh = makeTerrainMesh(geo, i, 0, terrainMat, group, chunkMeshes, atlasPixels, share);
    chunkData[i] = {
      index: i,
      lods: [mesh],
      center: geo.boundingSphere.center.clone(),
      radius: geo.boundingSphere.radius,
      lodLevel: 0,
    };
  }

  let waterGroup = null;
  if (waterGeoRaw) {
    try {
      const waterGeo = prepWaterAttrs(waterGeoRaw);
      ensureAttr(waterGeo, 'uv', 0, 2);
      waterGeo.computeBoundingBox();
      const waterMesh = new THREE.Mesh(waterGeo, waterMat);
      waterMesh.name = 'water';
      waterMesh.receiveShadow = false;
      waterMesh.castShadow = false;
      waterMesh.renderOrder = 2;
      group.add(waterMesh);
      waterGroup = waterMesh;
      waterMesh.visible = true;
      waterMesh.scale.setScalar(1);
    } catch (e) {
      console.warn('Water mesh setup failed', e);
    }
  }

  async function loadDeferredLODs() {
    const jobs = [];
    for (let lod = 1; lod < LOD_FILES.length; lod++) {
      for (let i = 0; i < CHUNKS; i++) {
        if (!chunkData[i]) continue;
        jobs.push({ i, lod, url: LOD_FILES[lod](i) });
      }
    }
    const BATCH = 4;
    for (let b = 0; b < jobs.length; b += BATCH) {
      const batch = jobs.slice(b, b + BATCH);
      await Promise.all(batch.map(async ({ i, lod, url }) => {
        try {
          const geo = await loadDrc(url);
          const mesh = makeTerrainMesh(geo, i, lod, terrainMat, group, chunkMeshes, atlasPixels, share);
          mesh.visible = false;
          const ch = chunkData[i];
          ch.lods.push(mesh);
          ch.lods.sort((a, c) => a.userData.lod - c.userData.lod);
        } catch (e) {
          console.warn(`deferred chunk ${i} lod ${lod}`, e);
        }
      }));
      await new Promise((r) => setTimeout(r, 0));
    }
    console.log('Deferred terrain LODs ready');
    setAssemblyUniforms();
    refreshInk();
  }

  let natureDecor = null;
  let signGroup = null;
  // Decor loads in background — don't block BEGIN button.
  loadNatureDecor({
    parentGroup: group,
    ktx2,
    atlas,
    noiseTerrain: textures.noiseTerrain,
    fogUniforms,
    onProgress: (label) => tick(label),
  }).then((decor) => {
    natureDecor = decor;
    wireAsmUniforms(natureDecor?.leavesMesh?.material);
    wireAsmUniforms(natureDecor?.grassMesh?.material);
    refreshInk();
    setAssemblyUniforms();
    console.log('Nature decor ready');
  }).catch((e) => {
    console.warn('Nature decor load failed', e);
  });

  collider.updateMatrixWorld(true);
  group.updateMatrixWorld(true);

  installCitySignOverlays(group).then((g) => {
    signGroup = g;
    setAssemblyUniforms();
  }).catch((e) => {
    console.warn('Sign overlays failed', e);
  });

  const walkable = [collider];

  function surfaceInfo(dir) {
    _v0.copy(dir).normalize();
    _v1.copy(_v0).multiplyScalar(radius + RAY_PAD);
    _ray.set(_v1, _v0.negate());
    const hit = _ray.intersectObject(collider, false)[0];
    if (!hit) return null;
    _nm.getNormalMatrix(hit.object.matrixWorld);
    _surfOut.point.copy(hit.point);
    _surfOut.normal.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    return _surfOut;
  }

  /** Downward ray — floor only (skips building walls). Used for player grounding. */
  function groundInfo(worldPos, up) {
    _v0.copy(up).normalize();
    _v1.copy(worldPos).addScaledVector(_v0, GROUND_CAST_UP);
    _ray.set(_v1, _v2.copy(_v0).negate());
    _ray.far = GROUND_CAST_UP + GROUND_CAST_DOWN;
    const hit = _ray.intersectObject(collider, false)[0];
    _ray.far = Infinity;
    if (!hit) return null;
    _nm.getNormalMatrix(hit.object.matrixWorld);
    _v3.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    if (_v3.dot(_v0) < FLOOR_DOT) return null;
    _surfOut.point.copy(hit.point);
    _surfOut.normal.copy(_v3);
    return _surfOut;
  }

  /** Push out of steep hitmesh faces (building walls) — tangential slide, no hop. */
  function resolveWallContact(worldPos, up, vel, radius = 0.4) {
    _v0.copy(up).normalize();
    const tang = _v1.copy(vel).addScaledVector(_v0, -vel.dot(_v0));
    if (tang.lengthSq() < 1e-8) return;
    const hLen = tang.length();
    const hDir = _v2.copy(tang).multiplyScalar(1 / hLen);
    _v3.copy(worldPos).addScaledVector(_v0, 0.55);
    _ray.set(_v3, hDir);
    _ray.far = hLen + radius + 0.2;
    const hit = _ray.intersectObject(collider, false)[0];
    _ray.far = Infinity;
    if (!hit) return;
    _nm.getNormalMatrix(hit.object.matrixWorld);
    const n = _v3.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    if (n.dot(_v0) >= FLOOR_DOT) return;
    const vn = vel.dot(n);
    if (vn < 0) vel.addScaledVector(n, -vn);
    const pen = radius + 0.08 - hit.distance;
    if (pen > 0) worldPos.addScaledVector(n, pen);
  }

  function spawnOnSurface(initialPos, jitterRadius = 0) {
    let dir = initialPos.clone().normalize();
    const up = dir.clone();
    const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const east = new THREE.Vector3().crossVectors(ref, up).normalize();
    const north = new THREE.Vector3().crossVectors(up, east).normalize();
    if (jitterRadius > 0) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * jitterRadius;
      dir = up.clone()
        .addScaledVector(east, (Math.cos(a) * r) / radius)
        .addScaledVector(north, (Math.sin(a) * r) / radius)
        .normalize();
    }
    const rayStart = dir.clone().multiplyScalar(radius + RAY_PAD);
    _ray.set(rayStart, dir.clone().negate());
    const hit = _ray.intersectObject(collider, false)[0];
    if (hit) {
      const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      return {
        point: hit.point.clone(),
        normal: hit.face.normal.clone().applyMatrix3(nm).normalize(),
        up: dir,
      };
    }
    const s = surfaceInfo(dir);
    return s ? { point: s.point, normal: s.normal, up: dir } : { point: dir.clone().multiplyScalar(radius), normal: dir, up: dir };
  }

  function syncLightDir(light) {
    if (!light) return;
    const d = _v0.set(0, 0, 0);
    const t = _v1.set(0, 0, 0);
    light.getWorldPosition(d);
    light.target.getWorldPosition(t);
    d.sub(t).normalize();
    share.lightDir.value.copy(d);
  }

  // --- Animus materialization: a per-vertex "reality bubble" in the terrain
  // shader. Geometry within uBuildInner of the player is solid; past uBuildOuter
  // it fragments into flying blocks and vanishes — so the world builds ahead of
  // the player and folds back into blocks behind them as they move.
  const materializationWave = { active: false };
  const _asmPlayer = new THREE.Vector3();
  // Live build radii (animated by the menu intro; default to the gameplay values).
  let _buildInner = ASSEMBLY_INNER;
  let _buildOuter = ASSEMBLY_OUTER;
  function setBuildRadius(inner, outer) {
    _buildInner = inner;
    _buildOuter = outer;
    share.asm.uBuildInner.value = inner;
    share.asm.uBuildOuter.value = outer;
  }
  function progFromDist(d) {
    const t = THREE.MathUtils.clamp((d - _buildInner) / Math.max(0.001, _buildOuter - _buildInner), 0, 1);
    const s = t * t * (3 - 2 * t);
    return 1 - s;
  }

  function refreshInk() {
    // Terrain, buildings, signs, character get outlines from the full-screen ink
    // pass (depth+normal). Foliage is excluded there, so it keeps an inverted-hull
    // silhouette of its own.
    if (natureDecor?.group) inkify(natureDecor.group, 0.03, { skipNames: [] });
    if (typeof window !== 'undefined') window.__refreshOutline?.();
  }

  function syncAssemblyState() {
    share.asm.uAssemblyOn.value = materializationWave.active ? 1.0 : 0.0;
    share.asm.uBuildInner.value = _buildInner;
    share.asm.uBuildOuter.value = _buildOuter;
    if (_asmPlayer.lengthSq() > 0) share.asm.uPlayerPos.value.copy(_asmPlayer);
  }

  function updateSignVisibility() {
    if (!signGroup) return;
    const active = materializationWave.active;
    for (const child of signGroup.children) {
      if (!active) {
        child.visible = true;
        child.scale.setScalar(1);
        if (child.material) child.material.opacity = 1;
        continue;
      }
      const prog = progFromDist(child.position.distanceTo(_asmPlayer));
      const t = assemblyRevealT(prog);
      child.visible = prog > ASSEMBLY_VISIBILITY;
      child.scale.setScalar(Math.max(0.001, t));
      if (child.material) child.material.opacity = t;
    }
  }

  function updateInkAssemblyVisibility() {
    const roots = [group];
    if (natureDecor?.group) roots.push(natureDecor.group);
    for (const root of roots) {
      root.traverse((o) => {
        if (!o.userData?.isInk) return;
        if (!materializationWave.active) {
          o.visible = true;
          return;
        }
        // Terrain ink stays at rest while verts fly → spiky black/cyan glitch.
        if (o.parent?.userData?.isTerrainChunk) {
          o.visible = false;
          return;
        }
        o.parent?.getWorldPosition(_v0);
        const prog = progFromDist(_v0.distanceTo(_asmPlayer));
        o.visible = prog > ASSEMBLY_VISIBILITY;
      });
    }
  }

  function setAssemblyUniforms() {
    syncAssemblyState();
    updateSignVisibility();
    updateInkAssemblyVisibility();
  }

  /** Enable the build-from-blocks effect (world materializes around the player). */
  function startAssembly(playerPos) {
    if (playerPos) {
      _asmPlayer.copy(playerPos);
      share.asm.uPlayerPos.value.copy(playerPos);
    }
    materializationWave.active = true;
    setAssemblyUniforms();
  }

  function stopAssembly() {
    materializationWave.active = false;
    setAssemblyUniforms();
  }

  function updateAssembly(playerPos, frame = 0) {
    if (!materializationWave.active || !playerPos) return;
    _asmPlayer.copy(playerPos);
    share.asm.uPlayerPos.value.copy(playerPos);
    // Signs + ink shells only need CPU refresh occasionally, not every frame.
    if ((frame & 7) === 0) {
      updateSignVisibility();
      updateInkAssemblyVisibility();
    }
  }

  function update(elapsed, playerPos, cam, frame = 0, light = null) {
    if (waterGroup) waterGroup.material.uniforms.uTime.value = elapsed;
    if ((frame & 3) === 0) syncLightDir(light);
    natureDecor?.update(elapsed, playerPos, light);
    updateAssembly(playerPos, frame);
  }

  return {
    group,
    collider,
    colliderSourceGeo: hitGeo,
    walkable,
    radius,
    chunkMeshes,
    terrainMat,
    waterMat,
    fogUniforms,
    syncLightDir,
    water: waterGroup,
    surfaceInfo,
    groundInfo,
    resolveWallContact,
    spawnOnSurface,
    update,
    loadDeferredLODs,
    chunkData,
    natureDecor,
    signGroup,
    refreshInk,
    textures,
    materializationWave,
    startAssembly,
    stopAssembly,
    setBuildRadius,
    get buildInner() { return _buildInner; },
    get buildOuter() { return _buildOuter; },
  };
}

function rendererFromScene(scene) {
  // KTX2Loader.detectSupport needs a WebGLRenderer; grab from window if available.
  return window.__renderer || new THREE.WebGLRenderer();
}
