// Small geometry helpers shared by the bike and the traffic: colour a primitive,
// place it, and merge many into one draw call.

import * as THREE from '../../vendor/three.module.js';

// Colour a whole geometry (non-indexed copy) and optionally transform it.
export function part(geo, color, matrix) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (matrix) g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) {
    const c = new THREE.Color(color);
    const a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  if (geo !== g) geo.dispose();
  return g;
}

// Merge coloured parts into one geometry (position, normal, color).
export function merge(parts) {
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

export const M4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')), new THREE.Vector3(sx, sy, sz));

// A box along the line a→b, w wide (z) and h tall.
export function bar(a, b, w, h, color) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const g = new THREE.BoxGeometry(len, h, w);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
  const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return part(g, color, m);
}

// A cylinder from a to b with radius r.
export function rod(a, b, r, color, seg = 10) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
  const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return part(g, color, m);
}

// bar() with rounded long edges: a rounded-rectangle section (w across, h tall), radius r.
export function rbar(a, b, w, h, color, r = Math.min(w, h) * 0.3) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz), x = w / 2 - r, y = h / 2 - r, s = new THREE.Shape();
  s.absarc(x, y, r, 0, Math.PI / 2); s.absarc(-x, y, r, Math.PI / 2, Math.PI);
  s.absarc(-x, -y, r, Math.PI, Math.PI * 1.5); s.absarc(x, -y, r, Math.PI * 1.5, Math.PI * 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 2 });
  g.translate(0, 0, -len / 2).rotateY(Math.PI / 2);           // length along x, as bar()'s box
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
  const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return part(g, color, m);
}
