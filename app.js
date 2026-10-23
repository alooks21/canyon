// The shell. Owns the game lifecycle so individual games stay small.
import { games } from './games/registry.js';
import { input, audio, save } from './services.js';

const $ = id => document.getElementById(id);
const lobby = $('lobby'), stage = $('stage'), back = $('back');
const canvas = $('screen'), overlay = $('overlay'), overlayText = $('overlay-text');

// The currently running game's controller, or null in the lobby.
// Exactly one game is ever live — that invariant is what keeps memory flat.
let current = null;
let currentId = null;

// ---------- lobby ----------
$('grid').innerHTML = games.map(g => `
  <li>
    <button class="card" data-id="${g.id}">
      <span class="card-title">${g.title}</span>
      <span class="card-blurb">${g.blurb}</span>
    </button>
  </li>`).join('');

$('grid').addEventListener('click', e => {
  const btn = e.target.closest('.card');
  if (btn) load(games.find(g => g.id === btn.dataset.id));
});

// ---------- the HUD handed to each game ----------
const hud = {
  setScore(n) {
    $('score').textContent = n;
    if (n > save.high(currentId)) {
      save.setHigh(currentId, n);
      $('best').textContent = n;
    }
  },
  setStatus(text) { $('status').textContent = text || ''; },
  // Games call this to show "Game over — click to retry" without knowing about the DOM.
  showOverlay(text) { overlayText.textContent = text; overlay.hidden = false; },
  hideOverlay() { overlay.hidden = true; },
};

// ---------- load / unload ----------
async function load(entry) {
  currentId = entry.id;
  lobby.hidden = true;
  stage.hidden = false;
  back.hidden = false;
  $('title').textContent = entry.title;
  $('score').textContent = '0';
  $('best').textContent = save.high(entry.id);
  hud.setStatus('Loading…');

  // Nothing for this game has been downloaded until this line runs.
  // The browser caches the module, so a second visit is instant.
  const mod = await import(entry.module);

  hud.setStatus('');
  hud.showOverlay('Click to start');

  // init() returns a controller rather than the module exporting a global
  // destroy(). Dynamic import caches modules, so module-level state would
  // survive between plays and leak into the next run. A fresh object per
  // load cannot.
  //
  // `mount` is for 3D games. A canvas can only ever hold ONE context type, so a
  // WebGL game must NOT take a context on the shared 2D canvas — doing that once
  // would make getContext('2d') return null forever and permanently break every
  // 2D game. 3D games create their own canvas inside `mount` and remove it in
  // destroy(). See README.
  current = mod.init(canvas, {
    input, audio, save, hud, id: entry.id,
    mount: canvas.parentElement,
  });
}

function unload() {
  // The single most important line in this file. Skip it and every game you've
  // played stays running invisibly, eating frames from the one on screen.
  current?.destroy();
  current = null;
  currentId = null;
  input.reset();

  // Wipe the canvas so the next game never inherits stale pixels.
  // Guarded: getContext returns null if something ever took a different context
  // type on this canvas, and an unload must never throw.
  const c2d = canvas.getContext('2d');
  if (c2d) c2d.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = false;   // a 3D game may have hidden it

  stage.hidden = true;
  back.hidden = true;
  lobby.hidden = false;
  hud.setStatus('');
  hud.hideOverlay();
}

back.addEventListener('click', unload);

// Deep link: /arcade/#canyon opens that game directly (the dashboard's per-game tiles use this).
// The hash tracks the current game so a reload or a shared link lands in the same place.
function openFromHash() {
  const entry = games.find(g => g.id === location.hash.slice(1));
  if (entry && currentId !== entry.id) { if (current) unload(); load(entry); }
  else if (!entry && current) unload();
}
const setHash = id => history.replaceState(null, '', id ? `#${id}` : location.pathname);
$('grid').addEventListener('click', e => { const b = e.target.closest('.card'); if (b) setHash(b.dataset.id); });
back.addEventListener('click', () => setHash(null));
addEventListener('hashchange', openFromHash);
openFromHash();

// First click anywhere on the stage unlocks audio. Browsers block sound until
// a real user gesture, so this is not optional — it's the price of WebAudio.
overlay.addEventListener('click', () => {
  audio.unlock();
  hud.hideOverlay();
  current?.start?.();
});

// Leaving the page mid-game should still run cleanup.
addEventListener('pagehide', () => current?.destroy());
