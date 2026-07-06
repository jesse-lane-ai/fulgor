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
   'uNumTowers', 'uBoundsMin', 'uBoundsMax', 'uRain', 'uShear', 'uWall',
   'uDensityMul', 'uCoverage',
   'uSteps', 'uLightSteps', 'uExposure', 'uHighDetail', 'uFlashAmb', 'uAmbColor',
   'uSunColor', 'uSunDir', 'uBgClouds', 'uCirrus', 'uMidClouds',
   'uBoltCount', 'uBoltColor', 'uBoltIntensity'
  ].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
  U.uTowers = gl.getUniformLocation(prog, 'uTowers[0]');
  U.uFlashPos = gl.getUniformLocation(prog, 'uFlashPos[0]');
  U.uFlashColor = gl.getUniformLocation(prog, 'uFlashColor[0]');
  U.uBoltA = gl.getUniformLocation(prog, 'uBoltA[0]');
  U.uBoltB = gl.getUniformLocation(prog, 'uBoltB[0]');

  // ---------- Parameters (bound to UI) ----------
  const params = {
    speed: 1.0, wind: 1.0, motion: 1.0, seed: 1234,
    density: 1.0, coverage: 1.0, size: 1.0,
    freq: 1.0, intensity: 1.0, duration: 1.0,
    boltColor: '#eee9ff', flashColor: '#d7c9ff',
    ambColor: '#2e3b55', sunColor: '#ff9e63',
    sunAz: 70, sunEl: 6, sunMotion: false,
    bgClouds: 0.5, cirrus: 0.55, midClouds: 0.3,
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
    // stepping down as it trails upwind — never competing columns.
    const nFlank = 2 + Math.floor(rand() * 2);
    let fd = mainR * (0.5 + rand() * 0.15);
    for (let i = 0; i < nFlank; i++) {
      fd += 1.3 + rand() * 0.6;
      towers.push({
        x: cx - sdx * fd + (rand() - 0.5) * 0.6,
        z: cz - sdz * fd + (rand() - 0.5) * 0.9,
        r: Math.max(1.9 - i * 0.35 + rand() * 0.25, 0.8),
        top: CLOUD_BASE + (mainTop - CLOUD_BASE) * (0.34 - i * 0.09) + rand() * 0.6,
        phase: rand() * Math.PI * 2,
      });
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
                 boundsMin: [0, 0, 0], boundsMax: [0, 0, 0], shearZ: 0 };
  const towerData = new Float32Array(32);
  function updateTowers(simT) {
    const s = params.size;
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
      const r = t.r * s * (0.94 + 0.06 * Math.sin(simT * 0.021 + t.phase * 1.7));
      const top = Math.min(CLOUD_BASE + (t.top - CLOUD_BASE) * sh, 13.5) *
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
                 storm.rain[2] * s, storm.rain[3]];
    live.wall = [cx + (storm.wall[0] - cx) * s + stormOffset[0],
                 cz + (storm.wall[1] - cz) * s + stormOffset[1],
                 storm.wall[2] * s, storm.wall[3]];
  }

  // ---------- Lightning ----------
  const boltA = new Float32Array(MAX_SEGS * 3);
  const boltB = new Float32Array(MAX_SEGS * 3);

  function genBolt(sx, sy, sz) {
    const A = [], B = [];
    function subdivide(a, b, depth, amp) {
      if (depth === 0 || A.length >= MAX_SEGS - 1) { A.push(a); B.push(b); return; }
      const m = [
        (a[0] + b[0]) / 2 + (Math.random() - 0.5) * amp,
        (a[1] + b[1]) / 2 + (Math.random() - 0.5) * amp * 0.35,
        (a[2] + b[2]) / 2 + (Math.random() - 0.5) * amp,
      ];
      subdivide(a, m, depth - 1, amp * 0.5);
      subdivide(m, b, depth - 1, amp * 0.5);
    }
    const end = [sx + (Math.random() - 0.5) * 2.2, 0, sz + (Math.random() - 0.5) * 2.2];
    subdivide([sx, sy, sz], end, 5, 0.85);
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
      subdivide(p, bend, 2, len * 0.4);
    }
    for (let i = 0; i < A.length; i++) {
      boltA.set(A[i], i * 3);
      boltB.set(B[i], i * 3);
    }
    return { count: A.length, groundPt: end };
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
        // Anvil crawler: a flash spreading through the sheared anvil downwind.
        const m = live.towers.length ? live.towers[0] : storm.towers[0];
        const reach = 2.0 + Math.random() * 4.0;
        ev.lights.push({
          slot: slotOf(0),
          pos: [m.x + storm.shearDir[0] * reach + (Math.random() - 0.5) * 1.5,
                m.top * (0.78 + Math.random() * 0.10),
                m.z + storm.shearDir[1] * reach + (Math.random() - 0.5) * 1.5],
          scale: 1.0,
        });
      } else {
        const y = CLOUD_BASE + 1.0 + Math.random() * Math.max(tw.top - CLOUD_BASE - 2.5, 1.0);
        ev.lights.push({
          slot: slotOf(0),
          pos: [tw.x + (Math.random() - 0.5) * tw.r * 1.2, y, tw.z + (Math.random() - 0.5) * tw.r * 1.2],
          scale: 1.0,
        });
      }
      this.events.push(ev);
    },

    update(simT) {
      if (simT >= this.next) {
        this.spawn(simT);
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
    let el = Math.min(1.2, Math.max(-0.05, Math.atan2(off[1], radH) + dy * 0.003));
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
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (camera.lock) {
      orbitDrag(dx, dy);
    } else {
      camera.yaw += dx * 0.0028;
      camera.pitch = Math.min(1.45, Math.max(-1.45, camera.pitch + dy * 0.0028));
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
    let mx = 0, my = 0, mz = 0;
    if (keys.has('KeyW')) { mx += sy; mz -= cy; }
    if (keys.has('KeyS')) { mx -= sy; mz += cy; }
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
  bindRange('density');
  bindRange('coverage');
  bindRange('size', v => v.toFixed(2) + '×');
  bindRange('freq');
  bindRange('intensity');
  bindRange('duration', v => v.toFixed(2) + '×');
  bindRange('exposure');
  bindRange('sunAz', v => v.toFixed(0) + '°');
  bindRange('sunEl', v => v.toFixed(1) + '°');
  bindRange('bgClouds');
  bindRange('cirrus');
  bindRange('midClouds');

  const sunMotionEl = document.getElementById('sunMotion');
  sunMotionEl.addEventListener('change', () => { params.sunMotion = sunMotionEl.checked; });

  const camLockEl = document.getElementById('camLock');
  camLockEl.addEventListener('change', () => { camera.lock = camLockEl.checked; });
  document.getElementById('camReset').addEventListener('click', () => {
    camera.pos = [0, 0.0025, 0];
    camera.yaw = Math.atan2(storm.towers[0].x, -storm.towers[0].z);
    camera.pitch = 0.10;
    camera.fovTan = 0.55;
  });

  ['boltColor', 'flashColor', 'ambColor', 'sunColor'].forEach(id => {
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
    set('sunAz', String(Math.round(R() * 360 - 180)));
    set('sunEl', (R() * 30 - 6).toFixed(1));
    set('bgClouds', R().toFixed(2));
    set('cirrus', R().toFixed(2));
    set('midClouds', (R() * 0.8).toFixed(2));
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

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * params.scale;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }
  window.addEventListener('resize', resize);
  resize();

  setTimeout(() => { document.getElementById('hint').style.opacity = '0'; }, 7000);

  // ---------- Render loop ----------
  // When the sun is moving, azimuth sweeps continuously and elevation follows
  // a day arc that peaks (at the "Sun height" value) at azimuth 0 and dips
  // below the horizon on the far side — a full day/night cycle.
  function effectiveSunEl() {
    if (!params.sunMotion) return params.sunEl;
    const c = Math.cos(params.sunAz * Math.PI / 180);
    return Math.max(-8 + (params.sunEl + 8) * c, -12);
  }
  function sunDirVec() {
    const az = params.sunAz * Math.PI / 180;
    const el = effectiveSunEl() * Math.PI / 180;
    // Azimuth 0 = straight ahead (behind the storm), positive = to the right.
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  }
  const flashPosData = new Float32Array(12);
  const flashColData = new Float32Array(9);

  let simT = 0;
  let last = performance.now() / 1000;
  let fpsAcc = 0, fpsN = 0, fpsLast = last;
  const fpsEl = document.getElementById('fps');

  function frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.1);
    last = now;
    simT += dt * params.speed;

    if (params.sunMotion) {
      let az = params.sunAz + dt * params.speed * 0.6; // full cycle ≈ 10 min at 1×
      if (az > 180) az -= 360;
      params.sunAz = az;
      const azInput = document.getElementById('sunAz');
      azInput.value = az;
      document.getElementById('v-sunAz').textContent = az.toFixed(0) + '°';
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
    const ambCol = hexToRgb(params.ambColor);
    const sunCol = hexToRgb(params.sunColor);
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
    gl.uniform3fv(U.uSunDir, sunDirVec());
    gl.uniform1f(U.uBgClouds, params.bgClouds);
    gl.uniform1f(U.uCirrus, params.cirrus);
    gl.uniform1f(U.uMidClouds, params.midClouds);
    gl.uniform1i(U.uBoltCount, lightning.bolt ? lightning.bolt.count : 0);
    gl.uniform3fv(U.uBoltColor, boltCol);
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
  document.addEventListener('visibilitychange', scheduleNext);
  scheduleNext();

  // Debug/automation hook.
  window.__ts = { params, camera, lightning, live, renderOnce: frame, reseed,
                  get storm() { return storm; } };
})();
