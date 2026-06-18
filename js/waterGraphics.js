// Abeto presentScene water — depth-based foam, shore gradients, wave detail.
import * as THREE from 'three';
import {
  createAssemblyUniforms, assemblyUniformDeclGLSL, assemblyCoreGLSL,
  assemblyDiscardGLSL, assemblyFadeAlphaGLSL, assemblyGlowGLSL,
} from './assemblyShader.js';

export const waterGLSL = {
  fit: `
    float efit(float x, float a1, float a2, float b1, float b2) {
      return b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
    }
    float fit(float x, float a1, float a2, float b1, float b2) {
      return clamp(efit(x, a1, a2, b1, b2), min(b1, b2), max(b1, b2));
    }
  `,
  depth: `
    float perspectiveDepthToViewZ(float depth, float near, float far) {
      return (near * far) / ((far - near) * depth - far);
    }
    float getViewZ(float depth, float near, float far) {
      return perspectiveDepthToViewZ(depth, near, far);
    }
    vec3 getViewPosition(float depth, vec2 uv, float near, float far, mat4 projMat) {
      float viewZ = getViewZ(depth, near, far);
      float clipW = projMat[2][3] * viewZ + projMat[3][3];
      vec4 clipPosition = vec4((vec3(uv, depth) - 0.5) * 2.0, 1.0);
      clipPosition *= clipW;
      return (inverse(projMat) * clipPosition).xyz;
    }
  `,
  bicubic: `
    float w0(float a) { return (1.0 / 6.0) * (a * (a * (-a + 3.0) - 3.0) + 1.0); }
    float w1(float a) { return (1.0 / 6.0) * (a * a * (3.0 * a - 6.0) + 4.0); }
    float w2(float a) { return (1.0 / 6.0) * (a * (a * (-3.0 * a + 3.0) + 3.0) + 1.0); }
    float w3(float a) { return (1.0 / 6.0) * (a * a * a); }
    float g0(float a) { return w0(a) + w1(a); }
    float g1(float a) { return w2(a) + w3(a); }
    float h0(float a) { return -1.0 + w1(a) / (w0(a) + w1(a)); }
    float h1(float a) { return 1.0 + w3(a) / (w2(a) + w3(a)); }
    vec4 bicubic(sampler2D tex, vec2 uv, vec4 texelSize) {
      uv = uv * texelSize.zw + 0.5;
      vec2 iuv = floor(uv);
      vec2 fuv = fract(uv);
      float g0x = g0(fuv.x);
      float g1x = g1(fuv.x);
      float h0x = h0(fuv.x);
      float h1x = h1(fuv.x);
      float h0y = h0(fuv.y);
      float h1y = h1(fuv.y);
      vec2 p0 = (vec2(iuv.x + h0x, iuv.y + h0y) - 0.5) * texelSize.xy;
      vec2 p1 = (vec2(iuv.x + h1x, iuv.y + h0y) - 0.5) * texelSize.xy;
      vec2 p2 = (vec2(iuv.x + h0x, iuv.y + h1y) - 0.5) * texelSize.xy;
      vec2 p3 = (vec2(iuv.x + h1x, iuv.y + h1y) - 0.5) * texelSize.xy;
      return g0(fuv.y) * (g0x * texture2D(tex, p0) + g1x * texture2D(tex, p1)) +
             g1(fuv.y) * (g0x * texture2D(tex, p2) + g1x * texture2D(tex, p3));
    }
    float textureBicubic(sampler2D tex, vec2 uv) {
      vec2 texelSize = vec2(1.0) / vec2(textureSize(tex, 0));
      return bicubic(tex, uv, vec4(texelSize, 1.0 / texelSize)).r;
    }
  `,
  parabola: `
    float parabola(float x, float k) {
      return pow(4.0 * x * (1.0 - x), k);
    }
  `,
  sinenoise: `
    float sinenoise1(vec3 p) {
      float val = 0.0;
      val += sin(dot(p, vec3(1.5, 3.4598, 1.234)));
      val += sin(dot(p, vec3(3.12, -3.234, 4.221)));
      val += sin(dot(p, vec3(0.355, 2.3, -1.375)));
      val += sin(dot(p, vec3(-0.156, -3.34, -0.4566)));
      val += sin(dot(p, vec3(-4.1235, -0.485, -1.45)));
      val += sin(dot(p, vec3(2.54, -0.879, -2.123)));
      return val / 6.0;
    }
  `,
  fog: `
    uniform vec3 uFogColorNear;
    uniform vec3 uFogColorFar;
    uniform float uFogDistance;
    uniform float uFogDensity;
    void addFog(inout vec3 outcolor, float lenCam) {
      float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * lenCam * lenCam);
      float range1 = smoothstep(0.0, uFogDistance, fogFactor);
      float range2 = 1.0 - range1;
      vec3 fogColor = uFogColorNear * range2 + uFogColorFar * range1;
      outcolor = mix(outcolor, fogColor, fogFactor);
    }
  `,
};

const _hidden = [];

export function createWaterDepthPass(renderer) {
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });

  return {
    texture: rt.texture,
    resize(w, h) {
      // half-res depth — water foam/shore tolerate it; saves a big chunk of the
      // per-frame scene depth re-render cost.
      const dpr = renderer.getPixelRatio() * 0.72;
      const W = Math.max(1, Math.floor(w * dpr));
      const H = Math.max(1, Math.floor(h * dpr));
      rt.setSize(W, H);
    },
    render(scene, camera, waterMesh) {
      _hidden.length = 0;
      scene.traverse((o) => {
        if (!o.visible) return;
        if (o === waterMesh || o.name === 'water' || o.name === 'sky') {
          _hidden.push(o);
          o.visible = false;
        }
      });

      const prev = renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      scene.overrideMaterial = depthMat;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = prevOverride;
      renderer.setRenderTarget(prev);

      _hidden.forEach((o) => { o.visible = true; });
    },
  };
}

export function createWaterMaterial(textures, fogUniforms) {
  const noise = textures.waterNoise || textures.noise;
  const noiseBlur = textures.waterNoiseBlur || noise;
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    uniforms: {
      tNoise: { value: noise },
      tNoiseBlur: { value: noiseBlur },
      uTime: { value: 0 },
      resolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 1000 },
      uProjMat: { value: new THREE.Matrix4() },
      uWorldMat: { value: new THREE.Matrix4() },
      tSceneInfo: { value: null },
      uColor1: { value: new THREE.Color('#4c868c') },
      uColor2: { value: new THREE.Color('#437a7f') },
      uColorWaves1: { value: new THREE.Color('#366a6f') },
      uColorWaves2: { value: new THREE.Color('#6facb2') },
      ...fogUniforms,
      ...createAssemblyUniforms(),
    },
    vertexShader: `
      ${assemblyUniformDeclGLSL}
      ${assemblyCoreGLSL}
      varying vec4 vMvPos;
      varying vec2 vHighPrecisionZW;
      varying vec2 vUv;
      varying vec3 wPos;
      varying float vAssembly;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        wPos = wp.xyz;
        vAssembly = 1.0 - assemblyProgAt(wPos);
        vMvPos = viewMatrix * wp;
        vUv = uv;
        gl_Position = projectionMatrix * vMvPos;
        vHighPrecisionZW = gl_Position.zw;
      }
    `,
    fragmentShader: `
      ${assemblyUniformDeclGLSL}
      ${assemblyCoreGLSL}
      ${assemblyFadeAlphaGLSL}
      ${waterGLSL.fit}
      ${waterGLSL.depth}
      ${waterGLSL.bicubic}
      ${waterGLSL.parabola}
      ${waterGLSL.sinenoise}
      ${waterGLSL.fog}

      varying vec4 vMvPos;
      varying vec2 vHighPrecisionZW;
      varying vec2 vUv;
      varying vec3 wPos;
      varying float vAssembly;

      uniform sampler2D tNoise;
      uniform sampler2D tNoiseBlur;
      uniform sampler2D tSceneInfo;
      uniform float uTime;
      uniform vec2 resolution;
      uniform float uCameraNear;
      uniform float uCameraFar;
      uniform mat4 uProjMat;
      uniform mat4 uWorldMat;
      uniform vec3 uColor1;
      uniform vec3 uColor2;
      uniform vec3 uColorWaves1;
      uniform vec3 uColorWaves2;

      void main() {
        ${assemblyDiscardGLSL}

        vec2 uv = gl_FragCoord.xy / resolution;
        vec2 meshUV = vUv * 1.25;

        float sceneDepth = 1.0 - textureBicubic(tSceneInfo, uv);
        float waterSurfaceDepth = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;

        vec3 sceneViewPos = getViewPosition(sceneDepth, uv, uCameraNear, uCameraFar, uProjMat);
        vec3 sceneWorldPos = (uWorldMat * vec4(sceneViewPos, 1.0)).xyz;
        float sceneDist = length(sceneViewPos);
        float sceneHeight = length(sceneWorldPos);
        vec3 waterViewPos = getViewPosition(waterSurfaceDepth, uv, uCameraNear, uCameraFar, uProjMat);
        vec3 waterWorldPos = (uWorldMat * vec4(waterViewPos, 1.0)).xyz;
        float waterDist = length(waterViewPos);
        float waterHeight = length(waterWorldPos);

        float viewDistDiff = sceneDist - waterDist;
        float worldHeightDiff = waterHeight - sceneHeight;
        float depthGradient = fit(viewDistDiff, 0.0, 2.5, 0.0, 1.0);

        float time = uTime;
        float timeOffset = sinenoise1(vec3(meshUV * 50.0, 0.0)) * 0.5 + 0.5;

        float foam = 0.0;
        float foamMargin = fit(worldHeightDiff, 0.0, 0.3, 1.0, 0.0);
        if (foamMargin > 0.0) {
          float foamBands = foamMargin * 4.0 - time * 0.35 + timeOffset * 2.0;
          foam = parabola(fract(foamBands), 5.0);
          float foamNoise = texture2D(tNoise, meshUV * 15.0 - (time + floor(foamBands) * 50.342) * 0.001).r;
          foam *= foamMargin * foamNoise;
          foam = step(0.42, foam);
          float foamVisibility = fit(viewDistDiff, 0.0, 1.0, 0.0, 1.0);
          foam *= 1.0 - step(0.99, pow(foamVisibility, 2.0));
        }

        float seaTime = time + timeOffset * 10.0;

        vec2 offsetSea1 = vec2(cos(seaTime * 1.0 + 3.432), sin(seaTime * 2.0 + 3.234)) * 0.01;
        float noiseSea1 = texture2D(tNoise, meshUV * 8.0 - seaTime * 0.01 + offsetSea1).r;
        vec2 offsetSea2 = vec2(sin(seaTime * 1.5 + 6.54353), cos(seaTime * 0.5 + 43.342)) * 0.0085;
        float noiseSea2 = texture2D(tNoise, meshUV * 10.0 + 34.54 + seaTime * 0.015 + offsetSea2).r;
        float noiseSea = noiseSea1 * noiseSea2;
        float wavesN = step(0.1, pow(noiseSea, 2.0));
        vec3 seaColor = mix(uColorWaves1, uColor2, wavesN);

        vec2 offsetSea3 = vec2(sin(seaTime * 2.0 + 12.435), cos(seaTime * 2.75 + 34.3)) * 0.011;
        float noiseSea3 = texture2D(tNoise, meshUV * 20.0 - seaTime * 0.01 + offsetSea3 - 3.525).r;
        vec2 offsetSea4 = vec2(cos(seaTime * 1.25 + 3.345), sin(seaTime * 2.5 + 97.798)) * 0.0095;
        float noiseSea4 = texture2D(tNoise, meshUV * 10.0 + 4.5434 + seaTime * 0.02 + offsetSea4 + 2.34).r;
        float additionaNoiseSea = noiseSea3 * noiseSea4;
        float wavesN2 = step(0.45, additionaNoiseSea);
        seaColor = mix(seaColor, uColorWaves2, wavesN2);

        float fineRipple = texture2D(tNoiseBlur, meshUV * 24.0 + seaTime * 0.008).r;
        seaColor = mix(seaColor, uColorWaves2, smoothstep(0.35, 0.65, fineRipple) * 0.18);

        float colorShore = max(fit(worldHeightDiff, 0.0, 0.15, 0.0, 1.0), depthGradient);
        vec3 colorWater = mix(uColor1, seaColor, colorShore);

        float gradientScene = 1.0 - max(fit(worldHeightDiff, 0.0, 0.75, 0.0, 1.0), depthGradient);
        colorWater = mix(colorWater, uColorWaves2, gradientScene * 0.1);

        colorWater = mix(colorWater, vec3(1.0), foam);

        addFog(colorWater, length(vMvPos.xyz));

        float wLum = dot(colorWater, vec3(0.299, 0.587, 0.114));
        colorWater = mix(colorWater * 0.58, colorWater, step(0.36, wLum));

        vec3 outCol = colorWater;
        ${assemblyGlowGLSL}
        float asmFade = assemblyFadeAlpha(wPos);
        // Stylized opacity — mostly opaque, foam fully opaque. (Old alpha used raw
        // NDC depth which made distant water ~invisible at planet scale.)
        float wAlpha = mix(0.9, 1.0, clamp(foam, 0.0, 1.0));
        gl_FragColor = vec4(outCol, wAlpha * asmFade);
      }
    `,
  });
}

export function syncWaterSceneUniforms(waterMat, camera, depthPass) {
  if (!waterMat?.uniforms) return;
  waterMat.uniforms.uCameraNear.value = camera.near;
  waterMat.uniforms.uCameraFar.value = camera.far;
  waterMat.uniforms.uProjMat.value.copy(camera.projectionMatrix);
  waterMat.uniforms.uWorldMat.value.copy(camera.matrixWorld);
  if (depthPass?.texture) waterMat.uniforms.tSceneInfo.value = depthPass.texture;
}
