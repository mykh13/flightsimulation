/* ══════════════════════════════════════════════════════════════════
   Snow Run — simulation.

   The mountain is modelled in metres. `z` is absolute distance down the
   slope, `x` is metres left/right of the fall line. The rider never
   really moves forward; `distance` grows and everything else is read
   relative to it, which makes the obstacle field trivially recyclable.
   ══════════════════════════════════════════════════════════════════ */

export const TRACK = {
  half: 13,           // clear width either side of the fall line
  treeBand: 34,       // trees fill from `half` out to `half + treeBand`
  ahead: 340,         // keep the field populated this far down the hill
  playerRadius: 0.7,
  maxDrift: 26        // hard limit on how far off-piste you can get
};

export const SPEED = {
  start: 26,
  gain: 26,           // added over the course of `rampOver` metres
  rampOver: 900,
  steerRate: 17,      // metres/second of lateral travel at full lean
  steerLag: 5.5       // how quickly lateral speed follows the lean
};

const rand = (a, b) => a + Math.random() * (b - a);

export class Game {
  constructor() {
    this.best = Number(localStorage.getItem('snowrun.best') || 0) || 0;
    this.reset();
  }

  reset() {
    this.state = 'running';       // 'running' | 'crashed'
    this.distance = 0;
    this.x = 0;
    this.vx = 0;
    this.speed = SPEED.start;
    this.obstacles = [];
    this.crash = null;            // {kind, x, z} once you hit something
    this.shake = 0;
    this._nextTreeZ = 12;
    this._nextRockZ = 55;         // a clear run-in, so you can find your feet
    this._populate();
  }

  get speedKph() { return Math.round(this.speed * 3.6); }
  get metres() { return Math.floor(this.distance); }

  /** Fill the field from wherever the spawners left off out to `ahead`. */
  _populate() {
    const limit = this.distance + TRACK.ahead;

    while (this._nextTreeZ < limit) {
      const z = this._nextTreeZ;
      // one stand per side, at a random depth into the tree band. Density
      // is highest right at the edge of the run, so straying off-piste
      // gets punished quickly rather than eventually.
      for (const side of [-1, 1]) {
        if (Math.random() < 0.86) {
          const t = Math.pow(Math.random(), 1.7);        // biased toward the edge
          const x = side * (TRACK.half + 0.4 + t * TRACK.treeBand);
          this.obstacles.push({
            kind: 'tree', x, z: z + rand(-1.4, 1.4),
            r: 0.85, h: rand(3.4, 5.6), seed: Math.random()
          });
        }
      }
      this._nextTreeZ += rand(1.5, 3.4);
    }

    while (this._nextRockZ < limit) {
      const z = this._nextRockZ;
      const n = Math.random() < 0.22 ? 2 : 1;            // occasional pairs
      for (let i = 0; i < n; i++) {
        this.obstacles.push({
          kind: 'rock',
          x: rand(-TRACK.half * 0.92, TRACK.half * 0.92),
          z: z + rand(-2, 2),
          r: rand(0.62, 1.05), h: 0, seed: Math.random()
        });
      }
      // the hill gets meaner the longer you last
      const gap = Math.max(11, 30 - this.distance / 90);
      this._nextRockZ += rand(gap * 0.6, gap * 1.5);
    }

    this.obstacles.sort((a, b) => a.z - b.z);
  }

  update(dt, steer) {
    if (this.state !== 'running') {
      this.shake = Math.max(0, this.shake - dt * 2.2);
      return;
    }

    this.speed = SPEED.start + SPEED.gain * Math.min(1, this.distance / SPEED.rampOver);

    // lateral movement carries a little inertia, so carving has weight
    const targetVx = Math.max(-1, Math.min(1, steer)) * SPEED.steerRate;
    this.vx += (targetVx - this.vx) * Math.min(1, dt * SPEED.steerLag);
    this.x += this.vx * dt;
    if (Math.abs(this.x) > TRACK.half + TRACK.maxDrift) {
      this.x = Math.sign(this.x) * (TRACK.half + TRACK.maxDrift);
      this.vx = 0;
    }

    const prev = this.distance;
    this.distance += this.speed * dt;

    // Collision by plane crossing rather than proximity: at 50 m/s an
    // obstacle moves nearly a metre per frame, so a radius test alone
    // would let things tunnel straight through the rider.
    for (const o of this.obstacles) {
      if (o.z > this.distance) break;            // sorted, so nothing further matters
      if (o.z <= prev) continue;                 // already behind us
      if (Math.abs(o.x - this.x) < o.r + TRACK.playerRadius) {
        this._wipeout(o);
        break;
      }
    }

    // recycle what's behind, top up what's ahead
    if (this.obstacles.length && this.obstacles[0].z < this.distance - 8) {
      let i = 0;
      while (i < this.obstacles.length && this.obstacles[i].z < this.distance - 8) i++;
      this.obstacles.splice(0, i);
    }
    this._populate();

    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  _wipeout(o) {
    this.state = 'crashed';
    this.crash = { kind: o.kind, x: o.x, z: o.z };
    this.shake = 1;
    if (this.metres > this.best) {
      this.best = this.metres;
      try { localStorage.setItem('snowrun.best', String(this.best)); } catch (e) { /* private mode */ }
    }
  }

  /** Obstacles currently in front of the rider, near enough to draw. */
  visible(range = TRACK.ahead) {
    const out = [];
    for (const o of this.obstacles) {
      const dz = o.z - this.distance;
      if (dz < -7) continue;
      if (dz > range) break;
      out.push(o);
    }
    return out;
  }
}
