import * as THREE from 'three';
import { World } from './world.js';
import { Aircraft, ChaseCamera, LIVERIES } from './plane.js';
import { PoseController, PLAYER_ACCENT } from './pose.js';
import { cameraDiagnostics, formatDiagnostics, interpret } from './camera.js';
import { Panel, Register, Banner } from './hud.js';

/* ══════════════════════════════════════════════════════════════════
   Wind Valley — entry point.
   ══════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const els = {
  canvas: $('scene'), hud: $('hud'), start: $('start'), loading: $('loading'),
  loadingText: $('loading-text'), startError: $('start-error'),
  btnStart: $('btn-start'), btnKeys: $('btn-keys'), modeBtns: [...document.querySelectorAll('.mode-btn')],
  video: $('webcam'), poseCanvas: $('pose-canvas'), pilotView: $('pilot-view'),
  hint: $('hint')
};

/* ── renderer / scene ─────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({
  canvas: els.canvas, antialias: true, powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
const world = new World(scene);

/* ── players ──────────────────────────────────────────────────────── */
// Built on take-off, once we know whether this is a one- or two-seat game.
let players = [];
let playerCount = 1;
let mode = 'keys';                       // 'pose' | 'keys'
let pose = null;
let register = null;
let banner = null;

const AUTO_INPUT = { bank: 0, pitch: 0.04, throttle: 0.45 };   // unattended glide

function makePlayer(index, count) {
  const camera = new THREE.PerspectiveCamera(count > 1 ? 78 : 62, 1, 0.5, 7000);
  const plane = new Aircraft(scene, index);
  const chase = new ChaseCamera(camera);
  chase.pos.copy(plane.position).add(new THREE.Vector3(0, 8, 38));
  chase.look.copy(plane.position).add(new THREE.Vector3(0, 0, -40));
  return {
    index, plane, camera, chase,
    score: 0,
    panel: new Panel(els.hud, index, count),
    keys: { bank: 0, pitch: 0, throttle: 0.55 },
    hadPilot: false
  };
}

/* ── keyboard fallback ────────────────────────────────────────────── */
// P1: arrows + RightShift for power + Enter for a gust
// P2: WASD   + LeftShift  for power + Space for a gust
const KEYMAP = [
  { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', power: 'ShiftRight', gust: 'Enter' },
  { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', power: 'ShiftLeft', gust: 'Space' }
];

const held = new Set();
const pressed = new Set();               // edge-triggered, cleared each frame
addEventListener('keydown', e => {
  if (!held.has(e.code)) pressed.add(e.code);
  held.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => held.delete(e.code));

function readKeys(p, dt) {
  const map = KEYMAP[p.index % KEYMAP.length];
  const axis = (neg, pos) => (held.has(neg) ? -1 : 0) + (held.has(pos) ? 1 : 0);
  const bankT = axis(map.right, map.left);              // left key => bank left
  const pitchT = axis(map.down, map.up);
  p.keys.bank  += (bankT  - p.keys.bank)  * Math.min(1, dt * 4);
  p.keys.pitch += (pitchT - p.keys.pitch) * Math.min(1, dt * 4);
  const thr = held.has(map.power) ? 1 : 0.6;
  p.keys.throttle += (thr - p.keys.throttle) * Math.min(1, dt * 1.5);
  if (pressed.has(map.gust)) { p.plane.gust(1); p.panel.flashGust(); }
  return p.keys;
}

/* ── hints ────────────────────────────────────────────────────────── */
const HINTS_POSE = [
  'spread your arms to catch the wind',
  'dip one arm — the plane banks that way',
  'both arms up to climb, down to dive',
  'flap twice, fast, for a burst of speed',
  'fly through the golden rings'
];
const HINTS_KEYS_SOLO = ['← → bank · ↑ ↓ climb & dive · right-shift power · enter for a gust'];
const HINTS_KEYS_DUO = [
  'P1 ← → ↑ ↓ · right-shift power · enter for a gust',
  'P2 A D W S · left-shift power · space for a gust'
];
let hints = HINTS_POSE;
let hintTimer = 0, hintIndex = 0;

function cycleHint(dt) {
  hintTimer += dt;
  if (hintTimer < 7) return;
  hintTimer = 0;
  hintIndex = (hintIndex + 1) % hints.length;
  els.hint.classList.add('fade');
  setTimeout(() => {
    els.hint.textContent = hints[hintIndex];
    els.hint.classList.remove('fade');
  }, 500);
}

/* ── per-player control resolution ────────────────────────────────── */
function resolveInput(p, dt) {
  if (mode === 'keys') return { input: readKeys(p, dt), span: 1.2 + p.keys.throttle * 1.7, status: '' };

  const slot = pose.slots[p.index];
  if (!slot || !slot.locked) {
    // Nobody holds this seat. The aircraft glides itself, and the slot
    // stays open until somebody steady walks into frame.
    const waiting = pose.claimProgress();
    return {
      input: AUTO_INPUT,
      span: 1.0,
      status: waiting > 0.05 ? 'registering…' : 'waiting for a pilot',
      statusClass: 'warn'
    };
  }
  if (slot.gust) { p.plane.gust(1); p.panel.flashGust(); }
  return {
    input: slot.input,
    span: slot.raw.span,
    status: slot.present ? (slot.wingsOut ? '' : 'arms in — gliding') : 'lost you — hold on',
    statusClass: slot.present ? '' : 'warn'
  };
}

/* ── main loop ────────────────────────────────────────────────────── */
let last = performance.now();
let running = false;
let fps = 60;
const centre = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) return;

  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (mode === 'pose' && pose) {
    pose.update(now);
    pose.draw();
    if (register) {
      register.update(pose);
      if (pose.ready) register.hide(); else register.show();
    }
  }

  centre.set(0, 0, 0);
  for (const p of players) {
    const r = resolveInput(p, dt);
    p.plane.update(dt, r.input, world);
    p.chase.update(dt, p.plane);
    p.score += world.collect(p.plane.position, p.index);
    p.panel.update(p.plane, { span: r.span, score: p.score, status: r.status, statusClass: r.statusClass });
    centre.add(p.plane.position);
  }
  centre.divideScalar(players.length);
  world.update(dt, centre);

  if (banner) updateBanner();
  cycleHint(dt);
  pressed.clear();
  render();
}
requestAnimationFrame(frame);

function updateBanner() {
  if (mode !== 'pose' || !pose || !pose.ready) { banner.set(''); return; }
  const lost = players.find(p => {
    const s = pose.slots[p.index];
    return s && s.locked && !s.present;
  });
  banner.set(lost ? `Pilot ${lost.index + 1} — hold still, reacquiring…` : '',
             lost ? PLAYER_ACCENT[lost.index % PLAYER_ACCENT.length] : null);
}

function render() {
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  if (players.length === 1) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, players[0].camera);
    return;
  }
  // split screen: player 1 left, player 2 right
  renderer.setScissorTest(true);
  const half = Math.floor(w / 2);
  for (let i = 0; i < players.length; i++) {
    const x = i === 0 ? 0 : half;
    const vw = i === 0 ? half : w - half;
    renderer.setViewport(x, 0, vw, h);
    renderer.setScissor(x, 0, vw, h);
    renderer.render(scene, players[i].camera);
  }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  const w = innerWidth, h = innerHeight;
  const aspect = players.length === 1 ? w / h : (w / 2) / h;
  for (const p of players) {
    p.camera.aspect = aspect;
    p.camera.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);

/* ── boot ─────────────────────────────────────────────────────────── */
function begin(controlMode, count) {
  mode = controlMode;
  playerCount = count;

  players = Array.from({ length: count }, (_, i) => makePlayer(i, count));
  els.hud.dataset.players = String(count);
  banner = new Banner(els.hud);

  if (mode === 'pose') {
    register = new Register(els.hud, count);
    hints = HINTS_POSE;
  } else {
    els.pilotView.classList.add('hidden');
    hints = count > 1 ? HINTS_KEYS_DUO : HINTS_KEYS_SOLO;
  }
  els.hint.textContent = hints[0];

  els.start.classList.add('hidden');
  stopLoadNote();
  els.loading.classList.add('hidden');
  els.hud.classList.remove('hidden');
  resize();
  last = performance.now();
  running = true;
}

let chosenPlayers = 1;
els.modeBtns.forEach(btn => btn.addEventListener('click', () => {
  els.modeBtns.forEach(b => b.classList.toggle('active', b === btn));
  chosenPlayers = Number(btn.dataset.players);
}));

els.btnStart.addEventListener('click', async () => {
  els.btnStart.disabled = true;
  els.startError.textContent = '';
  els.loading.classList.remove('hidden');
  startLoadNote();
  try {
    pose = new PoseController(els.video, els.poseCanvas, chosenPlayers);
    await pose.init(msg => { els.loadingText.textContent = msg; });
    begin('pose', chosenPlayers);
  } catch (err) {
    console.error(err);
    stopLoadNote();
    els.loading.classList.add('hidden');
    els.btnStart.disabled = false;
    // openCamera() already translates the failure into something actionable;
    // anything else is a genuine surprise and shows its raw message.
    els.startError.textContent = (err && err.friendly)
      ? err.message + ' You can fly with the keyboard meanwhile.'
      : `Could not start tracking (${err && err.message ? err.message : err}). ` +
        'You can still fly with the keyboard.';
    els.btnStart.textContent = 'Try the camera again';
    showCameraDiagnostics();
  }
});

els.btnKeys.addEventListener('click', () => begin('keys', chosenPlayers));

// handy for tuning without reloading
window.__wind = {
  world, scene, renderer,
  get players() { return players; },
  get plane() { return players[0] && players[0].plane; },
  get chase() { return players[0] && players[0].chase; },
  get fps() { return fps; },
  get pose() { return pose; }
};

/* ── camera diagnostics panel ─────────────────────────────────────── */
async function showCameraDiagnostics() {
  const wrap = document.getElementById('cam-diag');
  const body = document.getElementById('diag-body');
  const verdict = document.getElementById('diag-verdict');
  if (!wrap || !body) return;
  try {
    const d = await cameraDiagnostics();
    verdict.textContent = interpret(d);
    body.textContent = formatDiagnostics(d);
    wrap.classList.remove('hidden');
    const copy = document.getElementById('diag-copy');
    if (copy) copy.onclick = () => {
      navigator.clipboard.writeText(verdict.textContent + '\n\n' + body.textContent)
        .then(() => { copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1500); })
        .catch(() => { copy.textContent = 'Select and copy manually'; });
    };
  } catch (e) {
    /* diagnostics are a nicety; never let them mask the original failure */
  }
}

/* ── first-load note ──────────────────────────────────────────────── */
// ~15 MB of wasm and model comes down the first time. On a slow link that
// is well over half a minute, and silence reads as a hang.
let loadNoteTimers = [];
function startLoadNote() {
  const note = document.getElementById('loading-note');
  if (!note) return;
  stopLoadNote();
  note.textContent = '';
  loadNoteTimers = [
    setTimeout(() => { note.textContent =
      'First run downloads about 15 MB of tracking model. It is cached afterwards.'; }, 2500),
    setTimeout(() => { note.textContent =
      'Still downloading — this can take a minute on a slow connection.'; }, 25000),
    setTimeout(() => { note.textContent =
      'Taking unusually long. If nothing moves, check your connection and reload.'; }, 60000)
  ];
}
function stopLoadNote() {
  loadNoteTimers.forEach(clearTimeout);
  loadNoteTimers = [];
}
