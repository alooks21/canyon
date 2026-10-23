// Ride to my music: the tap. An AudioWorklet that mixes whatever reaches its input
// down to mono and posts it to the main thread in blocks of 1024 samples, where
// music-analysis.js turns each block into numbers and drops it. It has no output,
// so nothing it hears is played again, and it keeps nothing but the block it's filling.
// No input (the source stopped) still posts blocks — of silence — so the analysis
// can tell the music paused.

const BLOCK = 1024;

class MusicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
    this.on = true;
    this.port.onmessage = e => { if (e.data === 'stop') this.on = false; };
  }

  process(inputs) {
    if (!this.on) return false;
    const chans = inputs[0] || [], nc = chans.length, len = nc ? chans[0].length : 128;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < nc; c++) v += chans[c][i];
      this.buf[this.n++] = nc ? v / nc : 0;
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('canyon-music-tap', MusicTap);
