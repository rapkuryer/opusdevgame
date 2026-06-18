// Zone title banners — every district label shows $OPUSDEV (abeto zone spheres).
import * as THREE from 'three';

const ZONES = [
  { center: [25.1548, 11.1266, 2.25704], radius: 8.75 },
  { center: [-7.82486, 4.19171, -29.304], radius: 18.45 },
  { center: [8.09011, -13.7658, -12.4145], radius: 10 },
  { center: [-14.4395, -6.11889, 27.0498], radius: 9 },
  { center: [-8.84153, -19.1808, 2.54687], radius: 13 },
  { center: [27.7006, -14.1946, 13.4392], radius: 8 },
  { center: [-21.7063, -6.80204, 6.28998], radius: 5 },
  { center: [-10.1549, 34.7748, -3.82302], radius: 8 },
  { center: [-13.1445, 15.572, -1.75282], radius: 8 },
];

const _pos = new THREE.Vector3();

export function createZoneTitles() {
  const el = document.createElement('div');
  el.id = 'zoneTitle';
  el.textContent = '$OPUSDEV';
  document.body.appendChild(el);

  let current = -1;
  let hideTimer = null;

  function show() {
    el.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  return {
    update(playerPos) {
      if (!playerPos) return;
      _pos.copy(playerPos);
      let hit = -1;
      for (let i = 0; i < ZONES.length; i++) {
        const z = ZONES[i];
        const dx = _pos.x - z.center[0];
        const dy = _pos.y - z.center[1];
        const dz = _pos.z - z.center[2];
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < z.radius) {
          hit = i;
          break;
        }
      }
      if (hit !== current) {
        current = hit;
        if (hit >= 0) show();
      }
    },
    dispose() {
      clearTimeout(hideTimer);
      el.remove();
    },
  };
}
