// RS 660 engine sound — synthesised from the firing order, not sampled.
//
// The parallel twin uses a 270° crank (from training; 1000ps calls it "crankpin
// offset"): over one 720° four-stroke cycle the two cylinders fire at 0° and 270°,
// so the gaps alternate 270° / 450°. That uneven beat is why it sounds like a
// V-twin and not a sewing machine. Each firing is a pressure pulse that rings
// through fixed resonances — exhaust (~95 Hz, ~210 Hz) and intake/mechanical
// (~650 Hz). The resonances stay put while the firing rate climbs, which is what
// keeps a real engine from sounding like a sped-up tape.

const TWO_PI = Math.PI * 2;

class Biquad {
  constructor(type, f, q, sr) { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(type, f, q, sr); }
  set(type, f, q, sr) {
    const w = TWO_PI * f / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2;
    if (type === 'bp') { b0 = a; b1 = 0; b2 = -a; }
    else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }          // lowpass
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - a) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Engine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1300, minValue: 0, maxValue: 14000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const sr = sampleRate;
    this.theta = 0;                       // crank angle within the 720° cycle
    this.env = 0;                         // current pulse envelope
    this.amp = 0;
    this.pop = 0;
    this.seed = 12345;
    this.ex1 = new Biquad('bp', 95, 2.2, sr);
    this.ex2 = new Biquad('bp', 210, 3.0, sr);
    this.ink = new Biquad('bp', 650, 2.0, sr);
    this.body = new Biquad('lp', 2600, 0.7, sr);
    this.rumble = 0;
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }
  process(_, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const rpm = params.rpm[0], load = params.load[0], cut = params.cut[0] > 0.5;
    const dTheta = rpm / 60 * 360 / sampleRate;
    const decay = Math.exp(-1 / (sampleRate * (0.0022 + 0.0016 * (1 - Math.min(1, rpm / 9000)))));
    const strength = 0.35 + 0.65 * load;
    const overrun = load < 0.08 && rpm > 4200;
    for (let i = 0; i < out.length; i++) {
      const before = this.theta;
      this.theta += dTheta;
      if (this.theta >= 720) this.theta -= 720;
      // Firing events at 0° and 270° of the cycle.
      const fired = (before < 270 && this.theta >= 270) || this.theta < before;
      if (fired && !cut) {
        this.env = strength * (0.9 + 0.2 * this.rnd());
        // Over-run: unburnt mixture popping in the pipe.
        if (overrun && this.rnd() > 0.82) this.pop = 1.4 + this.rnd() * 0.5;
      }
      this.env *= decay;
      this.pop *= 0.9993;
      const n = this.rnd();
      const x = this.env * (0.7 + 0.3 * n) + this.pop * n * (this.pop > 0.05 ? 1 : 0) * 0.6;
      // Cycle-rate lope: the 270/450 rhythm has a strong component at rpm/120 Hz.
      this.rumble += (this.env - this.rumble) * 0.004;
      const y = this.ex1.run(x) * 1.6 + this.ex2.run(x) * 1.1 + this.ink.run(x) * (0.25 + 0.5 * load) + this.rumble * 0.35;
      out[i] = this.body.run(y) * 0.9;
    }
    return true;
  }
}

registerProcessor('rs660-engine', Engine);
