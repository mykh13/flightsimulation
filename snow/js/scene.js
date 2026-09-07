import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK } from './game.js';

/* ══════════════════════════════════════════════════════════════════
   Snow Run — 3D scene.

   A near-monochrome whiteout: everything is a shade of snow, and depth
   comes almost entirely from how steep a facet is rather than from
   colour. Steep ground catches less light and reads blue-grey; flat
   ground stays white. Heavy fog does the rest.

   The run itself is deliberately smooth — all the faceting is in the
   mountains and the trees, which is what the reference does too.
   ══════════════════════════════════════════════════════════════════ */

export const LOOK = {
  grade: 0.12,          // downhill gradient of the run
  fogNear: 70,
  fogFar: 620,
  sky: '#bcd7e6',
  skyLow: '#e4eff5',
  fog: '#dbe8f1',
  snowLit: '#f8fbfd',
  snowMid: '#e2edf5',
  snowShade: '#c6d8e6',
  iceFace: '#a2bad0',
  iceDeep: '#8199b2',
  pine: '#6e847a',
  pineDark: '#59706a',
  trunk: '#4a4038',
  jacket: '#23272e',
  trouser: '#3c4450',
  helmet: '#1a1d22',
  goggles: '#93aec4',
  glove: '#4a5361',
  board: '#eef4f9',
  boardBase: '#63768a'
};

/* The lateral profile of the valley: flat run, then walls rising away
   on both sides. It is a function of x only, and the downhill grade is
   a function of z only — which means the ground mesh is invariant under
   travel and can simply be translated instead of rebuilt. */
export function edgeProfile(x) {
  const d = Math.max(0, Math.abs(x) - TRACK.half);
  // Rise to the valley shoulder over ~44 m, then keep climbing very
  // gently so the sides blend into the mountains. Without the cap this
  // is a power law across a 420 m mesh — i.e. canyon walls thousands of
  // units high, wrapped around the camera.
  const t = Math.min(1, d / 66);
  return Math.pow(t, 2.0) * 52 + Math.max(0, d - 66) * 0.40;
}
export const groundY = (x, worldZ) => worldZ * LOOK.grade + edgeProfile(x);

const rngFrom = seed => {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
};

/* ── shared helpers ───────────────────────────────────────────────── */
function prep(source, matrix, colour) {
  const g = source.index ? source.toNonIndexed() : source.clone();
  if (matrix) g.applyMatrix4(matrix);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i*3] = colour.r; arr[i*3+1] = colour.g; arr[i*3+2] = colour.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Colour by height within the geometry, with a hard snowline — assigned
 * per FACE, not per vertex.
 *
 * Per-vertex is the trap here: a cone's side triangle has two dark base
 * vertices and one white apex, so the colour interpolates across the whole
 * face and every tier ends up half-dark. A snow-laden pine then reads as
 * an ordinary green one. Painting whole faces keeps the snow crisp.
 */
function prepSnowline(source, matrix, under, over, line) {
  const g = source.index ? source.toNonIndexed() : source.clone();
  if (matrix) g.applyMatrix4(matrix);
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y<lo) lo=y; if (y>hi) hi=y; }
  const span = Math.max(1e-4, hi - lo);
  const arr = new Float32Array(pos.count * 3);
  for (let t = 0; t < pos.count; t += 3) {
    const cy = (pos.getY(t) + pos.getY(t+1) + pos.getY(t+2)) / 3;
    const c = ((cy - lo) / span) < line ? under : over;
    for (let j = 0; j < 3; j++) {
      const o = (t + j) * 3;
      arr[o] = c.r; arr[o+1] = c.g; arr[o+2] = c.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const M = () => new THREE.Matrix4();
const trs = (x, y, z, sx=1, sy=1, sz=1, ry=0) => M().compose(
  new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
  new THREE.Vector3(sx, sy, sz));

const flatVC = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

/* ── mountains ────────────────────────────────────────────────────── */
/**
 * A range built from ridged noise. `1 - |sin·cos|` gives sharp crest
 * lines instead of rolling hills, and flat shading turns the result into
 * the faceted cliff walls the reference is made of.
 */
function makeRange(rng, width, depth, height, segX, segZ) {
  const geo = new THREE.PlaneGeometry(width, depth, segX, segZ).toNonIndexed();
  geo.rotateX(-Math.PI / 2);
  geo.deleteAttribute('uv');
  const pos = geo.attributes.position;
  const s = [rng()*100, rng()*100, rng()*100, rng()*100];

  const ridged = (x, z, f, k) => 1 - Math.abs(Math.sin(x*f + s[k]) * Math.cos(z*f*0.75 + s[k]*1.7));

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let h = ridged(x, z, 0.0034, 0) * 1.0
          + ridged(x, z, 0.0079, 1) * 0.46
          + ridged(x, z, 0.0181, 2) * 0.21
          + ridged(x, z, 0.0402, 3) * 0.08;
    h = Math.pow(h / 1.75, 1.7) * height;
    // sink the near edge so the range meets the valley floor instead of
    // ending in a cliff wall facing the player
    const front = THREE.MathUtils.smoothstep(z, -depth * 0.5, -depth * 0.5 + depth * 0.34);
    pos.setY(i, h * front - 30);
  }
  geo.computeVertexNormals();
  paintSnow(geo, rng, height);
  return geo;
}

/**
 * Slope-driven snow shading. On a white mountain, steepness is the only
 * thing that reads — flat ground holds snow and stays bright, steep faces
 * shed it and fall to blue-grey rock.
 */
function paintSnow(geo, rng, height) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const colours = new Float32Array(pos.count * 3);
  const c = new THREE.Color(), n = new THREE.Vector3();
  const lit = new THREE.Color(LOOK.snowLit), mid = new THREE.Color(LOOK.snowMid);
  const shade = new THREE.Color(LOOK.snowShade);
  const ice = new THREE.Color(LOOK.iceFace), deep = new THREE.Color(LOOK.iceDeep);
  const ss = THREE.MathUtils.smoothstep;

  for (let t = 0; t < pos.count; t += 3) {
    n.fromBufferAttribute(nrm, t);
    const cy = (pos.getY(t) + pos.getY(t+1) + pos.getY(t+2)) / 3;
    const steep = 1 - Math.max(0, n.y);
    const alt = THREE.MathUtils.clamp(cy / Math.max(1, height), 0, 1);

    c.copy(mid).lerp(lit, ss(alt, 0.15, 0.85));          // brighter up high
    c.lerp(shade, ss(steep, 0.16, 0.46) * 0.75);          // gentle slopes greying off
    c.lerp(ice, ss(steep, 0.42, 0.72) * 0.9);             // exposed faces
    c.lerp(deep, ss(steep, 0.72, 0.94) * 0.85);           // sheer walls
    // faces turned away from the light sit a touch cooler
    c.offsetHSL(0, (rng() - 0.5) * 0.02, (rng() - 0.5) * 0.022);

    for (let j = 0; j < 3; j++) {
      const o = (t + j) * 3;
      colours[o] = c.r; colours[o+1] = c.g; colours[o+2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geo;
}

/* ── snow-laden pines ─────────────────────────────────────────────── */
const tierGeo  = new THREE.ConeGeometry(1, 1, 7);
const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 5);

function pushPine(out, rng, x, y, z, h) {
  const w = h * 0.34;
  out.push(prep(trunkGeo, trs(x, y + h * 0.14, z, 1, h * 0.28, 1), new THREE.Color(LOOK.trunk)));
  // Tiers are painted white above their own snowline and dark below, so
  // each skirt reads as a branch carrying snow rather than a plain cone.
  const under = new THREE.Color(rng() < 0.5 ? LOOK.pine : LOOK.pineDark);
  const over  = new THREE.Color(LOOK.snowLit);
  let cy = y + h * 0.18;
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    const tw = w * (1 - t * 0.55), th = h * (0.42 - t * 0.055);
    out.push(prepSnowline(tierGeo, trs(x, cy + th / 2, z, tw, th, tw, rng() * 3),
                          under, over, 0.20 + rng() * 0.08));
    cy += th * 0.52;
  }
}

/* ── boulders ─────────────────────────────────────────────────────── */
const rockGeo = new THREE.DodecahedronGeometry(1, 0);
function makeRock(rng, r) {
  const geos = [
    prepSnowline(rockGeo, trs(0, r * 0.35, 0, r, r * 0.8, r * 0.92, rng() * 3),
                 new THREE.Color(LOOK.iceDeep), new THREE.Color(LOOK.snowLit), 0.52)
  ];
  if (rng() < 0.6) {
    const rr = r * (0.4 + rng() * 0.35);
    geos.push(prepSnowline(rockGeo, trs(r * 0.7, rr * 0.3, r * 0.2, rr, rr * 0.8, rr, rng() * 3),
                           new THREE.Color(LOOK.iceDeep), new THREE.Color(LOOK.snowLit), 0.52));
  }
  return mergeGeometries(geos, false);
}

/* ── the rider ────────────────────────────────────────────────────── */
/**
 * A snowboarder stands ACROSS the board, but not entirely: the feet stay
 * roughly along the deck at a binding angle, and it is the hips, torso and
 * head that twist to face down the hill. Rotating the *whole* body — the
 * obvious shortcut — swings the boots right off the board's line and the
 * figure reads as a squat lump rather than a rider.
 *
 * Kept deliberately slim. At normal chase distance this is only ~40 px
 * tall, so the silhouette is the whole job; bulk just turns into a blob.
 */
function buildRider() {
  const root = new THREE.Group();
  const mat = c => new THREE.MeshLambertMaterial({ color: new THREE.Color(c), flatShading: true });
  const jacket = mat(LOOK.jacket), trouser = mat(LOOK.trouser);
  const helmet = mat(LOOK.helmet), goggles = mat(LOOK.goggles);
  const glove = mat(LOOK.glove), board = mat(LOOK.board), base = mat(LOOK.boardBase);
  const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

  // ── board, running down the fall line ──
  const deck = box(0.34, 0.045, 1.46, board);
  deck.position.y = 0.075;
  const rail = box(0.35, 0.028, 1.46, base);
  rail.position.y = 0.046;
  root.add(deck, rail);
  for (const end of [-1, 1]) {
    const tip = box(0.30, 0.045, 0.30, board);
    tip.position.set(0, 0.105, end * 0.85);
    tip.rotation.x = end * 0.40;                    // rocker at nose and tail
    root.add(tip);
  }

  // ── feet stay on the deck, only turned to the binding angle ──
  for (const [z, ang] of [[0.28, 0.34], [-0.28, 0.30]]) {
    const boot = box(0.155, 0.11, 0.25, helmet);
    boot.position.set(0, 0.155, z);
    boot.rotation.y = ang;
    root.add(boot);
    const shin = box(0.115, 0.30, 0.135, trouser);
    shin.position.set(z > 0 ? -0.03 : 0.03, 0.36, z * 0.86);
    shin.rotation.x = z > 0 ? -0.16 : 0.16;
    const thigh = box(0.13, 0.27, 0.15, trouser);
    thigh.position.set(z > 0 ? -0.05 : 0.05, 0.62, z * 0.52);
    thigh.rotation.x = z > 0 ? 0.34 : -0.34;
    root.add(shin, thigh);
  }

  // ── everything above the hips twists to face down the hill ──
  const upper = new THREE.Group();
  upper.rotation.y = -0.85;
  upper.position.y = 0.70;
  root.add(upper);

  const hips = box(0.36, 0.18, 0.24, trouser);
  upper.add(hips);

  const torso = box(0.38, 0.44, 0.25, jacket);
  torso.position.set(0, 0.32, 0.04);
  torso.rotation.x = -0.42;                          // folded low over the board
  const shoulders = box(0.42, 0.14, 0.24, jacket);
  shoulders.position.set(0, 0.55, 0.01);
  shoulders.rotation.x = -0.42;
  upper.add(torso, shoulders);

  // leading arm reaches down the hill, trailing arm counterbalances
  for (const [side, rz, rx] of [[-1, -0.95, 0.40], [1, 0.72, -0.30]]) {
    const arm = box(0.10, 0.36, 0.115, jacket);
    arm.position.set(side * 0.26, 0.42, 0.06);
    arm.rotation.set(rx, 0, rz);
    const hand = box(0.10, 0.10, 0.10, glove);
    hand.position.set(side * 0.50, 0.24, 0.12 + rx * 0.26);
    upper.add(arm, hand);
  }

  // head: the goggle band is what makes it read as a head at 40 px
  const head = box(0.21, 0.22, 0.22, helmet);
  head.position.set(0, 0.74, 0.02);
  head.rotation.x = -0.16;
  const lid = new THREE.Mesh(new THREE.SphereGeometry(0.135, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), helmet);
  lid.position.set(0, 0.83, 0.02);
  const band = box(0.225, 0.062, 0.235, goggles);
  band.position.set(0, 0.755, 0.025);
  band.rotation.x = -0.16;
  upper.add(head, lid, band);

  return root;
}

/** Round sprite for snow particles — untextured Points render as squares. */
function flakeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d');
  const grd = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grd; x.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Soft blob shadow — cheaper and softer than a shadow map, and this
    scene has no hard light to justify one anyway. */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(96,124,150,.72)');
  grd.addColorStop(0.55, 'rgba(118,146,172,.40)');
  grd.addColorStop(1, 'rgba(160,185,205,0)');
  x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* ══════════════════════════════════════════════════════════════════ */
export class SnowScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;

    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(new THREE.Color(LOOK.fog), 0.0010);
    scene.background = new THREE.Color(LOOK.sky);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.5, 4000);
    this.rng = rngFrom(90210);
    const rng = this.rng;

    // Flat, bright, ambient-dominated. A hard key light would carve
    // shadows the reference simply does not have.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9cddd, 1.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-160, 240, -60);
    scene.add(sun);
    const bounce = new THREE.DirectionalLight(0xcfe0ee, 0.35);
    bounce.position.set(140, 60, 180);
    scene.add(bounce);

    this._sky(scene);
    this._ground(scene);
    this._mountains(scene, rng);

    this.rider = buildRider();
    scene.add(this.rider);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 2.2),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, fog: true })
    );
    shadow.rotation.x = -Math.PI / 2;
    this.shadow = shadow;
    scene.add(shadow);

    this._pool(scene, rng);
    this._snowfall(scene);
    this._puffSystem(scene);

    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this._seeded = false;
    this._shake = 0;
    this.resize();
  }

  /* ── static furniture ───────────────────────────────────────────── */
  _sky(scene) {
    const geo = new THREE.SphereGeometry(3000, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(LOOK.sky) },
        low: { value: new THREE.Color(LOOK.skyLow) }
      },
      vertexShader: `varying float vH;
        void main(){ vH = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top, low; varying float vH;
        void main(){
          float h = clamp(vH * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(low, top, smoothstep(0.48, 0.86, h)), 1.0);
        }`
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
  }

  /**
   * The run. Because the profile depends only on x and the grade only on
   * z, the whole mesh is invariant under travel — it is built once and
   * translated, never rebuilt.
   */
  _ground(scene) {
    const W = 420, D = 900, sx = 96, sz = 120;
    const geo = new THREE.PlaneGeometry(W, D, sx, sz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getZ(i) * LOOK.grade + edgeProfile(pos.getX(i)));
    }
    geo.computeVertexNormals();

    // smooth-shaded, unlike everything else — the piste is groomed
    const colours = new Float32Array(pos.count * 3);
    const c = new THREE.Color(), n = new THREE.Vector3();
    const nrm = geo.attributes.normal;
    const lit = new THREE.Color(LOOK.snowLit), shade = new THREE.Color(LOOK.snowShade);
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nrm, i);
      const steep = 1 - Math.max(0, n.y);
      c.copy(lit).lerp(shade, THREE.MathUtils.smoothstep(steep, 0.05, 0.55));
      colours[i*3] = c.r; colours[i*3+1] = c.g; colours[i*3+2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

    this.ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.groundLocalZ = 0;
    scene.add(this.ground);
  }

  _mountains(scene, rng) {
    // Two rings: a towering far wall, and a nearer set that overlaps it.
    // Both ride with the camera, so they behave as a backdrop at infinity.
    this.backdrop = new THREE.Group();
    const mat = flatVC();
    const place = (geo, x, z, ry) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, z * LOOK.grade, z);
      m.rotation.y = ry;
      this.backdrop.add(m);
    };
    place(makeRange(rng, 2800, 950, 520, 84, 28), 0, -900, 0);
    place(makeRange(rng, 2400, 850, 430, 72, 24), -980, -620, 0.5);
    place(makeRange(rng, 2400, 850, 450, 72, 24), 980, -620, -0.5);
    place(makeRange(rng, 2000, 700, 340, 56, 20), -1250, 220, 1.2);
    place(makeRange(rng, 2000, 700, 340, 56, 20), 1250, 220, -1.2);
    scene.add(this.backdrop);
  }

  /* ── recycled props ─────────────────────────────────────────────── */
  _pool(scene, rng) {
    // One merged mesh per pine size class, instanced through a pool of
    // Object3Ds we reposition as the field scrolls.
    const treeGeos = [[], [], []];
    for (let k = 0; k < 3; k++) {
      const h = [7, 10, 14][k];
      const out = [];
      pushPine(out, rng, 0, 0, 0, h * (0.9 + rng() * 0.2));
      treeGeos[k] = mergeGeometries(out, false);
    }
    const mat = flatVC();
    this.treeMeshes = treeGeos.map(g => new THREE.Mesh(g, mat));

    this.trees = [];
    for (let i = 0; i < 400; i++) {
      const m = this.treeMeshes[(rng() * 3) | 0].clone();
      m.rotation.y = rng() * 6.28;
      m.visible = false;
      scene.add(m);
      this.trees.push(m);
    }

    this.rockMeshes = [];
    for (let i = 0; i < 5; i++) this.rockMeshes.push(new THREE.Mesh(makeRock(rng, 1), mat));
    this.rocks = [];
    for (let i = 0; i < 60; i++) {
      const m = this.rockMeshes[(rng() * 5) | 0].clone();
      m.visible = false;
      scene.add(m);
      this.rocks.push(m);
    }
  }

  _snowfall(scene) {
    const N = 900, pos = new Float32Array(N * 3);
    this.flakeSpan = { x: 120, y: 70, z: 260 };
    for (let i = 0; i < N; i++) {
      pos[i*3]   = (Math.random() - 0.5) * this.flakeSpan.x;
      pos[i*3+1] = Math.random() * this.flakeSpan.y;
      pos[i*3+2] = (Math.random() - 0.5) * this.flakeSpan.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.snow = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.30, sizeAttenuation: true, map: flakeTexture(),
      transparent: true, opacity: 0.8, depthWrite: false, alphaTest: 0.02, fog: false
    }));
    this.snow.frustumCulled = false;
    scene.add(this.snow);
  }

  /** Snow thrown up where the rider goes down. */
  _puffSystem(scene) {
    const N = 90;
    this.puffN = N;
    this.puffVel = new Float32Array(N * 3);
    this.puffLife = new Float32Array(N);
    const pos = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.puff = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.55, sizeAttenuation: true, map: flakeTexture(),
      transparent: true, opacity: 0, depthWrite: false, fog: true
    }));
    this.puff.frustumCulled = false;
    scene.add(this.puff);
    this._puffed = false;
    this._crashT = 0;
  }

  _spawnPuff(x, y, z) {
    const p = this.puff.geometry.attributes.position.array;
    for (let i = 0; i < this.puffN; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random();
      p[i*3] = x + (Math.random() - 0.5) * 0.5;
      p[i*3+1] = y + 0.3 + Math.random() * 0.5;
      p[i*3+2] = z + (Math.random() - 0.5) * 0.5;
      const sp = 2.5 + r * 9;
      this.puffVel[i*3]   = Math.cos(a) * sp;
      this.puffVel[i*3+1] = 2.5 + Math.random() * 7;
      this.puffVel[i*3+2] = Math.sin(a) * sp;
      this.puffLife[i] = 0.8 + Math.random() * 0.7;
    }
    this.puff.geometry.attributes.position.needsUpdate = true;
    this.puff.material.opacity = 0.95;
  }

  _updatePuff(dt) {
    if (this.puff.material.opacity <= 0.001) return;
    const p = this.puff.geometry.attributes.position.array;
    let alive = 0;
    for (let i = 0; i < this.puffN; i++) {
      if (this.puffLife[i] <= 0) continue;
      this.puffLife[i] -= dt;
      alive++;
      this.puffVel[i*3+1] -= 13 * dt;                 // gravity
      for (let k = 0; k < 3; k++) {
        p[i*3+k] += this.puffVel[i*3+k] * dt;
        this.puffVel[i*3+k] *= 1 - 1.6 * dt;          // drag
      }
    }
    this.puff.geometry.attributes.position.needsUpdate = true;
    this.puff.material.opacity = alive ? Math.min(0.95, this.puff.material.opacity - dt * 0.55) : 0;
  }

  /* ── frame ──────────────────────────────────────────────────────── */
  resize() {
    this.w = innerWidth; this.h = innerHeight;
    this.renderer.setSize(this.w, this.h);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
  }

  reset() {
    this._seeded = false; this._shake = 0;
    this._crashT = 0; this._puffed = false;
    this.puff.material.opacity = 0;
  }

  draw(game, dt) {
    const rz = -game.distance;                       // rider's world z
    const gy = groundY(game.x, rz);

    // ── rider ──
    const lean = THREE.MathUtils.clamp(game.vx / 17, -1, 1);
    const down = game.state === 'crashed';
    this.rider.position.set(game.x, gy + 0.03, rz);
    this.rider.visible = true;

    if (down) {
      // Vanishing on impact reads as a bug. Let the rider go over instead.
      if (!this._puffed) { this._spawnPuff(game.x, gy, rz); this._puffed = true; }
      this._crashT += dt;
      const t = this._crashT;
      // every axis clamped — an unbounded yaw leaves the rider spinning
      // on the spot for as long as the card is up
      this.rider.rotation.set(-Math.min(t * 5.0, 2.4),
                              lean * 0.42 + Math.min(t * 1.8, 1.15),
                              -lean * 0.38 - Math.min(t * 3.4, 1.9));
      this.rider.position.y = gy + Math.max(0, 1.6 * t - 6.2 * t * t);
    } else {
      this._crashT = 0;
      this._puffed = false;
      this.rider.rotation.set(0, lean * 0.42, -lean * 0.38);
    }

    this.shadow.position.set(game.x, gy + 0.05, rz + 0.1);
    this.shadow.visible = !down;

    // ── camera ──
    const back = 11 + game.speed * 0.10, up = 5.2;
    const want = new THREE.Vector3(game.x * 0.55, groundY(game.x * 0.55, rz + back) + up, rz + back);
    const aheadZ = rz - 34;
    const look = new THREE.Vector3(game.x * 0.72, groundY(game.x, aheadZ) + 7.5, aheadZ);

    // Seed BOTH, not just the position — a look target still travelling in
    // from the origin points back up the hill, and you spend the first
    // second staring at where you came from.
    if (!this._seeded) { this.camPos.copy(want); this.camLook.copy(look); this._seeded = true; }
    this.camPos.lerp(want, 1 - Math.pow(0.0022, dt));
    this.camLook.lerp(look, 1 - Math.pow(0.0009, dt));

    this._shake = Math.max(0, this._shake - dt * 2.4);
    if (game.state === 'crashed' && game.shake > 0) this._shake = game.shake;
    this.camera.position.copy(this.camPos);
    if (this._shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this._shake * 1.6;
      this.camera.position.y += (Math.random() - 0.5) * this._shake * 1.2;
    }
    this.camera.lookAt(this.camLook);

    // ── follow the world along ──
    this.sky.position.copy(this.camera.position);
    this.backdrop.position.set(this.camera.position.x * 0.94, rz * LOOK.grade, rz);
    // the ground slides in z, with the grade folded into y so the profile
    // lands exactly where groundY() says it should
    this.ground.position.set(0, rz * LOOK.grade, rz);

    this._layout(game);
    this._drift(dt, game);
    this._updatePuff(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Park pooled trees and rocks onto the obstacles the game reports. */
  _layout(game) {
    const list = game.visible(TRACK.ahead);
    let ti = 0, ri = 0;
    for (const o of list) {
      if (o.kind === 'tree') {
        if (ti >= this.trees.length) continue;
        const m = this.trees[ti++];
        m.position.set(o.x, groundY(o.x, -o.z) - 0.4, -o.z);
        const s = o.h / 10;
        m.scale.set(s, s, s);
        m.visible = true;
      } else {
        if (ri >= this.rocks.length) continue;
        const m = this.rocks[ri++];
        m.position.set(o.x, groundY(o.x, -o.z) - o.r * 0.15, -o.z);
        m.scale.setScalar(o.r * 1.35);
        m.visible = true;
      }
    }
    for (; ti < this.trees.length; ti++) this.trees[ti].visible = false;
    for (; ri < this.rocks.length; ri++) this.rocks[ri].visible = false;
  }

  /** Snowfall drifts around the camera and wraps inside its own box. */
  _drift(dt, game) {
    const p = this.snow.geometry.attributes.position;
    const a = p.array, sp = this.flakeSpan;
    const fall = 5 + game.speed * 0.08;
    for (let i = 0; i < a.length; i += 3) {
      a[i+1] -= fall * dt;
      a[i]   += Math.sin(a[i+1] * 0.2 + i) * 1.2 * dt;
      a[i+2] += game.speed * 0.55 * dt;          // streaming past as you descend
      if (a[i+1] < -12) a[i+1] += sp.y;
      if (a[i+2] > sp.z * 0.5) a[i+2] -= sp.z;
    }
    p.needsUpdate = true;
    this.snow.position.set(this.camera.position.x, this.camera.position.y - sp.y * 0.35, this.camera.position.z);
  }
}
