// Character materials — preserve authored FBX colors at full brightness.
import * as THREE from 'three';
import { CHAR_HEIGHT } from './config.js';

const outfitUniforms = {
  skin: { value: new THREE.Color(0xffffff) },
  top: { value: new THREE.Color(0xffffff) },
  bottom: { value: new THREE.Color(0xffffff) },
  strength: { value: 0.72 },
};

function hexToColor(hex) {
  return new THREE.Color(hex);
}

function injectOutfitTint(shader) {
  shader.uniforms.uOutfitSkin = outfitUniforms.skin;
  shader.uniforms.uOutfitTop = outfitUniforms.top;
  shader.uniforms.uOutfitBottom = outfitUniforms.bottom;
  shader.uniforms.uOutfitStrength = outfitUniforms.strength;

  shader.fragmentShader = `
uniform vec3 uOutfitSkin;
uniform vec3 uOutfitTop;
uniform vec3 uOutfitBottom;
uniform float uOutfitStrength;
` + shader.fragmentShader;

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#include <map_fragment>
    {
      float torsoBand = smoothstep(0.18, 0.55, vUv.y);
      float headBand = smoothstep(0.58, 0.88, vUv.y);
      vec3 bodyTint = mix(
        mix(vec3(1.0), uOutfitBottom, uOutfitStrength),
        mix(vec3(1.0), uOutfitTop, uOutfitStrength),
        torsoBand
      );
      vec3 regionTint = mix(bodyTint, mix(vec3(1.0), uOutfitSkin, uOutfitStrength), headBand);
      diffuseColor.rgb *= regionTint;
    }`,
  );
}

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
        injectOutfitTint(shader);
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
      mat.customProgramCacheKey = () => 'ch19-character-cel-outfit-v2';
      mat.needsUpdate = true;
      return mat;
    };
    o.material = Array.isArray(o.material) ? o.material.map(upgrade) : upgrade(o.material);
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.userData.isCharacterMesh = true;
    o.userData.outfitMesh = true;
  });
}

/** Apply wardrobe palette to Capoeira FBX (regional UV tint + optional hat). */
export function applyFbxOutfitColors(root, outfit, palette) {
  if (!root || !outfit || !palette) return;
  outfitUniforms.skin.value.copy(hexToColor(palette.skin[outfit.skin] ?? palette.skin[0]));
  outfitUniforms.top.value.copy(hexToColor(palette.top[outfit.top] ?? palette.top[0]));
  outfitUniforms.bottom.value.copy(hexToColor(palette.bottom[outfit.bottom] ?? palette.bottom[0]));

  const hatIdx = outfit.hat ?? 0;
  let hatGroup = root.userData.hatGroup;
  if (hatGroup) {
    root.remove(hatGroup);
    hatGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) o.material.dispose?.();
    });
    root.userData.hatGroup = null;
  }
  if (hatIdx > 0) {
    const hatColor = hexToColor(palette.hat[hatIdx] ?? palette.hat[1]);
    hatGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: hatColor,
      roughness: 0.55,
      metalness: 0.02,
      fog: false,
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.2, 10), mat);
    cone.position.y = 0.1;
    cone.castShadow = true;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.025, 14), mat);
    brim.position.y = 0.02;
    brim.castShadow = true;
    hatGroup.add(cone, brim);
    hatGroup.position.set(0, (root.userData.headY ?? CHAR_HEIGHT * 0.88) + 0.06, 0);
    root.add(hatGroup);
    root.userData.hatGroup = hatGroup;
  }

  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat?.isMeshStandardMaterial) mat.needsUpdate = true;
    }
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
