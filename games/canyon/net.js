// Canyon — the network layer for online races. The rest of the game sees createLink(code,
// onMessage) with send() and close(). Plain WebSocket with backoff (the pattern of
// projects/holdout/net.js, not an import of it), so the browser side stays zero-dependency.
//
// PartyServer serves rooms at /parties/<party>/<room>, where <party> is the kebab-cased
// Durable Object binding name: "CanyonRoom" -> "canyon-room" (checked in partyserver 0.5.10's
// routePartykitRequest / camelCaseToKebabCase).

const PARTY = 'canyon-room';
// The deployed relay (projects/relay, Worker "arcade-relay", first deployed 2026-10-22).
export const RELAY_PROD = 'arcade-relay.lunar-gecko-4183.workers.dev';
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const GIVE_UP = 3;   // failed attempts in a row before saying it's down (never connected: just 3 tries)
const GIVE_UP_AFTER_OPEN = 8;
// A relay that dies without closing the socket (a crash, a dropped network) can leave it
// looking open for minutes. Heard nothing for PING_MS: ask. Nothing for DEAD_MS: it's gone.
const PING_MS = 4000, DEAD_MS = 10000;

// Which relay this page talks to. A page served from this machine uses the local `wrangler dev`,
// or ?relay=<host> (testing only: on the public site a link can't steer friends to another
// relay); anything else the deployed one, or null if none.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function relayHost(loc) {
  if (LOCAL_HOST.test(loc.hostname)) {
    const q = new URLSearchParams(loc.search).get('relay');
    return q && /^[\w.:[\]-]+$/.test(q) ? q : 'localhost:8787';
  }
  return RELAY_PROD || null;
}

export function socketUrl(host, code) {
  const local = LOCAL_HOST.test(host);
  return `${local ? 'ws' : 'wss'}://${host}/parties/${PARTY}/${encodeURIComponent(code)}`;
}

// onMessage gets each parsed server message plus three from this file: {type:'_open'} on
// each (re)connect, {type:'_closed'} when a live socket drops (a retry is coming), and
// {type:'_down'} when it gives up. A 'refused' message (room full) stops retries.
export function createLink(host, code, onMessage) {
  let ws = null, wanted = true, fails = 0, opened = false, timer = 0, sent = 0, bytes = 0, heard = 0, asked = 0;
  const open = () => {
    ws = new WebSocket(socketUrl(host, code));
    ws.onopen = () => { fails = 0; opened = true; heard = performance.now(); onMessage({ type: '_open' }); };
    ws.onmessage = e => {
      heard = performance.now();
      if (typeof e.data !== 'string' || e.data.length > 16384) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'refused') wanted = false;
      onMessage(msg);
    };
    ws.onclose = dropped;
  };
  function dropped() {
    ws = null;
    if (!wanted) return;
    fails++;
    if (fails >= (opened ? GIVE_UP_AFTER_OPEN : GIVE_UP)) { wanted = false; clearInterval(watch); onMessage({ type: '_down' }); return; }
    if (opened && fails === 1) onMessage({ type: '_closed' });
    timer = setTimeout(open, RETRY_MS[Math.min(fails - 1, RETRY_MS.length - 1)]);
  }
  const watch = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - heard > DEAD_MS) { const w = ws; w.onclose = null; w.close(); dropped(); }
    else if (now - heard > PING_MS && now - asked > PING_MS) { asked = now; ws.send('{"type":"ping"}'); }
  }, 1000);
  open();
  return {
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const s = JSON.stringify(msg);
      ws.send(s); sent++; bytes += s.length;
      return true;
    },
    get live() { return !!ws && ws.readyState === WebSocket.OPEN; },
    stats: () => ({ sent, bytes }),
    close() {
      wanted = false;
      clearTimeout(timer); clearInterval(watch);
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
    },
  };
}
