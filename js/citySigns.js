// $OPUSDEV on every sign plaque — wall boards, pole circles, vertical banners.
import * as THREE from 'three';
import { getOpusDevSignTexture, getOpusDevBlueSignTexture, getOpusDevPoleTexture } from './opusDevBrand.js';

const _center = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/** Sign plaque cluster from assets/signs.json — horizontal, vertical, or circular. */
function isSignPlaque(sign) {
  const [nx, ny, nz] = sign.normal;
  const [cx, cy, cz] = sign.center;
  const r = Math.hypot(cx, cy, cz) || 1;
  const dotUp = Math.abs(nx * (cx / r) + ny * (cy / r) + nz * (cz / r));
  if (dotUp > 0.55) return false;
  if (sign.area > 1.2 || sign.area < 0.02) return false;
  if (sign.faces < 6 || sign.faces > 120) return false;
  return true;
}

function dedupeSigns(signs) {
  const seen = new Set();
  const out = [];
  for (const sign of signs) {
    const key = sign.center.map((v) => Math.round(v * 40)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sign);
  }
  return out;
}

function orientSignPlane(mesh, center, normal, inset = 0.04) {
  _center.fromArray(center);
  _normal.fromArray(normal).normalize();
  _up.copy(_center).normalize();
  if (Math.abs(_normal.dot(_up)) > 0.92) _up.set(0, 1, 0);
  _tangent.crossVectors(_up, _normal).normalize();
  if (_tangent.lengthSq() < 1e-6) _tangent.set(1, 0, 0);
  _bitangent.crossVectors(_normal, _tangent).normalize();
  _m.makeBasis(_tangent, _bitangent, _normal);
  _q.setFromRotationMatrix(_m);
  mesh.quaternion.copy(_q);
  mesh.position.copy(_center).addScaledVector(_normal, inset);
}

function signDimensions(sign) {
  const u = sign.uvSpan[0];
  const v = sign.uvSpan[1];
  const aspect = u / Math.max(v, 0.01);
  const base = Math.sqrt(sign.area);
  const isVertical = aspect < 0.85;
  const isSquare = aspect > 0.75 && aspect < 1.35;

  if (isSquare || (u < 0.14 && v < 0.14)) {
    const s = THREE.MathUtils.clamp(base * 1.35 + Math.max(u, v) * 0.8, 0.28, 1.1);
    return { w: s, h: s, pole: true };
  }
  if (isVertical) {
    const h = THREE.MathUtils.clamp(base * 1.5 + v * 1.1, 0.35, 2.4);
    const w = THREE.MathUtils.clamp(h * 0.42, 0.2, 0.95);
    return { w, h, pole: false };
  }
  const w = THREE.MathUtils.clamp(base * 1.55 + u * 0.95, 0.4, 2.4);
  const h = THREE.MathUtils.clamp(w * 0.36, 0.16, 0.85);
  return { w, h, pole: false };
}

function createSignMaterial(tex) {
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

/** Flush $OPUSDEV planes on every sign plaque (shader also replaces atlas glyphs). */
export async function installCitySignOverlays(planetGroup) {
  let signs = [];
  try {
    const res = await fetch('assets/signs.json');
    if (res.ok) signs = await res.json();
  } catch (e) {
    console.warn('citySigns: could not load assets/signs.json', e);
    return null;
  }

  const filtered = dedupeSigns(signs.filter(isSignPlaque));
  const boardTex = getOpusDevSignTexture();
  const blueTex = getOpusDevBlueSignTexture();
  const poleTex = getOpusDevPoleTexture();
  const group = new THREE.Group();
  group.name = 'opusdev-signs';

  for (const sign of filtered) {
    const { w, h, pole } = signDimensions(sign);
    const aspect = sign.uvSpan[0] / Math.max(sign.uvSpan[1], 0.01);
    const isBlueBoard = !pole && aspect > 1.05;
    const tex = pole ? poleTex : (isBlueBoard ? blueTex : boardTex);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), createSignMaterial(tex));
    mesh.name = pole ? 'opusdev-pole-sign' : 'opusdev-sign';
    mesh.renderOrder = 4;
    mesh.userData.noInk = true;
    mesh.userData.asmBaseScale = 1;
    orientSignPlane(mesh, sign.center, sign.normal, pole ? 0.03 : 0.045);
    group.add(mesh);
  }

  planetGroup.add(group);
  console.log(`[citySigns] ${group.children.length} sign plaques (from ${signs.length} candidates)`);
  return group;
}
