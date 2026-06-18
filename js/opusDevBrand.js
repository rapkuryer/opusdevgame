// Shared $OPUSDEV branding textures for signs, shaders, and UI overlays.
import * as THREE from 'three';

let signTextureCache = null;
let poleTextureCache = null;
let compactTextureCache = null;

/** High-contrast sign board texture (RGBA) for 3D overlays and terrain shader. */
export function createOpusDevSignTexture(width = 512, height = 144) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const pad = Math.max(6, Math.round(width * 0.02));
  ctx.fillStyle = 'rgba(255, 245, 228, 0.94)';
  ctx.strokeStyle = 'rgba(26, 21, 56, 0.85)';
  ctx.lineWidth = Math.max(3, Math.round(width * 0.008));
  roundRect(ctx, pad, pad, width - pad * 2, height - pad * 2, pad * 1.2);
  ctx.fill();
  ctx.stroke();

  const fontSize = Math.round(height * 0.46);
  ctx.fillStyle = '#1a1538';
  ctx.font = `800 ${fontSize}px "SF Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$OPUSDEV', width / 2, height / 2 + fontSize * 0.04);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function getOpusDevSignTexture() {
  if (!signTextureCache) signTextureCache = createOpusDevSignTexture();
  return signTextureCache;
}

/** Circular pole sign — cream disc + red ring + $OPUSDEV (replaces yellow atlas plaques). */
export function createOpusDevPoleTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.48;
  const ring = size * 0.42;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#fff5e4';
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#8b2e2e';
  ctx.lineWidth = Math.max(4, size * 0.045);
  ctx.beginPath();
  ctx.arc(cx, cy, ring, 0, Math.PI * 2);
  ctx.stroke();

  const fontSize = Math.round(size * 0.11);
  ctx.fillStyle = '#1a1538';
  ctx.font = `800 ${fontSize}px "SF Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$OPUSDEV', cx, cy + fontSize * 0.05);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function getOpusDevPoleTexture() {
  if (!poleTextureCache) poleTextureCache = createOpusDevPoleTexture();
  return poleTextureCache;
}

/** Blue horizontal street-sign board — replaces atlas blue plaques. */
export function createOpusDevBlueSignTexture(width = 512, height = 144) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const pad = Math.max(6, Math.round(width * 0.02));
  ctx.fillStyle = 'rgba(42, 90, 158, 0.96)';
  ctx.strokeStyle = 'rgba(18, 14, 40, 0.75)';
  ctx.lineWidth = Math.max(3, Math.round(width * 0.008));
  roundRect(ctx, pad, pad, width - pad * 2, height - pad * 2, pad * 1.2);
  ctx.fill();
  ctx.stroke();

  const fontSize = Math.round(height * 0.44);
  ctx.fillStyle = '#f4f8ff';
  ctx.font = `800 ${fontSize}px "SF Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$OPUSDEV', width / 2, height / 2 + fontSize * 0.04);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let blueTextureCache = null;

export function getOpusDevBlueSignTexture() {
  if (!blueTextureCache) blueTextureCache = createOpusDevBlueSignTexture();
  return blueTextureCache;
}

/** Compact strip for shader tiling on building faces. */
export function getOpusDevCompactTexture() {
  if (!compactTextureCache) compactTextureCache = createOpusDevSignTexture(384, 96);
  return compactTextureCache;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
