// ---------------------------------------------------------------------------
// Test players — lightweight AI couriers that wander & run the planet surface
// using the same surface-walk logic as the hero (tangent move + ray-snap to the
// collider + feet-to-normal orientation). They run with the procedural leg/arm
// swing, so they read like real remote players. Pure visual NPCs (no physics
// capsule) — cheap enough for 10+ at once.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _ref = new THREE.Vector3();
const _east = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export function createBots({ scene, planet, makeAvatar, count = 10, center = null, height = 1.85, getFocus = null }) {
  const radius = planet.radius;
  const bots = [];

  // Place bots on a ring around the spawn: angular distance keeps them 8..27 units
  // away (visible, never blocking the camera), spread evenly around the player.
  const minAng = 8 / radius;
  const maxAng = 26 / radius;
  const randomDir = () => {
    if (!center) {
      return new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    }
    const base = center.clone().normalize();
    _ref.set(0, 1, 0);
    if (Math.abs(base.y) > 0.9) _ref.set(1, 0, 0);
    _east.crossVectors(_ref, base).normalize();
    const axis = _east.clone().applyAxisAngle(base, Math.random() * Math.PI * 2).normalize();
    const ang = minAng + Math.random() * (maxAng - minAng);
    return base.clone().applyAxisAngle(axis, ang).normalize();
  };

  for (let i = 0; i < count; i++) {
    const g = makeAvatar(i);
    const bb = new THREE.Box3().setFromObject(g);
    const h = Math.max(0.001, bb.max.y - bb.min.y);
    g.scale.setScalar(height / h);
    g.userData.isBot = true;
    // bots don't cast/receive shadows — keeps them out of the shadow pass (perf)
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    scene.add(g);

    const dir = randomDir();
    const s = planet.surfaceInfo(dir) || { point: dir.clone().multiplyScalar(radius), normal: dir.clone() };
    const up = s.normal.clone().normalize();
    _ref.set(0, 1, 0);
    if (Math.abs(up.y) > 0.9) _ref.set(1, 0, 0);
    _east.crossVectors(_ref, up).normalize();
    const heading = _east.clone().applyAxisAngle(up, Math.random() * Math.PI * 2).normalize();

    bots.push({
      g,
      pos: s.point.clone(),
      up,
      heading,
      speed: 3.0 + Math.random() * 2.4,
      phase: Math.random() * Math.PI * 2,
      turnTimer: 1 + Math.random() * 3,
      pauseTimer: 0,
    });
  }

  function update(dt) {
    const focus = getFocus ? getFocus() : null;
    const cullDist = planet.materializationWave?.active ? (planet.buildOuter ?? 999) + 6 : 1e9;
    for (const b of bots) {
      // occasional turn / brief idle, like a real wandering player
      b.turnTimer -= dt;
      if (b.turnTimer <= 0) {
        b.turnTimer = 1.5 + Math.random() * 3.5;
        if (Math.random() < 0.18) b.pauseTimer = 0.4 + Math.random() * 1.1;
        else b.heading.applyAxisAngle(b.up, (Math.random() - 0.5) * 1.7).normalize();
      }
      const moving = b.pauseTimer <= 0;
      if (!moving) b.pauseTimer -= dt;

      if (moving) b.pos.addScaledVector(b.heading, b.speed * dt);

      // snap to the real terrain surface along the radial direction
      _tmp.copy(b.pos).normalize();
      const s = planet.surfaceInfo(_tmp);
      if (s) { b.pos.copy(s.point); b.up.copy(s.normal).normalize(); }

      // keep heading tangent to the surface
      b.heading.addScaledVector(b.up, -b.heading.dot(b.up));
      if (b.heading.lengthSq() < 1e-6) b.heading.copy(_east);
      b.heading.normalize();

      // orient: model +Y = surface normal, model +Z = heading
      _right.crossVectors(b.up, b.heading).normalize();
      _m.makeBasis(_right, b.up, b.heading);
      _q.setFromRotationMatrix(_m);
      b.g.quaternion.copy(_q);
      b.g.position.copy(b.pos);

      // run cycle (legs/arms) — only while moving
      const ud = b.g.userData;
      if (ud && ud.legL) {
        b.phase += dt * (moving ? 11 : 0);
        const sw = Math.sin(b.phase) * (moving ? 0.6 : 0);
        ud.legL.rotation.x = sw; ud.legR.rotation.x = -sw;
        ud.armL.rotation.x = -sw; ud.armR.rotation.x = sw;
      }

      // hide bots that wandered outside the materialized world (no floating NPCs)
      if (focus) {
        const d = b.pos.distanceTo(focus);
        b.g.visible = d <= cullDist;
      }
    }
  }

  function setVisible(v) { for (const b of bots) b.g.visible = v; }

  return { bots, update, setVisible };
}
