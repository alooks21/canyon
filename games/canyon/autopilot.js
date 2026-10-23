// Autopilot — a rider made of two controllers, driving the real physics.
//
// Steering is PURE PURSUIT: pick a point on the lane ahead (further when faster),
// find the arc that reaches it, and lean for that arc (tanφ = v²κ/g), plus a little
// lead to make up for the lean lag. Speed follows a fraction of the lap-time
// simulation's ideal trace, looked up slightly ahead so braking starts in time.
//
// It rides the Demo lap, and in Node it proves every stage can be finished.

import { DS } from './road.js';
import { G } from './physics.js';
import { speedProfile } from './lapsim.js';
import { TUNED } from './spec.js';

const LEAN_REF = Math.atan(0.93 * TUNED.mu);       // the lean a full input asks for (lean assist)
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function makeAutopilot(course, { lane = 1.75, pace = 0.9 } = {}) {
  const road = course.road;
  const q = {};
  // Speed trace, computed in overlapping windows so Endless works too. The last
  // ~200 m of a window can't see the corners beyond it, so we re-plan while still
  // KEEP samples (500 m) short of the end and never use that stretch.
  const WIN = 900, KEEP = 250;
  let w0 = -1, w1 = -1, trace = null;
  function target(s) {
    const i = Math.floor(s / DS);
    if (i < w0 || i > w1 - KEEP) {
      course.ensure(s + WIN * DS);
      w0 = Math.max(0, i - 5);
      w1 = Math.min(road.n - 1, w0 + WIN);
      trace = speedProfile(road, w0, w1, null, course.gripAt);
    }
    return trace[clamp(i - w0, 0, trace.length - 1)];
  }

  const out = { throttle: 0, brake: 0, lean: 0, tuck: false, shiftUp: false, shiftDown: false };
  // `laneNow` (optional) overrides the lane for this step — e.g. to pass a slow car.
  return function drive(b, laneNow = lane) {
    // --- steering: pure pursuit on the lane centre ---
    // Look ~1 s ahead. Shorter makes the loop too stiff for a bike whose lean lags
    // the rider by a few tenths of a second, and it starts to oscillate in long bends.
    const Lp = clamp(b.v * 0.95, 8, 55);
    road.at(b.s + Lp, q);
    const tx = q.x - Math.sin(q.psi) * laneNow, tz = q.z + Math.cos(q.psi) * laneNow;
    const alpha = wrap(Math.atan2(tz - b.z, tx - b.x) - b.psi);
    const dist = Math.max(4, Math.hypot(tx - b.x, tz - b.z));
    const kappa = 2 * Math.sin(alpha) / dist;
    const want = Math.atan(b.v * b.v * kappa / G);
    out.lean = clamp((want + 0.15 * (want - b.phi)) / LEAN_REF, -1, 1);

    // --- speed: a fraction of the ideal trace, looked up ahead; scrub speed when
    // off the line, which tightens the arc (same lean, lower speed → smaller radius) ---
    const off = Math.abs(b.d - laneNow);
    const vT = pace * Math.min(target(b.s + b.v * 0.25), target(b.s + b.v * 0.6)) * (1 - clamp((off - 0.5) * 0.3, 0, 0.35));
    const err = vT - b.v;
    out.throttle = clamp(err * 0.45 + 0.05, 0, 1);
    // Trail-brake gently when leaned — grabbing the brake mid-corner stands a bike up.
    out.brake = clamp(-err * 0.35 - 0.05, 0, Math.max(0.2, 1 - Math.abs(b.phi) / LEAN_REF));
    out.tuck = b.v > 30 && Math.abs(b.phi) < 0.2;
    return out;
  };
}
