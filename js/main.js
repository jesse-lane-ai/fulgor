'use strict';
(function () {
  const CLOUD_BASE = 0.85;
  const MAX_SEGS = 48;

  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) {
    document.getElementById('nogl').style.display = 'grid';
    document.getElementById('panel').style.display = 'none';
    return;
  }

  // ---------- GL setup ----------
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:\n' + gl.getShaderInfoLog(s));
      throw new Error('shader compile failed');
    }
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:\n' + gl.getProgramInfoLog(prog));
    throw new Error('program link failed');
  }
  gl.useProgram(prog);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ['uResolution', 'uTime', 'uLook', 'uFovTan', 'uCamPos', 'uSeedOffset', 'uWindSpeed',
   'uNumTowers', 'uBoundsMin', 'uBoundsMax', 'uRain', 'uShear', 'uWall', 'uDecay',
   'uDensityMul', 'uCoverage',
   'uSteps', 'uLightSteps', 'uExposure', 'uHighDetail', 'uFlashAmb', 'uAmbColor',
   'uSunColor', 'uSunDir', 'uBgClouds', 'uCirrus', 'uMidClouds',
   'uBoltCount', 'uBoltColor', 'uBoltIntensity',
   'uSkyZenith', 'uSkyHorizon', 'uSunTint', 'uHazeCol', 'uHazeAmt',
   'uMoonDir', 'uMoonColor', 'uMoonPhase', 'uMoonLightDir', 'uMoonlight'
  ].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
  U.uTowers = gl.getUniformLocation(prog, 'uTowers[0]');
  U.uFlashPos = gl.getUniformLocation(prog, 'uFlashPos[0]');
  U.uFlashColor = gl.getUniformLocation(prog, 'uFlashColor[0]');
  U.uBoltA = gl.getUniformLocation(prog, 'uBoltA[0]');
  U.uBoltB = gl.getUniformLocation(prog, 'uBoltB[0]');

  // ---------- Parameters (bound to UI) ----------
  const params = {
    speed: 1.0, wind: 1.0, motion: 1.0, seed: 1234,
    stage: 0.5, lifecycle: false,
    sound: false, volume: 0.7,
    density: 1.0, coverage: 1.0, size: 1.0,
    freq: 1.0, intensity: 1.0, duration: 1.0,
    boltColor: '#eee9ff', flashColor: '#d7c9ff',
    ambColor: '#2e3b55', sunColor: '#ff9e63',
    sunAz: 70, sunEl: 6, sunMotion: false,
    timeOfDay: 14, cycleSpeed: 1.0,
    moon: true, moonPhase: 0.5, moonColor: '#e8e6da', moonDecouple: false,
    moonAz: -110, moonEl: 30,
    bgClouds: 0.5, cirrus: 0.55, midClouds: 0.3, haze: 0.4,
    exposure: 1.1, quality: 'high', scale: 1.0,
  };
  const QUALITY = {
    minimal: { steps: 28,  lightSteps: 2, detail: 0 },
    low:     { steps: 72,  lightSteps: 3, detail: 0 },
    medium:  { steps: 112, lightSteps: 4, detail: 1 },
    high:    { steps: 160, lightSteps: 5, detail: 1 },
    ultra:   { steps: 224, lightSteps: 6, detail: 1 },
  };

  // Software renderers (SwiftShader etc.) cannot handle the full raymarcher —
  // start them at minimal settings. URL params ?quality= and ?scale= override.
  {
    const renderer = String(gl.getParameter(gl.RENDERER) || '');
    if (/swiftshader|llvmpipe|software/i.test(renderer)) {
      params.quality = 'low';
      params.scale = 0.35;
    }
    const qs = new URLSearchParams(location.search);
    if (qs.get('quality') && QUALITY[qs.get('quality')]) params.quality = qs.get('quality');
    if (qs.get('scale')) params.scale = Math.max(0.05, parseFloat(qs.get('scale')) || 1);
    const qEl = document.getElementById('quality');
    if ([...qEl.options].some(o => o.value === params.quality)) qEl.value = params.quality;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // ---------- Sky model ----------
  // Sun elevation is the single driver of the whole sky look. Keyframes below
  // go night -> twilight -> golden-hour -> day so the GLSL side (skyColor,
  // groundColor, cloud ambient/aerial-haze) only has to blend four colors
  // instead of encoding this curve itself. Elevation in degrees.
  const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

  // Each stop: { el, zenith, horizon, sunTint, haze }. zenith/horizon are the
  // sky gradient endpoints; sunTint is the Mie-halo color (can exceed 1.0 —
  // it's an HDR glow term); haze is the shared low-atmosphere/ground tone.
  const SKY_STOPS = [
    { el: -18, zenith: [0.006, 0.007, 0.012], horizon: [0.010, 0.009, 0.016], sunTint: [0.0, 0.0, 0.0],    haze: [0.008, 0.008, 0.014] },
    { el: -8,  zenith: [0.012, 0.014, 0.035], horizon: [0.10, 0.055, 0.085],  sunTint: [0.7, 0.18, 0.10],  haze: [0.07, 0.04, 0.06] },
    { el: -2,  zenith: [0.02, 0.035, 0.09],   horizon: [0.55, 0.20, 0.13],    sunTint: [2.6, 0.55, 0.16],  haze: [0.30, 0.12, 0.09] },
    { el: 2,   zenith: [0.035, 0.075, 0.20],  horizon: [0.95, 0.46, 0.20],    sunTint: [3.4, 1.15, 0.35],  haze: [0.55, 0.28, 0.15] },
    { el: 8,   zenith: [0.05, 0.13, 0.34],    horizon: [0.92, 0.62, 0.34],    sunTint: [3.0, 1.7, 0.75],   haze: [0.55, 0.38, 0.24] },
    { el: 20,  zenith: [0.06, 0.20, 0.52],    horizon: [0.62, 0.68, 0.66],    sunTint: [2.2, 1.9, 1.35],   haze: [0.42, 0.46, 0.46] },
    { el: 60,  zenith: [0.05, 0.22, 0.62],    horizon: [0.55, 0.66, 0.78],    sunTint: [1.6, 1.55, 1.35],  haze: [0.40, 0.46, 0.52] },
  ];
  function skyModel(elDeg) {
    const s = SKY_STOPS;
    if (elDeg <= s[0].el) return s[0];
    if (elDeg >= s[s.length - 1].el) return s[s.length - 1];
    let i = 0;
    while (i < s.length - 2 && elDeg > s[i + 1].el) i++;
    const a = s[i], b = s[i + 1];
    const t = (elDeg - a.el) / (b.el - a.el);
    const st = t * t * (3 - 2 * t); // smoothstep for a soft cross-fade between stops
    return {
      zenith: vlerp(a.zenith, b.zenith, st),
      horizon: vlerp(a.horizon, b.horizon, st),
      sunTint: vlerp(a.sunTint, b.sunTint, st),
      haze: vlerp(a.haze, b.haze, st),
    };
  }
  // Luminance of the "Ambient light" picker's own default (#2e3b55), used to
  // normalize it into a neutral ~1x multiplier at that default — see
  // ambientFill() in shaders.js for why this keeps old share-links looking
  // like themselves instead of double-tinting the new auto-ambient.
  const AMB_DEFAULT_LUM = (() => {
    const c = hexToRgb('#2e3b55');
    return c[0] * 0.3 + c[1] * 0.5 + c[2] * 0.2;
  })();

  // ---------- Storm generation ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const camera = { pos: [0, 0.0025, 0], yaw: 0, pitch: 0.10, fovTan: 0.55, lock: false };
  let storm = null;
  const stormOffset = [0, 0]; // accumulated travel along the storm track

  // Supercell layout (see reference/anatomy-of-supercell.jpg): a main updraft
  // whose anvil shears downwind, a flanking line of shorter towers stepping
  // upwind, a wall cloud lowering on the rear flank, and the precipitation
  // core displaced downwind onto the forward flank.
  function genStorm(seed) {
    const rand = mulberry32(seed);
    const cx = (rand() - 0.5) * 6;
    const cz = -14 - rand() * 5;
    // Wind shear direction: mostly across the view, random side.
    const sgn = rand() < 0.5 ? 1 : -1;
    let sdx = sgn, sdz = (rand() - 0.5) * 0.7;
    const sl = Math.hypot(sdx, sdz);
    sdx /= sl; sdz /= sl;
    const shear = 2.5 + rand() * 2.5;

    const towers = [];
    // One dominant updraft — a supercell is a single rotating storm, so only
    // tower 0 ever reaches the tropopause (and grows the anvil + overshoot).
    const mainR = 3.0 + rand() * 1.3;
    const mainTop = 10.5 + rand() * 2.5;
    towers.push({ x: cx, z: cz, r: mainR, top: mainTop, phase: rand() * Math.PI * 2 });
    // Flanking line: a low staircase of cumulus hugging the updraft and
    // stepping down as it trails upwind — never competing columns. Spacing
    // is a fraction of each pair's combined radius, not a fixed distance, so
    // neighboring footprints always overlap enough to merge with no gap —
    // regardless of how big or small the random radii happen to roll.
    const nFlank = 2 + Math.floor(rand() * 2);
    let fd = mainR * (0.45 + rand() * 0.12);
    let prevR = mainR;
    for (let i = 0; i < nFlank; i++) {
      const r = Math.max(1.9 - i * 0.35 + rand() * 0.25, 0.8);
      fd += (prevR + r) * (0.45 + rand() * 0.15);
      towers.push({
        x: cx - sdx * fd + (rand() - 0.5) * r * 0.3,
        z: cz - sdz * fd + (rand() - 0.5) * r * 0.35,
        r, top: CLOUD_BASE + (mainTop - CLOUD_BASE) * (0.34 - i * 0.09) + rand() * 0.6,
        phase: rand() * Math.PI * 2,
      });
      prevR = r;
    }

    // Keep the precip core tucked under the forward half of the base — pushed
    // further out it pokes past the cloud edge and glows in low sun.
    const rainDist = 0.7 + rand() * 0.6;
    // Storm track: roughly downwind, deviated like a right-moving supercell.
    const dev = (rand() - 0.5) * 0.9;
    const cd = Math.cos(dev), sdv = Math.sin(dev);
    storm = {
      towers,
      shearDir: [sdx, sdz],
      shear,
      moveDir: [sdx * cd - sdz * sdv, sdx * sdv + sdz * cd],
      meanderPhase: rand() * Math.PI * 2,
      seedOffset: [rand() * 97, rand() * 97, rand() * 97],
      rain: [cx + sdx * rainDist, cz + sdz * rainDist, mainR * 0.6, 0.7 + rand() * 0.5],
      wall: [cx - sdx * (0.8 + rand() * 0.6), cz - sdz * (0.8 + rand() * 0.6),
             1.1 + rand() * 0.6, 0.45 + rand() * 0.35],
    };
    stormOffset[0] = 0; stormOffset[1] = 0;
    // Reset the camera to ground level, aimed at the main cell.
    camera.pos = [0, 0.0025, 0];
    camera.yaw = Math.atan2(towers[0].x, -towers[0].z);
    camera.pitch = 0.10;
  }
  genStorm(params.seed);

  // The storm as rendered this frame: base layout scaled by the Size slider
  // (about the main updraft) with the convective growth cycles applied.
  const live = { towers: [], rain: [0, 0, 0, 0], wall: [0, 0, 0, 0],
                 boundsMin: [0, 0, 0], boundsMax: [0, 0, 0], shearZ: 0,
                 stageFx: { grow: 1, rain: 1, rainSize: 1, wall: 1, ltg: 1, decay: 0 } };
  const towerData = new Float32Array(32);
  const sstep = (a, b, x) => {
    x = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return x * x * (3 - 2 * x);
  };
  // Lifecycle stage factors, from the three-stage diagram in
  // reference/Stages_of_a_Thunderstorm_Diagram_Explainer.webp:
  //   ~0.0  cumulus stage — short towers, updraft only: no anvil (towers stay
  //         below the tropopause), no rain, no wall cloud, no lightning;
  //   ~0.5  mature stage — every factor at full strength (the classic look);
  //   ~1.0  dissipating stage — downdraft only: rain tapers off, the column
  //         erodes to wisps (uDecay) and the anvil remnant fades last.
  // At stage 0.5 all factors are exactly 1/0, so the default view is the
  // same mature supercell as before this control existed.
  // The rain band's own decline (and lightning's) must finish *before*
  // uDecay meaningfully erodes the cloud base — otherwise the rain outlives
  // the base that's supposed to hide it and ends up floating in open air.
  // It also shrinks in step with its strength so it visibly narrows into a
  // wisp rather than just going translucent at full size.
  function stageFactors(g) {
    const rain = sstep(0.32, 0.48, g) * (1 - sstep(0.58, 0.72, g));
    return {
      grow: 0.30 + 0.70 * sstep(0.02, 0.45, g),
      rain,
      rainSize: 0.55 + 0.45 * rain,
      wall: sstep(0.30, 0.48, g) * (1 - sstep(0.55, 0.70, g)),
      ltg:  sstep(0.26, 0.45, g) * (1 - sstep(0.55, 0.75, g)),
      decay: sstep(0.55, 1.00, g),
    };
  }
  function updateTowers(simT) {
    const s = params.size;
    const fx = stageFactors(params.stage);
    live.stageFx = fx;
    // Wider storms get only somewhat taller — tops cap at the tropopause.
    const sh = Math.min(1 + (s - 1) * 0.35, 1.35);
    const cx = storm.towers[0].x, cz = storm.towers[0].z;
    towerData.fill(0);
    live.towers.length = 0;
    let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9, mxy = 0;
    storm.towers.forEach((t, i) => {
      // Slow convective growth cycles so cells visibly build and decay.
      // The main updraft stays steadier so the anvil doesn't bob around.
      const amp = i === 0 ? 0.06 : 0.14;
      const x = cx + (t.x - cx) * s + stormOffset[0];
      const z = cz + (t.z - cz) * s + stormOffset[1];
      const r = t.r * s * (0.82 + 0.18 * fx.grow) *
                (0.94 + 0.06 * Math.sin(simT * 0.021 + t.phase * 1.7));
      const top = Math.min(CLOUD_BASE + (t.top - CLOUD_BASE) * sh * fx.grow, 13.5) *
                  (1.0 - amp + amp * Math.sin(simT * 0.03 + t.phase));
      towerData[i * 4 + 0] = x;
      towerData[i * 4 + 1] = z;
      towerData[i * 4 + 2] = r;
      towerData[i * 4 + 3] = top;
      live.towers.push({ x, z, r, top });
      // Tall towers flare into the disc anvil (~2.6× radius) — pad for it.
      const tall = Math.min(Math.max((top - CLOUD_BASE) / 10, 0), 1);
      const pad = r * (1.7 + 1.6 * tall) + 1.5;
      mnx = Math.min(mnx, x - pad); mxx = Math.max(mxx, x + pad);
      mnz = Math.min(mnz, z - pad); mxz = Math.max(mxz, z + pad);
      mxy = Math.max(mxy, top);
    });
    live.shearZ = storm.shear * Math.sqrt(s);
    // Room for the downwind anvil drift + elongation and the overshooting top.
    const reach = live.shearZ * 2.6;
    const [sdx, sdz] = storm.shearDir;
    if (sdx > 0) mxx += sdx * reach; else mnx += sdx * reach;
    if (sdz > 0) mxz += sdz * reach; else mnz += sdz * reach;
    live.boundsMin = [mnx, 0.0, mnz];
    live.boundsMax = [mxx, mxy + 1.3, mxz];
    live.rain = [cx + (storm.rain[0] - cx) * s + stormOffset[0],
                 cz + (storm.rain[1] - cz) * s + stormOffset[1],
                 storm.rain[2] * s * fx.rainSize, storm.rain[3] * fx.rain];
    live.wall = [cx + (storm.wall[0] - cx) * s + stormOffset[0],
                 cz + (storm.wall[1] - cz) * s + stormOffset[1],
                 storm.wall[2] * s, storm.wall[3] * fx.wall];
  }

  // ---------- Lightning ----------
  const boltA = new Float32Array(MAX_SEGS * 3);
  const boltB = new Float32Array(MAX_SEGS * 3);

  // Shared midpoint-displacement channel generator: recursively bisects
  // a-b, displacing the midpoint (full jitter on the x/z axes, damped
  // `yDamp`x on the y axis) until `depth` runs out. Used both for CG bolts
  // (mostly-vertical drop, yDamp=0.35 default keeps the descent trending
  // down rather than zigzagging in height) and spider-lightning arms
  // (yDamp raised so they visibly weave up/down as they travel).
  function subdivideBolt(A, B, a, b, depth, amp, yDamp = 0.35) {
    if (depth === 0 || A.length >= MAX_SEGS - 1) { A.push(a); B.push(b); return; }
    const m = [
      (a[0] + b[0]) / 2 + (Math.random() - 0.5) * amp,
      (a[1] + b[1]) / 2 + (Math.random() - 0.5) * amp * yDamp,
      (a[2] + b[2]) / 2 + (Math.random() - 0.5) * amp,
    ];
    subdivideBolt(A, B, a, m, depth - 1, amp * 0.5, yDamp);
    subdivideBolt(A, B, m, b, depth - 1, amp * 0.5, yDamp);
  }

  function genBolt(sx, sy, sz) {
    const A = [], B = [];
    const end = [sx + (Math.random() - 0.5) * 2.2, 0, sz + (Math.random() - 0.5) * 2.2];
    subdivideBolt(A, B, [sx, sy, sz], end, 5, 0.85);
    const mainCount = A.length;
    const nBranches = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < nBranches; k++) {
      const p = A[Math.floor(Math.random() * mainCount * 0.7)];
      if (p[1] < 0.8) continue;
      const len = p[1] * (0.25 + Math.random() * 0.3);
      const bend = [
        p[0] + (Math.random() - 0.5) * len * 1.8,
        Math.max(p[1] - len, 0.05),
        p[2] + (Math.random() - 0.5) * len * 1.8,
      ];
      subdivideBolt(A, B, p, bend, 2, len * 0.4);
    }
    for (let i = 0; i < A.length; i++) {
      boltA.set(A[i], i * 3);
      boltB.set(B[i], i * 3);
    }
    return { count: A.length, groundPt: end };
  }

  // Spider lightning: a branching channel weaving along the storm's sides
  // and base (see lightning.spawn() for the height/position sampling that
  // keeps it low). Arms fan out in every direction — not just downwind,
  // since it's meant to wrap the visible sides of the cloud, not just the
  // anvil — with a raised yDamp so they dip and rise as they travel instead
  // of staying in a flat plane, reading as weaving in and out of the cloud
  // surface. Arms are built separately, then interleaved round-robin into
  // the shared buffers so a partial reveal (see frame()) grows every arm
  // outward at once, like the real thing spreading rather than one arm
  // finishing before the next starts.
  function genSpiderBolt(ox, oy, oz) {
    const A = [], B = [];
    const nArms = 4 + Math.floor(Math.random() * 3);
    const arms = [];
    for (let k = 0; k < nArms; k++) {
      const ang = Math.random() * Math.PI * 2;
      const len = 1.3 + Math.random() * 2.6;
      const end = [
        ox + Math.cos(ang) * len,
        oy + (Math.random() - 0.5) * 1.3,
        oz + Math.sin(ang) * len,
      ];
      const armA = [], armB = [];
      subdivideBolt(armA, armB, [ox, oy, oz], end, 3 + (Math.random() < 0.5 ? 1 : 0), 0.6, 0.9);
      // A short secondary offshoot partway along, like a real spider fork.
      if (armA.length > 1 && Math.random() < 0.6) {
        const idx = Math.floor(armA.length * (0.3 + Math.random() * 0.4));
        const p = armA[idx];
        const blen = len * (0.25 + Math.random() * 0.3);
        const bang = ang + (Math.random() - 0.5) * 1.6;
        const bend = [p[0] + Math.cos(bang) * blen, p[1] + (Math.random() - 0.5) * 0.8,
                       p[2] + Math.sin(bang) * blen];
        subdivideBolt(armA, armB, p, bend, 2, 0.4, 0.9);
      }
      arms.push({ A: armA, B: armB });
    }
    let idx = 0, more = true;
    outer: while (more) {
      more = false;
      for (const arm of arms) {
        if (idx < arm.A.length) {
          if (A.length >= MAX_SEGS - 1) break outer;
          A.push(arm.A[idx]); B.push(arm.B[idx]); more = true;
        }
      }
      idx++;
    }
    for (let i = 0; i < A.length; i++) {
      boltA.set(A[i], i * 3);
      boltB.set(B[i], i * 3);
    }
    return { count: A.length };
  }

  const lightning = {
    slots: [
      { pos: [0, 3, -14], i: 0 },
      { pos: [0, 3, -14], i: 0 },
      { pos: [0, 3, -14], i: 0 },
    ],
    events: [],
    next: 1.5,       // first strike shortly after load
    bolt: null,      // { count } while a CG bolt is alive
    boltI: 0,
    flashSum: 0,

    spawn(simT) {
      const towers = live.towers.length ? live.towers : storm.towers;
      const tw = towers[Math.floor(Math.random() * towers.length)];
      const isCG = this.force ? this.force === 'cg' : (Math.random() < 0.35 && !this.bolt);
      this.force = null;
      // Each event rolls its own duration around the Duration setting:
      // quick single pops through long multi-restrike flickers.
      const durMul = params.duration * (0.4 + Math.random() * 1.2);
      const decay = 14 / durMul;
      const gapMul = Math.min(Math.max(durMul, 0.6), 2.2);
      const strikes = [];
      const nStrikes = 1 + Math.floor(Math.random() * Math.min(2 + durMul * 1.5, 5));
      let tt = 0;
      for (let k = 0; k < nStrikes; k++) {
        strikes.push({ t: tt, p: (0.5 + Math.random() * 0.7) * (isCG ? 6.5 : 4.5) });
        tt += (0.05 + Math.random() * 0.22) * gapMul;
      }
      const used = new Set();
      this.events.forEach(e => e.lights.forEach(l => used.add(l.slot)));
      const free = [0, 1, 2].filter(i => !used.has(i));
      const slotOf = i => (free.length > i ? free[i] : (i % 3));

      const ev = { t0: simT, dur: tt + 4 / decay, strikes, decay, lights: [], isBolt: false };
      if (isCG) {
        // Bias toward the camera-facing edge so the channel is visible.
        const sx = tw.x + (Math.random() - 0.5) * tw.r * 1.2;
        const sz = tw.z + tw.r * (0.35 + Math.random() * 0.5);
        const sy = CLOUD_BASE + 1.0 + Math.random() * 1.6;
        const bolt = genBolt(sx, sy, sz);
        this.bolt = bolt;
        ev.isBolt = true;
        ev.lights.push({ slot: slotOf(0), pos: [sx, sy + 0.6, sz], scale: 1.0 });
        ev.lights.push({ slot: slotOf(1), pos: [bolt.groundPt[0], 0.35, bolt.groundPt[2]], scale: 0.7 });
      } else if (Math.random() < 0.3) {
        // Spider crawler: weaves along the storm's sides and base rather
        // than the anvil top. Height is power-skewed toward the lower half
        // (hFrac's exponent means values near 0 are far more common than
        // values near the 0.55 cap) — the higher up the cloud, the steeply
        // lower the chance. Radius straddles the tower's own footprint
        // (0.75x-1.25x) so the origin sits right at the visible edge,
        // reads as weaving in and out of the cloud. Gets a real branching
        // channel when the shared channel slot is free (same
        // one-channel-at-a-time rule as CG above) — otherwise falls back
        // to the plain glow, unchanged from before.
        const ang = Math.random() * Math.PI * 2;
        const rad = tw.r * (0.75 + Math.random() * 0.5);
        const ox = tw.x + Math.cos(ang) * rad;
        const oz = tw.z + Math.sin(ang) * rad;
        const hFrac = 0.55 * Math.pow(Math.random(), 2.5);
        const oy = CLOUD_BASE + (tw.top - CLOUD_BASE) * hFrac;
        if (!this.bolt) {
          const spider = genSpiderBolt(ox, oy, oz);
          this.bolt = { ...spider, kind: 'spider', bornT: simT };
          ev.isBolt = true;
        }
        ev.lights.push({ slot: slotOf(0), pos: [ox, oy, oz], scale: 1.0 });
      } else {
        const y = CLOUD_BASE + 1.0 + Math.random() * Math.max(tw.top - CLOUD_BASE - 2.5, 1.0);
        ev.lights.push({
          slot: slotOf(0),
          pos: [tw.x + (Math.random() - 0.5) * tw.r * 1.2, y, tw.z + (Math.random() - 0.5) * tw.r * 1.2],
          scale: 1.0,
        });
      }
      this.events.push(ev);

      // Thunder: one clap per lightning event, panned and delayed by where
      // the flash is relative to the camera. Inherits the lifecycle gating
      // (no spawn in cumulus/dissipating stages → no thunder).
      if (params.sound && ev.lights.length) {
        const p = ev.lights[0].pos;
        const dx = p[0] - camera.pos[0], dz = p[2] - camera.pos[2];
        const dist = Math.hypot(dx, p[1] - camera.pos[1], dz);
        // Signed left/right of the view direction.
        const ang = Math.atan2(dx, -dz) - camera.yaw;
        let peak = 0;
        for (const st of strikes) peak = Math.max(peak, st.p);
        StormAudio.thunder({
          distance: dist,
          energy: (peak / 5) * params.intensity,
          isCG: ev.isBolt,
          pan: Math.sin(ang),
          speed: params.speed,
        });
      }
    },

    update(simT) {
      if (simT >= this.next) {
        // Lightning only fires in the mature stage — thin the strike rate by
        // the lifecycle factor (cumulus/dissipating storms go quiet).
        if (Math.random() < live.stageFx.ltg) this.spawn(simT);
        const mean = 4.0 / params.freq;
        this.next = simT + mean * (0.25 - Math.log(1 - Math.random()) * 0.85);
      }
      for (const s of this.slots) s.i = 0;
      let boltEnv = 0, flashSum = 0;
      this.events = this.events.filter(ev => {
        const t = simT - ev.t0;
        if (t > ev.dur || t < 0) {
          if (t > ev.dur && ev.isBolt) this.bolt = null;
          return t < ev.dur;
        }
        let I = 0;
        for (const r of ev.strikes) if (t >= r.t) I += r.p * Math.exp(-(t - r.t) * ev.decay);
        I *= params.intensity;
        for (const li of ev.lights) {
          const s = this.slots[li.slot];
          s.pos = li.pos;
          s.i += I * li.scale;
        }
        flashSum += I;
        if (ev.isBolt) boltEnv = Math.max(boltEnv, Math.min(I * 0.28, 1.5));
        return true;
      });
      this.boltI = boltEnv;
      this.flashSum = flashSum;
    },
  };

  // ---------- Camera controls ----------
  // Lock mode aims at the storm's main updraft; dragging orbits around it.
  // Free mode is classic fly-cam: drag to look, WASD + Space/C to move.
  function lockTarget() {
    const m = live.towers.length ? live.towers[0] : storm.towers[0];
    return [m.x, Math.min(Math.max(m.top * 0.4, 2.5), 5.5), m.z];
  }
  function orbitDrag(dx, dy) {
    const t = lockTarget();
    const off = [camera.pos[0] - t[0], camera.pos[1] - t[1], camera.pos[2] - t[2]];
    const radH = Math.hypot(off[0], off[2]);
    const r = Math.hypot(radH, off[1]);
    let ang = Math.atan2(off[0], off[2]) - dx * 0.003;
    let el = Math.min(1.2, Math.max(-0.05, Math.atan2(off[1], radH) - dy * 0.003));
    const nradH = r * Math.cos(el);
    camera.pos = [
      t[0] + Math.sin(ang) * nradH,
      Math.max(t[1] + r * Math.sin(el), 0.003),
      t[2] + Math.cos(ang) * nradH,
    ];
  }

  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // A click is a user gesture — lets a suspended AudioContext start.
    StormAudio.resumeIfEnabled();
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (camera.lock) {
      orbitDrag(dx, dy);
    } else {
      camera.yaw += dx * 0.0028;
      camera.pitch = Math.min(1.45, Math.max(-1.45, camera.pitch - dy * 0.0028));
    }
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('pointerup', e => {
    dragging = false;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camera.fovTan = Math.min(0.9, Math.max(0.22, camera.fovTan * (e.deltaY > 0 ? 1.08 : 0.925)));
  }, { passive: false });

  // Fly keys (ignored while typing in the panel).
  const keys = new Set();
  const uiFocused = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'BUTTON');
  };
  window.addEventListener('keydown', e => {
    if (uiFocused()) return;
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys.delete(e.code); });
  window.addEventListener('blur', () => keys.clear());

  function moveCamera(dt) {
    if (!keys.size) return;
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 12 : 3) * dt;
    const sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw);
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    let mx = 0, my = 0, mz = 0;
    // W/S fly along the full view direction (including pitch); A/D strafe flat.
    if (keys.has('KeyW')) { mx += sy * cp; my += sp; mz -= cy * cp; }
    if (keys.has('KeyS')) { mx -= sy * cp; my -= sp; mz += cy * cp; }
    if (keys.has('KeyA')) { mx -= cy; mz -= sy; }
    if (keys.has('KeyD')) { mx += cy; mz += sy; }
    if (keys.has('Space')) my += 1;
    if (keys.has('KeyC')) my -= 1;
    if (!mx && !my && !mz) return;
    camera.pos[0] += mx * speed;
    camera.pos[1] = Math.min(12, Math.max(0.003, camera.pos[1] + my * speed));
    camera.pos[2] += mz * speed;
  }

  // ---------- UI wiring ----------
  function bindRange(id, fmt) {
    const el = document.getElementById(id);
    const val = document.getElementById('v-' + id);
    const apply = () => {
      params[id] = parseFloat(el.value);
      if (val) val.textContent = fmt ? fmt(params[id]) : params[id].toFixed(2);
    };
    el.addEventListener('input', apply);
    apply();
  }
  bindRange('speed', v => v.toFixed(2) + '×');
  bindRange('wind');
  bindRange('motion', v => v.toFixed(2) + '×');
  const stageName = v => (v < 0.30 ? 'cumulus' : v < 0.62 ? 'mature' : 'dissipating');
  bindRange('stage', stageName);
  bindRange('volume');
  bindRange('density');
  bindRange('coverage');
  bindRange('size', v => v.toFixed(2) + '×');
  bindRange('freq');
  bindRange('intensity');
  bindRange('duration', v => v.toFixed(2) + '×');
  bindRange('exposure');
  // Format a fractional hour (0..24) as HH:MM for the time-of-day readout.
  const fmtClock = h => {
    const hh = Math.floor(h) % 24;
    const mm = Math.floor((h - Math.floor(h)) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  };
  bindRange('timeOfDay', fmtClock);
  bindRange('cycleSpeed', v => v.toFixed(2) + '×');
  bindRange('moonPhase', v => {
    const p = v;
    if (p < 0.03 || p > 0.97) return 'new';
    if (Math.abs(p - 0.5) < 0.03) return 'full';
    if (Math.abs(p - 0.25) < 0.04) return 'first ¼';
    if (Math.abs(p - 0.75) < 0.04) return 'last ¼';
    return p < 0.5 ? 'waxing' : 'waning';
  });
  bindRange('sunAz', v => v.toFixed(0) + '°');
  bindRange('sunEl', v => v.toFixed(1) + '°');
  bindRange('moonAz', v => v.toFixed(0) + '°');
  bindRange('moonEl', v => v.toFixed(1) + '°');
  bindRange('bgClouds');
  bindRange('cirrus');
  bindRange('midClouds');
  bindRange('haze');

  const sunMotionEl = document.getElementById('sunMotion');
  sunMotionEl.addEventListener('change', () => {
    params.sunMotion = sunMotionEl.checked;
    if (params.sunMotion) sunManual = false; // resume clock control of the sun
  });
  // Grabbing the sun sliders takes manual control; grabbing the time slider
  // hands it back to the clock.
  ['sunAz', 'sunEl'].forEach(id =>
    document.getElementById(id).addEventListener('input', () => { sunManual = true; }));
  document.getElementById('timeOfDay').addEventListener('input', () => { sunManual = false; });

  const moonEl = document.getElementById('moon');
  moonEl.addEventListener('change', () => { params.moon = moonEl.checked; });
  const moonDecoupleEl = document.getElementById('moonDecouple');
  moonDecoupleEl.addEventListener('change', () => { params.moonDecouple = moonDecoupleEl.checked; });

  const lifecycleEl = document.getElementById('lifecycle');
  lifecycleEl.addEventListener('change', () => { params.lifecycle = lifecycleEl.checked; });

  // Audio: the toggle is a user gesture, so the AudioContext can start here.
  const soundEl = document.getElementById('sound');
  soundEl.addEventListener('change', () => {
    params.sound = soundEl.checked;
    if (params.sound) { StormAudio.enable(); StormAudio.setMaster(params.volume); }
    else StormAudio.disable();
  });
  document.getElementById('volume').addEventListener('input', () => {
    if (params.sound) StormAudio.setMaster(params.volume);
  });

  const camLockEl = document.getElementById('camLock');
  camLockEl.addEventListener('change', () => { camera.lock = camLockEl.checked; });
  document.getElementById('camReset').addEventListener('click', () => {
    camera.pos = [0, 0.0025, 0];
    camera.yaw = Math.atan2(storm.towers[0].x, -storm.towers[0].z);
    camera.pitch = 0.10;
    camera.fovTan = 0.55;
  });

  ['boltColor', 'flashColor', 'ambColor', 'sunColor', 'moonColor'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { params[id] = el.value; });
  });

  const seedEl = document.getElementById('seed');
  function reseed(seed) {
    params.seed = seed;
    seedEl.value = seed;
    genStorm(seed);
    lightning.events.length = 0;
    lightning.bolt = null;
    lightning.next = simT + 1.0;
  }
  seedEl.addEventListener('change', () => reseed(parseInt(seedEl.value, 10) || 0));
  document.getElementById('reseed').addEventListener('click', () => {
    reseed(Math.floor(Math.random() * 1000000));
  });

  function hslToHex(h, s, l) {
    const f = n => {
      const k = (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  // Randomize every visual/weather parameter except simulation speed and
  // render settings. Colors are constrained to plausible-but-varied ranges.
  document.getElementById('randomizeAll').addEventListener('click', () => {
    const R = Math.random;
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input'));
    };
    set('density', (0.6 + R() * 1.0).toFixed(2));
    set('coverage', (0.6 + R() * 0.9).toFixed(2));
    set('size', (0.6 + R() * 1.2).toFixed(2));
    set('wind', (R() * 2.5).toFixed(2));
    set('motion', (0.3 + R() * 1.7).toFixed(2));
    set('freq', (0.3 + R() * 2.7).toFixed(2));
    set('intensity', (0.5 + R() * 1.5).toFixed(2));
    set('duration', (0.4 + R() * 1.8).toFixed(2));
    // Time of day sets the sun; clear manual-sun so the clock re-poses it.
    set('timeOfDay', (R() * 24).toFixed(2));
    sunManual = false;
    set('moonPhase', R().toFixed(2));
    // Mostly pale-ivory moons, occasionally a warm harvest / blood tint.
    set('moonColor', R() < 0.25
      ? hslToHex(R() * 40, 0.45 + R() * 0.4, 0.45 + R() * 0.15)
      : hslToHex(40 + R() * 20, 0.05 + R() * 0.12, 0.86 + R() * 0.08));
    set('bgClouds', R().toFixed(2));
    set('cirrus', R().toFixed(2));
    set('midClouds', (R() * 0.8).toFixed(2));
    set('haze', (0.15 + R() * 0.6).toFixed(2));
    set('ambColor', hslToHex(R() * 360, 0.15 + R() * 0.40, 0.16 + R() * 0.20));
    set('sunColor', hslToHex(R() * 360, 0.40 + R() * 0.50, 0.55 + R() * 0.20));
    set('flashColor', hslToHex(R() * 360, 0.15 + R() * 0.45, 0.72 + R() * 0.18));
    set('boltColor', hslToHex(R() * 360, 0.05 + R() * 0.30, 0.85 + R() * 0.10));
    reseed(Math.floor(R() * 1000000));
  });

  document.getElementById('quality').addEventListener('change', e => { params.quality = e.target.value; });
  document.getElementById('scale').addEventListener('change', e => {
    params.scale = parseFloat(e.target.value);
    resize();
  });

  // ---------- Save & share ----------
  // A storm's whole identity is the seed (which deterministically generates
  // the layout via genStorm) plus every slider/color that shapes its look
  // and behavior. Render quality/scale, sound/volume and playback speed are
  // viewer preferences, not part of the storm, so they're left out — the
  // same spirit as the existing ?quality=&scale= URL overrides above.
  const SHARE_FIELDS = [
    { id: 'size', type: 'range' }, { id: 'density', type: 'range' },
    { id: 'coverage', type: 'range' }, { id: 'wind', type: 'range' },
    { id: 'motion', type: 'range' }, { id: 'stage', type: 'range' },
    { id: 'lifecycle', type: 'check' },
    { id: 'freq', type: 'range' }, { id: 'intensity', type: 'range' },
    { id: 'duration', type: 'range' },
    { id: 'boltColor', type: 'color' }, { id: 'flashColor', type: 'color' },
    { id: 'ambColor', type: 'color' }, { id: 'sunColor', type: 'color' },
    { id: 'sunAz', type: 'range' }, { id: 'sunEl', type: 'range' },
    { id: 'sunMotion', type: 'check' },
    { id: 'timeOfDay', type: 'range' }, { id: 'cycleSpeed', type: 'range' },
    { id: 'moon', type: 'check' }, { id: 'moonPhase', type: 'range' },
    { id: 'moonColor', type: 'color' }, { id: 'moonDecouple', type: 'check' },
    { id: 'moonAz', type: 'range' }, { id: 'moonEl', type: 'range' },
    { id: 'bgClouds', type: 'range' }, { id: 'cirrus', type: 'range' },
    { id: 'midClouds', type: 'range' }, { id: 'exposure', type: 'range' },
    { id: 'haze', type: 'range' },
  ];

  document.getElementById('shareBtn').addEventListener('click', () => {
    const qs = new URLSearchParams();
    qs.set('seed', String(params.seed));
    for (const f of SHARE_FIELDS) {
      const v = params[f.id];
      qs.set(f.id, f.type === 'check' ? (v ? '1' : '0') :
                   f.type === 'color' ? v.replace('#', '') : String(v));
    }
    const url = location.origin + location.pathname + '?' + qs.toString();
    const btn = document.getElementById('shareBtn');
    const restore = btn.textContent;
    const flash = () => { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = restore; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(flash, () => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
    }
  });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * params.scale;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }
  window.addEventListener('resize', resize);
  resize();

  setTimeout(() => { document.getElementById('hint').style.opacity = '0'; }, 7000);

  // ---------- Time-of-day clock ----------
  // A single 0..24h clock is the master driver for both sun and moon
  // positions. It sweeps the sun through a full day arc (azimuth turning east
  // -> south -> west while elevation rises to noon and dips below the horizon
  // at night), and every frame it writes the resulting az/el back into the
  // manual sunAz/sunEl sliders so they always mirror the current sun and the
  // user can still grab them to nudge the sun by hand when the clock is
  // paused (the "Auto-advance" checkbox — the old #sunMotion — just runs the
  // clock forward). MAX_DAY_EL caps the noon height so the tuned SKY_STOPS
  // table (which tops out at 60°) stays in range.
  const MAX_DAY_EL = 58;
  const dirFromAzEl = (azDeg, elDeg) => {
    const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
    // Azimuth 0 = straight ahead (behind the storm), positive = to the right.
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  };
  // Sun az/el from the hour. Solar noon (12h) sits due south, high overhead
  // (az 0, el MAX_DAY_EL); sunrise (6h) is due east (az -90, el 0), sunset
  // (18h) due west (az +90, el 0); midnight is due north, deep below the
  // horizon. Azimuth turns a full 360°/day; elevation is a sinusoid crossing
  // zero at 6h/18h so twilight lands where it should.
  function sunAzEl(hour) {
    let az = (hour - 12) / 24 * 360;               // 12->0, 18->+90, 6->-90
    az = ((az + 180) % 360 + 360) % 360 - 180;     // wrap to (-180, 180]
    const el = MAX_DAY_EL * Math.sin((hour - 6) / 24 * 2 * Math.PI);
    return [az, el];
  }
  // Moon az/el. Coupled to the sun by phase: a full moon (phase 0.5) rides
  // ~12h opposite the sun (rises at sunset, high at midnight); a new moon
  // (phase 0/1) rides with the sun. The offset is 24h*(phase) hours, so the
  // moon's own arc is the sun arc evaluated at hour - offset. Decoupling lets
  // the user pin moon az/el/phase for a chosen artistic look.
  function moonAzEl() {
    if (params.moonDecouple) return [params.moonAz, params.moonEl];
    const offset = 24 * params.moonPhase;          // full moon -> 12h lag
    return sunAzEl(params.timeOfDay - offset);
  }
  const flashPosData = new Float32Array(12);
  const flashColData = new Float32Array(9);

  let simT = 0;
  // True once the user hand-drags Sun azimuth/height: the clock stops writing
  // the sun so the manual pose sticks. Cleared by touching the time slider or
  // enabling auto-advance.
  let sunManual = false;

  // Apply a shared storm from the URL, if present — replays each field's own
  // input/change event so it reuses the same listener that already syncs
  // params + the label text, instead of duplicating that logic here. Every
  // range value is clamped to its slider's own min/max so a hand-edited or
  // malformed link can't push the sim out of bounds. (Placed after `simT` is
  // declared: reseed() reads it, and calling reseed() earlier — before that
  // `let` runs — hits the temporal dead zone and throws.)
  {
    const shareQs = new URLSearchParams(location.search);
    if (shareQs.has('seed') || SHARE_FIELDS.some(f => shareQs.has(f.id))) {
      if (shareQs.has('seed')) {
        const seed = parseInt(shareQs.get('seed'), 10);
        if (Number.isFinite(seed)) reseed(Math.max(0, Math.min(999999, seed)));
      }
      for (const f of SHARE_FIELDS) {
        if (!shareQs.has(f.id)) continue;
        const el = document.getElementById(f.id);
        const raw = shareQs.get(f.id);
        if (f.type === 'check') {
          el.checked = raw === '1';
          el.dispatchEvent(new Event('change'));
        } else if (f.type === 'color') {
          if (/^[0-9a-fA-F]{6}$/.test(raw)) {
            el.value = '#' + raw;
            el.dispatchEvent(new Event('input'));
          }
        } else {
          const v = parseFloat(raw);
          if (Number.isFinite(v)) {
            const lo = parseFloat(el.min), hi = parseFloat(el.max);
            el.value = Math.min(hi, Math.max(lo, v));
            el.dispatchEvent(new Event('input'));
          }
        }
      }
    }
  }

  let last = performance.now() / 1000;
  let fpsAcc = 0, fpsN = 0, fpsLast = last;
  const fpsEl = document.getElementById('fps');

  function frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.1);
    last = now;
    simT += dt * params.speed;

    // Time-of-day clock. When auto-advance is on it winds the clock forward
    // (a full 24h cycle ≈ 10 min at 1× speed & 1× cycle speed). Either way the
    // current time drives the sun az/el and writes them back into the manual
    // sliders so they mirror the sun. The moon derives from the same clock.
    // Time-of-day clock. When auto-advance is on it winds the clock forward
    // (a full 24h cycle ≈ 10 min at 1× speed & 1× cycle speed) and the clock
    // is authoritative: it drives sun az/el and writes them back into the
    // manual sliders so they mirror the sun. When paused, the clock still
    // follows whatever hour the timeOfDay slider is set to — but the moment
    // the user grabs the manual sunAz/sunEl sliders (sunManual flag), those
    // win, so hand-posing the sun still works. The moon derives from the same
    // clock either way.
    if (params.sunMotion) {
      let h = params.timeOfDay + dt * params.speed * params.cycleSpeed * (24 / 600);
      h = ((h % 24) + 24) % 24;
      params.timeOfDay = h;
      const todEl = document.getElementById('timeOfDay');
      todEl.value = h;
      document.getElementById('v-timeOfDay').textContent = fmtClock(h);
      sunManual = false;
    }
    if (!sunManual) {
      const [az, el] = sunAzEl(params.timeOfDay);
      params.sunAz = az; params.sunEl = el;
      const azI = document.getElementById('sunAz'), elI = document.getElementById('sunEl');
      azI.value = az; document.getElementById('v-sunAz').textContent = az.toFixed(0) + '°';
      elI.value = Math.max(-10, Math.min(60, el));
      document.getElementById('v-sunEl').textContent = el.toFixed(1) + '°';
    }

    // Storm lifecycle: cumulus → mature → dissipating, then a fresh cell
    // grows where the old one died. Full cycle ≈ 7 min at 1× speed.
    if (params.lifecycle) {
      let g = params.stage + dt * params.speed / 420;
      if (g >= 1) g = 0;
      params.stage = g;
      const stEl = document.getElementById('stage');
      stEl.value = g;
      document.getElementById('v-stage').textContent =
        (g < 0.30 ? 'cumulus' : g < 0.62 ? 'mature' : 'dissipating');
    }

    // Advance the storm along its track (gently meandering downwind).
    if (params.motion > 0.001) {
      const wob = Math.sin(simT * 0.004 + storm.meanderPhase) * 0.5;
      const cw = Math.cos(wob), sw = Math.sin(wob);
      const dirX = storm.moveDir[0] * cw - storm.moveDir[1] * sw;
      const dirZ = storm.moveDir[0] * sw + storm.moveDir[1] * cw;
      const step = 0.012 * params.motion * dt * params.speed; // ~43 km/h at 1×/1×
      stormOffset[0] += dirX * step;
      stormOffset[1] += dirZ * step;
    }

    updateTowers(simT);
    lightning.update(simT);

    // Push bed levels to the sound engine: rain hiss tracks the (stage-scaled)
    // core strength and how close the camera is to it; wind tracks the slider;
    // the ambient rumble is the storm's low-end presence, fading as it decays.
    if (params.sound) {
      const drx = live.rain[0] - camera.pos[0], drz = live.rain[1] - camera.pos[2];
      const rainDist = Math.hypot(drx, drz);
      const rainProx = Math.exp(-Math.max(rainDist - live.rain[2], 0) / 10);
      const m = live.towers.length ? live.towers[0] : storm.towers[0];
      const stormDist = Math.hypot(m.x - camera.pos[0], m.z - camera.pos[2]);
      const stormProx = Math.exp(-Math.max(stormDist - m.r, 0) / 14);
      StormAudio.update({
        rain: Math.min(live.rain[3], 1.2) * rainProx,
        wind: Math.min(params.wind / 3, 1),
        ambient: (1 - live.stageFx.decay) * live.stageFx.grow * stormProx,
      });
    }

    moveCamera(dt);
    if (camera.lock) {
      const t = lockTarget();
      const dx = t[0] - camera.pos[0], dy = t[1] - camera.pos[1], dz = t[2] - camera.pos[2];
      const len = Math.max(Math.hypot(dx, dy, dz), 1e-4);
      camera.yaw = Math.atan2(dx, -dz);
      camera.pitch = Math.asin(dy / len);
    }

    // Uniform packing.
    const q = QUALITY[params.quality];
    const flashCol = hexToRgb(params.flashColor);
    const boltCol = hexToRgb(params.boltColor);
    // Ambient light picker is now an optional tint/strength override on the
    // auto-ambient (see ambientFill() in shaders.js), normalized so its own
    // default value (#2e3b55) reads as a neutral ~1x multiplier.
    const ambRaw = hexToRgb(params.ambColor);
    const ambCol = vscale(ambRaw, 1 / Math.max(AMB_DEFAULT_LUM, 1e-4));
    const sunCol = hexToRgb(params.sunColor);
    const sunEl = params.sunEl;
    const sunDir = dirFromAzEl(params.sunAz, sunEl);
    const sky = skyModel(sunEl);
    // Moon direction, phase and moonlight strength.
    const [moonAz, moonEl] = moonAzEl();
    const moonDir = dirFromAzEl(moonAz, moonEl);
    const moonCol = hexToRgb(params.moonColor);
    // Illuminated fraction of the disc: 0 at new (phase 0/1), 1 at full (0.5).
    const moonIllum = params.moon ? (1 - Math.abs(params.moonPhase - 0.5) * 2) : 0;
    // Moon-light direction for the terminator. We synthesize it straight from
    // the phase slider (rather than the true sun direction) so the disc always
    // matches the requested phase, coupled or decoupled. -moonDir is the
    // viewer-facing axis (full moon = lit from there); we tilt away from it by
    // the phase angle within the disc's horizontal plane, sign picking the
    // waxing (west limb) vs waning (east limb) lit side.
    const phaseAng = Math.PI * 2 * Math.abs(params.moonPhase - 0.5); // 0=full, π=new
    const wax = params.moonPhase < 0.5 ? 1 : -1;
    // Disc horizontal tangent (mu in the shader): cross(moonDir, up).
    let mux = moonDir[2], muz = -moonDir[0]; // cross([0,1,0]) xz components
    const mul = Math.hypot(mux, muz) || 1; mux /= mul; muz /= mul;
    const ca = Math.cos(phaseAng), sa = Math.sin(phaseAng) * wax;
    const moonLightDir = [
      -moonDir[0] * ca + mux * sa,
      -moonDir[1] * ca,
      -moonDir[2] * ca + muz * sa,
    ];
    // Moonlight lights the night: scales with illuminated fraction and moon
    // elevation, and fades out once the sun climbs (daylight washes it away).
    const moonUp = Math.max(0, Math.min(1, (moonEl + 3) / 12));
    const sunDown = 1 - Math.min(1, Math.max(0, (sunEl + 6) / 8));
    const moonlight = moonIllum * moonIllum * moonUp * sunDown;
    for (let i = 0; i < 3; i++) {
      const s = lightning.slots[i];
      flashPosData.set(s.pos, i * 4);
      flashPosData[i * 4 + 3] = s.i;
      flashColData.set(flashCol, i * 3);
    }
    const fa = Math.min(lightning.flashSum * 0.006 + lightning.boltI * 0.03, 0.10);
    const flashAmb = [flashCol[0] * fa, flashCol[1] * fa, flashCol[2] * fa];

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uResolution, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, simT);
    gl.uniform2f(U.uLook, camera.yaw, camera.pitch);
    gl.uniform1f(U.uFovTan, camera.fovTan);
    gl.uniform3fv(U.uCamPos, camera.pos);
    gl.uniform3fv(U.uSeedOffset, storm.seedOffset);
    gl.uniform1f(U.uWindSpeed, params.wind);
    gl.uniform4fv(U.uTowers, towerData);
    gl.uniform1i(U.uNumTowers, storm.towers.length);
    // Widen the march bounds to cover the mid-level cloud field when enabled.
    let bmin = live.boundsMin, bmax = live.boundsMax;
    if (params.midClouds > 0.01) {
      bmin = [Math.min(bmin[0], -15), 0, Math.min(bmin[2], -22)];
      bmax = [Math.max(bmax[0], 15), bmax[1], Math.max(bmax[2], -4)];
    }
    gl.uniform3fv(U.uBoundsMin, bmin);
    gl.uniform3fv(U.uBoundsMax, bmax);
    gl.uniform4fv(U.uRain, live.rain);
    // Shear strength breathes a little with the wind setting.
    gl.uniform4f(U.uShear, storm.shearDir[0], storm.shearDir[1],
      live.shearZ * (0.55 + 0.45 * Math.min(params.wind, 2)), 0);
    gl.uniform4fv(U.uWall, live.wall);
    gl.uniform1f(U.uDecay, live.stageFx.decay);
    gl.uniform1f(U.uDensityMul, params.density);
    gl.uniform1f(U.uCoverage, params.coverage);
    gl.uniform1i(U.uSteps, q.steps);
    gl.uniform1i(U.uLightSteps, q.lightSteps);
    gl.uniform1f(U.uExposure, params.exposure);
    gl.uniform1i(U.uHighDetail, q.detail);
    gl.uniform4fv(U.uFlashPos, flashPosData);
    gl.uniform3fv(U.uFlashColor, flashColData);
    gl.uniform3fv(U.uFlashAmb, flashAmb);
    gl.uniform3fv(U.uAmbColor, ambCol);
    gl.uniform3fv(U.uSunColor, sunCol);
    gl.uniform3fv(U.uSunDir, sunDir);
    gl.uniform3fv(U.uMoonDir, moonDir);
    gl.uniform3fv(U.uMoonColor, moonCol);
    gl.uniform1f(U.uMoonPhase, params.moon ? params.moonPhase : -1.0);
    gl.uniform3fv(U.uMoonLightDir, moonLightDir);
    gl.uniform1f(U.uMoonlight, moonlight);
    gl.uniform1f(U.uBgClouds, params.bgClouds);
    gl.uniform1f(U.uCirrus, params.cirrus);
    gl.uniform1f(U.uMidClouds, params.midClouds);
    gl.uniform3fv(U.uSkyZenith, sky.zenith);
    gl.uniform3fv(U.uSkyHorizon, sky.horizon);
    gl.uniform3fv(U.uSunTint, sky.sunTint);
    gl.uniform3fv(U.uHazeCol, sky.haze);
    gl.uniform1f(U.uHazeAmt, params.haze);
    // Spider/IC channels grow into view over ~0.22s instead of appearing
    // instantly (the "crawl" the name refers to — the round-robin segment
    // interleaving in genSpiderBolt makes a partial reveal spread outward
    // from the origin in every direction at once) and are tinted with the
    // cloud-flash color rather than the CG bolt color. CG bolts are
    // unchanged: instant full reveal, boltColor.
    const isSpider = lightning.bolt && lightning.bolt.kind === 'spider';
    const revealed = isSpider
      ? Math.max(1, Math.ceil(lightning.bolt.count *
          Math.min((simT - lightning.bolt.bornT) / 0.22, 1)))
      : (lightning.bolt ? lightning.bolt.count : 0);
    gl.uniform1i(U.uBoltCount, revealed);
    gl.uniform3fv(U.uBoltColor, isSpider ? flashCol : boltCol);
    gl.uniform1f(U.uBoltIntensity, lightning.boltI);
    if (lightning.bolt) {
      gl.uniform3fv(U.uBoltA, boltA);
      gl.uniform3fv(U.uBoltB, boltB);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    fpsAcc += 1;
    if (now - fpsLast > 0.5) {
      fpsEl.textContent = Math.round(fpsAcc / (now - fpsLast)) + ' fps · ' +
        canvas.width + '×' + canvas.height;
      fpsAcc = 0; fpsLast = now;
    }
  }

  // rAF while visible; slow setTimeout ticks while hidden so the storm keeps evolving.
  let scheduled = false;
  function loop() {
    scheduled = false;
    frame();
    scheduleNext();
  }
  function scheduleNext() {
    if (scheduled) return;
    scheduled = true;
    if (document.hidden) setTimeout(loop, 250);
    else requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', () => {
    // Keep the hidden-tab capture workflow silent.
    if (document.hidden) StormAudio.suspendForHidden();
    else StormAudio.resumeIfEnabled();
    scheduleNext();
  });
  scheduleNext();

  // Debug/automation hook.
  window.__ts = { params, camera, lightning, live, renderOnce: frame, reseed,
                  audio: StormAudio, get storm() { return storm; } };
})();
