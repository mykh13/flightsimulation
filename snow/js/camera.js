
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

export async function countCameras() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput').length;
  } catch (e) {
    return null;
  }
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

  const n = await countCameras();
  const name = (last && last.name) || 'Error';
  const detail = n === null ? '' :
    n === 0 ? ' The browser can see no video input devices at all.'
            : ` The browser can see ${n} camera${n === 1 ? '' : 's'}, but could not open one.`;

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
