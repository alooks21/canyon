// Road — a seeded, endless, self-avoiding mountain road.
//
// Pure: no three.js and no DOM, so Node can test it and the autopilot can ride it
// headless. Everything visual is built from these numbers by world.js.
//
// The road is stored as samples every DS metres: position, heading, curvature,
// grade and bank. Corners are planned as clothoids — curvature ramps linearly into
// and out of every bend — which is what real highway engineers use. It's why a
// well-built road never jerks the bars, and it keeps bank and lean continuous.
//
// Self-avoidance comes from one rule: the heading never strays more than 85° from
// the main direction (+x). Every sample therefore moves forward in x, so the road can
// come close to itself but can never cross. Hairpins swing between roughly +80° and
// −80°, which is exactly how real switchbacks climb a hillside.
//
// Conventions (used everywhere in the game):
//   forward f(ψ) = (cos ψ, 0, sin ψ)     right r(ψ) = (−sin ψ, 0, cos ψ)
//   curvature κ > 0 → right-hand bend     lateral offset d > 0 → right of centre
//   bank > 0 → right side lower (so a right-hander banks into the corner)

export const DS = 2;                       // sample spacing, metres
const LIMIT = 83 * Math.PI / 180;          // planning limit, 2° inside the hard 85°
const BLOCK = 32;                          // samples per bounding box (area queries)
const DEG = Math.PI / 180;

// ---------- seeded randomness ----------
// mulberry32: tiny, fast, and good enough for level generation. Math.random is never
// used for anything that shapes the world — the same seed must give the same road.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash for per-tile seeds, so a terrain tile looks the same every visit.
export function hash2(a, b, seed = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// 2D gradient noise (Perlin-style, quintic fade). Output roughly −0.7..0.7.
export function makeNoise2D(seed) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256), gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a); gy[i] = Math.sin(a);
  }
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const aa = perm[X + perm[Y]], ab = perm[X + perm[Y + 1]];
    const ba = perm[X + 1 + perm[Y]], bb = perm[X + 1 + perm[Y + 1]];
    const d00 = gx[aa] * xf + gy[aa] * yf;
    const d10 = gx[ba] * (xf - 1) + gy[ba] * yf;
    const d01 = gx[ab] * xf + gy[ab] * (yf - 1);
    const d11 = gx[bb] * (xf - 1) + gy[bb] * (yf - 1);
    const a = d00 + u * (d10 - d00);
    const b = d01 + u * (d11 - d01);
    return a + v * (b - a);
  };
}

// Fractal sum of the above — a few octaves turn smooth blobs into rock.
export function fbm(noise, x, y, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

const lerp = (a, b, t) => a + (b - a) * t;
const pick = (range, r) => lerp(range[0], range[1], r);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => t * t * (3 - 2 * t);

// ---------- the road ----------
// `styleAt(s)` returns the road style (corner mix, radii, grades, width) in force at
// distance s. Stages pass a constant; Endless passes one that drifts between biomes.
export class Road {
  constructor(seed, styleAt, { y0 = 120 } = {}) {
    this.styleAt = styleAt;
    this.rngK = mulberry32(seed);              // curvature stream
    this.rngG = mulberry32(hash2(seed, 7));    // grade stream — independent, so tuning
                                               // one never reshuffles the other
    this.cap = 0;
    this.n = 0;
    this._grow(4096);

    this.kq = []; this.kqHead = 0;             // planned curvature, one value per step
    this.gq = []; this.gqHead = 0;             // planned grade, one value per step
    this.planPsi = 0;                          // heading at the end of the planned curvature
    this.gradeNow = 0;
    this.planY = y0;                           // altitude at the end of the planned grade
    this.gPlanS = 0;
    this.lastType = 'straight';

    this.blocks = [];                          // [minX, maxX, minZ, maxZ] per BLOCK samples

    // A calm run-up so every start line sits on a straight.
    const st = styleAt(0);
    this._push(0, y0, 0, 0, 0, 0, 0, st.halfWidth, st.shoulder);
    this._ramp(0, 0, 70);
    for (let j = 0; j < 60 / DS; j++) this.gq.push(0);
    this.gPlanS = 60;
  }

  get length() { return (this.n - 1) * DS; }

  _grow(cap) {
    const keys = ['x', 'y', 'z', 'psi', 'kappa', 'grade', 'bank', 'hw', 'sh'];
    for (const k of keys) {
      const next = new Float64Array(cap);
      if (this[k]) next.set(this[k].subarray(0, this.n));
      this[k] = next;
    }
    this.cap = cap;
  }

  _push(x, y, z, psi, kappa, grade, bank, hw, sh) {
    if (this.n === this.cap) this._grow(this.cap * 2);
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.psi[i] = psi; this.kappa[i] = kappa; this.grade[i] = grade;
    this.bank[i] = bank; this.hw[i] = hw; this.sh[i] = sh;

    const b = (i / BLOCK) | 0;
    let box = this.blocks[b];
    if (!box) box = this.blocks[b] = [x, x, z, z];
    if (x < box[0]) box[0] = x; if (x > box[1]) box[1] = x;
    if (z < box[2]) box[2] = z; if (z > box[3]) box[3] = z;
  }

  // Generate until the road covers distance s.
  ensure(s) {
    while (this.length < s) this._step();
  }

  _step() {
    if (this.kqHead >= this.kq.length) this._planSegment();
    if (this.gqHead >= this.gq.length) this._planGrade();
    // Trim consumed plan arrays now and then so Endless doesn't grow them forever.
    if (this.kqHead > 4096) { this.kq = this.kq.slice(this.kqHead); this.kqHead = 0; }
    if (this.gqHead > 4096) { this.gq = this.gq.slice(this.gqHead); this.gqHead = 0; }

    const k = this.kq[this.kqHead++];
    const g = this.gq[this.gqHead++];
    const i = this.n - 1;
    const psiMid = this.psi[i] + k * DS * 0.5;
    const st = this.styleAt(this.n * DS);
    // Bank follows curvature (≤ ~3.4°). Clothoids make κ continuous, so bank is too.
    const bank = clamp(k * 3.0, -0.06, 0.06);
    this._push(
      this.x[i] + Math.cos(psiMid) * DS,
      this.y[i] + g * DS,
      this.z[i] + Math.sin(psiMid) * DS,
      this.psi[i] + k * DS,
      k, g, bank, st.halfWidth, st.shoulder,
    );
  }

  // Curvature ramp from k0 to k1 over L metres (k0 === k1 is a plain arc or straight).
  _ramp(k0, k1, L) { this._rampN(k0, k1, Math.max(1, Math.round(L / DS))); }

  _rampN(k0, k1, steps) {
    for (let j = 0; j < steps; j++) {
      const k = k0 + (k1 - k0) * ((j + 0.5) / steps);
      this.kq.push(k);
      this.planPsi += k * DS;
    }
  }

  // A full corner: clothoid in, arc, clothoid out. `ang` > 0 radians, sign ±1.
  // Lengths are rounded UP to whole steps and the curvature rescaled to fit, so the
  // corner turns through exactly `ang` (keeping the heading limit honest) and its
  // radius never comes out tighter than R.
  _corner(R, ang, sign, lt) {
    let la = ang * R - lt;                       // two half-ramps give k·lt of heading
    if (la < 0) { lt = ang * R; la = 0; }
    const nt = Math.max(1, Math.ceil(lt / DS));
    const na = la > 0 ? Math.ceil(la / DS) : 0;
    const k = sign * ang / (DS * (nt + na));
    this._rampN(0, k, nt);
    if (na) this._rampN(k, k, na);
    this._rampN(k, 0, nt);
  }

  // Pick a turn direction for a corner of `ang` that keeps the heading in bounds.
  // Returns [sign, ang] — ang may be shrunk if neither direction fits.
  _chooseSign(ang, wander) {
    const psi = this.planPsi;
    const toward = psi > 0 ? -1 : 1;             // turning back toward the main direction
    let sign;
    if (Math.abs(psi) < 0.08) sign = this.rngK() < 0.5 ? -1 : 1;
    else sign = this.rngK() < wander ? -toward : toward;
    if (Math.abs(psi + sign * ang) > LIMIT) sign = -sign;
    if (Math.abs(psi + sign * ang) > LIMIT) {
      sign = toward;
      ang = Math.max(8 * DEG, LIMIT + Math.abs(psi) - 2 * DEG);
    }
    return [sign, ang];
  }

  _planSegment() {
    const st = this.styleAt(this.length);
    const r = this.rngK;
    const psi = this.planPsi;

    // Weighted pick. Never two straights in a row — that's how roads get boring.
    const w = st.mix;
    let roll = r() * (w.straight + w.sweeper + w.corner + w.esses + w.hairpin);
    let type = 'hairpin';
    for (const t of ['straight', 'sweeper', 'corner', 'esses']) {
      if (roll < w[t]) { type = t; break; }
      roll -= w[t];
    }
    if (type === 'straight' && this.lastType === 'straight') type = 'sweeper';
    this.lastType = type;

    if (type === 'straight') {
      this._ramp(0, 0, pick(st.straight, r()));
    } else if (type === 'sweeper' || type === 'corner') {
      const R = pick(type === 'sweeper' ? st.sweeperR : st.cornerR, r());
      const [sign, ang] = this._chooseSign(pick(type === 'sweeper' ? st.sweeperAng : st.cornerAng, r()) * DEG, st.wander);
      this._corner(R, ang, sign, clamp(R * 0.45, 12, 70));
      if (r() < 0.5) this._ramp(0, 0, pick([8, 40], r()));
    } else if (type === 'esses') {
      const R = pick(st.essesR, r());
      const a1 = pick(st.essesAng, r()) * DEG;
      const [sign, ang1] = this._chooseSign(a1, 0.5);
      this._corner(R, ang1, sign, clamp(R * 0.4, 10, 40));
      this._ramp(0, 0, pick([0, 16], r()));
      // Second bend the other way, sized so the heading stays in bounds.
      const room = LIMIT + sign * this.planPsi;   // headroom when turning by −sign
      const ang2 = Math.max(8 * DEG, Math.min(pick(st.essesAng, r()) * DEG, room));
      this._corner(R, ang2, -sign, clamp(R * 0.4, 10, 40));
    } else {
      // Hairpin. Only possible from a steep traverse; otherwise set one up.
      if (Math.abs(psi) >= 48 * DEG) {
        const sign = psi > 0 ? -1 : 1;
        const target = pick([58, 80], r()) * DEG;
        const ang = Math.abs(psi) + target;
        const R = pick(st.hairpinR, r());
        this._corner(R, ang, sign, clamp(R * 0.8, 8, 14));
        this._ramp(0, 0, pick(st.leg, r()));     // the leg to the next switchback
      } else {
        const sign = psi >= 0 ? 1 : -1;          // swing away from centre into a traverse
        const target = pick([62, 80], r()) * DEG;
        const ang = Math.max(10 * DEG, target - Math.abs(psi));
        const R = pick(st.cornerR, r());
        this._corner(R, ang, sign, clamp(R * 0.45, 12, 50));
        this._ramp(0, 0, pick(st.leg, r()));
        this.lastType = 'traverse';
      }
    }
  }

  _planGrade() {
    const st = this.styleAt(this.gPlanS);
    const r = this.rngG;
    let target = st.gradeBias + (r() * 2 - 1) * st.gradeMax;
    // Stay inside the biome's altitude band — the coast road mustn't dive into the sea.
    if (this.planY < st.yRange[0]) target = Math.abs(target) * 0.5 + 0.03;
    if (this.planY > st.yRange[1]) target = -Math.abs(target) * 0.5 - 0.03;
    target = clamp(target, -0.1, 0.1);

    const nb = Math.max(1, Math.round(pick(st.gradeBlend, r()) / DS));
    const nh = Math.max(1, Math.round(pick(st.gradeLen, r()) / DS));
    const g0 = this.gradeNow;
    for (let j = 0; j < nb; j++) {
      const g = g0 + (target - g0) * smooth((j + 0.5) / nb);
      this.gq.push(g);
      this.planY += g * DS;
    }
    for (let j = 0; j < nh; j++) { this.gq.push(target); this.planY += target * DS; }
    this.gradeNow = target;
    this.gPlanS += (nb + nh) * DS;
  }

  // ---------- queries ----------

  // Project (x, z) onto the segment(s) beside sample i and describe the road there.
  // Writes into `out` (no allocation — terrain generation calls this thousands of
  // times per tile).
  project(x, z, i, out) {
    const n = this.n;
    let bestD2 = Infinity, bj = 0, bt = 0;
    const j0 = Math.max(0, i - 1), j1 = Math.min(n - 2, i);
    for (let j = j0; j <= j1; j++) {
      const ax = this.x[j], az = this.z[j];
      const dx = this.x[j + 1] - ax, dz = this.z[j + 1] - az;
      let t = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x, pz = az + dz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < bestD2) { bestD2 = d2; bj = j; bt = t; }
    }
    return this._fill(bj, bt, x, z, Math.sqrt(bestD2), out);
  }

  _fill(j, t, x, z, dist, out) {
    const k = j + 1 < this.n ? j + 1 : j;
    const L = (a) => a[j] + (a[k] - a[j]) * t;
    const psi = L(this.psi);
    const cx = L(this.x), cz = L(this.z);
    out.i = j; out.t = t; out.s = (j + t) * DS;
    out.x = cx; out.z = cz;
    out.y = L(this.y); out.psi = psi;
    out.kappa = L(this.kappa); out.grade = L(this.grade); out.bank = L(this.bank);
    out.hw = L(this.hw); out.sh = L(this.sh);
    out.d = (x - cx) * -Math.sin(psi) + (z - cz) * Math.cos(psi);
    out.dist = dist;
    return out;
  }

  // Follow a moving point along the road from a hint index (the previous result).
  // Cheap and stable for anything that moves continuously — bikes, cars, cameras.
  track(x, z, hint, out) {
    const n = this.n;
    let i = hint < 0 ? 0 : hint >= n ? n - 1 : hint | 0;
    const d2 = j => (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2;
    let best = d2(i);
    for (let guard = 0; guard < 400 && i + 1 < n; guard++) {
      const nb = d2(i + 1);
      if (nb >= best) break;
      best = nb; i++;
    }
    for (let guard = 0; guard < 400 && i > 0; guard++) {
      const nb = d2(i - 1);
      if (nb >= best) break;
      best = nb; i--;
    }
    return this.project(x, z, i, out);
  }

  // Road description at distance s along the centreline.
  at(s, out) {
    const f = Math.max(0, Math.min(this.n - 1.000001, s / DS));
    const j = Math.floor(f);
    return this._fill(j, f - j, NaN, NaN, 0, out);
  }

  // Road surface height at lateral offset d from a projection result.
  static surfaceY(q, d) { return q.y - d * Math.tan(q.bank); }

  // Indices (every `step`-th sample) whose blocks overlap a box. For terrain tiles.
  collect(minX, maxX, minZ, maxZ, step, out) {
    out.length = 0;
    for (let b = 0; b < this.blocks.length; b++) {
      const box = this.blocks[b];
      if (box[1] < minX || box[0] > maxX || box[3] < minZ || box[2] > maxZ) continue;
      const end = Math.min(this.n, (b + 1) * BLOCK);
      for (let i = b * BLOCK; i < end; i += step) out.push(i);
    }
    return out;
  }
}
