// ---------------------------------------------------------------------------
// Multiplayer client — WebSocket relay, nicknames, interpolated Capoeira avatars.
// Networking stays off the critical path: parse in message handlers, send at 12 Hz.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { WS_URL, CHAR_HEIGHT } from './config.js';
import {
  createRemotePlayer,
  releaseRemotePlayer,
  setRemoteAnimState,
  updateRemoteMixer,
} from './playerCharacter.js';

const SEND_HZ = 12;
const SEND_DT = 1 / SEND_HZ;
const LERP_K = 14;
const MAX_NICK = 16;

export function getEnteredNick(raw) {
  const s = String(raw ?? '').trim().slice(0, MAX_NICK);
  const clean = s.replace(/[^\w\s.\-]/g, '').trim();
  return clean.length > 0 ? clean : null;
}

export function sanitizeNick(raw) {
  return getEnteredNick(raw) || 'Courier';
}

export function createNameTag(text, opts = {}) {
  const label = sanitizeNick(text);
  const local = !!opts.local;
  const PAD_X = 28;
  const PAD_Y = 18;
  const font = '600 26px Nunito, "Segoe UI", system-ui, sans-serif';
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');

  const measure = (name) => {
    ctx.font = font;
    return Math.min(300, Math.ceil(ctx.measureText(name).width) + PAD_X * 2);
  };

  const resize = (w) => {
    cv.width = w;
    cv.height = 52;
  };

  const draw = (name) => {
    const tw = cv.width;
    const th = cv.height;
    const cx = tw / 2;
    const cy = th / 2;
    ctx.clearRect(0, 0, tw, th);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Soft bloom — readability without a background plate.
    ctx.shadowColor = local ? 'rgba(153, 69, 255, 0.5)' : 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = local ? 14 : 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = local ? 0 : 1;
    ctx.fillStyle = local ? 'rgba(200, 170, 255, 0.35)' : 'rgba(0, 0, 0, 0.45)';
    ctx.fillText(name, cx, cy + 1);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Thin stroke — crisp silhouette on bright sky / terrain.
    ctx.lineWidth = local ? 2.5 : 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = local ? 'rgba(12, 8, 28, 0.72)' : 'rgba(8, 8, 12, 0.78)';
    ctx.strokeText(name, cx, cy);

    if (local) {
      const g = ctx.createLinearGradient(cx - tw * 0.35, cy, cx + tw * 0.35, cy);
      g.addColorStop(0, '#ddd0ff');
      g.addColorStop(0.45, '#ffffff');
      g.addColorStop(1, '#a8f5dc');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = '#f6f4ef';
    }
    ctx.fillText(name, cx, cy);
  };

  resize(measure(label));
  draw(label);

  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    alphaTest: 0.02,
  }));
  const aspect = cv.width / cv.height;
  const h = local ? 0.19 : 0.17;
  sp.scale.set(h * aspect, h, 1);
  sp.position.y = CHAR_HEIGHT * 1.06;
  sp.renderOrder = 999;
  sp.userData.label = label;
  sp.userData.setText = (t) => {
    const next = sanitizeNick(t);
    if (next === sp.userData.label) return;
    sp.userData.label = next;
    const w = measure(next);
    if (w !== cv.width) {
      resize(w);
      const a = cv.width / cv.height;
      sp.scale.set(h * a, h, 1);
    }
    draw(next);
    tex.needsUpdate = true;
  };
  return sp;
}

export class Multiplayer {
  constructor(opts) {
    this.scene = opts.scene;
    this.onCount = opts.onCount || (() => {});
    this.url = opts.url || WS_URL;
    this.ws = null;
    this.id = null;
    this.nick = 'Courier';
    this.pubkey = null;
    this.remotes = new Map();
    this._sendTimer = 0;
    this._connected = false;
    this._connecting = false;
    this._wantReconnect = true;
    this._retryDelay = 1;
    this._retryTimer = null;
  }

  connect(nick, pubkey = null) {
    this.nick = sanitizeNick(nick);
    this.pubkey = pubkey || null;
    this._wantReconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._connecting = true;
    this._updateCount();
    // Wake relay HTTP health (Render free tier), then open WebSocket after a short pause.
    const wake = this.url.startsWith('wss://')
      ? this.url.replace(/^wss:/, 'https:').replace(/\/ws$/, '/')
      : this.url.startsWith('ws://')
        ? this.url.replace(/^ws:/, 'http:').replace(/\/ws$/, '/')
        : null;
    const afterWake = () => {
      setTimeout(() => {
        if (!this._wantReconnect) return;
        if (this.ws?.readyState === WebSocket.OPEN) return;
        this._openSocket();
      }, 450);
    };
    if (wake) fetch(wake).catch(() => {}).finally(afterWake);
    else afterWake();
  }

  disconnect() {
    this._wantReconnect = false;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this._clearAll();
  }

  _openSocket() {
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { console.warn('[net] WebSocket unavailable — single player', e); return; }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this._connected = true;
      this._connecting = false;
      this._retryDelay = 1;
      this._send({ type: 'hello', nick: this.nick, pubkey: this.pubkey });
      console.log('[net] connected');
      this._updateCount();
    });
    ws.addEventListener('close', () => {
      this._connected = false;
      this._connecting = false;
      this.id = null;
      this._clearAll();
      this._updateCount();
      if (this._wantReconnect) {
        this._retryTimer = setTimeout(() => {
          this._connecting = true;
          this._updateCount();
          this._retryDelay = Math.min(this._retryDelay * 1.6, 20);
          const wake = this.url.startsWith('wss://')
            ? this.url.replace(/^wss:/, 'https:').replace(/\/ws$/, '/')
            : this.url.startsWith('ws://')
              ? this.url.replace(/^ws:/, 'http:').replace(/\/ws$/, '/')
              : null;
          const reopen = () => {
            setTimeout(() => {
              if (this._wantReconnect) this._openSocket();
            }, 450);
          };
          if (wake) fetch(wake).catch(() => {}).finally(reopen);
          else reopen();
        }, this._retryDelay * 1000);
      }
    });
    ws.addEventListener('error', () => {
      this._connecting = false;
      this._updateCount();
    });
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'welcome':
        this.id = msg.id;
        if (Array.isArray(msg.peers)) msg.peers.forEach((p) => this._ensureRemote(p.id, p));
        this._updateCount();
        break;
      case 'join':
        if (msg.id !== this.id) this._ensureRemote(msg.id, msg);
        this._updateCount();
        break;
      case 'state':
        if (msg.id !== this.id) this._applyState(msg);
        break;
      case 'leave':
        this._removeRemote(msg.id);
        this._updateCount();
        break;
      case 'full':
        console.warn('[net] room full — playing solo');
        break;
      default:
        break;
    }
  }

  _ensureRemote(id, init) {
    if (this.remotes.has(id)) {
      const r = this.remotes.get(id);
      if (init?.nick) this._setRemoteNick(r, init.nick);
      return r;
    }
    const remote = createRemotePlayer(init?.nick || 'Courier');
    this.scene.add(remote.group);
    if (init?.nick) this._setRemoteNick(remote, init.nick);
    const r = {
      ...remote,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      target: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
      animState: init?.a || 'idle',
    };
    if (init?.p) {
      r.pos.fromArray(init.p);
      r.target.pos.fromArray(init.p);
      remote.group.position.copy(r.pos);
    }
    if (init?.q) {
      r.quat.fromArray(init.q);
      r.target.quat.fromArray(init.q);
      remote.group.quaternion.copy(r.quat);
    }
    if (init?.a) setRemoteAnimState(r, init.a, 0.05);
    this.remotes.set(id, r);
    return r;
  }

  _setRemoteNick(remote, nick) {
    const label = sanitizeNick(nick);
    remote.nick = label;
    if (!remote.nameTag) {
      remote.nameTag = createNameTag(label);
      remote.group.add(remote.nameTag);
    } else {
      remote.nameTag.userData.setText(label);
    }
  }

  _applyState(msg) {
    const r = this._ensureRemote(msg.id, msg);
    if (msg.p) r.target.pos.fromArray(msg.p);
    if (msg.q) r.target.quat.fromArray(msg.q);
    if (msg.nick) this._setRemoteNick(r, msg.nick);
    if (msg.a && msg.a !== r.animState) {
      setRemoteAnimState(r, msg.a, 0.18);
      r.animState = msg.a;
    }
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    releaseRemotePlayer(r);
    this.remotes.delete(id);
  }

  _clearAll() {
    for (const id of [...this.remotes.keys()]) this._removeRemote(id);
    this._updateCount();
  }

  _updateCount() {
    const n = this._connected ? this.remotes.size + 1 : 1;
    this.onCount(n, this._connected, this._connecting);
  }

  update(dt, localState) {
    const k = 1 - Math.exp(-LERP_K * dt);
    for (const r of this.remotes.values()) {
      r.pos.lerp(r.target.pos, k);
      r.quat.slerp(r.target.quat, k);
      r.group.position.copy(r.pos);
      r.group.quaternion.copy(r.quat);
      updateRemoteMixer(r, dt);
    }

    if (!this._connected || !localState) return;
    this._sendTimer += dt;
    if (this._sendTimer < SEND_DT) return;
    this._sendTimer = 0;
    const p = localState.pos;
    const q = localState.quat;
    this._send({
      type: 'state',
      p: [r3(p.x), r3(p.y), r3(p.z)],
      q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
      a: localState.anim,
      nick: this.nick,
    });
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

function r3(n) { return Math.round(n * 1000) / 1000; }
