// ---------------------------------------------------------------------------
// BVH collider — abeto collisionworker pattern (build once, fast queries).
// Abeto builds in a Web Worker; we build synchronously during planet load (once).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { ensureSkipCollision } from './collisionUtils.js';

export class ColliderMesh extends THREE.Mesh {
  raycast(raycaster, intersects) {
    acceleratedRaycast.call(this, raycaster, intersects);
  }
}

/**
 * @param {THREE.BufferGeometry} sourceGeo — local hitmesh (keeps skipcollision + attrs)
 * @returns {Promise<{ sourceGeo, bvhGeo, collider, bvh }>}
 */
export async function buildBVHCollider(sourceGeo) {
  ensureSkipCollision(sourceGeo);
  sourceGeo.computeBoundingBox();
  sourceGeo.computeBoundingSphere();

  const bvhGeo = sourceGeo.clone();
  bvhGeo.applyMatrix4(new THREE.Matrix4());
  bvhGeo.computeBoundingBox();
  bvhGeo.computeBoundingSphere();

  // Yield so loader UI can paint before the one-time BVH build.
  await new Promise((r) => setTimeout(r, 16));
  const bvh = new MeshBVH(bvhGeo, { lazyGeneration: true });
  bvhGeo.boundsTree = bvh;

  const collider = new ColliderMesh(bvhGeo, new THREE.MeshBasicMaterial({ visible: false }));
  collider.name = 'bvh-collider';

  return { sourceGeo, bvhGeo, collider, bvh };
}
