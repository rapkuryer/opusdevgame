// Shared Capoeira FBX — local player + cloned remotes (SkeletonUtils, no re-download).
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CHAR_HEIGHT } from './config.js';
import { applyOriginalCharacterMaterials } from './characterMaterial.js';

let template = null;
const remotePool = [];

function remapClipBones(clip, root) {
  if (!clip?.tracks?.length) return clip;
  const bones = new Set();
  root.traverse((o) => { if (o.isBone) bones.add(o.name); });
  const alias = (name) => {
    if (bones.has(name)) return name;
    const variants = [
      name.replace(/^mixamorig:/i, 'mixamorig'),
      name.replace(/^mixamorig/i, 'mixamorig:'),
      name.replace(/^Mixamorig:/i, 'mixamorig:'),
    ];
    for (const v of variants) if (bones.has(v)) return v;
    return null;
  };
  clip.tracks = clip.tracks.filter((track) => {
    const bone = track.name.split('.')[0];
    const mapped = alias(bone);
    if (!mapped) return false;
    if (mapped !== bone) track.name = track.name.replace(bone, mapped);
    return true;
  });
  return clip;
}

function stripRootMotion(clip) {
  if (!clip) return clip;
  clip.tracks = clip.tracks.filter((t) => !/Hips\.position$/i.test(t.name));
  return clip;
}

function normalizeCharacter(root) {
  let bb = new THREE.Box3().setFromObject(root);
  const sz = new THREE.Vector3();
  bb.getSize(sz);
  const s = CHAR_HEIGHT / Math.max(0.001, sz.y);
  root.scale.setScalar(s);
  bb = new THREE.Box3().setFromObject(root);
  const ctr = new THREE.Vector3();
  bb.getCenter(ctr);
  root.position.x -= ctr.x;
  root.position.z -= ctr.z;
  root.position.y -= bb.min.y;
}

function buildActions(mixer, clips, root) {
  const pick = (obj) => obj.animations.find((a) => a.tracks.length > 0) || obj.animations[0];
  const idleClip = stripRootMotion(remapClipBones(pick(clips.idle).clone(), root));
  const runClip = stripRootMotion(remapClipBones(pick(clips.run).clone(), root));
  const jumpIdleClip = stripRootMotion(remapClipBones(pick(clips.jumpIdle).clone(), root));
  const jumpRunClip = stripRootMotion(remapClipBones(pick(clips.jumpRun).clone(), root));

  const anim = {
    idle: mixer.clipAction(idleClip),
    run: mixer.clipAction(runClip),
    jumpIdle: mixer.clipAction(jumpIdleClip),
    jumpRun: mixer.clipAction(jumpRunClip),
  };
  anim.jump = anim.jumpRun;
  anim.idle.setLoop(THREE.LoopRepeat, Infinity);
  anim.run.setLoop(THREE.LoopRepeat, Infinity);
  for (const j of [anim.jumpIdle, anim.jumpRun]) {
    j.loop = THREE.LoopOnce;
    j.clampWhenFinished = true;
  }
  return anim;
}

function pickJumpAction(anim, hasMovement) {
  return (hasMovement ? anim.jumpRun : anim.jumpIdle) || anim.jumpRun || anim.jumpIdle;
}

export function setRemoteAnimState(remote, next, fade = 0.22, opts = {}) {
  if (!remote?.mixer || !remote.anim) return;
  const action = next === 'jump'
    ? pickJumpAction(remote.anim, !!opts.hasMovement)
    : remote.anim[next];
  if (!action) return;
  if (next !== 'jump' && remote.curState === next) return;
  if (next === 'jump' && remote.curState === 'jump' && remote.curAction === action) return;
  if (remote.curState === 'jump' && next !== 'jump') fade = Math.max(fade, 0.45);
  const prev = remote.curAction;
  remote.curAction = action;
  remote.curAction.reset();
  if (next === 'jump') remote.curAction.setLoop(THREE.LoopOnce, 1);
  else remote.curAction.setLoop(THREE.LoopRepeat, Infinity);
  remote.curAction.clampWhenFinished = (next === 'jump');
  remote.curAction.fadeIn(fade).play();
  if (prev && prev !== remote.curAction) prev.fadeOut(fade);
  remote.curState = next;
}

export function updateRemoteMixer(remote, dt) {
  if (remote?.mixer) remote.mixer.update(dt);
}

/** Load Capoeira once; returns { model, mixer, anim, setAnimState } for the local player. */
export async function loadPlayerCharacter(anisotropy = 8) {
  const fbx = new FBXLoader();
  const load = (u) => new Promise((res, rej) => fbx.load(u, res, undefined, rej));
  const charSrc = await load('assets/character/capoeira.fbx');
  const [idleFbx, runFbx, jumpIdleFbx, jumpRunFbx] = await Promise.all([
    load('assets/anim/breathing_idle.fbx'),
    load('assets/anim/running.fbx'),
    load('assets/anim/jump.fbx'),
    load('assets/anim/jump_running.fbx'),
  ]);

  normalizeCharacter(charSrc);
  applyOriginalCharacterMaterials(charSrc, { anisotropy });

  const mixer = new THREE.AnimationMixer(charSrc);
  const anim = buildActions(mixer, {
    idle: idleFbx,
    run: runFbx,
    jumpIdle: jumpIdleFbx,
    jumpRun: jumpRunFbx,
  }, charSrc);
  anim.idle.play();

  const holdAnchor = new THREE.Group();
  holdAnchor.position.set(0, CHAR_HEIGHT * 0.57, 0.22);
  charSrc.add(holdAnchor);
  charSrc.userData = {
    holdAnchor,
    isFBX: true,
    isPlayer: true,
    charHeight: CHAR_HEIGHT,
    headY: CHAR_HEIGHT * 0.88,
  };

  template = { root: charSrc, clips: { idleFbx, runFbx, jumpIdleFbx, jumpRunFbx } };

  let curState = 'idle';
  let curAction = anim.idle;

  function setAnimState(next, fade = 0.28, opts = {}) {
    const action = next === 'jump' ? pickJumpAction(anim, !!opts.hasMovement) : anim[next];
    if (!action) return;
    if (next !== 'jump' && curState === next) return;
    if (next === 'jump' && curState === 'jump' && curAction === action) return;
    if (curState === 'jump' && next !== 'jump') fade = Math.max(fade, 0.52);
    if (curState === 'idle' && next === 'run') fade = Math.min(fade, 0.14);
    if (curState === 'run' && next === 'idle') fade = Math.min(fade, 0.34);
    const prev = curAction;
    curAction = action;
    curAction.reset();
    if (next === 'jump') curAction.setLoop(THREE.LoopOnce, 1);
    else curAction.setLoop(THREE.LoopRepeat, Infinity);
    curAction.clampWhenFinished = (next === 'jump');
    curAction.fadeIn(fade).play();
    if (prev && prev !== curAction) prev.fadeOut(fade);
    curState = next;
  }

  return {
    model: charSrc,
    mixer,
    anim,
    setAnimState,
    getState: () => curState,
    getCurAction: () => curAction,
  };
}

function spawnRemoteClone() {
  if (!template) return null;
  const clone = cloneSkeleton(template.root);
  clone.userData = { ...clone.userData, isFBX: true, isRemote: true };
  const mixer = new THREE.AnimationMixer(clone);
  const anim = buildActions(mixer, {
    idle: template.clips.idleFbx,
    run: template.clips.runFbx,
    jumpIdle: template.clips.jumpIdleFbx,
    jumpRun: template.clips.jumpRunFbx,
  }, clone);
  anim.idle.play();
  return {
    group: clone,
    mixer,
    anim,
    curState: 'idle',
    curAction: anim.idle,
    nameTag: null,
    nick: '',
  };
}

/** Pre-warm clone pool across frames so joins never hitch the game loop. */
export function warmRemotePool(target = 9) {
  let made = 0;
  const step = () => {
    while (made < target && remotePool.length < target) {
      const r = spawnRemoteClone();
      if (!r) return;
      r.group.visible = false;
      remotePool.push(r);
      made++;
      if (made % 2 === 0) { requestAnimationFrame(step); return; }
    }
  };
  requestAnimationFrame(step);
}

export function isPlayerCharacterReady() {
  return !!template;
}

/** Pull a pooled Capoeira clone for a remote player (same model as local hero). */
export function createRemotePlayer(nick = '') {
  const remote = remotePool.pop() || spawnRemoteClone();
  if (!remote) {
    const g = new THREE.Group();
    g.visible = false;
    g.userData.isRemote = true;
    return { group: g, mixer: null, anim: null, curState: 'idle', curAction: null, nameTag: null, nick };
  }
  remote.group.visible = true;
  remote.nick = nick;
  remote.curState = 'idle';
  remote.curAction = remote.anim?.idle || null;
  if (remote.curAction) {
    remote.curAction.reset().fadeIn(0.01).play();
  }
  return remote;
}

export function releaseRemotePlayer(remote) {
  if (!remote) return;
  if (remote.nameTag) {
    remote.group.remove(remote.nameTag);
    remote.nameTag.material?.map?.dispose?.();
    remote.nameTag.material?.dispose?.();
    remote.nameTag = null;
  }
  remote.group.visible = false;
  remote.nick = '';
  remote.mixer?.stopAllAction?.();
  if (remotePool.length < 9) remotePool.push(remote);
}
