// Physics — a lean-based motorcycle model, stepped at a fixed 120 Hz.
//
// Pure (no three.js, no DOM): the browser, the autopilot and the Node tests all run
// exactly this code. The model in one paragraph:
//
//   A bike turns by LEANING. In a steady turn, gravity and the cornering force
//   balance when tan(lean) = lateral acceleration / g, so the turn rate is
//   ψ̇ = g·tan(φ)/v. The rider commands a lean; the bike follows with second-order
//   dynamics that get lazier with speed (gyroscopic stiffness). The tyres can make
//   at most μ·g of total acceleration — the FRICTION CIRCLE — so braking or throttle
//   mid-corner eats into the grip available for leaning. Exceed it and you crash.
//   Longitudinal: engine torque through the gearbox, minus aero drag (calibrated to
//   Aprilia's 240 km/h), rolling resistance and gravity on slopes. Wheelies and
//   stoppies come from load transfer: the front lifts once acceleration exceeds
//   g·(CoG-to-rear-axle)/(CoG height). ATC, AWC and ABS are controllers that keep
//   those limits from being crossed — switch them off and you can cross them.

import { FACTORY, TUNED, torqueAt } from './spec.js';
import { Road } from './road.js';
import { crashKind } from './ragdoll.js';

export const STEP = 1 / 120;
export const G = 9.81;
const DEG = Math.PI / 180;

export const MASS = FACTORY.wetKg + TUNED.riderKg;          // 258 kg
const L = TUNED.wheelbaseM, LR = TUNED.cogFromRearM, LF = L - LR, H = TUNED.cogHeightM;
const RW = TUNED.wheelRadiusM;
const RATIOS = TUNED.ratios;
const ETA = TUNED.drivelineEff;
const RHO = TUNED.airDensity;
const IDLE = TUNED.idleRpm, LIMIT = TUNED.limiterRpm;
export const A_WHEELIE = G * LR / H;                          // ≈ 9.5 m/s² — front lifts
export const A_STOPPIE = G * LF / H;                          // ≈ 10.9 m/s² — rear lifts
const I_PITCH = MASS * (LR * LR + H * H) + MASS * 0.15;       // about a contact patch
export const LEAN_MAX = 56 * DEG;                             // hard parts touch down past this

// Assisted wheelie (hold Shift / pad B): an arcade feature, not physics. While it's
// on it owns the pitch — a critically damped follower to a fixed angle, whatever the
// throttle — so it can't loop out. Rise/fall times are to ~95% of the way there.
export const WHEELIE_ASSIST_DEG = 20;                         // held pitch, degrees
export const WHEELIE_RISE_S = 0.6;                            // up, seconds
export const WHEELIE_FALL_S = 0.5;                            // back down on release, seconds
export const WHEELIE_MIN_KMH = 15;                            // below this it sets down
export const WHEELIE_DROP_LEAN_DEG = 20;                      // leaned past this, it sets down
export const WHEELIE_DROP_BRAKE = 0.1;                        // braking past this, it sets down
const W_RISE = 4.74 / WHEELIE_RISE_S, W_FALL = 4.74 / WHEELIE_FALL_S;   // ωn: 95% at ωt ≈ 4.74
const W_MAX = 46 * DEG;                                       // hard ceiling, under the 48° loop

export const rpmPerMs = g => RATIOS[g] / RW * 60 / (2 * Math.PI);

// Drag area, solved so that tucked flat-out in 6th the bike tops out at exactly
// Aprilia's 240 km/h: drive force = drag + rolling resistance at that speed.
export const CDA_TUCK = (() => {
  const v = FACTORY.topSpeedKmh / 3.6;
  const F = torqueAt(v * rpmPerMs(5)) * RATIOS[5] * ETA / RW;
  return (F - TUNED.rollingCoeff * MASS * G) / (0.5 * RHO * v * v);
})();
export const CDA_UP = CDA_TUCK * 1.24;                        // sitting up: ~24% more drag

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

export const AIDS = {
  full:  { atc: true,  awc: true,  abs: true,  leanAssist: true },
  sport: { atc: true,  awc: true,  abs: true,  leanAssist: false },
  off:   { atc: false, awc: false, abs: false, leanAssist: false },
};

export function createBike() {
  return {
    x: 0, y: 0, z: 0, psi: 0, v: 0, vy: 0,
    phi: 0, phiDot: 0, phiCmd: 0,
    pitch: 0, pitchDot: 0, grade: 0, wAssist: false,
    psiDot: 0, ax: 0, ay: 0, steer: 0,
    rpm: IDLE, gear: 0, thr: 0, cut: 0, shiftCool: 0, limiterT: 0,
    airborne: false, airT: 0,
    hint: 0, s: 0, d: 0, roadPsi: 0, edge: 5, hw: 3.6, onRoad: true, surface: 'asphalt',
    usage: 0, slideT: 0, scrape: 0, skid: 0, wheelspin: 0,
    crashed: false, crashWhy: '', crashT: 0,
    aidATC: 0, aidAWC: 0, aidABS: 0,
    q: {},
  };
}

// Put the bike at rest on the road, at distance s and lateral offset d.
export function placeBike(b, road, s, d = 1.75, v = 0) {
  const q = road.at(s, b.q);
  b.x = q.x - Math.sin(q.psi) * d;
  b.z = q.z + Math.cos(q.psi) * d;
  b.y = Road.surfaceY(q, d);
  b.psi = q.psi; b.v = v; b.vy = 0;
  b.phi = 0; b.phiDot = 0; b.phiCmd = 0; b.pitch = 0; b.pitchDot = 0; b.wAssist = false;
  b.psiDot = 0; b.ax = 0; b.ay = 0;
  b.gear = v > 0 ? bestGear(v) : 0;
  b.rpm = Math.max(IDLE, v * rpmPerMs(b.gear));
  b.thr = 0; b.cut = 0; b.airborne = false; b.airT = 0;
  b.hint = q.i; b.s = s; b.d = d;
  b.usage = 0; b.slideT = 0; b.crashed = false; b.crashWhy = ''; b.crashT = 0;
  b.scrape = 0; b.skid = 0; b.wheelspin = 0;
}

// The lowest gear that keeps the engine under ~8,800 rpm at this speed.
function bestGear(v) {
  for (let g = 0; g < 6; g++) if (v * rpmPerMs(g) < 8800) return g;
  return 5;
}

// The rider comes off (game.js hands them to ragdoll.js) and the bike goes its own
// way: a highside cartwheels it, an impact stops it dead and spins it, a lowside
// lays it down to slide.
export function crash(b, why) {
  b.crashed = true;
  b.crashWhy = why;
  b.crashT = 0;
  b.thr = 0;
  b.vCrash = b.v;                                  // the speed the rider leaves with
  b.crashKind = crashKind(why);
  b.rollT = 0; b.rollRate = 0;
  const turn = Math.sign(b.psiDot || b.phi || 1);
  if (b.crashKind === 'highside') { b.rollT = 0.75; b.rollRate = -Math.sign(b.phi || 1) * 7.5; b.vy = 3; }
  else if (b.crashKind === 'impact') { b.v *= 0.35; b.psiDot = turn * 2.5; b.vy = 1.5; }
}

// Ground under a point: the road surface on the paved width, a short ramp down the
// edge drop-off, then the terrain grid (the same triangles the renderer draws).
// `q` is the road projection of (x, z). (The ragdoll uses it too.)
export function groundAt(course, q, x, z) {
  const edge = q.hw + q.sh, ad = Math.abs(q.d);
  if (ad <= edge) return Road.surfaceY(q, q.d);
  const roadEdge = Road.surfaceY(q, Math.sign(q.d) * edge);
  const terr = course.groundAt(x, z);
  if (ad - edge < 1.2) return Math.max(terr, roadEdge - 0.45 * (ad - edge) / 1.2);
  return terr;
}

// One physics step. `inp`: { throttle 0..1, brake 0..1, lean −1..1, tuck, wheelie,
// shiftUp, shiftDown }. `opt`: { aids, auto } (auto = automatic gearbox).
export function stepBike(b, inp, course, opt, dt = STEP) {
  if (b.crashed) { stepCrash(b, course, dt); return; }
  const aids = opt.aids;
  const road = course.road;

  // ---------- where are we ----------
  const q = road.track(b.x, b.z, b.hint, b.q);
  b.hint = q.i; b.s = q.s; b.d = q.d; b.roadPsi = q.psi;
  b.hw = q.hw; b.edge = q.hw + q.sh;
  const ad = Math.abs(q.d);
  let mu = TUNED.mu * (course.gripAt ? course.gripAt(q.s) : 1), crr = TUNED.rollingCoeff;
  if (ad <= q.hw) {
    b.surface = 'asphalt';
    if (ad < 0.2 || ad > q.hw - 0.16) { mu *= 0.95; b.surface = 'paint'; }  // painted lines: a touch slippier
  } else if (ad <= b.edge) { b.surface = 'gravel'; mu = 0.62; crr = 0.05; }
  else { b.surface = 'dirt'; mu = 0.55; crr = 0.09; }
  b.onRoad = ad <= b.edge;

  // ---------- rider inputs through ride-by-wire ----------
  b.thr += clamp(inp.throttle - b.thr, -dt * 9, dt * 6);
  let thr = b.thr;
  if (b.cut > 0) { b.cut -= dt; thr = 0; }                     // quickshift ignition cut

  // ---------- gearbox ----------
  b.shiftCool -= dt;
  const coupled = b.v * rpmPerMs(b.gear);
  if (opt.auto) {
    if (b.shiftCool <= 0) {
      if (b.gear < 5 && (coupled > 11050 || (coupled > 10500 && thr > 0.5))) shift(b, +1);
      else if (b.gear > 0) {
        const down = b.v * rpmPerMs(b.gear - 1);
        if (down < 10200 && (coupled < 4800 || (coupled < 7000 && (inp.brake > 0.2 || thr < 0.15)))) shift(b, -1);
      }
    }
  } else {
    if (inp.shiftUp && b.gear < 5 && b.shiftCool <= 0) shift(b, +1);
    if (inp.shiftDown && b.gear > 0 && b.shiftCool <= 0 && b.v * rpmPerMs(b.gear - 1) < 11400) shift(b, -1);
  }

  // ---------- engine ----------
  // Below ~8 m/s the clutch slips, so the engine can rev above the road speed.
  const slip = clamp(1 - b.v / 8, 0, 1);
  const rpmTarget = Math.max(b.v * rpmPerMs(b.gear), IDLE + slip * thr * 5200);
  b.rpm += (rpmTarget - b.rpm) * Math.min(1, dt * 25);
  b.limiterT -= dt;
  if (b.rpm >= LIMIT) { b.rpm = LIMIT; b.limiterT = 0.045; }  // fuel cut, bounce off
  if (b.limiterT > 0) thr = 0;
  // Engine braking (AEB) when the throttle is closed; the slipper clutch caps it.
  const engine = thr * torqueAt(b.rpm) - (1 - thr) * Math.min(14, 4 + b.rpm * 0.0009);
  let Fdrive = engine * RATIOS[b.gear] * ETA / RW;
  if (b.v < 0.5 && Fdrive < 0) Fdrive = 0;

  // ---------- resistances ----------
  const cda = inp.tuck ? CDA_TUCK : CDA_UP;
  const Fdrag = 0.5 * RHO * cda * b.v * b.v;
  const Froll = b.v > 0.05 ? crr * MASS * G : 0;
  const Fgrade = MASS * G * Math.sin(Math.atan(b.grade));

  // ---------- grip budget: the friction circle ----------
  const ayNow = b.v * b.psiDot;
  const longCap = Math.sqrt(Math.max(0, (mu * G) ** 2 - ayNow * ayNow));   // m/s² left for drive/brake
  // What the electronics allow: the same 93% budget lean assist uses, so braking or
  // accelerating never steals the grip that's holding the current lean — which is
  // what real cornering ABS / traction control are designed to do.
  const aidCap = Math.sqrt(Math.max(0, (0.93 * mu * G) ** 2 - ayNow * ayNow));

  // Drive: traction control trims torque to the grip that's left (ATC).
  let aDrive = Fdrive / MASS;
  b.wheelspin = 0;
  if (aids.atc && aDrive > aidCap) { aDrive = aidCap; b.aidATC = 0.25; }
  else if (!aids.atc && aDrive > longCap) {
    b.wheelspin = (aDrive - longCap) / G; aDrive = longCap * 0.85; b.rpm = Math.min(LIMIT, b.rpm + 30);
  }
  // Wheelie control (AWC). Solve the pitch equation backwards for the drive force
  // that gives a well-damped approach to a 2° hover — feedback linearisation:
  //   θ̈_want = −k₁(θ − 2°) − k₂θ̇,   a = (I·θ̈_want/m + g(Lr·cosθ − h·sinθ)) / (Lr·sinθ + h·cosθ)
  // The assisted wheelie lifts while held, fast enough, upright and off the brakes,
  // and keeps the pitch until it has set the front back down; AWC stands aside.
  const wLift = !!inp.wheelie && b.v * 3.6 >= WHEELIE_MIN_KMH && inp.brake <= WHEELIE_DROP_BRAKE
    && Math.abs(b.phi) <= WHEELIE_DROP_LEAN_DEG * DEG;
  const wOwn = wLift || b.wAssist;
  if (aids.awc && !wOwn) {
    const th = Math.max(0, b.pitch);
    const want = -30 * (th - 2 * DEG) - 12 * b.pitchDot;
    const resist = (Fdrag + Froll) / MASS;
    const aMax = (I_PITCH * want / MASS + G * (LR * Math.cos(th) - H * Math.sin(th))) / (LR * Math.sin(th) + H * Math.cos(th)) + resist;
    if (aDrive > aMax) { aDrive = Math.max(0, aMax); b.aidAWC = 0.25; }
  }

  // Braking: combined front + rear. Only TYRE forces count against grip — engine
  // braking does, aero drag doesn't. Cornering ABS holds the total inside the grip
  // left at this lean, and the chassis deceleration below the stoppie limit
  // (Aprilia's rear-wheel lift-up mitigation).
  let aBrake = inp.brake * 1.18 * G;
  const engineBrake = Math.max(0, -aDrive);
  b.skid = 0;
  if (aBrake > 0) {
    const cap = Math.min(aidCap - engineBrake, A_STOPPIE * 0.97 - engineBrake - Fdrag / MASS);
    if (aids.abs) { if (aBrake > cap) { aBrake = Math.max(0, cap); b.aidABS = 0.25; } }
    else if (aBrake + engineBrake > longCap) {
      if (Math.abs(b.phi) > 9 * DEG && b.v > 6) { crash(b, 'Front tyre locked mid-corner'); return; }
      aBrake = 0.75 * mu * G - engineBrake;                     // locked: sliding friction
      b.skid = 1;
    }
  }
  if (b.v < 0.05) aBrake = Math.min(aBrake, 0);
  aDrive = b.airborne ? 0 : aDrive;
  aBrake = b.airborne ? 0 : aBrake;

  const aTyre = aDrive - aBrake;                                 // longitudinal tyre force / m
  const ax = aTyre - (Fdrag + Froll + Fgrade) / MASS;
  b.ax = ax;
  b.aTyre = aTyre;
  b.v = Math.max(0, b.v + ax * dt);
  if (b.v === 0 && inp.throttle < 0.05) b.thr = 0;

  // ---------- wheelie / stoppie (load transfer) ----------
  const aLong = ax + Fgrade / MASS;                              // what the chassis feels
  if (wOwn) {
    // θ̈ = ωn²(θt − θ) − 2ωn·θ̇: no overshoot. Setting down aims 1° below level, so it
    // touches down in ~WHEELIE_FALL_S at a few °/s rather than creeping in forever.
    b.wAssist = true;
    const w = wLift ? W_RISE : W_FALL, target = (wLift ? WHEELIE_ASSIST_DEG : -1) * DEG;
    b.pitchDot += (w * w * (target - b.pitch) - 2 * w * b.pitchDot) * dt;
    b.pitch += b.pitchDot * dt;
    if (b.pitch > W_MAX) { b.pitch = W_MAX; b.pitchDot = Math.min(0, b.pitchDot); }
    if (!wLift && b.pitch <= 0) { b.pitch = 0; b.pitchDot = 0; b.wAssist = false; }
  } else if (!b.airborne && (b.pitch > 0 || aLong > A_WHEELIE)) {
    const th = Math.max(0, b.pitch);
    const M = MASS * (aLong * (LR * Math.sin(th) + H * Math.cos(th)) - G * (LR * Math.cos(th) - H * Math.sin(th)));
    b.pitchDot += (M / I_PITCH - 1.2 * b.pitchDot) * dt;
    b.pitch += b.pitchDot * dt;
    if (b.pitch <= 0) { b.pitch = 0; b.pitchDot = 0; }
    if (b.pitch > 48 * DEG) { crash(b, 'Looped it — wheelie past the balance point'); return; }
  } else if (!b.airborne && (b.pitch < 0 || -aLong > A_STOPPIE)) {
    const th = Math.max(0, -b.pitch);
    const M = MASS * (-aLong * (LF * Math.sin(th) + H * Math.cos(th)) - G * (LF * Math.cos(th) - H * Math.sin(th)));
    b.pitchDot -= (M / I_PITCH + 1.2 * b.pitchDot) * dt;     // nose-down moment, damped
    b.pitch += b.pitchDot * dt;
    if (b.pitch >= 0) { b.pitch = 0; b.pitchDot = 0; }
    if (b.pitch < -24 * DEG) { crash(b, 'Endo — stoppie past the balance point'); return; }
  }

  // ---------- lean ----------
  // The rider asks for a lean; at walking pace the bike only lets you lean a little.
  let leanMax = LEAN_MAX;
  if (b.v < 6) leanMax = Math.min(leanMax, (8 + b.v * 5) * DEG);
  let latMax = Infinity;                                       // lateral budget (lean assist)
  if (aids.leanAssist) {
    // Never ask for more lean than the grip left over after braking (brakes + engine
    // braking). Drive doesn't count: lean wins and ATC trims power to the grip the
    // lean leaves, like cornering traction control. Counting drive too deadlocked
    // the two aids — upright on the throttle, ATC gave full drive and lean assist
    // then allowed no lean, so the bike stayed upright.
    const aDecel = Math.max(0, -aTyre);
    const lat = Math.sqrt(Math.max(0, (0.93 * mu * G) ** 2 - aDecel * aDecel));
    leanMax = Math.min(leanMax, Math.atan(lat / G));
    latMax = lat;
  }
  const frontUp = b.pitch > 2 * DEG ? 0.25 : 1;                // no steering on one wheel
  b.phiCmd = clamp(inp.lean, -1, 1) * leanMax * frontUp + b.phi * (1 - frontUp);
  const wn = b.v < 4 ? 6.5 : clamp(6.2 - 0.048 * b.v, 2.9, 6.2);
  b.phiDot += (wn * wn * (b.phiCmd - b.phi) - 2 * 0.86 * wn * b.phiDot) * dt;
  b.phi += b.phiDot * dt;
  b.phi = clamp(b.phi, -LEAN_MAX - 0.05, LEAN_MAX + 0.05);

  // ---------- yaw ----------
  // Leaning turns the bike (ψ̇ = g·tanφ/v); at walking pace it's the handlebars.
  const blend = clamp((b.v - 1.5) / 6, 0, 1);
  const psiLean = G * Math.tan(b.phi) / Math.max(b.v, 3);
  const psiBar = b.v * Math.tan(clamp(inp.lean, -1, 1) * 0.5) / L;
  b.psiDot = b.airborne ? 0 : blend * psiLean + (1 - blend) * psiBar;
  // The handlebar term ignores the lean cap, so below ~7.5 m/s full lock could ask
  // for more cornering than the tyres have. Lean assist holds v·ψ̇ to the same budget.
  if (b.v > 0) b.psiDot = clamp(b.psiDot, -latMax / b.v, latMax / b.v);
  b.psi += b.psiDot * dt;
  b.ay = b.v * b.psiDot;
  // Visual steering angle: the geometry of the turn, plus a countersteer flick.
  b.steer = clamp(Math.atan(L * b.psiDot / Math.max(b.v, 2)) - 0.035 * b.phiDot, -0.6, 0.6);

  // ---------- grip used: crash if the friction circle is overrun ----------
  b.usage = Math.sqrt(b.ay * b.ay + aTyre * aTyre) / (mu * G);
  if (!b.airborne && b.usage > 1.0) {
    b.slideT += dt;
    if (b.usage > 1.2 || b.slideT > 0.16) {
      crash(b, b.wheelspin > 0 ? 'Highside — rear let go under power' : 'Lowside — ran out of grip');
      return;
    }
  } else b.slideT = Math.max(0, b.slideT - dt * 2);
  if (Math.abs(b.phi) > LEAN_MAX) { crash(b, 'Leaned too far — hard parts touched down'); return; }

  // ---------- move ----------
  const cx = Math.cos(b.psi), cz = Math.sin(b.psi);
  b.x += cx * b.v * dt;
  b.z += cz * b.v * dt;

  // ---------- vertical: follow the ground, or fly ----------
  const q2 = road.track(b.x, b.z, b.hint, b.q);
  const ground = groundAt(course, q2, b.x, b.z);
  const ahead = groundAt(course, q2, b.x + cx * 0.8, b.z + cz * 0.8);
  const slopeAhead = (ahead - ground) / 0.8;
  if (!b.airborne) {
    const yPrev = b.y;
    if (ground < yPrev + b.vy * dt - 0.5 * G * dt * dt - 0.03 && b.v > 4) {
      b.airborne = true;                                      // the ground fell away
      b.airT = 0;
      b.y = yPrev + b.vy * dt - 0.5 * G * dt * dt;
      b.vy -= G * dt;
    } else {
      b.vy = (ground - yPrev) / dt;
      b.y = ground;
    }
    // Slope along the bike's actual direction (riding across the road ≠ up it).
    b.grade = b.onRoad ? q2.grade * Math.cos(wrap(b.psi - q2.psi)) : clamp(slopeAhead, -1.5, 1.5);
  } else {
    b.airT += dt;
    b.vy -= G * dt;
    b.y += b.vy * dt;
    if (b.y <= ground) {
      const impact = b.vy;
      b.y = ground; b.vy = 0; b.airborne = false;
      if (impact < -7.5) { crash(b, 'Landed too hard'); return; }
      if (Math.abs(b.phi) > 38 * DEG && impact < -3) { crash(b, 'Landed leaned over'); return; }
    }
    if (b.airT > 4) { crash(b, 'Off the edge'); return; }
  }

  // Riding into a bank or wall.
  if (!b.onRoad && !b.airborne && b.v > 5 && slopeAhead > 0.95) { crash(b, 'Hit the bank'); return; }

  // ---------- guardrails (and tunnel walls, town kerbs) ----------
  b.scrape = Math.max(0, b.scrape - dt * 4);
  const side = q2.d > 0 ? 1 : -1;
  const railD = q2.hw + q2.sh - 0.32;
  const barrier = Math.abs(q2.d) > railD
    ? (course.barrierAt ? course.barrierAt(q2.i, side) : (course.railAt(q2.i, side) ? 'rail' : null)) : null;
  if (barrier) {
    const rel = wrap(b.psi - q2.psi);
    const into = b.v * Math.sin(rel) * side;                  // m/s toward the rail
    if (into > 4.5) { crash(b, barrier === 'wall' ? 'Hit the tunnel wall' : barrier === 'kerb' ? 'Hit the kerb' : 'Hit the guardrail'); return; }
    // Glancing blow: scrape along it, pushed back inside, losing speed.
    const back = (Math.abs(q2.d) - railD) * side;
    b.x -= -Math.sin(q2.psi) * back;
    b.z -= Math.cos(q2.psi) * back;
    b.psi = q2.psi + rel * 0.4;
    b.v *= 0.985;
    b.scrape = 1;
  }

  // Aid lights decay.
  b.aidATC = Math.max(0, b.aidATC - dt);
  b.aidAWC = Math.max(0, b.aidAWC - dt);
  b.aidABS = Math.max(0, b.aidABS - dt);
}

function shift(b, dir) {
  b.gear += dir;
  b.shiftCool = 0.22;
  if (dir > 0) b.cut = 0.06;                                   // AQS: 60 ms torque cut, no clutch
  b.shifted = dir;                                             // read (and cleared) by audio/UI
}

// After a crash: the bike slides on its side and grinds to a halt.
function stepCrash(b, course, dt) {
  b.crashT += dt;
  const q = course.road.track(b.x, b.z, b.hint, b.q);
  b.hint = q.i;
  const decel = (Math.abs(q.d) <= q.hw + q.sh ? 0.55 : 0.9) * G;
  b.v = Math.max(0, b.v - decel * dt);
  b.x += Math.cos(b.psi) * b.v * dt;
  b.z += Math.sin(b.psi) * b.v * dt;
  b.psi += b.psiDot * 0.4 * dt;
  b.psiDot *= 1 - dt * 1.5;
  if (b.rollT > 0) {
    b.rollT -= dt;                                 // cartwheeling (highside)
    b.phi += b.rollRate * dt;
  } else {
    b.phi = wrap(b.phi);                           // then down on whichever side it lands
    const fall = Math.sign(b.phi || 1) * 80 * DEG;
    b.phi += (fall - b.phi) * Math.min(1, dt * 8);
  }
  b.pitch *= 1 - dt * 5;
  // Thrown up by a highside or an impact, then down with a thump.
  b.vy = (b.vy || 0) - G * dt;
  b.y += b.vy * dt;
  const ground = groundAt(course, q, b.x, b.z);
  if (b.y <= ground) { b.y = ground; b.vy = b.vy < -2 ? -b.vy * 0.3 : 0; }
  b.rpm += (TUNED.idleRpm - b.rpm) * Math.min(1, dt * 3);
}
