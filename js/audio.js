'use strict';
// Procedural spatial sound engine for the thunderstorm — pure Web Audio, no
// assets. Vanilla-JS port of spatial-thunder-sound-engine's AudioEngine.ts
// with its auto-strike scheduler and radar-coordinate model removed: the SIM
// owns all lightning timing and positions, and this module only reacts to
// main.js calls (update() per frame, thunder() per strike).
//
// Beds (looping pink noise): rain through a lowpass that tracks intensity,
// plus a randomized pitter-patter drop generator; wind through a resonant
// bandpass howled by two detuned gust LFOs; and a deep lowpassed ambient
// storm-presence rumble carried over from the previous sim engine.
//
// Thunder one-shots are equal-power-panned from the flash bearing: an instant
// electrostatic fizz at flash time, then — after a compressed distance delay
// scaled by playback speed — a waveshaped shattering crack, a fluttering
// "tearing canvas" peal with staggered branch micro-claps, and layered
// dual-path bass rumbles (pure sub-bass + saturated low-mid harmonics that
// stay audible on small speakers). Every scheduled timer, interval and node
// is tracked so disable()/suspendForHidden() cancel cleanly with no leaks.
window.StormAudio = (function () {
  let ctx = null;
  let enabled = false;
  let masterVol = 0.7;

  // Buses
  let master = null, comp = null, limiter = null;
  let rainGain = null, windGain = null, thunderGain = null, ambientGain = null;

  // Bed nodes touched per frame by update()
  let rainFilter = null;
  let windLfo1 = null, windLfo2 = null, windLfo1Gain = null, windLfo2Gain = null;

  // Shared procedural noise buffers
  let pinkNoiseBuffer = null, whiteNoiseBuffer = null;

  // 'equalpower' keeps the left/right + distance cues at a tiny fraction of
  // the cost of HRTF convolution (which starved the audio thread and caused
  // dropouts once a few strikes overlapped).
  const SPATIAL_MODE = 'equalpower';
  // Max thunder strikes allowed to run their heavy Layer C rumble stack at
  // once; extra overlapping strikes still get the crack + tear peal.
  const MAX_RUMBLE_VOICES = 3;
  let activeRumbleVoices = 0;
  // Last bed levels from update(); rain also drives the drop generator.
  const levels = { rain: 0, wind: 0, ambient: 0 };
  // Per-sound user mixer trims (0..~1.5), multiplied on top of the sim-driven
  // levels. Set from the Audio panel via setMix(); default 1 = unchanged.
  const THUNDER_BASE = 0.8;
  const mix = { rain: 1, wind: 1, thunder: 1, ambient: 1 };

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function running() { return enabled && ctx && ctx.state === 'running'; }

  // ---------- One-shot lifecycle tracking ----------
  // Each thunder strike / rain drop registers its nodes, drift intervals and
  // a cleanup timeout here, so hiding the tab or disabling sound tears down
  // everything scheduled — no leaked timers, no burst of stale claps later.
  const oneShots = new Set();
  let dropTimer = 0;

  function makeOneShot() {
    const entry = {
      nodes: [], intervals: [], tid: 0, onCancel: null,
      cancel() {
        if (!oneShots.has(entry)) return; // idempotent: timeout + teardown may both fire
        oneShots.delete(entry);
        clearTimeout(entry.tid);
        for (const id of entry.intervals) clearInterval(id);
        for (const n of entry.nodes) {
          if (typeof n.stop === 'function') { try { n.stop(0); } catch (e) {} }
          try { n.disconnect(); } catch (e) {}
        }
        if (entry.onCancel) { try { entry.onCancel(); } catch (e) {} }
      },
      arm(lifeMs) { entry.tid = setTimeout(() => entry.cancel(), lifeMs); },
    };
    oneShots.add(entry);
    return entry;
  }
  function cancelOneShots() {
    for (const e of Array.from(oneShots)) e.cancel();
  }

  // ---------- Procedural noise ----------
  function makeNoiseBuffers() {
    const sampleRate = ctx.sampleRate;
    const numSamples = Math.floor(sampleRate * 5.0);

    // Pink noise (Kellet refined filter) — rich organic rain/wind/rumble.
    pinkNoiseBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    const pink = pinkNoiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < numSamples; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }

    whiteNoiseBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    const wht = whiteNoiseBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) wht[i] = Math.random() * 2 - 1;
  }

  // Waveshaper curves for the crack/micro-clap/harmonic saturation. Cached:
  // only three amounts are used and each curve is a 44100-float array.
  const curveCache = new Map();
  function distortionCurve(amount) {
    let curve = curveCache.get(amount);
    if (curve) return curve;
    const n = 44100;
    curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    curveCache.set(amount, curve);
    return curve;
  }

  // Equal-power panner used by all thunder layers. Listener stays at the origin
  // facing -z; positions are in meters (an acoustic-compressed distance, see
  // thunder()). refDistance 3000 = full volume within 3 km, inverse beyond.
  function makePanner(px, py, pz, t) {
    const p = ctx.createPanner();
    p.panningModel = SPATIAL_MODE;
    p.distanceModel = 'inverse';
    p.refDistance = 3000; // full volume within 3 km, inverse rolloff beyond —
    p.rolloffFactor = 1.0; // keeps a distant storm present without muting it
    if (p.positionX && typeof p.positionX.setValueAtTime === 'function') {
      p.positionX.setValueAtTime(px, t);
      p.positionY.setValueAtTime(py, t);
      p.positionZ.setValueAtTime(pz, t);
    } else {
      p.setPosition(px, py, pz);
    }
    return p;
  }

  // ---------- Audio graph ----------
  function buildGraph() {
    // Chain: beds/thunder -> comp (soft glue) -> limiter (brickwall) ->
    // master -> destination. The soft compressor alone let close strikes sum
    // several times past full scale and hard-clip the destination (audible
    // digital distortion); the zero-knee 20:1 limiter is a true ceiling.
    master = ctx.createGain();
    master.gain.value = masterVol;
    master.connect(ctx.destination);
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    limiter.connect(master);
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.3;
    comp.connect(limiter);

    rainGain = ctx.createGain(); rainGain.gain.value = 0; rainGain.connect(comp);
    windGain = ctx.createGain(); windGain.gain.value = 0; windGain.connect(comp);
    thunderGain = ctx.createGain(); thunderGain.gain.value = THUNDER_BASE * mix.thunder; thunderGain.connect(comp);
    ambientGain = ctx.createGain(); ambientGain.gain.value = 0; ambientGain.connect(comp);

    // Rain bed: pink noise loop through a lowpass whose cutoff tracks rain
    // intensity (700 Hz soft shower … 3500 Hz torrential).
    rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'lowpass';
    rainFilter.frequency.value = 1500;
    rainFilter.connect(rainGain);
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = pinkNoiseBuffer;
    rainSrc.loop = true;
    rainSrc.connect(rainFilter);
    rainSrc.start();

    // Wind bed: pink noise through a high-Q resonant bandpass that howls;
    // two out-of-sync LFOs sweep its center frequency so the gusts rise,
    // fall and shiver non-periodically.
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.Q.value = 4.0;
    windFilter.frequency.value = 450;
    windFilter.connect(windGain);
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = pinkNoiseBuffer;
    windSrc.loop = true;
    windSrc.playbackRate.value = 1.045; // detune vs. the rain loop
    windSrc.connect(windFilter);
    windSrc.start();

    windLfo1 = ctx.createOscillator();                 // slow rising/falling gusts
    windLfo1.frequency.value = 0.04;
    windLfo1Gain = ctx.createGain();
    windLfo1Gain.gain.value = 180;
    windLfo1.connect(windLfo1Gain);
    windLfo1Gain.connect(windFilter.frequency);
    windLfo1.start();
    windLfo2 = ctx.createOscillator();                 // faster turbulent shiver
    windLfo2.frequency.value = 0.18;
    windLfo2Gain = ctx.createGain();
    windLfo2Gain.gain.value = 70;
    windLfo2.connect(windLfo2Gain);
    windLfo2Gain.connect(windFilter.frequency);
    windLfo2.start();

    // Ambient storm-presence bed carried over from the previous engine (the
    // ported one has no equivalent): deep lowpassed noise with a slow
    // breathing LFO, driven by update({ambient}).
    const ambFilter = ctx.createBiquadFilter();
    ambFilter.type = 'lowpass';
    ambFilter.frequency.value = 95;
    ambFilter.Q.value = 1.1;
    ambFilter.connect(ambientGain);
    const ambSrc = ctx.createBufferSource();
    ambSrc.buffer = pinkNoiseBuffer;
    ambSrc.loop = true;
    ambSrc.playbackRate.value = 0.86;
    ambSrc.connect(ambFilter);
    ambSrc.start();
    const ambLfo = ctx.createOscillator();
    ambLfo.frequency.value = 0.07;
    const ambLfoG = ctx.createGain();
    ambLfoG.gain.value = 0.07;
    ambLfo.connect(ambLfoG);
    ambLfoG.connect(ambientGain.gain);
    ambLfo.start();
  }

  // ---------- Rain drop generator ----------
  // Tiny high-passed white-noise ticks stereo-panned around the head. A
  // single chained timeout, gated on running() and torn down by
  // stopDrops() so a hidden tab never keeps scheduling.
  function startDrops() {
    if (dropTimer) return;
    const tick = () => {
      if (!running()) { dropTimer = 0; return; }
      const intensity = levels.rain;
      if (intensity > 0.05) {
        scheduleRainDrop(intensity);
        // Heavier rain → denser drops, but floored at 35 ms so a torrential
        // storm can't runaway-spawn drop voices.
        const base = Math.max(35, 100 - intensity * 80);
        dropTimer = setTimeout(tick, base + Math.random() * base);
      } else {
        dropTimer = setTimeout(tick, 500); // idle poll while it's dry
      }
    };
    dropTimer = setTimeout(tick, 100);
  }
  function stopDrops() {
    clearTimeout(dropTimer);
    dropTimer = 0;
  }

  function scheduleRainDrop(intensity) {
    const t = ctx.currentTime;
    const entry = makeOneShot();

    const src = ctx.createBufferSource();
    src.buffer = whiteNoiseBuffer;

    const g = ctx.createGain();
    const peak = 0.01 + (Math.random() * 0.05) * intensity;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    const decay = 0.004 + Math.random() * 0.02;
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(4000 + Math.random() * 3000, t);

    // A drop lands somewhere close by: a plain stereo pan is plenty for a
    // 20 ms tick and orders of magnitude cheaper than the per-drop HRTF
    // PannerNode this used to allocate (10-50 HRTF convolutions/sec).
    src.connect(hp); hp.connect(g);
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(Math.random() * 2 - 1, t);
      g.connect(pan); pan.connect(rainGain);
      entry.nodes.push(pan);
    } else {
      g.connect(rainGain);
    }
    src.start(t);
    src.stop(t + decay + 0.05);

    entry.nodes.push(src, hp, g);
    entry.arm((decay + 0.15) * 1000);
  }

  // ---------- Thunder ----------
  // Instant subtle electrostatic "fizz" at the moment of the visual flash,
  // before the physical sound wave arrives.
  function scheduleFlashCrack(intensity, px, py, pz) {
    const t = ctx.currentTime;
    const entry = makeOneShot();
    const panner = makePanner(px, py, pz, t);
    panner.connect(thunderGain);

    const spark = ctx.createBufferSource();
    spark.buffer = whiteNoiseBuffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.04 * intensity, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(5000 + Math.random() * 2000, t);
    bp.Q.setValueAtTime(4.0, t);

    spark.connect(bp); bp.connect(g); g.connect(panner);
    spark.start(t);
    spark.stop(t + 0.1);

    entry.nodes.push(spark, bp, g, panner);
    entry.arm(300);
  }

  // The main event: shattering crack + tearing-canvas fluttering peal with
  // staggered branch micro-claps + layered dual-path bass rumbles, all fed
  // through one equal-power panner per strike. dist is in meters.
  function scheduleThunderSynth(o) {
    const { dist, intensity, isCG, delay, px, py, pz } = o;
    const strikeTime = ctx.currentTime + delay;
    const entry = makeOneShot();
    let end = 0; // latest layer end, relative to strikeTime

    const panner = makePanner(px, py, pz, strikeTime);
    panner.connect(thunderGain);
    entry.nodes.push(panner);

    // -- LAYER A: primary shattering crack (close/medium strikes < 6 km).
    // Instantaneous high-frequency air-splitting crunch; CG strikes hit the
    // ground nearby and get the full crack, in-cloud flashes only a hint.
    if (dist < 6000) {
      const distanceFactor = Math.max(0, 1 - dist / 6000);
      const crackVolume = 0.8 * intensity * Math.pow(distanceFactor, 1.5) * (isCG ? 1.0 : 0.35);
      if (crackVolume > 0.01) {
        const src = ctx.createBufferSource();
        src.buffer = whiteNoiseBuffer;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, strikeTime);
        g.gain.linearRampToValueAtTime(crackVolume, strikeTime + 0.005);
        const crackDecay = 0.06 + intensity * 0.18;
        g.gain.exponentialRampToValueAtTime(0.0001, strikeTime + crackDecay);

        const shaper = ctx.createWaveShaper();
        shaper.curve = distortionCurve(80);
        shaper.oversample = '2x'; // was 4x — inaudible difference, half the cost

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(Math.max(450, 2500 - dist / 2.5), strikeTime);
        bp.Q.setValueAtTime(2.5, strikeTime);

        src.connect(shaper); shaper.connect(bp); bp.connect(g); g.connect(panner);
        src.start(strikeTime);
        src.stop(strikeTime + crackDecay + 0.1);
        entry.nodes.push(src, shaper, bp, g);
        end = Math.max(end, crackDecay + 0.1);
      }
    }

    // -- LAYER B: tearing canvas / fluttering crackle peal, plus staggered
    // branch-discharge micro-claps ("machine gun" pops along the channel).
    const tearVolume = 0.65 * intensity * Math.max(0, 1 - dist / 9500);
    if (tearVolume > 0.01) {
      const tearSrc = ctx.createBufferSource();
      tearSrc.buffer = whiteNoiseBuffer;
      tearSrc.loop = true;

      const tearGainNode = ctx.createGain();
      const tearDuration = 1.0 + intensity * 2.5 + dist / 2500;
      tearGainNode.gain.setValueAtTime(0, strikeTime);
      tearGainNode.gain.linearRampToValueAtTime(tearVolume, strikeTime + 0.1);
      tearGainNode.gain.exponentialRampToValueAtTime(0.0001, strikeTime + tearDuration);

      // Bandpass isolates the tearing frequencies; the sweep down over time
      // simulates acoustic propagation.
      const tearFilter = ctx.createBiquadFilter();
      tearFilter.type = 'bandpass';
      const baseTearFreq = Math.max(250, 1200 - dist / 5);
      tearFilter.frequency.setValueAtTime(baseTearFreq, strikeTime);
      tearFilter.frequency.exponentialRampToValueAtTime(baseTearFreq * 0.5, strikeTime + tearDuration);
      tearFilter.Q.setValueAtTime(2.0, strikeTime);

      // Fast triangle LFO (18-32 Hz) amplitude-modulates the tear for the
      // shivering flutter.
      const flutterLfo = ctx.createOscillator();
      flutterLfo.type = 'triangle';
      flutterLfo.frequency.setValueAtTime(18 + Math.random() * 14, strikeTime);
      const flutterDepth = ctx.createGain();
      flutterDepth.gain.setValueAtTime(0.35, strikeTime);
      const vca = ctx.createGain();
      vca.gain.setValueAtTime(0.5, strikeTime);
      flutterLfo.connect(flutterDepth);
      flutterDepth.connect(vca.gain);

      tearSrc.connect(tearFilter); tearFilter.connect(vca);
      vca.connect(tearGainNode); tearGainNode.connect(panner);
      tearSrc.start(strikeTime);
      flutterLfo.start(strikeTime);
      tearSrc.stop(strikeTime + tearDuration + 0.1);
      flutterLfo.stop(strikeTime + tearDuration + 0.1);
      entry.nodes.push(tearSrc, tearFilter, vca, tearGainNode, flutterLfo, flutterDepth);
      end = Math.max(end, tearDuration + 0.1);

      const numMicroClaps = 2 + Math.round(intensity * 2); // 2-4 (was 3-7)
      for (let j = 0; j < numMicroClaps; j++) {
        const clapStagger = j * 0.18 + (Math.random() * 0.15) * (1 + dist / 4000);
        const clapStart = strikeTime + clapStagger;

        const src = ctx.createBufferSource();
        src.buffer = whiteNoiseBuffer;

        const g = ctx.createGain();
        const microVol = tearVolume * (0.6 + Math.random() * 0.6) * (1 - (j / numMicroClaps) * 0.4);
        g.gain.setValueAtTime(0, clapStart);
        g.gain.linearRampToValueAtTime(microVol, clapStart + 0.003);
        const microDecay = 0.03 + Math.random() * 0.07;
        g.gain.exponentialRampToValueAtTime(0.0001, clapStart + microDecay);

        const shaper = ctx.createWaveShaper();
        shaper.curve = distortionCurve(45);
        shaper.oversample = '2x';

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(baseTearFreq * (0.8 + Math.random() * 0.5), clapStart);
        bp.Q.setValueAtTime(3.0, clapStart);

        src.connect(shaper); shaper.connect(bp); bp.connect(g); g.connect(panner);
        src.start(clapStart);
        src.stop(clapStart + microDecay + 0.1);
        entry.nodes.push(src, shaper, bp, g);
        end = Math.max(end, clapStagger + microDecay + 0.1);
      }
    }

    // -- LAYER C: majestic rolling bass rumble with psychoacoustic
    // harmonics. Each staggered rumble runs two parallel paths: pure
    // sub-bass (headphones/subwoofers) and gently saturated low-mids that
    // carry the weight on phone/laptop speakers.
    //
    // This is the heavy layer (looping sources + shapers for up to ~13 s),
    // so it is capped: when MAX_RUMBLE_VOICES strikes already have live
    // rumbles, an overlapping strike keeps its crack + tear peal but skips
    // the rumble stack instead of starving the audio thread.
    if (activeRumbleVoices >= MAX_RUMBLE_VOICES) {
      entry.arm((delay + end + 1.5) * 1000);
      return;
    }
    activeRumbleVoices++;
    entry.onCancel = () => { activeRumbleVoices = Math.max(0, activeRumbleVoices - 1); };

    const numRumbles = 3 + Math.round(intensity * 2); // 3-5 (was 5-10)
    const baseRumbleGain = (0.75 + intensity * 0.45) * Math.max(0.2, 1800 / (1800 + dist));
    // Normalize by voice count so the summed rumble bus stays roughly
    // constant no matter how many layers stack (the un-normalized sum used
    // to reach several times full scale and hard-clip the output).
    const rumbleNorm = 2.0 / numRumbles;

    for (let i = 0; i < numRumbles; i++) {
      const src = ctx.createBufferSource();
      src.buffer = pinkNoiseBuffer;
      src.loop = true;

      const rumbleStagger = i * 0.5 + (Math.random() * 0.45) * (1 + dist / 2500);
      const rumbleStart = strikeTime + rumbleStagger;
      const rumbleVol = baseRumbleGain * rumbleNorm * (0.45 + Math.random() * 0.55) * (1 - (i / numRumbles) * 0.45);
      const rumbleAttack = 0.15 + Math.random() * 0.55;
      const rumbleDuration = 3.0 + intensity * 6.0 + Math.random() * 4.0;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, rumbleStart);
      g.gain.linearRampToValueAtTime(rumbleVol, rumbleStart + rumbleAttack);
      g.gain.exponentialRampToValueAtTime(0.0001, rumbleStart + rumbleAttack + rumbleDuration);

      // Path 1: pure sub-bass through two cascaded lowpasses.
      const lp1 = ctx.createBiquadFilter();
      lp1.type = 'lowpass';
      const subCutoff = Math.max(75, 180 - dist / 35);
      lp1.frequency.setValueAtTime(subCutoff, rumbleStart);
      lp1.frequency.exponentialRampToValueAtTime(subCutoff * 0.6, rumbleStart + rumbleAttack + rumbleDuration);
      lp1.Q.setValueAtTime(1.5, rumbleStart);
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.setValueAtTime(subCutoff * 1.3, rumbleStart);

      // Path 2: warm saturated low-mids.
      const shaper = ctx.createWaveShaper();
      shaper.curve = distortionCurve(35);
      shaper.oversample = 'none'; // was 4x on every rumble layer — the top CPU cost
      const lpH = ctx.createBiquadFilter();
      lpH.type = 'lowpass';
      const harmonicCutoff = Math.max(160, 480 - dist / 18);
      lpH.frequency.setValueAtTime(harmonicCutoff, rumbleStart);
      lpH.frequency.exponentialRampToValueAtTime(harmonicCutoff * 0.65, rumbleStart + rumbleAttack + rumbleDuration);
      lpH.Q.setValueAtTime(1.0, rumbleStart);

      src.connect(lp1); lp1.connect(lp2); lp2.connect(g);
      src.connect(shaper); shaper.connect(lpH); lpH.connect(g);
      g.connect(panner);
      src.start(rumbleStart);
      src.stop(rumbleStart + rumbleAttack + rumbleDuration + 0.1);
      entry.nodes.push(src, lp1, lp2, shaper, lpH, g);
      end = Math.max(end, rumbleStagger + rumbleAttack + rumbleDuration + 0.1);
    }

    // Slow lateral drift, as if the echo shifts along the storm front: one
    // scheduled automation on the strike's shared panner. (Previously every
    // rumble ran its own 200 ms setInterval rewriting positionX — 5-10
    // timers per strike all fighting over the same param.)
    if (panner.positionX && typeof panner.positionX.linearRampToValueAtTime === 'function') {
      const driftSpeed = (Math.random() - 0.5) * 60; // up to ±30 m/s
      panner.positionX.linearRampToValueAtTime(px + driftSpeed * end, strikeTime + end);
    }

    entry.arm((delay + end + 1.5) * 1000);
  }

  // ---------- Public API (unchanged from the previous engine) ----------

  function enable() {
    enabled = true;
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      makeNoiseBuffers();
      buildGraph();
    }
    if (ctx.state !== 'running') {
      ctx.resume().then(() => { if (enabled) startDrops(); }).catch(() => {});
    } else {
      startDrops();
    }
  }

  function disable() {
    enabled = false;
    stopDrops();
    cancelOneShots();
    if (ctx && ctx.state === 'running') ctx.suspend();
  }

  function setMaster(v) {
    masterVol = v;
    if (master && ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  }

  // Per-sound mixer trims from the Audio panel. Rain/wind/ambient beds pick
  // up the new value on the next update() frame; thunder is a fixed bus, so
  // apply its trim immediately.
  function setMix(m) {
    if (m.rain != null) mix.rain = m.rain;
    if (m.wind != null) mix.wind = m.wind;
    if (m.thunder != null) mix.thunder = m.thunder;
    if (m.ambient != null) mix.ambient = m.ambient;
    if (thunderGain && ctx) {
      thunderGain.gain.setTargetAtTime(THUNDER_BASE * mix.thunder, ctx.currentTime, 0.05);
    }
  }

  // Per-frame bed levels from the sim (values 0..~1, smoothed here):
  // rain → rainVolume + lowpass cutoff (and drop density), wind →
  // windVolume + gust-LFO rate/depth (turbulence), ambient → presence bed.
  function update(l) {
    if (!running()) return;
    const t = ctx.currentTime;
    const rain = clamp(l.rain || 0, 0, 1);
    const wind = clamp(l.wind || 0, 0, 1);
    const amb = clamp(l.ambient || 0, 0, 1);
    levels.rain = rain; levels.wind = wind; levels.ambient = amb;

    rainGain.gain.setTargetAtTime(rain * 0.55 * mix.rain, t, 0.35);
    rainFilter.frequency.setTargetAtTime(700 + rain * 2800, t, 0.5);

    windGain.gain.setTargetAtTime((0.03 + wind * 0.45) * mix.wind, t, 0.35);
    windLfo1.frequency.setTargetAtTime(0.02 + wind * 0.08, t, 1.0);
    windLfo2.frequency.setTargetAtTime(0.10 + wind * 0.25, t, 1.0);
    windLfo1Gain.gain.setTargetAtTime(100 + wind * 250, t, 1.0);
    windLfo2Gain.gain.setTargetAtTime(40 + wind * 120, t, 1.0);

    ambientGain.gain.setTargetAtTime(amb * 0.35 * mix.ambient, t, 0.35);
  }

  // One thunder event per sim lightning strike. distance arrives in sim
  // world units (≈ km) and is converted to the engine's meter scale;
  // energy → strike intensity; isCG biases the sharp crack layer; pan is
  // the camera-relative bearing (sin of the angle); speed divides the
  // flash→clap delay so fast-forward keeps flash and clap in sync.
  function thunder(opts) {
    if (!running()) return;
    // The sim's storm sits at a genuine ~14 km. In the ported engine's native
    // scale that lands in the "distant, rumble-only" bucket — the crack needs
    // < 6 km and the tearing peal < 9.5 km, so the audible thunder vanished
    // and only a faint sub-bass rumble survived (further attenuated ~8x by the
    // panner's inverse distance model). Compress the real distance into an
    // acoustic band so a typical storm reads as an audible "medium" strike
    // (crack + tear + rumble), flying close stays punchy, and truly far still
    // dulls out. realKm still drives the flash->boom delay for the drama.
    const realKm = clamp(opts.distance || 1, 0.2, 40);
    const acKm = 0.5 + 5.0 * (1 - Math.exp(-realKm / 7)); // saturates ~5.5 km
    const dist = clamp(acKm * 1000, 200, 9000);
    const energy = clamp(opts.energy == null ? 1 : opts.energy, 0.3, 2.5);
    const intensity = clamp(0.25 + energy * 0.3, 0.1, 1.0);
    const isCG = !!opts.isCG;
    const pan = clamp(opts.pan || 0, -1, 1);
    // Physical 343 m/s would answer a 14 km flash ~35 s later; keep a
    // compressed but real-distance-driven gap so flash and boom feel linked.
    const delay = (0.2 + 2.8 * (1 - Math.exp(-realKm / 12)) * (0.9 + Math.random() * 0.2)) /
                  Math.max(opts.speed || 1, 0.5);

    // Position: pan → azimuth in front of the listener (origin, facing -z);
    // in-cloud flashes originate higher up than ground strikes.
    const az = Math.asin(pan);
    const px = Math.sin(az) * dist;
    const pz = -Math.cos(az) * dist;
    const py = (isCG ? 1000 : 1700) + intensity * 800;

    scheduleFlashCrack(intensity, px, py, pz);
    scheduleThunderSynth({ dist, intensity, isCG, delay, px, py, pz });
  }

  return {
    enable, disable, setMaster, setMix, update, thunder,
    suspendForHidden() {
      stopDrops();
      cancelOneShots();
      if (ctx && ctx.state === 'running') ctx.suspend();
    },
    resumeIfEnabled() {
      if (enabled && ctx && ctx.state !== 'running') {
        ctx.resume().then(() => { if (enabled) startDrops(); }).catch(() => {});
      }
    },
    get state() { return ctx ? ctx.state : 'off'; },
    get enabled() { return enabled; },
  };
})();
