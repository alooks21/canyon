// World — everything you see except the bike: sky, light, land, road, signs, props.
//
// All of it is generated from the course's numbers. Props, guardrails and sign posts use
// Kenney kit models when assets.js loaded them (opts.kit), procedural stand-ins otherwise.
// The rules that keep it fast on integrated graphics:
//   * Meshes are built in LOCAL coordinates and positioned by their origin, so
//     floating-point precision holds even 100 km into an Endless ride.
//   * One draw call per terrain tile and per 200 m road chunk; props are a handful
//     of InstancedMeshes shared by every tile; only the bike casts shadows.
//   * At most one terrain tile is generated per frame, nearest first.
//   * Everything allocated here is registered in `bin` and freed in destroy() —
//     GPU memory is not garbage collected.

import * as THREE from '../../vendor/three.module.js';
import { DS, makeNoise2D, mulberry32, hash2 } from './road.js';
import { TILE, GRID, CELL, VERGE, placeProps, tunnelCrest } from './terrain.js';
import { BIOMES, TOD } from './stages.js';

const CHUNK = 100;                // road samples per mesh (200 m)
const AHEAD = 1200, BEHIND = 260; // road mesh range around the rider, metres
const MPH = 2.23694;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

// Road cross-section is mapped across u: dirt skirt | gravel shoulder | asphalt |
// gravel shoulder | dirt skirt. Lines are painted where US canyon roads have them:
// solid white edge lines and a double-yellow centre line.
export const ROAD_U = [0, 0.02, 0.12, 0.88, 0.98, 1];

function makeRoadTexture(aniso) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = mulberry32(99);
  const px = u => Math.round(u * W);

  // dirt skirt + gravel shoulders
  g.fillStyle = '#6b5a47'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#7b7064';
  g.fillRect(px(0.02), 0, px(0.10), H);
  g.fillRect(px(0.88), 0, px(0.10), H);
  for (let k = 0; k < 9000; k++) {
    const u = r() < 0.5 ? 0.02 + r() * 0.1 : 0.88 + r() * 0.1;
    const l = 70 + r() * 80;
    g.fillStyle = `rgb(${l + 12},${l + 4},${l - 6})`;
    g.fillRect(px(u), r() * H, 2 + r() * 3, 2 + r() * 3);
  }

  // asphalt: aged grey (~12% albedo), aggregate speckle, wheel-track polish per lane
  g.fillStyle = '#5a5a5a';
  g.fillRect(px(0.12), 0, px(0.76), H);
  for (let k = 0; k < 26000; k++) {
    const l = 52 + r() * 60;
    g.fillStyle = `rgba(${l},${l},${l + 3},${0.35 + r() * 0.4})`;
    g.fillRect(px(0.12 + r() * 0.76), r() * H, 1 + r() * 2, 1 + r() * 2);
  }
  for (const u of [0.24, 0.38, 0.62, 0.76]) {
    const grad = g.createLinearGradient(px(u - 0.04), 0, px(u + 0.04), 0);
    grad.addColorStop(0, 'rgba(20,20,22,0)');
    grad.addColorStop(0.5, 'rgba(20,20,22,0.22)');
    grad.addColorStop(1, 'rgba(20,20,22,0)');
    g.fillStyle = grad;
    g.fillRect(px(u - 0.04), 0, px(0.08), H);
  }

  // lines — a metre of asphalt is ≈ 0.1056 of u, so 10 cm ≈ 0.0106
  const line = (u0, u1, col) => {
    g.fillStyle = col;
    g.fillRect(px(u0), 0, Math.max(2, px(u1) - px(u0)), H);
    // worn paint: knock a few holes so it doesn't look printed
    for (let k = 0; k < 60; k++) {
      g.fillStyle = 'rgba(58,60,63,0.55)';
      g.fillRect(px(u0 + r() * (u1 - u0)), r() * H, 2, 2 + r() * 4);
    }
  };
  line(0.126, 0.139, '#e9e9e2');
  line(0.861, 0.874, '#e9e9e2');
  line(0.4842, 0.4948, '#e8b923');
  line(0.5052, 0.5158, '#e8b923');

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

// Sign atlas: 8×8 cells of 128 px. Cells: 0 grey (posts), 1 yellow (markers),
// 2/3 curve L/R, 4/5 hairpin L/R, 6/7 chevron L/R, 8.. advisory speed plates.
const SPEEDS = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65];
function cellUV(c) {
  const col = c % 8, row = Math.floor(c / 8);
  return [col / 8, 1 - (row + 1) / 8, (col + 1) / 8, 1 - row / 8];
}
const GREY_UV = [1 / 16, 1 - 1 / 16];     // middle of cell 0, for kit posts

function makeSignAtlas(aniso) {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S * 8;
  const g = c.getContext('2d');
  const at = k => [(k % 8) * S, Math.floor(k / 8) * S];
  const YEL = '#f2c230', BLK = '#121212';

  let [x, y] = at(0); g.fillStyle = '#8d9398'; g.fillRect(x, y, S, S);
  [x, y] = at(1); g.fillStyle = '#ffd23a'; g.fillRect(x, y, S, S);

  const diamond = (k, draw) => {
    const [ox, oy] = at(k);
    g.save();
    g.translate(ox + S / 2, oy + S / 2);
    g.rotate(Math.PI / 4);
    g.fillStyle = BLK; g.fillRect(-44, -44, 88, 88);
    g.fillStyle = YEL; g.fillRect(-40, -40, 80, 80);
    g.restore();
    g.save();
    g.translate(ox + S / 2, oy + S / 2);
    g.strokeStyle = BLK; g.fillStyle = BLK; g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
    draw(g);
    g.restore();
  };
  // curve arrows (drawn for a right curve, mirrored for left)
  const curve = m => g2 => {
    g2.scale(m, 1);
    g2.beginPath(); g2.moveTo(-12, 34); g2.lineTo(-12, 0); g2.quadraticCurveTo(-12, -22, 12, -24); g2.stroke();
    g2.beginPath(); g2.moveTo(10, -40); g2.lineTo(28, -24); g2.lineTo(10, -8); g2.closePath(); g2.fill();
  };
  const hairpin = m => g2 => {
    g2.scale(m, 1);
    g2.beginPath(); g2.moveTo(-16, 34); g2.lineTo(-16, -8); g2.arc(4, -8, 20, Math.PI, 0); g2.lineTo(24, 14); g2.stroke();
    g2.beginPath(); g2.moveTo(10, 10); g2.lineTo(24, 32); g2.lineTo(38, 10); g2.closePath(); g2.fill();
  };
  diamond(2, curve(-1)); diamond(3, curve(1));
  diamond(4, hairpin(-1)); diamond(5, hairpin(1));

  const chevron = (k, m) => {
    const [ox, oy] = at(k);
    g.fillStyle = YEL; g.fillRect(ox + 14, oy + 4, S - 28, S - 8);
    g.save(); g.translate(ox + S / 2, oy + S / 2); g.scale(m, 1);
    g.fillStyle = BLK;
    g.beginPath(); g.moveTo(-26, -44); g.lineTo(6, 0); g.lineTo(-26, 44); g.lineTo(-6, 44); g.lineTo(26, 0); g.lineTo(-6, -44); g.closePath(); g.fill();
    g.restore();
  };
  chevron(6, -1); chevron(7, 1);

  SPEEDS.forEach((mph, n) => {
    const [ox, oy] = at(8 + n);
    g.fillStyle = BLK; g.fillRect(ox + 10, oy + 18, S - 20, S - 36);
    g.fillStyle = YEL; g.fillRect(ox + 14, oy + 22, S - 28, S - 44);
    g.fillStyle = BLK; g.textAlign = 'center';
    g.font = 'bold 44px Arial, Helvetica, sans-serif'; g.fillText(String(mph), ox + S / 2, oy + 66);
    g.font = 'bold 20px Arial, Helvetica, sans-serif'; g.fillText('MPH', ox + S / 2, oy + 90);
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

// Gantry banners — one row per label.
function makeBannerTexture(labels) {
  const W = 1024, Hrow = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = Hrow * labels.length;
  const g = c.getContext('2d');
  labels.forEach((label, i) => {
    const y = i * Hrow;
    g.fillStyle = '#111214'; g.fillRect(0, y, W, Hrow);
    const flag = label === 'START' || label === 'FINISH';
    if (flag) {
      for (let cx = 0; cx < 8; cx++) for (let cy = 0; cy < 4; cy++) {
        g.fillStyle = (cx + cy) % 2 ? '#f2f2f2' : '#111214';
        g.fillRect(cx * 16, y + cy * 32, 16, 32);
        g.fillRect(W - 128 + cx * 16, y + cy * 32, 16, 32);
      }
    }
    g.fillStyle = '#d1202f'; g.fillRect(flag ? 128 : 0, y + Hrow - 12, flag ? W - 256 : W, 12);
    g.fillStyle = '#f4f4f4';
    g.font = 'italic bold 70px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, W / 2, y + Hrow / 2 - 4);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Growable flat arrays → one BufferGeometry. Used for rails, signs, gantries and the
// Endless features. With `colors`, every triangle takes the colour set by color().
const UNIT_UV = [0, 0, 1, 1];
class Mesher {
  constructor(uvs = true, colors = false) {
    this.p = []; this.n = []; this.u = uvs ? [] : null; this.c = colors ? [] : null;
    this.col = [1, 1, 1];
  }
  color(hex, k = 1) { _c.setHex(hex); this.col = [_c.r * k, _c.g * k, _c.b * k]; return this; }
  tri(a, b, c, na, uva, uvb, uvc) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(na[0], na[1], na[2], na[0], na[1], na[2], na[0], na[1], na[2]);
    if (this.u) this.u.push(uva[0], uva[1], uvb[0], uvb[1], uvc[0], uvc[1]);
    if (this.c) { const k = this.col; this.c.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]); }
  }
  // Quad a-b-c-d (counter-clockwise seen from the front: bottom-left, bottom-right,
  // top-right, top-left), uv rect [u0, v0, u1, v1] mapped the same way round.
  quad(a, b, c, d, uv) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1, n = [nx / l, ny / l, nz / l];
    const [u0, v0, u1, v1] = uv || UNIT_UV;
    this.tri(a, b, c, n, [u0, v0], [u1, v0], [u1, v1]);
    this.tri(a, c, d, n, [u0, v0], [u1, v1], [u0, v1]);
  }
  // Axis box around a centre, rotated by yaw about y.
  box(cx, cy, cz, sx, sy, sz, yaw, uv) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (x, y, z) => [cx + x * c - z * s, cy + y, cz + x * s + z * c];
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz),
               P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    this.quad(v[4], v[5], v[6], v[7], uv); this.quad(v[1], v[0], v[3], v[2], uv);
    this.quad(v[5], v[1], v[2], v[6], uv); this.quad(v[0], v[4], v[7], v[3], uv);
    this.quad(v[7], v[6], v[2], v[3], uv); this.quad(v[0], v[1], v[5], v[4], uv);
  }
  // A kit model (non-indexed) transformed by matrix m. Every vertex samples uv (a flat
  // atlas cell) and, with colours on, keeps the model's own colour. Face normals come from
  // the transformed triangle, so stretched pieces still light correctly.
  add(geo, m, uv = null) {
    const p = geo.attributes.position, col = geo.attributes.color;
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) _tv[k].fromBufferAttribute(p, i + k).applyMatrix4(m);
      _e1.subVectors(_tv[1], _tv[0]).cross(_e2.subVectors(_tv[2], _tv[0])).normalize();
      for (let k = 0; k < 3; k++) {
        this.p.push(_tv[k].x, _tv[k].y, _tv[k].z);
        this.n.push(_e1.x, _e1.y, _e1.z);
        if (this.u) this.u.push(uv[0], uv[1]);
        if (this.c) this.c.push(col.getX(i + k), col.getY(i + k), col.getZ(i + k));
      }
    }
  }
  get empty() { return this.p.length === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    if (this.u) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}
const _c = new THREE.Color();
const _tv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
// Scratch for placing kit pieces in road chunks.
const _km = new THREE.Matrix4(), _kv = new THREE.Vector3(), _ks = new THREE.Vector3(), _kq = new THREE.Quaternion(), _ky = new THREE.Vector3(0, 1, 0);

// Merge transformed primitive parts into one non-indexed, vertex-coloured geometry.
// Our own 25-line merge: BufferGeometryUtils isn't in the vendored core build.
function mergeParts(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  for (const { geo, color, matrix } of parts) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    if (matrix) g.applyMatrix4(matrix);
    g.computeVertexNormals();
    c.setHex(color);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nor.push(n[i], n[i + 1], n[i + 2]);
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// Lumpy rock: an icosahedron with every vertex pushed in or out by a hash of its
// position, so coincident vertices move together and the shape stays closed.
function rockGeo(seed, detail = 0) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = hash2(Math.round(x * 1000) + seed, Math.round(y * 1000) * 7 + Math.round(z * 1000)) / 4294967296;
    const k = 0.78 + h * 0.45;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  return g;
}

// Low-poly vegetation and rocks. Single-material props are white (tinted per
// instance); trees carry their own trunk/foliage colours.
function propGeometry(type) {
  switch (type) {
    case 'boulder':
      return mergeParts([{ geo: rockGeo(3, 0), color: 0xffffff, matrix: M(0, 0.25, 0, 1.3, 0.8, 1.05) }]);
    case 'shrub':
      return mergeParts([
        { geo: rockGeo(5, 0), color: 0xffffff, matrix: M(0, 0.45, 0, 0.85, 0.6, 0.8) },
        { geo: rockGeo(6, 0), color: 0xe8e8e8, matrix: M(0.5, 0.35, 0.2, 0.6, 0.48, 0.55) },
        { geo: rockGeo(7, 0), color: 0xf2f2f2, matrix: M(-0.4, 0.3, -0.3, 0.55, 0.42, 0.6) },
      ]);
    case 'pine':
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.16, 0.28, 2.4, 5), color: 0x5a4231, matrix: M(0, 1.2, 0) },
        { geo: new THREE.ConeGeometry(2.0, 3.2, 7), color: 0x2f4c2d, matrix: M(0, 3.1, 0) },
        { geo: new THREE.ConeGeometry(1.6, 2.8, 7), color: 0x355632, matrix: M(0, 4.6, 0, 1, 1, 1, 0, 0.4, 0) },
        { geo: new THREE.ConeGeometry(1.1, 2.4, 6), color: 0x3b5d36, matrix: M(0, 6.0, 0, 1, 1, 1, 0, 0.9, 0) },
      ]);
    case 'juniper':
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.12, 0.2, 1.2, 5), color: 0x5e4a38, matrix: M(0, 0.6, 0, 1, 1, 1, 0.1, 0, 0.12) },
        { geo: rockGeo(11, 0), color: 0x66743f, matrix: M(0.1, 1.7, 0, 1.2, 0.95, 1.1) },
        { geo: rockGeo(12, 0), color: 0x5d6a39, matrix: M(-0.5, 1.3, 0.3, 0.8, 0.7, 0.8) },
      ]);
    case 'joshua':
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.2, 0.28, 2.6, 6), color: 0x6b5a46, matrix: M(0, 1.3, 0) },
        { geo: new THREE.CylinderGeometry(0.13, 0.16, 1.5, 5), color: 0x6b5a46, matrix: M(0.45, 2.8, 0, 1, 1, 1, 0, 0, -0.6) },
        { geo: new THREE.CylinderGeometry(0.12, 0.15, 1.3, 5), color: 0x6b5a46, matrix: M(-0.4, 2.6, 0.2, 1, 1, 1, 0.2, 0, 0.7) },
        { geo: new THREE.IcosahedronGeometry(0.5, 0), color: 0x5b6b3a, matrix: M(0.9, 3.5, 0, 1, 1.2, 1) },
        { geo: new THREE.IcosahedronGeometry(0.45, 0), color: 0x56653a, matrix: M(-0.85, 3.2, 0.35, 1, 1.2, 1) },
        { geo: new THREE.IcosahedronGeometry(0.5, 0), color: 0x5f703c, matrix: M(0, 2.9, 0, 1, 1.2, 1) },
      ]);
    case 'oak':
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.25, 0.4, 2.6, 6), color: 0x4f3f30, matrix: M(0, 1.3, 0) },
        { geo: rockGeo(21, 0), color: 0x4f6235, matrix: M(0, 3.5, 0, 2.6, 1.6, 2.4) },
        { geo: rockGeo(22, 0), color: 0x56693a, matrix: M(1.2, 3.1, 0.6, 1.6, 1.1, 1.5) },
      ]);
    case 'cypress':
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.18, 0.3, 3.2, 5), color: 0x4a3a2c, matrix: M(0.3, 1.5, 0, 1, 1, 1, 0, 0, -0.18) },
        { geo: rockGeo(31, 0), color: 0x34502f, matrix: M(0.8, 3.6, 0, 2.8, 0.9, 2.2) },
        { geo: rockGeo(32, 0), color: 0x2e482b, matrix: M(-0.4, 3.0, 0.4, 2.0, 0.75, 1.7) },
      ]);
  }
  throw new Error(`unknown prop ${type}`);
}
const PROP_CAP = { boulder: 2200, shrub: 3200, pine: 3200, juniper: 1200, joshua: 900, oak: 900, cypress: 900 };
const TINTED = new Set(['boulder', 'shrub']);
// With kit models, boulders come in three shapes picked by the size placeProps already
// chose: small, mid, and a rock spire for the biggest. Same places, same count.
const BOULDER_KIT = ['boulder2', 'boulder3'];
const boulderShape = s => (s < 1.1 ? 'boulder' : s < 1.9 ? 'boulder2' : 'boulder3');

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;            // pinned to the far plane
}`;
const SKY_FRAG = `
uniform vec3 uZenith, uHorizon, uSunColor, uSunDir;
uniform float uStars, uSunSize;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.25, h));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, uSunSize) * 5.0 + pow(sd, 24.0) * 0.28 + pow(sd, 4.0) * 0.07);
  if (uStars > 0.0) {
    vec3 cell = floor(d * 380.0);
    float n = hash(cell);
    col += vec3(step(0.9982, n) * uStars * smoothstep(0.02, 0.25, h) * (0.6 + 0.4 * hash(cell + 3.1)));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
// Ocean (coast biome)
// ---------------------------------------------------------------------------

const OCEAN_VERT = `
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const OCEAN_FRAG = `
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uDeep, uSky, uSunDir, uSunColor;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz * 0.045;
  float t = uTime;
  float nx = sin(p.x * 3.1 + t * 0.9) * 0.5 + sin(p.y * 4.7 - t * 1.3) * 0.3 + sin((p.x + p.y) * 9.0 + t * 2.1) * 0.15;
  float nz = cos(p.y * 3.7 - t * 0.7) * 0.5 + cos(p.x * 5.3 + t * 1.1) * 0.3 + cos((p.x - p.y) * 8.0 - t * 1.9) * 0.15;
  vec3 n = normalize(vec3(nx * 0.09, 1.0, nz * 0.09));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 col = mix(uDeep, uSky, 0.12 + 0.7 * fres);
  vec3 hv = normalize(v + uSunDir);
  col += uSunColor * pow(max(dot(n, hv), 0.0), 240.0) * 2.5;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------------------
// Rain (Endless weather): streaks animated entirely on the GPU. Each drop lives in a
// 40 × 24 × 40 m box that wraps around the camera, so the rain stays put in the world
// (you ride through it) while costing no per-frame work on the CPU.
// ---------------------------------------------------------------------------

const RAIN_N = 1800;
const RAIN_VERT = `
attribute vec2 aEnd;               // x: 0 head / 1 tail of the streak; y: drop's random id
uniform vec3 uCam;
uniform float uTime, uAmount;
uniform vec2 uWind;
varying float vA;
void main() {
  vec3 B = vec3(40.0, 24.0, 40.0);
  vec3 p = position * B;
  p.y = mod(p.y - uTime * 13.0, B.y);
  vec3 rel = mod(p - uCam + 0.5 * B, B) - 0.5 * B;
  vec3 w = uCam + rel + vec3(uWind.x, -1.0, uWind.y) * 0.7 * aEnd.x;
  vA = step(aEnd.y, uAmount) * (1.0 - smoothstep(9.0, 20.0, length(rel.xz)));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const RAIN_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  if (vA < 0.01) discard;
  gl_FragColor = vec4(uColor, 0.38 * vA);
  #include <colorspace_fragment>
}`;

// Town buildings: colours by look family.
const TOWN_WALLS = {
  desert: [0xd2a679, 0xc28b5c, 0xe3cfa8, 0xb56f4e, 0xd9b48a],
  other: [0xe9e4da, 0xc9c3b4, 0x8e5c45, 0x6d8798, 0xb9a77f, 0x9c3f35, 0x5f6f58],
};
const TOWN_ROOFS = { desert: [0x8c4a32, 0x7a6450], other: [0x4a4d52, 0x6b3a2e, 0x3f4a3a, 0x56504a] };

function makeTownSign(name, pop) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 224;
  const g = c.getContext('2d');
  g.fillStyle = '#1d6b3c'; g.fillRect(0, 0, 512, 224);
  g.strokeStyle = '#f2f2f2'; g.lineWidth = 8; g.strokeRect(12, 12, 488, 200);
  g.fillStyle = '#f4f4f4'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 64px Arial, Helvetica, sans-serif';
  g.fillText(name.toUpperCase(), 256, 92, 460);
  g.font = 'bold 38px Arial, Helvetica, sans-serif';
  g.fillText(`POP. ${pop.toLocaleString('en-US')}`, 256, 168);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export function createWorld(scene, renderer, course, opts = {}) {
  const bin = [];
  const own = o => { bin.push(o); return o; };
  const road = course.road;
  let quality = opts.quality || 'high';
  const tileRadius = () => (quality === 'high' ? 560 : 430);

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const roadTex = own(makeRoadTexture(aniso));
  const signTex = own(makeSignAtlas(aniso));
  // Vertex colours on the road only darken it inside tunnels (white elsewhere).
  const roadMat = own(new THREE.MeshLambertMaterial({ map: roadTex, vertexColors: true }));
  const terrainMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const railMat = own(new THREE.MeshLambertMaterial({ color: 0xaab1b6, side: THREE.DoubleSide }));
  const signMat = own(new THREE.MeshLambertMaterial({
    map: signTex, alphaTest: 0.5, side: THREE.DoubleSide,
    emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0,
  }));
  const propMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  // Endless features. The tunnel lining is unlit (its colours are baked: lamplight
  // inside, daylight spilling in at the portals), so it reads the same from outside.
  const tubeMat = own(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const lampMat = own(new THREE.MeshBasicMaterial({ color: 0xffe2b0 }));
  // Daylight glare in a portal seen from inside (the eye adjusted to the dark).
  const glareMat = own(new THREE.MeshBasicMaterial({
    color: 0xfff1dc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
  }));
  const concreteMat = own(new THREE.MeshLambertMaterial({ color: 0xa8a398, side: THREE.DoubleSide }));
  const buildMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  // Windows and street lamps: dark glass by day, lit at night.
  const glowMat = own(new THREE.MeshLambertMaterial({ color: 0x2f353d, emissive: 0xffcf86, emissiveIntensity: 0 }));
  const townSignMats = new Set();

  // ---------- rain ----------
  const rainGeo = own(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(RAIN_N * 6), end = new Float32Array(RAIN_N * 4);
    for (let i = 0; i < RAIN_N; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), id = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      end.set([0, id, 1, id], i * 4);
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 2));
  }
  const rainUniforms = {
    uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uAmount: { value: 0 },
    uWind: { value: new THREE.Vector2(0.5, 0.25) }, uColor: { value: new THREE.Color(0xa9b6c4) },
  };
  const rainMat = own(new THREE.ShaderMaterial({
    uniforms: rainUniforms, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
    transparent: true, depthWrite: false, fog: false,
  }));
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  // ---------- sky, sun, fog ----------
  const skyUniforms = {
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uStars: { value: 0 }, uSunSize: { value: 900 },
  };
  const skyGeo = own(new THREE.SphereGeometry(1000, 32, 16));
  const skyMat = own(new THREE.ShaderMaterial({
    uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, fog: false,
  }));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -9; sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9; sun.shadow.camera.bottom = -9;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
  scene.fog = new THREE.Fog(0xffffff, 100, 1000);
  const sunDir = new THREE.Vector3(0, 1, 0);

  // ---------- far ridges: silhouettes beyond the fog ----------
  const RIDGE_SEG = 180;
  const ridgeNoise = makeNoise2D(hash2(course.def.seed, 55));
  const ridgeGeo = own(new THREE.BufferGeometry());
  {
    const pos = [], idx = [];
    for (const [ring, R, base, amp] of [[0, 1550, 60, 240], [1, 1850, 120, 380]]) {
      const off = ring * (RIDGE_SEG + 1) * 2;
      for (let k = 0; k <= RIDGE_SEG; k++) {
        const a = (k / RIDGE_SEG) * Math.PI * 2;
        const h = base + amp * (0.5 + ridgeNoise(Math.cos(a) * 2.2 + ring * 9, Math.sin(a) * 2.2)
          + 0.35 * ridgeNoise(Math.cos(a) * 7 + ring * 4, Math.sin(a) * 7));
        pos.push(Math.cos(a) * R, -120, Math.sin(a) * R, Math.cos(a) * R, h, Math.sin(a) * R);
        if (k < RIDGE_SEG) {
          const b = off + k * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }
    ridgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ridgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    ridgeGeo.setIndex(idx);
  }
  const ridgeMat = own(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  const ridges = new THREE.Mesh(ridgeGeo, ridgeMat);
  ridges.frustumCulled = false;
  ridges.renderOrder = -5;
  scene.add(ridges);
  let ridgeY = road.y[0];

  // ---------- ocean ----------
  const oceanUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uDeep: { value: new THREE.Color(0x0d3b57) }, uSky: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
  }]);
  const oceanGeo = own(new THREE.PlaneGeometry(7000, 7000, 1, 1));
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanMat = own(new THREE.ShaderMaterial({
    uniforms: oceanUniforms, vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG, fog: true,
  }));
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  ocean.frustumCulled = false;
  ocean.visible = false;
  scene.add(ocean);

  // ---------- environment (time of day) ----------
  const cA = new THREE.Color(), cB = new THREE.Color();
  const mixHex = (a, b, t, out) => out.setHex(a).lerp(cB.setHex(b), t);
  const env = { key: '', night: 0, headlight: false, exposure: 1, fogColor: new THREE.Color(), rain: 0, tunnel: 0 };
  const envMapGen = new THREE.PMREMGenerator(renderer);
  let envRT = null, envKey = '', oceanY = 0;
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeo, skyMat);
  envScene.add(envSky);
  const grey = (c, k) => { const l = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * k; return cB.setRGB(l, l, l); };
  const SODIUM = new THREE.Color(0xffb36b), SODIUM_LOW = new THREE.Color(0x2e241a), TUNNEL_HAZE = new THREE.Color(0x4a3f33);

  // mods (Endless): { rain, fog, overcast } weather 0..1, tunnel (how far inside one,
  // 0..1) and seaY (the region's sea level, or null).
  function setEnvironment(todMix, biomeMix, mods = null) {
    const A = TOD[todMix.a], B = TOD[todMix.b], t = todMix.t;
    const L = (k) => A[k] + (B[k] - A[k]) * t;
    const rn = mods ? mods.rain : 0, fg = mods ? mods.fog : 0, tk = mods ? mods.tunnel : 0;
    const oc = mods ? Math.max(mods.overcast, rn) : 0;
    const seaY = mods ? mods.seaY : biomeMix.a.seaY;
    const key = `${todMix.a}|${todMix.b}|${t.toFixed(2)}|${biomeMix.a.key}|${biomeMix.b.key}|${rn.toFixed(2)}|${fg.toFixed(2)}|${oc.toFixed(2)}|${tk.toFixed(2)}|${seaY}`;
    if (key === env.key) return;
    env.key = key;

    mixHex(A.zenith, B.zenith, t, skyUniforms.uZenith.value);
    mixHex(A.horizon, B.horizon, t, skyUniforms.uHorizon.value);
    mixHex(A.sunColor, B.sunColor, t, skyUniforms.uSunColor.value);
    skyUniforms.uStars.value = L('stars');
    if (oc > 0) {
      // Cloud: a flat grey sky, no sun disc, no stars.
      const zc = skyUniforms.uZenith.value, hc = skyUniforms.uHorizon.value;
      zc.lerp(grey(zc, 1.25), 0.8 * oc);
      hc.lerp(grey(hc, 0.95), 0.75 * oc);
      skyUniforms.uSunColor.value.multiplyScalar(1 - 0.95 * oc);
      skyUniforms.uStars.value *= 1 - oc;
    }
    const night = (A.headlight ? 1 - t : 0) + (B.headlight ? t : 0);
    skyUniforms.uSunSize.value = night > 0.5 ? 2600 : 900;     // the moon is smaller

    const elev = A.sun[0] + (B.sun[0] - A.sun[0]) * t;
    const az = A.sun[1] + (B.sun[1] - A.sun[1]) * t;
    const e = elev * Math.PI / 180, a = az * Math.PI / 180;
    sunDir.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
    skyUniforms.uSunDir.value.copy(sunDir);

    mixHex(A.sunColor, B.sunColor, t, sun.color);
    // Cloud dims the sun; a tunnel all but removes it and swaps the sky light for
    // sodium lamps.
    sun.intensity = L('sunI') * (1 - 0.62 * oc) * (1 - 0.93 * tk);
    mixHex(A.hemiSky, B.hemiSky, t, hemi.color);
    mixHex(A.hemiGround, B.hemiGround, t, hemi.groundColor);
    hemi.intensity = L('hemiI') * (1 + 0.08 * oc);
    if (tk > 0) {
      hemi.color.lerp(SODIUM, tk);
      hemi.groundColor.lerp(SODIUM_LOW, tk);
      hemi.intensity += (0.6 - hemi.intensity) * tk;
    }

    mixHex(A.fog, B.fog, t, scene.fog.color);
    if (oc > 0 || fg > 0) scene.fog.color.lerp(grey(scene.fog.color, 0.92), Math.min(1, 0.6 * oc + 0.7 * fg));
    if (tk > 0) scene.fog.color.lerp(TUNNEL_HAZE, 0.85 * tk);       // lamplit haze, not sky
    env.fogColor.copy(scene.fog.color);
    const fogScale = quality === 'high' ? 1 : 0.8;
    scene.fog.near = (L('fogNear') + (14 - L('fogNear')) * fg) * fogScale * (1 - 0.5 * rn);
    scene.fog.far = (L('fogFar') + (240 - L('fogFar')) * fg) * fogScale * (1 - 0.4 * rn);
    env.exposure = L('exposure');
    renderer.toneMappingExposure = env.exposure;
    env.night = night;
    env.rain = rn * (1 - tk);
    env.tunnel = tk;
    env.headlight = night > 0.5 || tk > 0.2 || fg > 0.5 || rn > 0.5;
    signMat.emissiveIntensity = night * 0.32;
    glowMat.emissiveIntensity = Math.max(night, 0.4 * oc) * 1.2;
    for (const m of townSignMats) m.emissiveIntensity = night * 0.3;
    roadMat.color.setScalar(1 - 0.3 * rn * (1 - tk));            // wet asphalt is darker
    tubeMat.color.setScalar(night > 0.5 ? 0.78 : 1);
    glareMat.opacity = 0.6 * tk * (1 - night) * (1 - 0.4 * oc);
    rainUniforms.uColor.value.setHex(0xa9b6c4).multiplyScalar(0.3 + 0.7 * (1 - night));

    // Far ridges: fog-coloured at the foot, a hazier shade of the sky at the crest.
    const col = ridgeGeo.attributes.color;
    const foot = cA.copy(scene.fog.color);
    const crest = new THREE.Color().copy(skyUniforms.uHorizon.value).lerp(skyUniforms.uZenith.value, 0.35).multiplyScalar(0.78);
    const crestFar = new THREE.Color().copy(crest).lerp(foot, 0.45);
    for (let ring = 0; ring < 2; ring++) {
      const top = ring === 0 ? crest : crestFar;
      for (let k = 0; k <= RIDGE_SEG; k++) {
        const v = (ring * (RIDGE_SEG + 1) + k) * 2;
        col.setXYZ(v, foot.r, foot.g, foot.b);
        col.setXYZ(v + 1, top.r, top.g, top.b);
      }
    }
    col.needsUpdate = true;

    oceanUniforms.uSky.value.copy(skyUniforms.uHorizon.value);
    oceanUniforms.uSunDir.value.copy(sunDir);
    oceanUniforms.uSunColor.value.copy(sun.color);
    oceanUniforms.uDeep.value.setHex(night > 0.5 ? 0x04121d : 0x0d3b57);
    ocean.visible = seaY != null;
    oceanY = seaY ?? 0;

    // Reflections for the bike's paint and chrome: a prefiltered copy of the sky.
    // Rebuilt only when the light has changed noticeably.
    const k2 = `${todMix.a}|${todMix.b}|${t.toFixed(1)}|${oc.toFixed(1)}`;
    if (k2 !== envKey) {
      envKey = k2;
      envSky.position.set(0, 0, 0);
      const rt = envMapGen.fromScene(envScene, 0.02, 1, 2000);
      envRT?.dispose();
      envRT = rt;
      scene.environment = rt.texture;
    }
  }

  // ---------- terrain tiles ----------
  const tileMeshes = new Map();        // key → { tile, mesh, props }
  const tkey = (tx, tz) => tx * 100003 + tz;
  const colorNoise = makeNoise2D(hash2(course.def.seed, 77));
  const tmpC = new THREE.Color();

  // The looks ({ key, palette, props, seaY }) in force at a tile's middle.
  function paletteFor(tile) {
    const k = tile.near[(GRID >> 1) * (GRID + 1) + (GRID >> 1)];
    const m = course.biomeAt(Math.max(0, k) * DS);
    return { A: m.a, B: m.b, t: m.t };
  }

  // Palettes converted to linear RGB once (Color.setHex does an sRGB→linear pow per
  // channel — doing that per vertex showed up in the profile).
  const palCache = new Map();
  const lin = hex => { tmpC.setHex(hex); return [tmpC.r, tmpC.g, tmpC.b]; };
  function linPal(p) {
    let c = palCache.get(p);
    if (!c) {
      c = { verge: lin(p.verge), ground: p.ground.map(lin), rock: lin(p.rock),
            strata: p.strata ? p.strata.map(lin) : null, sand: p.sand != null ? lin(p.sand) : null };
      palCache.set(p, c);
    }
    return c;
  }

  // Colour of one vertex: verge dirt, then ground shading by height above the road,
  // rock (or sandstone strata) on steep faces, sand at the waterline. Writes linear
  // RGB into out[0..2].
  function vertexColor(P, h, rel, t, slope, x, z, out, seaY = null) {
    let r, g, b;
    if (t <= 0) { r = P.verge[0]; g = P.verge[1]; b = P.verge[2]; }
    else if (P.sand && seaY != null && h < seaY + 2.6) { r = P.sand[0]; g = P.sand[1]; b = P.sand[2]; }
    else {
      const u = clamp(rel / 32 + 0.15 * colorNoise(x / 50, z / 50), 0, 0.999) * 2;
      const i = u | 0, f = smooth(u - i);
      const A = P.ground[i], B = P.ground[i + 1];
      r = A[0] + (B[0] - A[0]) * f; g = A[1] + (B[1] - A[1]) * f; b = A[2] + (B[2] - A[2]) * f;
      const rocky = smooth(clamp((slope - 0.6) / 0.55, 0, 1));
      if (rocky > 0) {
        let R = P.rock;
        if (P.strata) {
          // Bands must be taller than the vertical spacing of vertices on a steep
          // wall (~10 m per 3 m cell) or they alias into speckle.
          const n = P.strata.length;
          const band = Math.floor((h + 3000 + 6 * colorNoise(x / 90, z / 90)) / 11);
          R = P.strata[((band % n) + n) % n];
        }
        r += (R[0] - r) * rocky; g += (R[1] - g) * rocky; b += (R[2] - b) * rocky;
      }
    }
    const j = 1 + 0.09 * colorNoise(x / 7, z / 7);
    out[0] = r * j; out[1] = g * j; out[2] = b * j;
    return out;
  }
  const colA = [0, 0, 0], colB = [0, 0, 0];

  function buildTile(tile) {
    const N = GRID + 1;
    const p = paletteFor(tile);
    const PA = linPal(p.A.palette), PB = linPal(p.B.palette);
    const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
    const h = tile.heights;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[k * 3] = i * CELL; pos[k * 3 + 1] = h[k]; pos[k * 3 + 2] = j * CELL;
      const hx = (h[j * N + Math.min(GRID, i + 1)] - h[j * N + Math.max(0, i - 1)]) / (2 * CELL);
      const hz = (h[Math.min(GRID, j + 1) * N + i] - h[Math.max(0, j - 1) * N + i]) / (2 * CELL);
      const x = tile.x0 + i * CELL, z = tile.z0 + j * CELL;
      const slope = Math.sqrt(hx * hx + hz * hz);
      vertexColor(PA, h[k], tile.rel[k], tile.t[k], slope, x, z, colA, p.A.seaY);
      if (p.t > 0) {
        vertexColor(PB, h[k], tile.rel[k], tile.t[k], slope, x, z, colB, p.B.seaY);
        for (let c = 0; c < 3; c++) colA[c] += (colB[c] - colA[c]) * p.t;
      }
      col[k * 3] = colA[0]; col[k * 3 + 1] = colA[1]; col[k * 3 + 2] = colA[2];
    }
    const idx = new Uint16Array(GRID * GRID * 6);
    let o = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      // Same diagonal (b–c) as terrain.gridHeight, so physics matches the mesh.
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, terrainMat);
    mesh.position.set(tile.x0, 0, tile.z0);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    // Nothing grows in a bridge's river.
    const skip = course.endless ? (x, y, z, k) => {
      const s = Math.max(0, tile.near[k]) * DS, f = course.featureAt(s);
      if (!f || f.type !== 'bridge' || course.seaAt(s) != null) return false;
      const wy = course.waterY(f);
      return wy != null && y < wy + 1.5;
    } : null;
    const props = placeProps(tile, p.t < 0.5 ? p.A : p.B, course.def.seed, [], skip);
    if (quality !== 'high') props.length = Math.floor(props.length * 0.55);
    return { tile, mesh, props };
  }

  function dropTile(entry) {
    scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
  }

  // ---------- props (instanced, shared by all tiles) ----------
  const pools = {};
  const propTypes = new Set();
  for (const b of Object.values(BIOMES)) for (const p of b.props) propTypes.add(p.type);
  const kit = opts.kit || {};
  const boulderKit = propTypes.has('boulder') && BOULDER_KIT.every(k => kit[k]) && !!kit.boulder;
  const cap = { ...PROP_CAP };
  if (boulderKit) for (const k of BOULDER_KIT) { propTypes.add(k); cap[k] = cap.boulder; }
  // Far LOD: the kit pine is ~4× the placeholder's triangles and pine slopes fill the
  // pool, so pines beyond PINE_NEAR use a 78-triangle pine. The split is redone when the
  // rider has moved PINE_STEP since the last rebuild, so the swap stays well out in the haze.
  const pineLod = propTypes.has('pine') && !!kit.pine && !!kit.pineFar;
  if (pineLod) { propTypes.add('pineFar'); cap.pineFar = cap.pine; }
  const PINE_NEAR = 220, PINE_STEP = 80;
  let focusX = 0, focusZ = 0, lodX = 0, lodZ = 0;
  for (const type of propTypes) {
    const geo = own(kit[type] ? kit[type].clone() : propGeometry(type));
    const mesh = new THREE.InstancedMesh(geo, propMat, cap[type]);
    mesh.name = type;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    pools[type] = mesh;
  }
  const mtx = new THREE.Matrix4(), qtn = new THREE.Quaternion(), vpos = new THREE.Vector3(),
        vscl = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
  let propsDirty = false;

  function rebuildProps() {
    lodX = focusX; lodZ = focusZ;
    const n = {}, per = {};
    for (const type in pools) n[type] = 0;
    for (const entry of tileMeshes.values()) {
      for (const p of entry.props) {
        const key = boulderKit && p.type === 'boulder' ? boulderShape(p.scale)
          : pineLod && p.type === 'pine' && (p.x - lodX) ** 2 + (p.z - lodZ) ** 2 > PINE_NEAR * PINE_NEAR ? 'pineFar' : p.type;
        const pool = pools[key];
        const i = n[key];
        if (i >= cap[key] || (per[p.type] || 0) >= PROP_CAP[p.type]) continue;   // same total per type as ever
        per[p.type] = (per[p.type] || 0) + 1;
        qtn.setFromAxisAngle(yAxis, p.rot);
        vpos.set(p.x, p.y - 0.15, p.z);
        vscl.setScalar(p.scale);
        mtx.compose(vpos, qtn, vscl);
        pool.setMatrixAt(i, mtx);
        const v = 0.86 + 0.28 * ((hash2(Math.round(p.x * 10), Math.round(p.z * 10)) & 1023) / 1023);
        if (TINTED.has(p.type)) tint.setHex(p.tint).multiplyScalar(v * 1.15);
        else tint.setRGB(v, v, v);
        pool.setColorAt(i, tint);
        n[key] = i + 1;
      }
    }
    // Upload only the instances in use, not the whole capacity (~1.4 MB otherwise).
    for (const type in pools) {
      const pool = pools[type];
      pool.count = n[type];
      pool.visible = n[type] > 0;                 // an empty pool costs no state changes
      pool.instanceMatrix.clearUpdateRanges();
      pool.instanceMatrix.addUpdateRange(0, Math.max(1, n[type]) * 16);
      pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) {
        pool.instanceColor.clearUpdateRanges();
        pool.instanceColor.addUpdateRange(0, Math.max(1, n[type]) * 3);
        pool.instanceColor.needsUpdate = true;
      }
    }
    propsDirty = false;
  }

  // ---------- road chunks: surface, rails, signs, markers ----------
  const chunks = new Map();
  const q = {};
  const U = ROAD_U;

  function roadPoint(s, d, lift, out) {
    road.at(s, q);
    out[0] = q.x - Math.sin(q.psi) * d;
    out[1] = q.y - d * Math.tan(q.bank) + lift;
    out[2] = q.z + Math.cos(q.psi) * d;
    return out;
  }

  // ---------- Endless features: tunnels, bridges, towns ----------
  // Built per road chunk like the rails, so they stream in and out with the road.
  const fq = {};
  function place(geo, mat, ox, oz, out) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(ox, 0, oz);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
    out.push(m);
    return m;
  }
  // Road-frame point (s, d, lift above the surface) relative to the chunk origin.
  const rpo = (s, d, lift, ox, oz) => { const P = roadPoint(s, d, lift, [0, 0, 0]); P[0] -= ox; P[2] -= oz; return P; };
  const stepsOf = (a, b, step) => { const o = []; for (let s = a; s < b - 0.01; s += step) o.push(s); o.push(b); return o; };

  // A surface swept along the road. `sec(s)` gives the cross-section as flat [d, lift]
  // pairs; `shade(s, j, P, out)` (optional) a linear colour per vertex.
  function sweep(ss, sec, ox, oz, shade = null) {
    const first = sec(ss[0]), rows = ss.length, cols = first.length / 2;
    const pos = new Float32Array(rows * cols * 3), col = shade ? new Float32Array(rows * cols * 3) : null;
    const P = [0, 0, 0], C = [0, 0, 0];
    for (let r = 0; r < rows; r++) {
      const cs = r === 0 ? first : sec(ss[r]);
      for (let j = 0; j < cols; j++) {
        roadPoint(ss[r], cs[j * 2], cs[j * 2 + 1], P);
        const o = (r * cols + j) * 3;
        if (col) { shade(ss[r], j, P, C); col[o] = C[0]; col[o + 1] = C[1]; col[o + 2] = C[2]; }
        pos[o] = P[0] - ox; pos[o + 1] = P[1]; pos[o + 2] = P[2] - oz;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let j = 0; j < cols - 1; j++) {
      const a = r * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // --- tunnel: a lined tube with lamps, a roof over the terrain's slot, two portals ---
  const tubeHalf = s => { road.at(s, fq); return fq.hw + fq.sh + 0.25; };
  const archY = (d, W) => 4.3 + 2.9 * Math.sqrt(Math.max(0, 1 - (d / W) ** 2));
  const TUBE_SHADE = [0.5, 0.5, 0.95, 1, 0.9, 0.84, 0.8, 0.78, 0.8, 0.84, 0.9, 1, 0.95, 0.5, 0.5];
  function tubeSection(s) {
    const W = tubeHalf(s), o = [-W, -0.8, -W, 1.0, -W, 1.05, -W, 4.3];
    for (let j = 1; j < 8; j++) { const a = Math.PI - j * Math.PI / 8; o.push(W * Math.cos(a), 4.3 + 2.9 * Math.sin(a)); }
    o.push(W, 4.3, W, 1.05, W, 1.0, W, -0.8);
    return o;
  }
  const concrete = new THREE.Color(0xb7b2a8);
  function buildTunnel(f, s0c, s1c, ox, oz, out) {
    const a = Math.max(f.s0, s0c), b = Math.min(f.s1, s1c);
    if (b > a) {
      const ss = stepsOf(a, b, 4);
      // Lining: lamplit concrete, brighter near the portals where daylight gets in.
      out.push(place(sweep(ss, tubeSection, ox, oz, (s, j, P, C) => {
        const k = TUBE_SHADE[j] * (0.42 + 0.58 * Math.exp(-Math.min(s - f.s0, f.s1 - s) / 20));
        C[0] = concrete.r * k; C[1] = concrete.g * k; C[2] = concrete.b * k;
      }), tubeMat, ox, oz, []));
      // Two rows of lamps along the crown.
      const lamps = new Mesher(false);
      for (let s = Math.ceil(a / 10) * 10; s < b; s += 10) {
        const W = tubeHalf(s);
        for (const side of [-1, 1]) {
          const P = rpo(s, side * W * 0.5, archY(W * 0.5, W) - 0.08, ox, oz);
          lamps.box(P[0], P[1], P[2], 1.4, 0.1, 0.3, fq.psi);
        }
      }
      if (!lamps.empty) place(lamps.build(), lampMat, ox, oz, out);
      // Roof over the slot, buried into the hill at its edges, coloured like the land.
      const lid = s => {
        const W = tubeHalf(s), slot = W - 0.25 + VERGE, H = tunnelCrest(f, s);
        return [-(slot + 4), 0.82 * H, -(slot + 1), H + 0.1, -W, H + 0.4, 0, H + 0.5, W, H + 0.4, slot + 1, H + 0.1, slot + 4, 0.82 * H];
      };
      place(sweep(ss, lid, ox, oz, (s, j, P, C) => {
        const m = course.biomeAt(s), look = m.t < 0.5 ? m.a : m.b;
        vertexColor(linPal(look.palette), P[1], f.H, 6, 0.35, P[0], P[2], C, null);
      }), terrainMat, ox, oz, out);
    }
    // Portals: a concrete headwall around the opening, set into the hillside.
    const walls = new Mesher(false);
    for (const [sF, dir] of [[f.s0, -1], [f.s1, 1]]) {
      if (sF < s0c || sF >= s1c) continue;
      const s = sF + dir * 0.3, W = tubeHalf(sF), slot = W - 0.25 + VERGE;
      const Wout = slot + 4.6, top = f.H + 1.6, bot = -1.2;
      const Q = (d0, y0, d1, y1, d2, y2, d3, y3) =>
        walls.quad(rpo(s, d0, y0, ox, oz), rpo(s, d1, y1, ox, oz), rpo(s, d2, y2, ox, oz), rpo(s, d3, y3, ox, oz));
      Q(-Wout, bot, -W, bot, -W, top, -Wout, top);
      Q(W, bot, Wout, bot, Wout, top, W, top);
      Q(-W, 7.5, W, 7.5, W, top, -W, top);
      for (let j = 0; j < 8; j++) {
        const dA = -W + j * W / 4, dB = dA + W / 4;
        Q(dA, archY(dA, W), dB, archY(dB, W), dB, 7.5, dA, 7.5);
      }
    }
    if (!walls.empty) place(walls.build(), concreteMat, ox, oz, out);
    // Glare cards filling each opening, just inside it.
    const glare = new Mesher(false);
    for (const [sF, dir] of [[f.s0, 1], [f.s1, -1]]) {
      if (sF < s0c || sF >= s1c) continue;
      const s = sF + dir * 0.6, W = tubeHalf(sF) - 0.05;
      for (let j = 0; j < 8; j++) {
        const dA = -W + j * W / 4, dB = dA + W / 4;
        glare.quad(rpo(s, dA, -0.3, ox, oz), rpo(s, dB, -0.3, ox, oz), rpo(s, dB, archY(dB, W), ox, oz), rpo(s, dA, archY(dA, W), ox, oz));
      }
    }
    if (!glare.empty) place(glare.build(), glareMat, ox, oz, out).renderOrder = 2;
  }

  // --- bridge: a deck under the road, piers or a concrete arch, a river below ---
  function buildBridge(f, s0c, s1c, ox, oz, out) {
    const a = Math.max(f.s0 - 6, s0c), b = Math.min(f.s1 + 6, s1c);
    const L = f.s1 - f.s0;
    if (b > a) {
      out.push(place(sweep(stepsOf(a, b, 2), s => {
        road.at(s, fq);
        const e = fq.hw + fq.sh - 0.05, E = fq.hw + fq.sh + 0.55;
        return [-e, 0.06, -E, 0.06, -E, -1.9, E, -1.9, E, 0.06, e, 0.06];
      }, ox, oz), concreteMat, ox, oz, []));
    }
    const m = new Mesher(false);
    const ground = (s, d) => course.terrain.heightAt(Math.round(s / DS), d);
    const pier = s => {
      if (s < s0c || s >= s1c) return;
      road.at(s, fq);
      const psi = fq.psi, yb = fq.y - 1.9, e = fq.hw + fq.sh;
      let any = false;
      for (const side of [-1, 1]) {
        const d = side * (e - 1.0), g = ground(s, d);
        if (yb - g < 2.5) continue;
        const P = rpo(s, d, 0, ox, oz);
        m.box(P[0], (yb + g - 3) / 2, P[2], 1.7, yb - g + 3, 1.7, psi);
        any = true;
      }
      if (any) { const C = rpo(s, 0, -2.4, ox, oz); m.box(C[0], C[1], C[2], 1.6, 1.0, 2 * e - 0.4, psi); }
    };
    if (f.kind === 'arch') {
      // Open-spandrel concrete arch (the Big Sur kind): two ribs springing from the
      // gorge sides, columns up to the deck.
      const sA = f.s0 + 0.13 * L, sB = f.s1 - 0.13 * L, mid = (f.s0 + f.s1) / 2;
      road.at(mid, fq);
      const apex = fq.y - 2.6, dRib = fq.hw + fq.sh - 1.1;
      for (const side of [-1, 1]) {
        const d = side * dRib;
        const gA = ground(sA, d) - 0.5, gB = ground(sB, d) - 0.5;
        const yAt = s => { const u = (s - sA) / (sB - sA), base = gA + (gB - gA) * u; return base + (apex - base) * (1 - (2 * u - 1) ** 2); };
        const pAbs = (s, dd, y) => { const P = rpo(s, dd, 0, ox, oz); P[1] = y; return P; };
        for (let s = sA; s < sB - 0.01; s += 5) {
          if (s < s0c || s >= s1c) continue;
          const s2 = Math.min(sB, s + 5), yA = yAt(s), yB = yAt(s2), w = 0.65, h = 0.75;
          const a0 = pAbs(s, d - w, yA - h), a1 = pAbs(s, d + w, yA - h), a2 = pAbs(s, d + w, yA + h), a3 = pAbs(s, d - w, yA + h);
          const b0 = pAbs(s2, d - w, yB - h), b1 = pAbs(s2, d + w, yB - h), b2 = pAbs(s2, d + w, yB + h), b3 = pAbs(s2, d - w, yB + h);
          m.quad(a0, b0, b3, a3); m.quad(a1, a2, b2, b1); m.quad(a3, b3, b2, a2); m.quad(a0, a1, b1, b0);
        }
        for (let s = sA + 4; s < sB; s += 8) {
          if (s < s0c || s >= s1c) continue;
          road.at(s, fq);
          const top = fq.y - 1.9, y0 = yAt(s);
          if (top - y0 < 0.6) continue;
          const P = rpo(s, d, 0, ox, oz);
          m.box(P[0], (top + y0) / 2, P[2], 0.9, top - y0, 0.9, fq.psi);
        }
      }
      for (let s = f.s0 + 12; s < sA - 4; s += 14) pier(s);
      for (let s = sB + 8; s < f.s1 - 4; s += 14) pier(s);
    } else {
      for (let s = f.s0 + 28; s < f.s1 - 10; s += 30) pier(s);
    }
    if (!m.empty) place(m.build(), concreteMat, ox, oz, out);

    // The river, running down the gorge (across the road). Not on a sea coast: there
    // the gorge runs out over the cliffs and the strip would float above the sea.
    const mid = (f.s0 + f.s1) / 2;
    const wy = course.waterY(f);
    if (mid >= s0c && mid < s1c && wy != null && course.seaAt(mid) == null) {
      road.at(mid, fq);
      const nx = -Math.sin(fq.psi), nz = Math.cos(fq.psi), fx = Math.cos(fq.psi), fz = Math.sin(fq.psi);
      const cx = fq.x - ox, cz = fq.z - oz, half = 0.2 * L, len = 450;
      const P = (u, v) => [cx + nx * u + fx * v, wy, cz + nz * u + fz * v];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...P(-len, -half), ...P(len, -half), ...P(len, half), ...P(-len, half)], 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);                 // facing up
      geo.computeBoundingSphere();
      place(geo, oceanMat, ox, oz, out);
    }
  }

  // --- town: kerbs and pavements, buildings with lit windows, street lamps, a sign ---
  function buildTown(f, s0c, s1c, ox, oz, out, c) {
    const a = Math.max(f.s0, s0c), b = Math.min(f.s1, s1c);
    const r = mulberry32(hash2(Math.floor(f.s0), c));
    const fam = course.biomeAt(f.s0).a.key === 'desert' ? 'desert' : 'other';
    const pick = arr => arr[Math.floor(r() * arr.length)];
    const bm = new Mesher(false, true), wm = new Mesher(false);
    if (b > a) {
      const ss = stepsOf(a, b, 2);
      for (const side of [-1, 1]) {
        out.push(place(sweep(ss, s => {
          road.at(s, fq);
          const e = fq.hw + fq.sh;
          return side < 0 ? [-(e + 3.2), -0.9, -(e + 3.2), 0.16, -e, 0.16, -e, -0.02]
                          : [e, -0.02, e, 0.16, e + 3.2, 0.16, e + 3.2, -0.9];
        }, ox, oz), concreteMat, ox, oz, []));
      }
      for (const side of [-1, 1]) {
        let s = a + r() * 5;
        for (;;) {
          const w = 8 + r() * 10;
          if (s + w > b) break;
          if (r() < 0.18) { s += w; continue; }                    // an empty lot
          const depth = 7 + r() * 9, floors = r() < 0.35 ? 2 : 1, hgt = floors * 3.3 + 0.6 + r() * 0.8;
          const sm = s + w / 2;
          road.at(sm, fq);
          const e = fq.hw + fq.sh, d0 = e + 3.8, psi = fq.psi;
          const tx = Math.cos(psi), tz = Math.sin(psi), nx = -Math.sin(psi) * side, nz = Math.cos(psi) * side;
          const C = rpo(sm, side * (d0 + depth / 2), 0, ox, oz);
          const base = fq.y - 1.6, top = fq.y + hgt;
          bm.color(pick(TOWN_WALLS[fam]), 0.92 + r() * 0.12);
          bm.box(C[0], (base + top) / 2, C[2], w, top - base, depth, psi);
          // Local frame on the building: x along the road, y up, z away from the road.
          const L3 = (x, y, z) => [C[0] + tx * x + nx * z, y, C[2] + tz * x + nz * z];
          bm.color(pick(TOWN_ROOFS[fam]));
          if (r() < 0.6) {
            const hw2 = w / 2 + 0.3, hd = depth / 2 + 0.3, rh = 1.4 + r() * 0.8;
            const p0 = L3(-hw2, top, -hd), p1 = L3(hw2, top, -hd), p2 = L3(hw2, top, hd), p3 = L3(-hw2, top, hd);
            const r0 = L3(-hw2, top + rh, 0), r1 = L3(hw2, top + rh, 0);
            bm.quad(p0, p1, r1, r0); bm.quad(p2, p3, r0, r1);
            bm.tri(p1, p2, r1, [0, 1, 0]); bm.tri(p3, p0, r0, [0, 1, 0]);
          } else {
            bm.box(C[0], top + 0.25, C[2], w + 0.2, 0.5, depth + 0.2, psi);
          }
          // Windows (and a door) on the side facing the road.
          const zf = -depth / 2 - 0.06;
          const n = Math.max(1, Math.floor(w / 3.2));
          for (let fl = 0; fl < floors; fl++) {
            for (let k = 0; k < n; k++) {
              const x = -w / 2 + (k + 0.5) * w / n, y0 = fq.y + 0.9 + fl * 3.3;
              if (fl === 0 && k === (n >> 1)) {
                bm.color(0x2a2522);
                bm.quad(L3(x - 0.5, fq.y - 0.4, zf), L3(x + 0.5, fq.y - 0.4, zf), L3(x + 0.5, fq.y + 1.9, zf), L3(x - 0.5, fq.y + 1.9, zf));
                continue;
              }
              wm.quad(L3(x - 0.55, y0, zf), L3(x + 0.55, y0, zf), L3(x + 0.55, y0 + 1.3, zf), L3(x - 0.55, y0 + 1.3, zf));
            }
          }
          s += w + 1.5 + r() * 6;
        }
      }
      // Street lamps, alternating sides.
      for (let s = Math.ceil(a / 28) * 28, k = 0; s < b; s += 28, k++) {
        const side = k % 2 ? 1 : -1;
        road.at(s, fq);
        const e = fq.hw + fq.sh;
        const P = rpo(s, side * (e + 2.6), 0.16, ox, oz), A = rpo(s, side * (e + 1.7), 6.1, ox, oz), H = rpo(s, side * (e + 0.9), 5.95, ox, oz);
        bm.color(0x3b3f45);
        bm.box(P[0], P[1] + 3.05, P[2], 0.18, 6.1, 0.18, fq.psi);
        bm.box(A[0], A[1], A[2], 0.12, 0.12, 1.8, fq.psi);
        wm.box(H[0], H[1], H[2], 0.3, 0.14, 0.55, fq.psi);
      }
    }
    // The town sign, 40 m before the first house, on the right.
    const sS = f.s0 - 40;
    if (sS >= s0c && sS < s1c) {
      road.at(sS, fq);
      const e = fq.hw + fq.sh, d = e + 2.2, w = 3.2, h = 1.4, yMid = 2.7;
      const fx = Math.cos(fq.psi), fz = Math.sin(fq.psi), rx = -Math.sin(fq.psi), rz = Math.cos(fq.psi);
      const P = rpo(sS, d, 0, ox, oz);
      bm.color(0x6d7378);
      for (const off of [-1.1, 1.1]) bm.box(P[0] + rx * off, P[1] + 1.6, P[2] + rz * off, 0.1, 3.2, 0.1, fq.psi);
      const cx = P[0] - fx * 0.08, cy = P[1] + yMid, cz = P[2] - fz * 0.08;
      const face = new Mesher(true);
      face.quad([cx - rx * w / 2, cy - h / 2, cz - rz * w / 2], [cx + rx * w / 2, cy - h / 2, cz + rz * w / 2],
        [cx + rx * w / 2, cy + h / 2, cz + rz * w / 2], [cx - rx * w / 2, cy + h / 2, cz - rz * w / 2]);
      bm.color(0x55595e);
      bm.quad([cx + rx * w / 2 + fx * 0.04, cy - h / 2, cz + rz * w / 2 + fz * 0.04], [cx - rx * w / 2 + fx * 0.04, cy - h / 2, cz - rz * w / 2 + fz * 0.04],
        [cx - rx * w / 2 + fx * 0.04, cy + h / 2, cz - rz * w / 2 + fz * 0.04], [cx + rx * w / 2 + fx * 0.04, cy + h / 2, cz + rz * w / 2 + fz * 0.04]);
      const tex = makeTownSign(f.name, f.pop);
      const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: env.night * 0.3 });
      townSignMats.add(mat);
      const mesh = place(face.build(), mat, ox, oz, out);
      mesh.userData.dispose = () => { townSignMats.delete(mat); mat.dispose(); tex.dispose(); };
    }
    if (!bm.empty) place(bm.build(), buildMat, ox, oz, out);
    if (!wm.empty) place(wm.build(), glowMat, ox, oz, out);
  }

  function buildChunk(c) {
    const i0 = c * CHUNK, i1 = Math.min(road.n - 1, (c + 1) * CHUNK);
    if (i1 <= i0) return null;
    const ox = road.x[i0], oz = road.z[i0];
    const rows = i1 - i0 + 1, cols = U.length;
    const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
    const rgb = new Float32Array(rows * cols * 3).fill(1);
    for (let r = 0; r < rows; r++) {
      const i = i0 + r;
      // In a tunnel the road is darker (it's lit by lamps, not the sun), so it reads
      // right from outside too; it fades over the first metres from each portal.
      const tf = course.featureAt(i * DS);
      if (tf && tf.type === 'tunnel') {
        const k = 1 - 0.55 * smooth(clamp(Math.min(i * DS - tf.s0, tf.s1 - i * DS) / 18, 0, 1));
        rgb.fill(k, r * cols * 3, (r + 1) * cols * 3);
      }
      const psi = road.psi[i], rx = -Math.sin(psi), rz = Math.cos(psi), tb = Math.tan(road.bank[i]);
      const hw = road.hw[i], edge = hw + road.sh[i];
      const D = [-(edge + 0.35), -edge, -hw, hw, edge, edge + 0.35];
      for (let k = 0; k < cols; k++) {
        const d = D[k];
        const skirt = k === 0 || k === cols - 1;
        const o = (r * cols + k) * 3;
        pos[o] = road.x[i] + rx * d - ox;
        pos[o + 1] = road.y[i] - (skirt ? edge * Math.sign(d) : d) * tb - (skirt ? 1.9 : 0);
        pos[o + 2] = road.z[i] + rz * d - oz;
        uv[(r * cols + k) * 2] = U[k];
        uv[(r * cols + k) * 2 + 1] = (i * DS) / 8;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let k = 0; k < cols - 1; k++) {
      const a = r * cols + k, b = a + 1, cc = a + cols, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const surface = new THREE.Mesh(geo, roadMat);
    surface.position.set(ox, 0, oz);
    surface.receiveShadow = true;
    surface.matrixAutoUpdate = false;
    surface.updateMatrix();
    scene.add(surface);

    // Guardrails: a bent-steel beam on posts every 4 m, wherever the land drops.
    // With the kit: its rail piece, stretched over each 2 m sample (posts ≈ 2 m apart, as
    // on real roads), standing upright on the shoulder; the top stays at 0.85 m.
    const rails = new Mesher(false, !!kit.rail);
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], D2 = [0, 0, 0];
    if (kit.rail) for (const side of [-1, 1]) {
      for (let i = i0; i < i1; i++) {
        if (!course.railAt(i, side)) continue;
        roadPoint(i * DS, side * (road.hw[i] + road.sh[i] - 0.3), 0, A);
        roadPoint((i + 1) * DS, side * (road.hw[i + 1] + road.sh[i + 1] - 0.3), 0, B);
        // Columns: along the road (length), straight up (height), across (thickness). The
        // piece is turned (not mirrored) per side so its beam faces the road, posts behind.
        const ex = -side * (B[0] - A[0]), ey = -side * (B[1] - A[1]), ez = -side * (B[2] - A[2]);
        const h = Math.hypot(ex, ez) || 1;
        _km.set(ex, 0, -ez / h * 0.2, (A[0] + B[0]) / 2 - ox,
                ey, 1.15, 0, (A[1] + B[1]) / 2 - 0.3,
                ez, 0, ex / h * 0.2, (A[2] + B[2]) / 2 - oz,
                0, 0, 0, 1);
        rails.add(kit.rail, _km);
      }
    } else for (const side of [-1, 1]) {
      for (let i = i0; i < i1; i++) {
        if (!course.railAt(i, side)) continue;
        const dA = side * (road.hw[i] + road.sh[i] - 0.3), dB = side * (road.hw[i + 1] + road.sh[i + 1] - 0.3);
        for (const [y0, y1, bulge] of [[0.5, 0.68, 0.07], [0.68, 0.86, 0.07]]) {
          roadPoint(i * DS, dA, y0, A); roadPoint((i + 1) * DS, dB, y0, B);
          roadPoint((i + 1) * DS, dB + side * bulge, y1, C); roadPoint(i * DS, dA + side * bulge, y1, D2);
          for (const P of [A, B, C, D2]) { P[0] -= ox; P[2] -= oz; }
          rails.quad(A, B, C, D2);
        }
        if (i % 2 === 0) {
          roadPoint(i * DS, dA + side * 0.12, 0, A);
          rails.box(A[0] - ox, A[1] + 0.2, A[2] - oz, 0.12, 1.3, 0.1, -road.psi[i], null);
        }
      }
    }
    let railMesh = null;
    if (!rails.empty) {
      railMesh = new THREE.Mesh(rails.build(), kit.rail ? propMat : railMat);
      railMesh.position.set(ox, 0, oz);
      railMesh.matrixAutoUpdate = false;
      railMesh.updateMatrix();
      scene.add(railMesh);
    }

    // Signs: curve warnings with an advisory-speed plate ~90 m before each corner,
    // chevrons around the outside of tight ones, and reflective markers every 24 m.
    const signs = new Mesher(true);
    const s0 = i0 * DS, s1 = i1 * DS;
    const P = [0, 0, 0];
    // Posts: the kit's sign post (grey from the atlas) or a box. h: top above the road.
    const post = (s, d, h = 1.8) => {
      roadPoint(s, d, 0, P);
      if (kit.post) {
        _km.compose(_kv.set(P[0] - ox, P[1] - 0.6, P[2] - oz), _kq.setFromAxisAngle(_ky, -road.at(s, q).psi), _ks.set(0.09, h + 0.6, 0.09));
        signs.add(kit.post, _km, GREY_UV);
      } else signs.box(P[0] - ox, P[1] + h / 2 - 0.3, P[2] - oz, 0.08, h + 0.6, 0.08, -road.at(s, q).psi, cellUV(0));
    };
    const face = (s, d, yMid, w, h, cell) => {
      road.at(s, q);
      roadPoint(s, d, yMid, P);
      const fx = Math.cos(q.psi), fz = Math.sin(q.psi);
      const rx = -Math.sin(q.psi), rz = Math.cos(q.psi);
      const cx = P[0] - ox - fx * 0.06, cy = P[1], cz = P[2] - oz - fz * 0.06;
      // Facing back down the road, toward the approaching rider.
      const a = [cx - rx * w / 2, cy - h / 2, cz - rz * w / 2], b = [cx + rx * w / 2, cy - h / 2, cz + rz * w / 2];
      const tr = [cx + rx * w / 2, cy + h / 2, cz + rz * w / 2], tl = [cx - rx * w / 2, cy + h / 2, cz - rz * w / 2];
      signs.quad(a, b, tr, tl, cellUV(cell));     // front (normal −f) faces the rider
    };
    for (const k of course.cornersUpTo(s1 + 160)) {
      const sSign = k.s0 - 90;
      const R = k.R;
      if (course.featureAt(sSign) || course.featureAt(k.s0)) continue;    // not in tunnels, on bridges or in towns
      if (sSign >= s0 && sSign < s1 && sSign > 30 && R < 220) {
        const mph = Math.sqrt(0.3 * 9.81 * R) * MPH;
        const plate = SPEEDS.findLastIndex(v => v <= mph);
        const dS = road.at(sSign, q).hw + q.sh + 1.4;
        post(sSign, dS);
        face(sSign, dS, 2.25, 1.15, 1.15, R < 30 ? (k.sign > 0 ? 5 : 4) : (k.sign > 0 ? 3 : 2));
        if (plate >= 0) face(sSign, dS, 1.35, 0.72, 0.62, 8 + plate);
      }
      if (R < 80) {
        for (let s = k.s0 + 10; s < k.s1 - 6; s += 18) {
          if (s < s0 || s >= s1) continue;
          const dC = -k.sign * (road.at(s, q).hw + q.sh + 1.6);
          post(s, dC);
          face(s, dC, 1.55, 0.6, 0.75, k.sign > 0 ? 7 : 6);
        }
      }
    }
    // Reflector posts (kit only): every 50 m on each side, a short post with a reflector
    // that glows in the headlight like the signs — where there's no guardrail or feature.
    if (kit.post) for (let s = Math.ceil(s0 / 50) * 50; s < s1; s += 50) {
      if (s < 30 || course.featureAt(s)) continue;
      for (const side of [-1, 1]) {
        if (course.railAt(Math.round(s / DS), side)) continue;
        const d = side * (road.at(s, q).hw + q.sh + 0.8);
        post(s, d, 1.1);
        face(s, d, 0.98, 0.08, 0.16, 1);
      }
    }
    for (let s = Math.ceil(s0 / 24) * 24; s < s1; s += 24) {
      roadPoint(s, 0, 0.03, P);
      signs.box(P[0] - ox, P[1], P[2] - oz, 0.1, 0.05, 0.1, -road.at(s, q).psi, cellUV(1));
    }
    let signMesh = null;
    if (!signs.empty) {
      signMesh = new THREE.Mesh(signs.build(), signMat);
      signMesh.position.set(ox, 0, oz);
      signMesh.matrixAutoUpdate = false;
      signMesh.updateMatrix();
      scene.add(signMesh);
    }
    // Endless features overlapping this stretch.
    const extra = [];
    for (const f of course.featuresIn(s0 - 50, s1 + 50)) {
      if (f.type === 'tunnel') buildTunnel(f, s0, s1, ox, oz, extra);
      else if (f.type === 'bridge') buildBridge(f, s0, s1, ox, oz, extra);
      else buildTown(f, s0, s1, ox, oz, extra, c);
    }
    return { surface, railMesh, signMesh, extra };
  }

  function dropChunk(ch) {
    for (const m of [ch.surface, ch.railMesh, ch.signMesh, ...ch.extra]) {
      if (!m) continue;
      scene.remove(m);
      m.geometry.dispose();
      m.userData.dispose?.();
    }
  }

  // ---------- gantries: start, checkpoints, finish ----------
  const gantryGroup = new THREE.Group();
  scene.add(gantryGroup);
  let bannerTex = null, bannerMat = null, gantryMat = null;
  if (!course.endless) {
    const labels = ['START'];
    course.checkpoints.forEach((s, i) => labels.push(i === course.checkpoints.length - 1 ? 'FINISH' : `CHECKPOINT ${i + 1}`));
    bannerTex = own(makeBannerTexture(labels));
    bannerMat = own(new THREE.MeshLambertMaterial({ map: bannerTex, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: bannerTex, emissiveIntensity: 0.25 }));
    gantryMat = own(new THREE.MeshLambertMaterial({ color: 0x1c1d21 }));
    const where = [course.startS + 4, ...course.checkpoints];
    where.forEach((s, li) => {
      road.at(s, q);
      const edge = q.hw + q.sh + 0.9;
      const ox = q.x, oz = q.z;
      const pylons = new Mesher(false), banner = new Mesher(true);
      const P = [0, 0, 0];
      for (const side of [-1, 1]) {
        roadPoint(s, side * edge, 0, P);
        pylons.box(P[0] - ox, P[1] + 2.6, P[2] - oz, 0.55, 5.6, 0.55, -q.psi, null);
      }
      const L = roadPoint(s, -edge, 4.75, [0, 0, 0]), R = roadPoint(s, edge, 4.75, [0, 0, 0]);
      const v0 = 1 - (li + 1) / labels.length, v1 = 1 - li / labels.length;
      const a = [L[0] - ox, L[1] - 0.55, L[2] - oz], b = [R[0] - ox, R[1] - 0.55, R[2] - oz];
      const c = [R[0] - ox, R[1] + 0.55, R[2] - oz], d = [L[0] - ox, L[1] + 0.55, L[2] - oz];
      banner.quad(a, b, c, d, [0, v0, 1, v1]);
      const pm = new THREE.Mesh(own(pylons.build()), gantryMat);
      const bm = new THREE.Mesh(own(banner.build()), bannerMat);
      for (const m of [pm, bm]) { m.position.set(ox, 0, oz); gantryGroup.add(m); }
    });
  }

  // ---------- streaming ----------
  // Terrain streams through a small pipeline so no frame carries a whole tile:
  // heights a few rows per frame (job) → mesh the next frame (ready) → props later.
  let lastProps = 0, job = null, ready = null, syncTiles = false;
  // Timing of the expensive streaming steps (max ms since last read) — for profiling.
  const perf = {};
  const timed = (k, t0) => { const d = performance.now() - t0; perf[k] = Math.max(perf[k] || 0, d); };
  function update(f, time) {
    // f: { x, y, z, s, fx, fz } — the rider (or camera target) and its heading.
    course.ensure(f.s);
    focusX = f.x; focusZ = f.z;
    if (pineLod && (f.x - lodX) ** 2 + (f.z - lodZ) ** 2 > PINE_STEP * PINE_STEP) propsDirty = true;

    // Road chunks around the rider.
    const cLo = Math.max(0, Math.floor((f.s - BEHIND) / (CHUNK * DS)));
    const cHi = Math.floor((f.s + AHEAD) / (CHUNK * DS));
    for (const [c, ch] of chunks) if (c < cLo - 1 || c > cHi + 1) { dropChunk(ch); chunks.delete(c); }
    for (let c = cLo; c <= cHi; c++) {
      if (chunks.has(c) || c * CHUNK >= road.n - 1) continue;
      const t0 = performance.now();
      const ch = buildChunk(c);
      timed('chunk', t0);
      if (ch) chunks.set(c, ch);
      break;                                   // one per frame keeps frame times flat
    }

    // Terrain: the nearest missing tile around a point ahead of the rider.
    const cx = f.x + f.fx * 150, cz = f.z + f.fz * 150;
    const R = tileRadius();
    let best = null, bestD = Infinity;
    const t0x = Math.floor((cx - R) / TILE), t1x = Math.floor((cx + R) / TILE);
    const t0z = Math.floor((cz - R) / TILE), t1z = Math.floor((cz + R) / TILE);
    for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
      if (tileMeshes.has(tkey(tx, tz))) continue;
      const d = Math.hypot(tx * TILE + TILE / 2 - f.x, tz * TILE + TILE / 2 - f.z);
      const dc = Math.hypot(tx * TILE + TILE / 2 - cx, tz * TILE + TILE / 2 - cz);
      if (dc > R + TILE * 0.7) continue;
      if (d < bestD) { bestD = d; best = [tx, tz]; }
    }
    if (ready) {
      const t0 = performance.now();
      if (!tileMeshes.has(tkey(ready.tx, ready.tz))) tileMeshes.set(tkey(ready.tx, ready.tz), buildTile(ready));
      timed('mesh', t0);
      ready = null;
      propsDirty = true;
    } else if (job) {
      const t0 = performance.now();
      const done = job.step();
      timed('heights', t0);
      if (done) { ready = done; job = null; }
    } else if (best) {
      if (syncTiles) {
        tileMeshes.set(tkey(best[0], best[1]), buildTile(course.tile(best[0], best[1])));
        propsDirty = true;
      } else job = course.tileJob(best[0], best[1]);
    }
    for (const [k, entry] of tileMeshes) {
      const d = Math.hypot(entry.tile.x0 + TILE / 2 - cx, entry.tile.z0 + TILE / 2 - cz);
      if (d > R + TILE * 1.6) { dropTile(entry); tileMeshes.delete(k); propsDirty = true; }
    }
    course.releaseTiles(cx, cz, R + TILE * 2.2);
    if (propsDirty && time - lastProps > 0.25) { const t0 = performance.now(); rebuildProps(); lastProps = time; timed('props', t0); }

    // Environment follows the road in Endless; for stages it's set once.
    if (course.endless) setEnvironment(course.todAt(f.s), course.biomeAt(f.s), modsAt(f.s));
  }

  const mods = { rain: 0, fog: 0, overcast: 0, tunnel: 0, seaY: null };
  function modsAt(s) {
    const w = course.weatherAt(s);
    mods.rain = w.rain; mods.fog = w.fog; mods.overcast = w.overcast;
    mods.tunnel = course.tunnelAt(s);
    mods.seaY = course.seaAt(s);
    return mods;
  }

  // Per-frame: sky, ridges and ocean ride along with the camera.
  function follow(camera, time, groundY) {
    sky.position.copy(camera.position);
    ridgeY += (groundY - 40 - ridgeY) * 0.02;
    ridges.position.set(camera.position.x, ridgeY, camera.position.z);
    ocean.position.set(camera.position.x, oceanY, camera.position.z);
    oceanUniforms.uTime.value = time;
    rain.visible = env.rain > 0.01;
    rainUniforms.uAmount.value = env.rain;
    rainUniforms.uTime.value = time;
    rainUniforms.uCam.value.copy(camera.position);
  }

  // Shadows: a small box of shadow-map that follows the bike.
  function shadowAt(x, y, z) {
    sun.position.set(x + sunDir.x * 60, y + sunDir.y * 60, z + sunDir.z * 60);
    sun.target.position.set(x, y, z);
    sun.target.updateMatrixWorld();
  }

  // Generate everything around a point synchronously (behind a loading screen).
  function prewarm(f) {
    syncTiles = true;
    for (let k = 0; k < 160; k++) {
      const before = tileMeshes.size + chunks.size;
      update(f, k);
      if (tileMeshes.size + chunks.size === before) break;
    }
    syncTiles = false;
    rebuildProps();
    lastProps = -Infinity;    // the loop above stamped a fake time (k); don't hold back the next rebuild
  }

  function setQuality(qv) {
    quality = qv;
    sun.castShadow = qv === 'high';
    env.key = '';
  }
  setQuality(quality);

  setEnvironment(course.todAt(course.startS), course.biomeAt(course.startS), course.endless ? modsAt(course.startS) : null);

  return {
    update, follow, prewarm, shadowAt, setQuality, roadPoint,
    get env() { return env; },
    get sunDir() { return sunDir; },
    get sunLight() { return sun; },
    get tileCount() { return tileMeshes.size; },
    get chunkCount() { return chunks.size; },
    perf(reset) { const o = { ...perf }; if (reset) for (const k in perf) delete perf[k]; return o; },
    destroy() {
      for (const ch of chunks.values()) dropChunk(ch);
      chunks.clear();
      for (const entry of tileMeshes.values()) dropTile(entry);
      tileMeshes.clear();
      for (const pool of Object.values(pools)) { scene.remove(pool); pool.dispose(); }
      envRT?.dispose();
      envMapGen.dispose();
      scene.environment = null;
      for (const o of bin) o.dispose();
      bin.length = 0;
      scene.remove(sky, ridges, ocean, rain, hemi, sun, sun.target, gantryGroup);
      sun.dispose?.();
      hemi.dispose?.();
      scene.fog = null;
    },
  };
}
