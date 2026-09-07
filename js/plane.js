import * as THREE from 'three';
import { WORLD } from './world.js';

/* ══════════════════════════════════════════════════════════════════
   The aircraft: a stubby seaplane, and the flight model that turns arm
   gestures into motion.

   Sign convention, used consistently everywhere below:
     bank  > 0  ->  rolled LEFT (left wing down)  ->  turns LEFT
     pitch > 0  ->  nose UP  ->  climbs
   The pose tracker reports "pilot's left hand lower" as bank > 0, so
   dropping your left arm drops the left wing.
   ══════════════════════════════════════════════════════════════════ */

export const LIVERIES = [
  { hull: '#c8503c', hullHi: '#e07a5f', trail: '#ffd9c9' },   // player 1 — crimson
  { hull: '#6b53a0', hullHi: '#9b7fc0', trail: '#e2d6f6' }    // player 2 — plum
];

const flat = c => new THREE.MeshLambertMaterial({ color: new THREE.Color(c), flatShading: true });

const SHARED = {
  wing:  flat('#f0e0c0'),
  trim:  flat('#3c4a52'),
  glass: new THREE.MeshLambertMaterial({ color: new THREE.Color('#bfe4f0'), transparent: true, opacity: 0.75, flatShading: true }),
  prop:  new THREE.MeshLambertMaterial({ color: new THREE.Color('#5a4636'), transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
  metal: flat('#8a939b')
};

function buildAircraft(livery = LIVERIES[0]) {
  const hull = flat(livery.hull);
  const hullHi = flat(livery.hullHi);
  const g = new THREE.Group();

  // fuselage — a tapered capsule, nose pointing -Z
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 8.2, 4, 10), hull);
  body.rotation.x = Math.PI / 2;
  body.scale.set(1, 1, 0.86);
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 10), hullHi);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -6.2;
  g.add(nose);

  // engine cowl + propeller
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.35, 1.1, 10), SHARED.trim);
  cowl.rotation.x = Math.PI / 2;
  cowl.position.z = -7.3;
  g.add(cowl);

  const prop = new THREE.Group();
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 8), SHARED.metal);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -0.4;
  prop.add(spinner);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.32, 5.4, 0.12), SHARED.prop);
    const arm = new THREE.Group();
    arm.add(blade);
    arm.rotation.z = (i / 3) * Math.PI * 2;
    prop.add(arm);
  }
  prop.position.z = -8.0;
  g.add(prop);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), SHARED.glass);
  canopy.position.set(0, 1.15, -2.0);
  canopy.scale.set(1, 0.85, 1.9);
  g.add(canopy);

  // main wing — single high wing, slight dihedral, wingtip floats
  const wing = new THREE.Group();
  const wingGeo = new THREE.BoxGeometry(6.4, 0.38, 3.1);
  const wl = new THREE.Mesh(wingGeo, SHARED.wing);
  wl.position.set(-3.5, 0, 0); wl.rotation.z =  0.10;
  const wr = new THREE.Mesh(wingGeo, SHARED.wing);
  wr.position.set( 3.5, 0, 0); wr.rotation.z = -0.10;
  wing.add(wl, wr, new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.38, 3.1), SHARED.wing));
  for (const s of [-1, 1]) {
    const float = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.7, 3, 6), hullHi);
    float.rotation.x = Math.PI / 2;
    float.position.set(s * 6.6, -0.85, 0.2);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.95, 0.12), SHARED.trim);
    strut.position.set(s * 6.6, -0.45, 0.2);
    wing.add(float, strut);
  }
  wing.position.set(0, 1.55, -0.4);
  g.add(wing);

  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 2.6, 2.0), hullHi);
  tailFin.position.set(0, 2.1, 5.4);
  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.28, 1.5), SHARED.wing);
  tailPlane.position.set(0, 1.0, 5.6);
  const hullStep = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 5.4), SHARED.trim);
  hullStep.position.set(0, -1.4, 0.6);
  g.add(tailFin, tailPlane, hullStep);

  g.userData.prop = prop;
  g.userData.wing = wing;
  return g;
}

/* ── flight model ─────────────────────────────────────────────────── */
export const FLIGHT = {
  stallSpeed: 16,
  cruiseSpeed: 46,
  maxSpeed: 96,
  turnRate: 1.05,      // rad/s at full bank
  maxBank: 1.05,       // ~60°
  maxPitch: 0.62,      // ~35°
  minAlt: 4,
  maxAlt: 620,
  gustSpeed: 62,       // extra airspeed at the peak of a flap burst
  gustDuration: 2.8    // seconds for a burst to bleed back to normal
};

export class Aircraft {
  constructor(scene, playerIndex = 0) {
    this.index = playerIndex;
    this.livery = LIVERIES[playerIndex % LIVERIES.length];
    this.mesh = buildAircraft(this.livery);
    scene.add(this.mesh);

    this.position = new THREE.Vector3(playerIndex * 46 - 23, 150, 0);
    this.heading = 0;
    this.pitch = 0;
    this.bank = 0;
    this.speed = FLIGHT.cruiseSpeed;
    this.throttle = 0.5;
    this.forward = new THREE.Vector3(0, 0, -1);
    this.crashed = 0;                 // seconds of recovery remaining
    this.gustEnergy = 0;              // 0..1, decays over gustDuration
    this._propSpin = 0;
    this._wingFlex = 0;

    const trailMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(this.livery.trail), transparent: true, opacity: 0.35
    });
    this.trails = [-1, 1].map(s => {
      const pts = new Float32Array(90 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(geo, trailMat.clone());
      line.frustumCulled = false;
      scene.add(line);
      return { line, side: s, pts, head: 0, filled: 0 };
    });
  }

  /** A flap burst: a gust of wind shoves the aircraft forward. */
  gust(strength = 1) {
    this.gustEnergy = Math.min(1.25, this.gustEnergy + strength);
  }

  /** 0..1, eased — what the HUD and camera react to. */
  get gustAmount() {
    const g = Math.min(1, this.gustEnergy);
    return g * g * (3 - 2 * g);
  }

  /**
   * @param {object} input  {bank:-1..1, pitch:-1..1, throttle:0..1}
   */
  update(dt, input, world) {
    const target = {
      bank: THREE.MathUtils.clamp(input.bank, -1, 1) * FLIGHT.maxBank,
      pitch: THREE.MathUtils.clamp(input.pitch, -1, 1) * FLIGHT.maxPitch,
      throttle: THREE.MathUtils.clamp(input.throttle, 0, 1)
    };

    if (this.crashed > 0) {
      // gentle auto-recovery: level the wings, climb back to a safe height
      this.crashed -= dt;
      target.bank = 0;
      target.pitch = 0.35;
      target.throttle = 0.6;
    }

    // control surfaces respond with lag — gives the plane weight
    this.bank     += (target.bank     - this.bank)     * Math.min(1, dt * 2.6);
    this.pitch    += (target.pitch    - this.pitch)    * Math.min(1, dt * 2.2);
    this.throttle += (target.throttle - this.throttle) * Math.min(1, dt * 1.6);

    this.gustEnergy = Math.max(0, this.gustEnergy - dt / FLIGHT.gustDuration);
    const gust = this.gustAmount;

    // airspeed: throttle sets the target, diving/climbing trades energy,
    // and a gust adds a burst on top that bleeds away on its own
    const targetSpeed = THREE.MathUtils.lerp(FLIGHT.stallSpeed, FLIGHT.maxSpeed, this.throttle)
                      + FLIGHT.gustSpeed * gust;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (gust > 0 ? 2.6 : 0.7));
    this.speed += -this.pitch * 26 * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, 9, FLIGHT.maxSpeed * 1.15 + FLIGHT.gustSpeed);

    // banking turns the aircraft; steeper bank + slower speed = tighter arc
    const turn = Math.sin(this.bank) * FLIGHT.turnRate * (FLIGHT.cruiseSpeed / Math.max(18, this.speed * 0.7));
    this.heading -= turn * dt;

    // sink when the wings aren't out (arms down = gliding, losing height)
    const lift = THREE.MathUtils.lerp(-14, 2, THREE.MathUtils.smoothstep(this.throttle, 0.05, 0.55));
    const climb = Math.sin(this.pitch) * this.speed + lift;

    this.forward.set(
      Math.sin(this.heading) * Math.cos(this.pitch),
      0,
      -Math.cos(this.heading) * Math.cos(this.pitch)
    );
    this.position.addScaledVector(this.forward, this.speed * dt);
    this.position.y += climb * dt;

    // terrain + sea + ceiling
    const ground = world ? world.heightAt(this.position.x, this.position.z) : WORLD.seaLevel;
    const floor = ground + FLIGHT.minAlt;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.crashed <= 0) this.crashed = 1.6;           // skim & recover, never a game over
    }
    if (this.position.y > FLIGHT.maxAlt) {
      this.position.y = FLIGHT.maxAlt;
      this.pitch = Math.min(this.pitch, 0);
    }

    // ── pose the mesh ──
    this.mesh.position.copy(this.position);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.rotateY(this.heading);
    this.mesh.rotateX(this.pitch);
    this.mesh.rotateZ(this.bank);

    this._propSpin += dt * (14 + this.throttle * 46 + gust * 60);
    this.mesh.userData.prop.rotation.z = this._propSpin;

    // wings flex a little under load — small thing, adds a lot of life
    this._wingFlex += ((Math.abs(this.bank) * 0.09 + this.throttle * 0.03 + gust * 0.06) - this._wingFlex) * dt * 3;
    this.mesh.userData.wing.rotation.x = this._wingFlex;

    this._updateTrails(gust);
  }

  _updateTrails(gust) {
    const strength = THREE.MathUtils.clamp(
      Math.abs(this.bank) / FLIGHT.maxBank * 1.2 + (this.throttle - 0.6) + gust * 1.4, 0, 1);
    const tip = new THREE.Vector3();
    for (const t of this.trails) {
      tip.set(t.side * 6.7, 1.55, 0).applyQuaternion(this.mesh.quaternion).add(this.position);
      t.pts[t.head * 3 + 0] = tip.x;
      t.pts[t.head * 3 + 1] = tip.y;
      t.pts[t.head * 3 + 2] = tip.z;
      t.head = (t.head + 1) % 90;
      t.filled = Math.min(90, t.filled + 1);
      // rebuild in order so the polyline doesn't jump across the ring buffer
      const ordered = t.line.geometry.attributes.position.array;
      for (let i = 0; i < t.filled; i++) {
        const src = ((t.head - t.filled + i) + 180) % 90;
        ordered[i * 3 + 0] = t.pts[src * 3 + 0];
        ordered[i * 3 + 1] = t.pts[src * 3 + 1];
        ordered[i * 3 + 2] = t.pts[src * 3 + 2];
      }
      t.line.geometry.setDrawRange(0, t.filled);
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.material.opacity = 0.06 + strength * 0.5;
    }
  }
}

/* ── chase camera ─────────────────────────────────────────────────── */
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.baseFov = camera.fov;
    this.pos = new THREE.Vector3(0, 158, 38);
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.shake = 0;
  }

  update(dt, plane) {
    const gust = plane.gustAmount;
    const back = 26 + plane.speed * 0.22;
    const up = 6.2 + plane.throttle * 2.2;

    const desired = new THREE.Vector3(0, up, back)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), plane.heading)
      .add(plane.position);
    // swing slightly wide on the outside of a turn
    desired.addScaledVector(
      new THREE.Vector3(Math.cos(plane.heading), 0, Math.sin(plane.heading)),
      plane.bank * 3.4
    );

    const k = 1 - Math.pow(0.0016, dt);       // frame-rate independent smoothing
    this.pos.lerp(desired, k);

    const ahead = 32 * (1 - Math.abs(plane.bank) * 0.42);
    const lookTarget = plane.position.clone().addScaledVector(plane.forward, ahead);
    lookTarget.y += 6.5 + plane.pitch * 18;
    this.look.lerp(lookTarget, 1 - Math.pow(0.0006, dt));

    this.camera.position.copy(this.pos);
    // roll the camera a fraction of the bank — you feel the turn without nausea
    this.up.set(Math.sin(-plane.bank * 0.34), Math.cos(plane.bank * 0.34), 0)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), plane.heading);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);

    // a gust punches the field of view out; speed adds a low rumble
    const fov = this.baseFov + gust * 11;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const s = Math.max(0, plane.speed - FLIGHT.cruiseSpeed) / FLIGHT.maxSpeed + gust * 0.5;
    if (s > 0) {
      this.shake += dt * 40;
      this.camera.position.x += Math.sin(this.shake) * s * 0.35;
      this.camera.position.y += Math.cos(this.shake * 1.7) * s * 0.28;
    }
  }
}

export { buildAircraft };
