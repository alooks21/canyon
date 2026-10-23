// Traffic — cars sharing the canyon road.
//
// Oncoming cars keep to their own lane; slower cars ahead in yours hug the right
// side so you can pass inside your lane. Both slow for corners (≈0.3 g, like a
// careful driver). Passing close scores a near miss; touching one ends your run.
// Rendering: three body styles, each an InstancedMesh pair (tinted body + shared
// details) plus one mesh for every car's lights — nine draw calls in total.

import * as THREE from '../../vendor/three.module.js';
import { DS, mulberry32, hash2 } from './road.js';
import { part, merge, M4 } from './mesh-util.js';

const MAX = 14;
const PAINT = [0xf2f2f2, 0x2b2f36, 0x8a1c1c, 0x2c4b78, 0x9aa1a8, 0x1f1f22, 0x6b7a5a, 0xd7c9a8];

function carGeometry(kind) {
  // returns [bodyGeo (white, tinted per car), detailGeo (fixed colours), lightGeo]
  const L = kind === 'pickup' ? 5.4 : kind === 'suv' ? 4.8 : 4.6;
  const W = kind === 'suv' ? 1.95 : 1.85;
  const bodyH = kind === 'sedan' ? 0.62 : 0.8;
  const cabL = kind === 'pickup' ? 2.0 : kind === 'suv' ? 2.9 : 2.5;
  const cabH = kind === 'sedan' ? 0.55 : 0.72;
  const cabX = kind === 'pickup' ? 0.6 : -0.15;
  const y0 = 0.32;
  const body = [part(new THREE.BoxGeometry(L, bodyH, W), 0xffffff, M4(0, y0 + bodyH / 2, 0))];
  body.push(part(new THREE.BoxGeometry(cabL, cabH, W - 0.12), 0xffffff, M4(cabX, y0 + bodyH + cabH / 2, 0)));
  if (kind === 'pickup') body.push(part(new THREE.BoxGeometry(2.0, 0.35, W), 0xffffff, M4(-1.6, y0 + bodyH + 0.17, 0)));
  const det = [];
  // glass band around the cabin
  det.push(part(new THREE.BoxGeometry(cabL + 0.02, cabH * 0.62, W - 0.08), 0x16191e, M4(cabX, y0 + bodyH + cabH * 0.48, 0)));
  // wheels
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    det.push(part(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12), 0x121212, M4(sx * (L / 2 - 0.85), 0.34, sz * (W / 2 - 0.05), Math.PI / 2, 0, 0)));
  }
  // bumpers
  det.push(part(new THREE.BoxGeometry(0.12, 0.18, W - 0.1), 0x24262a, M4(L / 2, y0 + 0.12, 0)));
  det.push(part(new THREE.BoxGeometry(0.12, 0.18, W - 0.1), 0x24262a, M4(-L / 2, y0 + 0.12, 0)));
  const lit = [];
  for (const sz of [1, -1]) {
    lit.push(part(new THREE.BoxGeometry(0.06, 0.12, 0.34), 0xfff4d6, M4(L / 2 + 0.02, y0 + bodyH - 0.14, sz * (W / 2 - 0.3))));
    lit.push(part(new THREE.BoxGeometry(0.06, 0.12, 0.3), 0xff1d24, M4(-L / 2 - 0.02, y0 + bodyH - 0.12, sz * (W / 2 - 0.25))));
  }
  return [merge(body), merge(det), merge(lit), L, W];
}

export function createTraffic(scene, course, { density = 0.7, seed = 1 } = {}) {
  const road = course.road;
  const kinds = ['sedan', 'suv', 'pickup'];
  const bin = [];
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const detMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const litMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  bin.push(bodyMat, detMat, litMat);
  const meshes = kinds.map(k => {
    const [b, d, l, L, W] = carGeometry(k);
    bin.push(b, d, l);
    const mk = (geo, mat, colored) => {
      const m = new THREE.InstancedMesh(geo, mat, MAX);
      m.count = 0;
      m.frustumCulled = false;
      if (colored) m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      return m;
    };
    return { body: mk(b, bodyMat, true), det: mk(d, detMat, false), lit: mk(l, litMat, false), L, W };
  });

  const rand = mulberry32(hash2(seed, 31337));
  const cars = [];
  const q = {};
  let nextAhead = course.startS + 380;      // next same-direction car spawn point
  let nextOncoming = course.startS + 700;

  // Comfortable cornering speed for a car at sample i (≈0.3 g), capped at cruise.
  const cornerSpeed = (i, cruise) => {
    let k = 0;
    for (let d = 0; d <= 30; d += 5) k = Math.max(k, Math.abs(road.kappa[Math.min(road.n - 1, i + d)]));
    return Math.min(cruise, Math.sqrt(0.3 * 9.81 / Math.max(k, 1e-4)));
  };

  function spawn(s, dir) {
    const kind = Math.floor(rand() * 3);
    cars.push({
      s, dir, kind,
      lane: dir > 0 ? 2.15 : -1.75,               // same-direction cars hug the right
      cruise: (dir > 0 ? 18 : 21) + rand() * 6,   // m/s ≈ 40–60 mph
      v: 18, color: PAINT[Math.floor(rand() * PAINT.length)],
      passed: false, near: Infinity,
    });
  }

  function update(dt, bike, events) {
    const end = course.endless ? Infinity : course.length - 120;
    // spawn ahead of the rider
    const gap = 1 / Math.max(0.05, density);
    while (nextAhead < bike.s + 900 && nextAhead < end) {
      spawn(nextAhead, +1);
      nextAhead += (500 + rand() * 900) * gap;
    }
    while (nextOncoming < bike.s + 1100 && nextOncoming < end + 200) {
      spawn(nextOncoming, -1);
      nextOncoming += (380 + rand() * 700) * gap;
    }
    // move, cull, check
    for (let k = cars.length - 1; k >= 0; k--) {
      const c = cars[k];
      const i = Math.max(0, Math.min(road.n - 2, Math.floor(c.s / DS)));
      const target = cornerSpeed(c.dir > 0 ? i : Math.max(0, i - 30), c.cruise);
      c.v += Math.max(-4, Math.min(2, target - c.v)) * dt;
      c.s += c.dir * c.v * dt;
      if (c.s < bike.s - 260 || c.s > bike.s + 1300 || c.s < 5 || c.s > road.length - 5) { cars.splice(k, 1); continue; }
      if (bike.crashed) continue;
      const m = meshes[c.kind];
      const ds = c.s - bike.s, dd = c.lane - bike.d;
      // collision (road-aligned boxes: car L×W, bike ~2 m × 0.8 m)
      if (Math.abs(ds) < m.L / 2 + 1.0 && Math.abs(dd) < m.W / 2 + 0.4) { events.hit = true; return; }
      // near miss: scored once, the moment you pass it, by how close you were
      if (Math.abs(ds) < m.L / 2 + 1.5) c.near = Math.min(c.near, Math.abs(dd) - m.W / 2 - 0.4);
      if (!c.passed && ((c.dir > 0 && ds < -m.L / 2 - 1) || (c.dir < 0 && ds < -m.L / 2 - 1))) {
        c.passed = true;
        if (c.near < 1.1) events.nearMiss.push({ gap: Math.max(0, c.near), closing: Math.abs(bike.v - c.dir * c.v) });
      }
    }
  }

  const mtx = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1);
  const eul = new THREE.Euler(0, 0, 0, 'YZX'), col = new THREE.Color();
  function render() {
    const n = [0, 0, 0];
    for (const c of cars) {
      const m = meshes[c.kind], k = n[c.kind]++;
      if (k >= MAX) continue;
      road.at(c.s, q);
      pos.set(q.x - Math.sin(q.psi) * c.lane, q.y - c.lane * Math.tan(q.bank), q.z + Math.cos(q.psi) * c.lane);
      eul.set(0, -(q.psi + (c.dir < 0 ? Math.PI : 0)), Math.atan(q.grade) * c.dir);
      quat.setFromEuler(eul);
      mtx.compose(pos, quat, scl);
      m.body.setMatrixAt(k, mtx); m.det.setMatrixAt(k, mtx); m.lit.setMatrixAt(k, mtx);
      m.body.setColorAt(k, col.setHex(c.color));
    }
    meshes.forEach((m, i) => {
      const cnt = Math.min(MAX, n[i]);
      for (const im of [m.body, m.det, m.lit]) { im.count = cnt; im.instanceMatrix.needsUpdate = true; }
      if (m.body.instanceColor) m.body.instanceColor.needsUpdate = true;
    });
  }

  return {
    update, render,
    get cars() { return cars; },
    // Ride to my music: busier roads for faster songs (applies to cars not yet spawned).
    setDensity(d) { density = d; },
    dots(out) {
      for (const c of cars) { road.at(c.s, q); out.push({ x: q.x - Math.sin(q.psi) * c.lane, z: q.z + Math.cos(q.psi) * c.lane, color: c.dir > 0 ? '#5ac8fa' : '#ffcf4a', r: 4 }); }
      return out;
    },
    reset(s) {
      cars.length = 0;
      nextAhead = s + 380; nextOncoming = s + 700;
    },
    clearNear(s) { for (let k = cars.length - 1; k >= 0; k--) if (Math.abs(cars[k].s - s) < 60) cars.splice(k, 1); },
    destroy() {
      for (const m of meshes) for (const im of [m.body, m.det, m.lit]) { scene.remove(im); im.dispose(); }
      for (const o of bin) o.dispose();
    },
  };
}
