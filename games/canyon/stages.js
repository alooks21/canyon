// Stages, biomes and times of day. Pure data plus two tiny helpers — change a number
// here and the road, terrain, colours and lighting all follow.
//
// A biome is three things: how the road is laid out (`road`), what the land does
// beside it (`terrain`), and what it looks like (`palette`, `props`). Time of day is
// separate so the same canyon can be ridden at noon or at night.

export const BIOMES = {
  // Sweepers between sandstone walls. Strata terraces give the layered-rock look.
  desert: {
    name: 'Desert canyon',
    road: {
      halfWidth: 3.7, shoulder: 0.9, wander: 0.4,
      mix: { straight: 0.2, sweeper: 0.44, corner: 0.26, esses: 0.1, hairpin: 0 },
      straight: [60, 190], sweeperR: [130, 320], sweeperAng: [25, 75],
      cornerR: [55, 115], cornerAng: [35, 95], essesR: [70, 130], essesAng: [25, 55],
      hairpinR: [15, 20], leg: [40, 90],
      gradeMax: 0.04, gradeBias: 0, gradeLen: [150, 380], gradeBlend: [60, 140], yRange: [60, 260],
    },
    terrain: { mode: 'canyon', up: [34, 86], soft: 15, strata: 0, rough: 5.5, floor: [0, 26] },
    palette: {
      verge: 0xa8805a, ground: [0xb98b5f, 0xa9774e, 0x9c6a45], rock: 0xa24f2f,
      strata: [0xb8552f, 0xd98b5a, 0xf0d2a2, 0x9a3f26, 0xcd7648, 0xe8c08a, 0x7e4a3a, 0xc76a40],
      sand: null,
    },
    props: [
      { type: 'boulder', density: 0.9, minT: 2, maxSlope: 3, scale: [0.6, 2.6], tint: 0xb5603a },
      { type: 'juniper', density: 0.35, minT: 4, maxSlope: 0.9, scale: [0.8, 1.6], tint: 0x6d7a45 },
      { type: 'joshua', density: 0.18, minT: 5, maxSlope: 0.5, scale: [0.9, 1.5], tint: 0x7a8550 },
    ],
  },

  // Santa-Monica-Mountains feel: tight technical corners over rolling chaparral.
  chaparral: {
    name: 'Chaparral hills',
    road: {
      halfWidth: 3.5, shoulder: 0.7, wander: 0.45,
      mix: { straight: 0.1, sweeper: 0.18, corner: 0.42, esses: 0.26, hairpin: 0.04 },
      straight: [30, 110], sweeperR: [90, 200], sweeperAng: [25, 70],
      cornerR: [32, 80], cornerAng: [40, 120], essesR: [38, 75], essesAng: [30, 70],
      hairpinR: [16, 22], leg: [30, 70],
      gradeMax: 0.07, gradeBias: 0, gradeLen: [110, 300], gradeBlend: [40, 100], yRange: [150, 520],
    },
    terrain: { mode: 'hills', up: [-26, 38], soft: 20, strata: 0, rough: 7 },
    palette: {
      verge: 0x9b8462, ground: [0xb79e63, 0x8c8f55, 0x6a7646], rock: 0x8c826f,
      strata: null, sand: null,
    },
    props: [
      { type: 'shrub', density: 2.2, minT: 1.5, maxSlope: 1.4, scale: [0.7, 1.8], tint: 0x5d6b3e },
      { type: 'oak', density: 0.3, minT: 5, maxSlope: 0.7, scale: [0.8, 1.4], tint: 0x55663a },
      { type: 'boulder', density: 0.3, minT: 2, maxSlope: 3, scale: [0.5, 1.6], tint: 0x8f8574 },
    ],
  },

  // Granite and pines. Hairpins stack into switchbacks as the road climbs.
  pine: {
    name: 'Mountain pines',
    road: {
      halfWidth: 3.5, shoulder: 0.8, wander: 0.6,
      mix: { straight: 0.12, sweeper: 0.16, corner: 0.3, esses: 0.12, hairpin: 0.3 },
      straight: [40, 140], sweeperR: [110, 240], sweeperAng: [25, 70],
      cornerR: [35, 90], cornerAng: [35, 100], essesR: [45, 85], essesAng: [25, 60],
      hairpinR: [14, 19], leg: [60, 140],
      gradeMax: 0.035, gradeBias: 0.055, gradeLen: [140, 320], gradeBlend: [50, 110], yRange: [300, 1500],
    },
    terrain: { mode: 'slope', up: [36, 74], down: [-34, -70], soft: 21, strata: 0, rough: 5.5, upDir: [1, 0] },
    palette: {
      verge: 0x7d6b53, ground: [0x5a6a3c, 0x455832, 0x3d4f2f], rock: 0x8c8b86,
      strata: null, sand: null,
    },
    props: [
      { type: 'pine', density: 2.6, minT: 2.5, maxSlope: 1.3, scale: [0.8, 1.7], tint: 0x2f4a2c },
      { type: 'boulder', density: 0.6, minT: 2, maxSlope: 3, scale: [0.6, 2.2], tint: 0x8f8e88 },
    ],
  },

  // Bluffs above the ocean (which lies to the left of the main direction, −z).
  coast: {
    name: 'Coastal bluffs',
    road: {
      halfWidth: 3.7, shoulder: 1.2, wander: 0.35,
      mix: { straight: 0.2, sweeper: 0.5, corner: 0.2, esses: 0.1, hairpin: 0 },
      straight: [60, 220], sweeperR: [150, 400], sweeperAng: [20, 70],
      cornerR: [70, 140], cornerAng: [30, 80], essesR: [90, 160], essesAng: [20, 45],
      hairpinR: [18, 24], leg: [40, 90],
      gradeMax: 0.045, gradeBias: 0, gradeLen: [150, 400], gradeBlend: [60, 140], yRange: [28, 110],
    },
    terrain: { mode: 'coast', up: [18, 58], soft: 20, seaSoft: 11, seaFloor: -9, strata: 0, rough: 5, oceanDir: [0, -1] },
    palette: {
      verge: 0x9a8a68, ground: [0x93a05e, 0x75844a, 0x5e6d3f], rock: 0xb09772,
      strata: null, sand: 0xd8c79a,
    },
    props: [
      { type: 'shrub', density: 1.5, minT: 1.5, maxSlope: 1.2, scale: [0.6, 1.5], tint: 0x6f7f45 },
      { type: 'cypress', density: 0.35, minT: 5, maxSlope: 0.6, scale: [0.8, 1.5], tint: 0x34502f },
      { type: 'boulder', density: 0.4, minT: 2, maxSlope: 3, scale: [0.5, 1.8], tint: 0xa8916c },
    ],
  },

  // The pine mountain again, descending — ridden at night.
  night: {
    name: 'Mountain descent',
    road: {
      halfWidth: 3.5, shoulder: 0.8, wander: 0.5,
      mix: { straight: 0.12, sweeper: 0.25, corner: 0.35, esses: 0.18, hairpin: 0.1 },
      straight: [40, 150], sweeperR: [110, 260], sweeperAng: [25, 70],
      cornerR: [38, 95], cornerAng: [35, 100], essesR: [45, 90], essesAng: [25, 60],
      hairpinR: [15, 20], leg: [50, 120],
      gradeMax: 0.035, gradeBias: -0.045, gradeLen: [140, 320], gradeBlend: [50, 110], yRange: [80, 1400],
    },
    terrain: { mode: 'slope', up: [36, 76], down: [-30, -62], soft: 20, strata: 0, rough: 5.5, upDir: [-1, 0] },
    palette: {
      verge: 0x6f604d, ground: [0x52603a, 0x435432, 0x3a4a2d], rock: 0x7f7e7a,
      strata: null, sand: null,
    },
    props: [
      { type: 'pine', density: 2.2, minT: 2.5, maxSlope: 1.3, scale: [0.8, 1.7], tint: 0x2c4429 },
      { type: 'boulder', density: 0.6, minT: 2, maxSlope: 3, scale: [0.6, 2.2], tint: 0x85847e },
    ],
  },
};

// Lighting and sky. `sun` is elevation/azimuth in degrees (azimuth measured from +x
// toward +z — the road's main direction is +x).
export const TOD = {
  // Endless only: the sun just up behind you, low and pink.
  dawn:      { sun: [9, 110], sunColor: 0xffb48c, sunI: 2.6, hemiSky: 0xb7b5cc, hemiGround: 0x5a4a4a, hemiI: 0.85,
               zenith: 0x34548f, horizon: 0xf2b49c, fog: 0xd8b2a8, fogNear: 140, fogFar: 950, exposure: 1.05, stars: 0.12 },
  golden:   { sun: [16, 292], sunColor: 0xffc48a, sunI: 3.2, hemiSky: 0xc4c4d2, hemiGround: 0x7a5038, hemiI: 0.95,
               zenith: 0x2f6bc2, horizon: 0xf6c08a, fog: 0xe8b98f, fogNear: 160, fogFar: 1000, exposure: 1.0, stars: 0 },
  midday:    { sun: [62, 160], sunColor: 0xfff3df, sunI: 3.1, hemiSky: 0xbcd6f2, hemiGround: 0x8a7a5c, hemiI: 1.25,
               zenith: 0x3c78cb, horizon: 0xbdd5ee, fog: 0xc7daed, fogNear: 220, fogFar: 1150, exposure: 0.95, stars: 0 },
  afternoon: { sun: [33, 235], sunColor: 0xffe5c0, sunI: 3.0, hemiSky: 0xb2cae6, hemiGround: 0x5c5940, hemiI: 1.15,
               zenith: 0x3a6fbf, horizon: 0xc8d8e9, fog: 0xbdcfe0, fogNear: 150, fogFar: 950, exposure: 1.0, stars: 0 },
  sunset:    { sun: [7, 250], sunColor: 0xffa566, sunI: 2.9, hemiSky: 0xa4abc0, hemiGround: 0x4b3a2f, hemiI: 0.9,
               zenith: 0x31508f, horizon: 0xffa46d, fog: 0xe0a17d, fogNear: 170, fogFar: 1050, exposure: 1.05, stars: 0.06 },
  night:     { sun: [36, 140], sunColor: 0x9cb1ff, sunI: 0.5, hemiSky: 0x26375e, hemiGround: 0x0c0e16, hemiI: 0.55,
               zenith: 0x040814, horizon: 0x172240, fog: 0x0e1527, fogNear: 60, fogFar: 640, exposure: 1.1, stars: 1,
               headlight: true },
};

// The five authored stages. `seed` fixes the road forever, so medal times and ghosts
// stay comparable between runs. Total ≈ 22 km.
export const STAGES = [
  { id: 'narrows',  name: 'Sandstone Narrows', biome: 'desert',    tod: 'golden',    seed: 1101, length: 4200, y0: 120, traffic: 0.6,
    blurb: 'Red-rock canyon. Fast sweepers between sandstone walls.' },
  { id: 'ridge',    name: 'Chaparral Ridge',   biome: 'chaparral', tod: 'midday',    seed: 2207, length: 3800, y0: 260, traffic: 0.8,
    blurb: 'Tight, technical twisties over sun-baked hills.' },
  { id: 'crest',    name: 'Pine Crest',        biome: 'pine',      tod: 'afternoon', seed: 3313, length: 4400, y0: 420, traffic: 0.5,
    blurb: 'Climbing switchbacks through the pines.' },
  { id: 'bluffs',   name: 'Ocean Bluffs',      biome: 'coast',     tod: 'sunset',    seed: 4421, length: 5200, y0: 70,  traffic: 0.9,
    blurb: 'Fast and flowing above the Pacific at sunset.' },
  { id: 'midnight', name: 'Midnight Descent',  biome: 'night',     tod: 'night',     seed: 5531, length: 4600, y0: 950, traffic: 0.4,
    blurb: 'Down the mountain with nothing but your headlight.' },
];

// Endless: a never-ending stream of regions that mix the biomes' parts (road style ×
// land shape × look) with weather, tunnels, bridges and towns. See regions.js.
export const ENDLESS = {
  id: 'endless', name: 'Endless Ride',
  y0: 140, traffic: 0.8,
  blurb: 'Ride until you call it. Style points bank every 1.5 km — crash and you lose what you were carrying.',
};
