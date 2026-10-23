# vendor

Third-party code, committed on purpose so the arcade has no runtime CDN dependency
and works offline.

## three.js r186 (0.186.0) — MIT

`three.module.js` + `three.core.js`, the **minified** ESM builds from
`cdn.jsdelivr.net/npm/three@0.186.0/build/`. The `.min` suffix is dropped because
`three.module.js` imports `./three.core.js` by that exact filename.

Only the 3D games (`aim`, `canyon`) import these, and games load via dynamic
`import()`, so nobody who doesn't open a 3D game ever downloads them.

r186 note: `PCFSoftShadowMap` has been removed (it now warns and falls back), so
Canyon uses `PCFShadowMap`.

To upgrade, re-fetch both files at the new version and re-test the 3D games —
three.js makes breaking changes between revisions.

## glTF loading — same r186 release

Copied byte-for-byte from `projects/holdout/vendor/`, which fetched them from jsDelivr
`three@0.186.0/examples/jsm/` (2026-10-15) and rewrote only the import paths:

| File | From | Change |
|---|---|---|
| `GLTFLoader.js` | `loaders/GLTFLoader.js` | `'three'` → `'./three.module.js'`, `'../utils/X.js'` → `'./X.js'` |
| `BufferGeometryUtils.js`, `SkeletonUtils.js` | `utils/` (GLTFLoader imports both) | `'three'` → `'./three.module.js'` |

Only Canyon uses them (`games/canyon/assets.js`), loaded by dynamic `import()` once its kit models
are needed. No `DRACOLoader` or Draco decoder: Canyon's models are quantized
(`KHR_mesh_quantization`, which GLTFLoader reads natively). Draco would save ~34 KB of models and
cost a 344 KB decoder. If a future model needs Draco, holdout's `vendor/` has the loader and the
wasm decoder.
