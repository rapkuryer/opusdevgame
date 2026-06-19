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

/** Keep FBX textures — StandardMaterial + hard cel bands (no inverted-hull ink). */
export function applyOriginalCharacterMaterials(root, { anisotropy = 4 } = {}) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const upgrade = (src) => {
      if (!src) return src;
      const mat = new THREE.MeshStandardMaterial({
        map: src.map ?? null,
        normalMap: src.normalMap ?? null,
        color: src.color?.clone() ?? new THREE.Color(0xffffff),
        roughness: 0.52,
        metalness: 0.02,
        emissive: new THREE.Color(0x2a2018),
        emissiveIntensity: 0.28,
        fog: false,
      });
      for (const key of ['map', 'normalMap', 'emissiveMap']) {
        tuneTexture(mat[key], anisotropy);
      }
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
          {
            float lum = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
            float cel = step(0.30, lum);
            vec3 shadowCol = vec3(0.035, 0.030, 0.028);
            outgoingLight = mix(shadowCol, outgoingLight, cel);
          }
          outgoingLight = pow(outgoingLight, vec3(0.86));
          outgoingLight *= 1.26;`,
        );
      };
      mat.customProgramCacheKey = () => 'ch19-character-cel-v3';
      mat.needsUpdate = true;
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(upgrade) : upgrade(o.material);
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
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          `vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
          {
            float lum = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
            float lit = step(0.22, lum);
            vec3 shadowCol = vec3(0.028, 0.024, 0.032);
            outgoingLight = mix(shadowCol, outgoingLight, lit);
          }`,
        );
      };
      mat.customProgramCacheKey = () => 'messenger-character-v1';
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
  });
}
