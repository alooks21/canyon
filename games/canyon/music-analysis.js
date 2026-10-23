// Music analysis — tempo, beat, loudness, brightness and mode from live audio. Drives
// "Ride to my music" (the scenery from tempo and brightness is music-scene.js).
//
// Pure (no Web Audio, no DOM): push() takes mono Float32 frames of any length and
// keeps only numbers. The most of the audio it ever holds is the analysis window
// itself (the last 8 hops, ~85 ms, for the spectra). Beyond that it keeps ~8 s of
// onset strength (one number per ~10 ms hop) for the tempo, a 12-number chroma and a
// few running averages. Nothing is recorded, and nothing leaves the module except
// those numbers and the events below.
//
// Tempo: spectral flux (how much the log spectrum rose since the previous hop) is the
// onset envelope; its autocorrelation over the last 8 s peaks at the beat period.
// It's searched from 40 to 320 BPM, then folded by octaves into FOLD, so a half- or
// double-time reading lands on the same number. Beat phase: a comb at that period
// over the last 4 s finds where the beats fall. Mode: chroma (spectral peaks per
// pitch class) averaged over ~20 s, correlated with the Krumhansl–Kessler major and
// minor key profiles in all 12 keys.

export const FOLD = [70, 180];         // BPM range every tempo is folded into
const SEARCH = [40, 320];              // BPM range the autocorrelation looks at
export const SILENCE_DB = -65;         // a hop quieter than this (RMS, dBFS) is silence. -50 was inside
                                       // a quiet Spotify tab's own range (~-48, 2026-10-23): every soft bar was a "gap"
export const SONG_GAP_S = 1;           // silence at least this long, then sound: a new song
export const PAUSE_S = 5;              // silence this long: the music is paused
export const VIBE_READY_S = 10;        // seconds of a song before its features are reported ("ready")
const READY_MAX_S = 16;                // ...decided by then even if the tempo never settled
const TEMPO_WINDOW_S = 8;
const TEMPO_MIN_S = 3;                 // first tempo estimate after this much of a song
const TEMPO_EVERY_S = 0.5;
const SETTLE_TOL = 0.02;               // last 3 estimates within 2% of each other: settled
const PEAK_REL = 0.75;                 // a tempo peak this close to the best one counts (shortest wins)
const BEAT_PULL = 0.5;                 // how hard each estimate pulls the beat clock into phase
const STRONG_BEAT = 1.8;               // onset over its running mean for a "strong" beat
const SHORT_TAU_S = 1.5;               // short-term loudness and brightness
const SONG_TAU_S = 30;                 // a song's own loudness and brightness
const CHROMA_TAU_S = 20;
const CHROMA_HZ = [180, 4200];
const CHROMA_EVERY = 8;                // hops between chroma spectra (~12 a second)
// A song change without a gap (crossfades, gapless albums): loudness, brightness AND a
// settled tempo all stay this far from the song's own for CHANGE_HOLD_S. Two of three
// fired on a real ballad's quiet verse (2026-10-23), so it takes all three; N is the backup.
export const CHANGE_DB = 9, CHANGE_OCT = 0.7, CHANGE_TEMPO = 0.1, CHANGE_HOLD_S = 8, CHANGE_MIN_SONG_S = 45;

// Fold a tempo by octaves into FOLD.
export function foldBpm(b) {
  if (!(b > 0) || b === Infinity) return 0;   // Infinity halves forever
  while (b < FOLD[0]) b *= 2;
  while (b >= FOLD[1]) b /= 2;
  return b;
}

// ---- FFT (radix-2, in place) → magnitudes of bins 0..n/2 ----
function makeFFT(n) {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = -Math.sin(2 * Math.PI * i / n); }
  const re = new Float64Array(n), im = new Float64Array(n);
  return function magnitudes(x, out) {
    for (let i = 0; i < n; i++) { re[rev[i]] = x[i]; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
        const k = j * step, a = i + j, b = a + half;
        const tr = re[b] * cs[k] - im[b] * sn[k], ti = re[b] * sn[k] + im[b] * cs[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  };
}
const hann = n => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr12(x, p, tonic) {
  let mx = 0, mp = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; mp += p[i]; }
  mx /= 12; mp /= 12;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + tonic) % 12] - mx, b = p[i] - mp;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxx > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// on: { song({ reason }), pause(), resume(), ready(features), beat({ strength, strong }) }
export function createMusicAnalyzer(sampleRate, on = {}) {
  const sr = sampleRate;
  const HOP = 2 ** Math.round(Math.log2(sr / 94));      // ~10 ms: 512 at 44.1 and 48 kHz
  const N = HOP * 2, CN = HOP * 8, MASK = CN - 1;        // flux window, chroma window (powers of 2)
  const fr = sr / HOP, dt = HOP / sr;                   // hops per second, seconds per hop
  const fft = makeFFT(N), cfft = makeFFT(CN);
  const win = hann(N), cwin = hann(CN);
  const ring = new Float32Array(CN);                    // the analysis window: the newest CN samples
  let wpos = 0, fill = 0, hopSq = 0;
  const frameBuf = new Float64Array(CN), mag = new Float64Array(N / 2 + 1), cmag = new Float64Array(CN / 2 + 1);
  const prevLog = new Float64Array(N / 2 + 1);
  // Chroma bins: each FFT bin in range → its pitch class (C = 0).
  const pcOf = new Int8Array(CN / 2 + 1).fill(-1);
  for (let k = 1; k < CN / 2; k++) {
    const f = k * sr / CN;
    if (f >= CHROMA_HZ[0] && f <= CHROMA_HZ[1]) pcOf[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }

  // Onset envelope: a ring of TEMPO_WINDOW_S of flux values.
  const EN = Math.ceil(TEMPO_WINDOW_S * fr);
  const env = new Float64Array(EN);
  let epos = 0, ecount = 0, envMean = 0;
  const x = new Float64Array(EN), ac = new Float64Array(EN);

  let hops = 0, time = 0, silentFor = 0, paused = false, song = 0;
  let songTime = 0, songW = 0, ready = false, songBpm = 0, changeFor = 0;
  let shortPow = 0, songPow = 0, shortCent = 0, songCent = 0;
  const chroma = new Float64Array(12), cnow = new Float64Array(12);
  let chromaW = 0;
  let hist = [], bpm = 0, rawBpm = 0, settled = false, periodF = 0, since = 0, beats = 0, lastStrength = 0;
  let cpu = 0;

  function resetSong() {
    songTime = 0; songW = 0; ready = false; songBpm = 0; changeFor = 0;
    songPow = shortPow; songCent = shortCent;
    chroma.fill(0); chromaW = 0;
    env.fill(0); epos = 0; ecount = 0;
    hist = []; bpm = 0; rawBpm = 0; settled = false; periodF = 0; since = 0;
  }
  function newSong(reason) {
    resetSong();
    song++;
    on.song?.({ reason });
  }

  const envAt = back => env[(epos - 1 - back + EN * 2) % EN];   // back = 0: the newest hop
  function pushEnv(v) { env[epos] = v; epos = (epos + 1) % EN; if (ecount < EN) ecount++; }

  function estimateTempo() {
    const L = ecount;
    let mean = 0;
    for (let i = 0; i < L; i++) { x[i] = envAt(L - 1 - i); mean += x[i]; }
    mean /= L;
    envMean = mean;
    // Zero-mean, then a [¼ ½ ¼] blur, twice: a period that isn't a whole number of
    // hops puts its onsets on alternating hops, and unblurred they'd split its peak.
    for (let i = 0; i < L; i++) x[i] -= mean;
    for (let pass = 0; pass < 2; pass++) {
      let p0 = x[0];
      for (let i = 0; i < L; i++) {
        const c = x[i], n = i + 1 < L ? x[i + 1] : c;
        x[i] = 0.25 * p0 + 0.5 * c + 0.25 * n;
        p0 = c;
      }
    }
    const lagMin = Math.floor(fr * 60 / SEARCH[1]), lagMax = Math.min(Math.ceil(fr * 60 / SEARCH[0]), Math.floor(L / 2) - 1);
    if (lagMax <= lagMin + 2) return;
    const top = Math.min(L - 1, lagMax * 2 + 2);
    for (let l = lagMin - 1; l <= top; l++) {
      let s = 0;
      for (let i = 0; i + l < L; i++) s += x[i] * x[i + l];
      ac[l] = s;
    }
    // A period scores its own peak plus half its double's. Every multiple of the beat
    // period is periodic too (a click every P is also one every 2P and 3P), and one
    // that falls on a whole number of hops can even outscore P itself — so take the
    // SHORTEST lag that peaks within PEAK_REL of the best, and let folding sort octaves.
    const score = l => ac[l] + (2 * l <= top ? 0.5 * ac[2 * l] : 0);
    let max = -Infinity;
    for (let l = lagMin; l <= lagMax; l++) max = Math.max(max, score(l));
    if (!(max > 0)) return;
    let best = -1;
    for (let l = lagMin; l <= lagMax && best < 0; l++) {
      const s = score(l);
      if (s >= PEAK_REL * max && s >= score(l - 1) && s >= score(l + 1)) best = l;
    }
    const a = score(best - 1), b = score(best), c = score(best + 1);
    const den = a - 2 * b + c;
    const P = best + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0);
    rawBpm = foldBpm(60 * fr / P);
    // No peak worth a tempo (best = -1 on a beatless, slowly swelling stretch) folds to 0.
    // It must never reach hist: a median of 0 made Pf = Infinity below, and the phase loop
    // `ph < Infinity` hung the page (a real Joji ballad, 2026-10-23).
    if (!(rawBpm > 0)) { rawBpm = 0; return; }
    hist.push(rawBpm);
    if (hist.length > 5) hist.shift();
    const sorted = [...hist].sort((p, q) => p - q);
    bpm = sorted[sorted.length >> 1];
    const last3 = hist.slice(-3);
    settled = last3.length === 3 && last3.every(v => Math.abs(v / bpm - 1) < SETTLE_TOL);

    // Beat phase: the offset (hops since the last beat) whose comb at the folded
    // period collects the most onset over the last 4 s.
    const Pf = 60 * fr / bpm, span = Math.min(L, Math.round(4 * fr));
    if (!(Pf >= 1 && Pf <= span)) return;            // belt and braces: both loops below are bounded by Pf
    let bestPh = 0, bestV = -Infinity;
    for (let ph = 0; ph < Math.ceil(Pf); ph++) {
      let v = 0;
      for (let k = 0; ; k++) {
        const i = Math.round(ph + k * Pf);
        if (i + 1 >= span) break;
        v += Math.max(0, envAt(i) - mean) + 0.5 * Math.max(0, envAt(i + 1) - mean) + (i > 0 ? 0.5 * Math.max(0, envAt(i - 1) - mean) : 0);
      }
      if (v > bestV) { bestV = v; bestPh = ph; }
    }
    if (!periodF) since = bestPh;
    else {
      let err = bestPh - since;
      err -= Pf * Math.round(err / Pf);
      since += BEAT_PULL * err;
      if (since < 0) since += Pf;
    }
    periodF = Pf;
  }

  function advanceBeat() {
    if (!periodF) return;
    since += 1;
    if (since >= periodF) {
      since -= periodF;
      beats++;
      const o = Math.max(envAt(0), envAt(1), envAt(2));
      lastStrength = envMean > 0 ? o / envMean : 0;
      if (!paused) on.beat?.({ strength: lastStrength, strong: lastStrength >= STRONG_BEAT });
    }
  }

  function features() {
    const m = mode();
    return { bpm: songBpm || bpm, loud: 10 * Math.log10(songPow + 1e-12), centroid: songCent, modeScore: m.score, mode: m.mode, key: m.key };
  }
  function mode() {
    if (chromaW <= 0) return { mode: null, score: 0, key: null };
    let bm = -2, bn = -2, km = 0, kn = 0;
    for (let t = 0; t < 12; t++) {
      const a = corr12(chroma, KK_MAJOR, t), b = corr12(chroma, KK_MINOR, t);
      if (a > bm) { bm = a; km = t; }
      if (b > bn) { bn = b; kn = t; }
    }
    return { mode: bm >= bn ? 'major' : 'minor', score: bm - bn, key: bm >= bn ? km : kn };
  }

  function hop() {
    hops++; time += dt;
    const ms = hopSq / HOP;
    hopSq = 0;
    const db = 10 * Math.log10(ms + 1e-12);
    if (db < SILENCE_DB) {
      silentFor += dt;
      if (!paused && silentFor >= PAUSE_S) { paused = true; on.pause?.(); }
      pushEnv(0);
      prevLog.fill(0);
      advanceBeat();
      return;
    }
    if (silentFor >= SONG_GAP_S) {
      if (paused) { paused = false; on.resume?.(); }
      silentFor = 0;
      newSong('gap');
    }
    silentFor = 0;
    songTime += dt;

    // Spectrum of the newest N samples.
    for (let i = 0; i < N; i++) frameBuf[i] = ring[(wpos - N + i) & MASK] * win[i];
    fft(frameBuf, mag);
    let flux = 0, sm = 0, sf = 0;
    const norm = 4 / N;
    for (let k = 1; k <= N / 2; k++) {
      const m = mag[k] * norm;
      const lg = Math.log1p(1000 * m);
      const d = lg - prevLog[k];
      if (d > 0) flux += d;
      prevLog[k] = lg;
      sm += m; sf += m * k;
    }
    const cent = sm > 0 ? sf / sm * sr / N : 0;
    pushEnv(flux);

    // Running levels. The song's own start as a plain mean (weight grows with time),
    // so the first seconds aren't dragged towards zero.
    const aS = dt / SHORT_TAU_S;
    shortPow += (ms - shortPow) * (shortPow ? aS : 1);
    shortCent += (cent - shortCent) * (shortCent ? aS : 1);
    songW += dt;
    const aG = Math.max(dt / SONG_TAU_S, dt / songW);
    songPow += (ms - songPow) * aG;
    songCent += (cent - songCent) * aG;

    if (hops % CHROMA_EVERY === 0) {
      for (let i = 0; i < CN; i++) frameBuf[i] = ring[(wpos + i) & MASK] * cwin[i];
      cfft(frameBuf, cmag);
      cnow.fill(0);
      for (let k = 2; k < CN / 2 - 1; k++) {
        const p = pcOf[k];
        if (p >= 0 && cmag[k] >= cmag[k - 1] && cmag[k] >= cmag[k + 1]) cnow[p] += cmag[k];
      }
      chromaW += dt * CHROMA_EVERY;
      const aC = Math.max(dt * CHROMA_EVERY / CHROMA_TAU_S, dt * CHROMA_EVERY / chromaW);
      for (let p = 0; p < 12; p++) chroma[p] += (cnow[p] - chroma[p]) * aC;
    }

    if (songTime >= TEMPO_MIN_S && hops % Math.round(TEMPO_EVERY_S * fr) === 0) estimateTempo();
    advanceBeat();

    if (!ready && songTime >= VIBE_READY_S && (settled || songTime >= READY_MAX_S) && bpm > 0) {
      ready = true;
      songBpm = bpm;
      on.ready?.(features());
    }

    // A new song with no gap before it.
    if (ready && songTime >= CHANGE_MIN_SONG_S) {
      let votes = 0;
      if (Math.abs(10 * Math.log10((shortPow + 1e-12) / (songPow + 1e-12))) > CHANGE_DB) votes++;
      if (shortCent > 0 && songCent > 0 && Math.abs(Math.log2(shortCent / songCent)) > CHANGE_OCT) votes++;
      if (settled && songBpm > 0) {
        const r = Math.abs(Math.log2(rawBpm / songBpm));
        if (r > CHANGE_TEMPO && Math.abs(r - 1) > CHANGE_TEMPO) votes++;
      }
      changeFor = votes >= 3 ? changeFor + dt : 0;
      if (changeFor >= CHANGE_HOLD_S) newSong('change');
    }
  }

  return {
    sampleRate: sr, hopSize: HOP,
    push(frame) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      for (let i = 0; i < frame.length; i++) {
        const v = frame[i];
        ring[wpos] = v;
        wpos = (wpos + 1) & MASK;
        hopSq += v * v;
        if (++fill === HOP) { fill = 0; hop(); }
      }
      if (t0) cpu += performance.now() - t0;
    },
    // "N": treat what's playing as a new song.
    forceSong() { newSong('forced'); },
    features,
    get cpuMs() { return cpu; },
    get time() { return time; },
    get bpm() { return bpm; },
    get rawBpm() { return rawBpm; },
    get settled() { return settled; },
    get ready() { return ready; },
    get song() { return song; },
    get songTime() { return songTime; },
    get silentFor() { return silentFor; },
    get paused() { return paused; },
    get beats() { return beats; },
    get strength() { return lastStrength; },
    // Seconds since the last beat and the beat period (0 until there's a tempo).
    get beatAge() { return since * dt; },
    get period() { return periodF * dt; },
    get loud() { return 10 * Math.log10(shortPow + 1e-12); },
    get loudSong() { return 10 * Math.log10(songPow + 1e-12); },
    get centroid() { return shortCent; },
    get mode() { return mode(); },
  };
}
