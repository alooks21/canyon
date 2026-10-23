// Scenery from the music — "Ride to my music" picks one of four scenes from two
// measurements only: tempo (slow | fast) and brightness, the spectral centroid
// (dark | bright). Mood (mode, loudness) didn't carry: a calibration run over 14
// labelled songs scored 4/14 on mood, while tempo was within 0.3 BPM (2026-10-23).
//
// The scene follows a rolling window, not songs: Spotify plays tracks back to back
// with no silence, so there is often no "new song" to wait for. Every second the
// tracker takes the analyser's latest tempo estimate and brightness, keeps the last
// SCENE_WINDOW_S of them and takes their medians. The box those medians fall in (with
// hysteresis around each split) has to differ from the scene for SCENE_HOLD_S, and
// SCENE_SPACING_S must have passed since the last change, before the scene changes.
//
// Pure (no Web Audio, no DOM). Internal scene keys are the recipe keys in regions.js.

import { foldBpm } from './music-analysis.js';

export const SCENE_BPM = 122;          // slow below, fast at or above
export const SCENE_HZ = 2700;          // spectral centroid: dark below, bright at or above
export const HYST_BPM = 1.5;           // to cross the tempo split, go this far past it. Not 4: three
                                       // songs read 119.9–120.2 BPM, and ±4 kept them "fast" (the run: 120 vs 125)
export const HYST_BRIGHT = 0.08;       // ...and the brightness split, this fraction past it
export const SCENE_WINDOW_S = 30;      // rolling medians over this much
export const SCENE_READY_S = 10;       // a window this full before the first scene
export const SCENE_HOLD_S = 15;        // a new box has to last this long
export const SCENE_SPACING_S = 45;     // at least this between scene changes
export const FLIP_BACK_S = 60;         // ...and this before going back to the scene before

// Keys 1–4, in order. slow+dark · slow+bright · fast+bright · fast+dark.
export const VIBES = ['sad', 'chill', 'upbeat', 'intense'];
export const SCENE_NAME = { sad: 'Night', chill: 'Sunset', upbeat: 'Midday', intense: 'Storm' };

const FAST = { upbeat: true, intense: true }, BRIGHT = { chill: true, upbeat: true };

// The box (scene key) for a tempo and a brightness. prev: the current box, for hysteresis.
export function boxOf(bpm, hz, prev = null) {
  const fast = !prev ? bpm >= SCENE_BPM : FAST[prev] ? bpm >= SCENE_BPM - HYST_BPM : bpm >= SCENE_BPM + HYST_BPM;
  const bright = !prev ? hz >= SCENE_HZ : BRIGHT[prev] ? hz >= SCENE_HZ * (1 - HYST_BRIGHT) : hz >= SCENE_HZ * (1 + HYST_BRIGHT);
  return fast ? (bright ? 'upbeat' : 'intense') : (bright ? 'chill' : 'sad');
}

const median = a => {
  const s = a.map(e => e[1]).sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : 0;
};

// scene: the scene shown or planned at the start.
export function createSceneTracker(scene = 'chill') {
  let bpms = [], hzs = [], start = null, ready = false, box = null;
  let differing = false, diffSince = 0, lastChange = -Infinity, prevScene = null, mBpm = 0, mHz = 0;
  const MAX = SCENE_WINDOW_S * 8;      // bounded even if pushed far more than once a second

  function keep(arr, t, v) {
    if (Number.isFinite(v) && v > 0) arr.push([t, v]);
    while (arr.length && (arr[0][0] <= t - SCENE_WINDOW_S || arr.length > MAX)) arr.shift();
  }

  return {
    // One reading, about once a second (t in seconds). Returns { scene, reason } when the
    // scene changes ('shift'), or the first time a window is full ('ready': always, even
    // if the scene stays, so a new song's land can take its tempo).
    push(t, rawBpm, centroid) {
      if (!Number.isFinite(t)) return null;
      if (start === null) start = t;
      keep(bpms, t, foldBpm(rawBpm));
      keep(hzs, t, centroid);
      if (!ready && (t - start < SCENE_READY_S || bpms.length < 3 || hzs.length < 3)) return null;
      if (!bpms.length || !hzs.length) return null;
      mBpm = median(bpms); mHz = median(hzs);
      box = boxOf(mBpm, mHz, box);
      if (!ready) {
        ready = true;
        differing = false;
        if (box !== scene) { lastChange = t; prevScene = scene; }
        scene = box;
        return { scene, reason: 'ready' };
      }
      if (box === scene) { differing = false; return null; }
      if (!differing) { differing = true; diffSince = t; }   // any box but the scene's counts
      const gap = box === prevScene ? FLIP_BACK_S : SCENE_SPACING_S;
      if (t - diffSince >= SCENE_HOLD_S && t - lastChange >= gap) {
        prevScene = scene; scene = box; lastChange = t; differing = false;
        return { scene, reason: 'shift' };
      }
      return null;
    },
    // A new song (a silence gap, the gapless detector, N): start the window afresh; the
    // next 'ready' re-evaluates at once, without the hold or the spacing.
    clear() { bpms = []; hzs = []; start = null; ready = false; box = null; differing = false; },
    // The player's pick (keys 1–4), until the next change.
    setScene(v, t) { if (v !== scene) prevScene = scene; scene = v; differing = false; if (Number.isFinite(t)) lastChange = t; },
    get scene() { return scene; },
    get box() { return ready ? box : null; },
    get ready() { return ready; },
    get bpm() { return ready ? mBpm : 0; },
    get hz() { return ready ? mHz : 0; },
  };
}

// Replay per-second readings ([{ t, rawBpm, centroid }]) through a tracker. Returns the
// first scene, every change, and each second's box and scene.
export function replayScenes(samples, scene = 'chill') {
  const tr = createSceneTracker(scene);
  const changes = [], track = [];
  let first = null;
  for (const s of samples) {
    const r = tr.push(s.t, s.rawBpm, s.centroid);
    if (r?.reason === 'ready' && !first) first = { t: s.t, scene: r.scene };
    else if (r) changes.push({ t: s.t, scene: r.scene });
    track.push({ t: s.t, box: tr.box, scene: tr.scene, bpm: tr.bpm, hz: tr.hz });
  }
  return { first, changes, track };
}
