// ---------------------------------------------------------------------------
// Multiplayer client — connects to the Node.js + WebSocket server, broadcasts
// the local courier's transform/animation state, and renders smoothly
// interpolated remote couriers. Rooms are capped server-side (see config
// MAX_PLAYERS / server.js) to keep the world calm, just like the reference.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { WS_URL } from './config.js';

const SEND_HZ = 12;                 // transform broadcasts per second
const SEND_DT = 1 / SEND_HZ;

export class Multiplayer {
  // opts: { scene, makeAvatar(seed)->THREE.Object3D, onCount(n) }
  constructor(opts) {
    this.scene = opts.scene;
    this.makeAvatar = opts.makeAvatar;
    this.onCount = opts.onCount || (() => {});
    this.url = opts.url || WS_URL;

    this.ws = null;
    this.id = null;
    this.remotes = new Map();        // id -> { group, target:{pos,quat}, anim }
    this._sendTimer = 0;
    this._connected = false;
    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
  }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { console.warn('[net] WebSocket unavailable — single player', e); return; }
    this.ws = ws;

    ws.addEventListener('open', () => { this._connected = true; console.log('[net] connected'); });
    ws.addEventListener('close', () => { this._connected = false; this._clearAll(); });
    ws.addEventListener('error', () => { this._connected = false; });
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
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
    }
  }

  _ensureRemote(id, init) {
    if (this.remotes.has(id)) return this.remotes.get(id);
    const group = this.makeAvatar(init && init.seed);
    this.scene.add(group);
    const r = {
      group,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      target: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
      anim: 'idle',
    };
    if (init && init.p) { r.pos.fromArray(init.p); r.target.pos.fromArray(init.p); group.position.copy(r.pos); }
    if (init && init.q) { r.quat.fromArray(init.q); r.target.quat.fromArray(init.q); group.quaternion.copy(r.quat); }
    this.remotes.set(id, r);
    return r;
  }

  _applyState(msg) {
    const r = this._ensureRemote(msg.id, msg);
    if (msg.p) r.target.pos.fromArray(msg.p);
    if (msg.q) r.target.quat.fromArray(msg.q);
    if (msg.a) r.anim = msg.a;
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.group);
    r.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    });
    this.remotes.delete(id);
  }

  _clearAll() { for (const id of [...this.remotes.keys()]) this._removeRemote(id); this._updateCount(); }

  _updateCount() { this.onCount(this.remotes.size + (this._connected ? 1 : 1)); }

  // Called every frame. localState = { pos:Vector3, quat:Quaternion, anim:string }
  update(dt, localState) {
    // 1) interpolate remote avatars toward their last received transform
    const k = 1 - Math.pow(0.001, dt);   // critically-damped-ish smoothing
    for (const r of this.remotes.values()) {
      r.pos.lerp(r.target.pos, k);
      r.quat.slerp(r.target.quat, k);
      r.group.position.copy(r.pos);
      r.group.quaternion.copy(r.quat);
      // drive the avatar's leg swing if it exposes the procedural rig
      const ud = r.group.userData;
      if (ud && ud.legL) {
        r._phase = (r._phase || 0) + dt * (r.anim === 'run' ? 11 : 0);
        const sw = Math.sin(r._phase) * (r.anim === 'run' ? 0.6 : 0);
        ud.legL.rotation.x = sw; ud.legR.rotation.x = -sw;
        ud.armL.rotation.x = -sw; ud.armR.rotation.x = sw;
      }
    }

    // 2) throttle outgoing local transform broadcasts
    if (!this._connected || !localState) return;
    this._sendTimer += dt;
    if (this._sendTimer < SEND_DT) return;
    this._sendTimer = 0;
    const p = localState.pos, q = localState.quat;
    this._send({
      type: 'state',
      p: [r3(p.x), r3(p.y), r3(p.z)],
      q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
      a: localState.anim,
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

function r3(n) { return Math.round(n * 1000) / 1000; }
