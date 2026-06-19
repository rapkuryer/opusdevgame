// Character materials — preserve authored FBX colors at full brightness.
import * as THREE from 'three';

export function createCharacterToonGradient() {
  const d = new Uint8Array([0, 0, 0, 255]);
  const t = new THREE.DataTexture(d, d.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function tuneTexture(tex, anisotropy) {
  if (!tex) return;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  if (tex.image) {
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
  }
  tex.needsUpdate = true;
}

/** Tune loader-authored FBX materials in place — never replace (keeps skinning/maps intact). */
export function applyOriginalCharacterMaterials(root, { anisotropy = 4 } = {}) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const tune = (src) => {
      if (!src) return src;
      tuneTexture(src.map, anisotropy);
      tuneTexture(src.normalMap, anisotropy);
      tuneTexture(src.emissiveMap, anisotropy);
      if ('roughness' in src) src.roughness = 0.52;
      if ('metalness' in src) src.metalness = 0.02;
      if (src.emissive?.isColor) src.emissive.setHex(0x2a2018);
      if ('emissiveIntensity' in src) {
        src.emissiveIntensity = Math.max(src.emissiveIntensity ?? 0, 0.22);
      }
      src.fog = false;
      src.transparent = false;
      src.opacity = 1;
      src.depthWrite = true;
      src.side = THREE.FrontSide;
      // Drop any custom shader hooks (broken outfit/cel patches made the mesh outline-only).
      delete src.onBeforeCompile;
      delete src.customProgramCacheKey;
      src.needsUpdate = true;
      return src;
    };
    o.material = Array.isArray(o.material) ? o.material.map(tune) : tune(o.material);
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.userData.isCharacterMesh = true;
  });
}

export function applyMessengerCharacterMaterial(root, gradient) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const conv = (m) => {
      const mat = new THREE.MeshToonMaterial({ gradientMap: gradient, fog: true });
      if (m?.map) {
        mat.map = m.map;
        mat.map.colorSpace = THREE.SRGBColorSpace;
      } else if (m?.color) {
        mat.color.copy(m.color);
      }
      mat.customProgramCacheKey = () => 'messenger-character-v2';
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
  });
}
