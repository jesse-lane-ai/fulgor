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
    let tEnd = t0;

    // Crack: the sharp tearing snap of the channel. CG bolts always get a
    // distinct crack — distance dulls it (highpass cutoff, dry/wet mix)
    // rather than erasing it, so even a far bolt still snaps before rolling.
    const crackAmp = (opts.isCG ? 1.15 : 0.45) * (0.3 + 0.7 * near) * energy;
    if (crackAmp > 0.02) {
      const mkCrack = (at, amp, dur) => {
        const src = ctx.createBufferSource(); src.buffer = noiseBuf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 1100 + 2400 * near;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(amp, at + 0.005);
        g.gain.exponentialRampToValueAtTime(0.001, at + dur);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(at, Math.random() * 2, dur + 0.1);
        nodes.push(src, hp, g);
      };
      mkCrack(t0, crackAmp, 0.13 + 0.12 * near);
      // Ragged double-snap on ground strikes.
      if (opts.isCG) mkCrack(t0 + 0.05 + Math.random() * 0.08, crackAmp * 0.5, 0.09);
      tEnd = Math.max(tEnd, t0 + 0.5);
    }

    // Rumble: long multi-lobe low body; farther = duller, longer, softer.
    {
      const dur = 1.4 + 2.2 * (1 - near) + Math.random() * 1.2;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      src.playbackRate.value = 0.55 + Math.random() * 0.2;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(90 + 340 * near, t0);
      lp.frequency.exponentialRampToValueAtTime(45, t0 + dur);
      const g = ctx.createGain();
      const amp = (0.5 + 0.5 * near) * energy * 1.0;
      g.gain.setValueAtTime(0, t0);
      // Random sub-peaks give the rolling, tumbling character.
      const nLobes = 2 + Math.floor(Math.random() * 3);
      let tt = t0 + 0.02 + (1 - near) * 0.15;
      for (let i = 0; i < nLobes; i++) {
        const peak = amp * (i === 0 ? 1 : 0.4 + Math.random() * 0.5);
        g.gain.linearRampToValueAtTime(peak, tt + 0.09 + Math.random() * 0.15);
        tt += (dur / nLobes) * (0.7 + Math.random() * 0.6);
        g.gain.linearRampToValueAtTime(peak * 0.25, tt);
      }
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur + 0.6);
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(t0, Math.random() * 2);
      src.stop(t0 + dur + 0.8);
      nodes.push(src, lp, g);
      tEnd = Math.max(tEnd, t0 + dur + 0.8);
      // Teardown once the reverb tail is done too.
      src.onended = () => {
        setTimeout(() => nodes.forEach(n => { try { n.disconnect(); } catch (e) {} }),
                   4000);
      };
    }
  }

  return {
    enable, disable, setMaster, update, thunder,
    suspendForHidden() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resumeIfEnabled() { if (enabled && ctx && ctx.state !== 'running') ctx.resume(); },
    get state() { return ctx ? ctx.state : 'off'; },
    get enabled() { return enabled; },
  };
})();
