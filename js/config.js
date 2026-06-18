// ---------------------------------------------------------------------------
// Global game constants and tuning. Imported by main.js and net.js.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// World — a small planet whose curvature is visible within a few metres,
// matching the reference (messenger.abeto.co). Slightly larger radius keeps
// the horizon curve close to the original while leaving room to walk.
// Fallback before Draco hitmesh loads; real radius comes from abetoPlanet (~45).
export const PLANET_RADIUS = 32;
export const GRAVITY = 26;
export const JUMP = 9.5;
export const CHAR_HEIGHT = 1.85;   // taller hero (was 1.72)
export const WALK = 3.25;          // legacy ref
export const RUN = 5.2;             // run speed (u/s)
export const RUN_ANIM_SYNC = 5.2;   // clip stride @ timeScale 1 — must equal RUN

export const MOVE = {
  turnHalfLife: 0.18,    // facing eases toward input
  maxTurnRate: 5.0,      // rad/s cap on rotation
  accelHalfLife: 0.26,   // speed buildup
  decelHalfLife: 0.3,    // speed change while input held
  stopHalfLife: 0.14,    // quick stop when keys released
  inputHalfLife: 0.08,   // responsive WASD / stick direction
};

export const isMobile =
  /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 768;

export const CENTER = new THREE.Vector3(0, 0, 0);

// Multiplayer
export const MAX_PLAYERS = 10;     // per room, matching the reference's cap
// WebSocket endpoint — same host/port as the page, ws:// or wss:// automatically.
export const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
