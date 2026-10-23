// Canyon — online races ("Race friends"). Owns the room link, the lobby, the 20 Hz state
// sends and the other riders' see-through bikes. The relay (projects/relay/src/canyon.js)
// owns the host, the green light and the results; this file never decides an outcome.
// game.js keeps the ride itself: a race is a normal stage run with session.online set.

import * as THREE from '../../vendor/three.module.js';
import { relayHost, createLink } from './net.js';
import { makeCode, normCode, roomLink, cleanNick, packState, readState, createTrack, pushSample, sampleTrack, fmtGap, SEND_HZ, DELAY_MS } from './race.js';
import { STAGES } from './stages.js';

const NICK = 'arcade:canyon:nick';
export const RIDER_COLORS = ['#ff5a5f', '#4fd67a', '#ffcf4a', '#b48cff'];   // colour slot 0–3, set by the relay
const OPACITY = 0.45;

// hooks: { ui, scene, storage, ghostGeo(), startRide(def, online), toLobby(), riding() -> session|null }
export function createOnline(hooks) {
  const { ui, scene, storage } = hooks;
  const host = relayHost(location);
  let link = null, code = null, myId = null, room = null, race = null, nick = cleanNick(storage.get(NICK) || '');
  let lastSend = 0, down = false;
  const remotes = new Map();                       // id -> remote rider
  const pose = {};

  // ---- what the network sent, made safe to show ----
  const color = c => (Number.isInteger(c) && c >= 0 && c < RIDER_COLORS.length ? c : 0);
  const rows = list => (Array.isArray(list) ? list.slice(0, 8) : []).map(r => ({
    id: String(r && r.id), name: cleanNick(r && r.name), color: color(r && r.color),
    place: Number.isInteger(r && r.place) ? r.place : null,
    ms: typeof (r && r.ms) === 'number' && isFinite(r.ms) ? r.ms : null,
    dnf: !!(r && r.dnf), gapText: fmtGap(typeof (r && r.gap) === 'number' && isFinite(r.gap) ? r.gap : null),
  }));
  const stageOf = id => STAGES.find(s => s.id === id) || null;

  // ---- lobby ----
  function view() {
    let r = null;
    if (room && code) {
      const players = (Array.isArray(room.players) ? room.players.slice(0, 4) : []).map(p => ({
        name: cleanNick(p && p.name), color: color(p && p.color), host: p && p.id === room.host, you: p && p.id === myId,
      }));
      const rr = room.race && typeof room.race === 'object' ? room.race : null;
      r = {
        code, link: roomLink(location, code), players, isHost: room.host === myId && !!myId,
        stage: stageOf(room.stage) ? room.stage : STAGES[0].id,
        racing: rr ? (stageOf(rr.stage)?.name || 'a road') : '',
        inRace: !!rr && rows(rr.results).some(x => x.id === myId),
        last: room.last && stageOf(room.last.stage) ? { stage: room.last.stage, rows: rows(room.last.results) } : null,
      };
    }
    return { nick, room: r, colors: RIDER_COLORS, stages: STAGES.map(s => ({ id: s.id, name: s.name })) };
  }
  const render = () => { if (ui.screen === 'race') ui.renderRace(view()); };

  function open() {
    ui.raceMsg('');
    ui.renderRace(view());
    ui.show('race');
    if (!host) ui.raceMsg("Online racing isn't set up yet. Solo riding and friends' ghosts work as usual.", 'red');
    else if (down) ui.raceMsg("Online racing isn't available right now. Solo riding still works.", 'red');
  }

  function setUrl(c) {
    try {
      const q = new URLSearchParams(location.search);
      if (c) q.set('room', c); else q.delete('room');
      const s = q.toString();
      history.replaceState(null, '', `${location.pathname}${s ? '?' + s : ''}${location.hash}`);
    } catch {}
  }

  function join(c) {
    if (!host) return open();
    leave(true);
    code = c; down = false; room = null; myId = null;
    setUrl(c);
    ui.raceMsg('Connecting…');
    link = createLink(host, c, onMessage);
    open();
  }

  function leave(quiet) {
    if (link) link.close();
    link = null; code = null; room = null; myId = null; race = null;
    clearRemotes();
    if (!quiet) { setUrl(null); ui.raceMsg(''); render(); }
  }

  // ---- messages from the relay ----
  function onMessage(m) {
    const s = hooks.riding();
    switch (m.type) {
      case '_open':
        down = false;
        link.send({ type: 'hello', name: nick });
        ui.raceMsg('');
        return;
      case '_closed':
        ui.raceMsg('Connection lost — reconnecting…', 'red');
        if (s) ui.message('CONNECTION LOST — RECONNECTING', 'warn');
        return;
      case '_down':
        down = true;
        if (s && race) { race.lost = true; clearRemotes(); ui.message('ONLINE RACING UNAVAILABLE — RIDING SOLO', 'warn', true); }
        room = null; render();
        ui.raceMsg("Online racing isn't available right now. Solo riding still works.", 'red');
        return;
      case 'refused':
        room = null; code = null; setUrl(null); render();
        ui.raceMsg(m.why === 'full' ? 'That room is full: 4 riders at most.' : "That isn't a room code.", 'red');
        return;
      case 'welcome':
        myId = String(m.id);
        if (race && !race.lost && s) { race.lost = true; clearRemotes(); }   // a new connection isn't in the old race
        return;
      case 'room': {
        room = m;
        const rr = m.race && typeof m.race === 'object' ? m.race : null;
        if (race && rr && rr.id === race.id) {
          race.rows = rows(rr.results);
          race.closeAt = typeof rr.closeIn === 'number' && isFinite(rr.closeIn) ? performance.now() + rr.closeIn : null;
          // a rider in the results who isn't here any more has left: their bike goes
          for (const id of remotes.keys()) if (!m.players?.some?.(p => p.id === id)) dropRemote(id);
          if (ui.screen === 'board') board();
        }
        render();
        return;
      }
      case 'go': {
        const def = stageOf(m.stage), lead = Number(m.lead);
        if (!def || !Number.isFinite(m.race) || !(lead >= 0 && lead <= 10000)) return;
        race = { id: m.race, stage: m.stage, goAt: performance.now() + lead, rows: [], closeAt: null, lost: false, finished: false };
        clearRemotes();
        hooks.startRide(def, race);
        return;
      }
      case 'relay': {
        // the only thing riders send each other: their bike's state
        if (!race || race.lost || !s || !m.data || m.data.type !== 'state') return;
        const smp = readState(m.data.d), id = String(m.from);
        if (!smp || id === myId) return;
        const rp = remotes.get(id) || addRemote(id);
        if (rp && pushSample(rp.track, smp, performance.now())) rp.n++;
        return;
      }
      case 'leave': {
        const name = cleanNick(m.name);
        dropRemote(String(m.id));
        if (s) ui.message(`${name} left`, 'warn');
        else ui.raceMsg(`${name} left`);
        return;
      }
      case 'end':
        if (!race || m.race !== race.id) return;
        race = null;
        clearRemotes();
        if (s) hooks.toLobby();
        open();
        ui.raceMsg('Race over. The host picks the next road.', 'grn');
        return;
    }
  }

  // ---- other riders: the ghost bike, in their colour, with a name tag ----
  function addRemote(id) {
    if (remotes.size >= 3) return null;
    const p = rows(room?.race?.results).find(r => r.id === id) || room?.players?.find?.(q => q.id === id);
    const name = cleanNick(p && p.name), c = color(p && p.color);
    const mat = new THREE.MeshBasicMaterial({ color: RIDER_COLORS[c], transparent: true, opacity: OPACITY, depthWrite: false });
    const mesh = new THREE.Mesh(hooks.ghostGeo(), mat);
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = 'italic 800 34px "Segoe UI", Roboto, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.65)';
    g.strokeText(name, 128, 32, 240);
    g.fillStyle = RIDER_COLORS[c];
    g.fillText(name, 128, 32, 240);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tagMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const tag = new THREE.Sprite(tagMat);
    tag.scale.set(2, 0.5, 1);
    tag.position.y = 1.95;
    mesh.add(tag);
    mesh.visible = false;
    scene.add(mesh);
    const rp = { id, name, color: c, mesh, mat, tex, tagMat, track: createTrack(), op: 0, n: 0, n0: 0, t0: performance.now(), hz: 0, behind: 0 };
    remotes.set(id, rp);
    return rp;
  }
  function dropRemote(id) {
    const rp = remotes.get(id);
    if (!rp) return;
    scene.remove(rp.mesh);
    rp.mat.dispose(); rp.tex.dispose(); rp.tagMat.dispose();
    remotes.delete(id);
  }
  function clearRemotes() { for (const id of [...remotes.keys()]) dropRemote(id); }

  // ---- per frame, while riding an online race ----
  function frame(s, dt) {
    const now = performance.now();
    if (!race || race.lost) return;
    if (link && now - lastSend >= 1000 / SEND_HZ) {
      lastSend = now - lastSend < 2000 / SEND_HZ ? lastSend + 1000 / SEND_HZ : now;
      link.send({ type: 'state', d: packState(s.bike, now - race.goAt) });
    }
    for (const rp of remotes.values()) {
      const p = sampleTrack(rp.track, now, pose);
      if (!p) continue;
      rp.mesh.position.set(p.x, p.y, p.z);
      rp.mesh.rotation.set(p.phi, -p.psi, p.pitch, 'YZX');
      // A crash fades them out; they fade back in where they respawn.
      rp.op += ((p.crashed ? 0 : OPACITY) - rp.op) * Math.min(1, dt * 6);
      rp.mat.opacity = rp.op;
      rp.tagMat.opacity = rp.op / OPACITY;
      rp.mesh.visible = rp.op > 0.02;
      const S = rp.track.samples;
      rp.behind = S[S.length - 1].t - p.t;          // how far behind their newest sample we draw
      if (now - rp.t0 >= 2000) { rp.hz = (rp.n - rp.n0) * 1000 / (now - rp.t0); rp.n0 = rp.n; rp.t0 = now; }
    }
    if (ui.screen === 'board' && race.closeAt) board();
  }

  function dots(list) {
    for (const rp of remotes.values()) if (rp.mesh.visible) list.push({ x: rp.mesh.position.x, z: rp.mesh.position.z, color: RIDER_COLORS[rp.color], r: 5 });
  }

  // ---- finishing ----
  let mine = '';
  function finished(t, result) {
    if (!race || race.lost) return;
    race.finished = true;
    link?.send({ type: 'finish', race: race.id, ms: Math.round(t * 1000) });
    mine = `${result.time} · ${result.medal ? result.medal.toUpperCase() : 'no medal'}${result.newBest ? ' · NEW BEST' : ''}`;
  }
  let shown = '';
  function board() {
    const closeIn = race.closeAt ? Math.max(0, (race.closeAt - performance.now()) / 1000) : null;
    const key = JSON.stringify(race.rows) + (closeIn == null ? '' : Math.ceil(closeIn));
    if (key === shown && ui.screen === 'board') return;
    shown = key;
    ui.renderBoard({ title: `${stageOf(race.stage)?.name || ''} · results`, mine: `You: ${mine}`, rows: race.rows, closeIn, over: false }, RIDER_COLORS);
  }
  function showBoard() { shown = ''; board(); ui.show('board'); }
  // Leaving a race early: the relay marks this rider DNF.
  function quitRace() {
    if (race && !race.lost && !race.finished) link?.send({ type: 'quit', race: race.id });
    if (race) race.left = true;
    hooks.toLobby();
    open();
  }

  return {
    open, join, frame, dots, finished, showBoard, quitRace,
    get racing() { return !!race && !race.lost; },
    // ?room=KQZT in the address: straight into that room (once per page).
    fromUrl() {
      const c = normCode(new URLSearchParams(location.search).get('room'));
      if (c && !code) join(c);
    },
    // the lobby's buttons
    create() { join(makeCode()); },
    joinTyped() {
      const c = normCode(ui.codeInput.value);
      if (!c) { ui.raceMsg('A room code is 4 letters, like KQZT.', 'red'); return; }
      ui.codeInput.value = '';
      join(c);
    },
    leave() { leave(false); },
    nick(v) {
      nick = cleanNick(v);
      storage.set(NICK, nick);
      link?.send({ type: 'hello', name: nick });
      render();
    },
    stage(id) { if (stageOf(id)) link?.send({ type: 'stage', id }); },
    start() { link?.send({ type: 'start' }); },
    async copy() {
      const url = roomLink(location, code || '');
      try { await navigator.clipboard.writeText(url); ui.raceMsg('Link copied. Send it to up to 3 friends.', 'grn'); }
      catch { ui.root.querySelector('#cyLink')?.select(); ui.raceMsg('The browser blocked the clipboard: the link is selected, copy it with Ctrl+C.', 'red'); }
    },
    // a race ride ended locally (quit, end, destroy): its bikes go
    endRide() { clearRemotes(); if (race && race.left) race = null; },
    stats() {
      const st = link ? link.stats() : { sent: 0, bytes: 0 };
      return {
        code, myId, host: room?.host, race: race && { id: race.id, lost: race.lost, rows: race.rows }, down, sent: st.sent, avgBytes: st.sent ? +(st.bytes / st.sent).toFixed(1) : 0,
        remotes: [...remotes.values()].map(rp => ({ name: rp.name, n: rp.n, hz: +rp.hz.toFixed(1), behindMs: Math.round(rp.behind), delayMs: DELAY_MS, visible: rp.mesh.visible, op: +rp.op.toFixed(2), x: rp.mesh.position.x, z: rp.mesh.position.z, pitch: rp.mesh.rotation.z })),
      };
    },
    destroy() { leave(true); },
  };
}
