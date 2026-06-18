// Fixed 3D megastructures — Piranesi / megalophobia pillars & arches.
// Anchored to planet centre (never spins with camera). Real geometry, not sky paint.
import * as THREE from 'three';

const PILLAR_COUNT = 32;
const PILLAR_HEIGHT = 100;
const PILLAR_R_BASE = 3.2;
const PILLAR_R_TOP = 2.2;
const CLOUD_LIFT = 42;
const VIS_DOT = -0.05;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function pillarMaterial() {
  return new THREE.MeshLambertMaterial({
    color: 0x4a1828,
    fog: true,
  });
}

function archMaterial() {
  return new THREE.MeshLambertMaterial({
    color: 0x3a1420,
    fog: true,
  });
}

function cloudMaterial() {
  return new THREE.MeshLambertMaterial({
    color: 0xf2f6fa,
    transparent: true,
    opacity: 0.82,
    fog: true,
    depthWrite: false,
  });
}

function orientRadial(mesh, dir, surfaceR, lift = 0) {
  const base = _v0.copy(dir).multiplyScalar(surfaceR + lift);
  mesh.position.copy(base).addScaledVector(dir, mesh.userData.halfH || 0);
  _q.setFromUnitVectors(_up, dir);
  mesh.quaternion.copy(_q);
}

function buildArch(parent, dirA, dirB, surfaceR, mat) {
  const topA = _v0.copy(dirA).multiplyScalar(surfaceR + PILLAR_HEIGHT);
  const topB = _v1.copy(dirB).multiplyScalar(surfaceR + PILLAR_HEIGHT);
  const mid = topA.clone().add(topB).multiplyScalar(0.5);
  const span = topA.distanceTo(topB);
  const lift = span * 0.22;
  mid.addScaledVector(mid.clone().normalize(), lift);

  const curve = new THREE.QuadraticBezierCurve3(topA, mid, topB);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 12, 1.6, 6, false),
    mat,
  );
  tube.castShadow = false;
  tube.receiveShadow = false;
  parent.add(tube);
  return tube;
}

/**
 * @param {THREE.Group} parent — planet-present group (world origin)
 * @param {number} surfaceR — planet surface radius
 * @param {THREE.Vector3} [hubDir] — ring centred near spawn / city
 */
export function buildMegaStructures(parent, surfaceR, hubDir) {
  const group = new THREE.Group();
  group.name = 'mega-structures';
  parent.add(group);

  const hub = hubDir ? hubDir.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const ref = Math.abs(hub.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(ref, hub).normalize();
  const north = new THREE.Vector3().crossVectors(hub, east).normalize();

  const pMat = pillarMaterial();
  const aMat = archMaterial();
  const cMat = cloudMaterial();
  const dirs = [];
  const pillars = [];
  const clouds = [];

  const cylGeo = new THREE.CylinderGeometry(PILLAR_R_TOP, PILLAR_R_BASE, PILLAR_HEIGHT, 10, 1);

  // Horizon ring — pillars sit where you look "across", not painted on a spinning dome
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const a = (i / PILLAR_COUNT) * Math.PI * 2;
    const dir = east.clone().multiplyScalar(Math.cos(a)).addScaledVector(north, Math.sin(a)).normalize();
    dirs.push(dir.clone());

    const pillar = new THREE.Mesh(cylGeo, pMat);
    pillar.userData.halfH = PILLAR_HEIGHT * 0.5;
    pillar.userData.dir = dir;
    orientRadial(pillar, dir, surfaceR);
    pillar.castShadow = true;
    pillar.receiveShadow = false;
    group.add(pillar);
    pillars.push(pillar);

    const cloud = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 8), cMat);
    cloud.userData.halfH = 0;
    cloud.userData.dir = dir;
    orientRadial(cloud, dir, surfaceR, CLOUD_LIFT);
    group.add(cloud);
    clouds.push(cloud);
  }

  const arches = [];
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const j = (i + 1) % PILLAR_COUNT;
    arches.push(buildArch(group, dirs[i], dirs[j], surfaceR, aMat));
    if (i % 3 === 0) {
      const k = (i + 2) % PILLAR_COUNT;
      const h = PILLAR_HEIGHT * 0.62;
      const topI = dirs[i].clone().multiplyScalar(surfaceR + h);
      const topK = dirs[k].clone().multiplyScalar(surfaceR + h);
      const mid = topI.clone().add(topK).multiplyScalar(0.5).normalize()
        .multiplyScalar(surfaceR + h + 12);
      const curve = new THREE.QuadraticBezierCurve3(topI, mid, topK);
      arches.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 8, 1.1, 5, false), aMat));
      group.add(arches[arches.length - 1]);
    }
  }

  const lightShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 2.5, PILLAR_HEIGHT * 1.1, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xdce8ff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: true,
    }),
  );
  lightShaft.userData.halfH = PILLAR_HEIGHT * 0.55;
  orientRadial(lightShaft, hub, surfaceR);
  group.add(lightShaft);

  function update(playerPos) {
    if (!playerPos) return;
    const pDir = _v0.copy(playerPos).normalize();
    for (const p of pillars) {
      p.visible = pDir.dot(p.userData.dir) > VIS_DOT;
    }
    for (const c of clouds) {
      c.visible = pDir.dot(c.userData.dir) > VIS_DOT;
    }
  }

  return { group, pillars, clouds, arches, update };
}
