// Kit models — Kenney, CC0 (assets/<kit>/LICENSE.txt): the trees, rocks, guardrail and
// sign post that dress the world. world.js keeps every placement rule; this file only
// decides what a prop *is*.
//
// Each .glb becomes ONE non-indexed geometry with a colour per vertex, chosen by the kit
// material's NAME from the table below. The kits' own colours are pastel mint; these are
// the game's palette (the same colours the procedural props used), and with no textures
// every prop keeps sharing world.js's single vertex-coloured material.
//
// Fetched once per page (the module is cached between plays). Never rejects: a model that
// fails is left out, world.js falls back to its procedural stand-in, and one warning is
// logged.

import * as THREE from '../../vendor/three.module.js';

const BASE = new URL('./assets/', import.meta.url);
const ROCK = { dirt: 0xffffff, stone: 0xffffff, grass: 0xd6d6d6, _defaultMat: 0xe6e6e6 };   // tinted per biome

// w / h: the fitted size in metres — the procedural prop's size, so sightlines and the
// verge stay as they were (w alone or h alone scales uniformly; both stretch). sink: the
// share of the height pushed below ground, so a rock on a slope doesn't float.
// unit: fitted to a 1 m cube (centred on x/z, base at 0) for world.js to stretch.
export const MODELS = {
  pine:     { file: 'nature-kit/tree_pineDefaultA.glb', h: 7.2, sink: 0.02, colors: { leafsDark: 0x355632, woodBarkDark: 0x5a4231 } },
  pineFar:  { file: 'nature-kit/tree_pineTallA.glb', h: 7.2, sink: 0.02, colors: { leafsDark: 0x355632, woodBarkDark: 0x5a4231 } },  // far LOD: 78 triangles, not 230
  juniper:  { file: 'nature-kit/tree_fat.glb', h: 2.7, sink: 0.03, colors: { leafsGreen: 0x66743f, woodBark: 0x5e4a38 } },
  joshua:   { file: 'nature-kit/cactus_tall.glb', h: 4.0, sink: 0.02, colors: { leafsGreen: 0x5f703c } },
  oak:      { file: 'nature-kit/tree_oak.glb', w: 4.2, h: 5.2, sink: 0.02, colors: { leafsGreen: 0x4f6235, woodBark: 0x4f3f30 } },
  cypress:  { file: 'nature-kit/tree_plateau.glb', w: 4.6, h: 4.5, sink: 0.02, colors: { leafsGreen: 0x34502f, woodBark: 0x4a3a2c } },
  shrub:    { file: 'nature-kit/plant_bushLarge.glb', w: 2.0, sink: 0.1, colors: { grass: 0xffffff } },
  boulder:  { file: 'nature-kit/rock_largeB.glb', w: 2.4, sink: 0.2, colors: ROCK },     // small boulders
  boulder2: { file: 'nature-kit/rock_largeD.glb', w: 2.6, sink: 0.2, colors: ROCK },     // mid
  boulder3: { file: 'nature-kit/rock_tallB.glb', w: 2.4, sink: 0.15, colors: ROCK },     // the big ones: a rock spire
  rail:     { file: 'racing-kit/rail.glb', unit: true, colors: { grey: 0xaab1b6 } },
  post:     { file: 'city-kit-roads/road-sign-empty.glb', unit: true },
};

let cached = null;
// Resolves to { name: BufferGeometry } for the models that loaded, or null if none did.
export function loadKit(onProgress = () => {}) {
  if (cached) { onProgress(1); return cached; }
  cached = load(onProgress);
  cached.then(k => { if (!k) cached = null; });     // nothing loaded: try again next visit
  return cached;
}

async function load(onProgress) {
  const keys = Object.keys(MODELS), part = {};
  const report = () => onProgress(keys.reduce((a, k) => a + (part[k] || 0), 0) / keys.length);
  let loader;
  try {
    const { GLTFLoader } = await import('../../vendor/GLTFLoader.js');
    loader = new GLTFLoader();
  } catch (e) {
    console.warn(`Canyon: model loader unavailable (${e.message}); using procedural props`);
    onProgress(1);
    return null;
  }
  const kit = {}, failed = [];
  await Promise.all(keys.map(async k => {
    try {
      const gltf = await loader.loadAsync(new URL(MODELS[k].file, BASE).href,
        e => { if (e.total) { part[k] = 0.95 * e.loaded / e.total; report(); } });
      kit[k] = bake(gltf.scene, MODELS[k]);
    } catch (e) { failed.push(`${k} (${e.message || e})`); }
    part[k] = 1; report();
  }));
  if (failed.length) console.warn(`Canyon: ${failed.length} kit model(s) failed, procedural stand-ins used: ${failed.join(', ')}`);
  return Object.keys(kit).length ? kit : null;
}

// Every mesh in the scene → one geometry in model space (node transforms applied), then
// fitted. fromBufferAttribute de-quantizes the int16 positions the optimizer wrote.
function bake(root, spec) {
  root.updateMatrixWorld(true);
  const pos = [], col = [], v = new THREE.Vector3(), c = new THREE.Color();
  root.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : p.count;
    c.setHex(spec.colors?.[o.material.name] ?? 0xffffff);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      pos.push(v.x, v.y, v.z);
      col.push(c.r, c.g, c.b);
    }
  });
  if (!pos.length) throw new Error('no meshes');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingBox();
  const b = geo.boundingBox, sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  if (spec.unit) geo.scale(1 / sx, 1 / sy, 1 / sz);
  else {
    const kw = spec.w ? spec.w / Math.max(sx, sz) : spec.h / sy, ky = spec.h ? spec.h / sy : kw;
    geo.scale(kw, ky, kw);
    geo.translate(0, -spec.sink * sy * ky, 0);
  }
  geo.computeVertexNormals();          // non-indexed → flat face normals
  geo.computeBoundingSphere();
  return geo;
}

// The bike's painted bodywork with its livery baked into a texture (tools/blender/bake-livery.py
// → assets/bike/rs660-body.glb): the code-built body's exact shape plus UVs, the red read from
// Piaggio's side photo. Resolves to { geometry, map, fingerprint } for bike-model.js useBody(),
// or null with one warning (the code-built, vertex-coloured paint then stays).
let bodyCached = null;
export function loadBikeBody(onProgress = () => {}) {
  if (bodyCached) { onProgress(1); return bodyCached; }
  bodyCached = (async () => {
    try {
      const { GLTFLoader } = await import('../../vendor/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(new URL('bike/rs660-body.glb', BASE).href,
        e => { if (e.total) onProgress(0.95 * e.loaded / e.total); });
      const mesh = gltf.scene.getObjectByName('body');
      if (!mesh?.isMesh || !mesh.material.map || !mesh.geometry.attributes.uv) throw new Error('no textured body mesh');
      // The file is quantized (KHR_mesh_quantization): positions are int16 on a grid that the
      // node's transform scales back to metres. Bake that transform in, as floats.
      gltf.scene.updateMatrixWorld(true);
      const m = mesh.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3();
      const geometry = mesh.geometry.clone();
      for (const [key, xf] of [['position', p => p.applyMatrix4(m)], ['normal', n => n.applyMatrix3(nm).normalize()]]) {
        const a = geometry.attributes[key], out = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) xf(v.fromBufferAttribute(a, i)).toArray(out, i * 3);
        geometry.setAttribute(key, new THREE.BufferAttribute(out, 3));
      }
      geometry.computeBoundingSphere();
      return { geometry, map: mesh.material.map, fingerprint: mesh.userData.fingerprint };
    } catch (e) {
      console.warn(`Canyon: baked livery failed (${e.message || e}); using the code-built paint`);
      return null;
    } finally { onProgress(1); }
  })();
  bodyCached.then(b => { if (!b) bodyCached = null; });   // try again next visit
  return bodyCached;
}

// The bike as drawn — a Yamaha R1M: "Yamaha R1M" by shindedhirendra780 on Sketchfab, CC BY 4.0
// (credit in the README), cut down and split onto bike-model.js's rig by tools/blender/build-r1m.py
// → assets/bike/r1m.glb. Physics stays the RS 660's (spec.js). One node per rig part, at its pivot:
// body, steer, frontCarrier, frontSpin, swing, rearSpin, each with its meshes in the bike's axes;
// and the rider's anchors gripL/gripR/pegL/pegR. Resolves to { parts: { node: [{ geometry,
// material }] }, pivots: { node: Vector3 }, anchors: { name: Vector3 } } (model space, float
// geometry relative to each pivot) for bike-model.js useBike(), or null with one warning (the
// code-built RS 660 then stays).
const RIG = ['body', 'steer', 'frontCarrier', 'frontSpin', 'swing', 'rearSpin'];
let bikeCached = null;
export function loadBikeModel(onProgress = () => {}) {
  if (bikeCached) { onProgress(1); return bikeCached; }
  bikeCached = (async () => {
    try {
      const { GLTFLoader } = await import('../../vendor/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(new URL('bike/r1m.glb', BASE).href,
        e => { if (e.total) onProgress(0.95 * e.loaded / e.total); });
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const node = n => scene.getObjectByName(n) ?? (() => { throw new Error(`no "${n}" node`); })();
      const at = n => node(n).getWorldPosition(new THREE.Vector3());
      const parts = {}, pivots = {}, anchors = {};
      for (const n of RIG) {
        const pivot = node(n), inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
        pivots[n] = at(n);
        parts[n] = [];
        // Quantized (KHR_mesh_quantization) like the livery: bake each mesh's transform, relative to
        // its pivot, into float positions and normals.
        pivot.traverse(o => {
          if (!o.isMesh) return;
          const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3();
          const geometry = o.geometry.clone();
          for (const [key, xf] of [['position', p => p.applyMatrix4(m)], ['normal', q => q.applyMatrix3(nm).normalize()]]) {
            const a = geometry.attributes[key], out = new Float32Array(a.count * 3);
            for (let i = 0; i < a.count; i++) xf(v.fromBufferAttribute(a, i)).toArray(out, i * 3);
            geometry.setAttribute(key, new THREE.BufferAttribute(out, 3));
          }
          geometry.computeBoundingSphere();
          parts[n].push({ geometry, material: o.material.name });
        });
        if (!parts[n].length) throw new Error(`"${n}" has no mesh`);
      }
      for (const n of ['gripL', 'gripR', 'pegL', 'pegR']) anchors[n] = at(n);
      return { parts, pivots, anchors };
    } catch (e) {
      console.warn(`Canyon: R1M model failed (${e.message || e}); using the code-built RS 660`);
      return null;
    } finally { onProgress(1); }
  })();
  bikeCached.then(b => { if (!b) bikeCached = null; });   // try again next visit
  return bikeCached;
}

// The rider — Quaternius "Universal Base Characters", CC0 (assets/rider/LICENSE.txt): one
// skinned body on a 65-bone skeleton (pelvis, spine_01–03, neck_01, Head, clavicle /
// upperarm / lowerarm / hand + fingers, thigh / calf / foot / ball, each side).
// bike-model.js poses it and colours it. Fetched once per page; resolves to
// { clone() → a scene with its own skeleton, sharing the geometry }, or null with one
// warning (bike-model.js then keeps its code-built rider).
let riderCached = null;
export function loadRider(onProgress = () => {}) {
  if (riderCached) { onProgress(1); return riderCached; }
  riderCached = (async () => {
    try {
      const [{ GLTFLoader }, { clone }] = await Promise.all([import('../../vendor/GLTFLoader.js'), import('../../vendor/SkeletonUtils.js')]);
      const gltf = await new GLTFLoader().loadAsync(new URL('rider/rider.glb', BASE).href,
        e => { if (e.total) onProgress(0.95 * e.loaded / e.total); });
      if (!gltf.scene.getObjectByProperty('isSkinnedMesh', true)) throw new Error('no skinned mesh');
      return { clone: () => clone(gltf.scene) };
    } catch (e) {
      console.warn(`Canyon: rider model failed (${e.message || e}); using the code-built rider`);
      return null;
    } finally { onProgress(1); }
  })();
  riderCached.then(r => { if (!r) riderCached = null; });   // try again next visit
  return riderCached;
}
