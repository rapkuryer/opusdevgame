// ---------------------------------------------------------------------------
// followCamera — messenger.abeto.co followCamera (present scene)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { isSkipCollisionHit } from './collisionUtils.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const lerpCoefFPS = (rate, r) => 1 - Math.exp(Math.log(1 - rate) * r);
const lerpFPS = (a, b, rate, r) => a + (b - a) * lerpCoefFPS(rate, r);
const fit = (x, a, b, c, d) => {
  const lo = Math.min(c, d), hi = Math.max(c, d);
  return Math.max(lo, Math.min(hi, c + (x - a) * (d - c) / (b - a)));
};
const shortestTarget = (from, to) => {
  const i = ((from % TAU) + TAU) % TAU;
  let s = ((to % TAU) + TAU) % TAU;
  if (Math.abs(s - i) > Math.PI) s += s > i ? -TAU : TAU;
  return from + s - i;
};
/** Lerp angles without π-wrap jerk. */
const lerpAngle = (from, to, t) => {
  const tgt = shortestTarget(from, to);
  return from + (tgt - from) * t;
};

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _vE = new THREE.Vector3();
const _worldY = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _hitN = new THREE.Vector3();

/** Abeto ps() — spherical offset in character tangent frame. */
function sphericalToOffset(sph, quat, up, rotationH, out) {
  out.setFromSpherical(sph);
  out.applyQuaternion(quat);
  out.applyAxisAngle(up, Math.PI - rotationH);
  return out;
}

export function createFollowCamera(camera, opts = {}) {
  const PHI_MIN = Math.PI * 0.25;
  const PHI_MAX = Math.PI * 0.75;

  const relPos = new THREE.Vector3(...(opts.relativePosition || [0, 1, 5]));
  const followedMeshOffset = new THREE.Vector3(...(opts.offset || [-0.5, 0, 1]));
  const followedMeshOffsetTarget = new THREE.Vector3();
  const followedMeshOffsetDistance = followedMeshOffset.length();

  const spherical = new THREE.Spherical();
  const sphericalTarget = new THREE.Spherical();
  const sphericalWork = new THREE.Spherical();
  const sphericalBlend = new THREE.Spherical();

  const touchPos = { x: 0, y: 0 };
  const addDisp = { theta: 0, phi: 0 };
  let orbitYaw = 0;
  // abeto baseCamera.displacement.position — screen parallax on shoulder cam
  const DISP_POS_X = opts.displacement?.[0] ?? -0.075;
  const DISP_POS_Y = opts.displacement?.[1] ?? -0.05;
  const DISP_X_RANGE = opts.dispXRange ?? Math.PI * 0.62;
  const LOOK_PER_SCREEN = 2 * DISP_X_RANGE * Math.abs(DISP_POS_X);
  const touchSmooth = 0.1;
  const lerpPosition = 0.05;

  spherical.setFromVector3(relPos);
  spherical.phi = THREE.MathUtils.clamp(spherical.phi, PHI_MIN, PHI_MAX);
  const followedMeshPhi = spherical.phi;
  const followedMeshDistance = spherical.radius;
  sphericalTarget.copy(spherical);

  const baseTarget = new THREE.Vector3();
  const followedMeshTarget = new THREE.Vector3();

  const targetLocalLerp = 0.0125;
  const targetWorldLerp = 0.175;
  const rotationLerp = 0.03;
  const sphericalRotLerp = 0.075;
  const sphericalRotFastLerp = 0.3;
  const sphericalRadiusLerp = 0.035;
  const sphericalRadiusCollisionsLerp = 0.35;
  const centeringInactiveLerp = 0.0125;
  const inactiveMultiplier = 0.025;
  const collisionIncrement = 0.05;
  const minCameraRadius = () => followedMeshDistance * 0.72;

  let automaticCenteringAmount = 1;
  let collider = null;
  let bvhGeo = null;
  let sourceGeo = null;

  function capsuleHead(player, out) {
    const model = player.children.find((c) => c.userData?.isFBX);
    const headY = model?.userData?.headY ?? 0.88;
    out.set(0, headY, 0).applyQuaternion(player.quaternion).add(player.position);
    return out;
  }

  function isBlockingWallHit(hit, rayDir, up) {
    if (!hit?.face) return false;
    if (sourceGeo && bvhGeo && isSkipCollisionHit(hit, sourceGeo, bvhGeo)) return false;
    _hitN.copy(hit.face.normal);
    if (hit.object?.matrixWorld) _hitN.transformDirection(hit.object.matrixWorld);
    _hitN.normalize();
    if (_hitN.dot(up) > 0.5) return false;
    return _hitN.dot(rayDir) < -0.05;
  }

  function resetRadius() {
    spherical.radius = followedMeshDistance;
    sphericalTarget.radius = followedMeshDistance;
  }

  return {
    setCollider(mesh) {
      collider = mesh;
      bvhGeo = null;
      sourceGeo = null;
    },

    setBVHCollider({ collider: c, bvhGeo: bvh, sourceGeo: src }) {
      collider = c;
      bvhGeo = bvh;
      sourceGeo = src;
      resetRadius();
    },

    getTheta() { return spherical.theta; },

    initFromHeading(heading) {
      spherical.theta = shortestTarget(spherical.theta, heading);
      sphericalTarget.theta = spherical.theta;
      resetRadius();
    },

    setPointerParallax(nx, ny, ratio) {
      const f = lerpCoefFPS(touchSmooth, ratio);
      const tx = fit(nx, -1, 1, -HALF_PI, HALF_PI);
      const ty = fit(ny, 1, -1, -HALF_PI, HALF_PI);
      touchPos.x += (tx - touchPos.x) * f;
      touchPos.y += (ty - touchPos.y) * f;
    },

    /** Horizontal look — accumulates for full 360° at the same drag speed as before. */
    addPointerDeltaX(dxPx, viewportW) {
      if (!viewportW || !dxPx) return;
      orbitYaw -= (dxPx / viewportW) * LOOK_PER_SCREEN;
    },

    resetOrbitYaw() {
      orbitYaw = 0;
      addDisp.theta = 0;
    },

    update({
      player,
      rotationHorizontal,
      up,
      quaternion,
      isMoving,
      ratio,
      frame = 0,
    }) {
      if (!Number.isFinite(rotationHorizontal)) rotationHorizontal = 0;
      if (!Number.isFinite(spherical.theta)) spherical.theta = rotationHorizontal;
      if (!Number.isFinite(sphericalTarget.theta)) sphericalTarget.theta = spherical.theta;

      // abeto: constant target lerp (no speed-up while moving)
      const b = lerpCoefFPS(targetLocalLerp, ratio);
      const T = lerpCoefFPS(targetWorldLerp, ratio);

      capsuleHead(player, _vA);
      _vB.copy(followedMeshOffset).applyQuaternion(quaternion);
      if (collider && (frame & 3) === 0 && _vB.lengthSq() > 1e-8) {
        _vD.copy(_vB).normalize();
        _ray.set(_vA, _vD);
        const offHit = _ray.intersectObject(collider, false)[0];
        if (offHit && offHit.distance < followedMeshOffsetDistance) _vB.set(0, 0, 0);
      }
      if (sphericalTarget.radius < followedMeshDistance * 0.75) _vB.set(0, 0, 0);

      followedMeshOffsetTarget.lerp(_vB, b);
      _vE.copy(_vA).add(followedMeshOffsetTarget);
      followedMeshTarget.lerp(_vE, T);
      baseTarget.lerp(followedMeshTarget, T);

      // abeto: flatten camera offset on world XZ, compare to forward on world Y
      _vC.setFromSpherical(spherical);
      _vC.setY(0);
      if (_vC.lengthSq() > 1e-8) _vC.normalize();
      _vD.set(0, 0, -1).applyAxisAngle(_worldY, rotationHorizontal);
      const alignment = _vC.lengthSq() > 1e-8 ? fit(_vC.dot(_vD), 1, 0, 0, 1) : 1;
      const D = isMoving ? alignment : inactiveMultiplier;

      automaticCenteringAmount += (1 - automaticCenteringAmount)
        * lerpCoefFPS(centeringInactiveLerp, ratio);

      const yawTarget = shortestTarget(sphericalTarget.theta, rotationHorizontal);
      const yawT = lerpCoefFPS(rotationLerp * D * automaticCenteringAmount, ratio);
      sphericalTarget.theta = lerpAngle(sphericalTarget.theta, yawTarget, yawT);
      sphericalTarget.phi += (followedMeshPhi - sphericalTarget.phi)
        * lerpCoefFPS(rotationLerp * automaticCenteringAmount, ratio);

      const minR = minCameraRadius();
      const step = followedMeshDistance * collisionIncrement;
      let O = sphericalTarget.radius;

      const runCollision = collider && isMoving && (frame & 3) === 0;
      if (runCollision) {
        sphericalWork.copy(sphericalTarget);
        sphericalToOffset(sphericalWork, quaternion, up, rotationHorizontal, _vC);
        _vC.add(baseTarget);
        const distToPlayer = sphericalWork.radius - _vC.distanceTo(player.position);
        _vD.subVectors(_vC, baseTarget);
        if (_vD.lengthSq() > 1e-8) {
          const rayDir = _vD.normalize();
          _ray.set(baseTarget, rayDir);
          _ray.far = followedMeshDistance + 1;
          const wallHit = _ray.intersectObject(collider, false)[0];
          if (wallHit && isBlockingWallHit(wallHit, rayDir, up)
              && wallHit.distance < followedMeshDistance
              && wallHit.distance > distToPlayer
              && wallHit.distance > 0.05) {
            O = Math.max(minR, wallHit.distance * 0.92);
          }
        }
      } else if (!isMoving) {
        O = Math.min(followedMeshDistance, sphericalTarget.radius + step * ratio * 2);
      }

      O = Math.max(minR, Math.min(followedMeshDistance, O));
      sphericalTarget.radius = lerpFPS(
        sphericalTarget.radius, O, sphericalRadiusCollisionsLerp, ratio,
      );

      sphericalBlend.copy(sphericalTarget);
      sphericalBlend.makeSafe();

      // present scene — player control → fast spherical catch-up (abeto)
      const N = lerpCoefFPS(sphericalRotFastLerp, ratio);
      const H = lerpCoefFPS(sphericalRadiusLerp, ratio);
      spherical.phi += (sphericalBlend.phi - spherical.phi) * N;
      spherical.theta = lerpAngle(spherical.theta, sphericalBlend.theta, N);
      spherical.radius += (sphericalBlend.radius - spherical.radius) * H;
      spherical.radius = Math.max(minR, Math.min(followedMeshDistance, spherical.radius));
      spherical.makeSafe();
      if (!Number.isFinite(spherical.theta)) spherical.theta = rotationHorizontal;

      sphericalToOffset(spherical, quaternion, up, rotationHorizontal, _vC);
      const basePosition = _vE.copy(baseTarget).add(_vC);

      const dispT = lerpCoefFPS(lerpPosition, ratio);
      addDisp.theta += ((orbitYaw + touchPos.x * DISP_POS_X) - addDisp.theta) * dispT;
      addDisp.phi += ((touchPos.y * DISP_POS_Y) - addDisp.phi) * dispT;

      _forward.subVectors(basePosition, baseTarget);
      const offLen = _forward.length();
      if (offLen < 1e-6) {
        camera.position.copy(basePosition);
      } else {
        _forward.divideScalar(offLen);
        _right.crossVectors(up, _forward);
        if (_right.lengthSq() < 1e-6) {
          camera.position.copy(basePosition);
        } else {
          _right.normalize();
          _camUp.crossVectors(_forward, _right);
          if (_camUp.lengthSq() < 1e-6) {
            camera.position.copy(basePosition);
          } else {
            _camUp.normalize();
            _offset.subVectors(basePosition, baseTarget);
            if (Math.abs(addDisp.phi) > 1e-8) _offset.applyAxisAngle(_right, addDisp.phi);
            if (Math.abs(addDisp.theta) > 1e-8) _offset.applyAxisAngle(_camUp, addDisp.theta);
            camera.position.copy(baseTarget).add(_offset);
          }
        }
      }
      if (!Number.isFinite(camera.position.x)) camera.position.copy(basePosition);

      camera.up.copy(up);
      camera.lookAt(baseTarget);
    },
  };
}
