import { FilesetResolver, PoseLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { openCamera, fetchWithProgress, formatProgress } from './camera.js';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
                  'pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/* ══════════════════════════════════════════════════════════════════
   Rider tracking.

   Landmarks used (MediaPipe Pose indices):
     11 L shoulder  12 R shoulder
     15 L wrist     16 R wrist
     23 L hip       24 R hip

   STEER comes from how far the shoulders sit to one side of the hips —
   a genuine torso lean, not just "where is the player standing". Both
   measurements are divided by shoulder width, so it reads the same at
   any distance from the lens, and the hip reference means shuffling
   sideways across the room does nothing. You have to actually lean.

   Shoulder roll (dropping one shoulder into the turn) is folded in as a
   smaller second term, because that is what a rider's body does anyway.

   If the hips leave frame — easy to do in a small room — it falls back
   to shoulder roll alone rather than dropping the controls.

   RESTART is both arms raised above the head, held briefly.
   ══════════════════════════════════════════════════════════════════ */

const L = { SHOULDER: 11, WRIST: 15, HIP: 23 };
const R = { SHOULDER: 12, WRIST: 16, HIP: 24 };

export const CALIB = {
  leanGain: 2.9,        // torso offset (in shoulder widths) -> steer
  leanDeadzone: 0.055,
  rollGain: 1.15,       // shoulder roll assist
  rollDeadzone: 0.05,
  rollOnlyGain: 2.2,    // gain when the hips are out of frame
  minVisibility: 0.55,
  smoothing: 0.30,      // per 1/30 s, rescaled for the real frame time
  lostGrace: 1.2,       // seconds of tracking loss before we call it lost
  raiseHold: 0.7        // seconds of arms-up needed to restart
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const deadzone = (v, d) => (Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d));
const rate = (k, dt) => 1 - Math.pow(1 - k, Math.max(dt, 1e-3) * 30);

const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26]
];

export class RiderTracker {
  constructor(video, previewCanvas) {
    this.video = video;
    this.canvas = previewCanvas;
    this.ctx = previewCanvas ? previewCanvas.getContext('2d') : null;

    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.landmarks = null;

    /** −1 hard left … +1 hard right, smoothed. */
    this.steer = 0;
    this.raw = { lean: 0, roll: 0, steer: 0 };
    this.tracked = false;
    this.hipsVisible = false;
    this.lostFor = 0;
    this.armsUpFor = 0;

    this._lastMs = performance.now();
    this._acc = 0;
  }

  /** True once we have a steady read on the rider. */
  get ready() { return this.tracked; }
  /** 0..1 — how far through the arms-up restart gesture the rider is. */
  get restartProgress() { return Math.min(1, this.armsUpFor / CALIB.raiseHold); }

  async init(onProgress = () => {}) {
    onProgress('opening the camera…');
    this.stream = await openCamera();
    this.video.srcObject = this.stream;
    await this.video.play();

    // Warm the wasm binary ourselves so the ~9 MB download is visible.
    // FilesetResolver fetches it internally with no progress hook, but it
    // will hit the HTTP cache we just filled.
    onProgress('downloading the tracker…');
    try {
      await fetchWithProgress(WASM_BASE + '/vision_wasm_internal.wasm',
        (got, total) => onProgress(formatProgress('downloading the tracker…', got, total)));
    } catch (e) {
      // A failed warm-up is not fatal; FilesetResolver will fetch it again.
    }

    onProgress('starting the tracker…');
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

    // Fetching the model ourselves (rather than handing MediaPipe a URL)
    // is the only way to show progress on the 5.5 MB download.
    onProgress('downloading the pose model…');
    const modelBuffer = await fetchWithProgress(MODEL_URL,
      (got, total) => onProgress(formatProgress('downloading the pose model…', got, total)));

    onProgress('preparing the model…');
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
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
    this.landmarks = (result && result.landmarks && result.landmarks[0]) || null;
    this._interpret(dt);
    return this;
  }

  _interpret(dt) {
    const lm = this.landmarks, s = CALIB;
    const vis = p => (p && (p.visibility === undefined ? 1 : p.visibility)) || 0;

    if (!lm || Math.min(vis(lm[L.SHOULDER]), vis(lm[R.SHOULDER])) < s.minVisibility) {
      this.lostFor += dt;
      if (this.lostFor > s.lostGrace) this.tracked = false;
      this.armsUpFor = 0;
      this.steer += (0 - this.steer) * rate(0.08, dt);   // coast straight
      return;
    }

    this.lostFor = 0;
    this.tracked = true;

    const ls = lm[L.SHOULDER], rs = lm[R.SHOULDER];
    const shoulderW = Math.max(0.04, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

    // Shoulder roll: image y grows downward, so a positive value means the
    // rider's LEFT shoulder is the lower one — they are dropping into a
    // left-hand turn.
    let roll = (ls.y - rs.y) / shoulderW;
    roll = deadzone(roll, s.rollDeadzone);

    const lh = lm[L.HIP], rh = lm[R.HIP];
    this.hipsVisible = Math.min(vis(lh), vis(rh)) >= s.minVisibility;

    let steer;
    if (this.hipsVisible) {
      const hipMid = { x: (lh.x + rh.x) / 2 };
      // The camera image is not mirrored, so the rider's own left is at
      // HIGHER x. Leaning to their left therefore raises this value.
      let lean = (shoulderMid.x - hipMid.x) / shoulderW;
      lean = deadzone(lean, s.leanDeadzone);
      this.raw = { lean, roll, steer: 0 };
      // negate: leaning left (positive) must steer left (negative x)
      steer = -(lean * s.leanGain + roll * s.rollGain);
    } else {
      // hips out of shot — roll alone still gives a usable, if coarser, read
      this.raw = { lean: 0, roll, steer: 0 };
      steer = -roll * s.rollOnlyGain;
    }

    steer = clamp(steer, -1, 1);
    this.raw.steer = steer;
    this.steer += (steer - this.steer) * rate(s.smoothing, dt);

    // ── restart gesture: both wrists above the head ──
    const lw = lm[L.WRIST], rw = lm[R.WRIST];
    const head = lm[0];
    const up = head && vis(lw) > 0.5 && vis(rw) > 0.5 &&
               lw.y < head.y && rw.y < head.y;
    this.armsUpFor = up ? this.armsUpFor + dt : 0;
  }

  /** Mirrored webcam thumbnail with the skeleton and the lean line. */
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: w, height: h } = this.canvas;

    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    if (this.video.readyState >= 2) ctx.drawImage(this.video, 0, 0, w, h);
    else { ctx.fillStyle = '#1d3242'; ctx.fillRect(0, 0, w, h); }

    const lm = this.landmarks;
    if (lm && this.tracked) {
      const hot = Math.abs(this.steer) > 0.25;
      ctx.strokeStyle = hot ? 'rgba(159,198,224,.95)' : 'rgba(246,249,252,.72)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        if (!lm[a] || !lm[b]) continue;
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
      }
      ctx.stroke();

      // the actual control signal: shoulder midpoint against hip midpoint
      if (this.hipsVisible) {
        const sm = { x: (lm[11].x + lm[12].x) / 2 * w, y: (lm[11].y + lm[12].y) / 2 * h };
        const hm = { x: (lm[23].x + lm[24].x) / 2 * w, y: (lm[23].y + lm[24].y) / 2 * h };
        ctx.strokeStyle = 'rgba(200,80,60,.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(hm.x, hm.y); ctx.lineTo(hm.x, sm.y);   // plumb line
        ctx.moveTo(hm.x, sm.y); ctx.lineTo(sm.x, sm.y);   // the lean itself
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#c8503c';
        ctx.beginPath(); ctx.arc(sm.x, sm.y, 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.landmarker) this.landmarker.close();
  }
}
