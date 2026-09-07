import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ══════════════════════════════════════════════════════════════════
   Wind Valley — the world.

   Everything is flat-shaded, untextured and painted from a small warm
   palette so it reads like gouache rather than plastic.

   Each island and each cloud is merged down to one or two meshes with
   baked vertex colours. That matters because split-screen renders the
   whole scene twice per frame — an island built from thirty separate
   little meshes would cost sixty draw calls a frame on its own.

   The world is "infinite": props wrap around a moving centre point
   (the aircraft, or the midpoint between them in two-player mode).
   ══════════════════════════════════════════════════════════════════ */

export const PALETTE = {
  skyTop:    new THREE.Color('#3d7fb5'),
  skyMid:    new THREE.Color('#8ec7e2'),
  skyLow:    new THREE.Color('#f4e3c0'),
  sun:       new THREE.Color('#fff3d0'),
  seaDeep:   new THREE.Color('#2b7d9b'),
  seaShallow:new THREE.Color('#83cdd6'),
  foam:      new THREE.Color('#eaf6f4'),
  grass:     new THREE.Color('#8bb463'),
  grassDark: new THREE.Color('#628f50'),
  grassLight:new THREE.Color('#b6d478'),
  sand:      new THREE.Color('#e6d6ab'),
  rock:      new THREE.Color('#9d8f7d'),
  rockDark:  new THREE.Color('#6f6558'),
  cloud:     new THREE.Color('#ffffff'),
  cloudShade:new THREE.Color('#cfdcea'),
  roof:      new THREE.Color('#c8503c'),
  wall:      new THREE.Color('#f3e8d2'),
  wood:      new THREE.Color('#8a6244')
};

export const WORLD = {
  wrap: 6400,        // props wrap inside a square this wide, centred on the action
  seaLevel: 0,
  fogNear: 460,
  fogFar: 3000
};

/* ── geometry plumbing ────────────────────────────────────────────── */
// Everything merged has to carry exactly the same attributes, so each
// source geometry is de-indexed, transformed, given a flat colour and
// stripped of its uvs.
function prep(source, matrix, color, tint = 0) {
  const g = source.index ? source.toNonIndexed() : source.clone();
  if (matrix) g.applyMatrix4(matrix);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = color.clone();
  if (tint) c.offsetHSL(0, 0, tint);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// Same as prep(), but shades the geometry bottom-to-top between two
// colours — used for foliage, so a crown reads as a lit form rather than a
// single dark blob.
function prepGradient(source, matrix, low, high) {
  const g = source.index ? source.toNonIndexed() : source.clone();
  if (matrix) g.applyMatrix4(matrix);
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(1e-4, maxY - minY);
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(low).lerp(high, (pos.getY(i) - minY) / span);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function mergeAll(geos) {
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  return merged;
}

const M = () => new THREE.Matrix4();
const trs = (x, y, z, sx = 1, sy = 1, sz = 1, ry = 0) => M()
  .compose(new THREE.Vector3(x, y, z),
           new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
           new THREE.Vector3(sx, sy, sz));

const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const cloudMat = new THREE.MeshLambertMaterial({
  vertexColors: true, flatShading: true,
  emissive: new THREE.Color('#e9eff7'), emissiveIntensity: 0.34
});

/* ── sky dome ─────────────────────────────────────────────────────── */
function makeSky() {
  const geo = new THREE.SphereGeometry(5200, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      topColor: { value: PALETTE.skyTop }, midColor: { value: PALETTE.skyMid },
      lowColor: { value: PALETTE.skyLow }, sunColor: { value: PALETTE.sun },
      sunDir:   { value: new THREE.Vector3(0.35, 0.32, -0.88).normalize() }
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 topColor, midColor, lowColor, sunColor, sunDir;
      varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        // warm haze pinned to the horizon, deep blue overhead
        vec3 col = mix(lowColor, midColor, smoothstep(0.478, 0.545, h));
        col = mix(col, topColor, smoothstep(0.54, 0.88, h));
        // broad hazy sun, no hard disc — keeps the painted feel
        float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunColor * pow(d, 8.0) * 0.42;
        col += sunColor * pow(d, 120.0) * 0.55;
        col += 0.012 * sin(h * 90.0);
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* ── sea ──────────────────────────────────────────────────────────── */
function makeSea() {
  const geo = new THREE.PlaneGeometry(12000, 12000, 140, 140);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: PALETTE.seaDeep.clone() },
        uShallow: { value: PALETTE.seaShallow.clone() },
        uFoam: { value: PALETTE.foam.clone() }
      }
    ]),
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      uniform float uTime;
      varying float vWave;
      varying vec2  vWorld;
      void main(){
        vec3 p = position;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        // three crossing swells — cheap, and reads as long ocean rollers
        float w = sin(wp.x * 0.010 + uTime * 0.55) * 1.6
                + sin(wp.z * 0.014 - uTime * 0.42) * 1.3
                + sin((wp.x + wp.z) * 0.026 + uTime * 0.9) * 0.7;
        p.y += w;
        vWave  = w;
        vWorld = wp.xz;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform vec3 uDeep, uShallow, uFoam;
      uniform float uTime;
      varying float vWave;
      varying vec2 vWorld;
      void main(){
        // quantise the swell into a few flat tones => cel-shaded water
        float t = clamp(vWave * 0.28 + 0.5, 0.0, 1.0);
        float bands = floor(t * 4.0) / 3.0;
        vec3 col = mix(uDeep, uShallow, bands);
        float crest = smoothstep(0.86, 0.99, t);
        float streak = smoothstep(0.45, 1.0, sin(vWorld.x * 0.21 + vWorld.y * 0.14 + uTime * 0.9));
        col = mix(col, uFoam, crest * streak * 0.42);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}

/* ── clouds ───────────────────────────────────────────────────────── */
const puffGeos = [
  new THREE.IcosahedronGeometry(1, 1),
  new THREE.IcosahedronGeometry(1, 0),
  new THREE.DodecahedronGeometry(1, 0)
];

function makeCloud(rng, scale = 1) {
  const geos = [];
  const puffs = 5 + ((rng() * 7) | 0);
  for (let i = 0; i < puffs; i++) {
    const r = (10 + rng() * 22) * scale;
    const under = rng() < 0.28;
    const m = M().compose(
      new THREE.Vector3(
        (rng() - 0.5) * 70 * scale,
        (under ? -8 : 3) * scale + (rng() - 0.5) * 14 * scale,
        (rng() - 0.5) * 46 * scale
      ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3)),
      new THREE.Vector3(r * (0.9 + rng() * 0.6), r * (0.62 + rng() * 0.35), r * (0.9 + rng() * 0.6))
    );
    geos.push(prep(puffGeos[(rng() * puffGeos.length) | 0], m,
                   under ? PALETTE.cloudShade : PALETTE.cloud, (rng() - 0.5) * 0.03));
  }
  return new THREE.Mesh(mergeAll(geos), cloudMat);
}

/* ── islands ──────────────────────────────────────────────────────── */
// Shape a cone into a hill: ridges and gullies running down the slopes,
// and a flared foot so it wades into the water instead of being sawn off
// by it.
//
// The displacement is a smooth function of (angle, height) — never
// per-vertex noise — so vertices that share a position (the cap/side seam,
// the duplicated apex) move identically and the shell stays welded.
function makeHillGeo(rng, radius, height) {
  const radial = 19 + ((rng() * 7) | 0);
  // NB: a cone, not a cylinder, is the obvious choice here — but three's
  // ConeGeometry only emits ONE triangle per grid cell once heightSegments
  // exceeds 1, so its shell is a lattice of disconnected triangles with
  // ~1170 boundary edges. Half of every quad is simply missing, which reads
  // as alternating holes across the slope. A cylinder with a small top
  // radius is watertight, and the tiny flat summit rounds the peak off
  // nicely anyway.
  const geo = new THREE.CylinderGeometry(radius * 0.05, radius, height, radial, 8).toNonIndexed();
  geo.deleteAttribute('uv');
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();

  const a = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const ridge = (ang, k) =>
      Math.sin(ang * 2 + a[0]) * 0.50 +
      Math.sin(ang * 3 + a[1] + k * 0.7) * 0.27 +
      Math.sin(ang * 5 + a[2]) * 0.15 +
      Math.sin(ang * 8 + a[3] + k * 1.6) * 0.08;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = Math.hypot(v.x, v.z);
    const k = THREE.MathUtils.clamp((v.y + height / 2) / height, 0, 1);
    if (d > 1e-4) {
      const ang = Math.atan2(v.z, v.x);
      // the slope eases off as it reaches the water — this is what gives
      // the island a beach rather than a chopped-off edge
      const flare = 1 + 0.28 * Math.pow(1 - Math.min(k / 0.20, 1), 2);
      // ridges, fading out near the summit so the peak stays clean
      const rib = 1 + ridge(ang, k) * 0.15 * (1 - k * 0.4);
      const scale = flare * rib;
      v.x *= scale; v.z *= scale;
      v.y += ridge(ang + 1.7, k) * height * 0.07 * (1 - k * 0.75);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Paint a hill *after* it has been moved into world space, so the beach
 * lands at the real waterline.
 *
 * Colour follows the SLOPE of each facet, not just its height. That is the
 * whole difference between a mountain and a green disc: height alone gives
 * concentric bands, whereas slope puts bare rock on the cliffs and grass on
 * the shoulders, which is what makes the form legible.
 *
 * The geometry is non-indexed, so computeVertexNormals has already given
 * each triangle's three vertices the same face normal — this is a true
 * per-facet paint.
 */
function paintTerrain(geo, rng) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const n = new THREE.Vector3();
  const ss = THREE.MathUtils.smoothstep;

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(1, maxY - minY);

  for (let t = 0; t < pos.count; t += 3) {
    n.fromBufferAttribute(nrm, t);
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const k = THREE.MathUtils.clamp((cy - minY) / span, 0, 1);
    const steep = 1 - Math.max(0, n.y);              // 0 flat, 1 vertical

    // meadow green, catching more sun toward the ridges
    c.copy(PALETTE.grassDark).lerp(PALETTE.grassLight, ss(k, 0.12, 0.92));
    // ground this steep can't hold soil
    c.lerp(PALETTE.rock, ss(steep, 0.33, 0.70) * 0.9);
    // the steepest, lowest faces are wet sea cliff
    c.lerp(PALETTE.rockDark, ss(steep, 0.70, 0.95) * (1 - k) * 0.65);
    // beach, on anything shallow within a few metres of the waterline
    c.lerp(PALETTE.sand, (1 - ss(cy, 1.0, 6)) * (1 - steep * 0.7));
    // cheap ambient occlusion — the foot of a hill sits in its own shade
    c.multiplyScalar(1 - 0.20 * (1 - k) * (1 - steep * 0.4));
    // a little per-facet drift, so it reads as brushwork rather than plastic
    c.offsetHSL((rng() - 0.5) * 0.016, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.026);

    for (let j = 0; j < 3; j++) {
      const o = (t + j) * 3;
      colors[o] = c.r; colors[o + 1] = c.g; colors[o + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

const trunkGeo   = new THREE.CylinderGeometry(0.55, 0.8, 4, 5);
const crownGeo   = new THREE.IcosahedronGeometry(1, 0);
const coniferGeo = new THREE.ConeGeometry(1, 1, 7);
const boxGeo     = new THREE.BoxGeometry(1, 1, 1);
const coneGeo    = new THREE.ConeGeometry(1, 1, 4);
const towerGeo   = new THREE.CylinderGeometry(1.6, 2.8, 11, 7);

const FOLIAGE = {
  needleLow:  new THREE.Color('#3d6a4a'),
  needleHigh: new THREE.Color('#8dba62'),
  leafLow:    new THREE.Color('#4d7846'),
  leafHigh:   new THREE.Color('#aacd6e')
};

/** Trees are shaded bottom-to-top so a crown reads as lit, not as a blob. */
function pushTree(out, rng, x, y, z, s) {
  out.push(prep(trunkGeo, trs(x, y + 2 * s, z, s, s, s), PALETTE.wood));
  if (rng() < 0.62) {
    // conifer: a stack of skirts, dark at the base, sunlit at the tip
    let cy = y + 3.0 * s;
    for (let i = 0; i < 3; i++) {
      const w = (4.6 - i * 1.25) * s, hh = (5.2 - i * 0.7) * s;
      out.push(prepGradient(coniferGeo, trs(x, cy + hh / 2, z, w, hh, w, rng() * 3),
                            FOLIAGE.needleLow, FOLIAGE.needleHigh));
      cy += hh * 0.46;
    }
  } else {
    out.push(prepGradient(crownGeo, trs(x, y + 6.6 * s, z, 3.6 * s, 4.6 * s, 3.6 * s, rng() * 3),
                          FOLIAGE.leafLow, FOLIAGE.leafHigh));
  }
}

function pushCottage(out, rng, x, y, z) {
  const w = 5 + rng() * 3, h = 4 + rng() * 2, d = 5 + rng() * 3, ry = rng() * Math.PI * 2;
  out.push(prep(boxGeo, trs(x, y + h / 2, z, w, h, d, ry), PALETTE.wall));
  out.push(prep(coneGeo, trs(x, y + h * 1.4, z, w * 0.92, h * 0.8, d * 0.92, ry + Math.PI / 4), PALETTE.roof));
}

/** The little windmill from every valley in every Ghibli film. */
function pushWindmill(out, rng, x, y, z) {
  out.push(prep(towerGeo, trs(x, y + 5.5, z), PALETTE.wall));
  out.push(prep(coneGeo, trs(x, y + 12.2, z, 3.2, 3, 3.2, Math.PI / 4), PALETTE.roof));

  const bladeGeos = [];
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Matrix4().makeRotationZ((i / 4) * Math.PI * 2);
    bladeGeos.push(prep(boxGeo, arm.multiply(trs(0, 4.25, 0, 0.5, 8.5, 1.6)), PALETTE.wood));
  }
  const blades = new THREE.Mesh(mergeAll(bladeGeos), terrainMat);
  blades.position.set(x, y + 10.5, z + 2.6);
  return blades;
}

function makeIsland(rng) {
  const g = new THREE.Group();
  const r = 30 + rng() * 80;
  const h = r * (0.7 + rng() * 0.9);       // tall enough to read as a mountain
  const baseY = -r * 0.14;                 // sink the base under the waves

  const terrain = [];
  const main = makeHillGeo(rng, r, h);
  main.applyMatrix4(trs(0, h / 2 + baseY, 0));
  terrain.push(paintTerrain(main, rng));

  // Height of the main cone's surface at distance d from the centre.
  // Everything planted on the island rides this curve.
  const surfaceAt = d => baseY + h * Math.max(0, 1 - d / r);

  // shoulder peaks, so the silhouette isn't a lone cone
  const peaks = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < peaks; i++) {
    const rr = r * (0.3 + rng() * 0.4), hh = rr * (0.7 + rng() * 0.9);
    const a = rng() * Math.PI * 2, d = r * (0.4 + rng() * 0.5);
    const geo = makeHillGeo(rng, rr, hh);
    geo.applyMatrix4(trs(Math.cos(a) * d, surfaceAt(d) + hh / 2 - hh * 0.35, Math.sin(a) * d));
    terrain.push(paintTerrain(geo, rng));
  }
  g.add(new THREE.Mesh(mergeAll(terrain), terrainMat));

  // ── dress the slopes ──
  const dress = [];
  const sink = h * 0.02 + 1;
  const scale = 0.7 + r / 150;
  // trees grow in stands, not in an even sprinkle
  const clumps = 3 + ((rng() * 5) | 0);
  for (let i = 0; i < clumps; i++) {
    const ca = rng() * Math.PI * 2, cd = r * (0.12 + rng() * 0.58);
    const spread = r * (0.06 + rng() * 0.1);
    const n = 3 + ((rng() * 6) | 0);
    for (let j = 0; j < n; j++) {
      const a = ca + (rng() - 0.5) * 1.3, d = Math.max(0, cd + (rng() - 0.5) * 2 * spread);
      const y = surfaceAt(d);
      if (y < 3) continue;                        // nothing grows in the surf
      pushTree(dress, rng, Math.cos(a) * d, y - sink, Math.sin(a) * d,
               (0.85 + rng() * 0.5) * scale);
    }
  }
  if (rng() < 0.55) {
    const a = rng() * Math.PI * 2, d = r * (0.25 + rng() * 0.3);
    pushCottage(dress, rng, Math.cos(a) * d, surfaceAt(d) - sink, Math.sin(a) * d);
  }
  if (rng() < 0.3) {
    const a = rng() * Math.PI * 2, d = r * (0.15 + rng() * 0.25);
    const blades = pushWindmill(dress, rng, Math.cos(a) * d, surfaceAt(d) - sink, Math.sin(a) * d);
    g.add(blades);
    g.userData.blades = blades;
  }
  if (dress.length) g.add(new THREE.Mesh(mergeAll(dress), terrainMat));

  g.userData.radius = r;
  g.userData.height = h;
  g.userData.baseY = baseY;
  return g;
}

/* ── birds ────────────────────────────────────────────────────────── */
const birdMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#3c4a52'), flatShading: true, side: THREE.DoubleSide
});
const wingShape = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(3.2, 0.8); s.lineTo(3.0, -0.2); s.lineTo(0, -0.5);
  return new THREE.ShapeGeometry(s);
})();

function makeBird(rng) {
  const g = new THREE.Group();
  const l = new THREE.Mesh(wingShape, birdMat);
  const r = new THREE.Mesh(wingShape, birdMat);
  r.scale.x = -1;
  g.add(l, r);
  g.userData = { l, r, phase: rng() * 6.28, speed: 1.6 + rng() * 1.4 };
  return g;
}

/* ── wind rings ───────────────────────────────────────────────────── */
const ringGeo = new THREE.TorusGeometry(13, 1.1, 8, 24);
const ringMatIdle = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#f2c14e'), emissive: new THREE.Color('#c98f27'),
  emissiveIntensity: 0.55, flatShading: true
});
// A taken ring keeps the colour of whoever got there first.
const ringMatTaken = ['#e8825f', '#a98fd0'].map(c => new THREE.MeshLambertMaterial({
  color: new THREE.Color(c), emissive: new THREE.Color(c), emissiveIntensity: 0.25,
  transparent: true, opacity: 0.4, flatShading: true
}));

/* ── deterministic RNG so a seed always grows the same valley ─────── */
export function makeRng(seed = 20260829) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ══════════════════════════════════════════════════════════════════ */
export class World {
  constructor(scene) {
    this.scene = scene;
    this.rng = makeRng();
    const rng = this.rng;

    scene.fog = new THREE.Fog(new THREE.Color('#cfe2ec'), WORLD.fogNear, WORLD.fogFar);

    // cool sky bounce + warm high sun: the classic anime key/fill pair
    const hemi = new THREE.HemisphereLight(0xcdeaf8, 0x8d9c78, 1.30);
    const sun = new THREE.DirectionalLight(0xfff0cf, 1.5);
    sun.position.set(150, 260, -240);
    const rim = new THREE.DirectionalLight(0x9ec8e8, 0.45);
    rim.position.set(-160, 60, 180);
    scene.add(hemi, sun, rim);

    this.sky = makeSky();
    this.sea = makeSea();
    scene.add(this.sky, this.sea);

    const scatter = (n, build, yMin, yMax) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const o = build(rng);
        o.position.set(
          (rng() - 0.5) * WORLD.wrap,
          yMin + rng() * (yMax - yMin),
          (rng() - 0.5) * WORLD.wrap
        );
        scene.add(o);
        out.push(o);
      }
      return out;
    };

    this.islands   = scatter(46, makeIsland, 0, 0);
    this.islands.forEach(i => { i.position.y = 0; });
    this.clouds    = scatter(62, r => makeCloud(r, 0.8 + r() * 1.25), 190, 460);
    this.lowClouds = scatter(38, r => makeCloud(r, 0.5 + r() * 0.55), 16, 40);
    this.birds     = scatter(26, makeBird, 45, 170);
    this.birds.forEach(b => b.scale.setScalar(1.4 + rng() * 1.6));

    this.rings = [];
    for (let i = 0; i < 54; i++) {
      const ring = new THREE.Mesh(ringGeo, ringMatIdle);
      ring.position.set(
        (rng() - 0.5) * WORLD.wrap,
        30 + rng() * 150,
        (rng() - 0.5) * WORLD.wrap
      );
      ring.rotation.y = rng() * Math.PI * 2;
      ring.userData.takenBy = -1;
      ring.userData.spin = (rng() - 0.5) * 0.4;
      scene.add(ring);
      this.rings.push(ring);
    }

    this.half = WORLD.wrap / 2;
    this._t = 0;

    // Keep the take-off corridor clear — the first few seconds should be
    // open sky, not the inside of a cloud.
    this._clearSpawn(this.islands, 700);
    this._clearSpawn(this.clouds, 360);
    this._clearSpawn(this.lowClouds, 460);
    this._clearSpawn(this.rings, 280);
  }

  /** Shove anything sitting on top of the spawn point out to `r`. */
  _clearSpawn(list, r) {
    for (const o of list) {
      const d = Math.hypot(o.position.x, o.position.z);
      if (d >= r) continue;
      const a = d < 1e-3 ? this.rng() * Math.PI * 2 : Math.atan2(o.position.z, o.position.x);
      const push = r + this.rng() * 400;
      o.position.x = Math.cos(a) * push;
      o.position.z = Math.sin(a) * push;
    }
  }

  /** Wrap a prop into the [-half, half] box centred on the action. */
  _wrap(obj, cx, cz) {
    const w = WORLD.wrap;
    if (obj.position.x - cx >  this.half) obj.position.x -= w;
    if (obj.position.x - cx < -this.half) obj.position.x += w;
    if (obj.position.z - cz >  this.half) obj.position.z -= w;
    if (obj.position.z - cz < -this.half) obj.position.z += w;
  }

  /**
   * @param {THREE.Vector3} centre  the aircraft, or the midpoint between
   *        both aircraft in two-player mode.
   */
  update(dt, centre) {
    this._t += dt;
    this.sea.material.uniforms.uTime.value = this._t;

    // sky + sea ride along so the horizon never runs out
    this.sky.position.set(centre.x, 0, centre.z);
    this.sea.position.set(centre.x, WORLD.seaLevel, centre.z);

    for (const o of this.islands) {
      this._wrap(o, centre.x, centre.z);
      if (o.userData.blades) o.userData.blades.rotation.z += dt * 0.9;
    }
    for (const c of this.clouds)    { this._wrap(c, centre.x, centre.z); c.position.x += dt * 1.6; }
    for (const c of this.lowClouds) { this._wrap(c, centre.x, centre.z); c.position.x += dt * 2.4; }
    for (const r of this.rings)     { this._wrap(r, centre.x, centre.z); r.rotation.y += dt * r.userData.spin; }

    for (const b of this.birds) {
      this._wrap(b, centre.x, centre.z);
      const u = b.userData;
      u.phase += dt * u.speed * 3;
      const flap = Math.sin(u.phase) * 0.6;
      u.l.rotation.z =  flap;
      u.r.rotation.z = -flap;
      b.rotation.y += dt * 0.12;
      b.position.x += Math.cos(b.rotation.y) * dt * 9;
      b.position.z += Math.sin(b.rotation.y) * dt * 9;
      b.position.y += Math.sin(this._t * 0.6 + u.phase * 0.1) * dt * 3;
    }
  }

  /**
   * Claim any ring this aircraft just flew through.
   * First one there takes it — the ring then wears that player's colour.
   * @returns {number} how many were claimed this frame.
   */
  collect(planePos, playerIndex = 0, radius = 13) {
    let got = 0;
    for (const r of this.rings) {
      if (r.userData.takenBy >= 0) continue;
      if (planePos.distanceTo(r.position) < radius) {
        r.userData.takenBy = playerIndex;
        r.material = ringMatTaken[playerIndex % ringMatTaken.length];
        got++;
      }
    }
    return got;
  }

  /** Ground height under a point — islands are cones, so this is cheap. */
  heightAt(x, z) {
    let h = WORLD.seaLevel;
    for (const isl of this.islands) {
      const dx = x - isl.position.x, dz = z - isl.position.z;
      const r = isl.userData.radius;
      const d = Math.hypot(dx, dz);
      if (d < r) h = Math.max(h, isl.userData.baseY + isl.userData.height * (1 - d / r));
    }
    return h;
  }
}
