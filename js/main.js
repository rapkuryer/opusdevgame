import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PLANET_RADIUS, GRAVITY, JUMP, WALK, RUN, RUN_ANIM_SYNC, CHAR_HEIGHT, MOVE, isMobile, CENTER } from './config.js';
import { Multiplayer } from './net.js';
import { loadAbetoPlanet } from './planet.js';
import { SITE_LINKS } from './siteLinks.js';
import { createFollowCamera } from './followCamera.js';
import { CharacterPhysics } from './characterPhysics.js';
import { tuneDirectionalShadow, setupColorMap } from './graphics.js';
import { createToonGradient, syncWorldAtmosphere } from './worldGraphics.js';
import { applyOriginalCharacterMaterials } from './characterMaterial.js';
import { createSkyDome, createSkyUniforms } from './skyDome.js';
import { createWaterDepthPass, syncWaterSceneUniforms } from './waterGraphics.js';
import { inkify, stripInkShells } from './outline.js';
import { createInkOutline } from './inkOutlinePass.js';
import { ASSEMBLY_INNER, ASSEMBLY_OUTER } from './assemblyShader.js';

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference:'high-performance' });
const RENDER_DPR = Math.min(window.devicePixelRatio, isMobile ? 1.05 : 1.28);
renderer.setPixelRatio(RENDER_DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
window.__renderer = renderer;

const scene = new THREE.Scene();
window.__scene = scene;   // debug
scene.fog = null;

// FOV 45 · far 400 (our planet is larger than abeto; sky stays r=55 like messenger).
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.2, 400);
window.__cam=camera;   // debug
const followCam = createFollowCamera(camera, { dispX: -0.15, dispXRange: Math.PI * 0.62 });

function initSiteFooter() {
  const footer = document.getElementById('siteFooter');
  if (!footer) return;
  const tw = footer.querySelector('[data-link="twitter"]');
  const gh = footer.querySelector('[data-link="github"]');
  if (tw) tw.href = SITE_LINKS.twitter;
  if (gh) gh.href = SITE_LINKS.github;
}
initSiteFooter();

let skyDome = null;
const skyUniforms = createSkyUniforms();
const getSkyUniforms = () => skyDome?.uniforms ?? skyUniforms;
(async () => {
  try {
    skyDome = await createSkyDome(scene, renderer);
    window.__skyDome = skyDome;
  } catch (e) {
    console.warn('Sky dome init failed', e);
  }
})();

// Lights — soft warm key (near-white) for clean flat anime tones, brighter fill.
const sun = new THREE.DirectionalLight(0xffd8bc, 3.1);
sun.position.set(40, 60, 30);
tuneDirectionalShadow(sun, { mapSize: 1024, ortho: 24 });
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0x9a7088, 0xc88858, 0.62));
scene.add(new THREE.AmbientLight(0x8a7078, 0.42));
const fill = new THREE.DirectionalLight(0xf5d2b0, 0.42);
fill.position.set(-40, 35, -45); scene.add(fill);

// Toon gradient maps — world props vs dark FBX character
const grad = createToonGradient();
function toon(color){ return new THREE.MeshToonMaterial({ color, gradientMap: grad, fog: true }); }

// Ink outlines — see js/outline.js (inverted hull)

// ---------------------------------------------------------------------------
// Abeto "present" planet — sculpted Draco meshes (see js/planet.js).
// Hitmesh drives physics raycasts; full_0…9 chunks are the visible terrain.
// ---------------------------------------------------------------------------
let worldRadius = PLANET_RADIUS;
let walkable = [];
let surfaceInfo = (dir) => {
  const d = dir.clone().normalize();
  ray.set(d.clone().multiplyScalar(worldRadius + 50), d.negate());
  const hit = ray.intersectObjects(walkable, false)[0];
  if (!hit) return null;
  const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  return { point: hit.point.clone(), normal: hit.face.normal.clone().applyMatrix3(nm).normalize() };
};
let abetoPlanet = null;
let charPhysics = null;

// hill/street basis (legacy road code — unused while BUILD_WORLD=false)
const C0 = new THREE.Vector3(0,1,0.2).normalize();
const T0 = new THREE.Vector3().crossVectors(C0, new THREE.Vector3(1,0,0)).normalize();
const B0 = new THREE.Vector3().crossVectors(C0, T0).normalize();
function terrainHeight(/*dir*/){ return 0; }

const ray = new THREE.Raycaster(); window.__ray=ray;

function randDir(){ return new THREE.Vector3(Math.random()*2-1,Math.random()*2-1,Math.random()*2-1).normalize(); }
function placeOnSurface(obj, dir, lift=0){
  const s = surfaceInfo(dir); if(!s) return false;
  obj.position.copy(s.point).addScaledVector(s.normal, lift);
  obj.quaternion.copy(orientTo(s.normal));
  obj.userData.normal = s.normal.clone();
  return true;
}
const _up = new THREE.Vector3(0,1,0), _q = new THREE.Quaternion();
function orientTo(normal){ return _q.clone().setFromUnitVectors(_up, normal); }

// --- Road ring basis (C0/T0/B0 defined above with the terrain height field) ---
const dirAt = (a,o=0)=> new THREE.Vector3().copy(C0).multiplyScalar(Math.cos(a))
      .addScaledVector(T0, Math.sin(a)).addScaledVector(B0, o).normalize();
const roadDirAt = (a)=> new THREE.Vector3().copy(C0).multiplyScalar(-Math.sin(a)).addScaledVector(T0, Math.cos(a)).normalize();
function roadWobble(a){
  return a + Math.sin(a*3.7)*0.045 + Math.sin(a*1.3+1.1)*0.07;
}
const ROAD_HALF = 0.16;                                  // keep this band (road+sidewalk) clear
function nearRoad(dir){ return Math.abs(dir.dot(B0)) < ROAD_HALF; }
function placeAligned(obj, dir, forwardHint, lift=0){
  const s=surfaceInfo(dir); if(!s) return false;
  obj.position.copy(s.point).addScaledVector(s.normal,lift);
  const up=s.normal;
  let f=forwardHint.clone().addScaledVector(up,-forwardHint.dot(up));
  if(f.lengthSq()<1e-6) f.set(1,0,0); f.normalize();
  const x=new THREE.Vector3().crossVectors(up,f).normalize();
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,up,f));
  obj.userData.normal=up.clone();
  return true;
}

// --- Collision registry: spheres (trees/rocks/cones) + oriented boxes (walls/buildings) ---
const colliders = [];
const PLAYER_R = 0.4;
const GROUND_STICK = 0.14;
function addSphereCol(pos, r){ colliders.push({ pos: pos.clone(), r, bsq:(r+PLAYER_R+0.3)**2 }); }
function addBoxCol(obj, hx, hz, opts = {}){
  obj.updateMatrixWorld(true);
  colliders.push({ box:true, inv: obj.matrixWorld.clone().invert(), mat: obj.matrixWorld.clone(),
    center: obj.getWorldPosition(new THREE.Vector3()), bsq:(Math.hypot(hx,hz)+PLAYER_R+0.6)**2, hx, hz,
    localTopY: opts.localTopY ?? null,
    walkableTop: opts.walkableTop ?? false,
  });
}
const _colLocal = new THREE.Vector3();
const _colFeet = new THREE.Vector3();
// Robust push-out: broadphase reject, clamp per-step displacement, two settle passes.
function resolveCollisions(){
  const r0 = player.position.length();
  if (r0 < 1e-4) return;
  const up = _up.copy(player.position).multiplyScalar(1 / r0);
  const feetLift = charPhysics?.capsuleRadius ?? PLAYER_R;
  const MAXPUSH = 0.35;
  for(let iter=0; iter<2; iter++){
    for(const c of colliders){
      if(player.position.distanceToSquared(c.box?c.center:c.pos) > c.bsq) continue;
      if(c.box){
        _colLocal.copy(player.position).applyMatrix4(c.inv);
        _colFeet.copy(player.position).addScaledVector(up, -feetLift * 0.35).applyMatrix4(c.inv);
        const hx=c.hx+PLAYER_R, hz=c.hz+PLAYER_R;
        const inXZ = Math.abs(_colLocal.x) < hx && Math.abs(_colLocal.z) < hz;
        if (!inXZ) continue;

        const topY = c.localTopY ?? 999;
        const onTop = c.walkableTop && _colFeet.y >= topY - 0.12 && _colLocal.y >= topY - 0.25;

        if (onTop) {
          if (_colFeet.y < topY) {
            _colFeet.y = topY;
            const worldFeet = _colFeet.applyMatrix4(c.mat);
            player.position.copy(worldFeet).addScaledVector(up, feetLift * 0.35).setLength(r0);
          }
          continue;
        }

        if (_colFeet.y < topY - 0.06) {
          const dx=hx-Math.abs(_colLocal.x), dz=hz-Math.abs(_colLocal.z);
          if(dx<dz) _colLocal.x = (_colLocal.x<0?-1:1)*hx; else _colLocal.z = (_colLocal.z<0?-1:1)*hz;
          const target=_colLocal.applyMatrix4(c.mat).setLength(r0);
          player.position.lerp(target, Math.min(1, MAXPUSH/Math.max(1e-3,player.position.distanceTo(target))));
        }
      } else {
        const d = player.position.clone().sub(c.pos);
        d.addScaledVector(up, -d.dot(up));            // tangential only
        const dist=d.length(), min=c.r+PLAYER_R;
        if(dist<min && dist>1e-4){ player.position.addScaledVector(d.normalize(), Math.min(MAXPUSH, min-dist)).setLength(r0); }
      }
    }
  }
}

// Legacy icosphere biome tint + ink rim — removed (abeto Draco planet in planet.js)

// Trees / rocks / houses via instancing-ish (just meshes, count modest)
const treeTrunk = toon(0x7a4f2b), treeLeaf = toon(0x3f8f43), rockMat = toon(0x9a948c);
function addTree(dir){
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.26,1.4,6), treeTrunk); t.position.y=0.7; t.castShadow=true;
  const l = new THREE.Mesh(new THREE.ConeGeometry(1.0,1.9,7), treeLeaf); l.position.y=2.1; l.castShadow=true;
  const l2 = new THREE.Mesh(new THREE.ConeGeometry(0.75,1.4,7), treeLeaf); l2.position.y=2.9; l2.castShadow=true;
  g.add(t,l,l2);
  inkify(g, 0.035);
  if(placeOnSurface(g, dir)){ scene.add(g); addSphereCol(g.position, 0.35); }
}
function addRock(dir){
  const rad = 0.4+Math.random()*0.6;
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(rad,0), rockMat);
  m.castShadow=true; m.rotation.set(Math.random(),Math.random(),Math.random());
  inkify(m, 0.03);
  if(placeOnSurface(m, dir, 0.1)){ scene.add(m); addSphereCol(m.position, rad*0.8); }
}
const bushMat=toon(0x5aa84e), bushMat2=toon(0x6cba5c);
function addBush(dir){
  const g=new THREE.Group();
  for(let i=0;i<3;i++){ const b=new THREE.Mesh(new THREE.IcosahedronGeometry(0.3+Math.random()*0.25,0), i?bushMat2:bushMat);
    b.position.set((Math.random()-.5)*0.5,0.25+Math.random()*0.15,(Math.random()-.5)*0.5); b.castShadow=true; g.add(b); }
  inkify(g,0.02);
  if(placeOnSurface(g, dir)){ scene.add(g); addSphereCol(g.position,0.3); }
}
const houseWall=[toon(0xF2E8C6),toon(0xE88C53),toon(0x5B8FBF)], roofMat=toon(0xC0563C);
function addHouse(dir){
  const g=new THREE.Group();
  const w=new THREE.Mesh(new THREE.BoxGeometry(2.2,1.8,2.2), houseWall[(Math.random()*3)|0]); w.position.y=0.9; w.castShadow=true; w.receiveShadow=true;
  const r=new THREE.Mesh(new THREE.ConeGeometry(1.9,1.2,4), roofMat); r.position.y=2.4; r.rotation.y=Math.PI/4; r.castShadow=true;
  g.add(w,r);
  inkify(g, 0.04);
  if(placeOnSurface(g, dir)){ scene.add(g); addBoxCol(g, 1.1, 1.1); }
}
function offRoadDir(){ let d; let n=0; do{ d=randDir(); n++; }while(Math.abs(d.dot(B0))<0.26 && n<25); return d; }
// trees kept far from the street so they don't crowd the houses
function farDir(){ let d; let n=0; do{ d=randDir(); n++; }while(Math.abs(d.dot(B0))<0.5 && n<25); return d; }
// Decorative scatter (trees / rocks / bushes / box-houses) removed — the world
// is now a sculpted terrain/street landscape. (Functions kept above, unused.)

// ---------------------------------------------------------------------------
// Procedural canvas textures (no external files) — painterly-ish toon surfaces
// ---------------------------------------------------------------------------
function cvtex(w,h,draw){ const c=document.createElement('canvas'); c.width=w;c.height=h;
  draw(c.getContext('2d'),w,h); const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  setupColorMap(t, renderer);
  return t; }
function noiseOverlay(cx,w,h,amt){ const img=cx.getImageData(0,0,w,h),d=img.data;
  for(let i=0;i<d.length;i+=4){ const n=(Math.random()-.5)*amt; d[i]+=n;d[i+1]+=n;d[i+2]+=n; } cx.putImageData(img,0,0); }
// Higher-res procedural textures (2× canvas) — drawing kept resolution-relative
// so the painted pattern is identical, just crisper. Anisotropy/mips via cvtex.
const roadTex = cvtex(512,512,(cx,w,h)=>{
  const u=w/256;
  cx.fillStyle='#6f7378'; cx.fillRect(0,0,w,h);             // asphalt
  cx.fillStyle='#5a5e63'; for(let i=0;i<240;i++){cx.fillRect(Math.random()*w,Math.random()*h,Math.random()*30*u,2*u);}
  cx.fillStyle='#d8d4c8'; cx.fillRect(w/2-4*u,0,8*u,h);     // center line (muted, not white)
  cx.fillStyle='#6f7378'; for(let y=0;y<h;y+=40*u) cx.fillRect(w/2-4*u,y+12*u,8*u,16*u);
  cx.strokeStyle='#c8c4b8'; cx.lineWidth=5*u; cx.beginPath(); cx.moveTo(20*u,0);cx.lineTo(20*u,h);cx.moveTo(w-20*u,0);cx.lineTo(w-20*u,h); cx.stroke();
  noiseOverlay(cx,w,h,18);
});
function wallTex(base,line){ return cvtex(256,256,(cx,w,h)=>{
  const u=w/128;
  cx.fillStyle=base; cx.fillRect(0,0,w,h);
  cx.strokeStyle=line; cx.lineWidth=3*u;
  for(let y=24*u;y<h;y+=28*u){cx.beginPath();cx.moveTo(0,y);cx.lineTo(w,y);cx.stroke();}
  cx.globalAlpha=.5; for(let x=32*u;x<w;x+=32*u){cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,h);cx.stroke();} cx.globalAlpha=1;
  noiseOverlay(cx,w,h,16);
});}
const sidewalkTex = cvtex(256,256,(cx,w,h)=>{ const u=w/128; cx.fillStyle='#B0A898'; cx.fillRect(0,0,w,h);
  cx.strokeStyle='#9a9382'; cx.lineWidth=3*u; for(let x=0;x<=w;x+=32*u){cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,h);cx.stroke();}
  for(let y=0;y<=h;y+=32*u){cx.beginPath();cx.moveTo(0,y);cx.lineTo(w,y);cx.stroke();} noiseOverlay(cx,w,h,12); });
// grass detail — white base (so the biome vertex-color shows through) + green blades
const grassTex = cvtex(512,512,(cx,w,h)=>{ const u=w/256; cx.fillStyle='#ffffff'; cx.fillRect(0,0,w,h);
  for(let i=0;i<2600*u*u;i++){ const x=Math.random()*w,y=Math.random()*h,l=(3+Math.random()*6)*u;
    cx.strokeStyle=`rgba(${50+Math.random()*40|0},${110+Math.random()*55|0},${45+Math.random()*40|0},0.45)`;
    cx.lineWidth=1.1*u; cx.beginPath(); cx.moveTo(x,y); cx.lineTo(x+(Math.random()-.5)*2.5*u,y-l); cx.stroke(); }
  cx.globalAlpha=.10; cx.fillStyle='#3f7d3a'; for(let i=0;i<40*u*u;i++) cx.fillRect(Math.random()*w,Math.random()*h,20*u,20*u); cx.globalAlpha=1; });
function texMat(tex,repeat=1,color=0xffffff){ tex=tex.clone(); tex.needsUpdate=true;
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(repeat,repeat);
  return new THREE.MeshToonMaterial({ map:tex, gradientMap:grad,fog:true, color }); }

// ---------------------------------------------------------------------------
// Continuous ring road around the whole planet (never ends) + a city sector,
// sidewalks, crosswalks, lamps, cones. Built as smooth ribbons that hug terrain.
// ---------------------------------------------------------------------------
const R = PLANET_RADIUS;
// grass texture on icosphere — skipped (abeto terrain shader)

function buildRibbon(centerO, halfW, mat, vRepeat, wSeg=5){
  const seg=220, pos=[], uv=[], idx=[];
  const cols=wSeg+1;
  for(let i=0;i<=seg;i++){
    const a=roadWobble((i/seg)*Math.PI*2);
    for(let s=0;s<cols;s++){
      const o=centerO - halfW + (s/wSeg)*2*halfW;
      const si=surfaceInfo(dirAt(a,o));
      const p = si ? si.point.clone().addScaledVector(si.normal,0.09) : dirAt(a,o).multiplyScalar(R+0.09);
      pos.push(p.x,p.y,p.z); uv.push(s/wSeg, (i/seg)*vRepeat);
    }
  }
  for(let i=0;i<seg;i++) for(let s=0;s<wSeg;s++){
    const a=i*cols+s, b=a+1, c=a+cols, d=c+1;
    idx.push(a,c,b, b,c,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.Mesh(g, mat); m.receiveShadow=true; scene.add(m); return m;
}
// =====================================================================
// ROAD NETWORK — a graph of nodes/edges on the sphere (replaces the single ring).
// Roads follow the existing terrain (each vertex takes its height from surfaceInfo),
// branch into forks, and end in dead-ends → reads as a real street network.
// =====================================================================
const roadGraph = { nodes: [], edges: [] };
function nodeDirFromUV(u, v){
  return new THREE.Vector3()
    .copy(C0).multiplyScalar(Math.cos(u)*Math.cos(v))
    .addScaledVector(T0, Math.sin(u)*Math.cos(v))
    .addScaledVector(B0, Math.sin(v))
    .normalize();
}
const NODES_UV = [
  [-1.30, 0.00],[-0.85, 0.00],[-0.42, 0.03],[0.00, 0.00],[0.42,-0.03],[0.85, 0.00],[1.30, 0.00], // 0-6 spine THROUGH spawn (node3 = spawn dir)
  [-0.85, 0.42],[-0.28, 0.46],[0.42, 0.42],   // 7-9 upper branches
  [-0.60,-0.42],[0.10,-0.42],[0.60,-0.36]     // 10-12 lower branches
];
roadGraph.nodes = NODES_UV.map((uv,i)=>({ id:i, dir: nodeDirFromUV(uv[0], uv[1]) }));
roadGraph.edges = [
  [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],   // main spine
  [1,7],[3,8],[5,9],                     // upper branches → forks at nodes 1,3,5
  [2,10],[4,11],                         // lower branches → forks at nodes 2,4
  [7,8],                                 // upper cross-link (extra junction)
  [6,12]                                 // spur. dead-ends: 0,9,10,11,12
].map(([a,b])=>({a,b}));
const PLAZA_NODES = new Set([3,5]);      // widen the road into a small plaza at these junctions

// ribbon along an arbitrary path of samples [{dir,right(tangent-perp),halfW}]
function buildRibbonPath(samples, mat, vRepeat, wSeg=5){
  const seg=samples.length-1, pos=[], uv=[], idx=[], cols=wSeg+1;
  for(let i=0;i<=seg;i++){ const sm=samples[i];
    for(let s=0;s<cols;s++){
      const o=-sm.halfW + (s/wSeg)*2*sm.halfW;
      const vdir=sm.dir.clone().addScaledVector(sm.right, o).normalize();
      const si=surfaceInfo(vdir);                                  // height from existing terrain noise
      const p=si ? si.point.clone().addScaledVector(si.normal,0.09) : vdir.multiplyScalar(R+0.09);
      pos.push(p.x,p.y,p.z); uv.push(s/wSeg, (i/seg)*vRepeat);
    } }
  for(let i=0;i<seg;i++) for(let s=0;s<wSeg;s++){ const a=i*cols+s; idx.push(a,a+cols,a+1, a+1,a+cols,a+cols+1); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.Mesh(g, mat); m.receiveShadow=true; scene.add(m); return m;
}
// build samples for one edge: slerp direction + tangent-perp + local wobble + plaza widening
function edgeSamples(A, B, centerOff, halfW){
  const steps=26, out=[]; const plazaA=PLAZA_NODES.has(A.id), plazaB=PLAZA_NODES.has(B.id);
  for(let i=0;i<=steps;i++){ const t=i/steps;
    let dir=A.dir.clone().lerp(B.dir,t).normalize();
    let tangent=B.dir.clone().sub(A.dir); tangent.addScaledVector(dir,-tangent.dot(dir));
    if(tangent.lengthSq()<1e-8) tangent.crossVectors(dir,B0); tangent.normalize();
    let right=new THREE.Vector3().crossVectors(dir, tangent).normalize();
    const wob=Math.sin(t*Math.PI*3 + A.id*1.7)*0.02;
    dir=dir.addScaledVector(right, wob+centerOff).normalize();
    right=new THREE.Vector3().crossVectors(dir, tangent).normalize();
    let hw=halfW;
    if(plazaA) hw += Math.max(0,(0.75-t))/0.75*0.05;             // wider near the plaza end
    if(plazaB) hw += Math.max(0,(t-0.25))/0.75*0.05;
    out.push({dir, right, halfW:hw});
  }
  return out;
}
const BUILD_WORLD = false;   // EMPTY WORLD — focus on camera + character
if(BUILD_WORLD) roadGraph.edges.forEach(e=>{
  const A=roadGraph.nodes[e.a], B=roadGraph.nodes[e.b];
  buildRibbonPath(edgeSamples(A,B,-0.105,0.03), texMat(sidewalkTex,1), 26);   // left sidewalk
  buildRibbonPath(edgeSamples(A,B, 0.105,0.03), texMat(sidewalkTex,1), 26);   // right sidewalk
  buildRibbonPath(edgeSamples(A,B, 0.0,  0.075), texMat(roadTex,1), 20);      // road (on top)
});
// (outline for these meshes is applied later by setupPost()/refreshOutline once outlinePass exists)

// --- Fachwerk (half-timbered) houses: white plaster + black timber, steep gable roofs ---
const plasterMats=[wallTex('#F2EFE6','#e8e3d4'), wallTex('#EFEBDE','#e3ddcc'), wallTex('#F4F1E8','#eae4d6')];
// slight self-illumination so plaster never reads as a black mass, even when backlit
plasterMats.forEach(m=>{ m.emissive=new THREE.Color(0x2a2823); });
const roofCols=[0xC86D3A,0xB85F31,0xC2703F,0xA9542B];
const beamMat=toon(0x1C1C1C), frameMat=toon(0xF6F3EA), glassMat=toon(0x39454d), doorMat=toon(0x6a4326);
const rnd=(a,b)=>a+Math.random()*(b-a);
function beam(w,h,d){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d), beamMat); m.userData.noInk=true; m.castShadow=true; return m; }
function recessedWindow(){
  const win=new THREE.Group();
  const frame=new THREE.Mesh(new THREE.BoxGeometry(0.78,0.9,0.12), frameMat);      // thick white frame
  const glass=new THREE.Mesh(new THREE.BoxGeometry(0.54,0.66,0.04), glassMat); glass.position.z=-0.06; // recessed
  const mullV=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.66,0.06), frameMat); mullV.position.z=-0.02;
  const mullH=new THREE.Mesh(new THREE.BoxGeometry(0.54,0.06,0.06), frameMat); mullH.position.z=-0.02;
  win.add(frame,glass,mullV,mullH);
  win.traverse(o=>o.userData.noInk=true);
  return win;
}
// light black timber: 2 rails + 3 posts + 2 braces (~20% coverage), flush to the wall
function fachwerkFace(fw,h){
  const f=new THREE.Group(); const T=0.075, D=0.03;
  [0.04, h-0.04].forEach(y=>{ const r=beam(fw,T,D); r.position.y=y; f.add(r); });            // top/bottom rails
  [-0.5,0,0.5].forEach(fx=>{ const p=beam(T,h,D); p.position.set(fx*fw,h*0.5,0); f.add(p); }); // posts
  [-1,1].forEach(s=>{ const ln=Math.hypot(fw*0.3,h*0.4); const br=beam(T*0.85,ln,D);          // braces
    br.position.set(s*fw*0.32,h*0.5,0); br.rotation.z=-s*Math.atan2(fw*0.3,h*0.4); f.add(br); });
  f.traverse(o=>o.userData.noInk=true); return f;
}
// steep low-poly gable roof (two slopes + triangular gable caps), ridge along width X
function gableRoof(wd,dp,rh,ov,coli){
  const g=new THREE.Group(); const rmat=toon(roofCols[coli%roofCols.length]);
  const slope=Math.hypot(dp/2+ov, rh), ang=Math.atan2(rh, dp/2+ov);
  [-1,1].forEach(s=>{ const pl=new THREE.Mesh(new THREE.BoxGeometry(wd+2*ov,0.1,slope), rmat);
    pl.position.set(0, rh/2, s*(dp/2+ov)/2); pl.rotation.x=s*ang; pl.castShadow=true; g.add(pl); });
  const shp=new THREE.Shape(); shp.moveTo(-dp/2,0); shp.lineTo(dp/2,0); shp.lineTo(0,rh); shp.lineTo(-dp/2,0);
  const cap=new THREE.ExtrudeGeometry(shp,{depth:0.08,bevelEnabled:false});
  [-1,1].forEach(s=>{ const c=new THREE.Mesh(cap, plasterMats[coli%plasterMats.length]);
    c.rotation.y=Math.PI/2; c.position.set(s*wd/2, 0, 0); c.castShadow=true; c.userData.noInk=true; g.add(c); });
  return g;
}
function makeBuilding(seedi){
  // width larger than height, whimsical proportions
  const wd=3.2+Math.random()*1.4, h=2.0+Math.random()*0.7, dp=2.6+Math.random()*0.7;
  const rh=1.3+Math.random()*0.4, ov=0.3, g=new THREE.Group();
  const tilt=new THREE.Group(); g.add(tilt);
  tilt.rotation.set(rnd(-0.02,0.02), rnd(-0.035,0.035), rnd(-0.022,0.022));   // slightly crooked
  const body=new THREE.Mesh(new THREE.BoxGeometry(wd,h,dp), plasterMats[seedi%plasterMats.length]);
  body.position.y=h/2; body.castShadow=body.receiveShadow=true; tilt.add(body);
  // timber framing on all four faces
  const ff=fachwerkFace(wd,h); ff.position.z=dp/2+0.01; tilt.add(ff);
  const fb=fachwerkFace(wd,h); fb.position.z=-(dp/2+0.01); fb.rotation.y=Math.PI; tilt.add(fb);
  const fl=fachwerkFace(dp,h); fl.position.x=-(wd/2+0.01); fl.rotation.y=-Math.PI/2; tilt.add(fl);
  const fr=fachwerkFace(dp,h); fr.position.x=(wd/2+0.01); fr.rotation.y=Math.PI/2; tilt.add(fr);
  // gable roof
  const roof=gableRoof(wd,dp,rh,ov,seedi); roof.position.y=h; tilt.add(roof);
  // recessed windows on the street face (between the posts), leaving a slot for the door
  const nW=Math.max(2,Math.round(wd/1.5));
  for(let i=0;i<nW;i++){ if(i===Math.floor(nW/2)) continue; if(Math.random()<0.1) continue;
    const win=recessedWindow(); win.position.set((i-(nW-1)/2)*(wd/nW), h*0.56, dp/2+0.1); tilt.add(win);
  }
  // door
  const door=new THREE.Mesh(new THREE.BoxGeometry(0.78,1.25,0.14), doorMat);
  door.position.set(0,0.62,dp/2+0.06); door.userData.noInk=true;
  const dframe=new THREE.Mesh(new THREE.BoxGeometry(0.96,1.42,0.08), frameMat); dframe.position.set(0,0.69,dp/2+0.03); dframe.userData.noInk=true;
  tilt.add(dframe,door);
  inkify(g, 0.012);                                           // thin hand-drawn outline
  return {g, half:Math.max(wd,dp)/2};
}
// --- Clean flat-shaded toon houses (no photo textures), upright + uniform scale ---
const WALL_COLORS=[0xD0C4A8,0xDACFB4,0xC8BBA0,0xD6CDB6,0xCABD9E];   // warm beige
const ROOF_COLORS=[0x7A6858,0x6A5848,0x83705E,0x5C4A3A];           // dark brown
const winMat=new THREE.MeshToonMaterial({color:0x243642,gradientMap:grad,fog:true});
const winFrameMat=new THREE.MeshToonMaterial({color:0x487088,gradientMap:grad,fog:true});   // teal-blue frames
const doorMat2=new THREE.MeshToonMaterial({color:0xC87868,gradientMap:grad,fog:true});       // salmon door accent
const acMat2=new THREE.MeshToonMaterial({color:0xBFBBB2,gradientMap:grad,fog:true});
// bigger, more detailed houses — varied silhouettes
const HOUSE_TYPES=[
  {w:5.0,h:6.5,d:5.0,fl:3,roof:'gable',annex:true},
  {w:6.0,h:4.6,d:5.0,fl:1,roof:'flat', shop:true},
  {w:5.0,h:5.6,d:5.0,fl:2,roof:'hip',  balcony:true},
  {w:4.6,h:7.6,d:4.6,fl:3,roof:'gable'},
  {w:5.6,h:5.2,d:5.2,fl:2,roof:'hip',  annex:true},
];
const baseMat=new THREE.MeshToonMaterial({color:0x9a9080,gradientMap:grad,fog:true});
const pipeMatH=new THREE.MeshToonMaterial({color:0x70706a,gradientMap:grad,fog:true});
const railMatH=new THREE.MeshToonMaterial({color:0x8a8276,gradientMap:grad,fog:true});
const awningMats=[new THREE.MeshToonMaterial({color:0xC87868,gradientMap:grad,fog:true}),
                  new THREE.MeshToonMaterial({color:0x3A9050,gradientMap:grad,fog:true}),
                  new THREE.MeshToonMaterial({color:0x487088,gradientMap:grad,fog:true})];
function toonWindow(){
  const g=new THREE.Group();
  const frame=new THREE.Mesh(new THREE.BoxGeometry(1.0,1.24,0.14), winFrameMat);
  const glass=new THREE.Mesh(new THREE.BoxGeometry(0.8,1.04,0.06), winMat); glass.position.z=0.05;
  const mullV=new THREE.Mesh(new THREE.BoxGeometry(0.07,1.04,0.1), winFrameMat); mullV.position.z=0.07;
  const mullH=new THREE.Mesh(new THREE.BoxGeometry(0.8,0.07,0.1), winFrameMat); mullH.position.z=0.07;
  const sill=new THREE.Mesh(new THREE.BoxGeometry(1.12,0.1,0.22), winFrameMat); sill.position.y=-0.66;
  g.add(frame,glass,mullV,mullH,sill); g.traverse(o=>o.userData.noInk=true); return g;
}
function makeToonHouse(idx){
  const t=HOUSE_TYPES[idx%HOUSE_TYPES.length];
  const wallMat=new THREE.MeshToonMaterial({color:WALL_COLORS[idx%WALL_COLORS.length],gradientMap:grad,fog:true});
  const roofMat=new THREE.MeshToonMaterial({color:ROOF_COLORS[idx%ROOF_COLORS.length],gradientMap:grad,fog:true});
  const g=new THREE.Group();
  const body=new THREE.Mesh(new THREE.BoxGeometry(t.w,t.h,t.d), wallMat);
  body.position.y=t.h/2; body.castShadow=body.receiveShadow=true; g.add(body);
  // foundation base band
  const base=new THREE.Mesh(new THREE.BoxGeometry(t.w+0.1,0.5,t.d+0.1), baseMat); base.position.y=0.25; base.castShadow=true; g.add(base);
  // roof
  const md=Math.max(t.w,t.d), ov=0.5;
  if(t.roof==='flat'){
    const r=new THREE.Mesh(new THREE.BoxGeometry(t.w+ov,0.4,t.d+ov), roofMat); r.position.y=t.h+0.2; r.castShadow=true; g.add(r);
  } else if(t.roof==='hip'){
    const rh=1.4, r=new THREE.Mesh(new THREE.CylinderGeometry(0.02, md*0.5+ov, rh,4), roofMat);
    r.rotation.y=Math.PI/4; r.position.y=t.h+rh/2; r.scale.set(t.w/md,1,t.d/md); r.castShadow=true; g.add(r);
  } else { // gable (triangular prism along width X) with eaves
    const rh=1.6, slope=Math.hypot(t.d/2+ov,rh), ang=Math.atan2(rh,t.d/2+ov);
    [-1,1].forEach(s=>{ const pl=new THREE.Mesh(new THREE.BoxGeometry(t.w+ov,0.12,slope), roofMat);
      pl.position.set(0,t.h+rh/2,s*(t.d/2+ov)/2); pl.rotation.x=s*ang; pl.castShadow=true; g.add(pl); });
    const shp=new THREE.Shape(); shp.moveTo(-t.d/2,0); shp.lineTo(t.d/2,0); shp.lineTo(0,rh); shp.lineTo(-t.d/2,0);
    [-1,1].forEach(s=>{ const cap=new THREE.Mesh(new THREE.ExtrudeGeometry(shp,{depth:0.08,bevelEnabled:false}), wallMat);
      cap.rotation.y=Math.PI/2; cap.position.set(s*t.w/2,t.h,0); g.add(cap); });
  }
  // windows on street face
  const cols=Math.max(2,Math.round(t.w/1.8));
  for(let f=0;f<t.fl;f++) for(let c=0;c<cols;c++){
    if(f===0 && c===Math.floor(cols/2) && !t.shop) continue;   // door slot
    const win=toonWindow(); win.position.set((c-(cols-1)/2)*(t.w/cols), 1.1+f*1.55, t.d/2+0.07); body.add(win);
  }
  // door
  const door=new THREE.Mesh(new THREE.BoxGeometry(1.1,2.2,0.14), doorMat2);
  door.position.set(t.shop? -t.w*0.3:0, 1.1, t.d/2+0.06); door.userData.noInk=true; body.add(door);
  // shop awning + hanging sign
  if(t.shop){
    const aw=new THREE.Mesh(new THREE.BoxGeometry(t.w*0.9,0.18,1.1), awningMats[idx%3]);
    aw.position.set(0,2.5,t.d/2+0.55); aw.rotation.x=-0.18; aw.castShadow=true; aw.userData.noInk=true; g.add(aw);
    const sign=new THREE.Mesh(new THREE.BoxGeometry(1.6,0.8,0.12), awningMats[(idx+1)%3]);
    sign.position.set(t.w*0.2,t.h*0.85,t.d/2+0.2); sign.userData.noInk=true; g.add(sign);
  }
  // balcony rail on the upper floor
  if(t.balcony){
    const slab=new THREE.Mesh(new THREE.BoxGeometry(t.w*0.85,0.12,0.6), baseMat); slab.position.set(0,t.h*0.52,t.d/2+0.3); g.add(slab);
    const rail=new THREE.Mesh(new THREE.BoxGeometry(t.w*0.85,0.5,0.06), railMatH); rail.position.set(0,t.h*0.52+0.3,t.d/2+0.58); rail.userData.noInk=true; g.add(rail);
  }
  // side annex (a lower attached box) → breaks the boxy silhouette
  if(t.annex){
    const aw=t.w*0.5, ah=t.h*0.6, ad=t.d*0.7;
    const an=new THREE.Mesh(new THREE.BoxGeometry(aw,ah,ad), wallMat);
    an.position.set(t.w/2+aw/2-0.1, ah/2, -t.d*0.1); an.castShadow=an.receiveShadow=true; g.add(an);
    const ar=new THREE.Mesh(new THREE.BoxGeometry(aw+0.4,0.3,ad+0.4), roofMat); ar.position.set(an.position.x, ah+0.1, an.position.z); g.add(ar);
  }
  // wall AC unit + vertical drain pipe
  const ac=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.55,0.34), acMat2);
  ac.position.set(t.w*0.32,t.h*0.55,t.d/2+0.18); ac.userData.noInk=true; ac.castShadow=true; body.add(ac);
  const pipe=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,t.h*0.9,6), pipeMatH);
  pipe.position.set(-t.w*0.45,t.h*0.45,t.d/2+0.05); pipe.userData.noInk=true; body.add(pipe);
  inkify(g, 0.02);
  return {g, half:Math.max(t.w,t.d)/2 + (t.annex?t.w*0.25:0)};
}
// --- Meshy textured 3D houses, placed upright (yaw-only) + grounded + clustered ---
// Optimized asset pipeline: Draco-compressed geometry + KTX2 (Basis) textures +
// Meshopt — matching the reference's loading stack so heavy .glb assets stream
// fast and stay within mobile/Safari memory limits.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('assets/libs/basis/');
ktx2Loader.detectSupport(renderer);
const gltfLoader=new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
gltfLoader.setKTX2Loader(ktx2Loader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
function loadGLB(url){ return new Promise(res=>gltfLoader.load(url, g=>res(g.scene), undefined, ()=>res(null))); }
// stand on y=0, centred in XZ, scaled to target height but with footprint clamped
// so flat/short models don't blow up into giant slabs; lift dark baked colours
// Brighten only dark baked textures (some Meshy models bake heavy shadow into the map,
// which reads as a black house even with an unlit material). Leaves good textures untouched.
const _texCache=new Map();
function brightenTex(tex){
  if(!tex || !tex.image) return tex;
  if(tex.image.complete === false) return tex;
  if(_texCache.has(tex.uuid)) return _texCache.get(tex.uuid);
  const img=tex.image, W=img.width||512, H=img.height||512;
  const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const cx=cv.getContext('2d', { willReadFrequently:true, alpha:true });
  try{
    cx.clearRect(0,0,W,H);
    cx.drawImage(img,0,0,W,H);
    var d=cx.getImageData(0,0,W,H);
  }catch(e){ return tex; }
  const p=d.data; let sum=0; for(let i=0;i<p.length;i+=4) sum+=p[i]+p[i+1]+p[i+2];
  const avg=sum/((p.length/4)*3)/255;
  if(avg>=0.85) return tex;   // already bright — never over-expose
  if(avg<0.62){
    const g = avg<0.5 ? 0.5 : 0.62, LUT=new Uint8Array(256);
    for(let v=0; v<256; v++) LUT[v]=Math.min(255, 255*Math.pow(v/255, g));
    for(let i=0;i<p.length;i+=4){ p[i]=LUT[p[i]]; p[i+1]=LUT[p[i+1]]; p[i+2]=LUT[p[i+2]]; }
    cx.putImageData(d,0,0);
  }
  const nt=new THREE.CanvasTexture(cv);
  nt.colorSpace=THREE.SRGBColorSpace; nt.flipY=tex.flipY; nt.wrapS=tex.wrapS; nt.wrapT=tex.wrapT;
  setupColorMap(nt, renderer);
  _texCache.set(tex.uuid,nt); return nt;
}
function prepHouse(root, targetH, maxFoot=4.0){
  let b=new THREE.Box3().setFromObject(root), sz=new THREE.Vector3(); b.getSize(sz);
  root.scale.setScalar(targetH/Math.max(0.001,sz.y));
  b=new THREE.Box3().setFromObject(root); b.getSize(sz);
  const fmax=Math.max(sz.x,sz.z)/2;
  if(fmax>maxFoot) root.scale.multiplyScalar(maxFoot/fmax);    // clamp footprint
  b=new THREE.Box3().setFromObject(root); const c=new THREE.Vector3(); b.getCenter(c);
  root.position.x-=c.x; root.position.z-=c.z; root.position.y-=b.min.y;        // base sits on y=0
  // convert to UNLIT material → textures always show at full brightness, never black,
  // and gives the flat painterly look (no shadow-darkening on facades)
  const conv=(m)=>{ const bm=new THREE.MeshBasicMaterial({ side:THREE.DoubleSide });
    if(m && m.map){ bm.map=brightenTex(m.map); bm.color.setRGB(1,1,1); }
    else { let c=(m&&m.color)?m.color.clone():new THREE.Color(0xCAC2B2);
      if(c.r+c.g+c.b<0.55) c.setRGB(0.64,0.60,0.53); bm.color.copy(c); }
    return bm; };
  root.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=false;
    o.material = Array.isArray(o.material)? o.material.map(conv) : conv(o.material); } });
  b=new THREE.Box3().setFromObject(root); const fs=new THREE.Vector3(); b.getSize(fs);
  return { fx:fs.x/2, fz:fs.z/2 };
}
// Buildings removed by design — this world is a terrain/street landscape only.
// We still build the side-alley street network (paths, kerbs, benches), just
// without any houses lining them.
const ALLEY_ORIGINS=[-1.455, -0.685, 0.085, 0.855];
if(BUILD_WORLD) ALLEY_ORIGINS.forEach((originA, idx)=>{
  buildSideAlley(originA, idx%2===0?1:-1, 0.40, 7, [], idx*6);
});

function placeOneGLB(models, i, a, off, hScale){
  const aw=roadWobble(a);
  const up=new THREE.Vector3(0,1,0);
  const model=models[i%models.length].clone(true);
  const wrap=new THREE.Group();
  const dim=prepHouse(model, hScale);
  wrap.add(model);
  const inward = off>0 ? B0.clone().negate() : B0.clone();
  if(placeAligned(wrap, dirAt(aw, off), inward, -0.5)){
    scene.add(wrap);   // face the road squarely — no yaw jitter (keeps the row aligned)
    addBoxCol(wrap, Math.max(0.8,dim.fx*0.85), Math.max(0.8,dim.fz*0.85));
  }
}
// --- Side alleys (perpendicular dead-end branches off the ring road) ---
function alleyLift(a, o){
  return (Math.sin(a*7)+Math.sin(a*3.3))*0.15 + Math.sin(o*12)*0.06;
}
function dirAtOffset(a, o, tangentOffset){
  const base=dirAt(a, o);
  const s=surfaceInfo(base);
  if(!s) return base;
  let tan=roadDirAt(a).clone().addScaledVector(s.normal, -roadDirAt(a).dot(s.normal));
  if(tan.lengthSq()<1e-6) tan.set(1,0,0); tan.normalize();
  return s.point.clone().addScaledVector(tan, tangentOffset).normalize();
}
function alleyForwardAt(a, side){
  const aw=roadWobble(a);
  const s0=surfaceInfo(dirAt(aw, 0)), s1=surfaceInfo(dirAt(aw, side*0.025));
  if(!s0||!s1) return B0.clone().multiplyScalar(side);
  return s1.point.clone().sub(s0.point).normalize();
}
function buildAlleyStrip(a, oStart, oEnd, steps, mat, halfW){
  const aw=roadWobble(a);
  const cols=4, pos=[], uv=[], idx=[];
  for(let i=0;i<=steps;i++){
    const t=i/steps, o=oStart+(oEnd-oStart)*t;
    const lift=0.09+alleyLift(a, o);
    for(let s=0;s<=cols;s++){
      const lo=-halfW+(s/cols)*2*halfW;
      const d=dirAtOffset(aw, o, lo);
      const si=surfaceInfo(d);
      const p=si ? si.point.clone().addScaledVector(si.normal, lift) : d.clone().multiplyScalar(R+lift);
      pos.push(p.x,p.y,p.z); uv.push(s/cols, t*18);
    }
  }
  for(let i=0;i<steps;i++) for(let s=0;s<cols;s++){
    const c=i*(cols+1)+s, b=c+1, a0=c+cols+1, d=a0+1;
    idx.push(c,a0,b, b,a0,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.Mesh(g, mat); m.receiveShadow=true; scene.add(m); return m;
}
function placeAlleyHouse(models, useGLB, idx, a, o, latOff, side, hScale){
  const aw=roadWobble(a);
  const alleyFwd=alleyForwardAt(a, side);
  const houseDir=dirAtOffset(aw, o, latOff);
  const centerDir=dirAt(aw, o);
  const sC=surfaceInfo(centerDir), sH=surfaceInfo(houseDir);
  const inward=sC&&sH ? sC.point.clone().sub(sH.point).normalize() : alleyFwd.clone().negate();
  const lift=-0.5+alleyLift(a, o);
  if(useGLB){
    const model=models[idx%models.length].clone(true);
    const wrap=new THREE.Group();
    const dim=prepHouse(model, hScale);
    wrap.add(model);
    if(placeAligned(wrap, houseDir, inward, lift)){
      scene.add(wrap);
      addBoxCol(wrap, Math.max(0.7,dim.fx*0.85), Math.max(0.7,dim.fz*0.85));
    }
  } else {
    const {g,half}=makeToonHouse(idx);
    if(placeAligned(g, houseDir, inward, lift+0.5)){
      scene.add(g); addBoxCol(g, half*0.85, half*0.85);
    }
  }
}
function buildSideAlley(originA, side, length, steps, models, houseIdxStart=0){
  const aw=roadWobble(originA);
  const oStart=side*0.11, oEnd=side*(0.11+length);
  const HEIGHTS_ALLEY=[8, 9.5, 8.5];
  const useGLB=models&&models.length>0;
  const alleyFwd=alleyForwardAt(originA, side);
  buildAlleyStrip(originA, oStart, oEnd, steps, texMat(sidewalkTex,1), 0.09);
  buildAlleyStrip(originA, oStart, oEnd, steps, texMat(roadTex,1), 0.045);
  for(let i=1;i<steps;i++){
    const o=oStart+(oEnd-oStart)*(i/steps);
    [-1,1].forEach(lat=>{
      const seg=new THREE.Group();
      const body=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.75,1.1), texMat(sidewalkTex,1,0xD7D0BE));
      body.position.y=0.38; seg.add(body);
      seg.children.forEach(m=>{m.castShadow=true;m.receiveShadow=true;}); inkify(seg,0.012);
      if(placeAligned(seg, dirAtOffset(aw, o, lat*0.13), alleyFwd, 0.42+alleyLift(originA,o))){
        scene.add(seg); addBoxCol(seg,0.14,0.58);
      }
    });
  }
  // (houses intentionally not placed — terrain/street landscape only)
  const endLift=alleyLift(originA, oEnd);
  const bench=new THREE.Group();
  const seat=new THREE.Mesh(new THREE.BoxGeometry(1.1,0.08,0.35), toon(0x6a5848)); seat.position.y=0.42;
  const leg1=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.42,0.08), toon(0x5a4a3a)); leg1.position.set(-0.45,0.21,0);
  const leg2=leg1.clone(); leg2.position.x=0.45;
  bench.add(seat,leg1,leg2); inkify(bench,0.015);
  if(placeAligned(bench, dirAtOffset(aw, oEnd, -side*0.04), alleyFwd.clone().negate(), 0.12+endLift)){
    scene.add(bench); addBoxCol(bench, 0.55, 0.2, { walkableTop: true, localTopY: 0.46 });
  }
  const cap=new THREE.Mesh(new THREE.BoxGeometry(1.6,0.85,0.22), texMat(sidewalkTex,1,0xC8C0AE));
  cap.position.y=0.42; inkify(cap,0.012);
  if(placeAligned(cap, dirAt(aw, oEnd), alleyFwd.clone().negate(), 0.44+endLift)){
    scene.add(cap); addBoxCol(cap,0.82,0.12);
  }
}
function placeHousesGLB(models){
  let i=0; const HEIGHTS=[11, 13, 12, 14.5, 12.5];
  for(let a=-1.55; a<=1.55; a+=0.19){
    [-1,1].forEach(side=>{
      placeOneGLB(models, i, a, side*0.20, HEIGHTS[i%HEIGHTS.length]);
      i++;
    });
  }
}
function placeHousesFallback(){
  let idx=0; const LY=new THREE.Vector3(0,1,0);
  for(let a=-1.5; a<=1.5; a+=0.17){
    [-1,1].forEach(side=>{
      if(Math.random()<0.16){ idx++; return; }
      const setback=0.22+Math.random()*0.13;
      const aw=roadWobble(a);
      const {g,half}=makeToonHouse(idx++);
      const inward = side>0 ? B0.clone().negate() : B0.clone();
      if(placeAligned(g, dirAt(aw+(Math.random()-0.5)*0.05, side*setback), inward, 0)){
        g.rotateOnAxis(LY,(Math.random()-0.5)*0.5); scene.add(g); addBoxCol(g, half, half);
      }
    });
  }
}
// (the old per-segment street walls are replaced by the continuous
//  retaining-wall ribbons built in buildRetainingWalls())
// lamp posts all the way around the ring
const lampEm=new THREE.MeshToonMaterial({color:0xfff1c0,gradientMap:grad,fog:true,emissive:0x8a6a10});
const lampPole=toon(0x9a9aa2);   // lighter grey metal (was near-black, looked like a black blob up close)
if(BUILD_WORLD) for(let a=0.16; a<Math.PI*2; a+=0.32){
  const aw=roadWobble(a);
  const side=(Math.round(a/0.32)%2)?1:-1, g=new THREE.Group();
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.08,3,6), lampPole); pole.position.y=1.5;
  const arm=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.7,6), lampPole); arm.rotation.z=Math.PI/2.4; arm.position.set(0.3,2.9,0);
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(0.17,8,8), lampEm); lamp.position.set(0.62,2.78,0);
  g.add(pole,arm,lamp); g.children.forEach(m=>m.castShadow=true); inkify(g,0.02);
  if(placeAligned(g, dirAt(aw, side*0.135), roadDirAt(aw), 0)){ scene.add(g); addSphereCol(g.position,0.16); }
}
// a few cones near the first crosswalk
const coneMat=toon(0xE8581f), coneMat2=toon(0xf2f2ee);
if(BUILD_WORLD) for(let k=0;k<4;k++){
  const aw=roadWobble(0.12+k*0.1), side=(k%2)?1:-1, cone=new THREE.Group();
  const c=new THREE.Mesh(new THREE.ConeGeometry(0.2,0.5,10), coneMat); c.position.y=0.25;
  const base=new THREE.Mesh(new THREE.BoxGeometry(0.36,0.06,0.36), coneMat); base.position.y=0.03;
  const band=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.18,0.1,10), coneMat2); band.position.y=0.28;
  cone.add(base,c,band); cone.children.forEach(m=>m.castShadow=true); inkify(cone,0.02);
  if(placeAligned(cone, dirAt(aw, side*0.08), roadDirAt(aw), 0)){ scene.add(cone); addSphereCol(cone.position,0.26); }
}

// =====================================================================
// MULTI-LEVEL TERRAIN — raised plateaus held by retaining walls, with
// railings and a walkable ramp/lookout. Everything is oriented to the LOCAL
// surface normal (central gravity) and buried into the sphere so there are no
// floating gaps. Walkable tops are registered in `walkable` for grounding.
// (Buildings are intentionally absent — only terrain & support structures.)
// =====================================================================
const stoneMat = texMat(sidewalkTex, 2, 0xEDE7DA);                         // light plaster retaining wall
const railMatT = toon(0x8A8276);
const plateauTopMat = (()=>{ const gt=grassTex.clone(); gt.wrapS=gt.wrapT=THREE.RepeatWrapping; gt.repeat.set(3,3);
  return new THREE.MeshToonMaterial({ map:gt, gradientMap:grad,fog:true, color:0x84C268 }); })();

// thin oriented-box collider at a local offset inside an already-placed group
function sideCollider(parent, lx, lz, hx, hz){
  const o=new THREE.Object3D(); o.position.set(lx,0,lz); parent.add(o);
  o.updateMatrixWorld(true); addBoxCol(o, hx, hz);
}
// simple top-rim railing (top rail per edge), skipping the ramp edge if asked
function addRailing(g, w, d, height, skipFront){
  const y=height+0.6, t=0.06;
  const mk=(geo,x,z)=>{ const m=new THREE.Mesh(geo, railMatT); m.position.set(x,y,z); m.castShadow=true; g.add(m); };
  if(!skipFront) mk(new THREE.BoxGeometry(w,t,t), 0,  d/2);   // road-facing
  mk(new THREE.BoxGeometry(w,t,t), 0, -d/2);                  // back
  mk(new THREE.BoxGeometry(t,t,d),  w/2, 0);                  // sides
  mk(new THREE.BoxGeometry(t,t,d), -w/2, 0);
}
// a raised rectangular plateau (grass top + stone retaining-wall skirt)
function addPlateau(dir, fwd, w, d, height, opt={}){
  const g=new THREE.Group();
  const sink=3.4, H=height+sink;
  const wall=new THREE.Mesh(new THREE.BoxGeometry(w,H,d), stoneMat);
  wall.position.y=height-H/2; wall.castShadow=true; wall.receiveShadow=true; g.add(wall);
  const cap=new THREE.Mesh(new THREE.BoxGeometry(w-0.06,0.4,d-0.06), plateauTopMat);
  cap.position.y=height+0.18; cap.castShadow=true; cap.receiveShadow=true; g.add(cap);
  addRailing(g, w, d, height, opt.rampFront);
  inkify(g, 0.02);
  if(!placeAligned(g, dir, fwd, 0)) return null;
  scene.add(g); g.updateMatrixWorld(true);
  if(opt.walkable) walkable.push(cap);
  if(opt.rampFront){                          // leave the +z (road) side open for the ramp
    sideCollider(g, 0, -d/2, w/2, 0.25);
    sideCollider(g,  w/2, 0, 0.25, d/2);
    sideCollider(g, -w/2, 0, 0.25, d/2);
  } else {
    addBoxCol(g, w/2, d/2);
  }
  return g;
}
// a walkable ramp rising from the street (+z low) up to a plateau top (+z high)
function addRamp(dir, fwd, width, height, run){
  const g=new THREE.Group();
  const ang=Math.atan2(height, run), len=Math.hypot(height, run);
  const slab=new THREE.Mesh(new THREE.BoxGeometry(width,0.3,len), stoneMat);
  slab.rotation.x=-ang; slab.position.set(0, height/2, run/2);
  slab.castShadow=true; slab.receiveShadow=true; g.add(slab);
  inkify(g, 0.02);
  if(!placeAligned(g, dir, fwd, 0)) return null;
  scene.add(g); g.updateMatrixWorld(true);
  walkable.push(slab);
  return g;
}
// place helpers keyed to the road basis: o = lateral offset (sign = side of road)
function inwardAt(aw, o){
  const sC=surfaceInfo(dirAt(aw,0)), sH=surfaceInfo(dirAt(aw,o));
  return (sC&&sH) ? sC.point.clone().sub(sH.point).normalize() : B0.clone().multiplyScalar(-Math.sign(o));
}
function placePlateauAt(a,o,w,d,h,opt){ const aw=roadWobble(a);
  return addPlateau(dirAt(aw,o), inwardAt(aw,o), w,d,h,opt); }

// --- Continuous retaining walls following the street's uphill edge ---------
// A vertical ribbon that hugs the terrain along a path of directions, with
// periodic colliders so the player can't walk through it.
function buildWallRibbon(samples, height, mat){
  const n=samples.length-1, pos=[], uv=[], idx=[];
  for(let i=0;i<=n;i++){
    const si=surfaceInfo(samples[i]);
    const base = si ? si.point.clone() : samples[i].clone().multiplyScalar(R);
    const up   = si ? si.normal : samples[i].clone().normalize();
    const top  = base.clone().addScaledVector(up, height);
    pos.push(base.x,base.y,base.z); uv.push(i/n*12, 0);
    pos.push(top.x, top.y, top.z);  uv.push(i/n*12, 1);
    if(si && i%1===0) addSphereCol(base.clone().addScaledVector(up, height*0.4), 0.7);
  }
  for(let i=0;i<n;i++){ const a=i*2; idx.push(a,a+2,a+1, a+1,a+2,a+3); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.Mesh(g, mat); m.material.side=THREE.DoubleSide;
  m.castShadow=true; m.receiveShadow=true; scene.add(m); return m;
}
function buildRetainingWalls(){
  // walls bound the neighbourhood at its outer edges (beyond the road branches
  // at o≈±0.42) so they never cut across a street
  const N=110, up=[], down=[];
  for(let i=0;i<=N;i++){ const a=roadWobble(-1.35 + 2.7*(i/N));
    up.push(dirAt(a, 0.52)); down.push(dirAt(a, -0.52)); }
  buildWallRibbon(up,   1.8, texMat(sidewalkTex,1,0xEDE7DA));   // tall retaining wall, uphill edge
  buildWallRibbon(down, 1.4, texMat(sidewalkTex,1,0xD7D0BE));   // retaining wall, downhill edge
}
if(BUILD_WORLD) buildRetainingWalls();

// ---------------------------------------------------------------------------
// Character factory (procedural rig: body parts on a root)
// ---------------------------------------------------------------------------
const PALETTE = {
  skin:[0xE8C9A0,0xF0D6B0,0xC79B6E,0x8a5e3c],
  top:[0xF5F0E8,0xFF6B35,0x6FA8DC,0x88C9A1,0xE8C84f],   // 0 = cream sweater (default)
  bottom:[0xC0392B,0x3b4a66,0x444444,0x2e6b5a],          // 0 = dark red shorts (default)
  hat:[0x000000,0xFF6B35,0xFFD700,0x5B8FBF]              // 0 = no hat → hair buns
};
// Anime third-person courier. Built at spec proportions (3.2u tall) inside a body
// group scaled to fit the world; userData keeps the same names the engine animates.
function makeCourier(outfit){
  const g = new THREE.Group();
  const body = new THREE.Group(); body.scale.setScalar(0.6); g.add(body);

  const skin=toon(PALETTE.skin[outfit.skin]);
  const sweater=toon(PALETTE.top[outfit.top]);
  const shorts=toon(PALETTE.bottom[outfit.bottom]);
  const hairC=toon(0x1A1A1A), bootW=toon(0xF5F5F0), soleG=toon(0x48C774);
  const M=(geo,mat,x,y,z)=>{ const m=new THREE.Mesh(geo,mat); m.position.set(x,y,z); m.castShadow=true; return m; };

  // torso / shorts / neck
  body.add(M(new THREE.BoxGeometry(0.72,0.85,0.38), sweater, 0,1.9,0));
  body.add(M(new THREE.BoxGeometry(0.68,0.5,0.36),  shorts, 0,1.25,0));
  body.add(M(new THREE.CylinderGeometry(0.12,0.14,0.2,8), skin, 0,2.52,0));

  // head + face + hair
  const head=new THREE.Group(); head.position.y=2.85; body.add(head);
  head.add(M(new THREE.CylinderGeometry(0.35,0.32,0.42,12), skin, 0,0,0));
  const eyes=[];
  [-0.13,0.13].forEach(x=>{
    const e=M(new THREE.SphereGeometry(0.055,10,10), toon(0x141414), x,-0.02,0.30); e.userData.noInk=true; head.add(e); eyes.push(e);
    const hl=M(new THREE.SphereGeometry(0.018,6,6), toon(0xFFFFFF), x+0.022,0.02,0.34); hl.userData.noInk=true; head.add(hl);
  });
  [[-0.13,0.2],[0.13,-0.2]].forEach(([x,r])=>{ const b=M(new THREE.BoxGeometry(0.1,0.025,0.05), toon(0x2C1810), x,0.06,0.31); b.rotation.z=r; b.userData.noInk=true; head.add(b); });
  const mouth=M(new THREE.BoxGeometry(0.08,0.025,0.05), toon(0xC07860), 0,-0.13,0.31); mouth.userData.noInk=true; head.add(mouth);
  // hair: back + top + bangs + two buns (kept clear of the face)
  const hairBack=M(new THREE.SphereGeometry(0.37,14,12), hairC, 0,0.04,-0.05); hairBack.scale.set(1,0.95,1); head.add(hairBack);
  head.add(M(new THREE.BoxGeometry(0.56,0.16,0.16), hairC, 0,0.16,0.26));      // bangs over forehead
  head.add(M(new THREE.SphereGeometry(0.13,10,10), hairC, -0.18,0.34,0));       // bun L
  head.add(M(new THREE.SphereGeometry(0.13,10,10), hairC,  0.18,0.34,0));       // bun R

  // arms hang along the body (pivot at the shoulder)
  const mkArm=(sx)=>{
    const arm=new THREE.Group(); arm.position.set(sx*0.46,2.1,0); arm.rotation.z=sx*0.13; body.add(arm);
    arm.add(M(new THREE.CylinderGeometry(0.1,0.09,0.42,8), sweater, 0,-0.21,0));
    arm.add(M(new THREE.CylinderGeometry(0.08,0.07,0.38,8), sweater, 0,-0.55,0));
    arm.add(M(new THREE.SphereGeometry(0.09,8,8), skin, 0,-0.78,0));
    return arm;
  };
  const armL=mkArm(-1), armR=mkArm(1);

  // legs (pivot at the hip)
  const mkLeg=(sx)=>{
    const leg=new THREE.Group(); leg.position.set(sx*0.18,1.0,0); body.add(leg);
    leg.add(M(new THREE.CylinderGeometry(0.13,0.11,0.5,8), shorts, 0,-0.25,0));   // thigh
    leg.add(M(new THREE.CylinderGeometry(0.1,0.09,0.48,8), skin,   0,-0.72,0));   // shin
    leg.add(M(new THREE.BoxGeometry(0.2,0.14,0.32), bootW, 0,-0.97,0.06));        // boot
    leg.add(M(new THREE.BoxGeometry(0.22,0.07,0.34), soleG, 0,-1.03,0.06));       // green sole
    return leg;
  };
  const legL=mkLeg(-1), legR=mkLeg(1);

  // backpack on the back
  const packMat=toon(0x4A7C59), packMat2=toon(0x3a6147), buckle=toon(0xE7C25A);
  body.add(M(new THREE.BoxGeometry(0.52,0.66,0.26), packMat, 0,1.95,-0.30));
  body.add(M(new THREE.BoxGeometry(0.56,0.24,0.3),  packMat2,0,2.22,-0.30));
  body.add(M(new THREE.BoxGeometry(0.34,0.3,0.12),  packMat2,0,1.78,-0.46));
  body.add(M(new THREE.BoxGeometry(0.1,0.1,0.04),   buckle,  0,1.8,-0.52));
  [[-0.2],[0.2]].forEach(([x])=>{ const s=M(new THREE.BoxGeometry(0.09,0.62,0.06), packMat2, x,1.95,0.2); body.add(s); });

  // optional conical hat (kept for NPC variety; player default is no hat)
  if(outfit.hat>0){
    const hat=M(new THREE.ConeGeometry(0.34,0.42,10), toon(PALETTE.hat[outfit.hat]), 0,3.18,0);
    const brim=M(new THREE.CylinderGeometry(0.46,0.46,0.05,14), toon(PALETTE.hat[outfit.hat]), 0,2.98,0);
    body.add(hat,brim);
  }

  // parcel hold anchor (in front of chest, world-scaled root coords)
  const holdAnchor=new THREE.Group(); holdAnchor.position.set(0,1.05,0.3); g.add(holdAnchor);

  // outlines come from the global OutlinePass now (no inverted-hull shell → no black-blob artifact)
  g.userData = { legL, legR, armL, armR, head, eyes, holdAnchor };
  return g;
}

// ---------------------------------------------------------------------------
// Player + controller
// ---------------------------------------------------------------------------
const outfit = { skin:0, top:0, bottom:0, hat:0 };
const playerModelPlaceholder = new THREE.Group();
playerModelPlaceholder.visible = false;
let playerModel = playerModelPlaceholder;
const player = new THREE.Group();
player.add(playerModel);
player.visible = false;
scene.add(player);
// Camera-relative character lights — visible from front AND back (not tied to hero facing).
const charFill = new THREE.PointLight(0xfff4e8, 2.4, 9, 1.0);
const charBackFill = new THREE.PointLight(0xd8e8ff, 1.6, 9, 1.1);
const charTopFill = new THREE.PointLight(0xffffff, 0.9, 7, 1.3);
charFill.name = 'charFill';
charBackFill.name = 'charBackFill';
charTopFill.name = 'charTopFill';
scene.add(charFill, charBackFill, charTopFill);
const _charLightFwd = new THREE.Vector3();
const _charLightUp = new THREE.Vector3();
function updateCharacterLights() {
  if (!started) return;
  _charLightUp.copy(player.position).normalize();
  _charLightFwd.copy(cameraForwardTangent());
  charFill.position.copy(player.position)
    .addScaledVector(_charLightFwd, 0.9)
    .addScaledVector(_charLightUp, 1.1);
  charBackFill.position.copy(player.position)
    .addScaledVector(_charLightFwd, -0.85)
    .addScaledVector(_charLightUp, 1.0);
  charTopFill.position.copy(player.position).addScaledVector(_charLightUp, 1.65);
}
window.__player=player;   // debug

// --- Multiplayer: disabled — no procedural constructor avatars in world ---
const ENABLE_MULTIPLAYER = false;
function makeRemoteAvatar(){
  const g = new THREE.Group();
  g.visible = false;
  return g;
}
const mp = new Multiplayer({ scene, makeAvatar: makeRemoteAvatar });
if (ENABLE_MULTIPLAYER) mp.connect();
window.__mp = mp;   // debug

// --- Capoeira FBX character + animation state machine (idle / run / jump) ---
let mixer=null, anim={}, curState='idle', curAction=null;
const ANIMS=['idle','run','jump'];

/** Remap Mixamo clip bone names onto the loaded character skeleton. */
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

(async()=>{
  try{
    const fbx=new FBXLoader();
    const load=(u)=>new Promise((res,rej)=>fbx.load(u,res,undefined,rej));
    const pickClip=(obj)=>obj.animations.find(a=>a.tracks.length>0)||obj.animations[0];
    const stripRoot=(clip)=>{
      if(!clip) return clip;
      clip.tracks=clip.tracks.filter(t=>!/Hips\.position$/i.test(t.name));
      return clip;
    };

    const charSrc=await load('assets/character/capoeira.fbx');
    const [idleFbx, runFbx, jumpIdleFbx, jumpRunFbx] = await Promise.all([
      load('assets/anim/breathing_idle.fbx'),
      load('assets/anim/running.fbx'),
      load('assets/anim/jump.fbx'),
      load('assets/anim/jump_running.fbx'),
    ]);

    // Mixamo ~178u → messenger kid height (~1.28u, abeto proportion)
    let bb=new THREE.Box3().setFromObject(charSrc), sz=new THREE.Vector3(); bb.getSize(sz);
    const s=CHAR_HEIGHT/Math.max(0.001,sz.y); charSrc.scale.setScalar(s);
    bb=new THREE.Box3().setFromObject(charSrc); const ctr=new THREE.Vector3(); bb.getCenter(ctr);
    charSrc.position.x-=ctr.x; charSrc.position.z-=ctr.z; charSrc.position.y-=bb.min.y;

    applyOriginalCharacterMaterials(charSrc, {
      anisotropy: renderer.capabilities.getMaxAnisotropy?.() ?? 8,
    });

    mixer=new THREE.AnimationMixer(charSrc);
    const idleClip=stripRoot(remapClipBones(pickClip(idleFbx).clone(), charSrc));
    const runClip=stripRoot(remapClipBones(pickClip(runFbx).clone(), charSrc));
    const jumpIdleClip=stripRoot(remapClipBones(pickClip(jumpIdleFbx).clone(), charSrc));
    const jumpRunClip=stripRoot(remapClipBones(pickClip(jumpRunFbx).clone(), charSrc));

    anim.idle = mixer.clipAction(idleClip);
    anim.run = mixer.clipAction(runClip);
    anim.jumpIdle = mixer.clipAction(jumpIdleClip);
    anim.jumpRun = mixer.clipAction(jumpRunClip);
    anim.jump = anim.jumpRun;
    anim.idle.setLoop(THREE.LoopRepeat, Infinity);
    anim.run.setLoop(THREE.LoopRepeat, Infinity);
    for (const j of [anim.jumpIdle, anim.jumpRun]) {
      j.loop = THREE.LoopOnce;
      j.clampWhenFinished = true;
    }
    anim.idle.play(); curAction=anim.idle;

    const holdAnchor=new THREE.Group(); holdAnchor.position.set(0, CHAR_HEIGHT * 0.57, 0.22); charSrc.add(holdAnchor);
    charSrc.userData={ holdAnchor, isFBX:true, charHeight: CHAR_HEIGHT, headY: CHAR_HEIGHT * 0.88 };
    player.remove(playerModel);
    if(heldParcel) holdAnchor.add(heldParcel);
    playerModel=charSrc; player.add(playerModel);
    stripInkShells(playerModel);
    if(typeof refreshOutline==='function') refreshOutline();
    console.log('Capoeira player + animations loaded:', Object.keys(anim).join(', '),
      'tracks idle/run/jump:', idleClip.tracks.length, runClip.tracks.length,
      jumpIdleClip.tracks.length, jumpRunClip.tracks.length);
  }catch(e){ console.warn('FBX player load failed', e); }
})();
function pickJumpAction(hasMovement) {
  return (hasMovement ? anim.jumpRun : anim.jumpIdle) || anim.jumpRun || anim.jumpIdle;
}

// cross-fade helper for the animation state machine
function setAnimState(next, fade=0.28, opts={}){
  if(!mixer) return;
  const action = next === 'jump' ? pickJumpAction(!!opts.hasMovement) : anim[next];
  if(!action) return;
  if (next !== 'jump' && curState === next) return;
  if (next === 'jump' && curState === 'jump' && curAction === action) return;
  if (curState === 'jump' && next !== 'jump') fade = Math.max(fade, 0.52);
  if (curState === 'idle' && next === 'run') fade = Math.min(fade, 0.14);
  if (curState === 'run' && next === 'idle') fade = Math.min(fade, 0.34);
  const prev=curAction; curAction=action;
  curAction.reset();
  if(next==='jump') curAction.setLoop(THREE.LoopOnce,1);
  else curAction.setLoop(THREE.LoopRepeat, Infinity);
  curAction.clampWhenFinished = (next==='jump');
  curAction.timeScale = 1.0;
  curAction.fadeIn(fade).play();
  if(prev && prev!==curAction) prev.fadeOut(fade);
  curState=next;
}

// =====================================================================
// SPHERICAL-PLANET CONTROLLER + CAMERA  (abeto Messenger spec)
// Invariants: player.up = normalize(position) EVERY frame; gravity along -up;
// camera copies player.up; orientation via Matrix4.lookAt(pos,target,up).
// FPS-independent smoothing throughout. No fixed world-up — never flips.
// =====================================================================
const TAU = Math.PI*2;
const lerpf = (a,b,t)=>(1-t)*a+t*b;
const lerpCoefFPS = (rate,r)=> 1 - Math.exp(Math.log(1-rate)*r);
const frictionFPS = (f,r)=> Math.exp(Math.log(f)*r);
function efit(x,a,b,c,d){ return c + (x-a)*(d-c)/(b-a); }
function fit(x,a,b,c,d){ const lo=Math.min(c,d),hi=Math.max(c,d); return Math.max(lo,Math.min(hi, efit(x,a,b,c,d))); }
function shortestAngle(from,to){ let d=(to-from)%TAU; if(d>Math.PI)d-=TAU; if(d<-Math.PI)d+=TAU; return from+d; }

// Physics tuning — abeto Messenger spec structure (acceleration + exponential
// friction → momentum/glide, 3 substeps, FPS-independent, central gravity).
// Magnitudes scaled to this world (R≈32, character≈1.85u). Steady-state speed
// v* = accel·damp/(1−damp) per frame ×60 → ≈3.7 u/s walk, ≈6 u/s sprint.
const PHYS = {
  substeps: 3,
  // abeto positionForce 0.0045; scaled up for our larger planet (R≈32) so the
  // courier doesn't crawl — steady walk ≈5.2 u/s (matches RUN_ANIM_SYNC).
  positionForce: 0.0075,
  jumpForce: 0.2,            // abeto default
  gravity: -0.00981,
  damp: 0.92,
  dampIdle: 0.65,
  directionLerp: 0.075,
  rotVelocityMin: 0.0035,
  rotVelocityMax: 0.02,
  sprint: 1.1,
};

const ctrl = {
  vel: new THREE.Vector3(),
  up: new THREE.Vector3(0,1,0),
  east: new THREE.Vector3(1,0,0),
  north: new THREE.Vector3(0,0,1),
  facing: new THREE.Vector3(0,0,1),   // hero forward (tangent plane)
  heading: 0,
  rotationHorizontal: 0,   // abeto yaw — сглаженный, для камеры
  rotationPrev: 0,
  rotationNext: 0,
  moving: false,
  running: false,
  onGround:false, vH:0, speed:0, carrying:false, airTime:0, walkPhase:0, didJump:false,
};

// abeto presentScene — спавн в городе, не у моста ([-10,36,14] = подход к мосту)
const SPAWN = {
  position: new THREE.Vector3(5.81095, 5.80205, 25.7794),
  radius: CHAR_HEIGHT * 0.72,
  yaw: Math.PI * 0.625,
};

// spawn — raycast onto hitmesh after planet + BVH ready (единственный вызов)
function placePlayerSpawn(){
  const initial = SPAWN.position.clone();
  const up = initial.clone().normalize();
  ctrl.up.copy(up);
  let pos;
  if(abetoPlanet){
    const s = abetoPlanet.spawnOnSurface(initial, SPAWN.radius);
    pos = s.point;
    ctrl.up.copy(s.up);
  } else {
    const s = surfaceInfo(up);
    pos = up.clone().multiplyScalar(s ? s.point.length() : worldRadius);
  }
  player.position.copy(pos);
  const dist = player.position.length();
  if (abetoPlanet && Math.abs(dist - worldRadius) > 4) {
    const up = player.position.lengthSq() > 1e-4
      ? player.position.clone().normalize()
      : SPAWN.position.clone().normalize();
    const snap = abetoPlanet.spawnOnSurface(up.multiplyScalar(worldRadius), 0);
    player.position.copy(snap.point);
    ctrl.up.copy(snap.up);
    console.warn('[spawn] corrected radius', dist.toFixed(2), '→', player.position.length().toFixed(2));
  }
  updateUpBasis();
  ctrl.rotationHorizontal = SPAWN.yaw;
  ctrl.rotationPrev = ctrl.rotationNext = SPAWN.yaw;
  ctrl.heading = SPAWN.yaw;
  syncHeroRotationFromHorizontal();
  ctrl.vel.set(0, 0, 0);
  ctrl.vH = 0;
  ctrl.speed = 0;
  if (charPhysics) {
    charPhysics._velPhys.set(0, 0, 0);
    charPhysics._lastFloorPosition = pos.clone();
    charPhysics._needsToLand = false;
    charPhysics._jumpHoldUntil = 0;
    charPhysics._prevIsOnFloor = true;
    charPhysics._isOnFloor = true;
    updateUpBasis();
    let sample = charPhysics._measureGround(player, ctrl.up);
    charPhysics._snapToGround(player, ctrl, sample);
    sample = charPhysics._measureGround(player, ctrl.up);
    charPhysics._groundGap = sample.gap;
  }
}

// up = radius-vector outward; build a tangent east/north reference (compass/FX)
function updateUpBasis(){
  ctrl.up.copy(player.position).normalize();
  ctrl.east.crossVectors(ctrl.up, new THREE.Vector3(0,1,0));
  if(ctrl.east.lengthSq()<1e-4) ctrl.east.set(1,0,0);
  ctrl.east.normalize();
  ctrl.north.crossVectors(ctrl.east, ctrl.up).normalize();
}
// hero stands feet-to-planet; spawn / reset only
function orientHero(){
  const up = ctrl.up;
  let f = ctrl.facing.clone().addScaledVector(up, -ctrl.facing.dot(up));
  if(f.lengthSq()<1e-6){ f.crossVectors(up, new THREE.Vector3(0,1,0)); if(f.lengthSq()<1e-6) f.set(1,0,0); }
  f.normalize(); ctrl.facing.copy(f);
  const x = new THREE.Vector3().crossVectors(up, f).normalize();
  player.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, f));
}

// Поворот модели строго из rotationHorizontal в tangent east/north (без дрифта от -Z back)
function syncHeroRotationFromHorizontal(){
  const up = ctrl.up;
  ctrl.facing.copy(ctrl.north).multiplyScalar(Math.cos(ctrl.rotationHorizontal))
    .addScaledVector(ctrl.east, Math.sin(ctrl.rotationHorizontal)).normalize();
  const x = new THREE.Vector3().crossVectors(up, ctrl.facing).normalize();
  player.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, ctrl.facing));
}

// camera look direction → tangent plane (W = куда смотрит камера)
const _camFwd = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _accelDir = new THREE.Vector3();
const _physRight = new THREE.Vector3();
const _tangPre = new THREE.Vector3();
const _tang = new THREE.Vector3();
const _camFwdCached = new THREE.Vector3();
let _camFwdTick = -1;
function cameraForwardTangent(){
  if(_camFwdTick === tickId) return _camFwdCached;
  _camFwdTick = tickId;
  const up = ctrl.up;
  camera.updateMatrixWorld(false);
  camera.getWorldDirection(_camFwd);
  _camFwd.addScaledVector(up, -_camFwd.dot(up));
  if(!Number.isFinite(_camFwd.x) || _camFwd.lengthSq()<1e-6){
    _camFwd.copy(ctrl.facing);
    _camFwd.addScaledVector(up, -_camFwd.dot(up));
  }
  if(_camFwd.lengthSq()<1e-6) _camFwd.copy(ctrl.facing);
  return _camFwdCached.copy(_camFwd).normalize();
}

// Physics: gravity along -up → camera-relative tangent accel → friction →
// substep integrate → sphere ground clamp → hero heading + orientation.
function physicsUpdate(ix, iz, sprint, jumpPressed, ratio){
  updateUpBasis();
  const up = ctrl.up;
  const camFwd = cameraForwardTangent();
  const right = _physRight.crossVectors(camFwd, up).normalize();
  const inputMag = Math.min(1, Math.hypot(ix, iz));
  const isMoving = inputMag > 1e-5;
  ctrl.moving = isMoving;

  const accelDir = _accelDir.set(0, 0, 0);
  if (inputMag > 0.001) {
    accelDir.addScaledVector(camFwd, iz).addScaledVector(right, ix);
    if (accelDir.lengthSq() > 1e-6) accelDir.normalize();
  }

  // abeto rotationHorizontal — input theta + camera spherical theta
  ctrl.rotationPrev = ctrl.rotationNext;
  if (isMoving && inputMag > 0.001) {
    const moveTheta = Math.atan2(accelDir.dot(ctrl.east), accelDir.dot(ctrl.north));
    const tgt = shortestTarget(ctrl.rotationNext, moveTheta);
    ctrl.rotationNext += (tgt - ctrl.rotationNext) * lerpCoefFPS(PHYS.directionLerp, ratio);
  }
  _tangPre.copy(ctrl.vel).addScaledVector(up, -ctrl.vel.dot(up));
  const vHpre = _tangPre.length();
  if (vHpre > PHYS.rotVelocityMin) {
    _tangPre.applyAxisAngle(up, ctrl.rotationPrev);
    _qInv.copy(player.quaternion).invert();
    _tangPre.applyQuaternion(_qInv);
    const velTheta = Math.atan2(_tangPre.x, _tangPre.z);
    const velBlend = fit(vHpre, PHYS.rotVelocityMin, PHYS.rotVelocityMax, 0, 1);
    const velTgt = shortestTarget(ctrl.rotationNext, velTheta);
    ctrl.rotationNext += (velTgt - ctrl.rotationNext)
      * lerpCoefFPS(PHYS.directionLerp * velBlend, ratio);
  }
  ctrl.rotationHorizontal = lerpf(ctrl.rotationPrev, ctrl.rotationNext, lerpCoefFPS(1, ratio));
  if (!Number.isFinite(ctrl.rotationHorizontal)) ctrl.rotationHorizontal = ctrl.rotationPrev;
  ctrl.heading = ctrl.rotationHorizontal;
  syncHeroRotationFromHorizontal();

  // abeto collisionPhysics — полный цикл: accel → gravity → substeps → detectGround
  if (charPhysics?.bvhGeo?.boundsTree) {
    ctrl.didJump = charPhysics.update(player, ctrl, ratio, {
      moveDir: accelDir,
      inputMag,
      isMoving,
      jumpRequested: jumpPressed,
      sprint,
    });
    // BVH hitmesh handles terrain — legacy box colliders fight capsule physics
    if (!charPhysics?.bvhGeo?.boundsTree) resolveCollisions();
    updateUpBasis();
    syncHeroRotationFromHorizontal();
    return;
  }
  // fallback before BVH ready
  const sub = PHYS.substeps;
  const _n = new THREE.Vector3();
  const _gnd = new THREE.Vector3();
  for(let i=0;i<sub;i++){
    player.position.addScaledVector(ctrl.vel, ratio/sub);
    if(!Number.isFinite(player.position.x)){ ctrl.vel.set(0,0,0); break; }
  }
  updateUpBasis();
  const upStep = ctrl.up;
  const s = surfaceInfo(_n.copy(player.position).normalize());
  if(s){
    const gR = s.point.length();
    if(player.position.length() <= gR + 0.05){
      player.position.copy(s.point);
      const rv = ctrl.vel.dot(s.normal);
      if(rv < 0) ctrl.vel.addScaledVector(s.normal, -rv);
      ctrl.onGround = true;
    }
  } else if(player.position.length() <= worldRadius){
    _n.copy(player.position).normalize();
    player.position.setLength(worldRadius);
    const rv = ctrl.vel.dot(_n);
    if(rv<0) ctrl.vel.addScaledVector(_n, -rv);
    ctrl.onGround = true;
  }
  updateUpBasis();
  syncHeroRotationFromHorizontal();
}

// abeto getShortestRotationAngle
function shortestTarget(from, to){
  const i = ((from % TAU) + TAU) % TAU;
  let s = ((to % TAU) + TAU) % TAU;
  if(Math.abs(s - i) > Math.PI) s += s > i ? -TAU : TAU;
  return from + s - i;
}

// debug: совпадение facing / velocity / rotationHorizontal
window.__walkProbeStart = () => {
  window.__walkFrom = player.position.clone();
};
window.__probeOrientation = () => {
  const up = ctrl.up;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion);
  fwd.addScaledVector(up, -fwd.dot(up));
  if (fwd.lengthSq() > 1e-8) fwd.normalize();
  const tang = ctrl.vel.clone().addScaledVector(up, -ctrl.vel.dot(up));
  const vLen = tang.length();
  const faceAngle = Math.atan2(fwd.dot(ctrl.east), fwd.dot(ctrl.north));
  const velAngle = vLen > 0.004 ? Math.atan2(tang.dot(ctrl.east), tang.dot(ctrl.north)) : null;
  const align = vLen > 0.004 ? fwd.dot(tang.clone().normalize()) : null;
  const wrap = (a) => {
    if (!Number.isFinite(a)) return 0;
    let d = a % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d;
  };
  const rh = Number.isFinite(ctrl.rotationHorizontal) ? ctrl.rotationHorizontal : 0;
  let moveAlign = null, moveFaceDelta = null;
  if (window.__walkFrom) {
    const d = player.position.clone().sub(window.__walkFrom);
    d.addScaledVector(up, -d.dot(up));
    const dLen = d.length();
    if (dLen > 0.05) {
      d.divideScalar(dLen);
      moveAlign = fwd.dot(d);
      const moveAngle = Math.atan2(d.dot(ctrl.east), d.dot(ctrl.north));
      moveFaceDelta = wrap(faceAngle - moveAngle);
    }
  }
  return {
    align: align != null && Number.isFinite(align) ? +align.toFixed(4) : null,
    moveAlign: moveAlign != null ? +moveAlign.toFixed(4) : null,
    moveFaceDelta: moveFaceDelta != null ? +moveFaceDelta.toFixed(4) : null,
    faceRhDelta: +wrap(faceAngle - rh).toFixed(4),
    velRhDelta: velAngle != null ? +wrap(velAngle - rh).toFixed(4) : null,
    faceVelDelta: velAngle != null ? +wrap(faceAngle - velAngle).toFixed(4) : null,
    rotationHorizontal: +rh.toFixed(4),
    vH: Number.isFinite(ctrl.vH) ? +ctrl.vH.toFixed(4) : 0,
    started,
  };
};

window.__recoverPos = () => {
  placePlayerSpawn();
  followCam.initFromHeading(ctrl.rotationHorizontal);
  return player.position.toArray().map((n) => +n.toFixed(3));
};

window.__physicsProbe = () => {
  const up = ctrl.up;
  ray.set(player.position.clone().addScaledVector(up, 0.005), up.clone().negate());
  ray.far = 2.5;
  const hit = charPhysics?.collider ? ray.intersectObject(charPhysics.collider, false)[0] : null;
  ray.far = Infinity;
  let floorDot = 0;
  if (hit?.face) {
    const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    floorDot = hit.face.normal.clone().applyMatrix3(nm).normalize().dot(up);
  }
  const groundDist = hit ? hit.distance - 0.005 : 999;
  const radialV = ctrl.vel.dot(up);
  return {
    pos: player.position.toArray().map((n) => +n.toFixed(3)),
    onGround: ctrl.onGround,
    vH: +(ctrl.vH ?? 0).toFixed(4),
    radialV: +radialV.toFixed(4),
    speed: +(ctrl.speed ?? 0).toFixed(3),
    groundDist: +groundDist.toFixed(3),
    floorDot: +floorDot.toFixed(3),
    isOnFloor: charPhysics?.isOnFloor ?? null,
  };
};

window.__bridgeStepProbe = () => {
  if (!charPhysics?.collider) return null;
  const up = ctrl.up;
  const camFwd = cameraForwardTangent();
  return charPhysics.probeAutoStep(player, ctrl, camFwd);
};

window.__spawnCity = () => {
  placePlayerSpawn();
  followCam.initFromHeading(ctrl.rotationHorizontal);
  return window.__physicsProbe?.();
};

window.__jumpProbe = async () => {
  jumpKeyDown = false;
  keys['Space'] = false;
  await new Promise((r) => setTimeout(r, 400));
  const y0 = player.position.y;
  const up = ctrl.up.clone();
  const base = player.position.clone();
  const cp = charPhysics;
  const pre = cp ? {
    gap: cp.groundGap,
    onFloor: cp._prevIsOnFloor,
    needsLand: cp._needsToLand,
    bvh: !!cp.bvhGeo?.boundsTree,
  } : null;
  keys['Space'] = true;
  jumpKeyDown = false;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    keys['Space'] = false;
    jumpKeyDown = false;
  }
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const lift = player.position.clone().sub(base).dot(up);
    if (lift > peak) peak = lift;
  }
  return {
    peakLift: +peak.toFixed(3),
    y0: +y0.toFixed(3),
    y1: +player.position.y.toFixed(3),
    pre,
    post: cp ? { gap: cp.groundGap, vUp: cp._velPhys.dot(up), needsLand: cp._needsToLand } : null,
  };
};

// Animation (idle / run / jump) — synced to physics, no walk, no air-run
function updateAnim(dt, hasInput, sprint){
  const parts = playerModel.userData;
  if(parts && parts.isFBX && mixer){
    mixer.update(dt);

    ctrl.airTime = ctrl.onGround ? 0 : ctrl.airTime + dt;
    const groundGap = charPhysics?.groundGap ?? 0;
    const inJumpArc = charPhysics?._needsToLand;
    const jumping = ctrl.didJump || inJumpArc || charPhysics?._jumpRequested;
    const grounded = ctrl.onGround
      && (charPhysics?.isOnFloor ?? true)
      && groundGap < 0.18
      && !inJumpArc;
    const physSpeed = ctrl.vH * 60;
    const airborne = jumping
      || (!grounded && groundGap > 0.05 && ctrl.airTime > 0.02);

    // Hold jump clip through takeoff, apex, and landing blend.
    if (curState === 'jump') {
      if (airborne || jumping) {
        const clip = curAction?.getClip();
        const clipT = clip ? curAction.time / clip.duration : 1;
        if (clipT < 0.92) {
          ctrl.didJump = false;
          return;
        }
      }
    }
    ctrl.didJump = false;

    let next;
    if (airborne || jumping) next = 'jump';
    // Keep running while the body still carries momentum (glide), so the legs
    // decelerate naturally instead of snapping to idle the instant input ends.
    else if (grounded && (hasInput || physSpeed > 0.6)) next = 'run';
    else next = 'idle';

    if (next !== curState) {
      let fadeIn = 0.22;
      if (curState === 'idle' && next === 'run') fadeIn = 0.12;
      else if (next === 'jump') fadeIn = 0.06;
      else if (curState === 'jump') fadeIn = 0.55;
      else if (curState === 'run' && next === 'idle') fadeIn = 0.34;
      const jumpMove = hasInput || physSpeed > 0.25;
      if (next === 'jump') setAnimState('jump', fadeIn, { hasMovement: jumpMove });
      else setAnimState(next, fadeIn);
    }

    if (curAction && curState === 'jump' && airborne) {
      curAction.timeScale = 1.0;
    } else if (curAction && curState === 'run' && physSpeed > 0.2) {
      // Scale leg speed to real ground speed — also during the glide-to-stop so
      // the run visibly slows down before blending to idle (no robotic snap).
      curAction.timeScale = THREE.MathUtils.clamp(physSpeed / RUN_ANIM_SYNC, 0.42, 1.08);
    } else if (curAction && curState === 'idle') {
      curAction.timeScale = 1.0;
    }
  } else if(parts && parts.legL){
    // procedural fallback (only until the FBX loads)
    ctrl.walkPhase=(ctrl.walkPhase||0)+dt*(ctrl.vH>0.002?(sprint?15:10):0);
    const amp=(ctrl.vH>0.002?(sprint?0.7:0.5):0), sw=Math.sin(ctrl.walkPhase)*amp;
    parts.legL.rotation.x=sw; parts.legR.rotation.x=-sw;
    parts.armL.rotation.set(-sw,0,0); parts.armR.rotation.set(sw,0,0);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = {};
let jumpKeyDown = false;
addEventListener('keydown', e=>{ keys[e.code]=true;
  if(e.code==='Space'){ e.preventDefault(); jumpKeyDown = false; }
  if(e.code==='KeyE'||e.code==='Enter') interact();
  if(dialog.active && (e.code==='Space')) advanceDialog();
});
addEventListener('keyup', e=>{ keys[e.code]=false; if(e.code==='Space') jumpKeyDown=false; });

// Курсор: горизонталь — delta-орбита 360°, вертикаль — parallax по Y
let mNY = 0;
addEventListener('mousemove', (e) => {
  mNY = (e.clientY / innerHeight) * 2 - 1;
  if (started && e.movementX) followCam.addPointerDeltaX(e.movementX, innerWidth);
});

// Touch: left half = joystick move, right half = look
const stickEl = document.getElementById('stick');
let stickId=null, stickBase={x:0,y:0}, stickVec={x:0,y:0};
let lookId=null, lookLastX=null;
function onTouchStart(e){
  for(const t of e.changedTouches){
    if(t.clientX < innerWidth/2 && stickId===null){
      stickId=t.identifier; stickBase={x:t.clientX,y:t.clientY};
      stickEl.style.display='block'; stickEl.style.left=(t.clientX-60)+'px'; stickEl.style.top=(t.clientY-60)+'px';
    } else if(lookId===null){ lookId=t.identifier; lookLastX=t.clientX; }
  }
}
function onTouchMove(e){
  for(const t of e.changedTouches){
    if(t.identifier===stickId){
      let dx=t.clientX-stickBase.x, dy=t.clientY-stickBase.y;
      const len=Math.hypot(dx,dy), max=50; if(len>max){ dx*=max/len; dy*=max/len; }
      stickVec={x:dx/max, y:dy/max};
      stickEl.firstElementChild.style.transform=`translate(${dx}px,${dy}px)`;
    } else if(t.identifier===lookId){
      if (lookLastX !== null) followCam.addPointerDeltaX(t.clientX - lookLastX, innerWidth);
      lookLastX = t.clientX;
      mNY = (t.clientY / innerHeight) * 2 - 1;
    }
  }
  e.preventDefault();
}
function onTouchEnd(e){
  for(const t of e.changedTouches){
    if(t.identifier===stickId){ stickId=null; stickVec={x:0,y:0}; stickEl.style.display='none'; stickEl.firstElementChild.style.transform=''; }
    if(t.identifier===lookId){ lookId=null; lookLastX=null; }
  }
}
if(isMobile){
  renderer.domElement.addEventListener('touchstart', onTouchStart, {passive:false});
  renderer.domElement.addEventListener('touchmove', onTouchMove, {passive:false});
  renderer.domElement.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchmove', e=>{ if(e.target===renderer.domElement) e.preventDefault(); }, {passive:false});
  document.getElementById('mobileHint').style.display='block';
  setTimeout(()=>document.getElementById('mobileHint').style.display='none', 6000);
}

// ---------------------------------------------------------------------------
// NPCs + delivery quests
// ---------------------------------------------------------------------------
const npcNames = ['Pip','Bo','Luna','Gus','Mira','Tово','Hazel','Otis','Wren','Figaro'];
const senderLines = [
  ["Oh, a courier! Perfect timing.","Could you take this little parcel to my friend?","They're somewhere over the hills. Thank you!"],
  ["Psst… this letter is very important.","Don't peek inside! Just deliver it, okay?","Follow the compass. Off you go!"],
  ["My package is ready to send!","It's a surprise gift — handle with care.","Bring it to the marked friend. Cheers!"]
];
const recvLines = [
  ["For me? You shouldn't have!","Oh I've been waiting for this. Thank you!"],
  ["A delivery! How lovely.","You're the best courier on this little planet."],
  ["Finally it arrived!","Here, have a happy little emoji. 🎉"]
];

const npcs = [];
function makeNPC(dir, name){
  const o = { skin:(Math.random()*4)|0, top:(Math.random()*5)|0, bottom:(Math.random()*4)|0, hat:(Math.random()*4)|0 };
  const model = makeCourier(o);
  const g = new THREE.Group(); g.add(model);
  placeOnSurface(g, dir, 0.0);
  // marker (envelope) above head
  const marker = makeMarker('✉️');
  marker.position.y = 2.7; marker.visible=false; g.add(marker);
  scene.add(g);
  addSphereCol(g.position, 0.55);           // solid: player can't walk through NPCs
  const npc = { group:g, model, name, marker, dir, role:null, idlePhase:Math.random()*6 };
  npcs.push(npc); return npc;
}
// sprite marker from emoji
function makeMarker(emoji){
  const cv=document.createElement('canvas'); cv.width=cv.height=128;
  const cx=cv.getContext('2d'); cx.clearRect(0,0,128,128);
  cx.font='90px serif'; cx.textAlign='center'; cx.textBaseline='middle';
  cx.fillText(emoji,64,70);
  const tex=new THREE.CanvasTexture(cv);
  tex.premultiplyAlpha = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false, alphaTest: 0.05
  }));
  sp.scale.set(1.1,1.1,1.1); sp.renderOrder=999;
  sp.userData.setEmoji=(e)=>{ cx.clearRect(0,0,128,128); cx.fillText(e,64,70); tex.needsUpdate=true; };
  return sp;
}

// NPCs removed for now (cleaner, calmer scene + better performance).
// Set NPC_COUNT > 0 to bring wandering residents back.
const NPC_COUNT = 0;
for(let i=0;i<NPC_COUNT;i++){
  const dir = new THREE.Vector3(Math.sin(i*0.9)*0.9, (i%5-2)*0.35, Math.cos(i*1.3)).normalize();
  makeNPC(dir, npcNames[i]);
}

// Build quest chain: 5 deliveries, each links sender->recipient
let TOTAL = 5, done = 0;
const quests = [];
function buildQuests(){
  const pool = npcs.filter(n=>!n.isAlien);
  if(pool.length < 2) return;   // no residents → no deliveries
  for(let i=0;i<Math.min(TOTAL,pool.length);i++){
    const sender = pool[i], recipient = pool[(i+5)%pool.length];
    quests.push({ sender, recipient, picked:false, delivered:false,
      sLines: senderLines[i%senderLines.length], rLines: recvLines[i%recvLines.length] });
  }
}
buildQuests();
let activeQuest = 0;
function refreshMarkers(){
  npcs.forEach(n=>{ n.marker.visible=false; });
  const q = quests[activeQuest];
  if(!q) return;
  if(!q.picked){ q.sender.marker.userData.setEmoji('✉️'); q.sender.marker.visible=true; }
  else if(!q.delivered){ q.recipient.marker.userData.setEmoji('📦'); q.recipient.marker.visible=true; }
}
refreshMarkers();

// parcel held by player (parented to the hand anchor so it sits in the hands)
let heldParcel = null;
function giveParcel(){
  heldParcel = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.34,0.4), toon(0xC8924A));
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.42,0.08,0.42), toon(0xE8C26a));
  heldParcel.add(tape); heldParcel.castShadow=true;
  inkify(heldParcel, 0.018);
  ctrl.carrying = true;
  (playerModel.userData.holdAnchor || playerModel).add(heldParcel);
}
function dropParcel(){ if(heldParcel){ heldParcel.parent.remove(heldParcel); heldParcel=null; } ctrl.carrying=false; }

// ---------------------------------------------------------------------------
// Dialog system
// ---------------------------------------------------------------------------
const dialog = { active:false, lines:[], idx:0, onDone:null };
const dlgEl=document.getElementById('dialog'), dlgName=document.getElementById('dlgName'), dlgLine=document.getElementById('dlgLine');
function startDialog(name, lines, onDone){
  dialog.active=true; dialog.lines=lines; dialog.idx=0; dialog.onDone=onDone;
  dlgName.textContent=name; dlgLine.textContent=lines[0]; dlgEl.classList.add('show');
}
function advanceDialog(){
  if(!dialog.active) return;
  dialog.idx++;
  if(dialog.idx>=dialog.lines.length){
    dialog.active=false; dlgEl.classList.remove('show');
    const cb=dialog.onDone; dialog.onDone=null; if(cb) cb();
  } else dlgLine.textContent=dialog.lines[dialog.idx];
}
dlgEl.addEventListener('click', advanceDialog);

// nearest interactable NPC
let nearNPC=null;
function interact(){
  if(dialog.active){ advanceDialog(); return; }
  if(!nearNPC) return;
  const q=quests[activeQuest];
  if(nearNPC.isAlien){
    startDialog(nearNPC.name, ['Zorp wlikko manee?','*friendly alien noises*','Bl* blorp. 🛸'], null);
    return;
  }
  if(q && nearNPC===q.sender && !q.picked){
    startDialog(nearNPC.name, q.sLines, ()=>{ q.picked=true; giveParcel(); refreshMarkers(); pop('pickup'); });
  } else if(q && nearNPC===q.recipient && q.picked && !q.delivered){
    startDialog(nearNPC.name, q.rLines, ()=>{ q.delivered=true; dropParcel(); completeDelivery(); });
  } else {
    startDialog(nearNPC.name, ['Hello there, courier!','Lovely day on our little planet, isn\'t it?'], null);
  }
}

function completeDelivery(){
  done++; document.getElementById('dcount').textContent=done;
  flash('🎉'); pop('deliver'); spawnConfetti();
  activeQuest++;
  if(done>=TOTAL){ setTimeout(showWin, 900); }
  else refreshMarkers();
}

// ---------------------------------------------------------------------------
// FX: confetti particles + flash + emoji bursts
// ---------------------------------------------------------------------------
const fxParticles=[];
function spawnConfetti(){
  for(let i=0;i<26;i++){
    const m=new THREE.Mesh(new THREE.PlaneGeometry(0.16,0.16),
      new THREE.MeshBasicMaterial({color:new THREE.Color().setHSL(Math.random(),.8,.6), side:THREE.DoubleSide}));
    m.position.copy(player.position).addScaledVector(ctrl.up,1.8);
    const v=ctrl.up.clone().multiplyScalar(4+Math.random()*3)
      .addScaledVector(ctrl.east,(Math.random()-.5)*5).addScaledVector(ctrl.north,(Math.random()-.5)*5);
    scene.add(m); fxParticles.push({m,v,life:1.4});
  }
}
function updateFX(dt){
  for(let i=fxParticles.length-1;i>=0;i--){
    const p=fxParticles[i]; p.life-=dt;
    p.v.addScaledVector(player.position.clone().sub(p.m.position).normalize(), GRAVITY*dt*0.5);
    p.m.position.addScaledVector(p.v,dt); p.m.rotation.x+=dt*8; p.m.rotation.y+=dt*6;
    p.m.material.opacity=Math.max(0,p.life); p.m.material.transparent=true;
    if(p.life<=0){ scene.remove(p.m); fxParticles.splice(i,1); }
  }
  // emoji billboards above head
  for(let i=emojiFX.length-1;i>=0;i--){
    const e=emojiFX[i]; e.life-=dt;
    e.sp.position.copy(player.position).addScaledVector(ctrl.up, 2.6 + (1.6-e.life)*0.8);
    e.sp.material.opacity=Math.min(1,e.life);
    if(e.life<=0){ scene.remove(e.sp); emojiFX.splice(i,1); }
  }
}
const flashEl=document.getElementById('flash');
function flash(emoji){ flashEl.textContent=emoji; flashEl.style.opacity=1; flashEl.style.transition='none';
  flashEl.style.transform='translate(-50%,-50%) scale(.6)';
  requestAnimationFrame(()=>{ flashEl.style.transition='all .8s'; flashEl.style.opacity=0; flashEl.style.transform='translate(-50%,-90%) scale(1.4)'; });
}

// ---------------------------------------------------------------------------
// Emoji ring UI
// ---------------------------------------------------------------------------
const EMOJIS=['💩','👋','❤️','😄','😮','👏','🎉','✉️','📦','🌍'];
const ring=document.getElementById('emojiRing');
const emojiFX=[];
let ringOpen=false;
EMOJIS.forEach((em,i)=>{
  const b=document.createElement('button'); b.className='eitem'; b.textContent=em;
  const ang=(-90 - i*(360/EMOJIS.length))*Math.PI/180, r=92;
  b.dataset.x=Math.cos(ang)*r; b.dataset.y=Math.sin(ang)*r;
  b.style.right='6px'; b.style.bottom='6px';
  b.onclick=(e)=>{ e.stopPropagation(); throwEmoji(em); toggleRing(false); };
  ring.appendChild(b);
});
function toggleRing(state){
  ringOpen = state===undefined ? !ringOpen : state;
  [...ring.children].forEach(b=>{
    if(ringOpen){ b.classList.add('show'); b.style.transform=`translate(${b.dataset.x}px,${b.dataset.y}px) scale(1)`; }
    else { b.classList.remove('show'); b.style.transform='scale(0)'; }
  });
}
document.getElementById('btnEmoji').onclick=()=>toggleRing();
function throwEmoji(em){
  const sp=makeMarker(em); sp.scale.set(1.4,1.4,1.4);
  scene.add(sp); emojiFX.push({sp, life:1.6}); pop('emoji');
}

// ---------------------------------------------------------------------------
// Outfit panel
// ---------------------------------------------------------------------------
const outfitEl=document.getElementById('outfit');
document.getElementById('btnOutfit').onclick=()=>outfitEl.classList.toggle('show');
document.querySelectorAll('#outfit .swatches').forEach(row=>{
  const slot=row.dataset.slot;
  PALETTE[slot].forEach((col,idx)=>{
    const s=document.createElement('div'); s.className='sw'+(outfit[slot]===idx?' active':'');
    s.style.background = (slot==='hat'&&idx===0)?'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)':'#'+col.toString(16).padStart(6,'0');
    s.onclick=()=>{ outfit[slot]=idx; row.querySelectorAll('.sw').forEach(x=>x.classList.remove('active')); s.classList.add('active'); rebuildPlayer(); };
    row.appendChild(s);
  });
});
function rebuildPlayer(){
  if (playerModel?.userData?.isFBX) return;
  player.remove(playerModel);
  playerModel = makeCourier(outfit);
  playerModel.visible = started;
  player.add(playerModel);
  stripInkShells(playerModel);
  refreshOutline();
  if(heldParcel){ (playerModel.userData.holdAnchor||playerModel).add(heldParcel); }
}

// ---------------------------------------------------------------------------
// Audio (Web Audio, simple synth — no asset files needed)
// ---------------------------------------------------------------------------
let actx=null;
function pop(type){
  if(!actx) return;
  const t=actx.currentTime, o=actx.createOscillator(), g=actx.createGain();
  o.connect(g); g.connect(actx.destination);
  if(type==='deliver'){ // 3-note jingle
    [523,659,784].forEach((f,i)=>{ const oo=actx.createOscillator(),gg=actx.createGain();
      oo.frequency.value=f; oo.type='triangle'; oo.connect(gg); gg.connect(actx.destination);
      gg.gain.setValueAtTime(0,t+i*0.12); gg.gain.linearRampToValueAtTime(.2,t+i*0.12+0.02); gg.gain.exponentialRampToValueAtTime(.001,t+i*0.12+0.25);
      oo.start(t+i*0.12); oo.stop(t+i*0.12+0.26); });
    return;
  }
  o.type='sine'; o.frequency.value= type==='pickup'?660:520;
  g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(.18,t+0.01); g.gain.exponentialRampToValueAtTime(.001,t+0.18);
  o.start(t); o.stop(t+0.2);
}
function startAmbientMusic(){
  if(!actx) return;
  const notes=[261.6,329.6,392,261.6,349.2,440,329.6,392];
  let i=0;
  setInterval(()=>{
    if(actx.state!=='running') return;
    const t=actx.currentTime, o=actx.createOscillator(), g=actx.createGain();
    o.type='sine'; o.frequency.value=notes[i++%notes.length];
    o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.05,t+0.3); g.gain.exponentialRampToValueAtTime(.001,t+1.6);
    o.start(t); o.stop(t+1.7);
  }, 700);
}

// ---------------------------------------------------------------------------
// UFO easter egg
// ---------------------------------------------------------------------------
const ufo=new THREE.Group();
const saucer=new THREE.Mesh(new THREE.SphereGeometry(1.2,16,8), toon(0xb0b8c0)); saucer.scale.y=0.35;
const dome=new THREE.Mesh(new THREE.SphereGeometry(0.6,16,8,0,Math.PI*2,0,Math.PI/2), new THREE.MeshToonMaterial({color:0x8fd0ff,gradientMap:grad,fog:true,transparent:true,opacity:.8}));
dome.position.y=0.25; ufo.add(saucer,dome); ufo.visible=false; scene.add(ufo);
let ufoT=120; // appear after 2 min, then periodically

// ---------------------------------------------------------------------------
// Weather system — clear / cloudy / rain / sunset, smoothly cross-faded
// ---------------------------------------------------------------------------
const WEATHER=[
  { name:'Clear', icon:'☀️', sun:3, amb:0.7 },
  { name:'Soft',  icon:'⛅', sun:2.6, amb:0.65 },
  { name:'Bright',icon:'🌤️', sun:3.2, amb:0.75 },
];
const wState = { sun:3, amb:0.7, idx:0 };
const hemi = scene.children.find(o=>o.isHemisphereLight);
function setWeather(i){ wState.idx=i; const w=WEATHER[i];
  const wi=document.getElementById('wIcon'), wn=document.getElementById('wName');
  if(wi) wi.textContent=w.icon; if(wn) wn.textContent=w.name; }
function updateWeather(dt, t){
  const i = Math.floor(t/40) % WEATHER.length;
  if(i!==wState.idx) setWeather(i);
  const w=WEATHER[i], k=Math.min(1, dt*0.6);
  wState.sun += (w.sun-wState.sun)*k; wState.amb += (w.amb-wState.amb)*k;
  sun.intensity = wState.sun; if(hemi) hemi.intensity = wState.amb;
}

// =====================================================================
// followCamera tick — abeto spherical orbit (js/followCamera.js)
// =====================================================================

function updateFollowCamera(dt) {
  const ratio = dt * 60;
  followCam.setPointerParallax(0, mNY, ratio);
  followCam.update({
    player,
    rotationHorizontal: ctrl.rotationHorizontal,
    up: ctrl.up,
    quaternion: player.quaternion,
    isMoving: ctrl.moving,
    ratio,
    frame: tickId,
  });
}

// ---------------------------------------------------------------------------
// NPR post-processing: ambient occlusion + ink outlines on everything
// ---------------------------------------------------------------------------
// NPR post-processing — ink outline is the main GPU cost; throttle it.
let composer=null, inkOutline=null;
let waterDepthPass = null;
const USE_POST = true;
const INK_EVERY_N = 1;
const WATER_DEPTH_EVERY_N = 5;
function setupPost(){
  if (!USE_POST) return;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // Full-screen ink outlines on the whole world (depth + normal edge detect).
    inkOutline = createInkOutline(renderer, scene, camera, {
      color: 0x181410,
      thickness: 0.78,
      strength: 0.62,
      depthSens: 0.028,
      normalSens: 0.84,
      normalScale: 0.52,
      getAssembly: () => (abetoPlanet ? {
        on: abetoPlanet.materializationWave?.active,
        playerPos: player.position,
        inner: abetoPlanet.buildInner,
        outer: abetoPlanet.buildOuter,
      } : null),
    });
    inkOutline.resize(innerWidth, innerHeight);
    composer.addPass(inkOutline.pass);
    composer.addPass(new OutputPass());
  } catch (e) {
    console.warn('post-processing unavailable, falling back', e);
    composer = null;
  }
}
// Outline selection is handled by the full-screen ink pass now — no-op kept for callers.
function refreshOutline(){}
setupPost();
window.__refreshOutline = refreshOutline;
setTimeout(refreshOutline, 2500);
setTimeout(refreshOutline, 6000);

let started=false;
const clock=new THREE.Clock();
let tickId = 0;
let _weatherTick = 0;

// ---------------------------------------------------------------------------
// Loading screen — per-session progress, then PLAY NOW
// ---------------------------------------------------------------------------
const barFill = document.getElementById('startProgress');
const beginBtn = document.getElementById('begin');
const loadStatus = document.getElementById('loadStatus');
let prog = 0;
let planetReady = false;

function setLoadProgress(pct) {
  prog = Math.max(prog, Math.min(100, pct));
  if (barFill) barFill.style.width = `${Math.round(prog)}%`;
}

function setLoadStatus(msg) {
  if (loadStatus) loadStatus.textContent = msg || 'Loading world...';
}

function revealPlayNow() {
  planetReady = true;
  setLoadProgress(100);
  clearInterval(loadTick);
  clearTimeout(loadTimeout);
  if (loadStatus) loadStatus.textContent = '';
  beginBtn?.classList.add('show');
}

setLoadStatus('Loading world...');

const loadTick = setInterval(() => {
  if (planetReady) return;
  setLoadProgress(Math.min(88, prog + 2 + Math.random() * 4));
}, 140);

const loadTimeout = setTimeout(() => {
  if (planetReady) return;
  console.warn('Load timeout — forcing PLAY NOW');
  revealPlayNow();
}, 30000);

(async () => {
  const t0 = performance.now();
  try {
    setLoadStatus('Loading world...');
    abetoPlanet = await loadAbetoPlanet(scene, camera, (p, label) => {
      setLoadProgress(6 + p * 62);
      if (label) console.log('planet load:', label, Math.round(p * 100) + '%');
    });
    setLoadProgress(72);
    abetoPlanet.refreshInk?.();
    stripInkShells(playerModel);
    refreshOutline();
    if (abetoPlanet.water) {
      waterDepthPass = createWaterDepthPass(renderer);
      waterDepthPass.resize(innerWidth, innerHeight);
      abetoPlanet.water.renderOrder = 2;
      abetoPlanet.water.receiveShadow = false;
      syncWaterSceneUniforms(abetoPlanet.waterMat, camera, waterDepthPass);
      const dpr = renderer.getPixelRatio();
      abetoPlanet.waterMat.uniforms.resolution.value.set(
        Math.floor(innerWidth * dpr),
        Math.floor(innerHeight * dpr),
      );
    }
    walkable = abetoPlanet.walkable;
    worldRadius = abetoPlanet.radius;
    surfaceInfo = (dir) => abetoPlanet.surfaceInfo(dir);
    syncWorldAtmosphere({
      fogUniforms: abetoPlanet.fogUniforms,
      skyUniforms: getSkyUniforms(),
      terrainMat: abetoPlanet.terrainMat,
      waterMat: abetoPlanet.waterMat,
      worldUp: ctrl.up,
      sceneFog: scene.fog,
    });

    walkable = abetoPlanet.walkable;
    placePlayerSpawn();
    followCam.initFromHeading(ctrl.rotationHorizontal);
    setLoadProgress(82);

    await initCharacterPhysics();
    setLoadProgress(96);

    revealPlayNow();
    console.log('World ready in', ((performance.now() - t0) / 1000).toFixed(1), 's, radius ≈', worldRadius.toFixed(2));
    window.__planetRadius = worldRadius;
    window.__abetoPlanet = abetoPlanet;
    abetoPlanet.loadDeferredLODs?.().then(() => {
      abetoPlanet.refreshInk?.();
      stripInkShells(playerModel);
      refreshOutline();
    }).catch((e) => console.warn('Deferred LODs', e));
  } catch (e) {
    console.error('Planet load failed', e);
    revealPlayNow();
  }
})();
let physicsInitPromise = null;
async function initCharacterPhysics() {
  if (charPhysics?.bvhGeo?.boundsTree) return;
  if (!abetoPlanet?.colliderSourceGeo) return;
  if (physicsInitPromise) return physicsInitPromise;

  physicsInitPromise = (async () => {
  const t0 = performance.now();
  charPhysics = new CharacterPhysics({
    substeps: PHYS.substeps,
    positionForce: PHYS.positionForce,
    jumpForce: PHYS.jumpForce,
    gravity: PHYS.gravity,
    damp: PHYS.damp,
    dampIdle: PHYS.dampIdle,
    sprintMultiplier: PHYS.sprint,
    maxRunSpeed: RUN,
    floorDetectInclination: 0.7,
    capsuleRadius: CHAR_HEIGHT * 0.2,
    capsuleHeight: CHAR_HEIGHT * 0.6,
  });
  await charPhysics.init(abetoPlanet.colliderSourceGeo);
  walkable = [charPhysics.collider];
  surfaceInfo = (dir) => {
    const d = dir.clone().normalize();
    ray.set(d.clone().multiplyScalar(worldRadius + 50), d.negate());
    const hit = ray.intersectObject(charPhysics.collider, false)[0];
    if (!hit) return null;
    const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    return { point: hit.point.clone(), normal: hit.face.normal.clone().applyMatrix3(nm).normalize() };
  };
  followCam.setBVHCollider({
    collider: charPhysics.collider,
    bvhGeo: charPhysics.bvhGeo,
    sourceGeo: charPhysics.sourceGeo,
  });
  window.__charPhysics = charPhysics;
  placePlayerSpawn();
  console.log('BVH ready in', ((performance.now() - t0) / 1000).toFixed(1), 's');
  })();

  return physicsInitPromise;
}
beginBtn.onclick = async () => {
  try {
    beginBtn.disabled = true;
    await initCharacterPhysics();
    abetoPlanet?.setBuildRadius(ASSEMBLY_INNER, ASSEMBLY_OUTER);
    placePlayerSpawn();
    followCam.initFromHeading(ctrl.rotationHorizontal);

    document.body.classList.add('playing');
    try{ actx=new (window.AudioContext||window.webkitAudioContext)(); startAmbientMusic(); }catch(e){}
    const l=document.getElementById('loader'); l.style.opacity=0; setTimeout(()=>l.style.display='none',600);
    player.visible = true;
    if (playerModel) {
      playerModel.visible = true;
      stripInkShells(playerModel);
      refreshOutline();
    }
    started=true; clock.start();
    // Animus build-from-blocks: world materializes outward from spawn.
    abetoPlanet?.startAssembly?.(player.position);
  } catch (e) {
    console.error('Physics init failed', e);
    beginBtn.disabled = false;
  }
};
// Debug: toggle the Animus reality-bubble materialization.
window.__assemblyOn = () => { abetoPlanet?.startAssembly?.(player.position); return 'assembly on'; };
window.__assemblyOff = () => { abetoPlanet?.stopAssembly?.(); return 'assembly off'; };
window.__rebuildWorld = window.__assemblyOn;

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function tick(){
  requestAnimationFrame(tick);
  // Menu is CSS-only — skip the entire 3D pipeline until START.
  if (!started) return;

  tickId++;
  const dt=Math.min(clock.getDelta(),0.05);
  const ratio = dt * 60;
  const elapsed = clock.getElapsedTime();

  if ((_weatherTick++ & 3) === 0) updateWeather(dt, elapsed);
  const dayA=elapsed*0.01;
  sun.position.set(Math.cos(dayA)*60, 50, Math.sin(dayA)*60);

  if (abetoPlanet) {
    abetoPlanet.update(elapsed, player.position, camera, tickId, sun);
  }

  if(started && !dialog.active){
    // ---- input (WASD / arrows / mobile stick / Shift sprint / Space jump) ----
    let ix=0, iz=0;
    if(keys['KeyW']||keys['ArrowUp']) iz+=1;
    if(keys['KeyS']||keys['ArrowDown']) iz-=1;
    if(keys['KeyA']||keys['ArrowLeft']) ix-=1;
    if(keys['KeyD']||keys['ArrowRight']) ix+=1;
    if(isMobile){ ix+=stickVec.x; iz-=stickVec.y; }
    const running = keys['ShiftLeft']||keys['ShiftRight'];
    ctrl.running = running;
    const jumpPressed = !!keys['Space'] && !jumpKeyDown;
    if (jumpPressed) jumpKeyDown = true;
    const hasInput = Math.hypot(ix,iz) > 0.01;

    physicsUpdate(ix, iz, running, jumpPressed, ratio);
    updateAnim(dt, hasInput, running);
    updateFX(dt);
  } else if (started) {
    updateAnim(dt, false, false);
    ctrl.running = false;
  }

  skyDome?.update(elapsed, {
    position: player.position,
    running: started && ctrl.running,
  }, dt);
  if ((tickId & 3) === 0 && abetoPlanet) {
    syncWorldAtmosphere({
      fogUniforms: abetoPlanet.fogUniforms,
      skyUniforms: getSkyUniforms(),
      terrainMat: abetoPlanet.terrainMat,
      waterMat: abetoPlanet.waterMat,
      worldUp: ctrl.up,
      sceneFog: scene.fog,
    });
  }

  updateFollowCamera(dt);
  updateCharacterLights();

  if (abetoPlanet?.water && waterDepthPass && (tickId % WATER_DEPTH_EVERY_N) === 0) {
    waterDepthPass.render(scene, camera, abetoPlanet.water);
    syncWaterSceneUniforms(abetoPlanet.waterMat, camera, waterDepthPass);
  }

  // broadcast our transform + animation state and interpolate remote couriers
  if (ENABLE_MULTIPLAYER) {
    mp.update(dt, { pos: player.position, quat: player.quaternion, anim: curState });
  }
  if (composer) {
    if ((tickId % INK_EVERY_N) === 0) inkOutline?.render(tickId);
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}
tick();

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
addEventListener('resize', ()=>{
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  skyDome?.onResize(innerWidth, innerHeight);
  waterDepthPass?.resize(innerWidth, innerHeight);
  if (abetoPlanet?.waterMat?.uniforms?.resolution) {
    const dpr = renderer.getPixelRatio();
    abetoPlanet.waterMat.uniforms.resolution.value.set(
      Math.floor(innerWidth * dpr),
      Math.floor(innerHeight * dpr),
    );
  }
  if(composer){ composer.setSize(innerWidth,innerHeight); inkOutline?.resize(innerWidth,innerHeight); }
});

function showWin(){ const w=document.getElementById('win'); w.style.display='flex'; requestAnimationFrame(()=>w.style.opacity=1); }
