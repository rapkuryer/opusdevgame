// ---------------------------------------------------------------------------
// Abeto collision helpers — skipcollision lookup for camera BVH queries.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

/** First vertex of hit triangle → skipcollision on source hitmesh geometry. */
export function isSkipCollisionHit(hit, sourceGeo, bvhGeo) {
  if (!hit || hit.faceIndex == null || !sourceGeo?.attributes?.skipcollision) return false;
  const idx = bvhGeo?.index;
  const vi = idx ? idx.array[hit.faceIndex * 3] : hit.faceIndex * 3;
  if (vi < 0 || vi >= sourceGeo.attributes.skipcollision.count) return false;
  return sourceGeo.attributes.skipcollision.array[vi] > 0;
}

/** Mark outward-facing walkable surfaces — aggressive so camera ignores terrain. */
export function ensureSkipCollision(geo) {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  if (!pos || !norm) return;
  const existing = geo.getAttribute('skipcollision');
  const skip = existing ? existing.array : new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const dot = (norm.getX(i) * x + norm.getY(i) * y + norm.getZ(i) * z) / len;
    // terrain + shallow slopes = skip camera collision (abeto artist data ≈ walkable)
    skip[i] = dot > 0.45 ? 1 : 0;
  }
  if (!existing) {
    geo.setAttribute('skipcollision', new THREE.BufferAttribute(skip, 1));
  }
}
