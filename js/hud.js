import { FLIGHT } from './plane.js';
import { PLAYER_ACCENT } from './pose.js';

/* ══════════════════════════════════════════════════════════════════
   HUD panels are built in JS rather than written into the markup, so
   one-player and two-player use exactly the same code path — the only
   difference is how many panels exist and what CSS does with them.
   ══════════════════════════════════════════════════════════════════ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

function readout(label, unit) {
  const row = el('div', 'readout');
  row.appendChild(el('span', 'label', label));
  const value = el('span', 'value', '0');
  row.appendChild(value);
  if (unit) row.appendChild(el('span', 'unit', unit));
  return { row, value };
}

function gauge(label, centred) {
  const wrap = el('div', 'gauge');
  wrap.appendChild(el('div', 'gauge-label', label));
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill' + (centred ? ' center' : ''));
  bar.appendChild(fill);
  bar.appendChild(el('div', 'bar-notch'));
  wrap.appendChild(bar);
  return { wrap, fill };
}

export class Panel {
  constructor(root, index, playerCount) {
    this.index = index;
    this.accent = PLAYER_ACCENT[index % PLAYER_ACCENT.length];

    const node = el('div', 'panel');
    node.dataset.player = String(index);
    node.style.setProperty('--accent', this.accent);

    this.gustFlash = el('div', 'panel-gust');
    node.appendChild(this.gustFlash);

    // ── readouts ──
    const readouts = el('div', 'readouts');
    if (playerCount > 1) {
      const badge = el('div', 'badge', `P${index + 1}`);
      readouts.appendChild(badge);
    }
    this.alt = readout('ALT', 'm');
    this.spd = readout('SPD', 'km/h');
    this.rings = readout('RINGS');
    readouts.append(this.alt.row, this.spd.row, this.rings.row);
    node.appendChild(readouts);

    // ── instruments ──
    const instruments = el('div', 'instruments');
    this.span = gauge('WINGSPAN', false);
    this.pitch = gauge('PITCH', true);

    const hw = el('div', 'horizon-wrap');
    this.horizon = el('div', 'horizon');
    this.horizon.append(el('div', 'horizon-sky'), el('div', 'horizon-ground'), el('div', 'horizon-line'));
    hw.append(this.horizon, el('div', 'horizon-fixed'));

    instruments.append(this.span.wrap, hw, this.pitch.wrap);
    node.appendChild(instruments);

    this.status = el('div', 'panel-status');
    node.appendChild(this.status);

    root.appendChild(node);
    this.node = node;
    this._gustTimer = null;
  }

  /**
   * @param {object} plane   the Aircraft
   * @param {object} info    {span, score, status, statusClass}
   */
  update(plane, info) {
    this.alt.value.textContent = Math.round(plane.position.y);
    this.spd.value.textContent = Math.round(plane.speed * 3.6);
    this.rings.value.textContent = info.score;

    const spanPct = clamp((info.span - 1.0) / (3.0 - 1.0), 0, 1) * 100;
    this.span.fill.style.width = spanPct.toFixed(1) + '%';

    const p = clamp(plane.pitch / FLIGHT.maxPitch, -1, 1);
    this.pitch.fill.style.width = Math.abs(p) * 50 + '%';
    this.pitch.fill.style.transform = p < 0 ? 'translateX(-100%)' : 'none';

    // artificial horizon: the world rotates opposite to the aircraft, and
    // CSS rotate() is clockwise-positive
    const bankDeg = plane.bank * 180 / Math.PI;
    this.horizon.style.transform =
      `rotate(${bankDeg.toFixed(1)}deg) translateY(${(plane.pitch * 120).toFixed(1)}px)`;

    if (info.status !== this._status) {
      this._status = info.status;
      this.status.textContent = info.status || '';
      this.status.className = 'panel-status' + (info.status ? ' show' : '') +
                              (info.statusClass ? ' ' + info.statusClass : '');
    }
  }

  flashGust() {
    this.gustFlash.classList.remove('on');
    void this.gustFlash.offsetWidth;       // restart the animation
    this.gustFlash.classList.add('on');
    clearTimeout(this._gustTimer);
    this._gustTimer = setTimeout(() => this.gustFlash.classList.remove('on'), 900);
  }
}

/* ── registration overlay ─────────────────────────────────────────── */
export class Register {
  constructor(root, playerCount) {
    this.count = playerCount;
    this.node = el('div', 'register');
    this.card = el('div', 'register-card');
    this.title = el('h2', null, playerCount > 1 ? 'Registering pilots' : 'Registering pilot');
    this.sub = el('p', 'register-sub', playerCount > 1
      ? 'Both of you step into frame, side by side, and hold still for a moment.'
      : 'Step into frame so your whole wingspan is visible.');
    this.chips = el('div', 'chips');
    this.slots = [];
    for (let i = 0; i < playerCount; i++) {
      const chip = el('div', 'chip');
      chip.style.setProperty('--accent', PLAYER_ACCENT[i % PLAYER_ACCENT.length]);
      const dot = el('span', 'chip-dot');
      const label = el('span', 'chip-label', `Pilot ${i + 1}`);
      const state = el('span', 'chip-state', 'waiting');
      chip.append(dot, label, state);
      this.chips.appendChild(chip);
      this.slots.push({ chip, state });
    }
    this.note = el('p', 'register-note', '');
    this.card.append(this.title, this.sub, this.chips, this.note);
    this.node.appendChild(this.card);
    root.appendChild(this.node);
  }

  update(pose) {
    for (let i = 0; i < this.count; i++) {
      const slot = pose.slots[i];
      const ok = slot.locked;
      this.slots[i].chip.classList.toggle('ready', ok);
      this.slots[i].state.textContent = ok ? 'ready' : 'waiting';
    }
    const ignored = pose.ignored;
    this.note.textContent = ignored > 0
      ? `${ignored} other ${ignored === 1 ? 'person' : 'people'} in frame — not being tracked.`
      : '';
  }

  show() { this.node.classList.remove('gone'); }
  hide() { this.node.classList.add('gone'); }
}

/* ── transient banner, for a pilot dropping out mid-race ──────────── */
export class Banner {
  constructor(root) {
    this.node = el('div', 'banner');
    root.appendChild(this.node);
    this._text = null;
  }
  set(text, accent) {
    if (text === this._text) return;
    this._text = text;
    this.node.textContent = text || '';
    this.node.style.setProperty('--accent', accent || '#f6efdf');
    this.node.classList.toggle('show', !!text);
  }
}
