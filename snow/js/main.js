import { Game, TRACK } from './game.js';
import { SnowScene } from './scene.js';
import { RiderTracker } from './pose.js';

/* ══════════════════════════════════════════════════════════════════
   Snow Run — entry point.
   ══════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const els = {
  canvas: $('scene'), hud: $('hud'), start: $('start'), loading: $('loading'),
  loadingText: $('loading-text'), startError: $('start-error'),
  btnStart: $('btn-start'), btnKeys: $('btn-keys'), btnRetry: $('btn-retry'),
  video: $('webcam'), poseCanvas: $('pose-canvas'), poseStatus: $('pose-status'),
  pilotView: $('pilot-view'), register: $('register'), regChip: $('reg-chip'),
  regState: $('reg-state'), crash: $('crash'), flash: $('flash'),
  dist: $('r-dist'), speed: $('r-speed'), best: $('r-best'),
  leanFill: $('lean-fill'), hint: $('hint'),
  crashDist: $('crash-dist'), crashBest: $('crash-best'),
  crashSub: $('crash-sub'), crashTitle: $('crash-title'), retryFill: $('retry-fill')
};

const game = new Game();
const renderer = new SnowScene(els.canvas);
addEventListener('resize', () => renderer.resize());

let mode = 'keys';           // 'pose' | 'keys'
let tracker = null;
let running = false;

/* ── keyboard fallback ────────────────────────────────────────────── */
const held = new Set();
let keySteer = 0;
addEventListener('keydown', e => {
  held.add(e.code);
  if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); tryRetry(); }
  if (['ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => held.delete(e.code));

function readKeys(dt) {
  const t = (held.has('ArrowLeft') || held.has('KeyA') ? -1 : 0) +
            (held.has('ArrowRight') || held.has('KeyD') ? 1 : 0);
  keySteer += (t - keySteer) * Math.min(1, dt * 7);
  return keySteer;
}

/* ── hints ────────────────────────────────────────────────────────── */
const HINTS_POSE = [
  'lean your shoulders to carve',
  'the further you lean, the harder you turn',
  'stay out of the pines',
  'the hill gets steeper the longer you last'
];
const HINTS_KEYS = ['← → to carve · space to restart'];
let hints = HINTS_POSE, hintTimer = 0, hintIndex = 0;

function cycleHint(dt) {
  if (hints.length < 2) return;
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

/* ── main loop ────────────────────────────────────────────────────── */
let last = performance.now();
let wasCrashed = false;
let crashCardTimer = null;

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) return;

  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let steer = 0;
  let waiting = false;

  if (mode === 'pose' && tracker) {
    tracker.update(now);
    tracker.draw();
    steer = tracker.steer;
    // Hold the run until we actually have the rider. Nobody should be
    // crashing into a boulder while they are still walking into frame.
    waiting = !tracker.ready;
    updateRegister(waiting);
    els.poseStatus.textContent = tracker.ready
      ? (tracker.hipsVisible ? 'tracking — lean to carve' : 'hips out of frame — using shoulders')
      : 'step back into frame';
    els.poseStatus.classList.toggle('locked', tracker.ready && tracker.hipsVisible);
  } else {
    steer = readKeys(dt);
  }

  if (!waiting) game.update(dt, steer);

  // crash transition — hold the card back for a beat so the wipeout itself
  // is visible instead of being covered the instant you hit something
  if (game.state === 'crashed' && !wasCrashed) {
    wasCrashed = true;
    crashCardTimer = setTimeout(showCrash, 950);
  }

  renderer.draw(game, dt);
  updateHud(steer);
  cycleHint(dt);

  // arms-up restart gesture
  if (game.state === 'crashed' && mode === 'pose' && tracker && !els.crash.classList.contains('hidden')) {
    const p = tracker.restartProgress;
    els.retryFill.style.width = (p * 100).toFixed(0) + '%';
    if (p >= 1) restart();
  }
}
requestAnimationFrame(frame);

function updateHud(steer) {
  els.dist.textContent = game.metres;
  els.speed.textContent = game.speedKph;
  els.best.textContent = game.best;
  const s = Math.max(-1, Math.min(1, steer));
  els.leanFill.style.width = Math.abs(s) * 50 + '%';
  els.leanFill.style.transform = s < 0 ? 'translateX(-100%)' : 'none';
}

function updateRegister(waiting) {
  els.register.classList.toggle('hidden', !waiting);
  els.regChip.classList.toggle('ready', !waiting);
  els.regState.textContent = waiting ? 'waiting' : 'ready';
}

function showCrash() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth;
  els.flash.classList.add('on');
  els.crashDist.textContent = game.metres;
  els.crashBest.textContent = game.best;
  els.crashTitle.textContent = game.metres >= game.best && game.metres > 0 ? 'New best' : 'Wipeout';
  els.crashSub.textContent = game.crash && game.crash.kind === 'tree'
    ? 'You found the tree line.'
    : 'You clipped a rock.';
  els.retryFill.style.width = '0%';
  els.crash.classList.remove('hidden');
}

function restart() {
  clearTimeout(crashCardTimer);
  els.crash.classList.add('hidden');
  renderer.reset();
  game.reset();
  wasCrashed = false;
  if (tracker) tracker.armsUpFor = 0;
}
function tryRetry() { if (game.state === 'crashed') restart(); }
els.btnRetry.addEventListener('click', restart);

/* ── boot ─────────────────────────────────────────────────────────── */
function begin(controlMode) {
  mode = controlMode;
  if (mode === 'keys') {
    els.pilotView.classList.add('hidden');
    els.register.classList.add('hidden');
    hints = HINTS_KEYS;
  }
  els.hint.textContent = hints[0];
  els.start.classList.add('hidden');
  els.loading.classList.add('hidden');
  els.hud.classList.remove('hidden');
  game.reset();
  wasCrashed = false;
  last = performance.now();
  running = true;
}

els.btnStart.addEventListener('click', async () => {
  els.btnStart.disabled = true;
  els.startError.textContent = '';
  els.loading.classList.remove('hidden');
  try {
    tracker = new RiderTracker(els.video, els.poseCanvas);
    await tracker.init(msg => { els.loadingText.textContent = msg; });
    begin('pose');
  } catch (err) {
    console.error(err);
    els.loading.classList.add('hidden');
    els.btnStart.disabled = false;
    els.startError.textContent = (err && err.friendly)
      ? err.message + ' You can play with the arrow keys meanwhile.'
      : `Could not start tracking (${err && err.message ? err.message : err}). ` +
        'You can still play with the arrow keys.';
    els.btnStart.textContent = 'Try the camera again';
  }
});

els.btnKeys.addEventListener('click', () => begin('keys'));

window.__snow = { game, renderer, TRACK, get tracker() { return tracker; }, get mode() { return mode; } };
