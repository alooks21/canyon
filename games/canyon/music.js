// Ride to my music — the browser side. Asks Chrome for a music tab's audio, listens
// to it on the game's own AudioContext, and turns the analysis (music-analysis.js)
// into what the ride needs: song events, the scene and tempo for new land (from a
// rolling window of tempo and brightness, music-scene.js), a beat pulse, a kick on
// strong beats and a light level from the loudness.
//
// The captured audio goes into the tap (music-tap.js) and nowhere else: not to the
// speakers (it already plays in its own tab, so no echo), not to a recorder, not over
// the network. Only the numbers the analysis derives survive.

import { createMusicAnalyzer } from './music-analysis.js';
import { createSceneTracker, SCENE_NAME } from './music-scene.js';

export class MusicError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const NO_AUDIO = 'Pick your music tab under ‘Chrome Tab’ and tick ‘Also share tab audio’.';
// getDisplayMedia insists on video; it's stopped as soon as the share starts.
const CAPTURE = {
  video: true,
  audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  selfBrowserSurface: 'exclude', preferCurrentTab: false, surfaceSwitching: 'include',
  systemAudio: 'exclude',          // a whole-screen share would feed the game's own engine into the analysis
};
const LATENCY_S = 0.02;            // the analysis hears each block a little late: look this far ahead
const PULSE_S = 0.12;              // beat pulse decay
const KICK_DECAY = 9;              // per second
const LIGHT_DB = 10, LIGHT_GAIN = 0.15;   // ±10 dB against the song's own level → ±15% light
const SCENE_EVERY_S = 1;           // one reading a second into the scene tracker

// Must run straight from a click: Chrome only opens the picker with its activation.
export async function pickMusicTab() {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) throw new MusicError('unsupported', 'This browser can’t share a tab’s sound. Use Chrome on a computer.');
  let stream;
  try { stream = await md.getDisplayMedia(CAPTURE); }
  catch (e) {
    if (e?.name === 'NotAllowedError') throw new MusicError('cancelled', 'Sharing was cancelled. ' + NO_AUDIO);
    throw new MusicError('failed', `Chrome couldn’t share that (${e?.name || 'error'}). ${NO_AUDIO}`);
  }
  for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
  if (!stream.getAudioTracks().length) {
    for (const t of stream.getTracks()) t.stop();
    throw new MusicError('noaudio', 'That share has no sound. ' + NO_AUDIO);
  }
  return stream;
}

const tapLoaded = new WeakSet();   // registerProcessor twice in one context throws

// source: the shared tab's MediaStream, or (tests) an AudioBuffer played into the same
// tap. onEnded: the share stopped from Chrome's own "Stop sharing" bar. onEvent / onPush
// (the calibration recorder): each song event as it happens, and after each audio block.
export async function createMusic(ctx, source, { onEnded, onEvent, onPush } = {}) {
  if (!tapLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule(new URL('./music-tap.js', import.meta.url));
    tapLoaded.add(ctx);
  }
  const tap = new AudioWorkletNode(ctx, 'canyon-music-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  const stream = source instanceof MediaStream ? source : null;
  const input = stream ? ctx.createMediaStreamSource(stream) : null;   // kept: Chrome may stop an unreferenced one
  input?.connect(tap);
  const buffers = new Set();

  const events = [];
  const emit = ev => { events.push(ev); onEvent?.(ev); };
  const scenes = createSceneTracker('chill');
  let bpm = 110, yours = false, nextScene = 0, kick = 0, light = 1, wall = performance.now();
  let stopped = false, frames = 0;
  const an = createMusicAnalyzer(ctx.sampleRate, {
    song: e => { yours = false; scenes.clear(); emit({ type: 'song', reason: e.reason }); },
    pause: () => emit({ type: 'pause' }),
    resume: () => emit({ type: 'resume' }),
    ready: f => emit({ type: 'ready', f }),
    beat: e => { if (e.strong) kick = 1; },
  });
  // A reading a second (on the audio clock), never while it's silent or paused.
  function sceneTick() {
    if (an.time < nextScene) return;
    nextScene = Math.floor(an.time / SCENE_EVERY_S) * SCENE_EVERY_S + SCENE_EVERY_S;
    if (an.paused || an.silentFor > 0.5) return;
    const r = scenes.push(an.time, an.rawBpm, an.centroid);
    if (scenes.ready) bpm = scenes.bpm;
    if (r) { yours = false; emit({ type: 'scene', scene: r.scene, reason: r.reason, bpm: scenes.bpm, hz: scenes.hz }); }
  }
  tap.port.onmessage = e => { an.push(e.data); sceneTick(); wall = performance.now(); onPush?.(); };
  const track = stream?.getAudioTracks()[0] || null;
  const ended = () => { if (!stopped) onEnded?.(); };
  track?.addEventListener('ended', ended);

  function play(buffer) {
    const b = ctx.createBufferSource();
    b.buffer = buffer;
    b.connect(tap);
    b.onended = () => { b.disconnect(); buffers.delete(b); };
    buffers.add(b);
    b.start();
  }
  if (!stream) play(source);

  return {
    analyzer: an,
    track,
    scenes,
    // What new land should be: the scene (or the player's pick, until the next change),
    // and the tempo. Until a new song's window fills, the last ones (provisional).
    get want() { return { vibe: scenes.scene, bpm }; },
    setOverride(v) { scenes.setScene(v, an.time); yours = true; },
    // Back to automatic: the scene the music measures now (if the window is full).
    clearOverride() { if (scenes.box && scenes.box !== scenes.scene) scenes.setScene(scenes.box, an.time); yours = false; },
    get status() {
      return { vibe: scenes.scene, scene: SCENE_NAME[scenes.scene], override: yours, bpm: scenes.ready ? scenes.bpm : 0, listening: !scenes.ready, paused: an.paused, song: an.song };
    },
    get cpuPerFrame() { return an.cpuMs / Math.max(1, frames); },
    // Song events since the last call.
    drain() { return events.splice(0); },
    // Per frame: pulse (0..1 after each beat), kick (strong beats, decaying), light.
    frame(now, dt) {
      frames++;
      kick *= Math.exp(-KICK_DECAY * dt);
      let pulse = 0, want = 1;
      if (!an.paused && an.period > 0 && an.silentFor < 0.3) {
        const age = (an.beatAge + (now - wall) / 1000 + LATENCY_S) % an.period;
        pulse = Math.exp(-age / PULSE_S);
        const rel = an.loud - an.loudSong;
        want = 1 + LIGHT_GAIN * Math.max(-1, Math.min(1, rel / LIGHT_DB));
      }
      light += (want - light) * Math.min(1, dt * 4);
      return { pulse, kick: an.paused ? 0 : kick, light };
    },
    play,
    stop() {
      if (stopped) return;
      stopped = true;
      track?.removeEventListener('ended', ended);
      tap.port.onmessage = null;
      tap.port.postMessage('stop');
      input?.disconnect();
      for (const b of buffers) { try { b.stop(); } catch {} b.disconnect(); }
      buffers.clear();
      tap.disconnect();
      stream?.getTracks().forEach(t => t.stop());
    },
  };
}
