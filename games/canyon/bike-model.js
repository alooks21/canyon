// The bike: an Aprilia RS 660 Factory in "Dark Banshee", built entirely in code.
//
// Livery from Aprilia's own photo of the 2025 Factory: gloss black bodywork; a red
// front wing under the headlights; red arrow slashes on the nose; a red tank top;
// a silver band across the side fairing; big grey "RS" lettering with a red
// "FACTORY" script; black wheels; gold Öhlins fork tubes; smoked screen. (The photo's
// carbon silencer is an accessory — this is the stock underslung exhaust.)
//
// Proportions: 1370 mm wheelbase, 1995 mm long, 820 mm seat, 24.1° rake, 120/70 and
// 180/55 ZR17 tyres (Piaggio press release, 10 Oct 2020). The side profile is traced
// from Aprilia's own studio side view of the RS 660 Factory, scaled by that wheelbase
// (its silhouette then measures 1.985 m long against the official 1.995 m). Low-poly
// and stylised — recognisable, not photoreal.
//
// Model space: x forward, y up, z to the bike's RIGHT. Origin on the ground midway
// between the axles. Roll (+x rotation) leans right; pitch (+z) lifts the nose.

import * as THREE from '../../vendor/three.module.js';
import { TUNED } from './spec.js';
import { part, merge, M4, bar, rod, rbar } from './mesh-util.js';
import { JOINTS } from './ragdoll.js';

const DEG = Math.PI / 180;
export const WB = TUNED.wheelbaseM;
const RA = -WB / 2, FA = WB / 2;                // axle x positions
const RR = 0.315, FR = 0.30;                   // tyre radii (180/55-17, 120/70-17 assumed)
const HEAD = new THREE.Vector3(0.43, 0.86, 0); // steering head
const RAKE = Math.atan2(FA - HEAD.x, HEAD.y - FR);   // ≈ 24.5°
const FORK_LEN = Math.hypot(FA - HEAD.x, HEAD.y - FR);
const PIVOT = new THREE.Vector3(-0.17, 0.48, 0);     // swingarm pivot
const GHOST_GRID = 0.02;                             // ghost decimation grid (m), see cluster()
const SHADOW_LAYER = 1;                              // seen only by world.js's sun shadow camera, see cockpit()

const C = {
  black: 0x0e0f12, black2: 0x1a1b1f, red: 0xd0202a, silver: 0xa7abb2, grey: 0x3a3c42,
  gold: 0xd9a63a, steel: 0x9aa0a8, rubber: 0x141414, engine: 0x2a2c30, alu: 0x6f747c,
  seat: 0x16171a, leather: 0x121214, white: 0xe9e9e9, skin: 0x2a2a2a,
};

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

// Loft a body panel through cross-sections. Each section is { x, prof: [[y, zHalf]…] }
// listed bottom → top; the loop runs up the right side and back down the left, so
// the shape is symmetric about z = 0. Vertex colours come from colorFn(x, y, z).
// The traced points are control points: a Catmull-Rom spline runs through them, round
// each section and from section to section, with k − 1 points added per span.
function loft(sections, colorFn, k = 3) {
  let loops = sections.map(s => {
    const right = s.prof.map(([y, z]) => [s.x, y, z]);
    const top = s.prof[s.prof.length - 1][1] === 0;        // (a centreline top point isn't repeated)
    const left = (top ? s.prof.slice(0, -1) : s.prof.slice()).reverse().map(([y, z]) => [s.x, y, -z]);
    return spline(right.concat(left), k);
  });
  const cols = loops[0].map((_, j) => spline(loops.map(l => l[j]), k));
  loops = cols[0].map((_, s) => cols.map(c => c[s]));
  const n = loops[0].length;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const push = p => { pos.push(p[0], p[1], p[2]); c.setHex(colorFn(p[0], p[1], p[2])); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  const base = loops.map(loop => loop.map(push)[0]);
  for (let s = 0; s < loops.length - 1; s++) {
    for (let j = 0; j < n; j++) {
      const a0 = base[s] + j, a1 = base[s] + (j + 1) % n;
      const b0 = base[s + 1] + j, b1 = base[s + 1] + (j + 1) % n;
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
  // end caps (front faces +x, back faces −x)
  for (const [s, front] of [[0, true], [loops.length - 1, false]]) {
    const loop = loops[s];
    const cen = loop.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]);
    const ci = push(cen);
    for (let j = 0; j < n; j++) {
      const a = base[s] + j, b = base[s] + (j + 1) % n;
      if (front) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Centripetal Catmull-Rom through points [x, y, z]: k − 1 added per span, the points kept.
function spline(pts, k, closed = false) {
  const c = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), closed, 'centripetal');
  const out = c.getPoints(k * (closed ? pts.length : pts.length - 1)).map(v => [v.x, v.y, v.z]);
  if (closed) out.pop();
  return out;
}

// A lathed ring about the z axis (the wheel axis) through profile points [r, z].
function lathe(prof, seg) {
  return new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), seg).rotateX(Math.PI / 2);
}

// A flat wing: a planform (x, z) extruded t thick (y) with rounded edges.
function wing(outline, t, color, matrix) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z))),
    { depth: t - 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1 });
  g.translate(0, 0, -(t - 0.006) / 2).rotateX(Math.PI / 2);
  return part(g, color, matrix);
}

// A flat plate: an outline (x, y), optional round holes [x, y, r], t thick, outer face at z.
function plate(outline, holes, t, z, color) {
  const s = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const [x, y, r] of holes) s.holes.push(new THREE.Path().absarc(x, y, r, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, z - (z > 0 ? t : 0));
  return part(g, color);
}

// A sprocket in the wheel plane: n teeth to radius r, five lightening holes, z thick.
function sprocket(r, n, t, color, z) {
  const s = new THREE.Shape(), root = r - 0.008;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, d = Math.PI * 2 / n;
    for (const [f, rr] of [[0, root], [0.3, r], [0.6, r], [0.9, root]]) {
      const p = [Math.cos(a + f * d) * rr, Math.sin(a + f * d) * rr];
      if (i || f) s.lineTo(...p); else s.moveTo(...p);
    }
  }
  if (r > 0.06) for (let k = 0; k < 5; k++) s.holes.push(new THREE.Path().absarc(Math.cos(k * 1.2566) * r * 0.55, Math.sin(k * 1.2566) * r * 0.55, r * 0.2, 0, Math.PI * 2, true));
  s.holes.push(new THREE.Path().absarc(0, 0, r * 0.2, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 5 });
  g.translate(0, 0, z - t / 2);
  return part(g, color);
}

// Below KNEE the side fairing curves in toward the belly pan (Piaggio's front view: 0.20 m
// either side of centre at 0.6 m up, 0.11 m at 0.3 m). A smooth hinge: straight above,
// then TAPER m inward per metre down. Bent into the side panels and the decals on them.
const KNEE = 0.62, HINGE = 0.06, TAPER = 0.33;
function taperIn(y) {
  const d = KNEE + HINGE - y;
  return d <= 0 ? 0 : d < 2 * HINGE ? TAPER * d * d / (4 * HINGE) : TAPER * (KNEE - y);
}
function bend(g, side) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - side * taperIn(p.getY(i)));
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Side panel: a 2D outline (x, y) extruded `t` thick, outer face at z = zOut (flat, or bent
// in below the knee with `bendIn`). The traced outline is the control polygon of a smooth
// closed spline.
function panel(outline, zOut, t, color, side, bendIn = false) {
  const shape = new THREE.Shape(spline(outline.map(([x, y]) => [x, y, 0]), 3, true).map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 4 });
  // The bevel adds bevelThickness beyond each cap, so the true outer surface is at
  // z = t + 0.012. Put THAT at z = 0 — the decals sit just outside it.
  g.translate(0, 0, -t - 0.012);
  if (side < 0) g.scale(1, 1, -1);              // … mirrored for the left
  g.translate(0, 0, zOut * side);
  if (bendIn) bend(g, side);
  return part(g, color);
}

// ---------------------------------------------------------------------------
// the side graphics (canvas decal): silver band, "RS", "FACTORY", red slashes
// ---------------------------------------------------------------------------
const DECAL_X = [0.04, 0.74], DECAL_Y = [0.26, 0.84];
// `mirror` draws the left-side version: shapes mirrored front-to-back like a real
// bike's graphics, but the lettering still reads left-to-right and leans forward.
function makeDecalTexture(mirror) {
  const W = 1024, H = Math.round(W * (DECAL_Y[1] - DECAL_Y[0]) / (DECAL_X[1] - DECAL_X[0]));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const X = x => { const u = (x - DECAL_X[0]) / (DECAL_X[1] - DECAL_X[0]) * W; return mirror ? W - u : u; };
  const Y = y => (1 - (y - DECAL_Y[0]) / (DECAL_Y[1] - DECAL_Y[0])) * H;
  // (The silver diagonal across the flank is the aluminium frame spar, which shows
  // between the tank and the fairing — it's modelled, not painted.)
  // Red arrow slashes on the upper front of the panel (hot-air flow motif).
  g.fillStyle = '#d0202a';
  for (const [x0, w] of [[0.56, 0.06], [0.48, 0.05]]) {
    g.beginPath();
    g.moveTo(X(x0), Y(0.66)); g.lineTo(X(x0 + w), Y(0.66)); g.lineTo(X(x0 + w - 0.05), Y(0.58)); g.lineTo(X(x0 - 0.05), Y(0.58));
    g.closePath(); g.fill();
  }
  // big "RS" in dark grey, italic, and "FACTORY" in red underneath
  g.save();
  g.translate(X(0.32), Y(0.55));
  g.transform(1, 0, mirror ? 0.32 : -0.32, 1, 0, 0);   // lean toward the front
  g.fillStyle = '#3d4047';
  g.font = `900 ${Math.round(H * 0.3)}px Arial Black, Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('RS', 0, 0);
  g.fillStyle = '#d0202a';
  g.font = `900 ${Math.round(H * 0.105)}px Arial, sans-serif`;
  g.fillText('FACTORY', mirror ? -10 : 10, H * 0.2);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// A tread hint for the tyres (u round the wheel, v across the profile): staggered
// diagonal grooves either side of the crown. A pattern, not a real tyre's.
function makeTreadTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 512, 64);
  g.strokeStyle = '#555'; g.lineWidth = 3;
  for (let i = 0; i < 14; i++) {
    const x = i * 512 / 14;
    g.beginPath(); g.moveTo(x, 20); g.lineTo(x + 20, 29); g.stroke();
    g.beginPath(); g.moveTo(x + 18, 44); g.lineTo(x + 38, 35); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tyre section [r, z], bead to bead: a round crown of radius 0.075 m (the same 75 mm the
// lean code rides up on, see update()), then the shoulder and the sidewall down to a 17-inch
// rim (ZR17: 431.8 mm bead diameter). Shoulder and bead widths are stylised.
const RIM = 0.2159;
function tyreProfile(R, hw, thc) {
  const rho = 0.075, h = R - RIM, half = [];
  for (let i = 0; i <= 3; i++) { const a = thc * i / 3; half.push([R - rho + rho * Math.cos(a), rho * Math.sin(a)]); }
  half.push([RIM + 0.5 * h, hw], [RIM + 0.17 * h, hw * 0.96], [RIM + 0.004, hw * 0.76]);
  const full = [...half.slice(1).reverse().map(([r, z]) => [r, -z]), ...half];
  return spline(full.map(([r, z]) => [r, z, 0]), 2).map(([r, z]) => [r, z]);
}

// ---------------------------------------------------------------------------
// the painted bodywork and the screen (also read by tools/blender/export-body.mjs)
// ---------------------------------------------------------------------------
// The bodywork as named parts in model space, each with its livery vertex colours.
// createBikeModel() merges them into one mesh; tools/blender/ renders the same parts.
const BODY_NAMES = ['nose', 'tank', 'tail', 'belly', 'sideR', 'sideL', 'underSeatR', 'underSeatL',
  'wingletR', 'wingletSmallR', 'wingletL', 'wingletSmallL', 'frontWing', 'seat'];
export function bodyworkParts() {
  const livery = (x, y, z) => {
    // Mostly gloss black. Red: a slash on each nose flank above the headlights, the
    // top of the tank, and a flash along the tail sides (as in Aprilia's photo).
    const az = Math.abs(z);
    if (x > 0.6 && x < 0.8 && y > 0.86 && y < 0.95 && az > 0.13) return C.red;
    if (x > -0.1 && x < 0.24 && y > 1.03 && az < 0.12) return C.red;
    if (x < -0.6 && x > -0.82 && y > 0.93 && y < 0.97 && az > 0.06) return C.red;
    return C.black;
  };
  const bodyParts = [];
  // Upper fairing / nose. The beak ends above the front axle (x 0.82), not ahead
  // of the wheel; the top edge climbs to the screen base at ~1.0 m.
  // Widths: Piaggio's studio front view of the Factory (2025 press kit) puts the fairing
  // ~0.21 m either side of centre at the headlights, not the 0.25–0.29 m first guessed, so
  // the three rear sections are narrowed to it (W). The beak sections were already inside.
  const W = [1, 1, 0.837, 0.724, 0.75];
  bodyParts.push(part(loft([
    { x: 0.84, prof: [[0.775, 0.0], [0.79, 0.04], [0.82, 0.05], [0.845, 0.03], [0.85, 0.0]] },
    { x: 0.78, prof: [[0.70, 0.03], [0.73, 0.12], [0.81, 0.15], [0.89, 0.12], [0.915, 0.05], [0.92, 0.0]] },
    { x: 0.68, prof: [[0.66, 0.08], [0.69, 0.21], [0.80, 0.245], [0.92, 0.20], [0.97, 0.09], [0.975, 0.0]] },
    { x: 0.58, prof: [[0.62, 0.12], [0.66, 0.26], [0.80, 0.29], [0.93, 0.24], [0.995, 0.11], [1.0, 0.0]] },
    { x: 0.48, prof: [[0.60, 0.14], [0.64, 0.26], [0.80, 0.28], [0.92, 0.22], [0.97, 0.10], [0.98, 0.0]] },
  ].map((s, i) => ({ x: s.x, prof: s.prof.map(([y, z]) => [y, z * W[i]]) })), livery)));
  // tank: the crown sits right above the axle midpoint, 1.07 m up
  bodyParts.push(part(loft([
    { x: 0.30, prof: [[0.86, 0.10], [0.93, 0.17], [0.98, 0.14], [1.0, 0.06], [1.005, 0.0]] },
    { x: 0.15, prof: [[0.80, 0.15], [0.90, 0.21], [1.0, 0.19], [1.045, 0.08], [1.055, 0.0]] },
    { x: 0.0, prof: [[0.80, 0.16], [0.90, 0.21], [1.01, 0.19], [1.06, 0.08], [1.07, 0.0]] },
    { x: -0.12, prof: [[0.81, 0.14], [0.89, 0.18], [0.99, 0.15], [1.035, 0.06], [1.04, 0.0]] },
    { x: -0.20, prof: [[0.83, 0.10], [0.88, 0.13], [0.92, 0.10], [0.94, 0.04], [0.945, 0.0]] },
  ], livery)));
  // tail unit: under the seat, stepping up to the pillion cowl and the LED tail
  bodyParts.push(part(loft([
    { x: -0.38, prof: [[0.73, 0.12], [0.80, 0.135], [0.84, 0.11], [0.85, 0.0]] },
    { x: -0.58, prof: [[0.78, 0.105], [0.90, 0.115], [0.985, 0.085], [0.995, 0.0]] },
    { x: -0.74, prof: [[0.86, 0.075], [0.94, 0.085], [1.0, 0.06], [1.005, 0.0]] },
    { x: -0.86, prof: [[0.93, 0.03], [0.96, 0.04], [0.985, 0.03], [0.99, 0.0]] },
  ], livery)));
  // belly pan (around the exhaust collector); a third of the width first guessed: in the front
  // view nothing shows outside the tyre (±0.06 m) below 0.25 m
  bodyParts.push(part(loft([
    { x: 0.40, prof: [[0.20, 0.0], [0.22, 0.12], [0.30, 0.16], [0.34, 0.17]] },
    { x: 0.30, prof: [[0.155, 0.0], [0.165, 0.15], [0.26, 0.19], [0.33, 0.20]] },
    { x: -0.22, prof: [[0.20, 0.0], [0.21, 0.13], [0.28, 0.16], [0.33, 0.17]] },
  ].map(s => ({ x: s.x, prof: s.prof.map(([y, z]) => [y, z * 0.35]) })), () => C.black2)));
  // Side fairing panels, both sides; outer faces are flat above the knee so the decals sit
  // on them, and curve in toward the belly pan below it (bend()).
  // They stop short of the engine (its clutch cover, the frame and the swingarm all
  // show on the real bike) and below the frame spar.
  const SIDE = [[0.62, 0.68], [0.60, 0.56], [0.50, 0.42], [0.40, 0.33], [0.33, 0.30], [0.24, 0.36], [0.14, 0.50],
                [0.08, 0.62], [0.08, 0.64], [0.20, 0.70], [0.40, 0.80], [0.50, 0.82]];
  for (const s of [1, -1]) bodyParts.push(panel(SIDE, 0.215, 0.05, C.black, s, true));
  // Side covers under the seat: the dark triangle between the tank, the frame spar
  // and the seat.
  const UNDER_SEAT = [[0.04, 0.80], [0.0, 0.70], [-0.15, 0.62], [-0.40, 0.70], [-0.56, 0.79], [-0.45, 0.83], [-0.18, 0.83]];
  for (const s of [1, -1]) bodyParts.push(panel(UNDER_SEAT, 0.165, 0.04, C.black2, s));
  // winglets: the double-layer aero on each flank, and the red front wing below the
  // headlights
  // (same footprints as the boxes they replace; the swept planforms are stylised)
  // Spans from the front view: winglet tips 0.23 m from centre, front-wing tips 0.235 m.
  for (const s of [1, -1]) {
    bodyParts.push(wing([[0.11, -0.045 * s], [-0.11, -0.045 * s], [-0.09, 0.045 * s], [0.05, 0.045 * s]], 0.018, C.black, M4(0.57, 0.71, 0.185 * s, 0, 0.25 * s, -0.05)));
    bodyParts.push(wing([[0.08, -0.035 * s], [-0.08, -0.035 * s], [-0.065, 0.035 * s], [0.03, 0.035 * s]], 0.014, C.black, M4(0.49, 0.685, 0.195 * s, 0, 0.2 * s, -0.04)));
  }
  bodyParts.push(wing([[0.13, -0.19], [0.13, 0.19], [0.09, 0.235], [-0.13, 0.235], [-0.13, -0.235], [0.09, -0.235]], 0.022, C.red, M4(0.74, 0.705, 0, 0, 0, 0.08)));
  // seats: rider (black with red edge piping), behind the tank
  bodyParts.push(part(loft([
    { x: -0.19, prof: [[0.80, 0.13], [0.835, 0.14], [0.85, 0.08], [0.855, 0.0]] },
    { x: -0.38, prof: [[0.79, 0.15], [0.83, 0.16], [0.845, 0.09], [0.85, 0.0]] },
    { x: -0.56, prof: [[0.84, 0.12], [0.88, 0.13], [0.895, 0.07], [0.90, 0.0]] },
  ], (x, y, z) => (Math.abs(z) > 0.135 ? C.red : C.seat))));
  return bodyParts.map((geo, i) => ({ name: BODY_NAMES[i], geo }));
}

// The smoked screen: it rises from the fairing's top edge to a peak 1.18 m up, well back.
export function screenGeometry() {
  return loft([
    { x: 0.73, prof: [[0.94, 0.17], [0.965, 0.12], [0.975, 0.0]] },
    { x: 0.62, prof: [[1.0, 0.19], [1.07, 0.13], [1.10, 0.0]] },
    { x: 0.50, prof: [[1.02, 0.16], [1.14, 0.10], [1.18, 0.0]] },
    { x: 0.45, prof: [[1.03, 0.14], [1.15, 0.08], [1.17, 0.0]] },
  ], () => 0xffffff);
}

// The bodywork's shape as one number: a weighted sum of every coordinate, over the parts in
// order (= the merged body). assets/bike/rs660-body.glb carries the value it was baked from,
// so a baked body whose shape has since changed in code is never used.
export function bodyFingerprint(arrays) {
  let s = 0, k = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++, k++) s += a[i] * ((k % 97) + 1);
  return Math.round(s * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
export function createBikeModel() {
  const bin = [];
  const own = o => (bin.push(o), o);

  const paint = own(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12 }));
  const metal = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.88 }));   // brushed alloy
  const chrome = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 1 }));     // brake discs
  const rubber = own(new THREE.MeshStandardMaterial({ vertexColors: true, map: own(makeTreadTexture()), roughness: 0.94, metalness: 0 }));
  const matte = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 }));
  const glass = own(new THREE.MeshPhysicalMaterial({ color: 0x15171c, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, clearcoat: 1 }));
  const lamp = own(new THREE.MeshBasicMaterial({ color: 0xe8f4ff }));
  const drl = own(new THREE.MeshBasicMaterial({ color: 0xbfe4ff }));
  const tail = own(new THREE.MeshBasicMaterial({ color: 0x8a0d12 }));
  const amber = own(new THREE.MeshBasicMaterial({ color: 0xff9a1a }));
  const decalOpts = { transparent: true, roughness: 0.35, metalness: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const decalR = own(new THREE.MeshStandardMaterial({ map: own(makeDecalTexture(false)), ...decalOpts }));
  const decalL = own(new THREE.MeshStandardMaterial({ map: own(makeDecalTexture(true)), ...decalOpts }));
  const leather = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08 }));

  // The rig's geometry: the code-built bike's, until useBike() swaps in the R1M's own.
  const rig = { rake: RAKE, forkLen: FORK_LEN, fr: FR, rr: RR, foot: new THREE.Vector3(-0.37, 0.39, 0.20) };

  const root = new THREE.Group();          // position + yaw
  const pitchPivot = new THREE.Group();    // grade + wheelie, pivots at the rear contact patch
  pitchPivot.position.x = RA;
  root.add(pitchPivot);
  const lean = new THREE.Group();          // roll about the contact line
  lean.position.x = -RA;
  pitchPivot.add(lean);

  const add = (geo, mat, parent = lean, shadow = true) => {
    own(geo);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  };

  // ---------- painted bodywork (one merged mesh) ----------
  const body = add(merge(bodyworkParts().map(p => p.geo)), paint);

  // side decals — one plane per side, mapped so the text reads correctly on both
  for (const s of [1, -1]) {
    const w = DECAL_X[1] - DECAL_X[0], h = DECAL_Y[1] - DECAL_Y[0];
    const g = new THREE.PlaneGeometry(w, h, 1, 32);  // rows, so it can follow the panel's bend
    if (s < 0) g.rotateY(Math.PI);                // face outward on the left, unmirrored
    g.translate((DECAL_X[0] + DECAL_X[1]) / 2, (DECAL_Y[0] + DECAL_Y[1]) / 2, (0.215 + 0.003) * s);
    add(bend(g, s), s > 0 ? decalR : decalL, lean, false);
  }

  // ---------- glass, lights ----------
  add(screenGeometry(), glass, lean, false);
  // Angular LED headlight units either side of the centre intake, sitting on the
  // nose surface (inner corners on the front cap, outer corners on the flank),
  // with a DRL blade along each top edge.
  // The units are laid onto the nose: a grid over each traced quad, every point cast onto
  // the (smoothed) bodywork along the quad's normal and lifted `lift` off it. Each sits in
  // a dark recess, the lamp and DRL outline grown 18% about its centre.
  const lampGeo = [], drlGeo = [], recess = [];
  const ray = new THREE.Raycaster(), noseMesh = new THREE.Mesh(body.geometry);
  function onNose(q, s, lift, color) {
    const [a, b, c, d] = q.map(p => new THREE.Vector3(...p)), N = 4, P = [];
    const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(b, a)).normalize();   // (traced corners run clockwise seen from outside)
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const p = a.clone().lerp(b, i / N).lerp(d.clone().lerp(c, i / N), j / N);
      ray.set(p.clone().addScaledVector(n, 0.1), n.clone().negate());
      const hit = ray.intersectObject(noseMesh)[0];
      if (hit) p.copy(hit.point);
      p.addScaledVector(n, lift);
      P.push([p.x, p.y, p.z * s]);
    }
    const pos = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * (N + 1) + i, t = [k, k + 1, k + N + 2, k, k + N + 2, k + N + 1];
      if (s > 0) t.reverse();                                // outward on the right; mirroring flips it
      for (const v of t) pos.push(...P[v]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return part(g, color);
  }
  const grow = q => {
    const c = [0, 1, 2].map(i => q.reduce((a, p) => a + p[i] / 4, 0));
    return q.map(p => p.map((v, i) => c[i] + (v - c[i]) * 1.18));
  };
  // (widths × 0.837 with the nose section they sit on: outer corners ~0.20 m from centre,
  // as in the front view)
  const hw = q => q.map(([x, y, z]) => [x, y, z * 0.837]);
  for (const s of [1, -1]) {
    // traced: x 0.665–0.83, y 0.745–0.86, the top edge sloping down to the beak
    const q = hw([[0.83, 0.775, 0.07], [0.69, 0.745, 0.232], [0.665, 0.855, 0.242], [0.81, 0.815, 0.10]]);
    const top = hw([[0.66, 0.874, 0.24], [0.80, 0.834, 0.097]]);
    lampGeo.push(onNose(q, s, 0.004, 0xffffff));
    drlGeo.push(onNose([...hw([[0.81, 0.817, 0.10], [0.665, 0.857, 0.243]]), ...top], s, 0.004, 0xffffff));
    recess.push(onNose(grow([...q.slice(0, 2), ...top]), s, 0.0015, 0x07080a));
  }
  for (const m of [lamp, drl]) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  add(merge(lampGeo), lamp, lean, false);
  add(merge(drlGeo), drl, lean, false);
  // LED tail light: a slim lens in a black housing across the tail tip (lens shape stylised)
  const TAILM = M4(-0.866, 0.958, 0, 0, 0, Math.PI / 2 - 0.35);
  const tailLamp = add(wing([[0.015, -0.05], [0.015, 0.05], [-0.015, 0.04], [-0.015, -0.04]], 0.014, 0xffffff, TAILM), tail, lean, false);
  recess.push(part(new THREE.BoxGeometry(0.038, 0.02, 0.112), 0x07080a, TAILM.clone().multiply(M4(0, -0.006, 0))));
  const indic = [];
  for (const s of [1, -1]) {
    indic.push(part(new THREE.BoxGeometry(0.05, 0.02, 0.02), 0xffffff, M4(0.60, 0.66, 0.27 * s)));
    indic.push(part(new THREE.BoxGeometry(0.05, 0.02, 0.02), 0xffffff, M4(-0.95, 0.84, 0.10 * s)));
  }
  add(merge(indic), amber, lean, false);

  // ---------- chassis, engine, exhaust (metal + matte) ----------
  const metalParts = [], matteParts = [];
  for (const s of [1, -1]) {
    // Twin-spar aluminium frame: the silver diagonal that shows between the tank and
    // the fairing, from the steering head down and back to the swingarm pivot.
    metalParts.push(rbar([HEAD.x - 0.03, HEAD.y + 0.01, 0.10 * s], [0.0, 0.67, 0.19 * s], 0.045, 0.11, C.alu));
    metalParts.push(rbar([0.0, 0.67, 0.19 * s], [-0.14, 0.60, 0.18 * s], 0.045, 0.11, C.alu));
    metalParts.push(rbar([-0.14, 0.62, 0.17 * s], [PIVOT.x, PIVOT.y, 0.16 * s], 0.04, 0.12, C.alu));
    // rider footpegs (with an alloy end cap) and heel guards; pillion pegs on the subframe
    metalParts.push(rod([-0.38, 0.36, 0.16 * s], [-0.38, 0.36, 0.25 * s], 0.012, C.steel, 10));
    metalParts.push(rod([-0.38, 0.36, 0.25 * s], [-0.38, 0.36, 0.256 * s], 0.014, C.alu, 10));
    // heel guard: the old bar's plate, cut out with lightening holes (stylised)
    metalParts.push(plate([[-0.27, 0.48], [-0.45, 0.435], [-0.45, 0.365], [-0.27, 0.405]], [[-0.315, 0.44, 0.014], [-0.395, 0.42, 0.013]], 0.008, 0.165 * s, C.alu));
    // gear lever (left) / rear brake pedal (right): pivot by the peg, toe tip forward (stylised)
    metalParts.push(rbar([-0.37, 0.355, 0.235 * s], [-0.24, 0.325, 0.235 * s], 0.012, 0.016, C.black2));
    metalParts.push(rod([-0.245, 0.325, 0.235 * s], [-0.245, 0.325, 0.27 * s], 0.008, C.steel, 6));
    metalParts.push(rod([-0.66, 0.60, 0.12 * s], [-0.66, 0.60, 0.20 * s], 0.01, C.steel, 6));
    // mirrors on stalks from the fairing, ahead of the bars: a rounded housing with
    // the glass facing back
    // (same traced 13 × 6 × 10 cm envelope as before; the frame sits on the glass)
    const mir = M4(0.5257, 1.0697, 0.33 * s, 0, 0, -0.15);
    matteParts.push(part(new THREE.SphereGeometry(0.5, 12, 6, Math.PI / 2, Math.PI), C.black2, mir.clone().multiply(M4(0, 0, 0, 0, 0, 0, 0.26, 0.06, 0.10))));
    metalParts.push(part(new THREE.CircleGeometry(0.5, 12), 0xc9ced6, mir.clone().multiply(M4(-0.001, 0, 0, 0, -Math.PI / 2, 0, 0.098, 0.058, 1))));
    metalParts.push(rod([0.62, 0.97, 0.24 * s], [0.60, 1.04, 0.30 * s], 0.009, C.black2, 6));
  }
  // engine (left open by the fairing): crankcase, cylinders leaning forward under
  // the fairing, round clutch cover on the right, alternator cover on the left
  // (±0.12 m wide: no wider than the lower fairing in the front view)
  matteParts.push(part(new THREE.BoxGeometry(0.38, 0.30, 0.24), C.engine, M4(-0.02, 0.42, 0)));
  matteParts.push(part(new THREE.BoxGeometry(0.22, 0.26, 0.30), C.engine, M4(0.22, 0.58, 0, 0, 0, -0.45)));
  metalParts.push(part(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 18), C.alu, M4(-0.06, 0.455, 0.13, Math.PI / 2, 0, 0)));
  metalParts.push(part(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 14), C.alu, M4(-0.04, 0.42, -0.13, Math.PI / 2, 0, 0)));
  // radiator behind the front wheel: a frame round a core, with louvred grille slats
  const RAD = M4(0.45, 0.52, 0, 0, 0, -0.3);
  matteParts.push(part(new THREE.BoxGeometry(0.05, 0.30, 0.36), 0x1b1c1f, RAD));
  matteParts.push(part(new THREE.BoxGeometry(0.004, 0.27, 0.33), 0x0b0c0e, RAD.clone().multiply(M4(0.026, 0, 0))));
  for (let i = 0; i < 9; i++) matteParts.push(part(new THREE.BoxGeometry(0.006, 0.01, 0.33), 0x3a3d43, RAD.clone().multiply(M4(0.03, -0.12 + i * 0.03, 0, 0, 0, 0.5))));
  // Exhaust: collector under the engine to a stubby silver silencer below the
  // swingarm on the right, exiting behind the footpeg. The silencer is the old box's
  // envelope with rounded edges, ending in a short dark tip (stylised).
  metalParts.push(rod([0.36, 0.30, 0.0], [-0.08, 0.22, 0.06], 0.04, 0x2d2f33, 10));
  const can = [[-0.06, 0.0], [-0.055, 0.05], [-0.04, 0.07], [0.04, 0.07], [0.055, 0.05], [0.06, 0.0]];
  metalParts.push(part(loft([0.16, 0.15, -0.14, -0.15].map((x, i) => ({ x, prof: can.map(([y, z]) => [y * (i % 3 ? 1 : 0.85), z * (i % 3 ? 1 : 0.85)]) })),
    () => 0x8c9096, 2), null, M4(-0.30, 0.26, 0.10, 0, 0, 0.04)));
  matteParts.push(rod([-0.445, 0.255, 0.10], [-0.49, 0.25, 0.10], 0.03, 0x2d2f33, 12));
  matteParts.push(part(new THREE.CircleGeometry(0.023, 12), 0x030303, M4(-0.4915, 0.25, 0.10, 0, -Math.PI / 2, 0)));
  // licence-plate hanger: a long arm back from the tail, then the plate and a reflector
  matteParts.push(rbar([-0.74, 0.86, 0], [-0.95, 0.87, 0], 0.08, 0.025, C.black2));
  matteParts.push(rbar([-0.95, 0.87, 0], [-1.0, 0.68, 0], 0.08, 0.02, C.black2));
  matteParts.push(part(new THREE.BoxGeometry(0.01, 0.12, 0.17), 0x2a2b2e, M4(-0.99, 0.74, 0, 0, 0, 0.25)));
  matteParts.push(part(new THREE.BoxGeometry(0.008, 0.02, 0.06), 0x9a1016, M4(-0.968, 0.825, 0, 0, 0, 0.25)));
  matteParts.push(...recess);
  add(merge(metalParts), metal);
  add(merge(matteParts), matte);

  // ---------- dash: a small TFT (speed, gear, rev bar) behind the screen ----------
  // Frame-mounted on both bikes (the R1M's and the RS 660's dash sit on the fairing stay, not
  // the bars), so it hangs from `lean`. A 256×128 canvas, redrawn only when a shown value
  // changes and at most DASH_HZ times a second (dash()); never per frame.
  const DASH_HZ = 12, DASH_SEGS = 24;
  const dashCv = document.createElement('canvas');
  dashCv.width = 256; dashCv.height = 128;
  const dashG = dashCv.getContext('2d');
  const dashTex = own(new THREE.CanvasTexture(dashCv));
  dashTex.colorSpace = THREE.SRGBColorSpace;
  dashTex.anisotropy = 4;
  const dashMesh = add(new THREE.PlaneGeometry(0.12, 0.06), own(new THREE.MeshBasicMaterial({ map: dashTex })), lean, false);
  const dashShown = { speed: -1, mph: null, gear: -1, seg: -1 };
  let dashT = 1;
  // Where it sits (model space, metres) and how far its face tips back from facing the rider.
  function placeDash(x, y, tilt) {
    dashMesh.position.set(x, y, 0);
    dashMesh.rotation.set(0, -Math.PI / 2, 0);            // face (+z) to the rider (−x)
    dashMesh.rotateX(-tilt);                               // … and tipped back, up toward the eyes
  }
  placeDash(0.46, 0.93, 0.9);                              // RS 660: just behind the screen's base
  function drawDash(speed, mph, gear, seg) {
    const g = dashG;
    g.fillStyle = '#05070a'; g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < DASH_SEGS; i++) {
      g.fillStyle = i >= seg ? '#1b2129' : i >= DASH_SEGS - 4 ? '#ff3b30' : '#e8eef5';
      g.fillRect(10 + i * 9.9, 10, 7.5, 16);
    }
    g.textAlign = 'right';
    g.fillStyle = '#ffffff';
    g.font = '700 68px Arial, sans-serif';
    g.fillText(String(speed), 166, 100);
    g.fillStyle = '#8fa0b3';
    g.font = '600 17px Arial, sans-serif';
    g.fillText(mph ? 'MPH' : 'KM/H', 166, 120);
    g.strokeStyle = '#3a4553'; g.lineWidth = 3;
    g.strokeRect(182, 38, 64, 82);
    g.textAlign = 'center';
    g.fillStyle = '#ff3b30';
    g.font = '700 60px Arial, sans-serif';
    g.fillText(gear ? String(gear) : 'N', 214, 104);
    dashTex.needsUpdate = true;
  }
  drawDash(0, false, 0, 0);

  // ---------- front end: steering pivot about the raked axis ----------
  const steerPivot = new THREE.Group();
  steerPivot.position.copy(HEAD);
  steerPivot.rotation.z = RAKE;
  lean.add(steerPivot);
  const steer = new THREE.Group();
  steerPivot.add(steer);
  {
    const forkMetal = [], forkMatte = [];
    for (const s of [1, -1]) {
      forkMetal.push(rod([0, 0.02, 0.105 * s], [0, -0.40, 0.105 * s], 0.026, C.gold, 12));    // Öhlins gold
      forkMatte.push(rod([0, -0.36, 0.105 * s], [0, -FORK_LEN + 0.02, 0.105 * s], 0.032, C.black2, 10));
      // clip-on bars and grips
      forkMatte.push(rod([0.0, -0.04, 0.12 * s], [-0.04, -0.07, 0.30 * s], 0.014, C.black2, 6));
      forkMatte.push(rod([-0.04, -0.07, 0.24 * s], [-0.05, -0.075, 0.33 * s], 0.019, C.rubber, 8));
      // bar ends, fork caps; clutch (left) and brake (right) perch and lever ahead of the
      // grip (levers, master cylinder and reservoir are stylised, not traced)
      forkMetal.push(rod([-0.05, -0.075, 0.33 * s], [-0.0515, -0.076, 0.352 * s], 0.021, C.alu, 10));
      forkMetal.push(rod([0, 0.02, 0.105 * s], [0, 0.034, 0.105 * s], 0.022, C.alu, 10));
      forkMatte.push(rod([-0.012, -0.055, 0.20 * s], [-0.012, -0.055, 0.235 * s], 0.013, C.black2, 8));
      forkMatte.push(rbar([0.0, -0.06, 0.225 * s], [0.014, -0.085, 0.345 * s], 0.008, 0.014, C.black2));
    }
    forkMatte.push(rod([-0.015, -0.045, 0.165], [-0.015, -0.05, 0.205], 0.011, C.black2, 8));
    forkMatte.push(rod([-0.04, -0.03, 0.185], [-0.04, 0.025, 0.185], 0.016, 0x2a2b2e, 10));
    forkMatte.push(part(new THREE.BoxGeometry(0.08, 0.035, 0.30), C.black2, M4(0, 0.0, 0)));        // top clamp
    forkMatte.push(part(new THREE.BoxGeometry(0.08, 0.04, 0.30), C.black2, M4(0, -0.13, 0)));       // bottom clamp
    add(merge(forkMetal), metal, steer);
    add(merge(forkMatte), matte, steer);
  }
  // grip markers for the rider's hands
  const gripL = new THREE.Object3D(), gripR = new THREE.Object3D();
  gripR.position.set(-0.045, -0.072, 0.29); gripL.position.set(-0.045, -0.072, -0.29);
  steer.add(gripL, gripR);
  // fork slider (suspension travel slides the axle carrier up the fork)
  const fork = new THREE.Group();
  fork.position.y = -FORK_LEN;
  steer.add(fork);
  const frontCarrier = new THREE.Group();          // wheel plane stays vertical
  frontCarrier.rotation.z = -RAKE;
  fork.add(frontCarrier);
  // fender + calipers ride with the axle, don't spin
  {
    const g = new THREE.TorusGeometry(FR + 0.035, 0.07, 10, 28, Math.PI * 0.55);
    add(part(g, C.black, M4(0, 0, 0, 0, 0, Math.PI * 0.18, 1, 1, 1.25)), paint, frontCarrier);
    // radial calipers: the old boxes' size and place, rounded
    const cal = [], cd = [-Math.sin(0.6) * 0.065, Math.cos(0.6) * 0.065];
    for (const s of [1, -1]) cal.push(rbar([-0.11 - cd[0], 0.08 - cd[1], 0.075 * s], [-0.11 + cd[0], 0.08 + cd[1], 0.075 * s], 0.04, 0.06, 0x24262a, 0.014));
    add(merge(cal), matte, frontCarrier);
  }
  const frontSpin = wheel(FR, 0.06, true);
  frontCarrier.add(frontSpin);

  // ---------- rear: swingarm, shock, wheel ----------
  const swing = new THREE.Group();
  swing.position.copy(PIVOT);
  lean.add(swing);
  const armVec = new THREE.Vector3(RA - PIVOT.x, RR - PIVOT.y, 0);
  {
    const p = [];
    for (const s of [1, -1]) {
      p.push(rbar([0, 0, 0.13 * s], [armVec.x, armVec.y, 0.13 * s], 0.04, 0.11, C.alu, 0.012));
      p.push(rbar([armVec.x + 0.04, armVec.y, 0.13 * s], [armVec.x - 0.012, armVec.y, 0.13 * s], 0.046, 0.045, C.steel));   // chain adjuster
    }
    p.push(bar([armVec.x * 0.1, armVec.y * 0.1, 0], [armVec.x * 0.1, armVec.y * 0.1 + 0.001, 0.001], 0.28, 0.05, C.alu));
    // Chain (left): each run a pair of side plates, from the front sprocket over the rear
    // one, which turns with the wheel (sprocket sizes and tooth counts are stylised).
    for (const dz of [0.006, -0.006]) {
      p.push(bar([0.02, 0.03, -0.11 + dz], [armVec.x, armVec.y + 0.083, -0.11 + dz], 0.003, 0.014, 0x3b3d42));
      p.push(bar([0.02, -0.04, -0.11 + dz], [armVec.x, armVec.y - 0.083, -0.11 + dz], 0.003, 0.014, 0x3b3d42));
    }
    p.push(sprocket(0.036, 15, 0.008, 0x55585f, -0.11).translate(0.02, -0.005, 0));
    add(merge(p), metal, swing);
  }
  {
    // Öhlins shock, laid back above the swingarm's front
    const shock = [rod([-0.24, 0.53, 0.04], [-0.38, 0.65, 0.04], 0.03, C.gold, 10),
                   rod([-0.27, 0.555, 0.04], [-0.36, 0.635, 0.04], 0.042, 0xf2c21a, 10)];
    add(merge(shock), metal);
  }
  const rearSpin = wheel(RR, 0.09, false);
  rearSpin.position.copy(armVec);
  swing.add(rearSpin);
  // Rear hugger: the short black guard over the front of the tyre, on the swingarm.
  {
    const g = new THREE.TorusGeometry(RR + 0.03, 0.06, 8, 20, Math.PI * 0.4);
    // … and the rear caliper on the right-side disc, ahead of and below the axle (placement stylised)
    const c = [armVec.x + 0.066, armVec.y - 0.066, 0.081], t = [0.03, 0.03, 0];
    add(merge([part(g, C.black2, M4(armVec.x, armVec.y, 0, 0, 0, Math.PI * 0.32, 1, 1, 1.4)),
      rbar(c.map((v, i) => v - t[i]), c.map((v, i) => v + t[i]), 0.036, 0.04, 0x24262a, 0.012)]), matte, swing);
  }

  // A wheel: tyre, black split-spoke rim, disc(s). Spins about its z axis.
  function wheel(R, halfW, front) {
    const g = new THREE.Group();
    // Tyre: lathed section with a round crown (visible at lean); matte, with a tread hint.
    const tyre = part(lathe(tyreProfile(R, halfW, front ? 0.8 : 1.05), 32), C.rubber);
    const rim = [], w = halfW * 0.8, rIn = RIM - 0.012;
    rim.push(part(lathe([[RIM + 0.012, w], [RIM - 0.004, w], [rIn, w * 0.7], [rIn, -w * 0.7], [RIM - 0.004, -w], [RIM + 0.012, -w]], 32), C.black2));
    rim.push(part(new THREE.CylinderGeometry(0.055, 0.055, halfW * 1.6, 12), C.black2, M4(0, 0, 0, Math.PI / 2, 0, 0)));
    // Five split spokes (as before), tapering from the hub to the rim.
    for (let k = 0; k < 5; k++) {
      const a = k * Math.PI * 2 / 5;
      for (const off of [-0.09, 0.09]) {
        const A = [Math.cos(a) * 0.05, Math.sin(a) * 0.05], B = [Math.cos(a + off) * (rIn + 0.004), Math.sin(a + off) * (rIn + 0.004)];
        const d = Math.hypot(B[0] - A[0], B[1] - A[1]), nx = -(B[1] - A[1]) / d, ny = (B[0] - A[0]) / d;
        const sp = new THREE.Shape([[A, 0.017], [B, 0.008], [B, -0.008], [A, -0.017]].map(([P, h]) => new THREE.Vector2(P[0] + nx * h, P[1] + ny * h)));
        rim.push(part(new THREE.ExtrudeGeometry(sp, { depth: 0.018, bevelEnabled: false }).translate(0, 0, -0.009), C.black2));
      }
    }
    if (!front) rim.push(sprocket(0.085, 30, 0.007, 0x55585f, -0.11));
    // Brake discs (Brembo 2 × 320 mm front, 220 mm rear): a braking band on a carrier
    // with six arms and floating buttons, so the spokes show through. Band width stylised.
    const discs = [];
    const dR = front ? 0.16 : 0.11, band = front ? 0.034 : 0.026, ri = dR - band;
    for (const s of front ? [1, -1] : [1]) {
      const z = (halfW * 0.9) * s;
      for (const f of [1, -1]) {
        discs.push(part(new THREE.RingGeometry(ri, dR, 36), C.steel, M4(0, 0, z + 0.003 * f, 0, f > 0 ? 0 : Math.PI, 0)));
        discs.push(part(new THREE.RingGeometry(0.058, 0.074, 14), 0x2a2c30, M4(0, 0, z + 0.004 * f, 0, f > 0 ? 0 : Math.PI, 0)));
      }
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3 + 0.3, c = Math.cos(a), sn = Math.sin(a);
        discs.push(bar([c * 0.07, sn * 0.07, z], [c * (ri + 0.006), sn * (ri + 0.006), z], 0.008, 0.014, 0x2a2c30));
        discs.push(rod([c * (ri + 0.002), sn * (ri + 0.002), z - 0.006], [c * (ri + 0.002), sn * (ri + 0.002), z + 0.006], 0.006, 0x8c9096, 6));
      }
    }
    add(tyre, rubber, g);
    add(merge(rim), matte, g);
    add(merge(discs), chrome, g);
    return g;
  }

  // ---------- rider: leathers with red knees and boots, black/red helmet ----------
  const rider = new THREE.Group();
  lean.add(rider);
  const riderParts = {};
  const seg = (name, r, len, colorTop, colorBot) => {
    const g = new THREE.CapsuleGeometry(r, len, 3, 8);
    const pg = g.toNonIndexed(); g.dispose();
    pg.computeVertexNormals();
    const a = new Float32Array(pg.attributes.position.count * 3);
    const c1 = new THREE.Color(colorTop), c2 = new THREE.Color(colorBot ?? colorTop);
    for (let i = 0; i < pg.attributes.position.count; i++) {
      const y = pg.attributes.position.getY(i);
      const c = y > 0 ? c1 : c2;
      a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
    }
    pg.setAttribute('color', new THREE.BufferAttribute(a, 3));
    const m = add(pg, leather, rider);
    m.userData.len = len + 2 * r;
    riderParts[name] = m;
    return m;
  };
  const TH = 0.42, SH = 0.43, UA = 0.29, FA2 = 0.29;   // thigh, shin, upper arm, forearm
  seg('torso', 0.15, 0.36, C.leather, C.leather);
  for (const s of ['L', 'R']) {
    seg('thigh' + s, 0.075, TH - 0.15, C.leather);
    seg('shin' + s, 0.06, SH - 0.12, C.leather, C.red);
    seg('upper' + s, 0.055, UA - 0.11, C.leather);
    seg('fore' + s, 0.048, FA2 - 0.096, C.leather, C.red);
  }
  {
    const hp = [];
    hp.push(part(new THREE.SphereGeometry(0.15, 14, 10), C.black, M4(0, 0, 0)));
    hp.push(part(new THREE.SphereGeometry(0.152, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), C.red, M4(0, 0.005, 0)));
    hp.push(part(new THREE.BoxGeometry(0.06, 0.07, 0.2), 0x0a0c10, M4(0.13, 0.0, 0)));
    const helmet = add(merge(hp), paint, rider);
    riderParts.helmet = helmet;
    const sliders = [];
    for (const s of [1, -1]) sliders.push(part(new THREE.BoxGeometry(0.06, 0.04, 0.03), C.white, M4(0, 0, 0)));
    riderParts.sliderR = add(sliders[0], matte, rider);
    riderParts.sliderL = add(sliders[1], matte, rider);
    const boots = [part(new THREE.BoxGeometry(0.24, 0.09, 0.08), C.red), part(new THREE.BoxGeometry(0.24, 0.09, 0.08), C.red)];
    riderParts.bootR = add(boots[0], matte, rider);
    riderParts.bootL = add(boots[1], matte, rider);
  }

  // Headlight beam (night only).
  // Low beam: aimed ~1.5° down so it reaches 60–100 m up the road. (Decay below the
  // physical 2 — a real headlight's reflector throws a tighter, longer beam than a
  // point source can.)
  const beam = new THREE.SpotLight(0xe6f0ff, 0, 170, 0.36, 0.5, 1.0);
  beam.position.set(0.95, 0.72, 0);
  beam.castShadow = false;
  const beamTarget = new THREE.Object3D();
  beamTarget.position.set(45, -0.5, 0);
  lean.add(beam, beamTarget);
  beam.target = beamTarget;

  // ---------- pose ----------
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const qn = new THREE.Quaternion();
  function place(mesh, a, b) {
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    v3.copy(b).sub(a).normalize();
    mesh.quaternion.setFromUnitVectors(up, v3);
  }
  // Two-bone IK: from root a to target c with bone lengths l1, l2, bending toward pole.
  function ik(a, c, l1, l2, pole, outJoint) {
    v1.copy(c).sub(a);
    let d = v1.length();
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
    v1.normalize();
    const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    v2.copy(pole).addScaledVector(v1, -pole.dot(v1)).normalize();
    outJoint.copy(a).addScaledVector(v1, along).addScaledVector(v2, h);
    return outJoint;
  }
  const J = {
    hip: new THREE.Vector3(), hipL: new THREE.Vector3(), hipR: new THREE.Vector3(), chest: new THREE.Vector3(),
    shL: new THREE.Vector3(), shR: new THREE.Vector3(), head: new THREE.Vector3(),
    kneeL: new THREE.Vector3(), kneeR: new THREE.Vector3(), footL: new THREE.Vector3(), footR: new THREE.Vector3(),
    elbL: new THREE.Vector3(), elbR: new THREE.Vector3(), handL: new THREE.Vector3(), handR: new THREE.Vector3(),
    poleK: new THREE.Vector3(), poleE: new THREE.Vector3(), knee2: new THREE.Vector3(), foot2: new THREE.Vector3(),
  };
  let hang = 0, tuck = 0.4, wheelUp = 0, spinF = 0, spinR = 0, dive = 0, squat = 0;
  const tmpM = new THREE.Matrix4();

  function poseRider(dt, leanAngle, wantTuck, wantWheel = 0) {
    hang += ((Math.max(-1, Math.min(1, leanAngle / (34 * DEG)))) - hang) * Math.min(1, dt * 5);
    tuck += ((wantTuck ? 1 : 0.35) - tuck) * Math.min(1, dt * 4);
    wheelUp += (wantWheel - wheelUp) * Math.min(1, dt * 4);   // assisted wheelie: sit back, arms straighter
    const h = hang, t = tuck, w = wheelUp;
    J.hip.set(-0.24 - 0.03 * t - 0.05 * w, 0.94 - 0.03 * Math.abs(h), 0.16 * h);
    J.chest.set(-0.02 + 0.16 * t - 0.10 * w, 1.30 - 0.17 * t - 0.03 * Math.abs(h) + 0.05 * w, 0.06 * h + 0.06 * h * t);
    J.head.set(J.chest.x + 0.10 + 0.04 * t, J.chest.y + 0.16 - 0.06 * t, J.chest.z + 0.07 * h);
    J.shR.set(J.chest.x - 0.02, J.chest.y - 0.02, J.chest.z + 0.19);
    J.shL.set(J.chest.x - 0.02, J.chest.y - 0.02, J.chest.z - 0.19);
    J.hipR.set(J.hip.x, J.hip.y, J.hip.z + 0.11);
    J.hipL.set(J.hip.x, J.hip.y, J.hip.z - 0.11);
    J.footR.copy(rig.foot);                         // on the pegs
    J.footL.copy(rig.foot).z *= -1;
    // hands on the grips (the grips steer, so read their positions every frame). The whole chain,
    // root down: getWorldPosition() below refreshes the grip's parents, so the rider must see this
    // frame's root too, or the hands land a frame's travel ahead of the bars (0.5 m at 140 km/h, 80 fps).
    lean.updateWorldMatrix(true, true);
    tmpM.copy(rider.matrixWorld).invert();
    gripR.getWorldPosition(J.handR).applyMatrix4(tmpM);
    gripL.getWorldPosition(J.handL).applyMatrix4(tmpM);
    if (skin) { poseSkin(h, t); return; }

    place(riderParts.torso, J.hip, J.chest);
    riderParts.helmet.position.copy(J.head);
    riderParts.helmet.rotation.set(-h * 0.5, 0, -0.25 * t);
    for (const s of ['R', 'L']) {
      const side = s === 'R' ? 1 : -1;
      const inside = side * h > 0 ? Math.abs(h) : 0;          // this knee is on the inside of the turn
      const hipP = s === 'R' ? J.hipR : J.hipL, foot = s === 'R' ? J.footR : J.footL;
      J.poleK.set(1, -0.1 + 0.2 * inside, side * (0.35 + 1.6 * inside)).normalize();
      const knee = ik(hipP, foot, TH, SH, J.poleK, s === 'R' ? J.kneeR : J.kneeL);
      place(riderParts['thigh' + s], hipP, knee);
      place(riderParts['shin' + s], knee, foot);
      const boot = riderParts['boot' + s];
      boot.position.set(foot.x + 0.02, foot.y - 0.02, foot.z);
      const slider = riderParts['slider' + s];
      slider.position.set(knee.x + 0.02, knee.y - 0.04, knee.z + side * 0.07);
      const sh = s === 'R' ? J.shR : J.shL, hand = s === 'R' ? J.handR : J.handL;
      J.poleE.set(-0.3, -1, side * 0.9).normalize();
      const elbow = ik(sh, hand, UA, FA2, J.poleE, s === 'R' ? J.elbR : J.elbL);
      place(riderParts['upper' + s], sh, elbow);
      place(riderParts['fore' + s], elbow, hand);
    }
  }

  // ---------- crash: the rider leaves the bike (the motion is ragdoll.js) ----------
  // While detached, the rider's parts live in `riderWorld` (game.js adds it to the
  // scene) and are posed from the ragdoll's points, relative to its origin.
  const riderWorld = new THREE.Group();
  let detached = false;
  const RP = Object.fromEntries(JOINTS.map(n => [n, new THREE.Vector3()]));
  const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), bm = new THREE.Matrix4();
  // Orient a part: its y along `upV`, its z toward `sideV` (so x points forward).
  function orient(mesh, upV, sideV, pos) {
    by.copy(upV).normalize();
    bz.copy(sideV).addScaledVector(by, -sideV.dot(by)).normalize();
    bx.crossVectors(by, bz);
    mesh.quaternion.setFromRotationMatrix(bm.makeBasis(bx, by, bz));
    mesh.position.copy(pos);
  }
  // The rider's joints in world space minus (ox, oy, oz), in JOINTS order — the
  // ragdoll's starting pose — and the rider moved off the bike.
  function detach(ox, oy, oz) {
    lean.updateMatrixWorld(true);
    const out = JOINTS.map(n => {
      const v = v3.copy(J[n]).applyMatrix4(rider.matrixWorld);
      return [v.x - ox, v.y - oy, v.z - oz];
    });
    riderWorld.position.set(ox, oy, oz);
    riderWorld.add(rider);
    rider.position.set(0, 0, 0);
    rider.rotation.set(0, 0, 0);
    detached = true;
    return out;
  }
  // A limb spans its two joints exactly. (On the bike the hands reach a little past
  // the forearm to the grips, which hides in the pose but not in a tumble.)
  const SEGS = ['torso', 'thighL', 'thighR', 'shinL', 'shinR', 'upperL', 'upperR', 'foreL', 'foreR'];
  function fit(mesh, a, b) {
    place(mesh, a, b);
    mesh.scale.set(1, a.distanceTo(b) / mesh.userData.len, 1);
  }
  function ragdoll(P) {
    JOINTS.forEach((n, i) => RP[n].set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    if (skin) { ragSkin(); return; }
    place(riderParts.torso, RP.hip, RP.chest);
    orient(riderParts.helmet, v1.copy(RP.head).sub(RP.chest), v2.copy(RP.shR).sub(RP.shL), RP.head);
    const across = v2.copy(RP.hipR).sub(RP.hipL);
    for (const s of ['R', 'L']) {
      const hip = RP['hip' + s], knee = RP['knee' + s], foot = RP['foot' + s];
      fit(riderParts['thigh' + s], hip, knee);
      fit(riderParts['shin' + s], knee, foot);
      fit(riderParts['upper' + s], RP['sh' + s], RP['elb' + s]);
      fit(riderParts['fore' + s], RP['elb' + s], RP['hand' + s]);
      orient(riderParts['boot' + s], v1.copy(knee).sub(foot), across, foot);
      riderParts['slider' + s].position.copy(knee);
    }
  }
  function attach() {
    if (!detached) return;
    lean.add(rider);
    for (const n of SEGS) riderParts[n]?.scale.set(1, 1, 1);
    detached = false;
  }

  // ---------- the kit rider (assets.js → loadRider): a skinned body in place of the limbs ----------
  // Bones are aimed, not animated: each driven bone turns from its bind pose so that its
  // length lies along the segment between two of the rider's joints (J on the bike, the
  // ragdoll's points in a crash) and its hinge (knee, elbow) lies across that limb's bend.
  // The body keeps its own proportions: on the bike the joints are solved with its segment
  // lengths and read back from its skeleton, so the ragdoll starts from, and keeps, its
  // real shape. Without the model (load failed) the code-built limbs above stay.
  let skin = null;
  const HELM = new THREE.Vector3(0, 0.1, 0.02);            // helmet centre in the head bone's frame
  const LEFT = new THREE.Vector3(0, 0, -1), FWD = new THREE.Vector3(1, 0, 0), BACK = new THREE.Vector3(-1, 0, 0);
  const qa = new THREE.Quaternion(), qp = new THREE.Quaternion(), eul = new THREE.Euler();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), vd = new THREE.Vector3();
  // A node's rotation / position in rider space (its own and its parents' transforms, up to `rider`).
  function rq(o, q) { q.identity(); for (; o !== rider; o = o.parent) q.premultiply(o.quaternion); return q; }
  function rp(o, v) { v.set(0, 0, 0); for (; o !== rider; o = o.parent) v.multiply(o.scale).applyQuaternion(o.quaternion).add(o.position); return v; }
  function basis(d, s, q) {                                // y along d, z toward s (squared to d)
    by.copy(d).normalize();
    bz.copy(s).addScaledVector(by, -s.dot(by)).normalize();
    bx.crossVectors(by, bz);
    return q.setFromRotationMatrix(bm.makeBasis(bx, by, bz));
  }
  // Turn bone b so its bind direction lies along d and its bind side toward s.
  function aim(b, d, s) {
    basis(d, s, qa).multiply(b.q0).multiply(b.qb);
    b.bone.quaternion.copy(rq(b.bone.parent, qp).invert().multiply(qa));
  }
  // A limb from joint a through m to e: its hinge is across the bend (a straight limb keeps the last).
  function poseLimb(L, a, m, e) {
    va.subVectors(m, a); vb.subVectors(e, m);
    vc.crossVectors(va, vb);
    if (vc.lengthSq() > 1e-4 * va.lengthSq() * vb.lengthSq()) L.h.copy(vc).normalize();
    aim(L.up, va, L.h);
    aim(L.lo, vb, L.h);
  }
  const helmetCentre = out => rp(skin.head, out).add(vd.copy(HELM).applyQuaternion(rq(skin.head, qp)));

  // ---------- the baked livery (assets.js → loadBikeBody): same body, sharp paint ----------
  // The Blender bake (tools/blender/bake-livery.py) is this exact bodywork with UVs and a
  // painted texture. It replaces the vertex-coloured body only if its fingerprint matches the
  // shape built above; otherwise the code body stays (and says why). Returns whether it did.
  const bodyPrint = bodyFingerprint([body.geometry.attributes.position.array]);
  function useBody(asset) {
    if (!asset || body.material !== paint || r1m) return false;
    if (asset.fingerprint !== bodyPrint) {
      console.warn(`Canyon: baked livery is for another bodywork shape (${asset.fingerprint} ≠ ${bodyPrint}); re-run tools/blender/bake-livery.py. Using the code-built paint.`);
      return false;
    }
    body.geometry = own(asset.geometry.clone());
    body.material = own(new THREE.MeshPhysicalMaterial({ map: asset.map, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12 }));
    return true;
  }

  // ---------- the R1M (assets.js → loadBikeModel): a real model in place of the code-built bike ----------
  // Every code-built bike mesh goes; the R1M's parts hang from the same rig groups, which move to
  // the model's own pivots (steering axis, fork length, swingarm pivot, axles), and the grips and
  // the rider's feet move to its bars and pegs. Each part keeps one of the materials above (by name;
  // colours are per vertex). Physics is untouched: the file is scaled to spec.js's wheelbase and
  // rear wheel radius. Without the file the RS 660 above stays, baked livery and all.
  let r1m = false;
  const R1M_MATS = { paint, metal, chrome, matte, rubber, glass, lamp, tail, amber };
  const NO_SHADOW = new Set(['glass', 'lamp', 'tail', 'amber']);
  function useBike(asset) {
    if (r1m || !asset) return false;
    const old = [];
    (function walk(o) { for (const c of o.children) if (c !== rider && c !== dashMesh) { if (c.isMesh) old.push(c); walk(c); } })(lean);
    for (const m of old) { m.removeFromParent(); m.geometry.dispose(); }
    const P = asset.pivots, A = asset.anchors;
    rig.rake = Math.atan2(P.frontSpin.x - P.steer.x, P.steer.y - P.frontSpin.y);
    rig.forkLen = P.steer.distanceTo(P.frontSpin);
    rig.fr = P.frontSpin.y;
    rig.rr = P.rearSpin.y;
    rig.foot.set(A.pegR.x + 0.01, A.pegR.y + 0.03, A.pegR.z);   // as the RS 660's: on top of the peg, mid-length
    steerPivot.position.copy(P.steer);
    steerPivot.rotation.z = rig.rake;
    fork.position.y = -rig.forkLen;
    frontCarrier.rotation.z = -rig.rake;
    swing.position.copy(P.swing);
    rearSpin.position.copy(P.rearSpin).sub(P.swing);
    const Z = new THREE.Vector3(0, 0, 1);
    gripL.position.copy(A.gripL).sub(P.steer).applyAxisAngle(Z, -rig.rake);
    gripR.position.copy(A.gripR).sub(P.steer).applyAxisAngle(Z, -rig.rake);
    const groups = { body: lean, steer, frontCarrier, frontSpin, swing, rearSpin };
    for (const [n, list] of Object.entries(asset.parts)) {
      for (const { geometry, material } of list) {
        const m = add(geometry.clone(), R1M_MATS[material] ?? matte, groups[n], !NO_SHADOW.has(material));
        if (n === 'steer') m.rotation.z = -rig.rake;      // the file's frames are the bike's axes; steer's group is raked
      }
    }
    placeDash(0.47, 0.95, 0.9);                            // R1M: TFT behind the screen, above the top clamp
    r1m = true;
    if (!detached) poseRider(1, 0, false);
    return true;
  }

  function useRider(asset) {
    if (skin || !asset) return;
    const scene = asset.clone(), body = new THREE.Group();
    body.rotation.y = Math.PI / 2;                         // the model faces +z; the bike's forward is +x
    body.add(scene);
    rider.add(body);
    const mesh = scene.getObjectByProperty('isSkinnedMesh', true), bone = n => scene.getObjectByName(n);
    rider.updateMatrixWorld(true);
    colorRider(mesh);
    mesh.material = leather;
    mesh.castShadow = true;                                // part of the bike, the one shadow caster
    mesh.frustumCulled = false;                            // its bounds are the bind pose's, not a tumble's
    own(mesh.skeleton);
    const P = n => rp(bone(n), new THREE.Vector3());
    const B = (name, d0, s0) => {
      const o = bone(name);
      return { bone: o, qb: rq(o, new THREE.Quaternion()), q0: basis(d0, s0, new THREE.Quaternion()).invert(), l0: o.quaternion.clone() };
    };
    const limb = (s, up, lo, end, bend) => {
      const a = P(up + s), m = P(lo + s), e = P(end + s), d0 = m.clone().sub(a), h = d0.clone().cross(bend).normalize();
      return { up: B(up + s, d0, h), lo: B(lo + s, e.clone().sub(m), h), h, len1: a.distanceTo(m), len2: m.distanceTo(e) };
    };
    const pel = P('pelvis'), torso = P('neck_01').sub(pel), sh = P('upperarm_l').sub(pel), pp = bone('pelvis').parent;
    skin = { mesh, head: bone('Head'), fullGeo: mesh.geometry, cutGeo: torsoSplit(mesh) };
    skin.shadow = new THREE.SkinnedMesh(mesh.geometry, leather);   // the cockpit view's full-body shadow
    skin.shadow.bind(mesh.skeleton, mesh.bindMatrix);
    skin.shadow.castShadow = true;
    skin.shadow.frustumCulled = false;
    skin.shadow.layers.set(SHADOW_LAYER);
    skin.shadow.visible = false;
    mesh.add(skin.shadow);
    skin.headB = B('Head', torso, LEFT);
    skin.pelvis = B('pelvis', torso, LEFT);
    skin.spine = B('spine_01', torso, LEFT);
    skin.neck = B('neck_01', helmetCentre(new THREE.Vector3()).sub(P('neck_01')), LEFT);
    skin.pelvisInv = new THREE.Matrix4().compose(rp(pp, new THREE.Vector3()), rq(pp, new THREE.Quaternion()), new THREE.Vector3(1, 1, 1)).invert();
    for (const [s, k] of [['_l', 'L'], ['_r', 'R']]) {
      skin['arm' + k] = limb(s, 'upperarm', 'lowerarm', 'hand', FWD);
      skin['leg' + k] = limb(s, 'thigh', 'calf', 'foot', BACK);
      skin['foot' + k] = B('foot' + s, P('ball' + s).sub(P('foot' + s)), skin['leg' + k].h);
    }
    skin.Ls = Math.hypot(sh.x, sh.y);                      // pelvis → shoulder, side view
    skin.shZ = Math.abs(sh.z);
    skin.reach = skin.armL.len1 + skin.armL.len2;
    // The code-built limbs and boots go; the helmet stays, on the head bone.
    for (const n of [...SEGS, 'bootL', 'bootR']) { rider.remove(riderParts[n]); riderParts[n].geometry.dispose(); delete riderParts[n]; }
    skin.head.add(riderParts.helmet);
    riderParts.helmet.position.copy(HELM);
    riderParts.helmet.rotation.set(0, -Math.PI / 2, 0);    // visor (+x) to the face (the bone's +z)
    if (cockpitOn) { cockpitOn = false; cockpit(true); }   // loaded while in the cockpit view
    poseRider(1, 0, false);
  }

  // Leathers in the code rider's colours, by the bone that moves each vertex most: black,
  // with red gloves, gauntlets and boots (the far half of each forearm and shin); a dark
  // balaclava under the helmet. Once per page: the geometry is shared between plays.
  function colorRider(mesh) {
    const g = mesh.geometry;
    if (g.attributes.color) return;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = si.count, col = new Float32Array(n * 3), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, k)) k = j;
      const b = mesh.skeleton.bones[si.getComponent(i, k)], name = b.name;
      let hex = C.leather;
      if (/^(Head|neck)/.test(name)) hex = C.skin;
      else if (/^(hand|thumb|index|middle|ring|pinky|foot|ball)/.test(name)) hex = C.red;
      else if (/^(calf|lowerarm)/.test(name)) {
        mesh.getVertexPosition(i, v1).applyMatrix4(mesh.matrixWorld);
        if (v1.distanceToSquared(b.children[0].getWorldPosition(v2)) < v1.distanceToSquared(b.getWorldPosition(v3))) hex = C.red;
      }
      c.setHex(hex).toArray(col, i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // The cockpit view's body (see cockpit()): the index re-sorted so that triangles with two or
  // more corners moved mostly by the head, neck, spine, pelvis, a clavicle or an upper arm come
  // last (the upper arms too: their cut shoulders sat right under the camera), and a
  // geometry on the same buffers that draws only the ones before them. Once per page.
  const TORSO = /^(Head|neck|spine|pelvis|clavicle|upperarm)/;
  function torsoSplit(mesh) {
    const g = mesh.geometry;
    if (g.userData.cockpit) return g.userData.cockpit;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index.array, n = si.count, t = idx.length / 3;
    const hide = new Uint8Array(n), keep = [], cut = [];
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, k)) k = j;
      hide[i] = TORSO.test(mesh.skeleton.bones[si.getComponent(i, k)].name) ? 1 : 0;
    }
    for (let f = 0; f < t; f++) {
      const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
      (hide[a] + hide[b] + hide[c] >= 2 ? cut : keep).push(a, b, c);
    }
    idx.set(keep); idx.set(cut, keep.length);
    g.index.needsUpdate = true;
    const out = new THREE.BufferGeometry();
    for (const k in g.attributes) out.setAttribute(k, g.attributes[k]);
    out.setIndex(g.index);
    out.setDrawRange(0, keep.length);
    g.userData.cockpit = out;
    return out;
  }

  // On the bike: the code rider's lean-in, hang-off and tuck, mapped onto the body.
  function poseSkin(h, t) {
    const S = skin;
    for (const s of ['R', 'L']) { J['hand' + s].x -= 0.065; J['hand' + s].y += 0.02; }   // the wrist, behind the grip
    // Torso: the code rider's angle, or flatter if this (taller) body's hands couldn't
    // reach the grips — the upper of the two torso angles that put the wrists in reach.
    const wx = (J.handR.x + J.handL.x) / 2 - J.hip.x, wy = (J.handR.y + J.handL.y) / 2 - J.hip.y, D = Math.hypot(wx, wy);
    const R = Math.sqrt(Math.max(0, (S.reach * 0.97) ** 2 - (Math.abs(J.handR.z - J.handL.z) / 2 - S.shZ) ** 2));
    const a = (S.Ls * S.Ls - R * R + D * D) / (2 * D), y = Math.sqrt(Math.max(0, S.Ls * S.Ls - a * a));
    const th = Math.min(Math.atan2(J.chest.y - J.hip.y, J.chest.x - J.hip.x), Math.atan2(wy * a + wx * y, wx * a - wy * y));
    S.pelvis.bone.position.copy(J.hip).applyMatrix4(S.pelvisInv);
    va.set(Math.cos(th), Math.sin(th), (J.chest.z - J.hip.z) / S.Ls);
    aim(S.pelvis, va, LEFT);
    aim(S.spine, va, LEFT);
    rp(S.neck.bone, J.chest);
    aim(S.neck, vb.set(0.10 + 0.04 * t, 0.16 - 0.06 * t, 0.07 * h), LEFT);
    qa.setFromEuler(eul.set(-h * 0.5, 0, -0.25 * t)).multiply(S.headB.qb);   // the code helmet's tilt
    S.head.quaternion.copy(rq(S.head.parent, qp).invert().multiply(qa));
    helmetCentre(J.head);
    for (const s of ['R', 'L']) {
      const side = s === 'R' ? 1 : -1, inside = side * h > 0 ? Math.abs(h) : 0, leg = S['leg' + s], arm = S['arm' + s];
      // Legs: the ball of the foot on the peg, the ankle behind and above it; the inside knee drops.
      const hipP = rp(leg.up.bone, J['hip' + s]), foot = J['foot' + s], peg = vd.copy(foot);
      foot.x -= 0.13; foot.y += 0.07;
      J.poleK.set(1, -0.1 + 0.2 * inside, side * (0.35 + 1.6 * inside)).normalize();
      const knee = ik(hipP, foot, leg.len1, leg.len2, J.poleK, J['knee' + s]);
      peg.sub(foot);
      poseLimb(leg, hipP, knee, foot);
      aim(S['foot' + s], peg, leg.h);
      riderParts['slider' + s].position.set(knee.x + 0.02, knee.y - 0.04, knee.z + side * 0.07);
      // Arms: wrists to the grips (which steer), elbows out.
      const sh = rp(arm.up.bone, J['sh' + s]), hand = J['hand' + s], elb = J['elb' + s];
      J.poleE.set(-0.3, -1, side * 0.9).normalize();
      ik(sh, hand, arm.len1, arm.len2, J.poleE, elb);
      poseLimb(arm, sh, elb, hand);
      hand.sub(elb).setLength(arm.len2).add(elb);         // where the wrist really is (the ragdoll starts there)
    }
  }

  // In a crash: the body follows the ragdoll's points.
  function ragSkin() {
    const S = skin;
    S.pelvis.bone.position.copy(RP.hip).applyMatrix4(S.pelvisInv);
    va.subVectors(RP.chest, RP.hip);
    aim(S.pelvis, va, vb.subVectors(RP.hipL, RP.hipR));
    aim(S.spine, va, vb.subVectors(RP.shL, RP.shR));
    aim(S.neck, vc.subVectors(RP.head, RP.chest), vb);
    S.head.quaternion.copy(S.headB.l0);
    for (const s of ['R', 'L']) {
      poseLimb(S['leg' + s], RP['hip' + s], RP['knee' + s], RP['foot' + s]);
      poseLimb(S['arm' + s], RP['sh' + s], RP['elb' + s], RP['hand' + s]);
      riderParts['slider' + s].position.copy(RP['knee' + s]);
    }
  }

  // b: physics state. opts: { dt, tuck, wheelie (0..1), braking, night, gradeAngle }
  function update(b, opts) {
    const dt = opts.dt;
    rider.visible = true;
    root.position.set(b.x, b.y, b.z);
    root.rotation.set(0, -b.psi, 0);
    pitchPivot.rotation.z = (opts.gradeAngle || 0) + b.pitch;
    lean.rotation.x = b.phi;
    steer.rotation.y = -b.steer;
    spinF -= b.v / rig.fr * dt; spinR -= b.v / rig.rr * dt;
    frontSpin.rotation.z = spinF;
    rearSpin.rotation.z = spinR;
    // Suspension: under braking the fork dives (up to 90 of its 120 mm) and the
    // chassis pitches nose-down about the rear contact so the tyre stays planted;
    // under power the rear squats a touch (nose up).
    const wantDive = Math.max(0, Math.min(0.09, -(b.aTyre || 0) / 11 * 0.08));
    dive += (wantDive - dive) * Math.min(1, dt * 10);
    fork.position.y = -rig.forkLen + dive;
    const wantSquat = Math.max(0, Math.min(0.02, (b.aTyre || 0) / 10 * 0.02));
    squat += (wantSquat - squat) * Math.min(1, dt * 8);
    pitchPivot.rotation.z += -dive * Math.cos(rig.rake) / WB + squat;
    // Round tyre profiles: leaned over, the bike rides up on the tyre's shoulder.
    lean.position.y = 0.075 * (1 - Math.cos(b.phi));
    if (!detached) poseRider(dt, b.phi, opts.tuck, opts.wheelie || 0);
    tail.color.setHex(opts.braking ? 0xff1a22 : 0x8a0d12);
    // Always present (toggling a light's visibility recompiles every shader).
    beam.intensity = opts.night ? 180 : 0;
    dashT += dt;
  }

  // The dash's readout: speed (already in the player's units), mph?, gear (0 = N), rpm.
  // Redrawn only when what it shows changes, and at most DASH_HZ times a second.
  function dash(speed, mph, gear, rpm) {
    if (dashT < 1 / DASH_HZ) return;
    const sp = Math.round(speed), seg = Math.round(Math.max(0, Math.min(1, rpm / TUNED.limiterRpm)) * DASH_SEGS);
    const S = dashShown;
    if (sp === S.speed && mph === S.mph && gear === S.gear && seg === S.seg) return;
    S.speed = sp; S.mph = mph; S.gear = gear; S.seg = seg;
    dashT = 0;
    drawDash(sp, mph, gear, seg);
  }

  // Cockpit camera: the eyes (`eye`, in the helmet's frame: +x the visor, +y up, from its
  // centre), moved by `back` in the bike's frame (+x forward, +y up; leaned with the bike, but
  // not turned by the head's own nod), in world space.
  const qLean = new THREE.Quaternion(), vBack = new THREE.Vector3();
  function eyeWorld(out, eye, back) {
    const h = riderParts.helmet;
    h.updateWorldMatrix(true, false);
    out.copy(eye).applyMatrix4(h.matrixWorld);
    return out.add(vBack.copy(back).applyQuaternion(lean.getWorldQuaternion(qLean)));
  }

  // Cockpit view: no head, torso or upper arms in the way (the camera sits where they
  // are); forearms and gloves stay. The skinned body is one mesh, so its triangles are sorted
  // once per page (torsoSplit), those parts last, and in this view the mesh draws a copy of its
  // geometry (same buffers) that stops before them. Its own shadow would lose them too, so a full-body twin on
  // SHADOW_LAYER, which only the sun's shadow camera sees, casts the shadow instead.
  let cockpitOn = false;
  function cockpit(on) {
    if (on === cockpitOn) return;
    cockpitOn = on;
    riderParts.helmet.visible = !on;
    if (riderParts.torso) riderParts.torso.visible = !on;   // the code-built rider
    if (!skin) return;
    skin.mesh.geometry = on ? skin.cutGeo : skin.fullGeo;
    skin.mesh.castShadow = !on;
    skin.shadow.visible = on;
  }

  // The ghost's bike is decimated by vertex clustering: snap to a GHOST_GRID grid and drop
  // the triangles that collapse. A translucent one-colour ghost can't show the detail.
  function cluster(g) {
    const p = g.attributes.position.array, n = p.length, seen = new Set();
    let m = 0;
    for (let a = 0; a < n; a += 9) {
      const v = [0, 3, 6].map(i => [0, 1, 2].map(d => Math.round(p[a + i + d] / GHOST_GRID)).join());
      const i0 = v.indexOf(v.slice().sort()[0]), key = [0, 1, 2].map(i => v[(i0 + i) % 3]).join('|');   // (winding kept: a plate's two faces differ)
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2] || seen.has(key)) continue;   // collapsed, or a repeat
      seen.add(key);
      for (let k = 0; k < 9; k++) p[m + k] = Math.round(p[a + k] / GHOST_GRID) * GHOST_GRID;
      m += 9;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(p.slice(0, m), 3));
    g.dispose();
    return out;
  }

  // A one-mesh, translucent copy for the ghost of your best run.
  function bakeGhost() {
    const steer0 = steer.rotation.y;                     // the riding pose, bars straight
    steer.rotation.y = 0;
    if (!detached) poseRider(1, 0, false);
    root.updateMatrixWorld(true);
    steer.rotation.y = steer0;
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const geos = [];
    root.traverse(o => {
      if (!o.isMesh || o === dashMesh || o === skin?.shadow || o.material === decalR || o.material === decalL) return;
      let g;
      if (o.isSkinnedMesh) {                              // the body as posed, skinned on the CPU
        const idx = o.geometry.index, n = idx ? idx.count : o.geometry.attributes.position.count, p = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) o.getVertexPosition(idx ? idx.getX(i) : i, v1).toArray(p, i * 3);
        g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      } else g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      if (!o.isSkinnedMesh) g = cluster(g);
      g.computeVertexNormals();
      geos.push(g);
    });
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.computeBoundingSphere();
    return out;
  }

  poseRider(1, 0, false);                        // a sensible pose before the first frame

  // Garage pose: no rider (a clean studio shot), upright, bars turned a touch.
  function idle() {
    rider.visible = false;
    pitchPivot.rotation.z = 0;
    lean.rotation.x = 0;
    lean.position.y = 0;
    steer.rotation.y = 0.18;
    fork.position.y = -rig.forkLen;
    tail.color.setHex(0x8a0d12);
    beam.intensity = 0;
  }

  const sliderWorld = (side, out) => riderParts['slider' + side].getWorldPosition(out);

  return {
    group: root, update, idle, bakeGhost, rider, lean, sliderWorld,
    riderWorld, detach, ragdoll, attach,
    get detached() { return detached; },
    riderHelmet: riderParts.helmet, eyeWorld, cockpit, dash,
    useRider, useBody, useBike,
    // ?test=1: which bike is drawn, and its triangles and meshes (without the rider).
    bikeInfo() {
      let tris = 0, meshes = 0;
      (function walk(o) { for (const c of o.children) if (c !== rider && c !== dashMesh) { if (c.isMesh) { meshes++; tris += (c.geometry.index ? c.geometry.index.count : c.geometry.attributes.position.count) / 3; } walk(c); } })(lean);
      lean.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(lean.matrixWorld).invert(), g = o => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).toArray().map(v => +v.toFixed(4));
      const bn = n => skin && g(skin.mesh.skeleton.getBoneByName(n));      // the body's wrists and balls of the feet
      return { model: r1m ? 'R1M' : 'RS 660', tris, meshes, grips: { L: g(gripL), R: g(gripR) },
        wrists: { L: bn('hand_l'), R: bn('hand_r') }, balls: { L: bn('ball_l'), R: bn('ball_r') }, rig: { rake: +(rig.rake / DEG).toFixed(2), forkLen: +rig.forkLen.toFixed(4), fr: rig.fr, rr: rig.rr, foot: rig.foot.toArray() } };
    },
    // ?test=1: the body, and a few bones' local rotations.
    riderInfo() {
      if (!skin) return { skinned: false };
      const sk = skin.mesh.skeleton, q = n => sk.getBoneByName(n).quaternion.toArray().map(v => +v.toFixed(4));
      return { skinned: true, tris: skin.mesh.geometry.index.count / 3, bones: sk.bones.length,
        joints: Object.fromEntries(JOINTS.map(n => [n, J[n].toArray().map(v => +v.toFixed(3))])),
        q: Object.fromEntries(['pelvis', 'spine_01', 'neck_01', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'upperarm_l', 'upperarm_r'].map(n => [n, q(n)])) };
    },
    dispose() {
      // The rider is under one of the two, whichever it was in at the time.
      for (const g of [root, riderWorld]) g.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      for (const o of bin) o.dispose?.();
      beam.dispose();
    },
  };
}
