// Ragdoll — the rider after a crash, thrown clear of the bike.
//
// Fifteen point masses (head, chest, pelvis, shoulders, elbows, hands, hips, knees,
// feet) joined by fixed-length links: Verlet integration with the links solved as
// position constraints, the classic lightweight game ragdoll. The torso is braced
// into a near-rigid box; a few "keep apart" links stop the body folding through
// itself. Gravity, ground contact with sliding friction (leathers on asphalt), a
// little bounce, and walls all act on every point.
//
// How the rider leaves the bike depends on the crash: a lowside drops them to the
// inside of the turn to slide; a highside flings them up and over the outside; an
// impact pitches them forward over the bars while the legs catch on the tank.
//
// Pure (no three.js), so Node can test it. The world comes in through one callback.

export const JOINTS = ['head', 'chest', 'hip', 'shL', 'shR', 'elbL', 'elbR', 'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR'];
const N = JOINTS.length;
const I = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
const MASS = [5, 20, 14, 3, 3, 2, 2, 1, 1, 6, 6, 5, 5, 2, 2];          // kg, ~77 in all
const RADIUS = [0.15, 0.15, 0.13, 0.07, 0.07, 0.05, 0.05, 0.05, 0.05, 0.08, 0.08, 0.07, 0.07, 0.07, 0.07];
const UPPER = new Set(['head', 'chest', 'shL', 'shR', 'elbL', 'elbR', 'handL', 'handR']);
const G = 9.81;
const MU = 0.75;          // sliding leathers, plus the tumbling a real slide involves
const BOUNCE = 0.25;
const ITER = 10;

const pairs = list => list.flatMap((a, i) => list.slice(i + 1).map(b => [a, b]));
const LINKS = [
  ['chest', 'head'], ['head', 'shL'], ['head', 'shR'],
  ...pairs(['chest', 'shL', 'shR', 'hip', 'hipL', 'hipR']),       // the torso box
  ['shL', 'elbL'], ['elbL', 'handL'], ['shR', 'elbR'], ['elbR', 'handR'],
  ['hipL', 'kneeL'], ['kneeL', 'footL'], ['hipR', 'kneeR'], ['kneeR', 'footR'],
];
// At least this far apart (metres): no folding in half, no limbs through the body.
const SPREAD = [
  ['head', 'footL', 0.9], ['head', 'footR', 0.9], ['head', 'hip', 0.45],
  ['handL', 'hipL', 0.22], ['handR', 'hipR', 0.22], ['footL', 'hipL', 0.4], ['footR', 'hipR', 0.4],
  ['handL', 'handR', 0.15], ['footL', 'footR', 0.12], ['kneeL', 'kneeR', 0.1],
];

export function crashKind(why = '') {
  const w = why.toLowerCase();
  if (w.includes('highside')) return 'highside';
  if (w.includes('hit ') || w.includes('endo')) return 'impact';
  if (w.includes('looped')) return 'flip';
  if (w.includes('landed too hard') || w.includes('off the edge')) return 'drop';
  return 'lowside';
}

// points: 15 × [x, y, z] in JOINTS order (relative to some origin, metres).
// vel: the bike's velocity [vx, vy, vz]. side: which way the bike was leaning (±1).
// fwd: the bike's heading as [fx, fz]. dt: the step size step() will be called with.
export function createRagdoll(points, vel, { kind = 'lowside', side = 1, fwd = [1, 0], dt = 1 / 120, rnd = Math.random } = {}) {
  const P = new Float64Array(N * 3), Q = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) P.set(points[i], i * 3);
  const W = MASS.map(m => 1 / m);
  const len = ([a, b]) => Math.hypot(P[I[a] * 3] - P[I[b] * 3], P[I[a] * 3 + 1] - P[I[b] * 3 + 1], P[I[a] * 3 + 2] - P[I[b] * 3 + 2]);
  const links = LINKS.map(l => [I[l[0]], I[l[1]], len(l)]);
  const spread = SPREAD.map(([a, b, d]) => [I[a], I[b], d]);

  // How the rider leaves the bike.
  const [fx, fz] = fwd, rx = -fz, rz = fx;                    // forward, and right
  for (let i = 0; i < N; i++) {
    const up = UPPER.has(JOINTS[i]);
    let k = 1, f = 0, u = 0, r = 0;                           // extra forward / up / right (m/s)
    switch (kind) {
      case 'highside': k = 0.85; u = up ? 6 : 4.5; r = -side * (up ? 4.7 : 2.2); break;
      case 'impact': k = 0.9; f = up ? 2.5 : -3; u = up ? 3.2 : 2; break;
      case 'flip': k = 0.8; f = up ? -2 : 0; u = up ? 2.5 : 1.5; break;
      case 'drop': k = 0.9; break;
      default: k = 0.92; u = -0.5; r = side * (up ? 2.4 : 1.2);  // lowside
    }
    const vx = vel[0] * k + fx * f + rx * r + (rnd() - 0.5) * 0.6;
    const vy = vel[1] * k + u + (rnd() - 0.5) * 0.4;
    const vz = vel[2] * k + fz * f + rz * r + (rnd() - 0.5) * 0.6;
    Q[i * 3] = P[i * 3] - vx * dt; Q[i * 3 + 1] = P[i * 3 + 1] - vy * dt; Q[i * 3 + 2] = P[i * 3 + 2] - vz * dt;
  }

  const ground = new Float64Array(N);
  const touching = new Uint8Array(N);
  let still = 0, t = 0;

  function solve(list, onlyIfShort) {
    for (const [a, b, L] of list) {
      const ka = a * 3, kb = b * 3;
      const dx = P[kb] - P[ka], dy = P[kb + 1] - P[ka + 1], dz = P[kb + 2] - P[ka + 2];
      const d = Math.hypot(dx, dy, dz) || 1e-9;
      if (onlyIfShort && d >= L) continue;
      const diff = (d - L) / d / (W[a] + W[b]);
      P[ka] += dx * diff * W[a]; P[ka + 1] += dy * diff * W[a]; P[ka + 2] += dz * diff * W[a];
      P[kb] -= dx * diff * W[b]; P[kb + 1] -= dy * diff * W[b]; P[kb + 2] -= dz * diff * W[b];
    }
  }

  // surface(i, P, k) → ground height under point i (whose position is P[k..k+2]);
  // it may also push the point back from a wall by moving P[k] and P[k+2].
  function step(h, surface) {
    t += h;
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      const vx = P[k] - Q[k], vy = P[k + 1] - Q[k + 1], vz = P[k + 2] - Q[k + 2];
      Q[k] = P[k]; Q[k + 1] = P[k + 1]; Q[k + 2] = P[k + 2];
      P[k] += vx * 0.999; P[k + 1] += vy * 0.999 - G * h * h; P[k + 2] += vz * 0.999;
      // Walls: slide along them (the previous position moves too, so no bounce back).
      const x0 = P[k], z0 = P[k + 2];
      ground[i] = surface(i, P, k);
      Q[k] += P[k] - x0; Q[k + 2] += P[k + 2] - z0;
    }
    touching.fill(0);
    for (let it = 0; it < ITER; it++) {
      solve(links, false);
      solve(spread, true);
      for (let i = 0; i < N; i++) {
        const k = i * 3, floor = ground[i] + RADIUS[i];
        if (P[k + 1] < floor) { P[k + 1] = floor; touching[i] = 1; }
      }
    }
    // Friction and bounce for whatever touched the ground this step.
    let vmax = 0;
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      if (touching[i]) {
        const vx = (P[k] - Q[k]) / h, vz = (P[k + 2] - Q[k + 2]) / h, vy = (P[k + 1] - Q[k + 1]) / h;
        const vh = Math.hypot(vx, vz);
        const s = vh > 1e-6 ? Math.max(0, vh - MU * G * h) / vh : 0;
        Q[k] = P[k] - vx * s * h;
        Q[k + 2] = P[k + 2] - vz * s * h;
        if (vy < 0) Q[k + 1] = P[k + 1] + vy * BOUNCE * h;
      }
      vmax = Math.max(vmax, Math.hypot(P[k] - Q[k], P[k + 1] - Q[k + 1], P[k + 2] - Q[k + 2]) / h);
    }
    still = vmax < 0.4 ? still + h : 0;
  }

  return {
    P, step,
    get settled() { return still > 0.5; },
    get time() { return t; },
    // The pelvis: what the camera follows.
    center(out) { const k = I.hip * 3; out.x = P[k]; out.y = P[k + 1]; out.z = P[k + 2]; return out; },
    linkError() {                                              // worst stretch, as a fraction
      let worst = 0;
      for (const [a, b, L] of links) {
        const d = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
        worst = Math.max(worst, Math.abs(d - L) / L);
      }
      return worst;
    },
  };
}
