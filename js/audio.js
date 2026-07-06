'use strict';
// Procedural sound engine for the thunderstorm — pure Web Audio, no assets.
// Everything is synthesized from one shared noise buffer: continuous beds
// (rain hiss, gusting wind, low ambient rumble) plus distance-aware thunder
// one-shots synced to the lightning scheduler. main.js pushes state in via
// update()/thunder(); no audio nodes leak out of this module.
window.StormAudio = (function () {
  let ctx = null;
  let enabled = false;
  let master, comp, bedGain;
  let noiseBuf, irBuf;
  const beds = {};   // rain, rainBody, wind: { gain, filter? } — smoothed each frame
  let masterVol = 0.7;

  function makeNoiseBuffer(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Reverb impulse response: stereo decaying noise, darkening over the tail —
  // reads as open-sky distance rather than a room.
  function makeImpulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Progressive lowpass: late reflections are duller than early ones.
        const k = 0.02 + 0.25 * (1 - t);
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, decay) * 3.0;
      }
    }
    return buf;
  }

  function loopedNoise() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    // Random start offsets would need separate buffers; instead detune each
    // loop slightly so the beds never phase-lock audibly.
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    return src;
  }

  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = masterVol;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.3;
    comp.connect(master);
    master.connect(ctx.destination);

    bedGain = ctx.createGain();
    bedGain.gain.value = 1;
    bedGain.connect(comp);

    noiseBuf = makeNoiseBuffer(3.1);
    irBuf = makeImpulse(3.5, 2.2);

    // --- Rain: bright hiss band + a lower body band in parallel.
    {
      const g = ctx.createGain(); g.gain.value = 0;
      const hiss = ctx.createBiquadFilter();
      hiss.type = 'bandpass'; hiss.frequency.value = 3200; hiss.Q.value = 0.45;
      const src = loopedNoise();
      src.connect(hiss); hiss.connect(g); g.connect(bedGain);
      src.start();
      // Slow gain shimmer so the hiss doesn't sound like a frozen loop.
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.12;
      lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start();
      beds.rain = { gain: g };

      const g2 = ctx.createGain(); g2.gain.value = 0;
      const body = ctx.createBiquadFilter();
      body.type = 'bandpass'; body.frequency.value = 900; body.Q.value = 0.6;
      const src2 = loopedNoise();
      src2.connect(body); body.connect(g2); g2.connect(bedGain);
      src2.start();
      beds.rainBody = { gain: g2 };
    }

    // --- Wind: two detuned lowpassed layers, cutoffs gusting on slow LFOs.
    {
      const g = ctx.createGain(); g.gain.value = 0;
      beds.wind = { gain: g, filters: [] };
      for (let i = 0; i < 2; i++) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 350; lp.Q.value = 0.8;
        const pan = ctx.createStereoPanner();
        pan.pan.value = i === 0 ? -0.4 : 0.4;
        const src = loopedNoise();
        src.playbackRate.value *= i === 0 ? 0.92 : 1.05;
        src.connect(lp); lp.connect(pan); pan.connect(g);
        src.start();
        // Gust LFO: modulates the cutoff so the wind swells and howls.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.05 + i * 0.023;
        const lfoG = ctx.createGain(); lfoG.gain.value = 160;
        lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
        beds.wind.filters.push(lp);
      }
      g.connect(bedGain);
    }

    // --- Ambient rumble: deep lowpassed noise, the felt presence of a storm.
    {
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 95; lp.Q.value = 1.1;
      const src = loopedNoise();
      src.connect(lp); lp.connect(g); g.connect(bedGain);
      src.start();
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
      lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start();
      beds.ambient = { gain: g };
    }
  }

  function enable() {
    enabled = true;
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      buildGraph();
    }
    if (ctx.state !== 'running') ctx.resume();
  }
  function disable() {
    enabled = false;
    if (ctx && ctx.state === 'running') ctx.suspend();
  }

  function setMaster(v) {
    masterVol = v;
    if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  }

  // Per-frame bed levels; values are 0..~1 and smoothed here.
  function update(levels) {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const set = (bed, v, tc) => bed.gain.gain.setTargetAtTime(v, t, tc || 0.35);
    set(beds.rain, levels.rain * 0.17);
    set(beds.rainBody, levels.rain * 0.10);
    set(beds.wind, 0.05 + levels.wind * 0.30);
    set(beds.ambient, levels.ambient * 0.40);
    // Wind pitch/brightness rises with strength on top of the gust LFOs.
    for (const lp of beds.wind.filters) {
      lp.frequency.setTargetAtTime(220 + levels.wind * 480, t, 0.8);
    }
  }

  // Distance-aware thunder. distance in km, energy ~0.5..2, pan -1..1.
  // Delay is a compressed function of distance (~0.2–3 s), not the physical
  // ~3 s/km — a 14 km storm shouldn't answer a flash 40 s later.
  function thunder(opts) {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    const dist = Math.min(Math.max(opts.distance, 0.3), 30);
    const near = Math.exp(-dist / 9);            // 1 close … ~0.2 far
    const energy = Math.min(Math.max(opts.energy || 1, 0.3), 2.5);
    const delay = 0.2 + 2.8 * (1 - Math.exp(-dist / 12)) * (0.9 + Math.random() * 0.2);
    const t0 = ctx.currentTime + delay / Math.max(opts.speed || 1, 0.5);

    const out = ctx.createGain();
    out.gain.value = 1;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.min(Math.max(opts.pan || 0, -1), 1) * (0.35 + 0.4 * near);
    out.connect(pan);

    // Dry/wet split: far thunder is nearly all reverberant wash.
    const dry = ctx.createGain(); dry.gain.value = 0.40 + 0.60 * near;
    const wet = ctx.createGain(); wet.gain.value = 0.35 + 0.55 * (1 - near);
    const conv = ctx.createConvolver(); conv.buffer = irBuf;
    pan.connect(dry); dry.connect(comp);
    pan.connect(conv); conv.connect(wet); wet.connect(comp);

    const nodes = [out, pan, dry, wet, conv];

    // Generic rumble body: looping noise through a falling lowpass, with a
    // first peak followed by randomized sub-lobes. All three thunder
    // characters are parameterizations of this.
    const mkRumble = (p) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      src.playbackRate.value = p.rate * (0.9 + Math.random() * 0.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(p.f0, t0);
      lp.frequency.exponentialRampToValueAtTime(p.f1, t0 + p.dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      let tt = t0 + p.lead;
      g.gain.linearRampToValueAtTime(p.amp, tt + p.att);
      tt += p.att;
      for (let i = 0; i < p.lobes; i++) {
        tt += (p.dur / (p.lobes + 1)) * (0.7 + Math.random() * 0.6);
        g.gain.linearRampToValueAtTime(p.amp * (0.25 + Math.random() * 0.2), tt);
        const peak = p.amp * (0.4 + Math.random() * 0.5);
        tt += 0.12 + Math.random() * 0.25;
        g.gain.linearRampToValueAtTime(peak, tt);
      }
      g.gain.exponentialRampToValueAtTime(0.001, t0 + p.dur + 0.6);
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t0, Math.random() * 2);
      src.stop(t0 + p.dur + 0.8);
      nodes.push(src, lp, g);
      return src;
    };

    // Pick a thunder character: close/CG strikes favor the cannon boom,
    // far ones the long horizon roll, with the tumbling roll as the default.
    // Every parameter is randomized in a range so no two claps match.
    const roll = Math.random();
    let kind = 'roll';
    if (roll < near * (opts.isCG ? 0.65 : 0.30)) kind = 'boom';
    else if (roll > 1 - (1 - near) * 0.45) kind = 'longroll';

    let main;
    if (kind === 'boom') {
      // Cannon boom: one huge fast peak, quick decay, plus a sub-bass drop.
      main = mkRumble({
        dur: 1.2 + Math.random() * 0.7, rate: 0.55,
        f0: 150 + 160 * near, f1: 50,
        amp: (0.9 + 0.5 * near) * energy, att: 0.04 + Math.random() * 0.03,
        lead: 0, lobes: Math.random() < 0.5 ? 1 : 0,
      });
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(55 + Math.random() * 14, t0);
      o.frequency.exponentialRampToValueAtTime(34, t0 + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.6 * energy * near, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 0.6);
      nodes.push(o, g);
    } else if (kind === 'longroll') {
      // Long horizon roll: dull, slow, many soft lobes.
      main = mkRumble({
        dur: 3.8 + Math.random() * 2.4, rate: 0.5,
        f0: 110 + 60 * near, f1: 38,
        amp: (0.4 + 0.35 * near) * energy, att: 0.3 + Math.random() * 0.25,
        lead: 0.1 + Math.random() * 0.2, lobes: 4 + Math.floor(Math.random() * 3),
      });
    } else {
      // Tumbling roll: the classic mid-distance multi-lobe rumble.
      main = mkRumble({
        dur: 1.6 + 2.0 * (1 - near) + Math.random() * 1.2, rate: 0.6,
        f0: 90 + 340 * near, f1: 45,
        amp: (0.5 + 0.5 * near) * energy, att: 0.09 + Math.random() * 0.15,
        lead: 0.02 + (1 - near) * 0.15, lobes: 2 + Math.floor(Math.random() * 3),
      });
    }
    // Teardown once the reverb tail is done too.
    main.onended = () => {
      setTimeout(() => nodes.forEach(n => { try { n.disconnect(); } catch (e) {} }),
                 4000);
    };
  }

  return {
    enable, disable, setMaster, update, thunder,
    suspendForHidden() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resumeIfEnabled() { if (enabled && ctx && ctx.state !== 'running') ctx.resume(); },
    get state() { return ctx ? ctx.state : 'off'; },
    get enabled() { return enabled; },
  };
})();
