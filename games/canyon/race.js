// Online races — the pure parts (no DOM, no three.js, no sockets), so the Node tests run
// exactly this code: room codes, nicknames, the 20 Hz state message, and drawing other
// riders ~100 ms in the past between the two samples that bracket that moment (playbook §8).

export const SEND_HZ = 20;
export const DELAY_MS = 100;                 // remote riders are drawn this far in the past
export const SNAP_M = 20;                    // farther apart than this between samples: a respawn, don't slide
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';   // no I, L, O: they read as 1 and 0
const KEEP = 24;                             // samples kept per rider (~1.2 s)

export function makeCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(rand() * LETTERS.length) % LETTERS.length];
  return c;
}
// Whatever was typed or pasted (a code, a link, lower case) -> 'KQZT', or null.
export function normCode(text) {
  const s = String(text || '');
  const m = s.match(/[?&]room=([A-Za-z]{4})(?![A-Za-z])/);
  const c = (m ? m[1] : s.replace(/[^A-Za-z]/g, '')).toUpperCase();
  return c.length === 4 && [...c].every(ch => LETTERS.includes(ch)) ? c : null;
}
export const roomLink = (loc, code) => `${loc.origin}${loc.pathname}?room=${code}#canyon`;

// Same rule as the relay: no control characters, no markup, at most 12 characters.
export const cleanNick = s => String(s ?? '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 12).trim() || 'Rider';

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r = (v, k) => Math.round(v * k) / k;

// [t, s, x, y, z, psi, phi, pitch, v, crashed]: t is the sender's ms since the green light.
export function packState(b, t) {
  return [Math.round(t), r(b.s, 10), r(b.x, 100), r(b.y, 100), r(b.z, 100),
    r(wrap(b.psi), 1000), r(clamp(b.phi, -3.1, 3.1), 1000), r(clamp(b.pitch, -3.1, 3.1), 1000), r(clamp(b.v, -60, 200), 10), b.crashed ? 1 : 0];
}
const BOUNDS = [[-1e4, 4e6], [-1e3, 1e6], [-1e6, 1e6], [-1e5, 1e5], [-1e6, 1e6],
  [-1e4, 1e4], [-3.2, 3.2], [-3.2, 3.2], [-60, 200], [0, 1]];
// The relay checks this too; a client checks again because a network message is data, not trust.
export function readState(d) {
  if (!Array.isArray(d) || d.length !== BOUNDS.length) return null;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < BOUNDS[i][0] || v > BOUNDS[i][1]) return null;
  }
  return { t: d[0], s: d[1], x: d[2], y: d[3], z: d[4], psi: d[5], phi: d[6], pitch: d[7], v: d[8], crashed: d[9] === 1 };
}

// ---- interpolation ----
// offset maps the sender's clock onto ours: the smallest (arrival − sent) seen is the
// least-delayed packet. It creeps up slowly in case the path gets slower for good.
export const createTrack = () => ({ samples: [], offset: null, last: -Infinity });
export function pushSample(tr, smp, recvMs) {
  const n = tr.samples.length;
  if (n && smp.t <= tr.samples[n - 1].t) return false;         // late or duplicate
  const o = recvMs - smp.t;
  tr.offset = tr.offset == null || o < tr.offset ? o : tr.offset + (o - tr.offset) * 0.01;
  tr.samples.push(smp);
  if (tr.samples.length > KEEP) tr.samples.shift();
  tr.last = recvMs;
  return true;
}
// Pose at (now − delay) on the sender's clock; holds the newest sample if nothing newer has
// come (no guessing ahead). Returns null before the first sample.
export function sampleTrack(tr, nowMs, out = {}, delay = DELAY_MS) {
  const S = tr.samples;
  if (!S.length) return null;
  const at = nowMs - tr.offset - delay;
  let a = S[0], b = S[0];
  if (at >= S[S.length - 1].t) a = b = S[S.length - 1];
  else if (at > S[0].t) {
    let i = S.length - 1;
    while (i > 0 && S[i - 1].t > at) i--;
    a = S[i - 1]; b = S[i];
  }
  let f = b.t > a.t ? (at - a.t) / (b.t - a.t) : 0;
  if (Math.hypot(b.x - a.x, b.z - a.z) > SNAP_M) f = f < 0.5 ? 0 : 1;
  out.t = at;
  out.s = a.s + (b.s - a.s) * f;
  out.x = a.x + (b.x - a.x) * f; out.y = a.y + (b.y - a.y) * f; out.z = a.z + (b.z - a.z) * f;
  out.psi = a.psi + wrap(b.psi - a.psi) * f;
  out.phi = a.phi + (b.phi - a.phi) * f;
  out.pitch = a.pitch + (b.pitch - a.pitch) * f;
  out.v = a.v + (b.v - a.v) * f;
  out.crashed = f < 0.5 ? a.crashed : b.crashed;
  return out;
}

// Results rows come ordered from the relay; this only formats them.
export const fmtGap = ms => (ms == null ? '' : ms === 0 ? '—' : `+${(ms / 1000).toFixed(2)}`);
