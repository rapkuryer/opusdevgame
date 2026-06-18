// Texture / renderer helpers — messenger.abeto.co asset pipeline.
import * as THREE from 'three';

function maxAnisotropy(renderer, cap = 16) {
  const max = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  return Math.min(cap, max);
}

/** atlas.png — 16×16 indexed palette, nearest sampling (srgb-nearest). */
export function setupAtlasTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** KTX2 noise layers — linear + repeat + mips + high anisotropy. */
export function setupNoiseTexture(tex, renderer, { anisotropy = 16 } = {}) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = maxAnisotropy(renderer, anisotropy);
  return tex;
}

/** Grass / foliage alpha masks — crisp mips at all distances. */
export function setupNatureMaskTexture(tex, renderer, { anisotropy = 16 } = {}) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = maxAnisotropy(renderer, anisotropy);
  return tex;
}

/** Mesh / map textures for props and characters. */
export function setupColorMap(tex, renderer, { anisotropy = 16 } = {}) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = maxAnisotropy(renderer, anisotropy);
  return tex;
}

/** Abeto followCSM-ish directional shadow tuning. */
export function tuneDirectionalShadow(light, { mapSize = 2048, ortho = 24 } = {}) {
  light.castShadow = true;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 120;
  light.shadow.camera.left = -ortho;
  light.shadow.camera.right = ortho;
  light.shadow.camera.top = ortho;
  light.shadow.camera.bottom = -ortho;
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = 0.07;
}
