import { FilesetResolver, PoseLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { openCamera } from './camera.js';

/* ══════════════════════════════════════════════════════════════════
   Body tracker.

   Landmarks used (MediaPipe Pose indices):
     11 L shoulder   12 R shoulder
     13 L elbow      14 R elbow
     15 L wrist      16 R wrist
     23 L hip        24 R hip

   Mapping (every measurement is divided by shoulder width, so it reads
   the same whether the pilot is two feet or ten feet from the lens):

     WINGSPAN  wrist-to-wrist distance  ->  throttle
     BANK      height difference between the wrists  ->  roll
               left arm low / right arm high  ->  bank left, turn left
     PITCH     mean wrist height vs the shoulder line  ->  climb / dive
     FLAP      two full up-down cycles inside a short window -> gust

   Multiple pilots are tracked by slot. A slot is *claimed* by a body
   that holds still enough for a moment, and stays bound to that body by
   nearest-centroid matching. Bodies that match no slot are ignored
   entirely — that is what keeps a third person walking through the
   frame from stealing the controls.
   ══════════════════════════════════════════════════════════════════ */

const L = { SHOULDER: 11, ELBOW: 13, WRIST: 15, HIP: 23 };
const R = { SHOULDER: 12, ELBOW: 14, WRIST: 16, HIP: 24 };

export const PLAYER_ACCENT = ['#e8825f', '#a98fd0'];

export const CALIB = {
  spanMin: 1.15,        // wrists this close together => throttle 0
  spanMax: 2.95,        // wrists this far apart      => throttle 1
  bankGain: 2.6,
  bankDeadzone: 0.05,
  pitchGain: 2.2,
  pitchDeadzone: 0.08,
  minVisibility: 0.55,
  smoothing: 0.22,      // per 1/30 s; rescaled for the real frame time

  // ── flap-to-gust ──
  flapHigh: 0.32,       // wrists this far above the shoulder line = "up"
  flapLow: -0.32,       // and this far below = "down"
  flapWindow: 2.0,      // all four crossings must land inside this many seconds
  flapCrossings: 4,     // up, down, up, down — i.e. two complete flaps
  flapCooldown: 2.6,    // no second gust until this has elapsed
  flapSettle: 0.85,     // how long the pitch axis stays damped after a flap

  // ── slot tracking ──
  matchRadius: 0.17,    // a body may move this far (normalised) between frames
  claimHold: 0.9,       // an unclaimed body must be steady this long to take a slot
  dropAfter: 1.4,       // a claimed body missing this long releases its slot
  candidateTtl: 0.5
};

/* ── flap detector ────────────────────────────────────────────────── */
// Watches the arm-height signal cross a pair of hysteresis thresholds.
// Four crossings inside `flapWindow` means the pilot flapped twice.
class FlapDetector {
  constructor() {
    this.t = 0;
    this.state = 0;        // -1 below the low line, +1 above the high line
    this.times = [];
    this.cooldown = 0;
    this.activity = 0;     // 1 right after a crossing, decays to 0
  }

  reset() {
    this.state = 0;
    this.times.length = 0;
    this.activity = 0;
  }

  /** @returns {boolean} true on the single frame a gust should fire. */
  update(armHeight, dt) {
    this.t += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.activity = Math.max(0, this.activity - dt / CALIB.flapSettle);

    let crossed = false;
    if (this.state <= 0 && armHeight > CALIB.flapHigh) { this.state = 1; crossed = true; }
    else if (this.state >= 0 && armHeight < CALIB.flapLow) { this.state = -1; crossed = true; }

    if (crossed) {
      this.times.push(this.t);
      this.activity = 1;
    }
    while (this.times.length && this.t - this.times[0] > CALIB.flapWindow) this.times.shift();

    if (this.times.length >= CALIB.flapCrossings && this.cooldown <= 0) {
      this.times.length = 0;
      this.cooldown = CALIB.flapCooldown;
      return true;
    }
    return false;
  }
}

/* ── one pilot's slot ─────────────────────────────────────────────── */
export class PilotSlot {
  constructor(index) {
    this.index = index;
    /** Smoothed, game-ready control values. */
    this.input = { bank: 0, pitch: 0, throttle: 0 };
    /** Raw, unsmoothed — for the HUD gauges. */
    this.raw = { span: 0, bank: 0, pitch: 0, armHeight: 0 };

    this.landmarks = null;
    this.anchor = null;        // torso centroid, normalised image coords
    this.locked = false;       // a registered pilot owns this slot
    this.present = false;      // ...and is visible right now
    this.missingFor = 0;
    this.wingsOut = false;
    this.gust = false;         // true for exactly one frame per burst
    this.gustCount = 0;
    this.flap = new FlapDetector();
  }

  claim(det) {
    this.locked = true;
    this.anchor = det.anchor;
    this.landmarks = det.lm;
    this.missingFor = 0;
    this.flap.reset();
  }

  release() {
    this.locked = false;
    this.present = false;
    this.anchor = null;
    this.landmarks = null;
    this.flap.reset();
  }

  attach(det, dt) {
    this.anchor = det.anchor;
    this.landmarks = det.lm;
    this.present = true;
    this.missingFor = 0;
    this._interpret(dt);
  }

  _interpret(dt) {
    const lm = this.landmarks, s = CALIB;
    this.gust = false;

    const ls = lm[L.SHOULDER], rs = lm[R.SHOULDER];
    const lw = lm[L.WRIST],    rw = lm[R.WRIST];
    const vis = p => (p.visibility === undefined ? 1 : p.visibility);

    if (Math.min(vis(ls), vis(rs), vis(lw), vis(rw)) < s.minVisibility) {
      this.present = false;
      this.decay(dt);
      return;
    }

    const shoulderW = Math.max(0.04, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    const shoulderY = (ls.y + rs.y) / 2;

    // ── wingspan -> throttle ──
    const span = Math.hypot(lw.x - rw.x, lw.y - rw.y) / shoulderW;
    const throttle = clamp01((span - s.spanMin) / (s.spanMax - s.spanMin));

    // ── wrist height delta -> bank ──
    // Image y grows downward, so (left.y - right.y) > 0 means the pilot's
    // LEFT hand is lower => left wing down => bank & turn left.
    let bank = (lw.y - rw.y) / shoulderW;
    bank = deadzone(bank, s.bankDeadzone) * s.bankGain;

    // ── mean wrist height vs the shoulders -> pitch, and the flap signal ──
    const armHeight = (shoulderY - (lw.y + rw.y) / 2) / shoulderW;
    let pitch = deadzone(armHeight, s.pitchDeadzone) * s.pitchGain;

    if (this.flap.update(armHeight, dt)) {
      this.gust = true;
      this.gustCount++;
    }

    this.raw = { span, bank, pitch, armHeight };
    this.wingsOut = throttle > 0.28;

    // With the arms tucked in there is no meaningful wing to tilt, so fade
    // the steering out rather than letting tracker noise fly the plane.
    const authority = smoothstep(throttle, 0.08, 0.42);
    // Mid-flap the arms are sweeping through the whole pitch range; without
    // this the aircraft would porpoise wildly every time you beat your wings.
    const pitchAuthority = authority * (1 - 0.8 * this.flap.activity);

    const k = rate(s.smoothing, dt);
    this.input.throttle += (throttle - this.input.throttle) * k;
    this.input.bank     += (clamp(bank, -1, 1) * authority - this.input.bank) * k;
    this.input.pitch    += (clamp(pitch, -1, 1) * pitchAuthority - this.input.pitch) * k;
  }

  /** Lost sight of this pilot: ease into a wings-level glide, don't freeze. */
  decay(dt) {
    this.gust = false;
    this.wingsOut = false;
    const k = rate(0.06, dt);
    this.input.bank  += (0 - this.input.bank) * k;
    this.input.pitch += (0 - this.input.pitch) * k;
    this.input.throttle += (0.35 - this.input.throttle) * k;
  }
}

/* ── the tracker ──────────────────────────────────────────────────── */
export class PoseController {
  constructor(video, previewCanvas, playerCount = 1) {
    this.video = video;
    this.canvas = previewCanvas;
    this.ctx = previewCanvas ? previewCanvas.getContext('2d') : null;

    this.players = playerCount;
    this.slots = Array.from({ length: playerCount }, (_, i) => new PilotSlot(i));
    this.candidates = [];      // bodies queueing for an open slot
    this.detections = [];      // everything seen this frame, for the overlay
    this.ignored = 0;          // bodies present but with nowhere to go

    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this._lastMs = performance.now();
    this._acc = 0;
  }

  /** Every slot has a registered pilot — the race can start. */
  get ready() { return this.slots.every(s => s.locked); }
  get openSlots() { return this.slots.filter(s => !s.locked); }

  async init(onProgress = () => {}) {
    onProgress('opening the camera…');
    this.stream = await openCamera();
    this.video.srcObject = this.stream;
    await this.video.play();

    onProgress('loading the pose model…');
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      // One more than we need, so an extra body is something we can see and
      // deliberately reject rather than something that displaces a pilot.
      numPoses: this.players + 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  }

  update(nowMs) {
    const wall = clamp((nowMs - this._lastMs) / 1000, 0, 0.1);
    this._lastMs = nowMs;
    this._acc += wall;

    if (!this.landmarker || this.video.readyState < 2) return this;
    if (this.video.currentTime === this.lastVideoTime) return this;
    this.lastVideoTime = this.video.currentTime;

    const dt = Math.max(this._acc, 1e-3);
    this._acc = 0;

    const result = this.landmarker.detectForVideo(this.video, nowMs);
    const poses = (result && result.landmarks) || [];
    this.detections = poses
      .map(lm => ({ lm, anchor: torsoAnchor(lm) }))
      .filter(d => d.anchor);

    this._track(dt);
    return this;
  }

  _track(dt) {
    const dets = this.detections;
    const takenDet = new Set();
    const fedSlot = new Set();

    // 1 — every locked slot grabs the nearest body inside the match radius.
    const pairs = [];
    for (const slot of this.slots) {
      if (!slot.locked || !slot.anchor) continue;
      for (let i = 0; i < dets.length; i++) {
        const d = dist(slot.anchor, dets[i].anchor);
        if (d <= CALIB.matchRadius) pairs.push({ slot, i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const p of pairs) {
      if (takenDet.has(p.i) || fedSlot.has(p.slot.index)) continue;
      takenDet.add(p.i);
      fedSlot.add(p.slot.index);
      p.slot.attach(dets[p.i], dt);
    }

    // 2 — locked slots that found nobody. Hold their last heading for a
    //     moment (a pilot turning sideways shouldn't cost them the plane),
    //     then give the slot up.
    for (const slot of this.slots) {
      if (!slot.locked || fedSlot.has(slot.index)) continue;
      slot.present = false;
      slot.missingFor += dt;
      slot.decay(dt);
      if (slot.missingFor > CALIB.dropAfter) slot.release();
    }

    // 3 — everyone else. They queue as candidates; only an open slot lets
    //     them in, so extra bodies are watched but never given controls.
    const leftovers = dets.filter((_, i) => !takenDet.has(i));
    const open = this.openSlots;
    this.ignored = Math.max(0, leftovers.length - open.length);
    this._updateCandidates(leftovers, open, dt);
  }

  _updateCandidates(leftovers, open, dt) {
    const matched = new Set();
    for (const c of this.candidates) {
      let best = -1, bestD = CALIB.matchRadius;
      for (let i = 0; i < leftovers.length; i++) {
        if (matched.has(i)) continue;
        const d = dist(c.anchor, leftovers[i].anchor);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        matched.add(best);
        c.anchor = leftovers[best].anchor;
        c.det = leftovers[best];
        // Only accrue claim time while a seat is actually free. Otherwise a
        // bystander who happened to be standing there the whole time would
        // drop straight into a seat the instant its pilot walked off, with
        // no pause and no chance for that pilot to step back in.
        c.heldFor = open.length ? c.heldFor + dt : 0;
        c.gone = 0;
      } else {
        c.gone += dt;
      }
    }
    for (let i = 0; i < leftovers.length; i++) {
      if (matched.has(i)) continue;
      this.candidates.push({ anchor: leftovers[i].anchor, det: leftovers[i], heldFor: 0, gone: 0 });
    }
    this.candidates = this.candidates.filter(c => c.gone < CALIB.candidateTtl);

    if (!open.length) return;
    // Steady bodies take the free slots, left-to-right as the pilots see
    // themselves in the mirrored preview.
    const eligible = this.candidates
      .filter(c => c.heldFor >= CALIB.claimHold)
      .sort((a, b) => (1 - a.anchor.x) - (1 - b.anchor.x));
    for (const c of eligible) {
      const slot = this.openSlots[0];
      if (!slot) break;
      slot.claim(c.det);
      slot.attach(c.det, dt);
      this.candidates.splice(this.candidates.indexOf(c), 1);
    }
  }

  /** How close an unclaimed body is to taking a free slot, 0..1. */
  claimProgress() {
    if (!this.openSlots.length) return 0;
    let best = 0;
    for (const c of this.candidates) best = Math.max(best, c.heldFor / CALIB.claimHold);
    return Math.min(1, best);
  }

  /* ── mirrored webcam thumbnail with every body drawn on it ──────── */
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: w, height: h } = this.canvas;

    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    if (this.video.readyState >= 2) ctx.drawImage(this.video, 0, 0, w, h);
    else { ctx.fillStyle = '#20323c'; ctx.fillRect(0, 0, w, h); }

    // ignored bodies first, so a registered pilot always draws on top
    const claimedLm = new Set(this.slots.map(s => s.landmarks).filter(Boolean));
    for (const d of this.detections) {
      if (claimedLm.has(d.lm)) continue;
      drawSkeleton(ctx, d.lm, w, h, 'rgba(200,206,210,.4)', 1.5);
    }
    for (const slot of this.slots) {
      if (!slot.locked || !slot.landmarks) continue;
      const accent = PLAYER_ACCENT[slot.index % PLAYER_ACCENT.length];
      drawSkeleton(ctx, slot.landmarks, w, h, slot.present ? accent : 'rgba(246,239,223,.35)', 2.4);
      drawWingLine(ctx, slot.landmarks, w, h, slot.wingsOut ? accent : 'rgba(246,239,223,.3)');
    }
    ctx.restore();

    // badges go on after the mirror is undone, so the numerals read correctly
    for (const slot of this.slots) {
      if (!slot.locked || !slot.landmarks) continue;
      const head = slot.landmarks[0];
      if (!head) continue;
      const x = (1 - head.x) * w, y = head.y * h - 16;
      ctx.fillStyle = PLAYER_ACCENT[slot.index % PLAYER_ACCENT.length];
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#20323c';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(slot.index + 1), x, y + 0.5);
    }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.landmarker) this.landmarker.close();
  }
}

/* ── drawing helpers ──────────────────────────────────────────────── */
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24]
];

function drawSkeleton(ctx, lm, w, h, color, width) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    if (!lm[a] || !lm[b]) continue;
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
  }
  ctx.stroke();
  for (const i of [15, 16]) {
    const p = lm[i];
    if (!p) continue;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x * w, p.y * h, width * 1.8, 0, Math.PI * 2); ctx.fill();
  }
}

function drawWingLine(ctx, lm, w, h, color) {
  if (!lm[15] || !lm[16]) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(lm[15].x * w, lm[15].y * h);
  ctx.lineTo(lm[16].x * w, lm[16].y * h);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ── maths helpers ────────────────────────────────────────────────── */
function torsoAnchor(lm) {
  const pts = [lm[L.SHOULDER], lm[R.SHOULDER], lm[L.HIP], lm[R.HIP]].filter(
    p => p && (p.visibility === undefined || p.visibility > 0.3)
  );
  if (pts.length < 2) return null;
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = v => clamp(v, 0, 1);
const deadzone = (v, d) => (Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d));
function smoothstep(x, a, b) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
// Convert a "per 1/30 s" lerp factor into one for the actual frame time.
const rate = (k, dt) => 1 - Math.pow(1 - k, Math.max(dt, 1e-3) * 30);
