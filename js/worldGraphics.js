// Shared world atmosphere + cel shading — messenger.abeto.co reference.
import * as THREE from 'three';

/** Abeto presentScene fog — synced from sky uColor1 / uColor3 via syncWorldAtmosphere. */
export function createFogUniforms() {
  return {
    uFogColorNear: { value: new THREE.Color('#93a2bf') },
    uFogColorFar: { value: new THREE.Color('#9ea7b8') },
    uFogDistance: { value: 0.8 },
    uFogDensity: { value: 0.011 },
  };
}

/** GLSL: abeto exponential height fog + optional world-up aware horizon tint. */
export function fogGLSL() {
  return `
    uniform vec3 uFogColorNear;
    uniform vec3 uFogColorFar;
    uniform float uFogDistance;
    uniform float uFogDensity;
    uniform vec3 uWorldUp;

    vec3 applyWorldFog(vec3 color, vec3 wPos) {
      float lenCam = length(wPos - cameraPosition);
      float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * lenCam * lenCam);
      float nearFade = smoothstep(2.0, 16.0, lenCam);
      fogFactor *= nearFade;
      float range1 = smoothstep(0.0, uFogDistance, fogFactor);
      float range2 = 1.0 - range1;
      vec3 fogCol = uFogColorNear * range2 + uFogColorFar * range1;
      return mix(color, fogCol, clamp(fogFactor, 0.0, 0.72));
    }
  `;
}

/** GLSL helpers shared by planet / decor shaders. */
export function worldSurfaceGLSL() {
  return `
    float slopeFacing(vec3 wNorm, vec3 wPos) {
      return dot(wNorm, normalize(wPos));
    }
    float isFlatGround(vec3 wNorm, vec3 wPos) {
      return smoothstep(0.62, 0.9, slopeFacing(wNorm, wPos));
    }
  `;
}

/** Natural terrain (rocks/grass) — flat anime cel, soft bright shadow. */
export function abetoTerrainShadeGLSL() {
  return `
    vec3 shadeTerrainNatural(vec3 base, float ndl, vec3 wNorm, vec3 wPos) {
      return applyCelLight(base, ndl);
    }
  `;
}

/** Dark ink accent on atlas seams + hard cel shadow tint — abeto NPR. */
export function inkAccentGLSL() {
  return `
    const vec3 uInk = vec3(0.055, 0.048, 0.042);

    float atlasInkLine(sampler2D atlas, vec2 uv) {
      vec2 t = vec2(0.0024, 0.0024);
      vec3 c = texture2D(atlas, uv).rgb;
      vec3 l = texture2D(atlas, uv - t).rgb;
      vec3 r = texture2D(atlas, uv + t).rgb;
      vec3 u = texture2D(atlas, uv + vec2(t.x, -t.y)).rgb;
      vec3 d = texture2D(atlas, uv + vec2(-t.x, t.y)).rgb;
      float edge = length(c - l) + length(c - r) + length(c - u) + length(c - d);
      return smoothstep(0.14, 0.38, edge);
    }

    vec3 applyAtlasInk(vec3 color, sampler2D atlas, vec2 uv, float strength) {
      float line = atlasInkLine(atlas, uv);
      // Only paint real palette seams — not noise on flat white walls/roads.
      return mix(color, uInk, line * strength);
    }
  `;
}

/** 3-band toon ramp — hard cel steps like messenger.abeto.co */
export function createToonGradient() {
  const d = new Uint8Array([0, 42, 128, 255]);
  const t = new THREE.DataTexture(d, d.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** RGB ↔ HSV helpers — shared by terrain + cel shading. */
export function colorSpaceGLSL() {
  return `
    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }
  `;
}

/** Soft 2-tone anime cel — messenger.abeto.co NPR.
 *  Lit band = full base color. Shadow band stays BRIGHT (only ~18% darker with a
 *  faint cool hue shift) — no near-black "dirt" shadows on walls/road/objects.
 *  Requires colorSpaceGLSL() (rgb2hsv/hsv2rgb) to be included earlier. */
export function celShadeGLSL() {
  return `
    float celShade(float ndl) {
      return smoothstep(0.12, 0.52, ndl);
    }
    // Anime shadow tone — keep value high, nudge hue toward cool, light desat.
    vec3 celShadowColor(vec3 base) {
      vec3 hsv = rgb2hsv(base);
      hsv.x = fract(hsv.x + 0.016);
      hsv.y = clamp(hsv.y * 1.10 + 0.02, 0.0, 1.0);
      hsv.z *= 0.82;
      return hsv2rgb(hsv);
    }
    // Kept for compatibility — soft shadow, NOT ink-black.
    vec3 inkShadow(vec3 base) { return celShadowColor(base); }

    vec3 applyCelLight(vec3 base, float ndl) {
      vec3 lit = mix(celShadowColor(base), base, celShade(ndl));
      // ambient fill so the shadow side reads flat & bright like the reference
      return mix(lit, base, 0.24);
    }
  `;
}

/** Messenger/abeto manmade surfaces (walls, road, props) — flat bright cel. */
export function messengerManmadeGLSL() {
  return `
    vec3 shadeManmade(vec3 base, float ndl, vec3 wPos, float flatGround) {
      // Flat anime tone: bright lit face, soft (not black) shadow side.
      vec3 lit = applyCelLight(base, ndl);
      // keep saturation lively without crushing value
      vec3 hsv = rgb2hsv(lit);
      hsv.y = clamp(hsv.y * 1.08 + 0.02, 0.0, 1.0);
      return hsv2rgb(hsv);
    }
  `;
}

/** Sync fog tint with live sky gradient (spherical planet). */
export function syncWorldAtmosphere({
  fogUniforms, skyUniforms, terrainMat, waterMat, worldUp, sceneFog,
}) {
  if (!fogUniforms) return;
  if (skyUniforms?.bot?.value) {
    fogUniforms.uFogColorNear.value.copy(skyUniforms.bot.value).lerp(
      new THREE.Color('#6a2048'), 0.22,
    );
  }
  if (skyUniforms?.top?.value) {
    fogUniforms.uFogColorFar.value.lerpColors(
      skyUniforms.bot.value,
      skyUniforms.top.value,
      0.62,
    );
  }
  if (sceneFog?.color) {
    sceneFog.color.copy(fogUniforms.uFogColorFar.value);
  }
  const up = worldUp;
  if (terrainMat?.uniforms?.uWorldUp && up) {
    terrainMat.uniforms.uWorldUp.value.copy(up);
  }
  if (waterMat?.uniforms?.uWorldUp && up) {
    waterMat.uniforms.uWorldUp.value.copy(up);
  }
  if (terrainMat?.uniforms?.uFogColorNear) {
    terrainMat.uniforms.uFogColorNear.value.copy(fogUniforms.uFogColorNear.value);
    terrainMat.uniforms.uFogColorFar.value.copy(fogUniforms.uFogColorFar.value);
  }
  if (waterMat?.uniforms?.uFogColorNear) {
    waterMat.uniforms.uFogColorNear.value.copy(fogUniforms.uFogColorNear.value);
    waterMat.uniforms.uFogColorFar.value.copy(fogUniforms.uFogColorFar.value);
  }
}
