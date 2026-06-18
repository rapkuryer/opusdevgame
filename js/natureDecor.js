// Grass blades + tree foliage — messenger.abeto.co present planet decor.
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { setupNoiseTexture, setupNatureMaskTexture } from './graphics.js';
import { fogGLSL, celShadeGLSL, inkAccentGLSL, colorSpaceGLSL } from './worldGraphics.js';
import {
  createAssemblyUniforms, assemblyUniformDeclGLSL, assemblyCoreGLSL,
  assemblyDiscardGLSL, assemblyGlowGLSL,
} from './assemblyShader.js';

const TREE_FILES = 5;
const VIS_DIST = 80;
const DOT_THRESHOLD = 0.45;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sphere = new THREE.Sphere();

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

function applyTerrainColorGLSL() {
  return `
    vec3 applyTerrainColor(vec3 norm, vec3 pos, vec3 color, sampler2D tNoiseTerrain) {
      vec4 triplanarGrass = triplanar(tNoiseTerrain, norm, pos, 0.038);
      color = rgb2hsv(color);
      color.b -= step(0.7, triplanarGrass.r) * 0.038;
      color.b += step(triplanarGrass.g, 0.8) * 0.058;
      color.g += (triplanarGrass.b - 0.5) * 0.048;
      color = hsv2rgb(color);
      return color;
    }
  `;
}

function createTreeLeavesMaterial(textures, fogUniforms) {
  const { treeLeaves, treeDetail, atlas } = textures;
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      tLeaves: { value: treeLeaves },
      tDetail: { value: treeDetail },
      tColors: { value: atlas },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.4).normalize() },
      uColor1: { value: new THREE.Color('#5b9f7b') },
      uColor2: { value: new THREE.Color('#649c75') },
      uColor3: { value: new THREE.Color('#4e8c6d') },
      ...fogUniforms,
      uWorldUp: { value: new THREE.Vector3(0, 1, 0) },
      ...createAssemblyUniforms(),
    },
    vertexShader: `
      ${assemblyUniformDeclGLSL}
      ${assemblyCoreGLSL}
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 wPos;
      varying vec3 vNormal;
      varying float vColorBand;
      varying float vAssembly;
      void main() {
        vUv = uv;
        float asmAmt;
        vec3 pos = assemblyDisplace(position, modelMatrix, asmAmt);
        vAssembly = asmAmt;
        float sway = sin(uTime * 0.9 + position.x * 1.7 + position.z * 2.1) * 0.04;
        pos.x += sway;
        pos.z += sway * 0.6;
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        wPos = wp.xyz;
        vNormal = normalize(normalMatrix * normal);
        vColorBand = fract(sin(dot(position.xz, vec2(41.3, 289.7))) * 43758.5);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      ${assemblyUniformDeclGLSL}
      ${colorSpaceGLSL()}
      ${inkAccentGLSL()}
      ${fogGLSL()}
      ${celShadeGLSL()}
      uniform sampler2D tLeaves;
      uniform sampler2D tDetail;
      uniform sampler2D tColors;
      uniform vec3 uLightDir;
      uniform vec3 uColor1;
      uniform vec3 uColor2;
      uniform vec3 uColor3;
      varying vec2 vUv;
      varying vec3 wPos;
      varying vec3 vNormal;
      varying float vColorBand;
      varying float vAssembly;
      void main() {
        ${assemblyDiscardGLSL}
        float leaf = texture2D(tLeaves, vUv).r;
        float detail = texture2D(tDetail, vUv * 1.65).g;
        float detail2 = texture2D(tDetail, vUv * 2.4 + vec2(0.17, 0.31)).r;
        if (leaf > 0.11) discard;
        vec3 tint = mix(uColor1, uColor2, step(0.5, vColorBand));
        tint = mix(tint, uColor3, step(0.72, vColorBand) * 0.55);
        vec3 base = mix(texture2D(tColors, vec2(0.15, 0.95)).rgb, tint, 0.84);
        base = applyAtlasInk(base, tColors, vUv, 0.58);
        base *= 0.9 + detail * 0.16 + detail2 * 0.08;
        float ndl = max(0.0, dot(normalize(vNormal), uLightDir));
        vec3 col = mix(inkShadow(base), base, celShade(ndl));
        col = applyWorldFog(col, wPos);
        vec3 outCol = col;
        ${assemblyGlowGLSL}
        gl_FragColor = vec4(outCol, 1.0);
      }
    `,
  });
}

function createGrassBladeMaterial(textures, fogUniforms) {
  const { grassBlades, atlas, noiseTerrain } = textures;
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      tGrass: { value: grassBlades },
      tColors: { value: atlas },
      tNoiseTerrain: { value: noiseTerrain },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.4).normalize() },
      charPos: { value: new THREE.Vector3() },
      charSpeed: { value: 0 },
      ...fogUniforms,
      uWorldUp: { value: new THREE.Vector3(0, 1, 0) },
      ...createAssemblyUniforms(),
    },
    vertexShader: `
      ${assemblyUniformDeclGLSL}
      ${assemblyCoreGLSL}
      attribute vec3 up;
      attribute vec4 randomm;
      uniform float uTime;
      uniform vec3 charPos;
      uniform float charSpeed;
      varying vec2 vUv;
      varying vec4 vRand;
      varying vec3 wPos;
      varying vec3 vNormal;
      varying float vAssembly;
      void main() {
        vUv = uv;
        vRand = randomm;
        vec3 grassUp = normalize(up);
        vec3 base = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        vec3 camDir = normalize(cameraPosition - base);
        vec3 right = normalize(cross(grassUp, camDir));
        vec3 forward = cross(right, grassUp);
        float scale = 0.85 + fract(randomm.x + randomm.w * 2.0) * 0.45;
        mat3 tbn = mat3(right, forward, grassUp);
        vec3 local = tbn * (position * scale);
        float wind = sin(uTime * (0.25 + randomm.y * 0.3) + base.x * 0.05) * 0.08;
        local += right * wind * step(0.5, uv.y);
        vec3 repel = base - charPos;
        float repelLen = length(repel);
        if (repelLen > 0.001 && charSpeed > 0.01) {
          vec3 push = normalize(repel) * (1.0 - smoothstep(0.0, 1.2, repelLen)) * charSpeed * 0.35;
          push *= 1.0 - abs(dot(normalize(push), grassUp));
          local += push * step(0.5, uv.y);
        }
        vec4 wpBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float prog = assemblyProgAt(wpBase.xyz);
        vAssembly = 1.0 - prog;
        if (uAssemblyOn > 0.5) {
          local *= smoothstep(0.0, 0.65, prog);
        }
        vec4 wp = modelMatrix * instanceMatrix * vec4(local, 1.0);
        wPos = wp.xyz;
        vNormal = normalize((viewMatrix * vec4(grassUp, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      ${assemblyUniformDeclGLSL}
      ${colorSpaceGLSL()}
      ${triplanarGLSL()}
      ${applyTerrainColorGLSL()}
      ${inkAccentGLSL()}
      ${fogGLSL()}
      ${celShadeGLSL()}
      uniform sampler2D tGrass;
      uniform sampler2D tColors;
      uniform sampler2D tNoiseTerrain;
      uniform vec3 uLightDir;
      varying vec2 vUv;
      varying vec4 vRand;
      varying vec3 wPos;
      varying vec3 vNormal;
      varying float vAssembly;
      void main() {
        ${assemblyDiscardGLSL}
        float grassUVAmount = 12.0;
        float grassUVX = mix(vUv.x, 1.0 - vUv.x, step(0.5, vRand.w));
        vec2 grassUV = vec2(
          fract(grassUVX / grassUVAmount + (1.0 / grassUVAmount) * floor(vRand.y * grassUVAmount)),
          vUv.y * 0.5 + 0.5 * floor(mod(vRand.z * 2.0 + vRand.x * 3.32, 2.0))
        );
        if (texture2D(tGrass, grassUV).r > 0.095) discard;
        vec3 base = applyTerrainColor(normalize(vNormal), wPos, texture2D(tColors, vec2(0.15, 0.95)).rgb, tNoiseTerrain);
        base = applyAtlasInk(base, tColors, vec2(0.15, 0.95), 0.48);
        vec3 h = rgb2hsv(base);
        vec3 c2 = hsv2rgb(h - vec3(0.0, 0.0, 0.075));
        vec3 c3 = hsv2rgb(h + vec3(0.0, 0.0, 0.075));
        vec3 grassColor = mix(base, c2, step(0.5, fract(vRand.x * 34.324 + vRand.y * 21.231)));
        grassColor = mix(grassColor, c3, step(0.5, fract(vRand.z * 5.53 + vRand.w * 4.423)));
        float ndl = max(0.0, dot(normalize(vNormal), uLightDir));
        vec3 col = mix(inkShadow(grassColor), grassColor, celShade(ndl));
        col = applyWorldFog(col, wPos);
        vec3 outCol = col;
        ${assemblyGlowGLSL}
        float grassAlpha = 0.92;
        if (uAssemblyOn > 0.5) grassAlpha *= 1.0 - smoothstep(0.72, 0.90, vAssembly);
        gl_FragColor = vec4(outCol, grassAlpha);
      }
    `,
  });
}

function ensureGrassAttrs(geo) {
  const n = geo.attributes.position.count;
  if (!geo.getAttribute('up')) {
    const up = new Float32Array(n * 3);
    const pos = geo.attributes.position;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      up[i * 3] = x / len;
      up[i * 3 + 1] = y / len;
      up[i * 3 + 2] = z / len;
    }
    geo.setAttribute('up', new THREE.BufferAttribute(up, 3));
  }
  if (!geo.getAttribute('randomm')) {
    const rnd = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) rnd[i] = Math.random();
    geo.setAttribute('randomm', new THREE.BufferAttribute(rnd, 4));
  }
  return geo;
}

function buildGrassInstances(grassMetaGeo, bladeGeo) {
  if (!grassMetaGeo?.attributes?.position) return null;
  const meta = grassMetaGeo.attributes;
  const count = meta.position.count;
  if (!count) return null;

  const hasMatrix = meta.up && meta.randomm;
  const matrices = [];
  const ups = [];
  const rnds = [];

  for (let i = 0; i < count; i++) {
    const px = meta.position.getX(i);
    const py = meta.position.getY(i);
    const pz = meta.position.getZ(i);
    const m = new THREE.Matrix4();
    m.setPosition(px, py, pz);
    matrices.push(m);

    if (hasMatrix) {
      ups.push(meta.up.getX(i), meta.up.getY(i), meta.up.getZ(i));
      rnds.push(
        meta.randomm.getX(i), meta.randomm.getY(i),
        meta.randomm.getZ(i), meta.randomm.getW(i),
      );
    } else {
      const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
      ups.push(px / len, py / len, pz / len);
      const r = Math.random();
      rnds.push(r, Math.random(), Math.random(), Math.random());
    }
  }

  const merged = bladeGeo.clone();
  const inst = new THREE.InstancedMesh(merged, null, count);
  for (let i = 0; i < count; i++) inst.setMatrixAt(i, matrices[i]);
  inst.instanceMatrix.needsUpdate = true;

  inst.geometry.setAttribute('up', new THREE.InstancedBufferAttribute(new Float32Array(ups), 3));
  inst.geometry.setAttribute('randomm', new THREE.InstancedBufferAttribute(new Float32Array(rnds), 4));
  return inst;
}

export async function loadNatureDecor({
  parentGroup, ktx2, atlas, noiseTerrain, fogUniforms, onProgress,
}) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('assets/libs/draco/');
  const loadDrc = (url) => new Promise((resolve, reject) => {
    draco.load(url, resolve, undefined, reject);
  });

  const renderer = window.__renderer;
  let treeLeaves, treeDetail, grassBlades;
  try {
    treeLeaves = setupNatureMaskTexture(await ktx2.loadAsync('assets/images/tree-leaves.ktx2'), renderer);
    treeDetail = setupNatureMaskTexture(await ktx2.loadAsync('assets/images/tree-leaves-detail.ktx2'), renderer);
    grassBlades = setupNatureMaskTexture(await ktx2.loadAsync('assets/images/grass-blades-highq.ktx2'), renderer);
  } catch (e) {
    console.warn('Nature KTX2 textures failed', e);
    return { group: new THREE.Group(), update() {} };
  }

  const textures = { atlas, treeLeaves, treeDetail, grassBlades, noiseTerrain };
  const decorGroup = new THREE.Group();
  decorGroup.name = 'nature-decor';
  parentGroup.add(decorGroup);

  const chunks = [];
  const leafMat = createTreeLeavesMaterial(textures, fogUniforms);

  const leafGeos = [];
  for (let i = 0; i < TREE_FILES; i++) {
    try {
      const geo = await loadDrc(`assets/nature/tree-leaves_${i}.drc`);
      onProgress?.(`tree-leaves_${i}`);
      geo.computeBoundingSphere();
      leafGeos.push(geo);
      chunks.push({
        mesh: null,
        center: geo.boundingSphere.center.clone(),
        radius: geo.boundingSphere.radius,
      });
    } catch (e) {
      console.warn(`tree-leaves_${i} failed`, e);
    }
  }

  if (leafGeos.length) {
    const merged = mergeGeometries(leafGeos, false);
    if (merged) {
      merged.computeBoundingSphere();
      const leavesMesh = new THREE.Mesh(merged, leafMat);
      leavesMesh.name = 'tree-leaves';
      leavesMesh.castShadow = true;
      leavesMesh.receiveShadow = true;
      leavesMesh.visible = true;
      decorGroup.add(leavesMesh);
      chunks.length = 0;
      for (const geo of leafGeos) {
        chunks.push({
          mesh: leavesMesh,
          center: geo.boundingSphere.center.clone(),
          radius: geo.boundingSphere.radius,
        });
      }
    }
  }

  let grassMesh = null;
  try {
    const grassMeta = await loadDrc('assets/nature/grass.drc');
    onProgress?.('grass-meta');
    const blade = new THREE.PlaneGeometry(0.14, 0.7, 1, 3);
    blade.translate(0, 0.35, 0);
    blade.rotateX(-Math.PI / 2);
    ensureGrassAttrs(blade);
    grassMesh = buildGrassInstances(grassMeta, blade);
    if (grassMesh) {
      grassMesh.material = createGrassBladeMaterial(textures, fogUniforms);
      grassMesh.name = 'grass-blades';
      grassMesh.frustumCulled = true;
      grassMesh.castShadow = false;
      grassMesh.visible = true;
      decorGroup.add(grassMesh);
    }
  } catch (e) {
    console.warn('Grass decor failed', e);
  }

  function update(elapsed, playerPos, light) {
    if (leafMat) {
      leafMat.uniforms.uTime.value = elapsed;
      if (light) leafMat.uniforms.uLightDir.value.copy(light.position).normalize();
    }
    if (grassMesh?.material) {
      grassMesh.material.uniforms.uTime.value = elapsed;
      if (light) grassMesh.material.uniforms.uLightDir.value.copy(light.position).normalize();
      if (playerPos) grassMesh.material.uniforms.charPos.value.copy(playerPos);
    }
  }

  return { group: decorGroup, leavesMesh: decorGroup.children[0], grassMesh, update };
}
