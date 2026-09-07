
/* ══════════════════════════════════════════════════════════════════
   Opening the camera.

   getUserMedia fails in several genuinely different ways and the browser's
   own message ("Requested device not found") is not actionable, so each is
   translated into something the player can do something about.

   The constraints are also tried in descending order of fussiness. Every
   hint below is `ideal` rather than `exact`, so in theory none of them can
   over-constrain — but virtual cameras, capture cards and some external
   webcams do reject `facingMode` outright, so a bare `{video:true}` retry
   is worth having before giving up.
   ══════════════════════════════════════════════════════════════════ */
const CONSTRAINTS = [
  { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } },
  { video: { width: { ideal: 640 }, height: { ideal: 480 } } },
  { video: true }
];

/**
 * What the browser will admit about the camera situation.
 *
 * Device lists are deliberately masked until permission is granted: an
 * empty videoinput list can mean "no camera" OR "not telling you yet".
 * `labelsVisible` is the tell — labels only populate once a camera has
 * actually been opened, so without them a count of 0 proves nothing.
 */
export async function cameraDiagnostics() {
  const out = {
    secure: !!window.isSecureContext,
    permission: 'unknown',
    videoInputs: null,
    totalDevices: null,
    labelsVisible: false
  };
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    out.totalDevices = all.length;
    out.videoInputs = all.filter(d => d.kind === 'videoinput').length;
    out.labelsVisible = all.some(d => d.label);
  } catch (e) { /* leave nulls */ }
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    out.permission = p.state;
  } catch (e) { /* Firefox/Safari lack the camera permission name */ }
  return out;
}

export async function openCamera() {
  if (!window.isSecureContext) {
    throw tagged('insecure',
      'The camera only works on https or localhost. This page is on a plain ' +
      'http:// address, so the browser blocks it.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw tagged('unsupported', 'This browser does not expose a camera API.');
  }

  let last = null;
  for (const c of CONSTRAINTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (err) {
      last = err;
      // A refusal or a busy device will not be fixed by relaxing constraints.
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
    }
  }

  const d = await cameraDiagnostics();
  const name = (last && last.name) || 'Error';

  // Only claim a device count when the browser is actually being candid.
  // Before permission is granted the list is masked, so "0 cameras" would
  // be an assertion we cannot support.
  let detail = '';
  if (d.videoInputs === null) {
    detail = '';
  } else if (d.videoInputs > 0) {
    detail = ` The browser lists ${d.videoInputs} camera${d.videoInputs === 1 ? '' : 's'}.`;
  } else if (d.labelsVisible || d.permission === 'granted') {
    detail = ' The browser lists no video input devices at all.';
  } else {
    detail = ' The browser is not listing any devices yet, which it also does' +
             ' before camera permission has ever been granted — so this does not' +
             ' by itself prove there is no camera.';
  }

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      throw tagged(name, 'Camera permission was denied. Allow it for this site, ' +
        'then reload. On macOS also check System Settings › Privacy & Security › Camera.');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      throw tagged(name, 'No camera was found.' + detail +
        ' Check one is connected and enabled, and that no privacy shutter or ' +
        'switch is covering it.');
    case 'NotReadableError':
    case 'TrackStartError':
      throw tagged(name, 'The camera is busy.' + detail +
        ' Close anything else using it — video calls, Photo Booth, OBS — and retry.');
    case 'OverconstrainedError':
      throw tagged(name, 'No camera matched what the page asked for.' + detail);
    default:
      throw tagged(name, ((last && last.message) || String(last)) + detail);
  }
}

function tagged(name, message) {
  const e = new Error(message);
  e.name = name;
  e.friendly = true;
  return e;
}
