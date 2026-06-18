// ---------------------------------------------------------------------------
// Character physics — abeto collisionPhysics port (BVH capsule + auto-step).
// Ref: ~/abeto_analysis/extracted/character_physics.js
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { buildBVHCollider } from './bvhCollider.js';

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _vN = new THREE.Vector3();
const _vMove = new THREE.Vector3();
const _vPosPrev = new THREE.Vector3();
const _vDelta = new THREE.Vector3();
const _proxyUp = new THREE.Vector3();
const _capsule = new THREE.Line3();
const _capsulePrev = new THREE.Line3();
const _aabb = new THREE.Box3();
const _proxy = new THREE.Object3D();
const _nm = new THREE.Matrix3();
const _plane = new THREE.Plane();

export class CharacterPhysics {
  constructor(opts = {}) {
    this.substeps = opts.substeps ?? 3;
    this.positionForce = opts.positionForce ?? 0.005;
    this.jumpForce = opts.jumpForce ?? 0.15; // abeto planet scene
    this.gravity = opts.gravity ?? -0.00981;
    this.damp = opts.damp ?? 0.92;
    this.dampIdle = opts.dampIdle ?? 0.65;
    this.velocityCharDamp = opts.velocityCharDamp ?? 0.7;
    this.floorDetectInclination = opts.floorDetectInclination ?? 0.8;
    this.capsuleRadius = opts.capsuleRadius ?? 0.37;
    this.capsuleHeight = opts.capsuleHeight ?? 1.11;
    this.autoStep = opts.autoStep !== false;
    // abeto: step height min radius*0.1, max radius*1.5 (3 forward raycasts)
    this.sprintMultiplier = opts.sprintMultiplier ?? 1.1;

    this.collider = null;
    this.bvhGeo = null;
    this.sourceGeo = null;
    this.ready = Promise.resolve();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    this._accel = new THREE.Vector3();
    this._velPhys = new THREE.Vector3();
    this._velocityVariation = 0;
    this._velDampInterp = 0;

    // abeto fixed-timestep accumulator (frame-rate independent physics)
    this._positionPrev = new THREE.Vector3();
    this._positionNext = new THREE.Vector3();
    this._frameStart = new THREE.Vector3();
    this._accum = 0;
    this._physInit = false;

    this._isOnFloor = true;
    this._prevIsOnFloor = true;
    this._prevIsOnFloorTime = -1;
    this._isAutoStepping = false;
    this._needsToLand = false;
    this._jumpRequested = false;
    this._lastFloorPosition = new THREE.Vector3();
    this._groundGap = 0;
    this._jumpHoldUntil = 0; // kept for spawn-reset compatibility (main.js)

    this.GROUND_SNAP = opts.groundSnap ?? 0.012;
    this.AIR_GAP = opts.airGap ?? 0.14;

    this._shapecast = {
      intersectsBounds: (box) => box.intersectsBox(_aabb),
      intersectsTriangle: (tri) => {
        const r = this.capsuleRadius;
        const dist = tri.closestPointToSegment(_capsule, _vA, _vB);
        if (dist < r) {
          const atStart = _vB.equals(_capsule.start);
          const push = r - dist;
          const dir = _vB.sub(_vA).normalize();
          _capsule.start.addScaledVector(dir, push);
          _capsule.end.addScaledVector(dir, push);
          if (atStart && dir.dot(_proxyUp) > 0) {
            tri.getNormal(_vN);
            if (_vN.dot(_proxyUp) > this.floorDetectInclination) this._isOnFloor = true;
          }
        }
        return false;
      },
    };
  }

  async init(sourceGeo) {
    this.ready = buildBVHCollider(sourceGeo).then(({ sourceGeo: src, bvhGeo, collider }) => {
      this.sourceGeo = src;
      this.bvhGeo = bvhGeo;
      this.collider = collider;
      console.log('BVH collider ready, tris ≈', (bvhGeo.index?.count ?? 0) / 3 | 0);
    });
    await this.ready;
    return this;
  }

  get isOnFloor() { return this._prevIsOnFloor; }
  get groundGap() { return this._groundGap; }

  /** Debug: sample step heights ahead (bridge lip diagnosis). */
  probeAutoStep(player, ctrl, moveDir) {
    if (!this.collider) return null;
    _proxyUp.copy(ctrl.up);
    const up = _proxyUp;
    const r = this.capsuleRadius;
    const minH = r * 0.03;
    const maxH = r * 1.65;
    const samples = [];
    const probes = 5;
    const maxFwd = r * 2.2;

    for (let s = 1; s <= probes; s++) {
      const t = (s / probes) * maxFwd;
      _vA.copy(player.position).addScaledVector(moveDir, t).addScaledVector(up, r * 0.12);
      _vB.copy(_vA).addScaledVector(up, r * 2.5);
      this.raycaster.set(_vB, _vD.copy(up).negate());
      const hit = this.raycaster.intersectObject(this.collider, false)[0];
      if (!hit?.face) {
        samples.push({ t, rise: null, floorDot: null });
        continue;
      }
      _nm.getNormalMatrix(hit.object.matrixWorld);
      _vN.copy(hit.face.normal).applyMatrix3(_nm).normalize();
      _plane.setFromNormalAndCoplanarPoint(up, player.position);
      const rise = _plane.distanceToPoint(hit.point);
      samples.push({
        t: +t.toFixed(3),
        rise: +rise.toFixed(3),
        floorDot: +_vN.dot(up).toFixed(3),
        ok: rise > minH && rise < maxH && _vN.dot(up) >= this.floorDetectInclination,
      });
    }
    return { minH, maxH, samples };
  }

  _measureGround(player, up) {
    _vA.copy(player.position).addScaledVector(up, 0.015);
    this.raycaster.set(_vA, _vD.copy(up).negate());
    this.raycaster.far = 3;
    const hit = this.raycaster.intersectObject(this.collider, false)[0];
    this.raycaster.far = Infinity;
    if (!hit?.face) return { hit: null, gap: 999, walkable: false };
    _nm.getNormalMatrix(hit.object.matrixWorld);
    _vN.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    return {
      hit,
      gap: hit.distance - 0.015,
      walkable: _vN.dot(up) >= this.floorDetectInclination,
    };
  }

  update(player, ctrl, ratio, input = {}) {
    if (!this.bvhGeo?.boundsTree) return false;

    _proxyUp.copy(ctrl.up);
    const up = _proxyUp;

    // abeto: jump request latches until consumed on floor
    if (input.jumpRequested) this._jumpRequested = true;

    // Sync accumulator state to player (first run / external teleport / spawn)
    if (!this._physInit || player.position.distanceToSquared(this._positionNext) > 0.25) {
      this._positionNext.copy(player.position);
      this._positionPrev.copy(player.position);
      this._physInit = true;
    }
    this._frameStart.copy(this._positionNext);

    // abeto fixed-timestep loop — one physics tick per accumulated unit of ratio
    this._accum += ratio;
    let didJump = false;
    let steps = 0;
    while (this._accum >= 1) {
      this._accum -= 1;
      steps++;
      this._positionPrev.copy(this._positionNext);
      didJump = this._physicsTick(player, ctrl, up, input) || didJump;
      this._positionNext.copy(player.position);
    }

    // abeto _updatePosition: sub-frame interpolation for smooth rendering
    player.position.lerpVectors(this._positionPrev, this._positionNext, Math.min(1, this._accum));

    // horizontal speed for animation (units per 60fps frame → ×60 = u/s)
    _vC.copy(this._velPhys).addScaledVector(up, -this._velPhys.dot(up));
    const rawVH = this._prevIsOnFloor || steps > 0 ? _vC.length() : ctrl.vH ?? 0;

    ctrl.onGround = this._prevIsOnFloor;
    ctrl.vH = rawVH;
    ctrl.speed = rawVH * 60;
    return didJump;
  }

  /** One fixed-timestep physics tick (abeto _update inner body). */
  _physicsTick(player, ctrl, up, { moveDir, inputMag = 0, isMoving = false, sprint = false }) {
    player.position.copy(this._positionPrev);
    _vPosPrev.copy(this._positionPrev);
    this._isAutoStepping = false;

    // --- acceleration from input (abeto: e * positionForce, camera-rotated) ----
    this._accel.set(0, 0, 0);
    if (isMoving && moveDir?.lengthSq() > 1e-6) {
      const force = this.positionForce * inputMag * (sprint ? this.sprintMultiplier : 1);
      this._accel.copy(moveDir).multiplyScalar(force);

      // abeto auto-step: redirect accel toward step top while grounded.
      // abeto gates on _isOnFloor (which flickers per substep on radial-up
      // planets); we also accept the stable _prevIsOnFloor so stairs/curbs
      // step up every tick. No-op on flat ground (rise < minH → skipped).
      if (this.autoStep && (this._isOnFloor || this._prevIsOnFloor)) this._tryAutoStep(up);
    }

    // abeto: gravity only while NOT on floor (uses last tick's floor contact)
    if (!this._isOnFloor) this._accel.addScaledVector(up, this.gravity);

    this._velPhys.add(this._accel);
    this._accel.set(0, 0, 0);

    // abeto damp interpolation: idle (ground, no input) ramps toward idle damp
    const idle = !isMoving && this._prevIsOnFloor && !this._needsToLand;
    this._velDampInterp = idle
      ? this._velDampInterp + (0 - this._velDampInterp) * 0.05
      : 1;
    this._velPhys.multiplyScalar(this._lerp(this.dampIdle, this.damp, this._velDampInterp));

    // abeto: clampLength(0, radius * 0.9 * substeps)
    const maxV = this.capsuleRadius * 0.9 * this.substeps;
    if (this._velPhys.lengthSq() > maxV * maxV) this._velPhys.setLength(maxV);

    // abeto: shapecast in substeps re-asserts floor contact
    if (!this._isAutoStepping) this._isOnFloor = false;

    // abeto _substep — integrate velocity/substeps + capsule shapecast
    const sub = 1 / this.substeps;
    for (let i = 0; i < this.substeps; i++) {
      _vC.copy(this._velPhys).multiplyScalar(sub);
      player.position.add(_vC);
      const sep = this._performShapecast(player, sub);
      // abeto: separation cancels velocity into the surface, except while stepping
      if (!this._isAutoStepping && sep.lengthSq() > 1e-12) {
        this._velPhys.addScaledVector(sep, -sep.dot(this._velPhys));
      }
    }

    // --- velocity bookkeeping (abeto s.velocity / velocityVariation) -----------
    _vDelta.subVectors(player.position, this._positionPrev);
    ctrl.vel.add(_vDelta).multiplyScalar(this.velocityCharDamp);
    this._velocityVariation += _vDelta.length();
    this._velocityVariation *= this.velocityCharDamp;

    // abeto _detectJump: ground state, floor debounce, jump impulse
    const didJump = this._detectJump(player, up);
    // Settle feet onto the surface (abeto gates gravity off while grounded, so
    // nothing pulls the capsule down at rest → it would hover). Ease toward a
    // tiny gap; skip while rising so it never fights auto-step on stairs.
    this._settleToGround(player, up);
    return didJump;
  }

  _settleToGround(player, up) {
    if (this._needsToLand || this._isAutoStepping || !this._prevIsOnFloor) return;
    if (this._velPhys.dot(up) > 0.01) return; // rising (auto-step / jump arc)
    const g = this._measureGround(player, up);
    if (!g.walkable) return;
    if (g.gap > this.GROUND_SNAP && g.gap < 0.4) {
      const move = (g.gap - this.GROUND_SNAP) * 0.5; // ease down — smooth on steps
      player.position.addScaledVector(up, -move);
      this._groundGap = g.gap - move;
    }
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * abeto auto-step: 3 forward raycasts; if a walkable lip rises between
   * radius*0.1 and radius*1.5, redirect the whole acceleration toward the
   * step top so velocity lifts the capsule over it (no artificial teleport).
   */
  _tryAutoStep(up) {
    const r = this.capsuleRadius;
    _vMove.copy(this._accel);
    if (_vMove.lengthSq() < 1e-12) return;
    _vMove.normalize();

    const probes = 3;
    const maxFwd = r * 2;
    const minH = r * 0.1;
    const maxH = r * 1.5;

    for (let s = 0; s < probes; s++) {
      const t = (s + 1) / probes * maxFwd;
      _vA.copy(_vPosPrev).addScaledVector(_vMove, t);
      _vB.copy(_vA).addScaledVector(up, r * 2);
      this.raycaster.set(_vB, _vD.copy(up).negate());
      const hit = this.raycaster.intersectObject(this.collider, false)[0];
      if (!hit?.face) continue;

      _plane.setFromNormalAndCoplanarPoint(up, _vPosPrev);
      const rise = _plane.distanceToPoint(hit.point);
      if (rise <= minH || rise >= maxH) continue;

      _nm.getNormalMatrix(hit.object.matrixWorld);
      _vN.copy(hit.face.normal).applyMatrix3(_nm).normalize();
      if (_vN.dot(up) <= this.floorDetectInclination) continue;

      this._isAutoStepping = true;
      _vB.copy(hit.point).addScaledVector(up, rise * 0.5);
      const D = this._accel.length();
      const R = this.positionForce * 0.05;
      _vC.subVectors(_vB, _vPosPrev);
      if (_vC.lengthSq() < 1e-12) return;
      _vC.normalize();
      this._accel.copy(_vC).multiplyScalar(D + R);
      return;
    }
  }

  /**
   * abeto _detectJump: raycast down from feet, debounce floor transitions,
   * apply jump impulse while on floor. Sets _groundGap for animation.
   */
  _detectJump(player, up) {
    _vA.copy(player.position).addScaledVector(up, 0.005);
    this.raycaster.set(_vA, _vD.copy(up).negate());
    this.raycaster.far = 3;
    const hit = this.raycaster.intersectObject(this.collider, false)[0];
    this.raycaster.far = Infinity;
    const dist = hit ? hit.distance : Infinity;
    this._groundGap = hit ? Math.max(0, dist - 0.005) : 999;

    const far = dist > 0.25;                       // abeto: a
    const moving = this._velocityVariation > 0.01; // abeto: o

    // abeto: settle to floor when nearly stationary
    if (!this._isOnFloor && !moving) this._isOnFloor = true;

    if (this._prevIsOnFloor !== this._isOnFloor) {
      if (this._prevIsOnFloor) {
        const t = performance.now() * 0.001;
        if (this._prevIsOnFloorTime === -1) {
          this._prevIsOnFloorTime = t;
        } else if (t - this._prevIsOnFloorTime > 0.045 && far) {
          this._prevIsOnFloor = false;
          this._prevIsOnFloorTime = -1;
        }
      } else {
        this._prevIsOnFloor = true;
        this._prevIsOnFloorTime = -1;
        this._needsToLand = false;
      }
    } else {
      this._prevIsOnFloorTime = -1;
    }

    if (this._isOnFloor || this._prevIsOnFloor) {
      this._lastFloorPosition.copy(player.position);
    }

    let didJump = false;
    if (this._isOnFloor && this._jumpRequested) {
      this._jumpRequested = false;
      this._velPhys.addScaledVector(up, this.jumpForce);
      this._needsToLand = true;
      didJump = true;
    }
    return didJump;
  }

  _performShapecast(player, subScale = 1) {
    _proxy.position.copy(player.position);
    _proxy.quaternion.copy(player.quaternion);
    _proxy.updateMatrix();

    const r = this.capsuleRadius;
    _capsule.start.set(0, r, 0);
    _capsule.end.set(0, r + this.capsuleHeight, 0);
    _capsule.start.applyMatrix4(_proxy.matrix);
    _capsule.end.applyMatrix4(_proxy.matrix);
    _capsulePrev.copy(_capsule);

    _aabb.makeEmpty();
    _aabb.expandByPoint(_capsule.start);
    _aabb.expandByPoint(_capsule.end);
    _aabb.min.addScalar(-r);
    _aabb.max.addScalar(r);

    this.bvhGeo.boundsTree.shapecast(this._shapecast);

    const sep = _vA.subVectors(_capsule.start, _capsulePrev.start);
    const len = Math.max(0, sep.length() - 1e-5 * subScale);
    if (len < 1e-6) return _vA.set(0, 0, 0);

    sep.normalize();
    player.position.addScaledVector(sep, len);
    return sep;
  }

  /** Spawn-only: drop capsule onto the walkable surface and mark grounded. */
  _snapToGround(player, ctrl, ground = null) {
    if (!this.collider) return;
    const up = ctrl.up;
    const sample = ground ?? this._measureGround(player, up);
    if (!sample.walkable) return;
    const gap = sample.gap;
    if (gap > this.GROUND_SNAP && gap < 0.5) {
      player.position.addScaledVector(up, -(gap - this.GROUND_SNAP));
      this._groundGap = this.GROUND_SNAP;
    }
    this._isOnFloor = true;
    this._prevIsOnFloor = true;
    this._needsToLand = false;
  }

  probeGround(player, ctrl) {
    _proxyUp.copy(ctrl.up);
    const sample = this._measureGround(player, _proxyUp);
    this._groundGap = sample.gap;
    ctrl.onGround = sample.walkable && sample.gap < this.AIR_GAP && !this._needsToLand;
  }
}
