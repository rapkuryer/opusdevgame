// Two colossal eyes in the sky — always overhead, always looking at the player.
import * as THREE from 'three';

const EYE_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EYE_FRAGMENT = `
  varying vec2 vUv;
  uniform vec2 uPupil;
  uniform float uBlink;
  uniform float uTime;

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= 0.82;

    float lid = smoothstep(0.0, 0.08, uBlink) * smoothstep(1.0, 0.92, uBlink);
    uv.y *= mix(0.04, 1.0, lid);

    float edge = length(uv);
    if (edge > 0.98) discard;

    float sclera = smoothstep(0.94, 0.78, edge);
    vec3 white = vec3(0.93, 0.9, 0.84);
    vec3 vein = vec3(0.55, 0.12, 0.1);
    float veins = sin(uv.y * 28.0 + uv.x * 11.0 + uTime * 0.4) * 0.5 + 0.5;
    veins *= smoothstep(0.35, 0.9, edge) * smoothstep(0.2, 0.55, edge);
    vec3 eyeCol = mix(white, vein, veins * 0.22);

    vec2 p = uv - uPupil * 0.28;
    float iris = 1.0 - smoothstep(0.26, 0.34, length(p));
    float pupil = 1.0 - smoothstep(0.09, 0.13, length(p));
    vec3 irisCol = vec3(0.12, 0.22, 0.38);
    vec3 pupilCol = vec3(0.01, 0.01, 0.02);

    vec3 col = eyeCol;
    col = mix(col, irisCol, iris * 0.95);
    col = mix(col, pupilCol, pupil);

    float spec = 1.0 - smoothstep(0.0, 0.06, length(p - vec2(-0.06, 0.07)));
    col += vec3(0.35) * spec * pupil;

    float shadow = smoothstep(-0.55, -0.15, uv.y) * 0.18;
    col *= 1.0 - shadow;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function createEyeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPupil: { value: new THREE.Vector2(0, 0) },
      uBlink: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: EYE_VERTEX,
    fragmentShader: EYE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

function makeEye(name) {
  const mat = createEyeMaterial();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.name = name;
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}

const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _center = new THREE.Vector3();
const _left = new THREE.Vector3();
const _right = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();
const _local = new THREE.Vector3();
const _pupil = new THREE.Vector2();

/**
 * @param {THREE.Scene} scene
 * @param {number} skyRadius
 */
export function buildWatchingEyes(scene, skyRadius) {
  const group = new THREE.Group();
  group.name = 'watching-eyes';
  scene.add(group);

  const left = makeEye('EyeLeft');
  const right = makeEye('EyeRight');
  group.add(left, right);

  const eyeDist = skyRadius * 0.84;
  const eyeSize = skyRadius * 0.28;
  const eyeGap = skyRadius * 0.21;
  let blinkPhase = 1;
  let nextBlink = 4 + Math.random() * 5;
  const _inv = new THREE.Matrix4();

  function orientEye(mesh, worldPos, playerPos, radialUp) {
    mesh.position.copy(worldPos);
    _up.copy(radialUp);
    _toPlayer.copy(playerPos).sub(worldPos).normalize();
    _east.crossVectors(_up, _toPlayer);
    if (_east.lengthSq() < 1e-6) _east.crossVectors(_up, new THREE.Vector3(1, 0, 0));
    _east.normalize();
    mesh.up.copy(_up);
    mesh.lookAt(playerPos);

    mesh.updateMatrixWorld(true);
    _inv.copy(mesh.matrixWorld).invert();
    _local.copy(playerPos).applyMatrix4(_inv);
    _pupil.set(
      THREE.MathUtils.clamp(_local.x * 0.55, -0.35, 0.35),
      THREE.MathUtils.clamp(_local.y * 0.55, -0.28, 0.28),
    );
    mesh.material.uniforms.uPupil.value.copy(_pupil);
  }

  function update(elapsed, dt, playerPos) {
    if (!playerPos) return;

    _up.copy(playerPos).normalize();
    _east.crossVectors(_up, new THREE.Vector3(0, 0, 1));
    if (_east.lengthSq() < 0.01) _east.crossVectors(_up, new THREE.Vector3(1, 0, 0));
    _east.normalize();
    _north.crossVectors(_up, _east);

    const tilt = 0.38;
    _center.copy(_up).multiplyScalar(Math.cos(tilt)).addScaledVector(_north, Math.sin(tilt)).normalize()
      .multiplyScalar(eyeDist);
    _left.copy(_center).addScaledVector(_east, -eyeGap);
    _right.copy(_center).addScaledVector(_east, eyeGap);

    left.scale.setScalar(eyeSize);
    right.scale.setScalar(eyeSize);

    orientEye(left, _left, playerPos, _up);
    orientEye(right, _right, playerPos, _up);

    left.material.uniforms.uTime.value = elapsed;
    right.material.uniforms.uTime.value = elapsed;

    nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkPhase = 0;
      nextBlink = 5 + Math.random() * 8;
    }
    if (blinkPhase < 1) {
      blinkPhase = Math.min(1, blinkPhase + dt * 2.8);
      const t = blinkPhase;
      const blink = t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2;
      left.material.uniforms.uBlink.value = blink;
      right.material.uniforms.uBlink.value = blink;
    } else {
      left.material.uniforms.uBlink.value = 1;
      right.material.uniforms.uBlink.value = 1;
    }
  }

  return { group, left, right, update };
}
