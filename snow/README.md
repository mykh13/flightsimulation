# Snow Run

A downhill run you steer with your torso, rendered as a low-poly alpine
whiteout in Three.js. The webcam feeds MediaPipe's pose landmarker; leaning
your shoulders off your hips carves the board.

Sibling of [Wind Valley](../README.md), which uses the same tracking stack
with a different control mapping.

## Play

**In your browser, no setup:** <https://mykh13.github.io/flightsimulation/snow/>

**Locally:** `./startup.sh` from the repo root, then
<http://localhost:5178/snow/>. A `file://` page won't work — ES modules and
`getUserMedia` both need an http(s) origin.

Press **Enable camera & drop in**.
Stand back far enough that your shoulders *and* hips are in frame. Nothing
is uploaded — the pose model runs in the browser via WebAssembly.

Arrow keys work as a fallback if you'd rather play without a camera.

## Controls

| Gesture | Effect |
| --- | --- |
| Lean shoulders left of your hips | Carve left |
| Lean shoulders right of your hips | Carve right |
| Stand upright | Run straight |
| Both arms above your head | Restart after a wipeout |

Trees crowd both edges of the run and boulders sit in the fall line. One
hit ends the run. The hill accelerates from 26 to 52 m/s over the first
900 m, and rocks get closer together the longer you last.

Keyboard: **← →** to carve, **space** to restart.

## How the lean is read

`js/pose.js` uses six landmarks: both shoulders, both hips, both wrists.

```
lean  = (shoulderMidX − hipMidX) / shoulderWidth
roll  = (leftShoulderY − rightShoulderY) / shoulderWidth
steer = −(lean × 2.9 + roll × 1.15)
```

Both terms are divided by shoulder width, so the reading is identical at
any distance from the lens. Measuring the shoulders **against the hips**
rather than against the frame is what makes this a lean rather than a
position: walking across the room moves shoulders and hips together and
produces no steering at all. You have to actually tip your torso.

Shoulder roll is folded in as a smaller second term because dropping a
shoulder into the turn is what a rider's body does anyway, and it keeps
working when the hips leave frame — a real risk in a small room. In that
case it falls back to roll alone at a higher gain rather than dropping the
controls.

The sign: the camera image is not mirrored, so the rider's own left is at
*higher* x. Leaning left therefore raises `lean`, and the negation turns
that into a left-hand carve.

## Layout

| File | What's in it |
| --- | --- |
| `js/pose.js` | MediaPipe setup, lean → steer mapping, restart gesture, rider overlay |
| `js/game.js` | Obstacle field, steering physics, collision, scoring |
| `js/scene.js` | The Three.js scene: terrain, ranges, pines, rider, snowfall |
| `js/main.js` | State machine, loop, HUD, keyboard fallback |

## Notes

### Look

Near-monochrome on purpose. Depth comes almost entirely from **how steep a
facet is** rather than from colour — flat ground holds snow and stays white,
steep faces shed it and fall to blue-grey rock. The run itself is smooth
shaded; all the faceting lives in the mountains and the trees.

Ranges are built from **ridged** noise — `1 - |sin·cos|` rather than plain
noise — which gives sharp crest lines instead of rolling dunes. Flat shading
then turns those into cliff walls.

### Gotchas worth keeping

- **The valley profile must be capped.** `edgeProfile` is a power law in
  distance from the fall line; across a 420 m-wide ground mesh an uncapped
  one reaches thousands of units, i.e. canyon walls wrapped around the
  camera. It rises to the shoulder over ~66 m, then climbs very gently.
- **Ranges sit on the valley floor at their own distance.** The run drops
  12%, so a range 900 m out is 108 m below the rider. Placing them all at
  the rider's floor level makes them overhang the piste.
- **The rider stands ACROSS the board, but only from the hips up.** The
  feet stay near the deck's line at a binding angle; it is the hips, torso
  and head that twist down the hill. Rotating the whole body — the obvious
  shortcut — swings the boots off the board and the figure reads as a squat
  lump. It is also deliberately slim: at chase distance it is ~40 px tall,
  so silhouette is the whole job and bulk just becomes a blob.
- **Foliage is coloured per face, not per vertex.** A cone's side triangle
  has two dark base vertices and one white apex; interpolating across it
  leaves every tier half-dark, and a snow-laden pine reads as an ordinary
  green one.
- **The camera's look target needs seeding, not just its position.** A
  target still travelling in from the origin points back up the hill, so
  you spend the first second staring at where you came from. Both are
  snapped on the first frame and on every restart.
- **A crash should not delete the player.** The rider tumbles with a snow
  burst and the result card is held back ~1 s, so the wipeout is visible
  rather than instantly covered by a modal. Every tumble axis is clamped;
  an unbounded yaw leaves the rider spinning on the spot.
- **`THREE.Points` needs a texture.** Untextured, snowflakes render as hard
  squares that read as paper cut-outs at close range.

### Structure

- The ground is invariant under travel: its profile depends only on `x` and
  the grade only on `z`, so the mesh is built once and translated (with the
  grade folded into `y`) instead of being rebuilt or re-displaced.
- Trees and boulders are pooled `Object3D`s repositioned onto whatever
  `game.visible()` reports, rather than created and destroyed.
- The mountain backdrop rides with the camera, so it never needs recycling.
- Roughly 250 draw calls and 53k triangles per frame.

### Rules of play

- Collision is tested by **plane crossing**, not proximity. At 52 m/s a
  20 fps frame advances 2.6 m, nearly twice the 1.4 m collision radius, so
  a radius test alone would let obstacles tunnel straight through the rider.
- Obstacles are stored at absolute `z` down the mountain and read relative
  to `distance`, so recycling the field is just a splice off the front.
- Best distance persists in `localStorage` under `snowrun.best`, wrapped in
  try/catch for private-mode browsers.
- `window.__snow` exposes `game`, `renderer` and `tracker` for tuning.
  Gesture constants live in `CALIB` at the top of `js/pose.js`; look and
  layout constants in `LOOK` at the top of `js/scene.js`.
