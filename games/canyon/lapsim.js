// Lap-time simulation — the quasi-steady-state (QSS) method race engineers use.
//
// 1. Every point of the road gets a corner speed limit: the fastest you can go at
//    that curvature on the grip available (v = √(μ·g / κ)).
// 2. Forward pass: from each point, you can only be as fast as the bike can
//    accelerate from the previous one (engine, drag, wheelie limit, grip left over).
// 3. Backward pass: you can only be as fast as you can still brake down from in time
//    for what's ahead.
// The minimum of the three is the ideal speed trace; integrate it for the ideal time.
// Medal times are fixed multiples of that ideal, and the autopilot rides a fraction
// of the same trace — so every stage, even a freshly generated one, is self-calibrating.
//
// Pure (no three.js). Shares its constants with physics.js so the two agree.

import { DS } from './road.js';
import { MASS, G, CDA_TUCK, A_WHEELIE, A_STOPPIE, rpmPerMs } from './physics.js';
import { TUNED, torqueAt } from './spec.js';

const LANE = 1.75;                           // ride the right-hand lane, like real traffic
const MU_LAT = 0.93 * TUNED.mu;              // what lean assist allows
const V_MAX = 240 / 3.6;
const RHO = TUNED.airDensity;

// Best-gear tyre acceleration available at speed v (clutch slip below ~4,000 rpm).
export function driveAccel(v) {
  let best = 0;
  for (let g = 0; g < 6; g++) {
    const rpm = v * rpmPerMs(g);
    if (rpm > TUNED.limiterRpm - 300) continue;
    const F = torqueAt(Math.max(rpm, 4000)) * TUNED.ratios[g] * TUNED.drivelineEff / TUNED.wheelRadiusM;
    best = Math.max(best, F / MASS);
  }
  return Math.min(best, A_WHEELIE + 0.2);    // wheelie control caps it
}

// Curvature of the right-lane path (tighter on right-handers, wider on lefts).
const laneKappa = k => k / (1 - LANE * k);

// Ideal speed at every sample between samples i0 and i1 (inclusive). `gripAt(s)`
// (optional) scales the grip — Endless rain; stages are always dry.
export function speedProfile(road, i0, i1, out, gripAt = null) {
  const n = i1 - i0 + 1;
  const v = out && out.length >= n ? out : new Float32Array(n);
  const mu = gripAt ? new Float32Array(n) : null;
  if (mu) for (let j = 0; j < n; j++) mu[j] = MU_LAT * gripAt((i0 + j) * DS);
  const MU = j => (mu ? mu[Math.min(n - 1, Math.max(0, j))] : MU_LAT);
  for (let j = 0; j < n; j++) {
    // Use the tightest curvature within ±16 m. Changing lean isn't instant (~0.8 s
    // to swing from 45° one way to 45° the other at speed), so a bike can't be at a
    // corner's full speed right up to where the corner starts.
    let k = 0;
    for (let d = -8; d <= 8; d++) {
      const i = Math.min(road.n - 1, Math.max(0, i0 + j + d));
      k = Math.max(k, Math.abs(laneKappa(road.kappa[i])));
    }
    v[j] = k > 1e-6 ? Math.min(V_MAX, Math.sqrt(MU(j) * G / k)) : V_MAX;
  }
  // forward: acceleration limit
  for (let j = 0; j < n - 1; j++) {
    const i = i0 + j, vv = v[j];
    const lat = vv * vv * Math.abs(laneKappa(road.kappa[i]));
    const grip = Math.sqrt(Math.max(0, (MU(j) * G) ** 2 - lat * lat));
    const drag = 0.5 * RHO * CDA_TUCK * vv * vv / MASS + TUNED.rollingCoeff * G + G * road.grade[i];
    const a = Math.max(0.2, Math.min(driveAccel(vv), grip) - drag);
    v[j + 1] = Math.min(v[j + 1], Math.sqrt(vv * vv + 2 * a * DS));
  }
  // backward: braking limit
  for (let j = n - 1; j > 0; j--) {
    const i = i0 + j, vv = v[j];
    const lat = vv * vv * Math.abs(laneKappa(road.kappa[i]));
    const grip = Math.sqrt(Math.max(0, (MU(j) * G) ** 2 - lat * lat));
    const drag = 0.5 * RHO * CDA_TUCK * vv * vv / MASS + TUNED.rollingCoeff * G + G * road.grade[i];
    const b =Math.max(1, Math.min(A_STOPPIE * 0.95, grip) + drag);
    v[j - 1] = Math.min(v[j - 1], Math.sqrt(vv * vv + 2 * b * DS));
  }
  return v;
}

// Ideal time over [s0, s1], starting from rest at s0.
export function idealTime(road, s0, s1) {
  const i0 = Math.floor(s0 / DS), i1 = Math.min(road.n - 1, Math.ceil(s1 / DS));
  const v = speedProfile(road, i0, i1);
  v[0] = 0;
  // re-run the forward pass from a standing start
  for (let j = 0; j < v.length - 1; j++) {
    const vv = v[j];
    const a = Math.max(0.2, driveAccel(vv) - 0.5 * RHO * CDA_TUCK * vv * vv / MASS);
    v[j + 1] = Math.min(v[j + 1], Math.sqrt(vv * vv + 2 * a * DS));
  }
  let t = 0;
  for (let j = 0; j < v.length - 1; j++) t += 2 * DS / Math.max(0.5, v[j] + v[j + 1]);
  return t;
}

// Medal targets, as multiples of the ideal. Calibrated against the autopilot and
// against human riding with keyboard + full rider aids.
export const MEDALS = [['gold', 1.12], ['silver', 1.24], ['bronze', 1.40]];
export function medalTimes(road, s0, s1) {
  const t = idealTime(road, s0, s1);
  return { ideal: t, gold: t * MEDALS[0][1], silver: t * MEDALS[1][1], bronze: t * MEDALS[2][1] };
}
