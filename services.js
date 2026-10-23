// Shared services. Every game gets these for free, so no game attaches its own
// global listeners — that's what makes cleanup reliable.

// ---------- input ----------
// Listeners live here for the life of the page. Games only ever READ state, so
// there is nothing for a game to forget to unbind.
const held = new Set();

addEventListener('keydown', e => {
  held.add(e.code);
  // stop arrow keys / space scrolling the page while playing
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => held.delete(e.code));
// If the tab loses focus mid-keypress the keyup never arrives and the key
// sticks down forever. Clearing on blur is the fix.
addEventListener('blur', () => held.clear());

const input = {
  isDown: code => held.has(code),
  reset: () => held.clear(),
};

// ---------- audio ----------
// Safari (and Chrome's autoplay policy) refuse to make sound until the user has
// interacted with the page. We create the context lazily on the first gesture.
let ctx = null;

function unlock() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}

const audio = {
  unlock,
  beep(freq = 440, ms = 60, type = 'square') {
    if (!ctx) return;              // no gesture yet — stay silent rather than throw
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // a short ramp instead of a hard stop, which would click
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  },
};

// ---------- save ----------
// localStorage throws in private windows and when site data is blocked, so every
// access is wrapped. A missing high score is not worth crashing a game over.
const save = {
  high(id) {
    try { return Number(localStorage.getItem(`arcade:${id}:high`)) || 0; }
    catch { return 0; }
  },
  setHigh(id, value) {
    try { localStorage.setItem(`arcade:${id}:high`, String(value)); } catch {}
  },
};

export { input, audio, save };
