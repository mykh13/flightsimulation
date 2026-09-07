# Wind Valley

> Companion game: **[Snow Run](snow/README.md)** — a downhill run steered by
> leaning your torso.

A Ghibli-flavoured flight simulator you fly with your body. A webcam feeds
MediaPipe's pose landmarker; your arms are the wings. One pilot, or two
racing side by side on a split screen.

## Play

**In your browser, nothing to install:**

| | |
| --- | --- |
| 風 Wind Valley | <https://mykh13.github.io/flightsimulation/> |
| 雪 Snow Run | <https://mykh13.github.io/flightsimulation/snow/> |

**Or locally:**

```bash
./startup.sh
```

Serves both games and opens a browser. `./startup.sh 8080` for a different
port, `--no-open` to skip the browser.

> Double-clicking `index.html` will not work. A `file://` page cannot load ES
> modules, and `getUserMedia` requires a *secure context* — https or
> localhost. That is why a local server is needed, and why the hosted copy is
> served over https.

Pick **1 pilot** or **2 pilots**, then press **Enable camera & take off**.
Stand back far enough that both arms fit in frame. Nothing is uploaded — the
pose model runs in the browser via WebAssembly.

There's a keyboard fallback if you'd rather fly without a camera, or if the
camera permission is refused. It supports two players too.

## Controls

| Gesture | Effect |
| --- | --- |
| Spread your arms wide | Wings out — throttle up. Wider = more speed. |
| Tuck your arms in | Wings folded — the plane sinks into a slow glide. |
| Drop one arm, raise the other | Banks that way and carves a turn. |
| Both arms above the shoulders | Nose up, climb. |
| Both arms below the shoulders | Nose down, dive. |
| **Flap twice, quickly** | A gust hurls you forward, then bleeds away. |

Every measurement is divided by your shoulder width, so it works the same
whether you're two feet or ten feet from the camera.

Fly through the golden rings — in two-player, whoever reaches a ring first
takes it, and it keeps their colour. You can't crash: clipping the sea or a
hillside puts the plane into a short auto-recovery climb.

Keyboard: **P1** arrows, right-shift for power, enter for a gust.
**P2** WASD, left-shift for power, space for a gust.

## How the gestures are read

`js/pose.js` uses six landmarks: both shoulders, both wrists, and the hips
for the torso centroid.

- **throttle** — wrist-to-wrist distance ÷ shoulder width, mapped from
  `1.15` (arms tucked) to `2.95` (arms wide).
- **bank** — the height difference between the wrists ÷ shoulder width.
  Positive means your left hand is lower, which drops the left wing.
- **pitch** — mean wrist height relative to the shoulder line.
- **gust** — the same arm-height signal, watched by a hysteresis pair at
  ±0.32. Four crossings (up, down, up, down) inside 2 s is two flaps and
  fires a burst; a 2.6 s cooldown stops you chaining them.

Bank and pitch are scaled by a *steering authority* term that fades to zero
as the arms come in — with your arms at your sides there is no wing to tilt,
so tracker noise can't fly the plane. Pitch is additionally damped while a
flap is in progress, otherwise beating your wings would porpoise the
aircraft through its whole pitch range. Everything is exponentially
smoothed at a frame-rate-independent rate, and if the tracker loses you the
controls ease back to a wings-level glide rather than freezing.

## Two pilots, and who gets tracked

Each pilot owns a **slot**. The model is asked for one more pose than there
are slots, so an extra body is something the game can see and deliberately
reject rather than something that displaces a pilot.

- **Registering.** An unclaimed body that holds still for `claimHold`
  (0.9 s) takes the lowest free slot. With two slots open, bodies are
  seated left-to-right as they appear in the mirrored preview. The race
  doesn't start until every slot is filled.
- **Staying bound.** Each frame, every claimed slot grabs its nearest body
  within `matchRadius` (0.17 of the frame). Greedy nearest-first, so two
  pilots crossing over don't swap planes.
- **A third person is ignored.** They match no slot, and with no seat free
  they never accrue claim time. The registration card counts them so it's
  obvious they're being skipped.
- **Losing a pilot.** A slot missing for under `dropAfter` (1.4 s) is held —
  turning sideways shouldn't cost you your plane — and the controls ease
  toward level flight. Past that the slot is released, the plane flies
  itself, and the panel says *waiting for a pilot*.
- **Refilling.** Claim time only accrues while a seat is actually open, so a
  bystander who's been standing there doesn't drop straight into the seat
  the instant it frees. Somebody has to walk in and hold still.

## Layout

| File | What's in it |
| --- | --- |
| `js/world.js` | Sky and ocean shaders, clouds, islands, birds, rings, infinite-wrap logic |
| `js/plane.js` | The seaplane mesh and liveries, flight model, gust burst, chase camera |
| `js/pose.js` | MediaPipe setup, gesture mapping, flap detector, slot tracking, pilot overlay |
| `js/hud.js` | Per-player HUD panels, registration card, drop-out banner |
| `js/main.js` | Renderer, main loop, split-screen viewports, keyboard fallback |

Sign convention used throughout the sim: `bank > 0` is rolled **left** and
turns **left**; `pitch > 0` is nose **up**.

## If the camera won't start

The start screen reports the actual reason rather than a raw browser error,
and the button becomes **Try the camera again** so you can retry without
reloading. Both games fall back to keyboard control regardless.

| Message | What to do |
| --- | --- |
| *No camera was found* | Check one is connected and enabled, and that no privacy shutter covers it. The message reports what the browser lists — but note it only claims *"no video inputs at all"* when the browser is actually being candid. Device lists are masked until camera permission has been granted once, so an empty list on its own proves nothing. |
| *The camera is busy* | Close whatever else has it: a video call, Photo Booth, OBS. |
| *Permission was denied* | Allow it for the site, then reload. On macOS also check System Settings › Privacy & Security › Camera. |
| *Only works on https or localhost* | `getUserMedia` needs a secure context. Use the hosted copy or `./startup.sh`. |

`js/camera.js` also retries with progressively looser constraints — some
virtual cameras and capture cards reject `facingMode` outright — before
giving up. A permission denial is never retried, since relaxing constraints
cannot fix it.

## Notes

- Hills are built from `CylinderGeometry` with a small top radius, **not**
  `ConeGeometry`. Three's cone emits only one triangle per grid cell once
  `heightSegments` exceeds 1, so its shell is a lattice of disconnected
  triangles — an audit showed ~1170 boundary edges against 88 shared ones.
  Half of every quad is missing, which renders as alternating holes across
  the slope. The cylinder is watertight (3552 shared edges, 24 boundary),
  and its tiny flat summit rounds the peak off nicely anyway.
- Terrain colour follows the **slope** of each facet, not its height.
  Height alone gives concentric bands, which read as a flat green disc;
  slope puts bare rock on the cliffs and grass on the shoulders, which is
  what makes the landform legible. Geometry is non-indexed, so
  `computeVertexNormals` has already given each triangle's three vertices
  the same face normal and the paint is genuinely per-facet.
- Each island and cloud is merged into one or two meshes with baked vertex
  colours. That matters because split-screen renders the whole scene twice
  per frame; unmerged, a single island would have cost sixty draw calls.
- The world is a fixed set of props that wrap around a moving centre — the
  aircraft, or the midpoint between both — inside a 6.4 km square, so you
  can fly forever without running out of scenery.
- Three.js and MediaPipe load from jsDelivr, and the pose model from
  Google's model host, so the first load needs a network connection.
- `window.__wind` exposes `players`, `world`, `fps` and `pose` for tuning
  from the console. Tracking and gesture constants live in `CALIB` at the
  top of `js/pose.js`.
