// Ghost sharing — pack a recorded run into a code (or file) a friend can race.
//
// No server: the code travels however people already talk (a chat, an email, a
// file). To keep it short, a run is stored the way the road describes it, not as
// world coordinates: distance along the road and offset from the centre line, plus
// lean, pitch and heading relative to the road, quantised to 16 bits, 10 samples a
// second, split into planes (so similar numbers sit together) and deflated. A whole
// stage comes out at a few thousand characters.
//
// The road is rebuilt from the stage's seed on the friend's machine, so each code
// carries a fingerprint of the road. A ghost recorded on a different version of a
// stage is refused with a clear message instead of floating off the road.
//
// Codes are untrusted input: every field is bounds-checked, decompression is capped,
// and the claimed time must match the recording's length.

import { Road, DS } from './road.js';
import { STAGES } from './stages.js';

export const PREFIX = 'CANYON1.';
const MAGIC = 0x4743;                 // "CG"
const VERSION = 1;
const SRC_HZ = 20, EVERY = 2;         // recorded at 20 Hz, shared at 10 Hz
const HEADER = 20;
const MAX_CODE = 120000;              // characters
const MAX_RAW = 512 * 1024;           // bytes after inflating
const MAX_SAMPLES = 10 * 60 * 15;     // 15 minutes at 10 Hz
const NAME_MAX = 16;

export class GhostError extends Error {}

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp16 = v => Math.max(-32768, Math.min(32767, Math.round(v)));

// A fingerprint of the road itself (FNV-1a over positions every 50 m). If road
// generation ever changes, old codes stop matching and say so.
export function roadPrint(course) {
  const r = course.road;
  const n = Math.min(r.n, Math.ceil((course.length + 100) / DS));
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i += 25) {
    for (const v of [r.x[i], r.y[i], r.z[i]]) {
      h ^= Math.round(v * 10) | 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function nearestIndex(road, x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < road.n; i += 2) {
    const d = (road.x[i] - x) ** 2 + (road.z[i] - z) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

// The code alone, out of whatever was pasted around it (chat text, line breaks).
export function extractCode(text) {
  const raw = String(text || '');
  const at = raw.indexOf(PREFIX);
  if (at < 0) return null;
  return PREFIX + raw.slice(at + PREFIX.length).replace(/\s/g, '').match(/^[A-Za-z0-9_-]*/)[0];
}

export function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
}

const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = s => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deflate(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// Inflate with a hard cap, so a hostile code can't balloon in memory.
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const reader = ds.readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RAW) { reader.cancel().catch(() => {}); throw new GhostError('That code is far too big to be a ghost.'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// samples: Float32Array of [x, y, z, psi, phi, pitch] at 20 Hz (the game's format).
export async function encodeGhost({ stageId, course, samples, timeMs, name }) {
  const stageIndex = STAGES.findIndex(s => s.id === stageId);
  if (stageIndex < 0) throw new GhostError('Only the five stages can be shared.');
  const total = Math.floor(samples.length / 6);
  if (total < 2) throw new GhostError('There is no recorded run to share yet.');
  const n = Math.floor((total - 1) / EVERY) + 1;
  if (n > MAX_SAMPLES) throw new GhostError('That run is too long to share.');

  const road = course.road;
  const planes = new Int16Array(n * 5);   // Δs (cm), d (cm), Δψ, φ, θ (milliradians)
  const q = {};
  let hint = -1, s0 = 0, sPrev = 0, px = 0, pz = 0;
  for (let k = 0; k < n; k++) {
    const o = k * EVERY * 6;
    // track() walks downhill from the last match, which can stall on a hairpin after
    // a jump (the first sample, or a respawn); search the whole road then.
    if (hint < 0 || Math.hypot(samples[o] - px, samples[o + 2] - pz) > 15) hint = nearestIndex(road, samples[o], samples[o + 2]);
    px = samples[o]; pz = samples[o + 2];
    road.track(samples[o], samples[o + 2], hint, q);
    hint = q.i;
    const sCm = Math.round(q.s * 100);
    if (k === 0) { s0 = sCm; sPrev = sCm; }
    else {
      planes[k] = clamp16(sCm - sPrev);
      sPrev += planes[k];                    // track the decoded value so error can't drift
    }
    planes[n + k] = clamp16(q.d * 100);
    planes[2 * n + k] = clamp16(wrap(samples[o + 3] - q.psi) * 1000);
    planes[3 * n + k] = clamp16(samples[o + 4] * 1000);
    planes[4 * n + k] = clamp16(samples[o + 5] * 1000);
  }
  // Offset, heading, lean and pitch change smoothly, so store each as the change from
  // the sample before: small, repetitive numbers deflate far better. (Integers, so
  // the decoder's running sum is exact — no drift.)
  for (let p = 1; p < 5; p++) {
    for (let k = n - 1; k > 0; k--) planes[p * n + k] = clamp16(planes[p * n + k] - planes[p * n + k - 1]);
  }

  const nameBytes = new TextEncoder().encode(cleanName(name) || 'Rider').subarray(0, 48);
  const buf = new Uint8Array(HEADER + nameBytes.length + planes.length * 2);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, MAGIC, true);
  dv.setUint8(2, VERSION);
  dv.setUint8(3, stageIndex);
  dv.setUint32(4, roadPrint(course), true);
  dv.setUint32(8, Math.max(0, Math.round(timeMs)), true);
  dv.setUint16(12, n, true);
  dv.setUint32(14, s0, true);
  dv.setUint8(18, nameBytes.length);
  buf.set(nameBytes, HEADER);
  let o = HEADER + nameBytes.length;
  for (let i = 0; i < planes.length; i++, o += 2) dv.setInt16(o, planes[i], true);
  return PREFIX + b64url(await deflate(buf));
}

// courseFor(stageDef) → the stage's course (built from its seed, so it matches).
// Returns world-format samples at 20 Hz plus the distance along the road of each,
// which the game uses for the live gap.
export async function decodeGhost(text, courseFor) {
  const code = extractCode(text);
  if (!code) throw new GhostError("That isn't a Canyon ghost code. It should start with " + PREFIX);
  const body = code.slice(PREFIX.length);
  if (!body) throw new GhostError('The code is empty after ' + PREFIX + '. Copy the whole thing.');
  if (body.length > MAX_CODE) throw new GhostError('That code is far too long to be a ghost.');

  let buf;
  try { buf = await inflate(fromB64url(body)); }
  catch (e) { throw e instanceof GhostError ? e : new GhostError('That code is damaged or cut short. Copy the whole thing.'); }
  if (buf.length < HEADER) throw new GhostError('That code is damaged or cut short. Copy the whole thing.');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== MAGIC) throw new GhostError("That isn't a Canyon ghost code.");
  if (dv.getUint8(2) !== VERSION) throw new GhostError('That ghost comes from a newer version of Canyon.');
  const stage = STAGES[dv.getUint8(3)];
  if (!stage) throw new GhostError("That ghost is for a road this version doesn't have.");
  const print = dv.getUint32(4, true);
  const timeMs = dv.getUint32(8, true);
  const n = dv.getUint16(12, true);
  const s0 = dv.getUint32(14, true);
  const nameLen = dv.getUint8(18);
  if (n < 2 || n > MAX_SAMPLES) throw new GhostError('That ghost has no usable run in it.');
  if (buf.length !== HEADER + nameLen + n * 10) throw new GhostError('That code is damaged or cut short. Copy the whole thing.');
  const name = cleanName(new TextDecoder().decode(buf.subarray(HEADER, HEADER + nameLen))) || 'Rider';

  // The run must last about as long as the time it claims.
  const span = (n - 1) * EVERY / SRC_HZ * 1000;
  if (Math.abs(span - timeMs) > 1500) throw new GhostError("That ghost's time doesn't match its recording, so it was edited or damaged.");

  const course = courseFor(stage);
  if (roadPrint(course) !== print) throw new GhostError(`That ghost was recorded on a different version of ${stage.name}, so it wouldn't line up with the road.`);

  // Rebuild world positions at 10 Hz from road coordinates…
  const road = course.road, q = {};
  const coarse = new Float32Array(n * 6), sAt = new Float32Array(n);
  let sCm = s0;
  const plane = (p, k) => dv.getInt16(HEADER + nameLen + (p * n + k) * 2, true);
  const run = [0, 0, 0, 0, 0];                   // running sums of the delta planes
  for (let k = 0; k < n; k++) {
    if (k) sCm += plane(0, k);
    for (let p = 1; p < 5; p++) run[p] += plane(p, k);
    const s = Math.max(0, Math.min(road.length, sCm / 100));
    const d = run[1] / 100;
    road.at(s, q);
    const o = k * 6;
    coarse[o] = q.x - Math.sin(q.psi) * d;
    coarse[o + 1] = Road.surfaceY(q, d);
    coarse[o + 2] = q.z + Math.cos(q.psi) * d;
    coarse[o + 3] = q.psi + run[2] / 1000;
    coarse[o + 4] = run[3] / 1000;
    coarse[o + 5] = run[4] / 1000;
    sAt[k] = s;
  }
  // …then back to the game's 20 Hz by interpolating midpoints (angles the short way).
  const m = (n - 1) * EVERY + 1;
  const samples = new Float32Array(m * 6), sAlong = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    const k = Math.floor(j / EVERY), f = (j % EVERY) / EVERY;
    const a = k * 6, b = Math.min(n - 1, k + 1) * 6, o = j * 6;
    for (let c = 0; c < 6; c++) {
      const d = c === 3 ? wrap(coarse[b + c] - coarse[a + c]) : coarse[b + c] - coarse[a + c];
      samples[o + c] = coarse[a + c] + d * f;
    }
    sAlong[j] = sAt[k] + (sAt[Math.min(n - 1, k + 1)] - sAt[k]) * f;
  }
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) throw new GhostError('That code is damaged.');
  return { stageId: stage.id, stageName: stage.name, name, timeMs, samples, sAlong };
}
