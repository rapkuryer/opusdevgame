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

export function sanitizeNick(raw) {
  const s = String(raw || 'Courier').trim().slice(0, MAX_NICK);
  const clean = s.replace(/[^\w\s.\-]/g, '').trim();
  return clean || 'Courier';
}

function makeNameTag(text) {
  const label = sanitizeNick(text);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = 'bold 22px Nunito, system-ui, sans-serif';
  ctx.font = font;
  const tw = Math.min(220, Math.ceil(ctx.measureText(label).width) + 28);
  cv.width = tw;
  cv.height = 40;
  ctx.font = font;
  ctx.fillStyle = 'rgba(8, 8, 12, 0.55)';
  ctx.beginPath();
  ctx.roundRect(4, 6, tw - 8, 28, 8);
  ctx.fill();
  ctx.fillStyle = '#f4f2ee';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tw / 2, 20);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    alphaTest: 0.04,
  }));
  sp.scale.set(1.35, 0.42, 1);
  sp.position.y = CHAR_HEIGHT * 0.92;
  sp.renderOrder = 998;
  sp.userData.label = label;
  sp.userData.setText = (t) => {
    const next = sanitizeNick(t);
    if (next === sp.userData.label) return;
    sp.userData.label = next;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = font;
    ctx.fillStyle = 'rgba(8, 8, 12, 0.55)';
    ctx.beginPath();
    ctx.roundRect(4, 6, tw - 8, 28, 8);
    ctx.fill();
    ctx.fillStyle = '#f4f2ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(next, tw / 2, 20);
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
    this.remotes = new Map();
    this._sendTimer = 0;
    this._connected = false;
    this._connecting = false;
    this._wantReconnect = true;
    this._retryDelay = 1;
    this._retryTimer = null;
  }

  connect(nick) {
    this.nick = sanitizeNick(nick);
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
      this._send({ type: 'hello', nick: this.nick });
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
      remote.nameTag = makeNameTag(label);
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
