// Shared Animus assembly uniforms + GLSL (terrain, trees, grass, water, signs).
import * as THREE from 'three';

export const ASSEMBLY_INNER = 4.0;
export const ASSEMBLY_OUTER = 28.0;   // reality bubble — builds closer to player
export const ASSEMBLY_DISCARD = 0.82;
export const ASSEMBLY_VISIBILITY = 0.12;

export function createAssemblyUniforms() {
  return {
    uAssemblyOn: { value: 0.0 },
    uPlayerPos: { value: new THREE.Vector3() },
    uBuildInner: { value: ASSEMBLY_INNER },
    uBuildOuter: { value: ASSEMBLY_OUTER },
  };
}

export function applyAssemblyUniforms(uniforms, active, playerPos) {
  if (!uniforms) return;
  if (uniforms.uAssemblyOn) uniforms.uAssemblyOn.value = active ? 1.0 : 0.0;
  if (uniforms.uPlayerPos && playerPos) uniforms.uPlayerPos.value.copy(playerPos);
  if (uniforms.uBuildInner) uniforms.uBuildInner.value = ASSEMBLY_INNER;
  if (uniforms.uBuildOuter) uniforms.uBuildOuter.value = ASSEMBLY_OUTER;
}

/** CPU-side progress 0..1 for sign visibility etc. */
export function assemblyProgFromDist(dist) {
  const t = THREE.MathUtils.clamp(
    (dist - ASSEMBLY_INNER) / (ASSEMBLY_OUTER - ASSEMBLY_INNER), 0, 1,
  );
  const s = t * t * (3 - 2 * t);
  return 1 - s;
}

export function assemblyRevealT(prog) {
  const t = THREE.MathUtils.clamp(prog / 0.88, 0, 1);
  return t * t * (3 - 2 * t);
}

export const assemblyUniformDeclGLSL = `
  uniform float uAssemblyOn;
  uniform vec3 uPlayerPos;
  uniform float uBuildInner;
  uniform float uBuildOuter;
`;

export const assemblyCoreGLSL = `
  float assemblyProgAt(vec3 worldPos) {
    if (uAssemblyOn < 0.5) return 1.0;
    float d = distance(worldPos, uPlayerPos);
    return 1.0 - smoothstep(uBuildInner, uBuildOuter, d);
  }

  vec3 assemblyCellHash(vec3 cell) {
    return fract(sin(vec3(
      dot(cell, vec3(127.1, 311.7, 74.7)),
      dot(cell, vec3(269.5, 183.3, 246.1)),
      dot(cell, vec3(113.5, 271.9, 124.6))
    )) * 43758.5453);
  }

  // Terrain: manmade structures (poles, benches, rails, buildings) vs natural
  // rock / sand / ground / grass. Natural gets a WIDER, smaller-block build band
  // with a stronger upward lift so the ground & rocks visibly fly in as blocks
  // over the mid field (not silently pop in at the horizon).
  vec3 assemblyTerrainDisplace(vec3 pos, float elementId, mat4 modelMat, out float assemblyAmt) {
    assemblyAmt = 0.0;
    float prog = assemblyProgAt((modelMat * vec4(pos, 1.0)).xyz);
    if (prog >= 0.9985) return pos;
    bool manmade = elementId < 0.5;
    float CELL = manmade ? 0.55 : 1.4;
    vec3 cell = floor(pos / CELL);
    vec3 h = assemblyCellHash(cell);
    float phase = h.x * 0.12;
    // Wide build band for BOTH so poles, bridges, walls, ground & rocks all
    // visibly fly in as blocks (not pop in solid at the horizon).
    float phaseSpread = manmade ? 0.55 : 0.62;
    float ampMul = manmade ? 8.5 : 7.0;
    float upBias = manmade ? 1.5 : 2.0;
    vec3 cc = (cell + 0.5) * CELL;
    float local = smoothstep(phase, phase + phaseSpread, prog);
    assemblyAmt = 1.0 - local;
    float grow = smoothstep(0.0, 0.5, local);
    vec3 offset = (pos - cc) * grow;
    // extra tumble — blocks spin ~2 turns as they fly in for a livelier build
    float ang = (1.0 - local) * (h.y * 2.0 - 1.0) * 12.566;
    vec3 ax = normalize(h - 0.5 + 1e-3);
    float s = sin(ang), c = cos(ang);
    offset = offset * c + cross(ax, offset) * s + ax * dot(ax, offset) * (1.0 - c);
    vec3 dir = normalize(h * 2.0 - 1.0 + vec3(0.0, upBias, 0.0));
    float amp = (1.0 - local);
    amp = amp * amp * ampMul;
    return cc + offset + dir * amp;
  }

  // Trees / foliage decor — medium blocks.
  vec3 assemblyDisplace(vec3 pos, mat4 modelMat, out float assemblyAmt) {
    assemblyAmt = 0.0;
    float prog = assemblyProgAt((modelMat * vec4(pos, 1.0)).xyz);
    if (prog >= 0.9985) return pos;
    float CELL = 1.6;
    vec3 cell = floor(pos / CELL);
    vec3 h = assemblyCellHash(cell);
    float phase = h.x * 0.18;
    float local = smoothstep(phase, phase + 0.40, prog);
    assemblyAmt = 1.0 - local;
    float grow = smoothstep(0.0, 0.5, local);
    vec3 cc = (cell + 0.5) * CELL;
    vec3 offset = (pos - cc) * grow;
    float ang = (1.0 - local) * (h.y * 2.0 - 1.0) * 6.2832;
    vec3 ax = normalize(h - 0.5 + 1e-3);
    float s = sin(ang), c = cos(ang);
    offset = offset * c + cross(ax, offset) * s + ax * dot(ax, offset) * (1.0 - c);
    vec3 dir = normalize(h * 2.0 - 1.0 + vec3(0.0, 1.2, 0.0));
    float amp = (1.0 - local);
    amp = amp * amp * 9.0;
    return cc + offset + dir * amp;
  }
`;

export const assemblyDiscardGLSL = `
  if (uAssemblyOn > 0.5 && vAssembly > ${ASSEMBLY_DISCARD}) discard;
`;

// Materialization look — blocks keep their OWN texture colour (already cel-shaded),
// just darkened a touch while still forming (the dark NPR feel) with a faint cool
// "digital" rim on barely-formed blocks. No white/cyan wash. vAssembly: 0 = settled,
// →1 = still flying in. Requires `outCol` + `vAssembly` in scope.
export const assemblyGlowGLSL = `
  if (uAssemblyOn > 0.5 && vAssembly > 0.001) {
    float a = clamp(vAssembly, 0.0, 1.0);
    // darken core while forming — subtle, keeps texture colour visible
    outCol *= (1.0 - 0.10 * a);
    // subtle materialization — no bright cyan shards on hills/terrain
    vec3 accent = vec3(0.45, 0.82, 1.0);
    outCol += accent * pow(a, 4.0) * 0.04;
  }
`;

// Function form (top-level safe). Call inside main(): float a = assemblyFadeAlpha(wPos);
export const assemblyFadeAlphaGLSL = `
  float assemblyFadeAlpha(vec3 wPos) {
    if (uAssemblyOn < 0.5) return 1.0;
    float asmAmt = 1.0 - assemblyProgAt(wPos);
    return 1.0 - smoothstep(0.72, 0.90, asmAmt);
  }
`;
