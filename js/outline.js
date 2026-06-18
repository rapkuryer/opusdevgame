// Inverted-hull ink outlines — messenger.abeto.co NPR style.
// SkinnedMesh (character) uses OutlinePass only — hull ink stays in bind-pose (T-pose blob).
import * as THREE from 'three';

export const INK = new THREE.Color(0x0a0908);

export function createOutlineMaterial(thickness = 0.02) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      thickness: { value: thickness },
      color: { value: INK },
    },
    vertexShader: `
      uniform float thickness;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 mvNormal = normalize(normalMatrix * normal);
        float distScale = clamp(-mvPosition.z * 0.048, 1.0, 6.0);
        mvPosition.xyz += mvNormal * thickness * distScale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      void main() { gl_FragColor = vec4(color, 1.0); }
    `,
  });
}

function hasInkShell(mesh) {
  return mesh.children?.some((c) => c.userData?.isInk);
}

/** Remove inverted-hull shells (e.g. after accidental skinned-mesh inkify). */
export function stripInkShells(root) {
  if (!root) return;
  const toRemove = [];
  root.traverse((o) => {
    if (o.userData?.isInk) toRemove.push(o);
  });
  for (const sh of toRemove) {
    sh.parent?.remove(sh);
    sh.geometry?.dispose?.();
    sh.material?.dispose?.();
  }
}

/** Attach inflated back-face ink shells to rigid meshes under root. */
export function inkify(root, thickness = 0.02, {
  skipNames = ['hitmesh'],
  skipInvisible = false,
} = {}) {
  if (!root) return root;
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || !o.geometry || o.userData.isInk || o.userData.noInk) return;
    if (skipInvisible && (!o.visible || o.material?.visible === false)) return;
    if (skipNames.includes(o.name)) return;
    if (hasInkShell(o)) return;
    const sh = new THREE.Mesh(o.geometry, createOutlineMaterial(thickness));
    sh.userData.isInk = true;
    sh.castShadow = false;
    sh.receiveShadow = false;
    sh.frustumCulled = o.frustumCulled;
    sh.renderOrder = (o.renderOrder ?? 0) - 1;
    o.add(sh);
  });
  return root;
}

/** Planet terrain + water + decor + signs — full world ink silhouettes. */
export function inkifyPlanet(planet, thickness = 0.034) {
  if (!planet?.group) return;
  inkify(planet.group, thickness, { skipNames: ['hitmesh'] });
  if (planet.natureDecor?.group) {
    inkify(planet.natureDecor.group, thickness * 0.9);
  }
  if (planet.signGroup) {
    inkify(planet.signGroup, thickness * 0.78);
  }
}

/** Re-apply ink on all loaded world layers (call after deferred LOD / decor). */
export function applyWorldNPR(planet) {
  inkifyPlanet(planet);
}
