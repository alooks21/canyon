// UI — every screen and the riding HUD, as plain DOM layered over the 3D canvas.
//
// Sizes use container-query units (cqw) so the whole thing scales with the frame,
// whether it's the arcade's 846 px panel or fullscreen. All CSS lives in one
// <style> element that destroy() removes, so nothing leaks into the arcade shell.
// Buttons are real <button>s: Tab/Enter work natively; arrows and the gamepad
// d-pad move focus through moveFocus().

import { FACTORY, TUNED } from './spec.js';
import { STAGES, ENDLESS, BIOMES } from './stages.js';

const CSS = `
.cy{position:absolute;inset:0;container-type:size;font-family:"Segoe UI",Roboto,Arial,sans-serif;color:#f2f2f2;pointer-events:none;user-select:none;overflow:hidden}
.cy *{box-sizing:border-box}
.cy button{pointer-events:auto;font:inherit;color:inherit;cursor:pointer}
.cy .scr{position:absolute;inset:0;display:none;pointer-events:none}
.cy .scr.on{display:block}
.cy .panel{pointer-events:auto;background:rgba(10,11,14,.78);border:1px solid rgba(255,255,255,.08);border-radius:1cqw;backdrop-filter:blur(6px)}
.cy .btn{display:flex;align-items:center;gap:1cqw;width:100%;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:.7cqw;padding:1.05cqw 1.4cqw;font-size:1.7cqw;letter-spacing:.02em;transition:background .12s,border-color .12s,transform .12s}
.cy .btn:hover,.cy .btn:focus-visible{background:rgba(208,32,42,.22);border-color:#d0202a;outline:none;transform:translateX(.3cqw)}
.cy .btn small{margin-left:auto;color:#9aa0aa;font-size:1.25cqw}
.cy .btn[aria-pressed=true]{border-color:#d0202a}
.cy h1{margin:0;font-style:italic;font-weight:900;letter-spacing:.06em;font-size:5.4cqw;line-height:1}
.cy h1 b{color:#d0202a}
.cy h2{margin:0 0 1cqw;font-size:2.3cqw;font-style:italic;font-weight:800;letter-spacing:.04em}
.cy .sub{color:#b9bec7;font-size:1.45cqw;margin:.6cqw 0 1.8cqw}
.cy .dim{color:#9aa0aa}
.cy .red{color:#ff4a52}
.cy .grn{color:#4fd67a}
/* title / garage */
.cy .title{position:absolute;left:3cqw;top:4cqw;width:31cqw;padding:2.2cqw}
.cy .menu{display:flex;flex-direction:column;gap:.8cqw}
.cy .spec{position:absolute;right:2.5cqw;bottom:2.5cqw;width:58cqw;padding:1.1cqw 1.5cqw;font-size:1.12cqw;line-height:1.4}
.cy .spec dl{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:.15cqw 1cqw;margin:.6cqw 0 0}
.cy .spec dt{color:#9aa0aa}
.cy .spec dd{margin:0}
.cy .spec .src{margin-top:.6cqw;color:#7f8590;font-size:.95cqw}
.cy .tag{display:inline-block;font-size:.95cqw;padding:.1cqw .5cqw;border-radius:.4cqw;background:#d0202a;color:#fff;font-weight:700;letter-spacing:.06em;vertical-align:middle}
.cy .tag.grey{background:#3a3d45}
/* lists */
.cy .sheet{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:84cqw;max-height:94cqh;overflow:auto;padding:2cqw 2.2cqw;scrollbar-width:thin;scrollbar-color:#3a3e46 transparent}
.cy .stages{display:grid;grid-template-columns:repeat(3,1fr);gap:.9cqw}
.cy .stage{flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:.3cqw;padding:1cqw 1.2cqw}
.cy .stage:hover,.cy .stage:focus-visible{transform:translateY(-.2cqw)}
.cy .stage .nm{font-size:1.75cqw;font-weight:800;font-style:italic}
.cy .stage .meta{font-size:1.08cqw;color:#9aa0aa}
.cy .stage .best{font-size:1.15cqw;margin-top:auto;padding-top:.3cqw}
.cy .medal{display:inline-block;width:1.3cqw;height:1.3cqw;border-radius:50%;vertical-align:-.2cqw;margin-right:.3cqw;border:1px solid rgba(255,255,255,.35)}
.cy .m-gold{background:#e3b341}.cy .m-silver{background:#c5ccd6}.cy .m-bronze{background:#c27a43}.cy .m-none{background:transparent}
.cy .row{display:flex;gap:1cqw;margin-top:1.4cqw}
.cy .row .btn{justify-content:center}
.cy .grid2{display:grid;grid-template-columns:1fr 1fr;gap:.8cqw}
.cy .keys{display:grid;grid-template-columns:max-content max-content 1fr;gap:.35cqw 2cqw;font-size:1.3cqw;align-items:baseline}
.cy kbd{font-family:ui-monospace,Consolas,monospace;background:#22252b;border:1px solid #3a3e46;border-bottom-width:2px;border-radius:.35cqw;padding:0 .5cqw;font-size:1.15cqw}
.cy .tips{font-size:1.25cqw;line-height:1.5;color:#c9cdd4;margin-top:1.2cqw}
.cy .tips b{color:#fff}
/* results */
.cy .res-medal{font-size:3cqw;font-weight:900;font-style:italic;letter-spacing:.04em}
.cy .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.8cqw;margin-top:1.2cqw}
.cy .stat{background:rgba(255,255,255,.04);border-radius:.6cqw;padding:.8cqw 1cqw}
.cy .stat .v{font-size:2.1cqw;font-weight:800;font-style:italic}
.cy .stat .k{font-size:1.05cqw;color:#9aa0aa;text-transform:uppercase;letter-spacing:.08em}
/* HUD */
.cy .hud{position:absolute;inset:0;display:none}
.cy .hud.on{display:block}
.cy .tl{position:absolute;left:2cqw;top:1.8cqw;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.cy .tl .stg{font-size:1.15cqw;color:#c6cad1;letter-spacing:.08em;text-transform:uppercase}
.cy .tl .time{font-size:3.4cqw;font-weight:800;font-style:italic;font-variant-numeric:tabular-nums;line-height:1.05}
.cy .tl .split{font-size:1.6cqw;font-weight:700;font-variant-numeric:tabular-nums;min-height:2cqw}
.cy .tl .tgt{font-size:1.15cqw;color:#c6cad1}
.cy .tr{position:absolute;right:6cqw;top:1.8cqw;text-align:right;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.cy .tr .score{font-size:3cqw;font-weight:800;font-style:italic;font-variant-numeric:tabular-nums;line-height:1.05}
.cy .tr .combo{font-size:1.6cqw;font-weight:800;color:#ffcf4a}
.cy .tr .pend{font-size:1.2cqw;color:#c6cad1}
.cy .dash{position:absolute;left:2cqw;bottom:2cqw;width:33cqw;padding:1cqw 1.2cqw 1.1cqw;background:linear-gradient(180deg,rgba(8,9,12,.82),rgba(8,9,12,.7));border:1px solid rgba(255,255,255,.08);border-radius:1.1cqw}
.cy .rev{position:relative;height:1.5cqw;display:grid;grid-template-columns:repeat(24,1fr);gap:.18cqw}
.cy .rev i{background:#22252b;border-radius:.15cqw}
.cy .rev i.on{background:#e8e8e8}
.cy .rev i.on.hi{background:#ffb02e}
.cy .rev i.on.red{background:#ff2b36}
.cy .rev.flash i.on{background:#ff2b36;box-shadow:0 0 .8cqw #ff2b36}
.cy .dmain{display:flex;align-items:flex-end;justify-content:space-between;margin-top:.6cqw}
.cy .spd{font-size:5.4cqw;font-weight:900;font-style:italic;line-height:.9;font-variant-numeric:tabular-nums;color:#fff}
.cy .ln{white-space:nowrap}
.cy .unit{font-size:1.1cqw;color:#9aa0aa;margin-left:.4cqw;letter-spacing:.08em}
.cy .gear{font-size:4cqw;font-weight:900;line-height:.9;color:#ff3b45;font-style:italic;min-width:3cqw;text-align:center}
.cy .gl{font-size:.9cqw;color:#9aa0aa;text-align:center;letter-spacing:.1em}
.cy .lean{display:flex;align-items:center;gap:1cqw;margin-top:.7cqw}
.cy .lean svg{width:9cqw;height:5cqw;overflow:visible}
.cy .lean .ln{font-size:1.15cqw;line-height:1.35;color:#c6cad1;font-variant-numeric:tabular-nums}
.cy .aids{display:flex;gap:.45cqw;margin-left:auto}
.cy .aids span{font-size:.95cqw;font-weight:800;padding:.15cqw .45cqw;border-radius:.3cqw;border:1px solid #3a3e46;color:#5d626c;letter-spacing:.05em}
.cy .aids span.hot{color:#111;background:#ffb02e;border-color:#ffb02e}
.cy .aids span.offx{text-decoration:line-through}
.cy .map{position:absolute;right:2cqw;bottom:2cqw;width:15cqw;height:15cqw;border-radius:50%;background:rgba(8,9,12,.6);border:1px solid rgba(255,255,255,.1)}
.cy .msgs{position:absolute;left:0;right:0;top:24cqh;display:flex;flex-direction:column;align-items:center;gap:.5cqw}
.cy .msg{font-size:2.2cqw;font-weight:900;font-style:italic;letter-spacing:.05em;text-shadow:0 2px 6px rgba(0,0,0,.7);animation:cyPop 1.6s ease-out forwards}
.cy .msg.big{font-size:3.4cqw}
.cy .msg.warn{color:#ff4a52}
.cy .msg.good{color:#4fd67a}
.cy .msg.gold{color:#ffcf4a}
@keyframes cyPop{0%{opacity:0;transform:translateY(1cqw) scale(.9)}12%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0;transform:translateY(-1.5cqw)}}
.cy .count{position:absolute;inset:0;display:grid;place-items:center;font-size:12cqw;font-weight:900;font-style:italic;text-shadow:0 4px 18px rgba(0,0,0,.6);pointer-events:none}
.cy .count.go{color:#4fd67a}
.cy .fs{position:absolute;right:1.2cqw;top:1.2cqw;width:3.2cqw;height:3.2cqw;border-radius:.6cqw;background:rgba(10,11,14,.6);border:1px solid rgba(255,255,255,.15);display:grid;place-items:center;z-index:5}
.cy .fs svg{width:1.7cqw;height:1.7cqw}
.cy .hint{position:absolute;left:0;right:0;bottom:1.2cqw;text-align:center;font-size:1.15cqw;color:#c6cad1;text-shadow:0 1px 3px #000}
/* friends' ghosts */
.cy .gcols{display:grid;grid-template-columns:1fr 1fr;gap:1.8cqw}
.cy .gcols h3{margin:0 0 .5cqw;font-size:1.55cqw;font-style:italic}
.cy .gcols label{display:block;font-size:1.1cqw;color:#9aa0aa;margin:.4cqw 0 .3cqw}
.cy input[type=text],.cy textarea{pointer-events:auto;width:100%;font:1.2cqw/1.4 ui-monospace,Consolas,monospace;color:#f2f2f2;background:#0d0f13;border:1px solid #3a3e46;border-radius:.5cqw;padding:.6cqw .8cqw;user-select:text}
.cy textarea{height:7cqw;resize:none;word-break:break-all}
.cy input:focus-visible,.cy textarea:focus-visible{outline:2px solid #d0202a;outline-offset:1px}
.cy .glist{display:flex;flex-direction:column;gap:.4cqw;margin-top:.6cqw}
.cy .gitem{display:flex;align-items:center;gap:.6cqw;font-size:1.1cqw;line-height:1.3;background:rgba(255,255,255,.04);border-radius:.5cqw;padding:.35cqw .7cqw}
.cy .gitem .gname{flex:1;min-width:0}
.cy .gitem .btn{width:auto;padding:.35cqw .8cqw;font-size:1.05cqw}
.cy .btn:disabled{opacity:.35;cursor:default;transform:none;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09)}
.cy .gmsg{font-size:1.15cqw;min-height:1.6cqw;margin-top:.5cqw}
.cy .gcols .row{margin-top:.6cqw}
.cy .gcols .row .btn{font-size:1.3cqw;padding:.55cqw 1cqw}
.cy .gsheet .sub{margin-bottom:1.1cqw}
.cy .gsheet>.row{margin-top:.8cqw}
.cy .gsheet>.row .btn{padding:.7cqw 1.4cqw}
.cy .filebtn{position:relative;overflow:hidden}
.cy .filebtn input{position:absolute;inset:0;opacity:0;cursor:pointer;pointer-events:auto;width:100%}
.cy .filebtn:focus-within{background:rgba(208,32,42,.22);border-color:#d0202a}
.cy .tl .rival{font-size:1.3cqw;font-weight:700;font-variant-numeric:tabular-nums;color:#ffb347}
.cy .res-rival{font-size:1.5cqw;font-weight:700;margin-top:.5cqw;color:#ffb347}
.cy .loading{position:absolute;inset:0;display:none;place-items:center;background:rgba(6,7,9,.92);font-size:2cqw;font-style:italic;font-weight:800;letter-spacing:.1em;pointer-events:auto}
.cy .loading.on{display:grid}
/* race friends */
.cy .rsheet{width:66cqw}
.cy .rsheet label{display:block;font-size:1.1cqw;color:#9aa0aa;margin:.8cqw 0 .3cqw}
.cy .rsheet .row{margin-top:.6cqw;align-items:center}
.cy .rsheet .row .btn{width:auto;padding:.6cqw 1.3cqw;font-size:1.35cqw}
.cy .rsheet .row input{flex:1}
.cy .rcode{font-size:3.6cqw;font-weight:900;font-style:italic;letter-spacing:.25em;line-height:1}
.cy .rdot{display:inline-block;width:1.1cqw;height:1.1cqw;border-radius:50%;vertical-align:-.1cqw;margin-right:.5cqw}
.cy .rstages{display:grid;grid-template-columns:repeat(5,1fr);gap:.5cqw;margin-top:.4cqw}
.cy .rstages .btn{font-size:1.1cqw;justify-content:center;text-align:center;padding:.6cqw .4cqw}
.cy .rstages .btn[aria-pressed=true]{background:rgba(208,32,42,.3)}
.cy .rh{font-size:1.1cqw;color:#9aa0aa;margin:1cqw 0 .3cqw;text-transform:uppercase;letter-spacing:.08em}
.cy table.board{width:100%;border-collapse:collapse;font-size:1.35cqw;font-variant-numeric:tabular-nums}
.cy table.board td{padding:.35cqw .6cqw;border-bottom:1px solid rgba(255,255,255,.06)}
.cy table.board td.n{text-align:right;width:1%;white-space:nowrap}
.cy .rmine{font-size:1.5cqw;font-weight:700;margin:.3cqw 0 .6cqw}
/* ride to my music */
.cy .mchip{position:absolute;left:50%;top:1.8cqw;transform:translateX(-50%);display:none;align-items:center;gap:.9cqw;padding:.4cqw .5cqw .4cqw 1.2cqw;border-radius:2cqw;background:rgba(8,9,12,.72);border:1px solid rgba(255,255,255,.12);font-size:1.3cqw;font-weight:800;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.cy .mchip.on{display:flex}
.cy .mchip .mv{color:var(--vibe,#fff)}
.cy .mchip .mb{color:#c6cad1;font-variant-numeric:tabular-nums}
.cy .mchip .btn{width:auto;padding:.25cqw .8cqw;font-size:1.05cqw;text-transform:none}
.cy .cchip{position:absolute;left:50%;top:5.4cqw;transform:translateX(-50%);display:none;align-items:center;gap:.9cqw;padding:.3cqw .5cqw .3cqw 1.1cqw;border-radius:2cqw;background:rgba(8,9,12,.72);border:1px solid rgba(255,216,74,.35);font-size:1.1cqw;font-weight:700;color:#ffd84a;white-space:nowrap;font-variant-numeric:tabular-nums}
.cy .cchip.on{display:flex}
.cy .cchip .btn{width:auto;padding:.25cqw .8cqw;font-size:1.05cqw;text-transform:none}
.cy .hud.music .dash{box-shadow:0 0 calc(var(--beat,0) * 2.4cqw) rgba(255,59,69,calc(var(--beat,0) * .7))}
.cy .hud.music .spd{text-shadow:0 0 calc(var(--beat,0) * 1.6cqw) rgba(255,110,110,var(--beat,0))}
.cy .mrange{grid-column:1/-1;cursor:default}
.cy .mrange input{pointer-events:auto;margin-left:auto;width:40%;accent-color:#d0202a}
.cy .mrange output{min-width:3.5cqw;text-align:right;color:#9aa0aa;font-size:1.25cqw}
`;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = s => {
  if (s == null || !isFinite(s)) return '–:––.––';
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
};

export function createUI(mount, actions) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'cy';
  mount.appendChild(root);

  root.innerHTML = `
  <div class="scr" data-s="title">
    <div class="title panel">
      <h1>CANY<b>O</b>N</h1>
      <div class="sub">660 cc superbike · <span class="red">canyon roads</span></div>
      <div class="menu">
        <button class="btn" data-a="stages">Ride a stage <small>5 roads</small></button>
        <button class="btn" data-a="endless">Endless ride <small>no finish line</small></button>
        <button class="btn" data-a="music">Ride to my music <small>Endless, to a tab's sound</small></button>
        <button class="btn" data-a="race">Race friends <small>live, up to 4</small></button>
        <button class="btn" data-a="ghosts">Friends' ghosts <small>share and race runs</small></button>
        <button class="btn" data-a="demo">Watch a demo lap <small>autopilot</small></button>
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn" data-a="help">How to ride</button>
        <button class="btn" data-a="calibLast" hidden>Download last calibration</button>
      </div>
    </div>
    <div class="spec panel">
      <div><span class="tag">BIKE SPEC</span> <span class="dim">— a production 660 cc sport bike's published figures</span></div>
      <dl>
        <dt>Engine</dt><dd>${FACTORY.displacementCc} cc parallel twin</dd>
        <dt>Suspension</dt><dd>Adjustable fork (120 mm) · shock (130 mm)</dd>
        <dt>Power</dt><dd>${FACTORY.powerHp} HP (${FACTORY.powerKw} kW) @ ${FACTORY.powerRpm.toLocaleString()} rpm</dd>
        <dt>Brakes</dt><dd>Radial calipers, 2 × Ø320 mm · Ø220 mm rear</dd>
        <dt>Torque</dt><dd>${FACTORY.torqueNm} Nm @ ${FACTORY.torqueRpm.toLocaleString()} rpm</dd>
        <dt>Electronics</dt><dd>Traction · wheelie control · cornering ABS · quickshifter</dd>
        <dt>Weight</dt><dd>${FACTORY.wetKg} kg wet</dd>
        <dt>Top speed</dt><dd>${FACTORY.topSpeedKmh} km/h</dd>
      </dl>
      <div class="src"><span class="tag grey">GAME VALUES</span> gear ratios, redline ${TUNED.limiterRpm.toLocaleString()} rpm, centre of mass, tyre sizes and grip are tuned, not published by the manufacturer.</div>
    </div>
    <div class="hint">↑/↓ or Tab to choose · Enter to select · gamepad works too</div>
  </div>

  <div class="scr" data-s="music">
    <div class="sheet panel" style="width:58cqw">
      <h2>Ride to my music</h2>
      <div class="sub">Play music in another Chrome tab (Spotify, YouTube…), then share that tab's sound.
        The road follows it: tempo and brightness pick the scene (night, sunset, midday or storm), the tempo bends the road, and the lights pulse on the beat.
        Canyon only listens. It works out a few numbers live and keeps no audio; the music plays on in its own tab.</div>
      <div class="gmsg" id="cyMusicMsg" aria-live="polite"></div>
      <div class="row"><button class="btn" data-a="music">Choose the tab again</button><button class="btn" data-a="back">Back</button></div>
    </div>
  </div>

  <div class="scr" data-s="stages">
    <div class="sheet panel">
      <h2>Choose a road</h2>
      <div class="stages"></div>
      <div class="row"><button class="btn" data-a="back">Back</button></div>
    </div>
  </div>

  <div class="scr" data-s="settings">
    <div class="sheet panel">
      <h2>Settings</h2>
      <div class="grid2 setlist"></div>
      <div class="row"><button class="btn" data-a="back">Done</button></div>
    </div>
  </div>

  <div class="scr" data-s="ghosts">
    <div class="sheet panel gsheet">
      <h2>Friends' ghosts</h2>
      <div class="sub">Send your best run as a code or a file. Your friend loads it and races your ghost on the same road. No server and no account needed.</div>
      <div class="gcols">
        <section>
          <h3>Share yours</h3>
          <label for="cyGhostName">Name on your ghost</label>
          <input type="text" id="cyGhostName" maxlength="16" placeholder="Rider" autocomplete="off" spellcheck="false">
          <div class="glist" id="cyShareList"></div>
          <div class="gmsg" id="cyShareMsg" aria-live="polite"></div>
        </section>
        <section>
          <h3>Load a friend's</h3>
          <label for="cyGhostIn">Paste their code</label>
          <textarea id="cyGhostIn" placeholder="CANYON1.…" spellcheck="false"></textarea>
          <div class="row" style="margin-top:.6cqw">
            <button class="btn" data-a="importPaste">Load code</button>
            <span class="btn filebtn">Load a file<input type="file" id="cyGhostFile" accept=".canyonghost,.txt,text/plain" aria-label="Load a ghost file"></span>
          </div>
          <div class="gmsg" id="cyImportMsg" aria-live="polite"></div>
          <div class="glist" id="cyRivalList"></div>
        </section>
      </div>
      <div class="row"><button class="btn" data-a="back">Back</button></div>
    </div>
  </div>

  <div class="scr" data-s="race">
    <div class="sheet panel rsheet">
      <h2>Race friends</h2>
      <div class="sub">Up to 4 riders on the same road at once. You ride through each other, and there's no traffic.</div>
      <label for="cyNick">Your nickname</label>
      <input type="text" id="cyNick" maxlength="12" placeholder="Rider" autocomplete="off" spellcheck="false">
      <div class="rjoin">
        <div class="row"><button class="btn" data-a="raceCreate">Create a room</button></div>
        <label for="cyCode">Or join one: a code or a link</label>
        <div class="row"><input type="text" id="cyCode" maxlength="200" placeholder="KQZT" autocomplete="off" spellcheck="false"><button class="btn" data-a="raceJoin">Join</button></div>
      </div>
      <div class="rlobby" hidden></div>
      <div class="gmsg" id="cyRaceMsg" aria-live="polite"></div>
      <div class="row"><button class="btn" data-a="raceLeave" hidden>Leave the room</button><button class="btn" data-a="back">Back</button></div>
    </div>
  </div>

  <div class="scr" data-s="board">
    <div class="sheet panel rsheet" style="width:52cqw">
      <div class="rboard"></div>
      <div class="row"><button class="btn" data-a="quit">Back to the lobby</button></div>
    </div>
  </div>

  <div class="scr" data-s="help">
    <div class="sheet panel">
      <h2>How to ride</h2>
      <div class="keys">
        <span>Throttle</span><span><kbd>W</kbd> <kbd>↑</kbd></span><span class="dim">RT</span>
        <span>Brake (front + rear)</span><span><kbd>S</kbd> <kbd>↓</kbd></span><span class="dim">LT</span>
        <span>Lean left / right</span><span><kbd>A</kbd> <kbd>D</kbd> · <kbd>←</kbd> <kbd>→</kbd></span><span class="dim">left stick</span>
        <span>Tuck in (less drag)</span><span><kbd>Space</kbd></span><span class="dim">A</span>
        <span>Wheelie (hold, above 15 km/h)</span><span><kbd>Left Shift</kbd></span><span class="dim">B</span>
        <span>Shift down / up (manual box)</span><span><kbd>Q</kbd> <kbd>E</kbd></span><span class="dim">LB / RB</span>
        <span>Camera</span><span><kbd>C</kbd></span><span class="dim">Y</span>
        <span>Respawn</span><span><kbd>R</kbd></span><span class="dim">Back</span>
        <span>Pause</span><span><kbd>Esc</kbd> <kbd>P</kbd></span><span class="dim">Start</span>
        <span>Fullscreen</span><span><kbd>F</kbd></span><span class="dim"></span>
        <span>Ride to my music: sky (time of day) — night · sunset · midday · storm</span><span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></span><span class="dim"></span>
        <span>Ride to my music: back to automatic (scene and sky follow the music)</span><span><kbd>5</kbd></span><span class="dim"></span>
        <span>Ride to my music: new scene now (the sky follows the music again)</span><span><kbd>N</kbd></span><span class="dim"></span>
      </div>
      <div class="tips">
        <b>Bikes turn by leaning.</b> Lean is grip: the tyres can only give about 1.1 g in total, shared between
        cornering, braking and accelerating — the <b>friction circle</b>. Brake while upright, then lean, then
        feed the throttle as you stand it back up. Grab the brakes mid-corner and the bike stands up and runs wide.<br>
        <b>Rider aids</b> mirror the real bike's APRC: traction control (ATC), wheelie control (AWC) and cornering
        ABS. With aids on, lean assist won't let you ask for more lean than the grip left. Switch them off in
        Settings to find the limit yourself — and the crash beyond it.<br>
        <b>Score</b> comes from knee-down cornering, wheelies, near misses and staying in your lane. It banks at each
        checkpoint; crash before then and the unbanked points are gone.
      </div>
      <div class="row"><button class="btn" data-a="back">Back</button></div>
    </div>
  </div>

  <div class="scr" data-s="pause">
    <div class="sheet panel" style="width:34cqw">
      <h2>Paused</h2>
      <div class="menu">
        <button class="btn" data-a="resume">Resume</button>
        <button class="btn" data-a="restart">Restart</button>
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn" data-a="musicStop" hidden>Stop the music</button>
        <button class="btn" data-a="calibSave" hidden>Download calibration</button>
        <button class="btn" data-a="quit">Back to the garage</button>
      </div>
    </div>
  </div>

  <div class="scr" data-s="results">
    <div class="sheet panel" style="width:62cqw">
      <div class="res"></div>
      <div class="row">
        <button class="btn" data-a="restart">Ride it again</button>
        <button class="btn" data-a="next">Next road</button>
        <button class="btn" data-a="quit">Garage</button>
      </div>
    </div>
  </div>

  <div class="hud">
    <div class="tl"><div class="stg"></div><div class="time">0:00.00</div><div class="split"></div><div class="tgt"></div><div class="rival"></div></div>
    <div class="tr"><div class="score">0</div><div class="combo"></div><div class="pend"></div></div>
    <div class="dash">
      <div class="rev">${'<i></i>'.repeat(24)}</div>
      <div class="dmain">
        <div><span class="spd">0</span><span class="unit">MPH</span></div>
        <div><div class="gear">N</div><div class="gl">GEAR</div></div>
      </div>
      <div class="lean">
        <svg viewBox="-50 -50 100 55"><path d="M-44 0 A44 44 0 0 1 44 0" fill="none" stroke="#2c2f36" stroke-width="7"/>
          <path class="arcL" d="" fill="none" stroke="#ff3b45" stroke-width="7"/>
          <path class="arcR" d="" fill="none" stroke="#ff3b45" stroke-width="7"/>
          <line class="needle" x1="0" y1="0" x2="0" y2="-40" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>
        <div class="ln"><div>LEAN <b class="lv">0°</b></div><div class="dim">MAX <span class="lmax">0° · 0°</span></div></div>
        <div class="aids"><span data-k="atc">ATC</span><span data-k="awc">AWC</span><span data-k="abs">ABS</span></div>
      </div>
    </div>
    <canvas class="map" width="240" height="240"></canvas>
    <div class="mchip"><span class="mv"></span><span class="mb"></span><button class="btn" data-a="musicStop">Stop music</button></div>
    <div class="cchip"><span class="cl"></span><button class="btn" data-a="calibSave">Download calibration</button></div>
    <div class="msgs"></div>
  </div>
  <div class="count"></div>
  <div class="loading">LOADING</div>
  <button class="fs" data-a="fullscreen" aria-label="Toggle fullscreen"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
  `;

  const $ = sel => root.querySelector(sel);
  const screens = {};
  root.querySelectorAll('.scr').forEach(el => { screens[el.dataset.s] = el; });
  let current = null;

  // One delegated listener on our own element — removed with it in destroy().
  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn || !root.contains(btn)) return;
    const a = btn.dataset.a;
    if (a && actions[a]) actions[a](btn.dataset.arg, btn);
  }
  root.addEventListener('click', onClick);
  // Typing in a text box must not reach the game's keys (the shell swallows Space
  // and arrows on window, and W/S would move menu focus). Keyups still pass, so a
  // key released inside a box can't stay "held".
  function onKey(e) {
    if (!e.target.matches?.('input, textarea')) return;
    e.stopPropagation();
    // preventDefault: the join moves focus to a button, which would take this Enter as a click
    if (e.key === 'Enter' && e.target.id === 'cyCode') { e.preventDefault(); actions.raceJoin?.(); }
  }
  root.addEventListener('keydown', onKey);
  // The music-mode engine slider (the only range input).
  function onInput(e) {
    if (e.target.id !== 'cyMusicEngine') return;
    e.target.nextElementSibling.textContent = `${Math.round(e.target.value * 100)}%`;
    actions.musicEngine?.(e.target.value);
  }
  root.addEventListener('input', onInput);
  // A chosen file goes through the same import as a pasted code.
  const fileIn = $('#cyGhostFile'), nameIn = $('#cyGhostName');
  function onFile() {
    const file = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!file) return;
    if (file.size > 300000) { ghostMsg('import', 'That file is far too big to be a ghost.', 'red'); return; }
    file.text().then(t => actions.importCode?.(t), () => ghostMsg('import', 'Could not read that file.', 'red'));
  }
  function onName() { actions.ghostName?.(nameIn.value); }
  fileIn.addEventListener('change', onFile);
  nameIn.addEventListener('change', onName);
  const nickIn = $('#cyNick'), codeIn = $('#cyCode');
  function onNick() { actions.raceNick?.(nickIn.value); }
  nickIn.addEventListener('change', onNick);

  function show(name) {
    for (const k in screens) screens[k].classList.toggle('on', k === name);
    current = name;
    if (name) {
      const first = screens[name].querySelector('button:not(:disabled)');
      first?.focus({ preventScroll: true });
    }
  }

  function focusables() {
    if (!current) return [];
    return [...screens[current].querySelectorAll('button:not(:disabled)')];
  }
  function moveFocus(dir) {
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = list[(i + dir + list.length) % list.length];
    next.focus({ preventScroll: true });
  }
  function activate() {
    const el = document.activeElement;
    if (el && root.contains(el) && el.tagName === 'BUTTON') el.click();
  }

  // ---------- stage list ----------
  function renderStages(records, units, medalsFor) {
    const box = $('.stages');
    const dist = m => units === 'mph' ? `${(m / 1609.34).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`;
    const TOD_NAME = { golden: 'golden hour', midday: 'midday', afternoon: 'afternoon', sunset: 'sunset', night: 'night' };
    const cards = STAGES.map(st => {
      const rec = records[st.id] || {};
      const md = medalsFor(st);
      const medal = rec.medal || 'none';
      return `<button class="btn stage" data-a="ride" data-arg="${st.id}">
        <span class="nm">${esc(st.name)}</span>
        <span class="meta">${esc(BIOMES[st.biome].name)} · ${TOD_NAME[st.tod]} · ${dist(st.length)}</span>
        <span class="meta">${esc(st.blurb)}</span>
        <span class="best"><span class="medal m-${medal}"></span>${rec.best ? 'Best ' + fmtTime(rec.best) : 'Not ridden yet'}
          <span class="dim"> · gold ${fmtTime(md.gold)}</span></span>
      </button>`;
    });
    const er = records.endless || {};
    cards.push(`<button class="btn stage" data-a="ride" data-arg="endless">
      <span class="nm">${esc(ENDLESS.name)}</span>
      <span class="meta">New land every ride · tunnels, bridges, towns · weather · day and night</span>
      <span class="meta">${esc(ENDLESS.blurb)}</span>
      <span class="best">${er.bestDist ? 'Best ' + dist(er.bestDist) + ' · ' + (er.bestScore || 0).toLocaleString() + ' pts' : 'Not ridden yet'}</span>
    </button>`);
    box.innerHTML = cards.join('');
  }

  // ---------- settings ----------
  const SETTINGS = [
    ['aids', 'Rider aids', [['full', 'Full'], ['sport', 'Sport'], ['off', 'Off']]],
    ['gearbox', 'Gearbox', [['auto', 'Automatic'], ['manual', 'Manual (Q / E)']]],
    ['units', 'Units', [['mph', 'mph'], ['kmh', 'km/h']]],
    ['camera', 'Camera', [['chase', 'Chase'], ['close', 'Close'], ['helmet', 'Helmet']]],
    ['tilt', 'Camera tilts with lean', [['on', 'On'], ['off', 'Off']]],
    ['traffic', 'Traffic', [['on', 'On'], ['off', 'Off']]],
    ['ghost', 'Ghost of best run', [['on', 'On'], ['off', 'Off']]],
    ['quality', 'Graphics', [['high', 'High'], ['low', 'Low (faster)']]],
    ['volume', 'Sound', [['1', 'Loud'], ['0.6', 'Normal'], ['0.3', 'Quiet'], ['0', 'Off']]],
    ['musicKick', 'Camera kick on strong beats (music)', [['on', 'On'], ['off', 'Off']]],
  ];
  function renderSettings(s) {
    const AID_NOTE = { full: 'ATC · AWC · ABS · lean assist', sport: 'ATC · AWC · ABS, no lean assist', off: 'nothing — it’s all you' };
    $('.setlist').innerHTML = SETTINGS.map(([k, label, opts]) => {
      const i = Math.max(0, opts.findIndex(o => o[0] === String(s[k])));
      const note = k === 'aids' ? AID_NOTE[s[k]] : '';
      return `<button class="btn" data-a="cycle" data-arg="${k}">${esc(label)} <small>${esc(opts[i][1])}${note ? ' — ' + esc(note) : ''}</small></button>`;
    }).join('') + `<label class="btn mrange">Engine volume (music mode)
      <input type="range" id="cyMusicEngine" min="0" max="1" step="0.05" value="${esc(s.musicEngine)}"><output>${Math.round(s.musicEngine * 100)}%</output></label>`;
  }
  function nextSetting(k, s) {
    const opts = SETTINGS.find(x => x[0] === k)[2];
    const i = opts.findIndex(o => o[0] === String(s[k]));
    return opts[(i + 1) % opts.length][0];
  }

  // ---------- friends' ghosts ----------
  // g: { name, stages: [{ id, name, best, ready }], rivals: [{ stageId, stageName, name, timeMs }] }
  function renderGhosts(g) {
    if (document.activeElement !== nameIn) nameIn.value = g.name || '';
    $('#cyShareList').innerHTML = g.stages.map(st => `<div class="gitem">
        <span class="gname">${esc(st.name)}<br><span class="dim">${st.ready ? 'your best ' + fmtTime(st.best) : esc(st.note || '')}</span></span>
        <button class="btn" data-a="shareCopy" data-arg="${st.id}" ${st.ready ? '' : 'disabled'}>Copy code</button>
        <button class="btn" data-a="shareFile" data-arg="${st.id}" ${st.ready ? '' : 'disabled'}>Save file</button>
      </div>`).join('');
    $('#cyRivalList').innerHTML = g.rivals.length
      ? g.rivals.map(r => `<div class="gitem">
          <span class="gname"><span style="color:#ffb347">${esc(r.name)}</span> · ${esc(r.stageName)}<br><span class="dim">${fmtTime(r.timeMs / 1000)}</span></span>
          <button class="btn" data-a="removeRival" data-arg="${r.stageId}" aria-label="Remove ${esc(r.name)}'s ghost on ${esc(r.stageName)}">Remove</button>
        </div>`).join('')
      : `<div class="dim" style="font-size:1.1cqw">No friends' ghosts loaded yet. One per road; a new one replaces the old.</div>`;
  }
  function ghostMsg(which, text, cls = '') {
    const node = $(which === 'share' ? '#cyShareMsg' : '#cyImportMsg');
    node.textContent = text;
    node.className = 'gmsg ' + cls;
  }

  // ---------- race friends ----------
  // Every name and code goes through esc(): they came over the network.
  // v: { nick, room: null | { code, link, players: [{ name, color, host, you }], isHost, stage,
  //      racing: stage name or '', inRace, last: { stage, rows } }, colors, stages: [{ id, name }] }
  const boardRows = (rows, colors) => `<table class="board">${rows.map(r => `<tr>
      <td class="n">${r.place ? r.place : r.dnf ? 'DNF' : '…'}</td>
      <td><span class="rdot" style="background:${colors[r.color] || colors[0]}"></span>${esc(r.name)}</td>
      <td class="n">${r.ms != null ? fmtTime(r.ms / 1000) : r.dnf ? '' : 'riding'}</td>
      <td class="n dim">${esc(r.gapText || '')}</td></tr>`).join('')}</table>`;
  function renderRace(v) {
    if (document.activeElement !== nickIn) nickIn.value = v.nick || '';
    const r = v.room;
    $('.rjoin').hidden = !!r;
    $('[data-a=raceLeave]').hidden = !r;
    const box = $('.rlobby');
    box.hidden = !r;
    if (!r) { box.innerHTML = ''; return; }
    const stageName = id => esc((v.stages.find(s => s.id === id) || {}).name || id);
    box.innerHTML = `
      <div class="rh">Room</div>
      <div class="row" style="margin-top:0"><span class="rcode">${esc(r.code)}</span>
        <input type="text" readonly value="${esc(r.link)}" aria-label="Share link" id="cyLink">
        <button class="btn" data-a="raceCopy">Copy link</button></div>
      <div class="rh">Riders (${r.players.length}/4)</div>
      <div class="glist" style="margin-top:0">${r.players.map(p => `<div class="gitem"><span class="gname">
        <span class="rdot" style="background:${v.colors[p.color] || v.colors[0]}"></span>${esc(p.name)}${p.you ? ' <span class="dim">(you)</span>' : ''}</span>
        ${p.host ? '<span class="tag">HOST</span>' : ''}</div>`).join('')}</div>
      <div class="rh">Road</div>
      ${r.racing ? `<div>Race on ${esc(r.racing)} in progress${r.inRace ? '' : ' — you\'re in the next one'}.</div>`
        : r.isHost ? `<div class="rstages">${v.stages.map(s => `<button class="btn" data-a="raceStage" data-arg="${s.id}" aria-pressed="${s.id === r.stage}">${esc(s.name)}</button>`).join('')}</div>
          <div class="row"><button class="btn" data-a="raceStart">Start the race on ${stageName(r.stage)}</button></div>`
        : `<div>${stageName(r.stage)} <span class="dim">· the host picks the road and starts</span></div>`}
      ${r.last ? `<div class="rh">Last race · ${stageName(r.last.stage)}</div>${boardRows(r.last.rows, v.colors)}` : ''}`;
  }
  function raceMsg(text, cls = '') {
    const node = $('#cyRaceMsg');
    node.textContent = text;
    node.className = 'gmsg ' + cls;
  }
  // b: { title, mine, rows, closeIn (s or null), over }
  function renderBoard(b, colors) {
    $('.rboard').innerHTML = `<h2>${esc(b.title)}</h2>
      <div class="rmine">${esc(b.mine)}</div>
      ${boardRows(b.rows, colors)}
      <div class="dim" style="font-size:1.2cqw;margin-top:.6cqw">${b.over ? 'Race over.' : b.closeIn != null ? `The race closes in ${Math.ceil(b.closeIn)} s; anyone still riding then is DNF.` : 'Waiting for the others to finish.'}</div>`;
  }
  // Online, a ride can't be restarted, and quitting goes back to the room's lobby.
  // ---------- ride to my music ----------
  function musicMsg(text, cls = '') {
    const node = $('#cyMusicMsg');
    node.textContent = text;
    node.className = 'gmsg ' + cls;
  }
  function musicMode(on) {
    $('[data-s=pause] [data-a=musicStop]').hidden = !on;
    hud.classList.toggle('music', on);
    el.mchip.classList.toggle('on', on);
    if (!on) { last.beat = null; hud.style.removeProperty('--beat'); }
  }
  const VIBE_COLOR = { sad: '#8fb0ff', chill: '#ffb36b', upbeat: '#ffd84a', intense: '#ff4a52' };
  // m: { vibe, scene, override, bpm, listening, paused } — "Night · 98 BPM"
  function musicHud(m) {
    const v = m.paused ? 'Music paused' : `${m.scene || m.vibe}${m.override ? ' (yours)' : ''}`;
    const b = m.paused ? '· scenery holds' : m.listening ? '· listening…' : `· ${Math.round(m.bpm)} BPM`;
    set('mv', el.mv, v);
    set('mb', el.mb, b);
    const c = m.paused ? '#c6cad1' : VIBE_COLOR[m.vibe];
    if (last.mc !== c) { last.mc = c; el.mchip.style.setProperty('--vibe', c); }
  }
  // ?calibrate=1: the recorder's chip, and its download buttons.
  function calibMode(on) {
    el.cchip.classList.toggle('on', on);
    $('[data-s=pause] [data-a=calibSave]').hidden = !on;
  }
  function calibLast(on) { $('[data-a=calibLast]').hidden = !on; }
  function beat(p) {
    const q = Math.round(p * 20) / 20;
    if (last.beat !== q) { last.beat = q; hud.style.setProperty('--beat', q); }
  }

  function onlineMode(on) {
    const rs = $('[data-s=pause] [data-a=restart]');
    rs.hidden = rs.disabled = on;
    $('[data-s=pause] [data-a=quit]').textContent = on ? 'Leave the race (DNF)' : 'Back to the garage';
  }

  // ---------- HUD ----------
  const hud = $('.hud');
  const el = {
    stg: $('.tl .stg'), time: $('.tl .time'), split: $('.tl .split'), tgt: $('.tl .tgt'), rival: $('.tl .rival'),
    score: $('.tr .score'), combo: $('.tr .combo'), pend: $('.tr .pend'),
    rev: [...root.querySelectorAll('.rev i')], revBox: $('.rev'),
    spd: $('.spd'), unit: $('.unit'), gear: $('.gear'),
    needle: $('.needle'), arcL: $('.arcL'), arcR: $('.arcR'), lv: $('.lv'), lmax: $('.lmax'),
    aids: { atc: $('[data-k=atc]'), awc: $('[data-k=awc]'), abs: $('[data-k=abs]') },
    map: $('.map'), msgs: $('.msgs'), count: $('.count'), loading: $('.loading'),
    mchip: $('.mchip'), mv: $('.mchip .mv'), mb: $('.mchip .mb'),
    cchip: $('.cchip'), cl: $('.cchip .cl'),
  };
  const mapCtx = el.map.getContext('2d');
  const last = {};
  const set = (key, node, text) => { if (last[key] !== text) { last[key] = text; node.textContent = text; } };
  const arc = deg => {
    const a = Math.min(60, Math.abs(deg)) * Math.PI / 180;
    const s = Math.sign(deg);
    return `M0 -44 A44 44 0 0 ${s > 0 ? 1 : 0} ${(44 * Math.sin(a) * s).toFixed(1)} ${(-44 * Math.cos(a)).toFixed(1)}`;
  };

  function updateHud(h) {
    set('stg', el.stg, h.stage);
    set('time', el.time, h.time);
    set('tgt', el.tgt, h.target || '');
    set('rival', el.rival, h.rival || '');
    set('score', el.score, h.score.toLocaleString());
    set('combo', el.combo, h.combo > 1 ? `×${h.combo} COMBO` : '');
    set('pend', el.pend, h.pending > 0 ? `+${h.pending.toLocaleString()} unbanked` : '');
    set('spd', el.spd, String(h.speed));
    set('unit', el.unit, h.unit);
    set('gear', el.gear, h.gear);
    const lit = Math.round(h.rpm / 12000 * 24);
    if (last.lit !== lit) {
      last.lit = lit;
      el.rev.forEach((n, i) => {
        n.className = i < lit ? (i >= 23 ? 'on red' : i >= 20 ? 'on hi' : 'on') : '';
      });
    }
    el.revBox.classList.toggle('flash', h.shiftLight);
    const deg = Math.round(h.lean);
    if (last.deg !== deg) {
      last.deg = deg;
      el.needle.setAttribute('transform', `rotate(${Math.max(-60, Math.min(60, deg))})`);
      el.lv.textContent = `${Math.abs(deg)}°`;
    }
    const ml = Math.round(h.maxL), mr = Math.round(h.maxR);
    if (last.ml !== ml || last.mr !== mr) {
      last.ml = ml; last.mr = mr;
      el.lmax.textContent = `${ml}° | ${mr}°`;
      el.arcL.setAttribute('d', ml > 0 ? arc(-ml) : '');
      el.arcR.setAttribute('d', mr > 0 ? arc(mr) : '');
    }
    for (const k of ['atc', 'awc', 'abs']) {
      el.aids[k].classList.toggle('hot', h.aids[k] > 0);
      el.aids[k].classList.toggle('offx', !h.aidsOn[k]);
    }
  }

  function split(text, cls) {
    el.split.textContent = text;
    el.split.className = 'split ' + (cls || '');
  }

  // Minimap: road around the rider, heading-up.
  function drawMap(road, b, extras) {
    const W = el.map.width, H = el.map.height, R = W / 2;
    const ctx = mapCtx;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 2, 0, Math.PI * 2); ctx.clip();
    const scale = R / 420;                                   // 420 m to the edge
    const c = Math.cos(-b.psi - Math.PI / 2), s = Math.sin(-b.psi - Math.PI / 2);
    const P = (x, z) => {
      const dx = x - b.x, dz = z - b.z;
      return [R + (dx * c - dz * s) * scale, R + (dx * s + dz * c) * scale];
    };
    const i0 = Math.max(0, Math.floor((b.s - 500) / 2)), i1 = Math.min(road.n - 1, Math.floor((b.s + 700) / 2));
    ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(230,230,235,.85)';
    ctx.beginPath();
    for (let i = i0; i <= i1; i += 4) { const [px, py] = P(road.x[i], road.z[i]); i === i0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.stroke();
    for (const e of extras) {
      const [px, py] = P(e.x, e.z);
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(px, py, e.r || 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ff3b45';
    ctx.beginPath(); ctx.moveTo(R, R - 10); ctx.lineTo(R + 7, R + 8); ctx.lineTo(R, R + 4); ctx.lineTo(R - 7, R + 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function message(text, kind = '', big = false) {
    const m = document.createElement('div');
    m.className = `msg ${kind} ${big ? 'big' : ''}`;
    m.textContent = text;
    el.msgs.appendChild(m);
    while (el.msgs.children.length > 4) el.msgs.firstChild.remove();
    setTimeout(() => m.remove(), 1700);
  }

  function countdown(text) {
    el.count.textContent = text || '';
    el.count.classList.toggle('go', text === 'GO');
  }

  function results(r) {
    const medalName = r.medal ? r.medal.toUpperCase() : 'NO MEDAL';
    const cls = { gold: 'gold', silver: '', bronze: '' }[r.medal] ?? 'dim';
    const stat = (v, k) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
    $('.res').innerHTML = `
      <h2>${esc(r.title)}</h2>
      <div class="res-medal ${cls}"><span class="medal m-${r.medal || 'none'}" style="width:2.6cqw;height:2.6cqw"></span> ${medalName}
        ${r.newBest ? '<span class="tag">NEW BEST</span>' : ''}</div>
      <div class="dim" style="font-size:1.3cqw;margin-top:.4cqw">${esc(r.targets)}</div>
      ${r.rival ? `<div class="res-rival">${esc(r.rival)}</div>` : ''}
      <div class="stats">
        ${stat(r.time, 'time')}${stat(r.score, 'score')}${stat(r.top, 'top speed')}
        ${stat(r.lean, 'max lean L / R')}${stat(r.wheelie, 'wheelie time')}${stat(r.misses, 'near misses')}
      </div>`;
  }

  // Fullscreen icon state is cosmetic; the action lives in game.js.
  return {
    root, show, moveFocus, activate,
    get screen() { return current; },
    renderStages, renderSettings, nextSetting, renderGhosts, ghostMsg,
    get ghostInput() { return $('#cyGhostIn'); },
    renderRace, raceMsg, renderBoard, onlineMode, musicMsg, musicMode, calibMode, calibLast,
    get codeInput() { return codeIn; },
    hud: {
      show(on) { hud.classList.toggle('on', on); },
      update: updateHud, split, drawMap, music: musicHud, beat,
      calib: text => set('cl', el.cl, text),
    },
    message, countdown, results,
    loading(on) { el.loading.classList.toggle('on', on); },
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('input', onInput);
      fileIn.removeEventListener('change', onFile);
      nameIn.removeEventListener('change', onName);
      nickIn.removeEventListener('change', onNick);
      root.remove();
      style.remove();
    },
  };
}
