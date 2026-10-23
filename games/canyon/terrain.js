// Terrain — the land either side of the road, defined *relative to the road*.
//
// Pure (no three.js). world.js turns the height grids into meshes; physics reads the
// very same grids, so what you collide with is exactly what you see.
//
// Every point of land asks "where is the nearest road, how far away, which side?"
// and builds its height from that: flat under the asphalt, a dirt verge, then the
// biome's cross-section — canyon walls, a hillside falling away, a cliff to the sea.
// Because the land is shaped around the road (rather than the road being bulldozed
// through land), the road always fits, however twisty the generator makes it.

import { DS, makeNoise2D, fbm, hash2, mulberry32 } from './road.js';

export const TILE = 192;          // metres per terrain tile
export const GRID = 64;           // cells per tile side
export const CELL = TILE / GRID;  // 3 m
// Flat dirt beyond the shoulder. It must exceed one cell diagonal (4.24 m): then no
// terrain triangle that touches the paved surface has a raised vertex, so walls can
// never poke up through the road between grid points.
export const VERGE = 5;
// Where the land FALLS away the verge can be narrow — terrain below the road can't
// poke through it — so drops start almost at the shoulder, where guardrails belong.
const DROP_VERGE = 1.2;
const COARSE = 4;                 // nearest-road search runs on every 4th vertex first

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => t * t * (3 - 2 * t);

// Sandstone ledges: hold flat for most of each step, then rise steeply.
function terrace(h, step) {
  const k = Math.floor(h / step);
  const f = h / step - k;
  const g = f < 0.55 ? 0 : (f - 0.55) / 0.45;
  return (k + g * g * (3 - 2 * g)) * step;
}

// `profileAt(s)` returns { a, b, t }: the terrain profiles in force at road distance s
// and how far to blend from a to b (stages always return t = 0).
export function makeTerrain(road, profileAt, seed, baseY = 100) {
  const nSlow = makeNoise2D(hash2(seed, 101));
  const nRock = makeNoise2D(hash2(seed, 202));
  const qa = {}, qb = {};
  let lastT = 0;                  // distance beyond the verge of the last evaluation

  // Height of the land at (x, z) according to one road projection q. `xf` widens the
  // level ground beside the road (a town's shelf).
  function fromRoad(prof, q, x, z, xf = 0) {
    const edge = q.hw + q.sh;
    const dAbs = Math.abs(q.d);
    const dc = clamp(q.d, -edge, edge);
    const yEdge = q.y - dc * Math.tan(q.bank);
    // Just under the asphalt; the verge drops away a touch so it reads as dirt.
    const under = yEdge - 0.45 - 0.05 * Math.max(0, dAbs - edge);
    if (dAbs <= edge + DROP_VERGE) { lastT = dAbs - edge - VERGE; return under; }
    const side = q.d > 0 ? 1 : -1;
    const nx = -Math.sin(q.psi) * side, nz = Math.cos(q.psi) * side;   // outward, this side
    const vary = clamp(0.5 + 0.75 * nSlow(q.s / 260 + side * 13.7, 3.1), 0, 1);
    let amp, soft = prof.soft;

    if (prof.mode === 'slope') {
      // Uphill on whichever side faces upDir. For stacked switchbacks this puts each
      // leg's wall toward the next (higher) leg, so the hillside reads as one slope.
      const w = clamp((nx * prof.upDir[0] + nz * prof.upDir[1]) * 2.5, -1, 1);
      amp = lerp(lerp(prof.down[0], prof.down[1], vary), lerp(prof.up[0], prof.up[1], vary), (w + 1) / 2);
    } else if (prof.mode === 'coast') {
      const w = nx * prof.oceanDir[0] + nz * prof.oceanDir[1];
      const land = lerp(prof.up[0], prof.up[1], vary);
      const sea = prof.seaFloor - yEdge;
      const k = clamp((w + 0.25) / 0.5, 0, 1);
      amp = lerp(land, sea, k);
      soft = lerp(prof.soft, prof.seaSoft, k);
    } else {
      amp = lerp(prof.up[0], prof.up[1], vary);   // canyon and hills
    }

    amp *= 0.8 + 0.5 * (0.5 + nSlow(x / 700, z / 700));
    // Full verge wherever the land rises; narrow where it falls (continuous in amp).
    // `floor` widens the flat ground in places — a canyon that opens and narrows.
    const v = clamp((amp + 6) / 6, 0, 1);
    const open = prof.floor ? lerp(prof.floor[0], prof.floor[1], clamp(0.5 + nSlow(q.s / 420, side * 5.3 + 40), 0, 1)) : 0;
    const flat = edge + DROP_VERGE + (VERGE + open - DROP_VERGE) * v * v * (3 - 2 * v) + xf;
    if (dAbs <= flat) { lastT = dAbs - flat; return under; }
    const t = dAbs - flat;
    lastT = t;
    let h;
    if (amp > 0 && prof.mode !== 'canyon') {
      // Rising ground beside a mountain road: a short steep road cut, then the
      // natural hillside at a gentler angle. (One long steep rise is both less
      // realistic and too steep for a 3 m grid — it renders as sawtooth slivers.)
      const cut = Math.min(amp, 5 + 5 * vary);
      h = cut * (1 - Math.exp(-t / 2.2)) + (amp - cut) * (1 - Math.exp(-t / (soft * 1.8)));
    } else h = amp * (1 - Math.exp(-t / soft));
    if (prof.strata && h > 0) h = terrace(h, prof.strata);
    h += prof.rough * 2 * fbm(nRock, x / 36, z / 36, 4) * (t < 14 ? t / 14 : 1);
    return yEdge + h;
  }

  function blended(q, x, z) {
    const m = profileAt(q.s);
    const xf = m.flat || 0;
    let h = fromRoad(m.a, q, x, z, xf);
    if (m.t > 0) {
      const t = lastT;
      const h2 = fromRoad(m.b, q, x, z, xf);
      lastT = t;
      h = lerp(h, h2, m.t);
    }
    if (m.fw > 0) h = feature(m.feat, m.fw, q, x, z, h);
    return h;
  }

  // Endless features reshape the land around the road (weight w, 0..1):
  //   tunnel — a hill over the road. The road keeps a level slot as wide as a rising
  //            verge (so nothing pokes through it); world.js roofs the slot over and
  //            builds the tube, portals and lighting inside it.
  //   bridge — a river gorge across the road. It only ever lowers the land.
  function feature(f, w, q, x, z, h) {
    const edge = q.hw + q.sh, dAbs = Math.abs(q.d);
    const dc = clamp(q.d, -edge, edge);
    const yEdge = q.y - dc * Math.tan(q.bank);
    if (f.type === 'tunnel') {
      const slot = edge + VERGE;
      let hT;
      if (dAbs <= slot) {
        hT = yEdge - 0.45 - 0.05 * Math.max(0, dAbs - edge);
        if (w > 0.5) lastT = dAbs - slot;
      } else {
        // A shoulder the height of the portal headwall beside the slot, then the
        // mountain proper rising behind it (so the road goes under a saddle).
        const t = dAbs - slot;
        hT = yEdge + tunnelCrest(f, q.s) * smooth(clamp(t / 5, 0, 1))
          + f.H2 * smooth(clamp((t - 4) / 70, 0, 1)) * (1 - 0.6 * smooth(clamp((t - 120) / 220, 0, 1)))
          + (1.2 + 3 * smooth(clamp((t - 10) / 40, 0, 1))) * fbm(nRock, x / 30, z / 30, 3) * clamp(t / 10, 0, 1);
        if (w > 0.5) lastT = t;
      }
      return lerp(h, hT, w);
    }
    // bridge: valley floor `depth` below the road, river banks either side of it.
    // Under the deck it's valley floor, not roadside verge, so colour it as ground.
    const floor = q.y - f.depth + 2.5 * fbm(nRock, x / 60, z / 60, 3);
    if (w > 0.3) lastT = Math.max(lastT, 6);
    return h > floor ? h - (h - floor) * w : h;
  }

  // Land height at lateral offset d from road sample i (bridge piers and arches).
  const qh = {};
  function heightAt(i, d) {
    road.at(i * DS, qh);
    qh.d = d;
    return blended(qh, qh.x - Math.sin(qh.psi) * d, qh.z + Math.cos(qh.psi) * d);
  }

  // Build one tile's height grid. Returns heights plus two helper grids used for
  // colouring and prop placement: rel (height above the nearest road) and t
  // (metres beyond the verge; ≤ 0 means verge or road).
  //
  // Written as a generator that yields every few rows, so the renderer can spread
  // one tile over several frames instead of stalling one (a hitch you'd feel at
  // speed on a slower laptop). generate() runs it to completion in one go.
  function* generateSteps(tx, tz) {
    const cand = [];
    const N = GRID + 1;
    const x0 = tx * TILE, z0 = tz * TILE;
    const heights = new Float32Array(N * N);
    const rel = new Float32Array(N * N);
    const tOut = new Float32Array(N * N);
    const near = new Int32Array(N * N);       // nearest road sample index per vertex

    // Candidate road samples around this tile (every 3rd — refinement fixes it up).
    let R = 300;
    road.collect(x0 - R, x0 + TILE + R, z0 - R, z0 + TILE + R, 3, cand);
    if (!cand.length) { R = 800; road.collect(x0 - R, x0 + TILE + R, z0 - R, z0 + TILE + R, 6, cand); }

    if (!cand.length) {
      for (let i = 0; i < N * N; i++) {
        const x = x0 + (i % N) * CELL, z = z0 + Math.floor(i / N) * CELL;
        heights[i] = baseY + 40 + 30 * fbm(nRock, x / 120, z / 120, 3);
        rel[i] = 40; tOut[i] = 99; near[i] = -1;
      }
      return { tx, tz, x0, z0, heights, rel, t: tOut, near };
    }

    // Coarse pass: for every 4th vertex, brute-force the nearest candidate and the
    // nearest candidate on a *different* stretch of road (≥ 70 m away along it).
    const C = GRID / COARSE + 1;
    const hintA = new Int32Array(C * C), hintB = new Int32Array(C * C);
    const xs = road.x, zs = road.z;
    for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
      const x = x0 + ci * COARSE * CELL, z = z0 + cj * COARSE * CELL;
      let best = -1, bd = Infinity;
      for (let k = 0; k < cand.length; k++) {
        const i = cand[k];
        const d = (xs[i] - x) ** 2 + (zs[i] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      let best2 = -1, bd2 = Infinity;
      for (let k = 0; k < cand.length; k++) {
        const i = cand[k];
        if (Math.abs(i - best) < 35) continue;
        const d = (xs[i] - x) ** 2 + (zs[i] - z) ** 2;
        if (d < bd2) { bd2 = d; best2 = i; }
      }
      hintA[cj * C + ci] = best;
      hintB[cj * C + ci] = Math.sqrt(bd2) < Math.sqrt(bd) + 140 ? best2 : -1;
    }
    yield;

    // Fine pass: refine from the coarse hints by walking along the road.
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = x0 + i * CELL, z = z0 + j * CELL;
      const c = Math.round(j / COARSE) * C + Math.round(i / COARSE);
      let a = road.track(x, z, hintA[c], qa);
      let b = hintB[c] >= 0 ? road.track(x, z, hintB[c], qb) : null;
      if (b && Math.abs(b.i - a.i) < 30) b = null;               // walked onto the same stretch
      if (b && b.dist < a.dist) { const t = a; a = b; b = t; }    // a = nearest

      let H = blended(a, x, z);
      const ta = lastT;
      if (b && ta > 0) {
        const Hb = blended(b, x, z);
        const tb = lastT;
        if (tb <= 0) H = Hb;
        else {
          // Inverse-square blend between two nearby stretches (switchback legs), so
          // the hillside between them is one continuous slope instead of a seam.
          const wa = 1 / (ta * ta), wb = 1 / (tb * tb);
          H = (H * wa + Hb * wb) / (wa + wb);
        }
      }
      const k = j * N + i;
      heights[k] = H;
      rel[k] = H - a.y;
      tOut[k] = ta;
      near[k] = a.i;
      if (i === N - 1 && j % 9 === 8) yield;
    }
    return { tx, tz, x0, z0, heights, rel, t: tOut, near };
  }

  function generate(tx, tz) {
    const it = generateSteps(tx, tz);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }

  // Land height `extra` metres beyond the shoulder on one side (±1) of sample i,
  // using that sample's own profile. Decides where guardrails go.
  const qs = {};
  function sideHeight(i, side, extra) {
    road.at(i * DS, qs);
    const d = side * (qs.hw + qs.sh + extra);
    qs.d = d;
    return blended(qs, qs.x - Math.sin(qs.psi) * d, qs.z + Math.cos(qs.psi) * d);
  }

  return { generate, generateSteps, sideHeight, heightAt };
}

// Height of a tunnel's hill right beside the slot (above the road): the portal
// headwall's height at each end, climbing over the middle so the road runs into a
// hillside rather than under a flat bridge of land. world.js roofs the slot to match.
export function tunnelCrest(f, s) {
  const u = smooth(clamp((s - f.s0) / 70, 0, 1)) * smooth(clamp((f.s1 - s) / 70, 0, 1));
  return f.H + 0.7 * f.H2 * u;
}

// Height inside a tile grid, interpolated on exactly the triangles world.js meshes:
// every cell splits along the diagonal from (i+1, j) to (i, j+1).
export function gridHeight(tile, x, z) {
  const N = GRID + 1;
  let fx = (x - tile.x0) / CELL, fz = (z - tile.z0) / CELL;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0) i = 0; if (i > GRID - 1) i = GRID - 1;
  if (j < 0) j = 0; if (j > GRID - 1) j = GRID - 1;
  fx -= i; fz -= j;
  const h = tile.heights;
  const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
  if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}

// Scatter rocks and plants over a tile. Deterministic per tile, so a tile you ride
// past twice has the same trees in the same places. `biome` is a look ({ palette,
// props, seaY? }); `skip(x, y, z, k)` can veto a spot (a river, say).
export function placeProps(tile, biome, seed, out = [], skip = null) {
  const seaY = biome.seaY ?? (biome.palette.sand ? 0 : null);
  out.length = 0;
  const N = GRID + 1;
  const r = mulberry32(hash2(tile.tx, tile.tz, seed));
  const area = TILE * TILE / 1000;
  for (let p = 0; p < biome.props.length; p++) {
    const spec = biome.props[p];
    const tries = Math.round(spec.density * area);
    for (let n = 0; n < tries; n++) {
      const fx = r() * GRID, fz = r() * GRID;
      const i = Math.min(GRID - 1, Math.floor(fx)), j = Math.min(GRID - 1, Math.floor(fz));
      const k = j * N + i;
      const t = tile.t[k];
      if (t < spec.minT) continue;
      const h = tile.heights;
      const sx = (h[k + 1] - h[k]) / CELL, sz = (h[k + N] - h[k]) / CELL;
      if (Math.hypot(sx, sz) > spec.maxSlope) continue;
      const x = tile.x0 + fx * CELL, z = tile.z0 + fz * CELL;
      const y = gridHeight(tile, x, z);
      if (seaY != null && y < seaY + 2.5) continue;           // nothing grows in the sea
      if (skip && skip(x, y, z, k)) continue;
      out.push({
        type: spec.type, tint: spec.tint, x, y, z,
        scale: spec.scale[0] + (spec.scale[1] - spec.scale[0]) * r(),
        rot: r() * Math.PI * 2,
      });
    }
  }
  return out;
}
