// Audio — the engine worklet plus wind, tyres, gravel, scraping and one-shots.
//
// The game owns this AudioContext (created on the player's click, so Chrome's
// autoplay policy is satisfied) and close() releases everything at once — a
// closed context can't leave a drone running after you leave the game.

export async function createAudio() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.gain.value = 0.6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);

  // Shared white-noise loop for wind, tyre, gravel and scrape beds.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  {
    const d = noiseBuf.getChannelData(0);
    let s = 7;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 4294967296 * 2 - 1; }
  }
  function bed(type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(master);
    src.start();
    return { f, g };
  }
  const wind = bed('bandpass', 500, 0.6);
  const tyre = bed('bandpass', 1150, 7);
  const gravel = bed('lowpass', 520, 0.9);
  const scrape = bed('bandpass', 3200, 2.5);
  const rainBed = bed('bandpass', 900, 0.35);   // soft, low patter (was a 2.4 kHz highpass hiss)

  // Tunnels: the engine bounces off the walls — a short, dark feedback echo.
  const echoSend = ctx.createGain(), echo = ctx.createDelay(0.5), echoFb = ctx.createGain(), echoTone = ctx.createBiquadFilter();
  echoSend.gain.value = 0; echo.delayTime.value = 0.075; echoFb.gain.value = 0.42;
  echoTone.type = 'lowpass'; echoTone.frequency.value = 1600;
  echoSend.connect(echo).connect(echoTone).connect(echoFb).connect(echo);
  echoTone.connect(master);

  // Engine: the worklet. If it can't load (it always should in Chrome), stay quiet.
  let engine = null;
  const engGain = ctx.createGain();
  engGain.gain.value = 0.55;
  engGain.connect(master);
  engGain.connect(echoSend);
  try {
    await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    engine = new AudioWorkletNode(ctx, 'rs660-engine', { numberOfInputs: 0, outputChannelCount: [1] });
    engine.connect(engGain);
  } catch { engine = null; }

  const set = (param, v, tc = 0.05) => param.setTargetAtTime(v, ctx.currentTime, tc);
  let duck = 1;                    // Ride to my music: engine and wind under the player's own music

  // One-shot tone with a short envelope.
  function tone(freq, dur, type = 'sine', vol = 0.25, when = 0) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function burst(dur, freq, vol) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  return {
    get ready() { return !!engine; },
    get state() { return ctx.state; },
    // The context itself, for the music analysis (music.js), which listens on it.
    get context() { return ctx; },
    setDuck(k) { duck = k; },
    resume() { if (ctx.state === 'suspended') ctx.resume(); },
    suspend() { if (ctx.state === 'running') ctx.suspend(); },
    setVolume(v) { set(master.gain, 0.6 * v, 0.1); },
    // a: { rpm, load, cut, v, usage, surface, scrape, airborne, crashed }
    update(a) {
      if (engine) {
        engine.parameters.get('rpm').value = a.rpm;
        engine.parameters.get('load').value = a.load;
        engine.parameters.get('cut').value = a.cut ? 1 : 0;
        set(engGain.gain, (a.crashed ? 0.08 : 0.55) * duck, 0.15);
      }
      const v = a.v;
      // wind stays under the engine: ~0.03 at 100 km/h, 0.15 max (was 0.45/0.5, which hissed over it)
      set(wind.g.gain, Math.min(0.15, (v / 60) ** 2 * 0.14) * duck);
      set(wind.f.frequency, 250 + v * 9);           // lower band = a rush, not static
      const squeal = !a.airborne && a.surface !== 'gravel' && a.surface !== 'dirt' ? Math.max(0, (a.usage - 0.86) / 0.14) : 0;
      set(tyre.g.gain, Math.min(0.22, squeal * 0.22 * Math.min(1, v / 10)), 0.03);
      const rough = (a.surface === 'gravel' || a.surface === 'dirt') && !a.airborne ? Math.min(0.5, v / 25) : 0;
      set(gravel.g.gain, rough * 0.45, 0.04);
      set(scrape.g.gain, a.scrape ? 0.3 : 0, 0.03);
      set(rainBed.g.gain, (a.rain || 0) * 0.05, 0.8);   // a background bed: ~1/3 of before, eased in slower
      set(echoSend.gain, (a.tunnel || 0) * 0.85, 0.25);
    },
    chime(kind) {
      if (kind === 'checkpoint') { tone(880, 0.18, 'triangle', 0.22); tone(1320, 0.25, 'triangle', 0.18, 0.08); }
      else if (kind === 'best') { tone(660, 0.2, 'triangle', 0.22); tone(990, 0.2, 'triangle', 0.2, 0.1); tone(1320, 0.35, 'triangle', 0.2, 0.2); }
      else if (kind === 'miss') tone(1500, 0.08, 'square', 0.08);
      else if (kind === 'count') tone(520, 0.15, 'square', 0.12);
      else if (kind === 'go') tone(1040, 0.35, 'square', 0.14);
      else if (kind === 'warn') tone(300, 0.2, 'sawtooth', 0.08);
    },
    crash() { burst(0.9, 1400, 0.9); burst(1.6, 300, 0.7); },
    close() { try { ctx.close(); } catch {} },
  };
}
