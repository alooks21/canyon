// Calibration recorder for "Ride to my music" (?calibrate=1). It reads the analysis
// and keeps what it read: one sample of the analyser's numbers a second, and every
// song / pause / resume / ready / scene event. Numbers only, never audio, and nothing about
// the browser or the person. The file it makes is for tuning the analysis offline.
//
// Pure (no DOM): the page hands it the analyser, the scene tracker and a clock.

import { SILENCE_DB, SONG_GAP_S, PAUSE_S, VIBE_READY_S, FOLD, CHANGE_DB, CHANGE_OCT, CHANGE_TEMPO, CHANGE_HOLD_S, CHANGE_MIN_SONG_S } from './music-analysis.js';
import { SCENE_BPM, SCENE_HZ, HYST_BPM, HYST_BRIGHT, SCENE_WINDOW_S, SCENE_READY_S, SCENE_HOLD_S, SCENE_SPACING_S, FLIP_BACK_S } from './music-scene.js';

export const CALIB_VERSION = 2;          // 2: + the scene tracker's rolling medians and box
export const CALIB_KEY = 'canyon.calibration.last';
const SAMPLE_S = 1;
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
const pad = n => String(n).padStart(2, '0');

// now(): milliseconds (performance.now in the page). startedAt: a Date.
export function createCalibration({ sampleRate, now, startedAt = new Date() }) {
  const t0 = now();
  const samples = [], events = [];
  let next = 0;
  const t = () => r1((now() - t0) / 1000);

  return {
    // Call often (every audio block): takes a sample whenever a second has passed.
    // vibe: the scene now (or the player's pick). scenes: the scene tracker (music-scene.js).
    tick(an, vibe, override = false, scenes = null) {
      const s = (now() - t0) / 1000;
      if (s < next) return false;
      next = Math.floor(s / SAMPLE_S) * SAMPLE_S + SAMPLE_S;
      const m = an.mode;
      samples.push({
        t: r1(s), at: r1(an.time), song: an.song, songTime: r1(an.songTime),
        rawBpm: r1(an.rawBpm), bpm: r1(an.bpm), settled: an.settled,
        loud: r1(an.loud), loudSong: r1(an.loudSong), centroid: Math.round(an.centroid),
        mode: m.mode, modeScore: r3(m.score), key: m.key,
        paused: an.paused, vibe, override, ready: an.ready, beats: an.beats,
        medBpm: r1(scenes?.bpm || 0), medHz: Math.round(scenes?.hz || 0), box: scenes?.box ?? null,
      });
      return true;
    },
    // ev: what music.js reports — { type: 'song', reason } | pause | resume | { type: 'ready', f }
    //   | { type: 'scene', scene, reason, bpm, hz }
    event(ev) {
      const e = { t: t(), type: ev.type };
      if (ev.reason) e.reason = ev.reason;
      if (ev.type === 'ready') e.f = { ...ev.f };
      if (ev.type === 'scene') { e.scene = ev.scene; e.bpm = r1(ev.bpm || 0); e.hz = Math.round(ev.hz || 0); }
      events.push(e);
    },
    get seconds() { return (now() - t0) / 1000; },
    // Songs heard: the first one plus every change.
    get songs() { return samples.length || events.length ? 1 + events.filter(e => e.type === 'song').length : 0; },
    get count() { return samples.length; },
    data() {
      return {
        version: CALIB_VERSION,
        startedAt: startedAt.toISOString(),
        sampleRate, sampleEveryS: SAMPLE_S,
        constants: { SILENCE_DB, SONG_GAP_S, PAUSE_S, VIBE_READY_S, FOLD, SCENE_BPM, SCENE_HZ, HYST_BPM, HYST_BRIGHT, SCENE_WINDOW_S, SCENE_READY_S, SCENE_HOLD_S, SCENE_SPACING_S, FLIP_BACK_S, CHANGE_DB, CHANGE_OCT, CHANGE_TEMPO, CHANGE_HOLD_S, CHANGE_MIN_SONG_S },
        samples, events,
      };
    },
    fileName() { return calibFileName(startedAt); },
  };
}

export function calibFileName(d) {
  return `canyon-calibration-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

// "Calibration: recording · 12:34 · 5 songs"
export function calibLabel(seconds, songs) {
  const s = Math.max(0, Math.floor(seconds));
  return `Calibration: recording · ${pad(Math.floor(s / 60))}:${pad(s % 60)} · ${songs} song${songs === 1 ? '' : 's'}`;
}
