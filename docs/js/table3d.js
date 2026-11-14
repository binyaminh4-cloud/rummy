// The 3D table: room, table/chairs/lamp from Blender, cards, piles and card animations.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js?v=170';
import { RoomEnvironment } from '../vendor/addons/environments/RoomEnvironment.js?v=170';
import { faceCanvas, backCanvas } from './cards.js?v=1';

const TOP = 0.766;                    // felt height (metres)
const CW = 0.052, CH = 0.07, CT = 0.014;      // tile: width, height (lying: depth), thickness
const DECK = new THREE.Vector3(-0.16, TOP, -0.03);
const PILE = new THREE.Vector3(0.14, TOP, -0.03);
const SEAT_ANGLES = { 2: [0, 180], 3: [0, 120, 240], 4: [0, 90, 180, 270] };

export async function createTable(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  container.style.background = '#0b1511 url(assets/img/bg_room.webp) center/cover no-repeat';

  // draw only when something changed (saves battery on phones)
  let running = true, scheduled = false;
  function invalidate() { if (!scheduled && running) { scheduled = true; requestAnimationFrame(frame); } }

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
  const look = new THREE.Vector3(0, 0.6, 0.12);

  scene.add(new THREE.HemisphereLight(0xffe7c4, 0x1a120a, 0.45));
  const spot = new THREE.SpotLight(0xffe2b0, 22, 6, Math.PI / 3.2, 0.55, 1.6);
  spot.position.set(0, 2.15, 0.05); spot.target.position.set(0, TOP, 0);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004; spot.shadow.radius = 4;
  scene.add(spot, spot.target);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.35); fill.position.set(-2, 3, 3); scene.add(fill);

  // ---------- textures ----------
  const tl = new THREE.TextureLoader();
  const loadTex = (src, rep) => new Promise((res) => tl.load(src, (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy(); res(t);
  }, undefined, () => res(null)));
  const [feltTex, woodTex] = await Promise.all([loadTex('assets/img/felt.webp', 3), loadTex('assets/img/wood.webp', 2)]);

  const mats = {
    Felt: new THREE.MeshStandardMaterial({ map: feltTex, color: 0xffffff, roughness: 0.95 }),
    Wood: new THREE.MeshStandardMaterial({ map: woodTex, color: 0xd9b59a, roughness: 0.35, metalness: 0.05 }),
    DarkWood: new THREE.MeshStandardMaterial({ map: woodTex, color: 0x6b4a36, roughness: 0.45 }),
    Leather: new THREE.MeshStandardMaterial({ color: 0x2a0f08, roughness: 0.5, metalness: 0.0 }),
    Brass: new THREE.MeshStandardMaterial({ color: 0xd8a64a, roughness: 0.28, metalness: 1.0 }),
    Beech: new THREE.MeshStandardMaterial({ map: woodTex, color: 0xf3cf9c, roughness: 0.5 }),
  };

  // planar / box UVs because the Blender meshes have none
  function boxUV(geo, scale) {
    const p = geo.attributes.position, n = geo.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n ? n.getX(i) : 0), ay = Math.abs(n ? n.getY(i) : 1), az = Math.abs(n ? n.getZ(i) : 0);
      let u, v;
      if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  const loader = new GLTFLoader();
  const load = (src) => new Promise((res) => loader.load(src, (g) => res(g.scene), undefined, () => res(null)));
  const [table, chair, lamp, rackModel] = await Promise.all([
    load('assets/models/table.glb?v=1'), load('assets/models/chair.glb?v=1'), load('assets/models/lamp.glb?v=1'),
    load('assets/models/rack.glb?v=1')]);

  function dress(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      const name = (o.material && o.material.name) || '';
      boxUV(o.geometry, name === 'Felt' ? 0.45 : 1.2);
      if (mats[name]) o.material = mats[name];
      else if (name === 'LampGlow') o.material = new THREE.MeshBasicMaterial({ color: 0xfff1cf });
      o.castShadow = name !== 'Felt'; o.receiveShadow = true;
    });
    return root;
  }
  if (table) scene.add(dress(table));
  else { // fallback if the model did not load
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.04, 64), mats.Felt);
    top.scale.set(1.2, 1, 0.72); top.position.y = TOP - 0.02; top.receiveShadow = true; scene.add(top);
  }
  if (lamp) { dress(lamp); lamp.position.y = 0.32; scene.add(lamp); }
  const chairs = [];

  // ---------- cards ----------
  const geo = new THREE.BoxGeometry(CW, CT, CH);
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe9dcbc, roughness: 0.35 });
  const backTex = new THREE.CanvasTexture(backCanvas()); backTex.colorSpace = THREE.SRGBColorSpace;
  backTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.35 });
  const faceMats = {};
  function faceMat(c) {
    const k = c >= 104 ? 'J' + (c % 2) : c % 52;
    if (!faceMats[k]) {
      const t = new THREE.CanvasTexture(faceCanvas(c)); t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      faceMats[k] = new THREE.MeshStandardMaterial({ map: t, roughness: 0.35 });
    }
    return faceMats[k];
  }
  // box faces order: +x, -x, +y(top), -y(bottom), +z, -z. Face up = card face on +y.
  function makeCard(c) {
    const top = c == null ? backMat : faceMat(c);
    const m = new THREE.Mesh(geo, [edgeMat, edgeMat, top, backMat, edgeMat, edgeMat]);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  function setFace(m, c) { m.material[2] = c == null ? backMat : faceMat(c); }

  // deck stack
  const deckGroup = new THREE.Group(); scene.add(deckGroup);
  // the pool ("קופה"): face-down tiles in neat little stacks; fewer stacks as it empties
  const rnd = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  function drawDeck(count) {
    deckGroup.clear();
    const tiles = Math.min(Math.ceil(count / 3), 24);
    for (let i = 0; i < tiles; i++) {
      const col = i % 4, row = Math.floor(i / 4) % 3, layer = Math.floor(i / 12);
      const m = makeCard(null);
      m.position.set(DECK.x + (col - 1.5) * (CW + 0.004) + (rnd(i) - 0.5) * 0.004,
        TOP + CT / 2 + layer * CT, DECK.z + (row - 1) * (CH + 0.004) + (rnd(i + 50) - 0.5) * 0.004);
      m.rotation.y = (rnd(i + 99) - 0.5) * 0.08;
      deckGroup.add(m);
    }
  }
  // discard pile: top card face up plus a few under it
  const pileGroup = new THREE.Group(); scene.add(pileGroup);
  let pileSig = '';
  function drawPile(top, count) {
    const sig = top + ':' + count; if (sig === pileSig) return; pileSig = sig;
    pileGroup.clear();
    if (top == null || count === 0) return;
    const under = Math.min(count - 1, 3);
    for (let i = 0; i < under; i++) {
      const m = makeCard(null); m.position.set(PILE.x + (i - 1) * 0.012, TOP + CT / 2, PILE.z + 0.03 - i * 0.012);
      m.rotation.y = (i - 1) * 0.15; pileGroup.add(m);
    }
    const t = makeCard(top); t.position.set(PILE.x, TOP + CT / 2 + (under ? CT * 0.8 : 0), PILE.z); t.rotation.y = 0.05;
    pileGroup.add(t);
  }

  // seats
  let n = 2;
  const fans = [];           // per relative seat: group with card backs
  function seatAngle(rel) { return (SEAT_ANGLES[n] || SEAT_ANGLES[4])[rel] * Math.PI / 180; }
  function seatPoint(rel, rx, rz, y = TOP) {
    const t = seatAngle(rel);
    return new THREE.Vector3(-Math.sin(t) * rx, y, Math.cos(t) * rz);
  }
  function setPlayers(count) {
    n = count;
    chairs.forEach((c) => scene.remove(c)); chairs.length = 0;
    fans.forEach((f) => scene.remove(f)); fans.length = 0;
    for (let r = 0; r < n; r++) {
      if (r > 0 && chair) {
        const c = chair.clone(true); dress(c);
        const p = seatPoint(r, 1.62, 1.12, 0); c.position.copy(p); c.rotation.y = -seatAngle(r);
        scene.add(c); chairs.push(c);
      }
      // each opponent has a wooden rack at the table edge, front towards its owner
      const f = new THREE.Group(); f.position.copy(seatPoint(r, 0.9, 0.56)); f.rotation.y = -seatAngle(r);
      if (r > 0) {
        if (rackModel) { const rk = rackModel.clone(true); rk.traverse((o) => { if (o.isMesh) { boxUV(o.geometry, 3); o.material = mats.Beech; o.castShadow = o.receiveShadow = true; } }); f.add(rk); }
        const tiles = new THREE.Group(); f.add(tiles); f.userData.tiles = tiles;
      }
      scene.add(f); fans.push(f);
    }
  }
  function drawFan(rel, count) {
    const f = fans[rel]; if (!f || rel === 0) return;
    if (f.userData.count === count) return; f.userData.count = count;
    const g = f.userData.tiles; g.clear();
    const k = Math.min(count, 15), step = CW + 0.0015;
    for (let i = 0; i < k; i++) {
      const m = makeCard(null);
      // standing on the rack, leaning back, face towards the owner (we see the back)
      m.position.set((i - (k - 1) / 2) * step, 0.008 + CH / 2 * 0.97, -0.008);
      m.rotation.x = Math.PI / 2 - 0.26;
      g.add(m);
    }
  }

  // ---------- animation ----------
  const tweens = [];
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  function tween(obj, toPos, toRotY, dur, lift = 0.12) {
    return new Promise((res) => {
      const tw = { obj, from: obj.position.clone(), to: toPos.clone(), r0: obj.rotation.y, r1: toRotY, t0: performance.now(), dur, lift, res };
      tweens.push(tw); invalidate();
      // if the browser pauses drawing (tab in background), never let the game wait forever
      setTimeout(() => { const i = tweens.indexOf(tw); if (i >= 0) { tweens.splice(i, 1); obj.position.copy(tw.to); res(); invalidate(); } }, dur + 400);
    });
  }
  function handPoint() { return new THREE.Vector3(0, TOP + 0.25, 0.95); }
  function seatHand(rel) { return rel === 0 ? handPoint() : seatPoint(rel, 0.9, 0.56, TOP + 0.06); }

  async function flyDraw(rel, fromPile, cardId) {
    const src = fromPile ? PILE : DECK;
    const m = makeCard(fromPile ? cardId : null);
    m.position.set(src.x, TOP + 0.03, src.z); scene.add(m);
    await tween(m, seatHand(rel), rel === 0 ? 0 : -seatAngle(rel), 520);
    scene.remove(m); invalidate();
  }
  async function flyDiscard(rel, cardId) {
    const m = makeCard(cardId);
    m.position.copy(seatHand(rel)); m.rotation.y = rel === 0 ? 0 : -seatAngle(rel); scene.add(m);
    await tween(m, new THREE.Vector3(PILE.x, TOP + 0.02, PILE.z), 0.05, 520);
    scene.remove(m); invalidate();
  }
  async function dealAnim(count) {
    const jobs = [];
    for (let i = 0; i < Math.min(count * 3, 12); i++) {
      const rel = i % count;
      const m = makeCard(null); m.position.set(DECK.x, TOP + 0.03, DECK.z); scene.add(m);
      jobs.push(new Promise((r) => setTimeout(r, i * 70)).then(() => tween(m, seatHand(rel), rel === 0 ? 0 : -seatAngle(rel), 420)).then(() => { scene.remove(m); invalidate(); }));
    }
    await Promise.all(jobs);
  }

  // ---------- layout + loop ----------
  function resize() {
    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    const aspect = w / h; camera.aspect = aspect;
    // keep the whole table in view on narrow and wide screens
    // the table area is a wide strip above the rack: look down more steeply and fit the table width
    const wide = Math.min(1, Math.max(0, (aspect - 1.6) / 2.4));          // 0 = normal screen, 1 = very wide strip
    camera.position.set(0, 2.05 + wide * 0.7, 1.72 - wide * 0.45);
    const hfov = 84;                                                       // keep the whole table across the width
    camera.fov = Math.min(70, Math.max(24, 2 * Math.atan(Math.tan(hfov * Math.PI / 360) / aspect) * 180 / Math.PI));
    look.set(0, 0.6 + wide * 0.16, 0.12 - wide * 0.1);
    camera.lookAt(look);
    camera.updateProjectionMatrix();
    invalidate();
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  function frame(now) {
    scheduled = false;
    if (!running) return;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i]; const x = Math.min(1, (now - tw.t0) / tw.dur), e = ease(x);
      tw.obj.position.lerpVectors(tw.from, tw.to, e); tw.obj.position.y += Math.sin(Math.PI * x) * tw.lift;
      tw.obj.rotation.y = tw.r0 + (tw.r1 - tw.r0) * e;
      if (x >= 1) { tweens.splice(i, 1); tw.res(); }
    }
    renderer.render(scene, camera);
    if (tweens.length) invalidate();
  }
  invalidate();

  function toScreen(v) {
    const p = v.clone().project(camera);
    return { x: (p.x + 1) / 2 * container.clientWidth, y: (1 - p.y) / 2 * container.clientHeight };
  }

  const withDraw = (fn) => (...a) => { const r = fn(...a); invalidate(); return r; };
  return {
    setPlayers: withDraw(setPlayers),
    drawDeck: withDraw(drawDeck), drawPile: withDraw(drawPile), drawFan: withDraw(drawFan),
    flyDraw, flyDiscard, dealAnim,
    deckScreen: () => toScreen(DECK), pileScreen: () => toScreen(PILE),
    seatScreen: (rel) => toScreen(rel === 0 ? new THREE.Vector3(0, TOP, 0.62) : seatPoint(rel, 1.3, 0.9, TOP + 0.14)),
    resize,
    dispose() { running = false; ro.disconnect(); renderer.dispose(); container.innerHTML = ''; },
  };
}
