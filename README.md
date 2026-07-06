# Thunderstorm

Real-time volumetric cumulonimbus thunderstorm simulation — a distant storm seen
from ground level, with evolving clouds, intracloud flashes that light the cloud
interior, and branched cloud-to-ground lightning bolts. Pure JavaScript + WebGL2,
no dependencies. Look is tuned against the photos in `reference/`.

## Run

Any static file server works:

```
npx -y http-server -p 8172 -c-1 .
```

then open http://localhost:8172. (Or use the Claude Code preview: server name
`thunderstorm` in `.claude/launch.json`.)

## Controls

- **Free camera** — drag to look, scroll to zoom, WASD to fly, Space/C for
  up/down, Shift to sprint. You can fly into and through the storm.
- **Lock on storm** (Camera panel) — the view stays aimed at the main updraft;
  dragging orbits around the storm, and flying keeps it centered. "Reset
  camera" returns to the ground-level view.
- **Simulation** — speed (0 pauses), wind, storm motion (the storm travels a
  gently meandering track roughly downwind, ~43 km/h at 1×; 0 parks it), seed +
  🎲 New storm (regenerates the cell layout and noise field, re-aims the
  camera). Rain core, wall cloud, lightning and the camera lock all follow the
  moving storm — lock mode is a storm chase.
- **⚡ Randomize everything** — rerolls all colors, storm structure, sky layers,
  sun position and weather settings (leaves speed and render settings alone).
- **Clouds** — storm size (0.5×–2×, scales the whole cell live; height scales
  more gently and caps at the tropopause), density, coverage, and a mid-level
  scattered cumulus field that drifts between the viewer and the storm.
- **Lightning** — strike frequency, intensity, duration (average flash length;
  each event still rolls its own — quick pops through long multi-restrike
  flickers), bolt color, cloud-flash color.
- **Atmosphere** — ambient (sky/atmospheric) light color, sun color, sun
  azimuth and height (azimuth 0° puts the sun behind the storm for a backlit
  silhouette; negative height sinks it below the horizon for full night),
  background cloud bank and cirrus amounts, exposure. "Moving sun" animates a
  full day/night arc (peaking at the Sun-height value, dipping below the
  horizon on the far side) — one cycle ≈ 10 minutes at 1× speed, scaled by the
  speed slider.
- **Render** — quality (raymarch step counts) and resolution scale.

URL overrides: `?quality=minimal|low|medium|high|ultra&scale=0.5` (used for
weak/software GPUs, which are also auto-detected).

## How it works

- `js/shaders.js` — a single fragment-shader raymarcher (units are km). The
  storm follows supercell anatomy (see the photos in `reference/`): one
  dominant rotating updraft — a supercell is a single cell, so only tower 0
  ever reaches the tropopause — wearing helical mesocyclone striations, topped
  by a wide disc anvil (flat base, undulating rim, drifting and elongating
  downwind with a short back-sheared edge) and an overshooting-top dome. A low
  staircase of flanking-line cumulus hugs the updraft upwind, a dark
  wall-cloud lowering hangs on the rear flank, and the precipitation core is
  displaced onto the forward flank (kept in the storm's own shadow, sun and
  sky ambient both). Cells are analytic profiles blended with
  smooth-max, eroded by domain-warped fBm noise that advects with wind and
  morphs over time; ~30% of intracloud flashes are anvil crawlers placed in
  the sheared anvil layer. Lighting = sun with a short shadow
  march (Beer–Lambert + multi-scatter floor), sky ambient, up to 3 lightning
  point lights with their own shadow taps, plus a scene-wide flicker term.
  Bolts are rendered analytically as ray-to-segment glow, occluded by the
  cloud transmittance at the bolt's depth and by the horizon treeline.
- `js/main.js` — WebGL setup, seeded storm generation (mulberry32), slow
  convective growth cycles per cell, and the lightning scheduler: Poisson-ish
  strike timing, 65% intracloud / 35% cloud-to-ground, multi-restrike flicker
  envelopes, and midpoint-displacement bolt geometry with branches (≤48
  segments uploaded as uniforms).

Debug hook: `window.__ts` exposes `params`, `camera`, `lightning`
(`lightning.force = 'cg' | 'ic'; lightning.next = 0` forces a strike),
`renderOnce()`, and `reseed(n)`.
