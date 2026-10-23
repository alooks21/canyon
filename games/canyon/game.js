// Canyon — canyon-road riding on an Aprilia RS 660 Factory ("Dark Banshee").
//
// This file is the director: it owns the renderer, the screens, the input, the
// fixed-timestep loop and one ride "session" at a time. Everything it directs is
// its own module — road/terrain/course (the world's numbers), world (what you see),
// physics (the bike), bike-model (the RS 660), traffic, audio, ui. Arcade contract:
// init() returns a controller with start() and destroy(); destroy() must leave
// nothing behind (canvas, WebGL context, audio, listeners, fullscreen).

import * as THREE from '../../vendor/three.module.js';
import { makeCourse } from './course.js';
import { createWorld } from './world.js';
import { loadKit, loadRider, loadBikeBody, loadBikeModel } from './assets.js';
import { STAGES, ENDLESS } from './stages.js';
import { createBike, placeBike, stepBike, STEP, AIDS, crash, groundAt, WHEELIE_ASSIST_DEG } from './physics.js';
import { createRagdoll, crashKind, JOINTS } from './ragdoll.js';
import { createBikeModel } from './bike-model.js';
import { makeAutopilot } from './autopilot.js';
import { medalTimes } from './lapsim.js';
import { createTraffic } from './traffic.js';
import { createAudio } from './audio.js';
import { createUI, fmtTime } from './ui.js';
import { encodeGhost, decodeGhost, extractCode, cleanName, GhostError } from './ghost-share.js';
import { createOnline } from './online.js';
import { pickMusicTab, createMusic, MusicError } from './music.js';
import { VIBES, SCENE_NAME } from './music-scene.js';
import { VIBE_PARTS } from './regions.js';
import { createCalibration, calibLabel, calibFileName, CALIB_KEY } from './music-calibrate.js';

const STORE = 'arcade:canyon:v1';
const GHOST = id => `arcade:canyon:ghost:${id}`;
const RIVAL = id => `arcade:canyon:rival:${id}`;     // a friend's ghost code, one per stage
const DEFAULTS = { aids: 'full', gearbox: 'auto', units: 'mph', camera: 'chase', tilt: 'on', traffic: 'on', ghost: 'on', quality: 'high', volume: '0.6', musicEngine: '0.35', musicKick: 'on' };
const DEG = Math.PI / 180;
const GHOST_HZ = 20;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const IDLE_SOUND = { rpm: 1300, load: 0.04, cut: false, v: 0, usage: 0, surface: 'asphalt', scrape: false, airborne: false, crashed: false };
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// localStorage throws in private windows / with site data blocked — never crash on it.
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
};

// Ghost samples are stored as base64 of their Float32 bytes.
function f32ToB64(arr) {
  const bytes = new Uint8Array(new Float32Array(arr).buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToF32(raw) {
  const bin = atob(raw);
  const buf = new Uint8Array(bin.length & ~3);
  for (let i = 0; i < buf.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

// Place a ghost mesh at a moment of its recording (20 Hz samples, interpolated).
function poseGhost(mesh, G, clock) {
  const f = Math.max(0, clock) * GHOST_HZ, i = Math.min(Math.floor(f), G.length / 6 - 2), t = Math.min(1, f - i);
  const o = i * 6, p = o + 6;
  mesh.position.set(G[o] + (G[p] - G[o]) * t, G[o + 1] + (G[p + 1] - G[o + 1]) * t, G[o + 2] + (G[p + 2] - G[o + 2]) * t);
  const psi = G[o + 3] + wrap(G[p + 3] - G[o + 3]) * t;
  mesh.rotation.set(G[o + 4] + (G[p + 4] - G[o + 4]) * t, -psi, G[o + 5], 'YZX');
}

export function init(sharedCanvas, services) {
  const { mount, input, hud: shell } = services;
  const debug = new URLSearchParams(location.search).has('canyondebug');
  // ?calibrate=1: music rides ride themselves and record the analysis's readings (music-calibrate.js).
  const calibrate = new URLSearchParams(location.search).get('calibrate') === '1';

  // ---------- canvas + renderer (our own canvas: see the arcade README) ----------
  sharedCanvas.hidden = true;
  const cv = document.createElement('canvas');
  cv.style.cssText = 'display:block;width:100%;height:auto;aspect-ratio:16/9;';
  mount.appendChild(cv);
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.08, 2600);

  // ---------- saved data ----------
  let store = { settings: {}, records: {} };
  try { store = { ...store, ...JSON.parse(storage.get(STORE) || '{}') }; } catch {}
  const settings = { ...DEFAULTS, ...store.settings };
  const persist = () => storage.set(STORE, JSON.stringify({ settings, records: store.records }));

  // ---------- the bike (one model, moved between the garage and the road) ----------
  const model = createBikeModel();
  let ghostGeo = model.bakeGhost();
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x5ac8fa, transparent: true, opacity: 0.32, depthWrite: false });
  const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);
  ghostMesh.visible = false;
  // A friend's ghost: same shape, orange, with their name floating over it.
  const rivalMat = new THREE.MeshBasicMaterial({ color: 0xff9d2e, transparent: true, opacity: 0.45, depthWrite: false });
  const rivalMesh = new THREE.Mesh(ghostGeo, rivalMat);
  rivalMesh.visible = false;
  const tagCanvas = document.createElement('canvas');
  tagCanvas.width = 256; tagCanvas.height = 64;
  const tagTex = new THREE.CanvasTexture(tagCanvas);
  tagTex.colorSpace = THREE.SRGBColorSpace;
  const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false, depthTest: false });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(2, 0.5, 1);
  tag.position.y = 1.95;
  rivalMesh.add(tag);
  function setTag(name) {
    const g = tagCanvas.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    g.font = 'italic 800 34px "Segoe UI", Roboto, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.65)';
    g.strokeText(name, 128, 32, 240);
    g.fillStyle = '#ffb347';
    g.fillText(name, 128, 32, 240);
    tagTex.needsUpdate = true;
  }

  // ---------- garage: a studio turntable ----------
  const garage = buildGarage(renderer);
  garage.scene.add(model.group);

  // ---------- UI ----------
  let audio = null, audioPromise = null;
  const medalCache = {}, courseCache = {};
  const courseFor = def => courseCache[def.id] || (courseCache[def.id] = makeCourse(def));
  const medalsFor = def => medalCache[def.id] || (medalCache[def.id] = (() => {
    const c = courseFor(def);
    return medalTimes(c.road, c.startS, c.length);
  })());

  // ---------- friends' ghosts ----------
  // Stored as their codes (a few KB each) and decoded on load, so every load is
  // checked against this version's roads again.
  const rivals = {};                                 // stageId → decoded ghost
  function adoptRival(g) {
    // The first moment the rival reached each distance: a respawn sends a ghost
    // backwards, and the gap should count from when they first got there.
    const reach = new Float32Array(g.sAlong.length);
    let m = -Infinity;
    for (let i = 0; i < reach.length; i++) reach[i] = m = Math.max(m, g.sAlong[i]);
    rivals[g.stageId] = { ...g, reach };
  }
  const rivalsReady = Promise.all(STAGES.map(async st => {
    const code = storage.get(RIVAL(st.id));
    if (!code) return;
    try { adoptRival(await decodeGhost(code, courseFor)); }
    catch (e) { if (e instanceof GhostError) storage.remove(RIVAL(st.id)); }   // e.g. the road changed
  }));
  // Your own best run on a stage, if it can be shared: it must exist, and last as
  // long as the best time (runs saved before crashes were recorded fall short).
  function ownGhost(st) {
    const best = store.records[st.id]?.best;
    const raw = storage.get(GHOST(st.id));
    if (!best || !raw) return { best, note: best ? 'best run has no ghost saved' : 'not ridden yet' };
    let samples;
    try { samples = b64ToF32(raw); } catch { return { best, note: 'saved ghost is damaged' }; }
    const span = (samples.length / 6 - 1) / GHOST_HZ;
    if (Math.abs(span - best) > 1.4) return { best, note: 'beat your best to record a shareable run' };
    return { best, samples };
  }
  function ghostsData() {
    return {
      name: settings.ghostName || '',
      stages: STAGES.map(st => {
        const g = ownGhost(st);
        return { id: st.id, name: st.name, best: g.best, ready: !!g.samples, note: g.note };
      }),
      rivals: STAGES.filter(st => rivals[st.id]).map(st => rivals[st.id]),
    };
  }
  async function shareCode(id) {
    const st = STAGES.find(s => s.id === id);
    const g = st && ownGhost(st);
    if (!g?.samples) throw new GhostError('There is no shareable run on that road yet.');
    return encodeGhost({ stageId: id, course: courseFor(st), samples: g.samples, timeMs: g.best * 1000, name: settings.ghostName || 'Rider' });
  }
  const fileName = (id, name) => `canyon-${id}-${(name || 'rider').replace(/[^A-Za-z0-9_-]+/g, '-')}.canyonghost`;

  const actions = {
    stages() { ui.renderStages(store.records, settings.units, medalsFor); ui.show('stages'); },
    endless() { startRide({ ...ENDLESS, seed: (Date.now() % 100000) | 0 }); },
    music() { startMusicRide(); },
    musicStop() { stopMusic(true); },
    musicEngine(v) { settings.musicEngine = String(v); persist(); if (music) audio?.setDuck(Number(v)); },
    calibSave() { const c = calib || lastCalib; if (c) downloadJson(c.fileName(), c.data()); },
    calibLast() {
      if (lastCalib) { actions.calibSave(); return; }
      try { const d = JSON.parse(storage.get(CALIB_KEY)); downloadJson(calibFileName(new Date(d.startedAt)), d); } catch {}
    },
    demo() { startRide(STAGES[Math.floor(Math.random() * STAGES.length)], { demo: true }); },
    settings() { settingsFrom = ui.screen; ui.renderSettings(settings); ui.show('settings'); },
    help() { ui.show('help'); },
    back() {
      if (ui.screen === 'settings' && settingsFrom === 'pause') { ui.show('pause'); return; }
      ui.show('title');
    },
    ride(id) { startRide(id === 'endless' ? { ...ENDLESS, seed: (Date.now() % 100000) | 0 } : STAGES.find(s => s.id === id)); },
    cycle(key) {
      settings[key] = ui.nextSetting(key, settings);
      applySettings(key);
      persist();
      ui.renderSettings(settings);
      ui.root.querySelector(`[data-arg="${key}"]`)?.focus({ preventScroll: true });
    },
    resume() { setPaused(false); },
    restart() { if (session && !session.online) startRide(session.def, { demo: session.demo }); },
    next() {
      if (!session) return;
      const i = STAGES.findIndex(s => s.id === session.def.id);
      startRide(i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : { ...ENDLESS, seed: (Date.now() % 100000) | 0 });
    },
    quit() { if (session?.online) { online.quitRace(); return; } stopMusic(false); endSession(); showGarage(); },
    fullscreen() { toggleFullscreen(); },
    // race friends (online.js)
    race() { online.open(); },
    raceCreate() { online.create(); },
    raceJoin() { online.joinTyped(); },
    raceLeave() { online.leave(); },
    raceNick(v) { online.nick(v); },
    raceStage(id) { online.stage(id); },
    raceStart() { online.start(); },
    raceCopy() { online.copy(); },
    // friends' ghosts
    ghosts() {
      ui.ghostMsg('share', ''); ui.ghostMsg('import', '');
      ui.renderGhosts(ghostsData());
      ui.show('ghosts');
      rivalsReady.then(() => { if (ui.screen === 'ghosts') ui.renderGhosts(ghostsData()); });
    },
    ghostName(v) { settings.ghostName = cleanName(v); persist(); ui.renderGhosts(ghostsData()); },
    async shareCopy(id) {
      try {
        const code = await shareCode(id);
        try {
          await navigator.clipboard.writeText(code);
          ui.ghostMsg('share', `Copied (${code.length.toLocaleString()} characters). Paste it to a friend.`, 'grn');
        } catch {
          ui.ghostMsg('share', 'The browser blocked the clipboard. Use Save file instead.', 'red');
        }
      } catch (e) { ui.ghostMsg('share', e instanceof GhostError ? e.message : 'Could not make a code for that run.', 'red'); }
    },
    async shareFile(id) {
      try {
        const code = await shareCode(id);
        const url = URL.createObjectURL(new Blob([code + '\n'], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url; a.download = fileName(id, settings.ghostName);
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        ui.ghostMsg('share', `Saved ${a.download}. Send the file to a friend.`, 'grn');
      } catch (e) { ui.ghostMsg('share', e instanceof GhostError ? e.message : 'Could not save that run.', 'red'); }
    },
    importPaste() { actions.importCode(ui.ghostInput.value); },
    async importCode(text) {
      try {
        const g = await decodeGhost(text, courseFor);
        adoptRival(g);
        const kept = storage.set(RIVAL(g.stageId), extractCode(text));
        ui.ghostInput.value = '';
        ui.ghostMsg('import', `Loaded ${g.name}'s ${fmtTime(g.timeMs / 1000)} on ${g.stageName}.` +
          (kept ? ' Ride that road to race it.' : ' Browser storage is blocked, so it lasts until you leave.'), 'grn');
      } catch (e) {
        ui.ghostMsg('import', e instanceof GhostError ? e.message : 'That code could not be read.', 'red');
      }
      ui.renderGhosts(ghostsData());
    },
    removeRival(id) {
      delete rivals[id];
      storage.remove(RIVAL(id));
      ui.ghostMsg('import', '');
      ui.renderGhosts(ghostsData());
      ui.root.querySelector('[data-s=ghosts] button:not(:disabled)')?.focus({ preventScroll: true });
    },
  };
  let settingsFrom = 'title';
  const ui = createUI(mount, actions);
  if (calibrate && storage.get(CALIB_KEY)) ui.calibLast(true);

  // ---------- kit models and the rider (assets.js) ----------
  // Fetched once per page; a ride waits for them. If they fail, the world uses its
  // procedural props and the bike its code-built rider (assets.js logs why) — never a
  // blank screen.
  let kit = null, kitF = 0, riderF = 0, bodyF = 0, bikeF = 0;
  const kitNote = document.createElement('div');
  kitNote.className = 'dim';
  kitNote.textContent = 'loading world…';
  ui.root.querySelector('.title .menu')?.after(kitNote);
  const loadNote = () => { kitNote.textContent = `loading world… ${Math.round((kitF + riderF + bodyF + bikeF) * 100 / 4)}%`; };
  const kitReady = Promise.all([
    loadKit(f => { kitF = f; loadNote(); }).then(k => { kit = k; }),
    loadRider(f => { riderF = f; loadNote(); }).then(r => !!r && mode !== 'destroyed' && (model.useRider(r), true)),
    loadBikeBody(f => { bodyF = f; loadNote(); }).then(b => !!b && mode !== 'destroyed' && model.useBody(b)),
    loadBikeModel(f => { bikeF = f; loadNote(); }).then(b => !!b && mode !== 'destroyed' && model.useBike(b)),
  ]).then(([, rider, body, bike]) => {
    kitNote.remove();
    if (!rider && !body && !bike) return;
    const g = model.bakeGhost();                     // the ghosts get the new body/rider too: baked, still one mesh
    ghostMesh.geometry = rivalMesh.geometry = g;
    ghostGeo.dispose(); ghostGeo = g;
  });

  function applySettings(key) {
    if (key === 'volume') audio?.setVolume(Number(settings.volume));
    if (key === 'quality') { session?.world.setQuality(settings.quality); resize(); }
    if (key === 'camera') camMode = settings.camera;
  }

  // ---------- sizing, fullscreen, dynamic resolution ----------
  let resScale = 1;
  function resize() {
    const fs = document.fullscreenElement === mount;
    cv.style.height = fs ? '100%' : 'auto';
    cv.style.aspectRatio = fs ? 'auto' : '16/9';
    const w = cv.clientWidth || 800, h = fs ? (cv.clientHeight || 450) : Math.round(w * 9 / 16);
    const base = Math.min(devicePixelRatio, settings.quality === 'high' ? 1.5 : 1);
    renderer.setPixelRatio(base * resScale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    garage.camera.aspect = w / h;
    garage.camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else mount.requestFullscreen?.().catch(() => {});
    } catch {}
  }

  // ---------- input: keyboard (shared service) + gamepad (polled) ----------
  const prev = new Set();
  let leanKey = 0;
  const ctl = { throttle: 0, brake: 0, lean: 0, tuck: false, wheelie: false, shiftUp: false, shiftDown: false };
  function pollInput(dt) {
    const k = c => input.isDown(c);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    const btn = i => !!(pad && pad.buttons[i] && pad.buttons[i].pressed);
    const val = i => (pad && pad.buttons[i] ? pad.buttons[i].value : 0);
    const now = new Set();
    const mark = (name, on) => { if (on) now.add(name); };
    mark('up', k('ArrowUp') || k('KeyW') || btn(12));
    mark('down', k('ArrowDown') || k('KeyS') || btn(13));
    mark('enter', k('Enter') || k('Space') || btn(0));
    mark('pause', k('Escape') || k('KeyP') || btn(9));
    mark('cam', k('KeyC') || btn(3));
    mark('respawn', k('KeyR') || btn(8));
    mark('fs', k('KeyF'));
    mark('sup', k('KeyE') || btn(5));
    mark('sdn', k('KeyQ') || btn(4));
    for (let v = 1; v <= 5; v++) mark('v' + v, k('Digit' + v) || k('Numpad' + v));   // music: sky 1–4, 5 = auto
    mark('song', k('KeyN'));                                                         // music: new scene now
    const edge = n => now.has(n) && !prev.has(n);
    const e = {
      up: edge('up'), down: edge('down'), enter: edge('enter'), pause: edge('pause'),
      cam: edge('cam'), respawn: edge('respawn'), fs: edge('fs'), shiftUp: edge('sup'), shiftDown: edge('sdn'),
      vibe: [1, 2, 3, 4, 5].find(v => edge('v' + v)) || 0, song: edge('song'),
    };
    prev.clear(); for (const n of now) prev.add(n);

    // riding controls
    const kThr = k('KeyW') || k('ArrowUp') ? 1 : 0, kBrk = k('KeyS') || k('ArrowDown') ? 1 : 0;
    const kLean = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    // Keys are on/off; ease the lean in so a tap is a small lean and a hold is a big one.
    const rate = kLean === 0 ? 5 : (Math.sign(kLean) !== Math.sign(leanKey) ? 7 : 2.6);
    leanKey += clamp(kLean - leanKey, -rate * dt, rate * dt);
    let padLean = 0;
    if (pad) {
      const ax = pad.axes[0] || 0;
      padLean = Math.abs(ax) < 0.12 ? 0 : Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.4;
    }
    ctl.throttle = Math.max(kThr, val(7));
    ctl.brake = Math.max(kBrk, val(6));
    ctl.lean = Math.abs(padLean) > Math.abs(leanKey) ? padLean : leanKey;
    ctl.tuck = k('Space') || btn(0);
    ctl.wheelie = k('ShiftLeft') || btn(1);         // assisted wheelie (physics.js owns the feel)
    // Latch shift taps: at >120 Hz some frames run no physics step, and a tap seen only
    // by such a frame would be lost. stepRide() clears them once used.
    if (e.shiftUp) ctl.shiftUp = true;
    if (e.shiftDown) ctl.shiftDown = true;
    return e;
  }

  // ---------- camera ----------
  // Helmet (cockpit) view: the eyes in the helmet's frame (m; +x the visor, +y up, from its
  // centre), the camera's offset from them in the bike's frame (m; +x forward, +y up), the
  // look-down (rad), the vertical FOV at rest and its widening at speed (deg), and the near
  // plane. The rider's eyes sit right above the grips, so the camera sits behind and above them
  // (a racing-game cockpit) with the head and torso hidden. ?canyondebug: window.__canyon.fpv.
  const FPV = { eye: new THREE.Vector3(0.08, 0.01, 0), back: new THREE.Vector3(-0.66, 0.14, 0), pitch: 0.32, fov: 80, fovGain: 4, near: 0.05 };
  let camMode = settings.camera;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmpV = new THREE.Vector3();
  let camYaw = 0, camInit = false, shake = 0, debugView = null, beatKick = 0;
  function updateCamera(b, dt, cinematic) {
    const fwdX = Math.cos(b.psi), fwdZ = Math.sin(b.psi);
    if (!camInit) { camYaw = b.psi; camInit = true; }
    camYaw += wrap(b.psi - camYaw) * Math.min(1, dt * (camMode === 'close' ? 6 : 4.2));
    const groundAt = (x, z) => session.course.groundAt(x, z);
    const fpv = camMode === 'helmet' && !cinematic && !b.crashed;
    if (fpv) {
      // From the rider's head (it follows lean and tuck), behind and above the eyes.
      model.eyeWorld(camPos, FPV.eye, FPV.back);
      camera.position.copy(camPos);
      camera.rotation.set(0, 0, 0, 'YXZ');
      camera.rotation.set(-FPV.pitch, -b.psi - Math.PI / 2, 0, 'YXZ');
      camera.rotateZ(-b.phi * 0.75);
      camera.near = FPV.near;
    } else {
      const dist = (camMode === 'close' ? 2.6 : 3.35) + b.v * (camMode === 'close' ? 0.008 : 0.014);
      const h = camMode === 'close' ? 1.15 : 1.62;           // chase sits a little higher (was 1.38)
      tmpV.set(b.x - Math.cos(camYaw) * dist, b.y + h, b.z - Math.sin(camYaw) * dist);
      const g = groundAt(tmpV.x, tmpV.z);
      if (tmpV.y < g + 0.6) tmpV.y = g + 0.6;
      if (!camPos.lengthSq() || camPos.distanceToSquared(tmpV) > 400) camPos.copy(tmpV);
      camPos.lerp(tmpV, Math.min(1, dt * 9));
      camera.position.copy(camPos);
      if (shake > 0) {
        camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake;
        shake = Math.max(0, shake - dt * 0.8);
      }
      camera.position.y -= 0.04 * beatKick;              // music: a small dip on strong beats
      camLook.set(b.x + fwdX * 4, b.y + (camMode === 'close' ? 0.9 : 0.78), b.z + fwdZ * 4); // chase looks down ~6 deg (was ~4)
      camera.up.set(0, 1, 0);
      camera.lookAt(camLook);
      if (settings.tilt === 'on') camera.rotateZ(-b.phi * 0.22);
      camera.near = 0.1;
    }
    if (debugView) {
      // Debug only: a camera at (back, up, side) metres from the bike, looking at it.
      const [bk, up, sd] = debugView;
      camera.position.set(b.x - fwdX * bk - fwdZ * sd, b.y + up, b.z - fwdZ * bk + fwdX * sd);
      camera.up.set(0, 1, 0);
      camera.lookAt(b.x, b.y, b.z);
    }
    const fov = (fpv ? FPV.fov : 55) + clamp(b.v / 66, 0, 1) * (fpv ? FPV.fovGain : 12) + 1.2 * beatKick;
    if (Math.abs(camera.fov - fov) > 0.05) camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
    model.cockpit(fpv);
  }

  // ---------- sparks (knee sliders, footpegs, crashes) ----------
  const SPARKS = 160;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(SPARKS * 3), sparkVel = new Float32Array(SPARKS * 3), sparkLife = new Float32Array(SPARKS);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparkMat = new THREE.PointsMaterial({ color: 0xffb347, size: 0.07, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  let sparkNext = 0;
  function emitSpark(p, vx, vz, n) {
    for (let k = 0; k < n; k++) {
      const i = sparkNext++ % SPARKS;
      sparkPos[i * 3] = p.x; sparkPos[i * 3 + 1] = p.y; sparkPos[i * 3 + 2] = p.z;
      sparkVel[i * 3] = vx * (0.6 + Math.random() * 0.5) + (Math.random() - 0.5) * 3;
      sparkVel[i * 3 + 1] = 1 + Math.random() * 2.5;
      sparkVel[i * 3 + 2] = vz * (0.6 + Math.random() * 0.5) + (Math.random() - 0.5) * 3;
      sparkLife[i] = 0.25 + Math.random() * 0.35;
    }
  }
  function updateSparks(dt) {
    for (let i = 0; i < SPARKS; i++) {
      if (sparkLife[i] <= 0) { sparkPos[i * 3 + 1] = -1e5; continue; }
      sparkLife[i] -= dt;
      sparkVel[i * 3 + 1] -= 9.8 * dt;
      sparkPos[i * 3] += sparkVel[i * 3] * dt; sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt; sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
    }
    sparkGeo.attributes.position.needsUpdate = true;
  }

  // ---------- the ride session ----------
  let mode = 'garage';          // garage | loading | countdown | ride | finished | paused
  let pausedFrom = null;
  let session = null;
  const scene = new THREE.Scene();
  const online = createOnline({
    ui, scene, storage, ghostGeo: () => ghostGeo,
    startRide: (def, race) => startRide(def, { online: race }),
    toLobby: () => { endSession(); showGarage(); },
    riding: () => (session && session.online ? session : null),
  });

  function startRide(def, { demo = false, online = null } = {}) {
    if (!def) return;
    endSession();
    mode = 'loading';
    ui.show(null);
    ui.loading(true);
    ui.hud.show(false);
    // Two frames so the loading screen actually paints before the heavy build.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mode !== 'loading') return;              // quit (or destroyed) while loading
      kitReady.then(() => { if (mode === 'loading') buildSession(def, demo, online); });
    }));
  }

  // online: an online race (online.js) — same ride, no traffic, no ghosts, a shared green light.
  function buildSession(def, demo, online = null) {
    // Ride to my music: only a solo Endless that asked for it, with the music still on.
    const musicOn = !!(def.music && music && !demo && !online);
    if (!musicOn) stopMusic(false);
    const course = makeCourse(musicOn ? { ...def, director: () => music?.want ?? null } : def);
    const world = createWorld(scene, renderer, course, { quality: settings.quality, kit });
    garage.scene.remove(model.group);
    scene.add(model.group, model.riderWorld, sparks, ghostMesh, rivalMesh);
    const bike = createBike();
    placeBike(bike, course.road, course.startS, 1.75);
    world.prewarm({ x: bike.x, y: bike.y, z: bike.z, s: bike.s, fx: Math.cos(bike.psi), fz: Math.sin(bike.psi) });
    const medals = course.endless ? null : medalTimes(course.road, course.startS, course.length);
    const traffic = settings.traffic === 'on' && !online
      ? createTraffic(scene, course, { density: musicOn ? trafficFor(music.want.bpm) : def.traffic ?? 0.7, seed: def.seed })
      : null;
    // ghost of the best run on this stage
    let ghost = null;
    if (!course.endless && settings.ghost === 'on' && !demo && !online) {
      try {
        const raw = storage.get(GHOST(def.id));
        if (raw) ghost = b64ToF32(raw);
      } catch { ghost = null; }
    }
    // a friend's ghost on this stage (shown whatever the own-ghost setting says:
    // loading one is asking to race it)
    const rival = !course.endless && !demo && !online ? rivals[def.id] || null : null;
    if (rival) setTag(rival.name);
    const rec = store.records[def.id] || {};
    session = {
      def, demo, course, world, bike, medals, traffic, ghost, rival,
      drive: demo ? makeAutopilot(course, { pace: 0.88 }) : null,
      t: 0, clock: -3.2, acc: 0, cp: 0, splits: [], bestSplits: rec.splits || null,
      score: 0, pending: 0, combo: 1, clean: true,
      lean: { L: 0, R: 0 }, top: 0, wheelieT: 0, misses: 0, crashes: 0,
      rec: [], recClock: 0, hist: [], histClock: 0,
      laneT: 0, laneWarned: false, kneeCool: 0, wheelieShown: false, wrongT: 0, offT: 0,
      nextCp: course.endless ? 1500 : course.checkpoints[0], finished: false, finishT: 0,
      mapClock: 0, events: { hit: false, nearMiss: [] }, online,
      musicOn, musicPending: null, musicT: 0,
    };
    ui.musicMode(musicOn);
    ui.calibMode(musicOn && !!calib);
    if (musicOn && calib) {                      // calibrating: the autopilot rides, hands-off
      const pilot = makeAutopilot(course, { pace: 0.88 }), me = session;
      session.calibBot = true;
      session.bot = b => pilot(b, passLane(me, b));
    }
    if (online) { session.clock = (performance.now() - online.goAt) / 1000; ui.onlineMode(true); }
    camInit = false; camPos.set(0, 0, 0);
    world.setQuality(settings.quality);
    resize();
    ui.loading(false);
    ui.hud.show(true);
    ui.hud.split('');
    shell.setScore(0);
    shell.setStatus(demo ? 'Demo lap — the autopilot is riding. Esc to stop.' : 'W/↑ throttle · S/↓ brake · A/D lean · Space tuck · Shift wheelie · C camera · Esc pause' + (musicOn ? ' · 1–4 sky · 5 auto · N new scene' : ''));
    mode = 'countdown';
    audio?.resume();
  }

  function endSession() {
    if (!session) return;
    if (session.course.endless && !session.demo && !session.calibBot) {
      const er = store.records.endless || {};
      const dist = session.bike.s - session.course.startS;
      store.records.endless = { bestDist: Math.max(er.bestDist || 0, dist), bestScore: Math.max(er.bestScore || 0, session.score) };
      persist();
    }
    if (session.musicOn) { ui.musicMode(false); beatKick = 0; }
    session.world.destroy();
    session.traffic?.destroy();
    if (session.online) { online.endRide(); ui.onlineMode(false); }
    model.attach();
    scene.remove(model.group, model.riderWorld, sparks, ghostMesh, rivalMesh);
    session = null;
  }

  function showGarage() {
    mode = 'garage';
    ghostMesh.visible = rivalMesh.visible = false;
    garage.scene.add(model.group);
    model.group.position.set(0, 0, 0);
    model.group.rotation.set(0, 0, 0);
    ui.hud.show(false);
    ui.countdown('');
    ui.show('title');
    shell.setStatus('660 cc superbike — choose a road');
  }

  function setPaused(p) {
    if (p && (mode === 'ride' || mode === 'countdown')) {
      pausedFrom = mode; mode = 'paused';
      ui.show('pause');
      audio?.suspend();
    } else if (!p && mode === 'paused') {
      mode = pausedFrom; ui.show(null);
      audio?.resume();
      prevTime = performance.now();
    }
  }

  // ---------- ride to my music ----------
  // The share picker comes first: Chrome only opens it with this click's activation.
  // Anything that goes wrong lands on the music screen, with what to do about it.
  let music = null, musicBusy = false;
  let calib = null, lastCalib = null, calibBackupAt = 0;
  const musicDef = () => ({ ...ENDLESS, name: 'Ride to my music', seed: (Date.now() % 100000) | 0, music: true });
  const trafficFor = bpm => 0.45 + 0.75 * clamp((bpm - 80) / 90, 0, 1);     // 0.45 (slow) … 1.2 (fast)
  async function startMusicRide() {
    if (musicBusy) return;
    musicBusy = true;
    ui.musicMsg('');
    try {
      const stream = await pickMusicTab();
      await beginMusic(stream);
      startRide(musicDef());
    } catch (e) {
      ui.musicMsg(e instanceof MusicError ? e.message : 'Something went wrong starting the music. Try again.', 'red');
      if (!(e instanceof MusicError)) console.warn('Canyon: music mode failed to start', e);
      ui.show('music');
    } finally { musicBusy = false; }
  }
  // source: the shared tab's stream, or (test hook) a generated AudioBuffer.
  async function beginMusic(source) {
    await audioPromise;
    if (!audio) {
      if (source instanceof MediaStream) source.getTracks().forEach(t => t.stop());
      throw new MusicError('nosound', 'The game\u2019s sound didn\u2019t start, so it can\u2019t listen either. Reload the page and try again.');
    }
    stopMusic(false);
    calib = calibrate ? createCalibration({ sampleRate: audio.context.sampleRate, now: () => performance.now() }) : null;
    calibBackupAt = performance.now();
    music = await createMusic(audio.context, source, {
      onEnded: () => stopMusic(true),
      onEvent: calib && (ev => calib?.event(ev)),
      onPush: calib && calibTick,
    });
    audio.setDuck(Number(settings.musicEngine));
    audio.resume();
  }
  // Stop listening (Stop button, Chrome's Stop sharing bar, leaving). A ride carries on
  // as plain Endless: land already made keeps its scene, new land is the usual mix.
  function stopMusic(tell) {
    if (!music) return;
    music.stop();
    music = null;
    if (calib) finishCalib();
    audio?.setDuck(1);
    beatKick = 0;
    const s = session;
    if (s?.musicOn) {
      s.musicOn = false;
      s.world.music(0, 1);
      s.world.setSky(null); s.sky = null;
      s.traffic?.setDensity(s.def.traffic ?? 0.7);
      ui.musicMode(false);
      if (tell) ui.message('MUSIC STOPPED', 'warn');
      shell.setStatus('W/↑ throttle · S/↓ brake · A/D lean · Space tuck · Shift wheelie · C camera · Esc pause');
    }
  }
  // Calibration: a sample a second (driven by the audio blocks, so it keeps going while
  // the tab is in the background), a localStorage backup every 30 s.
  function calibTick() {
    if (!calib || !music) return;
    const st = music.status;
    calib.tick(music.analyzer, st.vibe, st.override, music.scenes);
    if (performance.now() - calibBackupAt > 30000) { calibBackupAt = performance.now(); backupCalib(calib); }
  }
  const backupCalib = c => storage.set(CALIB_KEY, JSON.stringify(c.data()));
  // The music stopped (Stop, Chrome's Stop sharing, leaving): back it up and offer the file.
  function finishCalib() {
    const c = calib;
    calib = null;
    ui.calibMode(false);
    if (!c.count) return;
    lastCalib = c;
    backupCalib(c);
    ui.calibLast(true);
    downloadJson(c.fileName(), c.data());
    if (session) ui.message('CALIBRATION SAVED', 'gold');
  }
  function downloadJson(name, obj) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // A new scene (the rolling window moved into another box, a new song's window filled,
  // or the player picked one): dress the land ahead for it if that's still out of sight,
  // else cut again if where you're heading doesn't match.
  function settleVibe(s) {
    const p = s.musicPending, b = s.bike, want = music.want.vibe;
    const ahead = p && p.s0 > b.s;
    if (ahead && s.course.musicRedress(p, b.s)) return;
    const reg = s.course.regionAt(ahead ? p.s0 + 1 : b.s);
    if (reg && reg.vibe !== want) s.musicPending = s.course.musicCut(b.s);
  }
  // Every frame of a music ride: song events, then the beat into the lights and HUD.
  function frameMusic(s, dt) {
    for (const ev of music.drain()) {
      // A new song only restarts the window; its tunnel waits for its scene (the 'scene'
      // event ~10 s in). Cutting at once dressed the land past the tunnel for the OLD
      // scene, and at speed it was too close to re-dress by the time the new one came.
      if (ev.type === 'scene') settleVibe(s);
      else if (ev.type === 'pause') ui.message('MUSIC PAUSED', 'warn');
    }
    fadeSky(s, dt);
    const v = music.frame(performance.now(), dt);
    s.world.music(v.pulse, v.light);
    ui.hud.beat(v.pulse);
    beatKick = settings.musicKick === 'on' ? v.kick : 0;
    s.musicT += dt;
    if (s.musicT > 1) { s.musicT = 0; s.traffic?.setDensity(trafficFor(music.want.bpm)); }
    ui.hud.music(s.skyPick ? { ...music.status, vibe: s.skyPick, scene: SCENE_NAME[s.skyPick] + ' sky', override: true, listening: false } : music.status);
    if (calib) ui.hud.calib(calibLabel(calib.seconds, calib.songs));
  }
  // The sky (time of day + weather) follows the scene straight away, over SKY_FADE_S; the
  // land still waits for the scene's tunnel, which has to start past the built road.
  const SKY_FADE_S = 10;
  const skyOf = v => { const V = VIBE_PARTS[v]; return { tod: V.tod[V.tod.length - 1], weather: V.weather[0] }; };
  function fadeSky(s, dt) {
    const ready = music.scenes.ready || music.status.override || s.skyPick;
    if (!ready && !s.sky) return;                              // first window still filling: the road's sky
    const want = s.skyPick || music.want.vibe;
    if (!s.sky) {
      // Start from what's on screen now: the road's time of day and weather here.
      const tm = s.course.todAt(s.bike.s), w = s.course.weatherAt(s.bike.s);
      s.sky = { scene: null, from: { tod: tm.t < 0.5 ? tm.a : tm.b, weather: { ...w } }, to: null, t: 1,
        out: { tod: { a: '', b: '', t: 0 }, weather: { rain: 0, fog: 0, overcast: 0 } } };
      s.sky.to = s.sky.from;
    }
    const k = s.sky;
    if (k.scene !== want) {
      if (k.to) k.from = k.t < 0.5 ? k.from : k.to;            // mid-fade: start from the nearer end
      k.to = skyOf(want); k.scene = want; k.t = 0;
    }
    k.t = Math.min(1, k.t + dt / SKY_FADE_S);
    const e = k.t * k.t * (3 - 2 * k.t), A = k.from.weather, B = k.to.weather;
    k.out.tod.a = k.from.tod; k.out.tod.b = k.to.tod; k.out.tod.t = e;
    k.out.weather.rain = A.rain + (B.rain - A.rain) * e;
    k.out.weather.fog = A.fog + (B.fog - A.fog) * e;
    k.out.weather.overcast = A.overcast + (B.overcast - A.overcast) * e;
    s.world.setSky(k.out);
  }
  // N: a different scene now — what the music measures if that differs, else the next one.
  function newScene(s) {
    const cur = music.want.vibe, box = music.scenes.box;
    const next = box && box !== cur ? box : VIBES[(VIBES.indexOf(cur) + 1) % VIBES.length];
    s.skyPick = null;                                          // N also hands the sky back to the music
    if (music.want.vibe === next && music.status.override) return;
    music.setOverride(next);
    ui.message(`SCENE: ${SCENE_NAME[next].toUpperCase()}`, 'gold');
    settleVibe(s);
  }
  // Keys 1–4: the sky only (time of day + weather), at once; the land keeps following the
  // music. Holds until N. (They used to set the scene, whose land starts ~1.5 km ahead, so a
  // press showed nothing for a minute and looked broken.)
  function pickVibe(s, k) {
    if (k === 5) {                                             // 5: everything back to the music
      s.skyPick = null;
      music.clearOverride();
      ui.message('AUTO: FOLLOWING THE MUSIC', 'gold');
      settleVibe(s);
      return;
    }
    const v = VIBES[k - 1];
    if (s.skyPick === v) return;
    s.skyPick = v;
    ui.message(`SKY: ${SCENE_NAME[v].toUpperCase()}`, 'gold');
  }

  // --- scoring helpers ---
  function addPoints(n) { if (!session.demo) session.pending += Math.round(n * session.combo); }
  function bank(atCheckpoint) {
    const s = session;
    s.score += s.pending;
    s.pending = 0;
    if (atCheckpoint && s.clean) s.combo = Math.min(5, s.combo + 1);
    s.clean = true;
    shell.setScore(s.score);
  }

  // --- respawn: back to where you were ~3 s ago, in your lane, slowly ---
  function respawn() {
    const s = session, b = s.bike;
    let back = s.hist.length ? s.hist[0] : { s: Math.max(s.course.startS, b.s - 60), v: 10 };
    for (let k = s.hist.length - 1; k >= 0; k--) if (s.t - s.hist[k].t > 3) { back = s.hist[k]; break; }
    placeBike(b, s.course.road, Math.max(s.course.startS, back.s), 1.75, Math.min(12, back.v));
    s.traffic?.clearNear(back.s);
    s.hist.length = 0;
    camInit = false;
    s.wrongT = 0; s.offT = 0;
    s.rag = null;
    model.attach();
  }

  function onCrash(why) {
    const s = session;
    s.crashes++;
    s.crashT = 0;
    if (s.pending > 0) ui.message(`−${s.pending.toLocaleString()} unbanked`, 'warn');
    s.pending = 0; s.combo = 1; s.clean = false;
    ui.message(why || 'Crashed', 'warn', true);
    audio?.crash();
    shake = 0.25;
    const b = s.bike;
    model.lean.updateMatrixWorld(true);
    emitSpark(new THREE.Vector3(b.x, b.y + 0.3, b.z), Math.cos(b.psi) * b.v * 0.5, Math.sin(b.psi) * b.v * 0.5, 40);
    // The rider comes off: from the riding pose, at the speed the bike had.
    const v = b.vCrash ?? b.v, fx = Math.cos(b.psi), fz = Math.sin(b.psi);
    s.ragO = { x: b.x, y: b.y, z: b.z };
    s.ragHints = new Int32Array(JOINTS.length).fill(b.hint);
    s.ragPsi = b.psi;
    s.rag = createRagdoll(model.detach(b.x, b.y, b.z), [fx * v, b.vy || 0, fz * v],
      { kind: b.crashKind || crashKind(why), side: Math.sign(b.phi) || 1, fwd: [fx, fz], dt: STEP });
  }

  // The ragdoll's view of the world: the ground under each point, and the same
  // walls and guardrails that stop the bike (a rail only stops what's below its top).
  const rq = {};
  function ragSurface(i, P, k) {
    const s = session, O = s.ragO, c = s.course;
    const q = c.road.track(P[k] + O.x, P[k + 2] + O.z, s.ragHints[i], rq);
    s.ragHints[i] = q.i;
    const edge = q.hw + q.sh - 0.15, side = q.d > 0 ? 1 : -1;
    if (Math.abs(q.d) > edge) {
      const kind = c.barrierAt(q.i, side);
      if (kind && (kind === 'wall' || P[k + 1] + O.y - q.y < 1.0)) {
        const back = (Math.abs(q.d) - edge) * side;
        P[k] += Math.sin(q.psi) * back;
        P[k + 2] -= Math.cos(q.psi) * back;
        q.d = side * edge;
      }
    }
    // A tunnel's roof (the arch in world.js) as well as its walls.
    const f = c.featureAt(q.s);
    if (f && f.type === 'tunnel') {
      const W = q.hw + q.sh + 0.25, dd = Math.min(Math.abs(q.d), W);
      const roof = q.y + 4.3 + 2.9 * Math.sqrt(1 - (dd / W) ** 2) - 0.25 - O.y;
      if (P[k + 1] > roof) P[k + 1] = roof;
    }
    return groundAt(c, q, P[k] + O.x, P[k + 2] + O.z) - O.y;
  }
  // What the camera follows during a crash: the rider, from the way you were going.
  const ragFocus = { x: 0, y: 0, z: 0, psi: 0, v: 12, phi: 0, crashed: true };
  function crashFocus(s) {
    s.rag.center(ragFocus);
    ragFocus.x += s.ragO.x; ragFocus.y += s.ragO.y; ragFocus.z += s.ragO.z;
    ragFocus.psi = s.ragPsi;
    return ragFocus;
  }

  // Pass slower cars on the inside of our own lane, like a considerate rider.
  function passLane(s, b) {
    if (s.traffic) for (const c of s.traffic.cars) if (c.dir > 0 && c.s - b.s > -7 && c.s - b.s < 55) return 0.55;
    return 1.75;
  }
  // One fixed physics step of the ride.
  const kneeW = new THREE.Vector3();
  function stepRide(dt) {
    const s = session, b = s.bike;
    const aids = AIDS[settings.aids];
    let inp = ctl;
    if (s.bot) inp = s.bot(b);                     // debug: autopilot on a scored run
    if (s.demo) inp = s.drive(b, passLane(s, b));
    if (s.finished) inp = { throttle: 0, brake: b.v > 3 ? 0.35 : 0, lean: s.drive ? s.drive(b).lean : 0, tuck: false };
    const wasCrashed = b.crashed;
    stepBike(b, inp, s.course, { aids: s.demo || s.calibBot ? AIDS.full : aids, auto: s.demo || s.calibBot || settings.gearbox === 'auto' });
    ctl.shiftUp = ctl.shiftDown = false;
    s.t += dt;
    if (!s.finished) s.clock += dt;
    if (b.crashed && !wasCrashed) onCrash(b.crashWhy);
    // Ghost recording runs through crashes too: the clock does, and a ghost that
    // skipped them would drift ahead of the time it claims.
    s.recClock += dt;
    if (!s.finished && s.recClock >= 1 / GHOST_HZ && s.rec.length < GHOST_HZ * 600 * 6) {
      s.recClock -= 1 / GHOST_HZ;
      s.rec.push(b.x, b.y, b.z, b.psi, b.phi, b.pitch);
    }
    if (b.crashed) {
      s.crashT += dt;
      s.rag?.step(dt, ragSurface);
      // Back on the bike once the rider has come to rest (R skips the wait).
      if (s.rag ? (s.rag.settled && s.crashT > 1.6) || s.crashT > 4.5 : s.crashT > 2.3) respawn();
      return;
    }

    // history for respawning (on the road, upright-ish)
    s.histClock += dt;
    if (s.histClock > 0.25) {
      s.histClock = 0;
      if (b.onRoad && Math.abs(b.d) < b.hw) { s.hist.push({ t: s.t, s: b.s, v: b.v }); if (s.hist.length > 40) s.hist.shift(); }
    }

    // stats
    s.top = Math.max(s.top, b.v);
    if (b.phi < 0) s.lean.L = Math.max(s.lean.L, -b.phi / DEG); else s.lean.R = Math.max(s.lean.R, b.phi / DEG);
    if (s.demo && !s.course.endless && b.s >= s.course.length) s.demoDone = true;
    if (s.demo || s.finished) return;

    // --- style points ---
    const leanDeg = Math.abs(b.phi) / DEG;
    if (leanDeg > 35 && b.surface !== 'gravel' && b.surface !== 'dirt') addPoints(((leanDeg - 35) / 10) ** 2 * 120 * (b.v / 30) * dt);
    s.kneeCool -= dt;
    if (leanDeg > 42 && b.v > 12) {
      if (s.kneeCool <= 0) { ui.message('KNEE DOWN', 'gold'); addPoints(60); }
      s.kneeCool = 2.5;
    }
    if (b.pitch > 4 * DEG) {
      s.wheelieT += dt;
      addPoints(80 * dt);
      if (!s.wheelieShown && b.pitch > 6 * DEG) { s.wheelieShown = true; ui.message('WHEELIE', 'gold'); }
    } else s.wheelieShown = false;
    // lane discipline: across the double yellow for more than ~0.8 s
    if (b.d < -0.2 && b.onRoad) {
      s.laneT += dt;
      if (s.laneT > 0.8 && !s.laneWarned) {
        s.laneWarned = true; s.clean = false;
        if (s.combo > 1) { s.combo = 1; ui.message('STAY IN YOUR LANE — combo lost', 'warn'); }
        else ui.message('STAY IN YOUR LANE', 'warn');
        audio?.chime('warn');
      }
    } else { s.laneT = 0; s.laneWarned = false; }
    // wrong way / lost
    const rel = Math.abs(wrap(b.psi - b.roadPsi));
    s.wrongT = rel > 1.9 && b.v > 2 ? s.wrongT + dt : 0;
    if (s.wrongT > 1.2 && s.wrongT - dt <= 1.2) ui.message('WRONG WAY', 'warn', true);
    if (s.wrongT > 5) respawn();
    s.offT = Math.abs(b.d) > b.edge + 18 ? s.offT + dt : 0;
    if (s.offT > 2.5) respawn();

    // --- checkpoints ---
    if (b.s >= s.nextCp) {
      if (s.course.endless) {
        addPoints(150);                       // distance bonus per 1.5 km
        bank(true);
        ui.message(`CHECKPOINT · ×${s.combo}`, 'good');
        audio?.chime('checkpoint');
        s.nextCp += 1500;
      } else {
        const k = s.cp;
        s.splits.push(s.clock);
        bank(true);
        const last = k === s.course.checkpoints.length - 1;
        if (s.bestSplits && s.bestSplits[k] != null) {
          const d = s.clock - s.bestSplits[k];
          ui.hud.split(`${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`, d < 0 ? 'grn' : 'red');
        } else ui.hud.split(fmtTime(s.clock), '');
        if (last) finish();
        else {
          ui.message(`CHECKPOINT ${k + 1} · ×${s.combo}`, 'good');
          audio?.chime('checkpoint');
          s.cp++;
          s.nextCp = s.course.checkpoints[s.cp];
        }
      }
    }
    // knee slider and footpeg sparks
    if (leanDeg > 44 && b.v > 10) {
      const side = b.phi > 0 ? 'R' : 'L';
      model.sliderWorld(side, kneeW);
      if (Math.random() < 0.6) emitSpark(kneeW, -Math.cos(b.psi) * 2, -Math.sin(b.psi) * 2, 1);
    }
  }

  function finish() {
    const s = session;
    s.finished = true;
    s.finishT = 0;
    if (!s.drive) s.drive = makeAutopilot(s.course, { pace: 0.3 });
    const t = s.clock, m = s.medals;
    const medal = t <= m.gold ? 'gold' : t <= m.silver ? 'silver' : t <= m.bronze ? 'bronze' : null;
    const rec = store.records[s.def.id] || {};
    const newBest = !rec.best || t < rec.best;
    const rank = x => ({ gold: 3, silver: 2, bronze: 1 }[x] || 0);
    if (newBest) {
      rec.best = t;
      rec.splits = s.splits.slice();
      try { storage.set(GHOST(s.def.id), f32ToB64(s.rec)); } catch {}
    }
    let rivalLine = '';
    if (s.rival) {
      const rt = s.rival.timeMs / 1000, d = t - rt, who = s.rival.name;
      rivalLine = Math.abs(d) < 0.005 ? `Dead heat with ${who} at ${fmtTime(rt)}`
        : d < 0 ? `Beat ${who}'s ${fmtTime(rt)} by ${(-d).toFixed(2)} s`
        : `${who} was ${d.toFixed(2)} s quicker (${fmtTime(rt)})`;
    }
    if (rank(medal) > rank(rec.medal)) rec.medal = medal;
    rec.bestScore = Math.max(rec.bestScore || 0, s.score);
    store.records[s.def.id] = rec;
    persist();
    audio?.chime(newBest ? 'best' : 'checkpoint');
    ui.message(newBest ? 'NEW BEST' : 'FINISH', newBest ? 'gold' : 'good', true);
    const sp = v => settings.units === 'mph' ? `${Math.round(v * 2.23694)} mph` : `${Math.round(v * 3.6)} km/h`;
    s.result = {
      title: s.def.name, medal, newBest,
      time: fmtTime(t), score: s.score.toLocaleString(), top: sp(s.top),
      lean: `${Math.round(s.lean.L)}° / ${Math.round(s.lean.R)}°`, wheelie: `${s.wheelieT.toFixed(1)} s`,
      misses: String(s.misses), rival: rivalLine,
      targets: `Gold ${fmtTime(m.gold)} · Silver ${fmtTime(m.silver)} · Bronze ${fmtTime(m.bronze)}${s.crashes ? ` · ${s.crashes} crash${s.crashes > 1 ? 'es' : ''}` : ''}`,
    };
    if (s.online) online.finished(t, s.result);
  }

  // ---------- per-frame ride update ----------
  const scratch = [];
  // Debug-only section timer (?canyondebug): where does a frame's time go?
  const perf = { frames: 0 };
  let pt = 0;
  const mark = name => { if (!debug) return; const t = performance.now(); perf[name] = (perf[name] || 0) + t - pt; perf[name + ' max'] = Math.max(perf[name + ' max'] || 0, t - pt); pt = t; };
  function frameRide(dt, time) {
    const s = session, b = s.bike;
    if (debug) { pt = performance.now(); perf.frames++; }
    if (mode === 'countdown') {
      if (s.online) s.clock = (performance.now() - s.online.goAt) / 1000;   // everyone's green light at once
      else s.clock += dt;
      const n = Math.ceil(-s.clock);
      if (n !== s.lastCount) {
        s.lastCount = n;
        if (n > 0 && n <= 3) { ui.countdown(String(n)); audio?.chime('count'); }
      }
      // Launch control: holding the throttle on the line keeps revs at ~9,000.
      b.rpm += ((ctl.throttle > 0.5 && !s.demo ? 9000 : 1300) - b.rpm) * Math.min(1, dt * 6);
      if (s.clock >= 0) {
        if (!s.online) s.clock = 0;
        mode = 'ride';
        ui.countdown('GO'); audio?.chime('go');
        setTimeout(() => { if (mode === 'ride' || mode === 'finished') ui.countdown(''); }, 700);
      }
    } else if (mode === 'ride') {
      s.acc += dt;
      let n = 0;
      while (s.acc >= STEP && n < 24) { stepRide(STEP); s.acc -= STEP; n++; }
      mark('physics');
      // traffic + near misses
      if (s.traffic && !b.crashed) {
        s.events.hit = false; s.events.nearMiss.length = 0;
        s.traffic.update(dt, b, s.events);
        if (s.events.hit && !s.demo) { crash(b, 'Hit a car'); onCrash('Hit a car'); }
        else if (s.events.hit && s.demo) { s.traffic.clearNear(b.s); }
        for (const m of s.events.nearMiss) {
          if (s.demo) continue;
          const pts = Math.round(150 + 350 * (1 - m.gap / 1.1));
          addPoints(pts);
          s.misses++;
          ui.message(`NEAR MISS +${Math.round(pts * s.combo)}`, 'gold');
          audio?.chime('miss');
        }
      }
      if (s.finished) {
        s.finishT += dt;
        if (s.finishT > 2.2 && !s.resultShown) {
          s.resultShown = true;
          mode = 'finished';
          ui.hud.show(false);
          if (s.online && !s.online.lost) online.showBoard();
          else { ui.results(s.result); ui.show('results'); }
        }
      }
    }
    if (mode === 'finished') {
      s.acc += dt;
      while (s.acc >= STEP) { stepRide(STEP); s.acc -= STEP; }
    }
    s.traffic?.render();
    mark('traffic');

    // world, model, camera
    const fx = Math.cos(b.psi), fz = Math.sin(b.psi);
    s.world.update({ x: b.x, y: b.y, z: b.z, s: b.s, fx, fz }, time);
    if (s.musicOn && music) frameMusic(s, dt);
    mark('world');
    const night = s.world.env.headlight;
    model.update(b, { dt, tuck: ctl.tuck || (s.demo && b.v > 30), wheelie: b.wAssist ? clamp(b.pitch / (WHEELIE_ASSIST_DEG * DEG), 0, 1) : 0, braking: (s.demo ? false : ctl.brake > 0.1) || b.ax < -3, night, gradeAngle: Math.atan(b.grade) });
    model.dash(b.v * (settings.units === 'mph' ? 2.23694 : 3.6), settings.units === 'mph', b.v < 0.3 && b.gear === 0 ? 0 : b.gear + 1, b.rpm);   // redraws only on a change, <= 12 Hz
    // Crashed: the rider tumbles on their own, the camera follows them, and the bike
    // throws sparks for as long as it's still sliding.
    const rag = b.crashed && s.rag;
    if (rag) {
      model.ragdoll(s.rag.P);
      if (b.v > 3 && Math.random() < 0.8) emitSpark({ x: b.x, y: b.y + 0.12, z: b.z }, Math.cos(b.psi) * b.v * 0.6, Math.sin(b.psi) * b.v * 0.6, 2);
    }
    mark('model');
    const focus = rag ? crashFocus(s) : b;
    updateCamera(focus, dt, s.demo);
    s.world.follow(camera, time, focus.y);
    s.world.shadowAt(focus.x, focus.y, focus.z);

    // ghost playback
    const racing = mode === 'ride' || mode === 'countdown';
    ghostMesh.visible = !!(s.ghost && s.ghost.length >= 12 && racing);
    if (ghostMesh.visible) poseGhost(ghostMesh, s.ghost, s.clock);
    rivalMesh.visible = !!(s.rival && racing);
    if (rivalMesh.visible) poseGhost(rivalMesh, s.rival.samples, s.clock);
    if (s.online) online.frame(s, dt);

    mark('camera+ghost');
    updateSparks(dt);
    // audio
    audio?.update({
      rpm: b.rpm, load: b.crashed ? 0 : Math.max(b.thr, 0.04), cut: b.cut > 0 || b.limiterT > 0,
      v: b.v, usage: b.usage, surface: b.surface, scrape: b.scrape > 0, airborne: b.airborne, crashed: b.crashed,
      rain: s.world.env.rain, tunnel: s.world.env.tunnel,
    });
    // Endless: say so when the land, the weather or a town changes.
    if (s.course.endless && mode === 'ride') {
      const reg = s.course.regionAt(b.s), f = s.course.featureAt(b.s), wx = s.course.weatherAt(b.s);
      // (Through a tunnel, the new land is announced as you come out into it.)
      if (reg && reg !== s.region && s.course.tunnelAt(b.s) === 0) {
        if (s.region) ui.message(reg.name.toUpperCase(), 'good');
        s.region = reg;
      }
      if (f && f.type === 'town' && s.town !== f) { s.town = f; ui.message(f.name.toUpperCase(), 'gold'); }
      const wet = wx.rain > 0.4, foggy = wx.fog > 0.5;
      if (wet && !s.wet) ui.message('RAIN — LESS GRIP', 'warn');
      else if (foggy && !s.foggy) ui.message('FOG', 'warn');
      s.wet = wet; s.foggy = foggy;
    }

    // HUD
    if (mode === 'ride' || mode === 'countdown' || (mode === 'finished' && !s.resultShown)) {
      const mph = settings.units === 'mph';
      const m = s.medals;
      let target = '';
      if (m && !s.demo) {
        const next = s.clock <= m.gold ? ['Gold', m.gold] : s.clock <= m.silver ? ['Silver', m.silver] : s.clock <= m.bronze ? ['Bronze', m.bronze] : null;
        target = next ? `${next[0]} ${fmtTime(next[1])}` : 'No medal this run';
      }
      const aids = AIDS[s.demo ? 'full' : settings.aids];
      let rival = '';
      if (s.rival) {
        // When did the rival first reach where I am now? Same sign as the splits:
        // − means I'm ahead.
        const R = s.rival.reach;
        if (mode === 'countdown' || b.s <= R[0]) rival = `vs ${s.rival.name} · ${fmtTime(s.rival.timeMs / 1000)}`;
        else {
          let lo = 0, hi = R.length - 1;
          if (b.s >= R[hi]) lo = hi;
          else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (R[mid] <= b.s) lo = mid; else hi = mid; }
          const f = lo < R.length - 1 && R[lo + 1] > R[lo] ? (b.s - R[lo]) / (R[lo + 1] - R[lo]) : 0;
          const d = s.clock - (lo + f) / GHOST_HZ;
          rival = `vs ${s.rival.name} ${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}`;
        }
      }
      ui.hud.update({
        stage: s.demo ? `DEMO · ${s.def.name}` : (s.course.endless ? `${s.course.regionAt(b.s)?.name || s.def.name} · ${((b.s - s.course.startS) / (mph ? 1609.34 : 1000)).toFixed(1)} ${mph ? 'mi' : 'km'}` : `${s.def.name} · CP ${Math.min(s.cp + 1, s.course.checkpoints.length)}/${s.course.checkpoints.length}`),
        time: s.course.endless ? fmtTime(Math.max(0, s.clock)) : fmtTime(Math.max(0, s.clock)),
        target, rival, score: s.score, combo: s.combo, pending: s.pending,
        speed: Math.round(b.v * (mph ? 2.23694 : 3.6)), unit: mph ? 'MPH' : 'KM/H',
        gear: b.v < 0.3 && b.gear === 0 ? 'N' : String(b.gear + 1), rpm: b.rpm,
        shiftLight: settings.gearbox === 'manual' && b.rpm > 10800,
        lean: b.phi / DEG, maxL: s.lean.L, maxR: s.lean.R,
        aids: { atc: b.aidATC, awc: b.aidAWC, abs: b.aidABS }, aidsOn: aids,
      });
      s.mapClock += dt;
      if (s.mapClock > 0.066) {
        s.mapClock = 0;
        scratch.length = 0;
        s.traffic?.dots(scratch);
        if (!s.course.endless && s.cp < s.course.checkpoints.length) {
          const q = s.course.road.at(s.nextCp, {});
          scratch.push({ x: q.x, z: q.z, color: '#4fd67a', r: 6 });
        }
        if (ghostMesh.visible) scratch.push({ x: ghostMesh.position.x, z: ghostMesh.position.z, color: '#5ac8fa', r: 5 });
        if (rivalMesh.visible) scratch.push({ x: rivalMesh.position.x, z: rivalMesh.position.z, color: '#ffb347', r: 5 });
        if (s.online) online.dots(scratch);
        ui.hud.drawMap(s.course.road, b, scratch);
      }
      if (s.course.endless && !s.demo) {
        const dist = b.s - s.course.startS;
        const er = store.records.endless || {};
        if (dist > (er.bestDist || 0) + 50 && !s.endlessSaved) { /* saved on quit */ }
        s.endlessDist = dist;
      }
    }
    mark('fx+audio+hud');
    renderer.render(scene, camera);
    mark('render');
  }

  // ---------- main loop ----------
  let frame = 0, prevTime = performance.now(), clock = 0, slowT = 0, fastT = 0, ftAvg = 16;
  let timeScale = 1;
  let bp = null;                                   // debug blueprint view (model tracing)
  function loop(now) {
    frame = requestAnimationFrame(loop);
    const rawDt = (now - prevTime) / 1000;
    prevTime = now;
    const dt = Math.min(0.1, rawDt) * timeScale;
    clock += dt;
    const e = pollInput(Math.min(0.1, rawDt));

    // global keys
    if (e.fs) toggleFullscreen();
    if (ui.screen) {                                   // a menu is up
      if (e.up) ui.moveFocus(-1);
      if (e.down) ui.moveFocus(1);
      if (e.enter && !input.isDown('Enter')) ui.activate();   // Enter clicks natively
      if (e.pause) {
        if (mode === 'paused') setPaused(false);
        else if (['settings', 'help', 'stages', 'ghosts', 'race', 'music'].includes(ui.screen)) actions.back();
      }
    } else if (session) {
      if (e.pause) { if (session.demo) { endSession(); showGarage(); } else setPaused(true); }
      if (e.cam) { camMode = camMode === 'chase' ? 'close' : camMode === 'close' ? 'helmet' : 'chase'; settings.camera = camMode; persist(); }
      if (e.respawn && mode === 'ride' && !session.demo && (!session.bike.crashed || session.crashT > 0.8)) respawn();
      if (session.musicOn && music) {
        if (e.vibe) pickVibe(session, e.vibe);
        if (e.song) newScene(session);
      }
      if (session.demo && (e.enter)) { endSession(); showGarage(); }
      // auto-pause when the tab/window loses focus (not to music: you switch to its tab to skip songs)
      if ((document.hidden || !document.hasFocus()) && (mode === 'ride' || mode === 'countdown') && !session.demo && !session.online && !session.musicOn) setPaused(true);
    }

    if (session && mode !== 'garage' && mode !== 'loading') {
      if (mode !== 'paused') frameRide(dt, clock);
      else renderer.render(scene, camera);
      if (session?.demoDone) { endSession(); showGarage(); }   // demo lap over
    } else if (mode === 'garage' || mode === 'loading') {
      garage.update(dt, model);
      // The bike idles on the turntable (and a ride's last revs don't linger).
      audio?.update(IDLE_SOUND);
      renderer.render(garage.scene, bp ? bp.cam : garage.camera);
    }

    // Dynamic resolution: if frames run long for a couple of seconds, render fewer
    // pixels; claw it back when there's headroom. Integrated graphics thank you.
    ftAvg += (rawDt * 1000 - ftAvg) * 0.05;
    if (ftAvg > 21) { slowT += rawDt; fastT = 0; } else if (ftAvg < 14.5) { fastT += rawDt; slowT = 0; } else { slowT = fastT = 0; }
    if (slowT > 2 && resScale > 0.6) { resScale = Math.max(0.6, resScale - 0.1); slowT = 0; resize(); }
    if (fastT > 4 && resScale < 1) { resScale = Math.min(1, resScale + 0.1); fastT = 0; resize(); }
  }

  resize();
  frame = requestAnimationFrame(loop);
  shell.setStatus('Click to start — sound needs a click first');

  // ?test=1: a tiny hook for automated checks (draw calls, forced-render timing, position).
  const testHook = new URLSearchParams(location.search).get('test') === '1';
  if (testHook) {
    window.__canyonTest = {
      get mode() { return mode; },
      calls: () => renderer.info.render.calls,
      rider: () => model.riderInfo(),
      bike: () => model.bikeInfo(),
      pos: () => (session ? { s: session.bike.s, x: session.bike.x, y: session.bike.y, z: session.bike.z, crashed: session.bike.crashed } : null),
      bot(on = true) { if (session) session.bot = on ? makeAutopilot(session.course, { pace: 0.88 }) : null; },
      // n renders of the current view (view = 'garage': the title turntable's); a 1-px
      // readback makes the GPU finish before timing stops.
      bench(n = 300, view) {
        const [sc, cam] = view === 'garage' ? [garage.scene, garage.camera] : [scene, camera];
        const px = new Uint8Array(4), gl = renderer.getContext(), t0 = performance.now();
        for (let i = 0; i < n; i++) renderer.render(sc, cam);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { msPerFrame: (performance.now() - t0) / n, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      },
      timescale(v) { timeScale = v; },
      // Ride to my music without a tab: src (an AudioBuffer, { samples, sampleRate } or
      // a URL) goes through the same tap and analysis. In a music ride it plays into the
      // running analysis; otherwise it starts one.
      async musicFrom(src) {
        await audioPromise;
        const ctx = audio.context;
        let buf = src;
        if (typeof src === 'string') buf = await ctx.decodeAudioData(await (await fetch(src)).arrayBuffer());
        else if (src && src.samples) { buf = ctx.createBuffer(1, src.samples.length, src.sampleRate); buf.copyToChannel(src.samples, 0); }
        if (music && session?.musicOn) { music.play(buf); return 'playing'; }
        await beginMusic(buf);
        startRide(musicDef());
        return 'started';
      },
      music() {
        if (!music || !session) return null;
        const a = music.analyzer, b = session.bike, p = session.musicPending, r = session.course.regionAt(b.s);
        const reg = x => x && { name: x.name, vibe: x.vibe, tod: x.tod, bpm: x.bpm && Math.round(x.bpm), s0: Math.round(x.s0), weather: x.weather };
        return {
          ...music.status, box: music.scenes.box, medBpm: Math.round(music.scenes.bpm * 10) / 10, medHz: Math.round(music.scenes.hz), raw: Math.round(a.rawBpm * 10) / 10, settled: a.settled, songTime: +a.songTime.toFixed(1),
          mode: a.mode.mode, loud: +a.loud.toFixed(1), centroid: Math.round(a.centroid), beats: a.beats, cpuMsPerFrame: +music.cpuPerFrame.toFixed(3),
          s: Math.round(b.s), region: reg(r), pending: reg(p), want: music.want, kick: settings.musicKick, duck: settings.musicEngine,
        };
      },
      // Stand-in for Chrome's share picker: 'noaudio' (a video-only share), 'deny'
      // (cancelled), or { samples, sampleRate } (a share whose sound is that audio, as a
      // real MediaStream). Each call is logged with whether it had a click's activation.
      stubDisplayMedia(kind) {
        const md = navigator.mediaDevices;
        if (!md.__realGDM) md.__realGDM = md.getDisplayMedia;
        md.__calls = [];
        md.getDisplayMedia = async opts => {
          md.__calls.push({ activation: navigator.userActivation?.isActive ?? null, opts });
          if (kind === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
          const video = document.createElement('canvas').captureStream(1).getVideoTracks();
          if (kind === 'noaudio') return new MediaStream(video);
          const ctx = audio.context, buf = ctx.createBuffer(1, kind.samples.length, kind.sampleRate);
          buf.copyToChannel(kind.samples, 0);
          const src = ctx.createBufferSource(), dst = ctx.createMediaStreamDestination();
          src.buffer = buf; src.connect(dst); src.start();
          return new MediaStream([...video, ...dst.stream.getAudioTracks()]);
        };
        return md.__calls;
      },
      unstubDisplayMedia() { const md = navigator.mediaDevices; if (md.__realGDM) { md.getDisplayMedia = md.__realGDM; delete md.__realGDM; } },
      displayMediaCalls: () => navigator.mediaDevices.__calls || [],
      // Chrome's own "Stop sharing" bar ends the track; this fires the same event.
      // ?calibrate=1: the recording (live, or the last one) as it would be saved.
      calib: () => (calib || lastCalib)?.data() ?? null,
      endShare() { const t = music?.track; if (!t) return false; t.dispatchEvent(new Event('ended')); return true; },
      // Instanced pools in the scene: live instance count and triangles per instance.
      online: () => online.stats(),
      props() {
        const o = {};
        scene.traverse(m => { if (m.isInstancedMesh) o[m.name || m.id] = [m.count, m.geometry.attributes.position.count / 3]; });
        return o;
      },
    };
  }

  if (debug) {
    window.__canyon = {
      get mode() { return mode; },
      state() {
        const b = session?.bike;
        return b ? { mode, s: b.s, d: b.d, v: b.v, kmh: b.v * 3.6, gear: b.gear + 1, rpm: Math.round(b.rpm), phi: b.phi / DEG, pitch: b.pitch / DEG, crashed: b.crashed, clock: session.clock, score: session.score, cp: session.cp } : { mode };
      },
      ride(id, demo = false) { const d = id === 'endless' ? { ...ENDLESS, seed: 777 } : STAGES.find(s => s.id === id) || STAGES[Number(id) || 0]; startRide(d, { demo }); },
      timescale(v) { timeScale = v; },
      // Autopilot riding a normal, scored run (checkpoints, results, saving all live).
      bot(on = true, pace = 0.88) { if (session) session.bot = on ? makeAutopilot(session.course, { pace }) : null; },
      info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, res: resScale, fps: Math.round(1000 / ftAvg) }),
      jump(s) { if (session) { placeBike(session.bike, session.course.road, s, 1.75, 20); camInit = false; } },
      camera(m) { camMode = m; },
      fpv: FPV,
      view(back, up, side) { debugView = back == null ? null : [back, up, side]; },
      // Force a crash of a given kind ('Highside — …', 'Lowside — …', 'Hit a car', …).
      crash(why = 'Lowside — ran out of grip') { if (session && !session.bike.crashed) { crash(session.bike, why); onCrash(why); } },
      rag: () => (session?.rag ? { t: +session.rag.time.toFixed(2), settled: session.rag.settled, stretch: +session.rag.linkError().toFixed(3), hip: session.rag.center({}) } : null),
      tod: () => session?.world.env,
      shareCode: id => shareCode(id),
      // Endless: what's on the road so far, and where we are.
      features: () => session?.course.featuresIn(0, session.course.road.length).map(f => ({ type: f.type, s0: Math.round(f.s0), s1: Math.round(f.s1), change: f.change, kind: f.kind, name: f.name })),
      region: () => { const r = session?.course.regionAt(session.bike.s); return r && { name: r.name, weather: r.weather, enter: r.enter, s0: Math.round(r.s0) }; },
      rival: () => (session?.rival ? { name: session.rival.name, visible: rivalMesh.visible, x: rivalMesh.position.x, z: rivalMesh.position.z } : null),
      worldPerf: reset => session?.world.perf(reset),
      audio: () => (audio ? { engineWorklet: audio.ready, context: audio.state } : null),
      garage: (angle, hideUi = true) => { garage.freeze(angle); ui.root.style.visibility = hideUi ? 'hidden' : 'visible'; },
      // Model tracing: a flat side view of the bike with a reference photo laid over
      // it at true scale. The photo lives in .ref/ (git-ignored, never shipped). Its
      // calibration — px per metre and the axle-midpoint/ground pixel — comes from the
      // official wheelbase and tyre sizes; see the README's model notes.
      blueprint(on = true, { url = '/.ref/rs660-side.png', pxPerM = 721, midPx = 747.9, groundPx = 906, w = 1500, h = 1000, opacity = 0.5, zoom = 1.15, cx = 0, cy = 0.6 } = {}) {
        if (bp) { garage.scene.remove(bp.plane); bp.plane.geometry.dispose(); bp.plane.material.map.dispose(); bp.plane.material.dispose(); bp = null; }
        ui.root.style.visibility = on ? 'hidden' : 'visible';
        if (!on) { garage.freeze(null); return; }
        garage.freeze(0);
        const tex = new THREE.TextureLoader().load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w / pxPerM, h / pxPerM),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, depthTest: false }));
        plane.position.set((w / 2 - midPx) / pxPerM, 0.06 + (groundPx - h / 2) / pxPerM, 0.6);
        plane.renderOrder = 10;
        garage.scene.add(plane);
        const aspect = cv.clientWidth / cv.clientHeight;
        const cam = new THREE.OrthographicCamera(-zoom * aspect, zoom * aspect, zoom, -zoom, 0.1, 20);
        cam.position.set(cx, 0.06 + cy, 5);
        cam.lookAt(cx, 0.06 + cy, 0);
        bp = { plane, cam };
      },
      bpOpacity(o) { if (bp) bp.plane.material.opacity = o; },
      perf(reset) { const o = {}; for (const k in perf) if (k !== 'frames') o[k] = +(k.endsWith(' max') ? perf[k] : perf[k] / Math.max(1, perf.frames)).toFixed(2); o.frames = perf.frames; if (reset) { for (const k in perf) perf[k] = 0; } return o; },
    };
  }

  return {
    async start() {
      // The overlay click is the user gesture that lets us make sound.
      if (!audioPromise) {
        audioPromise = createAudio().then(a => { audio = a; a.setVolume(Number(settings.volume)); }).catch(() => { audio = null; });
      }
      showGarage();
      online.fromUrl();
    },
    destroy() {
      cancelAnimationFrame(frame);
      mode = 'destroyed';                          // a queued buildSession must not run
      stopMusic(false);
      endSession();
      online.destroy();
      removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', resize);
      if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
      ui.destroy();
      if (audio) audio.close(); else audioPromise?.then(() => audio?.close());
      model.dispose();
      ghostGeo.dispose(); ghostMat.dispose();
      rivalMat.dispose(); tagMat.dispose(); tagTex.dispose();
      sparkGeo.dispose(); sparkMat.dispose();
      if (bp) { bp.plane.geometry.dispose(); bp.plane.material.map.dispose(); bp.plane.material.dispose(); }
      garage.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      cv.remove();
      sharedCanvas.hidden = false;
      if (debug) delete window.__canyon;
      if (testHook) delete window.__canyonTest;
    },
  };
}

// ---------------------------------------------------------------------------
// The garage: a dark studio, a turntable and three lights. The PMREM environment
// gives the clear-coated paint something to reflect.
// ---------------------------------------------------------------------------
function buildGarage(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121419);
  scene.fog = new THREE.Fog(0x121419, 9, 24);
  scene.environmentIntensity = 1.7;          // let the clear coat catch the softboxes
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
  const bin = [];
  const own = o => (bin.push(o), o);

  const floor = new THREE.Mesh(own(new THREE.CircleGeometry(30, 48)), own(new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.9 })));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const table = new THREE.Mesh(own(new THREE.CylinderGeometry(1.9, 1.95, 0.06, 64)), own(new THREE.MeshStandardMaterial({ color: 0x1d1f25, roughness: 0.35, metalness: 0.6 })));
  table.position.y = 0.03;
  table.receiveShadow = true;
  scene.add(table);
  const ring = new THREE.Mesh(own(new THREE.TorusGeometry(1.93, 0.012, 8, 96)), own(new THREE.MeshBasicMaterial({ color: 0xd0202a })));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.062;
  scene.add(ring);

  scene.add(new THREE.HemisphereLight(0xa9b4cc, 0x1a1c22, 1.4));
  const key = new THREE.DirectionalLight(0xfff1e0, 4.6);
  key.position.set(3.5, 5, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 1, far: 15 });
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc3ff, 2.2);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  // A neutral fill low at the front. (A red one looked moody but painted the black
  // bodywork red in the clear coat — and the livery is the point of this screen.)
  const kick = new THREE.PointLight(0xdfe6ff, 4, 7, 1.5);
  kick.position.set(1.8, 0.5, 1.8);
  scene.add(kick);

  // Studio reflections: a dark box with three bright softbox panels.
  const studio = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 14), new THREE.MeshBasicMaterial({ color: 0x101115, side: THREE.BackSide }));
  studio.add(room);
  for (const [x, y, z, w, h, c] of [[0, 3.9, 0, 6, 4, 0xffffff], [-6.9, 2, 2, 0.1, 3, 0xbfd6ff], [6.9, 1.6, -2, 0.1, 2.4, 0xffe2c8]]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(w || 0.1, h, w ? 0.1 : 4), new THREE.MeshBasicMaterial({ color: c }));
    if (y > 3) p.rotation.x = Math.PI / 2;
    p.position.set(x, y, z);
    studio.add(p);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(studio, 0.04);
  scene.environment = envRT.texture;
  studio.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  pmrem.dispose();

  let spin = 0.6, frozen = false;
  return {
    scene, camera,
    freeze(a) { frozen = a != null; if (frozen) spin = a; },
    update(dt, model) {
      if (!frozen) spin += dt * 0.32;
      model.group.position.set(0, 0.06, 0);
      model.group.rotation.set(0, spin, 0);
      model.idle(dt);
      // Frame the bike in the upper right: the title panel sits on the left and the
      // spec strip along the bottom.
      camera.position.set(-1.0, 1.55, 5.2);
      camera.lookAt(-1.0, 0.32, 0);
    },
    dispose() {
      for (const o of bin) o.dispose();
      envRT.dispose();
      key.dispose(); rim.dispose(); kick.dispose();
    },
  };
}
