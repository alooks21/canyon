// Course — one ride: road, land, checkpoints, guardrails, corners.
//
// Pure, and shared by everything: the renderer draws it, the physics collides with
// it, the autopilot and the tests ride it headless. Terrain tiles live here (not in
// the renderer) so the ground you hit is, by construction, the ground you see.

import { Road, DS } from './road.js';
import { makeTerrain, gridHeight, TILE } from './terrain.js';
import { BIOMES } from './stages.js';
import { makeRegions } from './regions.js';

// Ride to my music: a new song's tunnel starts at least MUSIC_AHEAD past the rider,
// beyond everything world.js may have built (road meshes reach 1.2 km plus one 200 m
// chunk; terrain tiles under 1 km). Its region can be re-dressed while its start is
// still MUSIC_REDRESS ahead — no tile beyond it can exist yet.
const MUSIC_AHEAD = 1500, MUSIC_REDRESS = 1100;

export function makeCourse(def) {
  const endless = def.id === 'endless';
  let styleAt, profileAt, biomeAt, todAt, regions = null, road = null;

  if (!endless) {
    const b = BIOMES[def.biome];
    const pm = { a: b.terrain, b: b.terrain, t: 0 };
    const look = { ...b, key: def.biome, seaY: def.biome === 'coast' ? 0 : null };
    const bm = { a: look, b: look, t: 0 };
    const tm = { a: def.tod, b: def.tod, t: 0 };
    styleAt = () => b.road;
    profileAt = () => pm;
    biomeAt = () => bm;
    todAt = () => tm;
  } else {
    // Regions are created as the road reaches them (see regions.js). Only the road's
    // own queries create them, in the road's fixed order, so a seed always replays.
    regions = makeRegions(def.seed, def.y0, def.director || null);
    regions.extend(0, def.y0);
    styleAt = s => { regions.extend(s, road ? road.planY : def.y0); return regions.style(s); };
    profileAt = regions.profile;
    biomeAt = regions.look;
    todAt = regions.tod;
  }

  road = new Road(def.seed, styleAt, { y0: def.y0 });
  const length = endless ? Infinity : def.length;
  road.ensure(endless ? 2500 : def.length + 900);
  const terrain = makeTerrain(road, profileAt, def.seed, def.y0);

  // Stages: 3–5 sectors of ~1.1 km. The last checkpoint is the finish line.
  const sectors = endless ? 0 : Math.max(3, Math.round(def.length / 1100));
  const checkpoints = [];
  for (let k = 1; k <= sectors; k++) checkpoints.push(def.length * k / sectors);

  // ---------- terrain tiles (shared cache) ----------
  const tiles = new Map();
  const key = (tx, tz) => tx * 100003 + tz;
  function tile(tx, tz) {
    const k = key(tx, tz);
    let t = tiles.get(k);
    if (!t) { t = terrain.generate(tx, tz); tiles.set(k, t); }
    return t;
  }
  const hasTile = (tx, tz) => tiles.has(key(tx, tz));
  // A tile built a slice per call (see terrain.generateSteps). step() returns the
  // finished tile, or null while it's still working. If physics needed the same tile
  // in the meantime it was built synchronously — the job then just hands that back.
  function tileJob(tx, tz) {
    const it = terrain.generateSteps(tx, tz);
    return {
      tx, tz,
      step() {
        const k = key(tx, tz);
        if (tiles.has(k)) return tiles.get(k);
        const r = it.next();
        if (!r.done) return null;
        tiles.set(k, r.value);
        return r.value;
      },
    };
  }
  // Ground height anywhere (generates the tile if needed — the renderer normally has).
  function groundAt(x, z) {
    return gridHeight(tile(Math.floor(x / TILE), Math.floor(z / TILE)), x, z);
  }
  // Drop tiles whose centre is far from (x, z). The renderer frees its meshes first.
  function releaseTiles(x, z, radius, onRelease) {
    for (const [k, t] of tiles) {
      const cx = t.x0 + TILE / 2, cz = t.z0 + TILE / 2;
      if (Math.hypot(cx - x, cz - z) > radius) { onRelease?.(t); tiles.delete(k); }
    }
  }

  // ---------- guardrails ----------
  // Raw flag per sample: bit 1 = left drop, bit 2 = right drop. A rail goes wherever
  // the land falls more than 2.5 m within 4 m of the shoulder, smoothed so rails come
  // in sensible runs instead of flickering on and off.
  let raw = new Uint8Array(4096), rawUpTo = 0;
  const q = {};
  function ensureFeatures(i) {
    i = Math.min(i, road.n - 1);
    if (i < rawUpTo) return;
    if (i >= raw.length) { const n = new Uint8Array(Math.max(i + 1, raw.length * 2)); n.set(raw); raw = n; }
    for (let j = rawUpTo; j <= i; j++) {
      road.at(j * DS, q);
      let f = 0;
      for (const side of [-1, 1]) {
        const yEdge = q.y - side * (q.hw + q.sh) * Math.tan(q.bank);
        if (yEdge - terrain.sideHeight(j, side, 4) > 2.5) f |= side < 0 ? 1 : 2;
      }
      raw[j] = f;
    }
    rawUpTo = i + 1;
  }
  function railAt(i, side) {
    if (regions) {
      // Bridges always have rails; tunnels and towns have walls and kerbs instead.
      const f = regions.featureAt(i * DS) || regions.featureAt(i * DS - 8) || regions.featureAt(i * DS + 8);
      if (f) return f.type === 'bridge';
    }
    ensureFeatures(i + 6);
    const bit = side < 0 ? 1 : 2;
    let c = 0;
    for (let j = Math.max(0, i - 5); j <= i + 5 && j < rawUpTo; j++) if (raw[j] & bit) c++;
    return c >= 5;
  }

  // ---------- corners (for warning signs and the lap-time sim) ----------
  const corners = [];
  let cornerScan = 0, open = null;
  function cornersUpTo(s) {
    const iMax = Math.min(road.n - 1, Math.floor(s / DS));
    for (let i = cornerScan; i <= iMax; i++) {
      const k = road.kappa[i], ak = Math.abs(k);
      if (open) {
        const flipped = Math.sign(k) !== open.sign && ak > 1 / 400;
        if (ak < 1 / 400 || flipped) {
          if ((i - open.i0) * DS >= 12) corners.push({ s0: open.i0 * DS, s1: i * DS, sPeak: open.iPeak * DS, R: 1 / open.peak, sign: open.sign });
          open = null;
        } else if (ak > open.peak) { open.peak = ak; open.iPeak = i; }
      }
      if (!open && ak > 1 / 260) open = { i0: i, iPeak: i, peak: ak, sign: Math.sign(k) };
    }
    cornerScan = iMax + 1;
    return corners;
  }

  // What stops the bike at the road's edge: a guardrail, a tunnel wall or a town kerb.
  function barrierAt(i, side) {
    const f = regions?.featureAt(i * DS);
    if (f && f.type === 'tunnel') return 'wall';
    if (f && f.type === 'town') return 'kerb';
    return railAt(i, side) ? 'rail' : null;
  }

  // Endless extras. Stages: dry, no tunnels, sea only on the coast stage.
  const weatherAt = regions ? s => regions.weather(s) : () => null;
  const tunnelAt = regions ? s => regions.tunnelAt(s) : () => 0;
  // Wet asphalt grips ~20% less (a tunnel stays dry).
  const gripAt = regions ? s => 1 - 0.2 * regions.weather(s).rain * (1 - regions.tunnelAt(s)) : () => 1;
  const seaAt = regions ? s => regions.seaAt(s) : () => (def.biome === 'coast' ? 0 : null);
  // A bridge's river: just above the gorge floor at mid-span (needs the road there).
  function waterY(f) {
    if (f.waterY == null) {
      const mid = (f.s0 + f.s1) / 2;
      if (road.length < mid) return null;
      road.at(mid, q);
      f.waterY = q.y - f.depth + 1.2;
    }
    return f.waterY;
  }

  return {
    def, endless, road, terrain, length, checkpoints,
    styleAt, biomeAt, todAt, weatherAt, tunnelAt, gripAt, seaAt, waterY,
    regionAt: s => regions?.regionAt(s) || null,
    featureAt: s => regions?.featureAt(s) || null,
    featuresIn: (s0, s1) => regions ? regions.featuresIn(s0, s1) : [],
    tile, hasTile, tileJob, groundAt, releaseTiles,
    railAt, barrierAt, cornersUpTo,
    // Endless grows the road ahead of the rider; stages are pre-built.
    ensure(s) { if (endless) road.ensure(s + 1600); },
    // Ride to my music, from the rider at s: a new song (returns its region), and a
    // late change of that region's vibe (false once it's too close to change).
    musicCut: s => regions.songCut(s + MUSIC_AHEAD, road.planY),
    musicRedress(reg, s) {
      if (reg.s0 - s < MUSIC_REDRESS) return false;
      regions.redress(reg);
      return true;
    },
    startS: 24,
  };
}
