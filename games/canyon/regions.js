// Regions — what makes Endless endless.
//
// A seeded stream of landscapes, a few kilometres each, built by MIXING the biomes'
// parts instead of replaying them: a road style (how the road bends and climbs), a
// land shape (canyon walls, rolling hills, a mountainside, sea cliffs) and a look
// (colours, plants, rocks) are picked independently — so hairpins up a red-rock
// canyon, or fast sweepers through pines above the sea. Each region rolls its own
// weather. A region arrives either gradually (a 600 m crossfade) or all at once,
// inside a tunnel. Bridges over river gorges and small towns turn up in between.
//
// Time of day runs on its own clock (by distance), so any region can come at dawn,
// in the afternoon or at night.
//
// Pure (no three.js). Regions are created as the road grows, from one seeded stream
// in a fixed order, so the same seed always gives the same ride.

import { BIOMES } from './stages.js';
import { mulberry32, hash2 } from './road.js';

const KEYS = ['desert', 'chaparral', 'pine', 'coast', 'night'];
const SHAPES = ['canyon', 'hills', 'slope', 'coast'];
const LAND = { canyon: ['desert'], hills: ['chaparral'], slope: ['pine', 'night'], coast: ['coast'] };
const FAMILY = { desert: 'desert', chaparral: 'chaparral', pine: 'forest', night: 'forest', coast: 'coast' };
export const DAY = ['dawn', 'midday', 'afternoon', 'golden', 'sunset', 'night'];
const PHASE = 5000;            // metres per time-of-day phase: a whole day is ~30 km
const BLEND = 600;             // a gradual region change
const AHEAD = 1300;            // create the next region this far before it starts
const CALM = 420;              // gentle road this far before a feature (the planner can
                               // commit to ~300 m of corner at a time)
export const TOWN_FLAT = 34;   // metres of level ground beside the road in a town
export const TUNNEL_LEAD = 150;  // metres over which the hill rises to a tunnel portal

const LOOK_NAME = { desert: 'Red Rock', chaparral: 'Sagebrush', pine: 'Timber', coast: 'Seaside', night: 'Dark Pine' };
const LAND_NAME = { canyon: 'Canyon', hills: 'Hills', slope: 'Pass', coast: 'Bluffs' };
const SAND = 0xd8c79a;
const TOWN_A = ['Pine', 'Dry', 'Cedar', 'Coyote', 'Granite', 'Willow', 'Rattlesnake', 'Juniper', 'Copper', 'Sage', 'Eagle', 'Lone', 'Mesa', 'Bear', 'Silver', 'Owl'];
const TOWN_B = ['Hollow', 'Wells', 'Flat', 'Springs', 'Gulch', 'Junction', 'Creek', 'Ridge', 'Crossing', 'Bend', 'Gap', 'Station', 'Falls', 'Mill'];
const CLEAR = { rain: 0, fog: 0, overcast: 0 };

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => t * t * (3 - 2 * t);
const ramp = x => smooth(clamp(x, 0, 1));

// Numeric road-style fields crossfade between two styles; the corner mix switches halfway.
export function blendStyle(A, B, t) {
  const o = { ...(t < 0.5 ? A : B) };
  for (const k of ['halfWidth', 'shoulder', 'gradeMax', 'gradeBias']) o[k] = lerp(A[k], B[k], t);
  o.yRange = [lerp(A.yRange[0], B.yRange[0], t), lerp(A.yRange[1], B.yRange[1], t)];
  return o;
}

// The road near a tunnel, bridge or town: long sweepers, gentle grades.
function calmOf(st) {
  return {
    ...st, mix: { straight: 0.35, sweeper: 0.65, corner: 0, esses: 0, hairpin: 0 },
    straight: [60, 160], sweeperR: [260, 520], sweeperAng: [8, 26], gradeMax: 0.018, gradeBias: 0,
  };
}

export function makeRegions(seed, y0 = 140) {
  const r = mulberry32(hash2(seed, 4242));
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const regions = [], features = [];
  const dayOff = 1 + r() * 2.5;              // start somewhere between midday and golden hour

  function create(y) {
    const prev = regions[regions.length - 1] || null;
    const i = regions.length;
    const s0 = prev ? prev.s1 : 0;

    // Mix the parts; never repeat more than one of the last region's three. Land is
    // picked by shape (pine and night are both mountainsides) and looks by family
    // (pine and night are both forest), so "different" means visibly different.
    let terrKey, styleKey, lookKey;
    for (let k = 0; k < 12; k++) {
      const shape = pick(SHAPES);
      terrKey = pick(LAND[shape]);
      styleKey = shape === 'coast' ? pick(['coast', 'desert', 'chaparral']) : pick(KEYS);
      lookKey = r() < 0.4 ? terrKey : pick(KEYS);
      if (!prev) break;
      const same = (shape === BIOMES[prev.terrKey].terrain.mode) + (styleKey === prev.styleKey) + (FAMILY[lookKey] === FAMILY[prev.lookKey]);
      if (same <= 1) break;
    }

    // Sea level is set per region, below wherever the road happens to be, so sea
    // cliffs work at any altitude instead of forcing a 20 km descent to y = 0.
    const sea = terrKey === 'coast';
    const seaY = sea ? y - 55 - 35 * r() : null;
    const base = BIOMES[styleKey].road;
    const yRange = sea ? [seaY + 28, seaY + 110]
      : [Math.max(-150, Math.min(base.yRange[0], y - 250)), y > 1800 ? y + 60 : Math.max(base.yRange[1], y + 250)];
    const style = { ...base, yRange };

    const tb = BIOMES[terrKey].terrain;
    const amp = 0.75 + 0.55 * r();
    const terrain = { ...tb, up: tb.up.map(v => v * amp), soft: tb.soft * (0.85 + 0.3 * r()), rough: tb.rough * (0.7 + 0.6 * r()) };
    if (tb.down) terrain.down = tb.down.map(v => v * amp);
    if (tb.mode === 'slope') {
      // Uphill ahead when the road climbs, behind when it descends, else to one side.
      const bias = style.gradeBias;
      terrain.upDir = bias > 0.02 ? [1, 0] : bias < -0.02 ? [-1, 0] : [0, r() < 0.5 ? 1 : -1];
    }
    if (sea) terrain.seaFloor = seaY - 9;

    const lb = BIOMES[lookKey];
    const palette = sea && !lb.palette.sand ? { ...lb.palette, sand: SAND } : lb.palette;
    const look = { key: lookKey, palette, props: lb.props, seaY };

    let weather = CLEAR;                     // the first region is clear: a fair first look
    if (prev) {
      const w = r();
      weather = w < 0.5 ? CLEAR
        : w < 0.68 ? { rain: 0, fog: 0, overcast: 0.6 + 0.4 * r() }
        : w < 0.83 ? { rain: 0, fog: 0.65 + 0.35 * r(), overcast: 0.5 }
        : { rain: 1, fog: 0.15, overcast: 1 };
    }

    const len = 2600 + 3400 * r();
    const enter = prev ? (r() < 0.5 ? 'tunnel' : 'blend') : 'start';
    const reg = {
      i, s0, s1: s0 + len, enter, styleKey, terrKey, lookKey, style, terrain, look, weather, seaY,
      name: `${LOOK_NAME[lookKey]} ${LAND_NAME[terrain.mode]}`,
    };
    regions.push(reg);

    // ---- features ----
    const placed = [];
    if (enter === 'tunnel') {
      // The change happens at the tunnel's midpoint, out of sight.
      const L = 240 + 360 * r();
      placed.push({ type: 'tunnel', s0: s0 - L / 2, s1: s0 + L / 2, H: 11 + 4 * r(), H2: 22 + 28 * r(), change: true, region: i });
    }
    const a = s0 + 1100, b = reg.s1 - 1100;
    const want = [];
    if (r() < 0.45) want.push({ type: 'town', L: 380 + 280 * r() });
    if (r() < 0.6) want.push({ type: 'bridge', L: 150 + 160 * r() });
    if (r() < 0.2) want.push({ type: 'bridge', L: 140 + 120 * r() });
    if (r() < 0.25) want.push({ type: 'tunnel', L: 180 + 220 * r() });
    for (const w of want) {
      if (b - a < w.L) break;
      for (let k = 0; k < 6; k++) {
        const p = a + r() * (b - a - w.L);
        if (placed.some(o => p < o.s1 + 650 && p + w.L > o.s0 - 650)) continue;
        const f = { type: w.type, s0: p, s1: p + w.L, region: i };
        if (w.type === 'tunnel') { f.H = 11 + 4 * r(); f.H2 = 22 + 28 * r(); f.change = false; }
        if (w.type === 'bridge') { f.depth = 22 + 33 * r(); f.kind = f.depth > 34 && r() < 0.6 ? 'arch' : 'piers'; }
        if (w.type === 'town') { f.name = `${pick(TOWN_A)} ${pick(TOWN_B)}`; f.pop = 80 + Math.floor(r() * 1900); }
        placed.push(f);
        break;
      }
    }
    placed.sort((p, q) => p.s0 - q.s0);
    features.push(...placed);
    return reg;
  }

  // Make sure regions (and their features) exist up to distance s. `y` is the road's
  // planned altitude there, used for a new region's sea level and altitude band.
  function extend(s, y) {
    while (!regions.length || regions[regions.length - 1].s1 - AHEAD <= s) create(y);
  }

  // ---- lookups (called per terrain vertex: no allocation, walk from the last hit) ----
  let rh = 0;
  function regionIndex(s) {
    let k = Math.min(rh, regions.length - 1);
    while (k > 0 && s < regions[k].s0) k--;
    while (k < regions.length - 1 && s >= regions[k].s1) k++;
    rh = k;
    return k;
  }
  const M = { a: null, b: null, t: 0 };
  function mix(s) {
    const k = regionIndex(s), R = regions[k];
    if (k > 0 && R.enter === 'blend' && s < R.s0 + BLEND) { M.a = regions[k - 1]; M.b = R; M.t = smooth(clamp((s - R.s0) / BLEND, 0, 1)); }
    else { M.a = R; M.b = R; M.t = 0; }
    return M;
  }

  // The feature whose span, widened by `pre` before and `post` after, contains s.
  // Features are sorted and at least 650 m apart, more than any pre + post used here.
  let fh = 0;
  function featureNear(s, pre, post) {
    const n = features.length;
    if (!n) return null;
    let k = Math.min(fh, n - 1);
    while (k > 0 && features[k].s0 - pre > s) k--;
    while (k < n - 1 && features[k + 1].s0 - pre <= s) k++;
    fh = k;
    const f = features[k];
    return s >= f.s0 - pre && s <= f.s1 + post ? f : null;
  }

  // How strongly a feature shapes the land at s (0..1).
  function featureWeight(f, s) {
    if (f.type === 'tunnel') return ramp((s - (f.s0 - TUNNEL_LEAD)) / TUNNEL_LEAD) * ramp((f.s1 + TUNNEL_LEAD - s) / TUNNEL_LEAD);
    if (f.type === 'bridge') { const q = (f.s1 - f.s0) * 0.25; return ramp((s - f.s0) / q) * ramp((f.s1 - s) / q); }
    return ramp((s - (f.s0 - 80)) / 80) * ramp((f.s1 + 80 - s) / 80);
  }

  const calmCache = new WeakMap();
  function style(s) {
    const m = mix(s);
    const st = m.t > 0 ? blendStyle(m.a.style, m.b.style, m.t) : m.a.style;
    const f = featureNear(s, CALM, 60);
    if (!f) return st;
    let c = m.t > 0 ? null : calmCache.get(st);
    if (!c) { c = calmOf(st); if (m.t <= 0) calmCache.set(st, c); }
    if (f.change) {
      // Through a region-changing tunnel the road eases from one width to the other.
      const A = regions[regionIndex(f.s0 - 1)].style, B = regions[regionIndex(f.s1 + 1)].style;
      const u = clamp((s - f.s0 + 60) / (f.s1 - f.s0 + 120), 0, 1);
      return { ...c, halfWidth: lerp(A.halfWidth, B.halfWidth, u), shoulder: lerp(A.shoulder, B.shoulder, u) };
    }
    return c;
  }

  const P = { a: null, b: null, t: 0, feat: null, fw: 0, flat: 0 };
  function profile(s) {
    const m = mix(s);
    P.a = m.a.terrain; P.b = m.b.terrain; P.t = m.t;
    P.feat = null; P.fw = 0; P.flat = 0;
    const f = featureNear(s, TUNNEL_LEAD, TUNNEL_LEAD);
    if (f) {
      const w = featureWeight(f, s);
      if (w > 0) {
        if (f.type === 'town') P.flat = TOWN_FLAT * w;
        else { P.feat = f; P.fw = w; }
      }
    }
    return P;
  }

  function look(s) { const m = mix(s); return { a: m.a.look, b: m.b.look, t: m.t }; }

  const T = { a: '', b: '', t: 0 };
  function tod(s) {
    const u = s / PHASE + dayOff;
    const k = Math.floor(u), f = u - k;
    T.a = DAY[((k % 6) + 6) % 6];
    T.b = DAY[(((k + 1) % 6) + 6) % 6];
    T.t = f < 0.5 ? 0 : smooth((f - 0.5) / 0.5);
    return T;
  }

  const W = { rain: 0, fog: 0, overcast: 0 };
  function weather(s) {
    const m = mix(s);
    W.rain = lerp(m.a.weather.rain, m.b.weather.rain, m.t);
    W.fog = lerp(m.a.weather.fog, m.b.weather.fog, m.t);
    W.overcast = lerp(m.a.weather.overcast, m.b.weather.overcast, m.t);
    return W;
  }

  // How far inside a tunnel (0 outside, 1 more than ~35 m in).
  function tunnelAt(s) {
    const f = featureNear(s, 0, 0);
    if (!f || f.type !== 'tunnel') return 0;
    return ramp((s - f.s0) / 35) * ramp((f.s1 - s) / 35);
  }

  function seaAt(s) {
    const m = mix(s);
    return m.t < 0.5 ? (m.a.seaY ?? m.b.seaY) : (m.b.seaY ?? m.a.seaY);
  }

  return {
    regions, features, extend, style, profile, look, tod, weather, tunnelAt, seaAt,
    regionAt: s => regions[regionIndex(s)],
    featureAt: s => featureNear(s, 0, 0),
    featuresIn(s0, s1) { return features.filter(f => f.s1 >= s0 && f.s0 <= s1); },
  };
}
