// The bike: Aprilia RS 660 Factory, "Dark Banshee" livery (2025 model year).
//
// Every number is tagged with where it came from. VERIFIED values were read from
// Aprilia's own documents on 2026-10-01; everything else is a game value I chose and
// is labelled as such — the garage screen shows both, so nobody mistakes a tuning
// number for a factory figure.

export const SOURCES = {
  spec: 'Aprilia, "RS 660 Factory - Technical Specification" (wlassets.aprilia.com)',
  site: 'aprilia.com — RS 660 range page ("true top speed of 240 km/h")',
  livery: 'Piaggio Group Wide magazine, 5 Mar 2025 ("Aprilia RS 660 Factory, Dark Banshee")',
};

// ---------- VERIFIED: Aprilia's technical specification ----------
export const FACTORY = {
  engine: 'Parallel twin, 4 valves per cylinder, liquid-cooled, ride-by-wire',
  displacementCc: 659,
  boreMm: 81, strokeMm: 63.93,
  powerHp: 105, powerKw: 77.2, powerRpm: 10400,
  torqueNm: 70, torqueRpm: 8400,
  gears: 6,
  clutch: 'Multi-plate wet clutch with slipper system',
  frame: 'Twin-spar aluminium',
  fork: 'Öhlins Ø43 mm USD, fully adjustable, 120 mm travel',
  shock: 'Öhlins monoshock, fully adjustable, 130 mm travel',
  brakeFront: 'Double Ø320 mm floating discs, Brembo radial calipers',
  brakeRear: 'Ø220 mm disc, Brembo caliper',
  wheels: 'Cast 17 × 3.5 in front, 17 × 5.5 in rear',
  seatHeightMm: 820,
  tankL: 15,
  wetKg: 183,
  topSpeedKmh: 240,                // aprilia.com (the range page, not the PDF)
  electronics: 'APRC with 6-axis IMU: ATC traction control, AWC wheelie control, AEB engine brake, AEM engine maps, cornering ABS with rear-wheel lift-up mitigation, ALC launch control, ACC cruise control, AQS quickshifter',
};

// ---------- GAME VALUES: not published by Aprilia (tuned or estimated) ----------
export const TUNED = {
  riderKg: 75,                     // a typical rider in leathers
  // Piaggio press release for the RS 660 (10 Oct 2020): 1370 mm wheelbase, 1995 mm
  // long, 24.1° rake, 104.6 mm trail. Not on the Factory's own sheet; the Factory is
  // taken to share the chassis [unverified for the Factory specifically].
  wheelbaseM: 1.37,
  // Combined centre of mass, estimated: bike (183 kg) ~0.55 m up and mid-wheelbase,
  // rider (75 kg) ~1.05 m up and ~0.45 m ahead of the rear axle. That puts the
  // wheelie threshold at ~0.87 g — reachable in 1st, not in 2nd, as on the real bike.
  cogFromRearM: 0.61,
  cogHeightM: 0.70,
  wheelRadiusM: 0.305,             // rolling radius of a 180/55-17 sport tyre (size assumed)
  idleRpm: 1300,
  limiterRpm: 11500,
  // Overall reduction (crank → rear wheel) per gear. Picked for sensible gear speeds;
  // Aprilia doesn't publish the ratios on the spec sheet.
  ratios: [13.0, 9.3, 7.62, 6.51, 5.75, 5.09],     // ≈ 102/142/174/203/230/260 km/h at the limiter
  drivelineEff: 0.9,
  mu: 1.15,                        // peak grip of a warm sport tyre on dry asphalt
  rollingCoeff: 0.014,
  airDensity: 1.2,
  // Firing order: a 270° crank (uneven 270°/450° intervals), from training and
  // consistent with 1000ps's "crankpin offset" — not on Aprilia's sheet. Sets the sound.
  crankDeg: 270,
};

// Full-throttle torque curve (rpm, Nm). It passes through Aprilia's peak torque
// (70 Nm @ 8,400). Aprilia's two headline figures can't both be met exactly: 77.2 kW
// at 10,400 rpm needs 70.9 Nm there, more than the stated 70 Nm peak. Holding 70 Nm
// flat to 10,400 gives 76.2 kW — within 1.3%, and the stated peak torque stays true.
export const TORQUE_CURVE = [
  [1000, 30], [2000, 42], [3000, 48], [4500, 55], [6000, 62], [7200, 67],
  [8400, 70], [10400, 70], [11000, 66], [11500, 62], [12000, 40],
];

export function torqueAt(rpm) {
  const c = TORQUE_CURVE;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1], [r1, t1] = c[i];
      return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
    }
  }
  return c[c.length - 1][1];
}
