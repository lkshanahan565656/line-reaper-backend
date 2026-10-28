// ─── KALSHI LIVE PRICES: THE WEBSOCKET TICKER FEED ──────────────────────────
// Kalshi's prices otherwise reach us by polling: the exchange arb scan reads
// every open market once a minute (xarb.js) and the +EV books read the game
// series once a minute (exchanges.js). This module keeps one WebSocket open to
// Kalshi's `ticker` channel for the markets those polls already track, so a
// price change reaches the screens in about a second instead of a minute.
//
//   auth       Kalshi signs the handshake even for public prices: an API key
//              id and its private key (RSA-PSS or Ed25519), the same signing
//              as the REST API, over `<ms timestamp>GET/trade-api/ws/v2`. A
//              read-only key is enough.
//   markets    only the tickers we ask for (never the whole exchange), at most
//              maxMarkets, added and dropped in chunks as the polls change.
//   prices     the last yes bid and yes ask of each tracked market, and when
//              Kalshi sent it. Nothing else is kept: memory is one small entry
//              per tracked market.
//   fallback   the polls never stop. While the socket is down, refused or
//              still catching up, the polled prices stand; quotes are cleared
//              on every disconnect so a price from before a gap never
//              overrides a newer poll.
//   limits     one connection. Reconnects back off from 2 s to 5 min with
//              jitter (a refused handshake waits 30 min). Commands go one at a
//              time with a gap; a "too many markets" error halves the cap and
//              a "command rate" error doubles the gap.
//   liveness   Kalshi pings every 10 s; 45 s without a ping or a message and
//              the socket is dropped and reopened.
//
// Pure apart from the socket it is handed: `WebSocket` (the `ws` package's
// class, or a fake in tests), clock and timers are injected.

'use strict';
const crypto = require('crypto');

const WS_URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const WS_PATH = '/trade-api/ws/v2';
const DEFAULTS = { maxMarkets: 1500, chunk: 100, gapMs: 250, idleMs: 45e3, baseMs: 2e3, maxMs: 5 * 60e3, refusedMs: 30 * 60e3, stableMs: 60e3 };

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// ── auth ──
function sign(pem, ts, method, path) {
  const key = crypto.createPrivateKey(pem);
  const msg = Buffer.from(`${ts}${method}${path}`, 'utf8');
  const sig = key.asymmetricKeyType === 'ed25519' ? crypto.sign(null, msg, key)
    : crypto.sign('sha256', msg, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  return sig.toString('base64');
}
function authHeaders({ keyId, pem, now = Date.now() }) {
  const ts = String(now);
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sign(pem, ts, 'GET', WS_PATH) };
}
// a PEM pasted into one env line: "\n" written out, or the body with no breaks
function pemFromEnv(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  if (!s.includes('\n')) {
    const m = s.match(/^(-----BEGIN [A-Z ]+-----)\s*(.+?)\s*(-----END [A-Z ]+-----)$/);
    if (m) s = `${m[1]}\n${m[2].replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n${m[3]}`;
  }
  try { crypto.createPrivateKey(s); return s; } catch { return null; }
}

// ── messages ──
// a ticker message → { ticker, yesBid, yesAsk } (dollars; null when that side has no orders)
function parseTicker(m) {
  const t = m?.msg;
  if (m?.type !== 'ticker' || !t?.market_ticker) return null;
  const px = f => { const d = num(t[`${f}_dollars`]); if (d != null) return d; const c = num(t[f]); return c == null ? null : c / 100; };
  const ok = x => (x != null && x > 0 && x < 1 ? r4(x) : null);
  return { ticker: String(t.market_ticker), yesBid: ok(px('yes_bid')), yesAsk: ok(px('yes_ask')) };
}
// the next wait before a reconnect: doubling from baseMs to maxMs, a random half to all of it
function backoffMs(attempt, { baseMs = DEFAULTS.baseMs, maxMs = DEFAULTS.maxMs, rand = Math.random } = {}) {
  const full = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(full * (0.5 + rand() * 0.5));
}

// ── the stream ──
function createKalshiStream({ keyId, pem, url = WS_URL, WebSocket, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  rand = Math.random, log = () => {}, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  let ws = null, state = 'off', sid = null, nextId = 1, attempt = 0;
  let retryT = null, pumpT = null, idleT = null;
  let openedAt = null, heardAt = null, lastError = null, refusedUntil = null;
  let cap = o.maxMarkets, gap = o.gapMs;
  const counts = { messages: 0, tickers: 0, connects: 0, reconnects: 0, errors: 0 };
  let want = new Set();             // tickers we want, in the polls' order, capped
  let asked = 0;                    // how many tickers the polls asked for before the cap
  const subscribed = new Set();     // tickers Kalshi confirmed (or that went in the first subscribe)
  const pending = new Map();        // command id → { action, tickers }
  const queue = [];                 // commands waiting to go
  const quotes = new Map();         // ticker → { yesBid, yesAsk, at }
  const dirty = new Set();          // tickers whose quote changed since takeDirty()

  const clear = t => { if (t) clearTimer(t); return null; };
  function send(cmd) { queue.push(cmd); if (!pumpT) pump(); }
  function pump() {
    pumpT = null;
    if (!ws || state !== 'live' || !queue.length) return;
    const cmd = queue.shift();
    const id = nextId++;
    pending.set(id, cmd.meta || null);
    try { ws.send(JSON.stringify({ id, cmd: cmd.cmd, params: cmd.params })); } catch (e) { lastError = `send: ${e.message}`; }
    if (queue.length) pumpT = setTimer(pump, gap);
  }
  const chunks = list => { const out = []; for (let i = 0; i < list.length; i += o.chunk) out.push(list.slice(i, i + o.chunk)); return out; };
  // bring Kalshi's subscription in line with `want`
  function sync() {
    if (state !== 'live') return;
    const add = [...want].filter(t => !subscribed.has(t) && ![...pending.values()].some(p => p?.action === 'add' && p.tickers.includes(t)));
    const del = [...subscribed].filter(t => !want.has(t));
    if (sid == null) {
      // nothing asked for: no subscribe at all (an empty ticker list would be every market)
      if (!add.length || [...pending.values()].some(p => p?.action === 'subscribe')) return;
      // the first chunk opens the subscription; the rest are added once Kalshi names it
      const first = add.slice(0, o.chunk);
      send({ cmd: 'subscribe', params: { channels: ['ticker'], market_tickers: first, send_initial_snapshot: true }, meta: { action: 'subscribe', tickers: first } });
      for (const t of first) subscribed.add(t);
      return;
    }
    for (const c of chunks(add)) send({ cmd: 'update_subscription', params: { sids: [sid], market_tickers: c, action: 'add_markets' }, meta: { action: 'add', tickers: c } });
    for (const c of chunks(del)) {
      send({ cmd: 'update_subscription', params: { sids: [sid], market_tickers: c, action: 'delete_markets' }, meta: { action: 'delete', tickers: c } });
      for (const t of c) { subscribed.delete(t); quotes.delete(t); }
    }
  }
  function heard() {
    heardAt = now();
    idleT = clear(idleT);
    idleT = setTimer(() => { lastError = `no ping or message for ${Math.round(o.idleMs / 1000)} s`; drop(); }, o.idleMs);
  }
  function onMessage(raw) {
    heard();
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    counts.messages++;
    if (m.type === 'ticker') {
      const q = parseTicker(m);
      if (!q || !want.has(q.ticker)) return;
      counts.tickers++;
      const had = quotes.get(q.ticker);
      if (!had || had.yesBid !== q.yesBid || had.yesAsk !== q.yesAsk) dirty.add(q.ticker);
      quotes.set(q.ticker, { yesBid: q.yesBid, yesAsk: q.yesAsk, at: now() });
      return;
    }
    const meta = m.id != null ? pending.get(m.id) : null;
    if (m.id != null) pending.delete(m.id);
    if (m.type === 'subscribed' && m.msg?.channel === 'ticker') {
      sid = num(m.msg.sid);
      sync();
    } else if (m.type === 'ok' && meta?.action === 'add') {
      for (const t of meta.tickers) if (want.has(t)) subscribed.add(t);
    } else if (m.type === 'error') {
      counts.errors++;
      const code = num(m.msg?.code);
      lastError = `Kalshi error ${code}: ${m.msg?.msg || ''}`.trim();
      if (code === 9) { refused('channel needs an authenticated connection'); return; }
      if (code === 26) { cap = Math.max(o.chunk, Math.floor(cap / 2)); want = new Set([...want].slice(0, cap)); log(`Kalshi stream: market limit, cap now ${cap}`); }
      if (code === 27) gap = Math.min(10e3, gap * 2);
      // the failed command's markets aren't subscribed; the next track() (each
      // poll, about a minute) asks again, so an error can't loop at command speed
      if (meta?.action === 'subscribe') for (const t of meta.tickers) subscribed.delete(t);
    }
  }
  function reset() {
    sid = null; subscribed.clear(); pending.clear(); queue.length = 0; quotes.clear(); dirty.clear();
    pumpT = clear(pumpT); idleT = clear(idleT);
  }
  function drop() {
    const w = ws; ws = null;
    if (w) { try { w.removeAllListeners?.(); w.on?.('error', () => {}); w.terminate ? w.terminate() : w.close(); } catch {} }
    const wasLive = state === 'live';
    reset();
    if (state === 'stopped' || state === 'refused') return;
    if (wasLive && openedAt != null && now() - openedAt >= o.stableMs) attempt = 0;
    state = 'waiting';
    counts.reconnects++;
    const wait = backoffMs(attempt++, { baseMs: o.baseMs, maxMs: o.maxMs, rand });
    retryT = clear(retryT);
    retryT = setTimer(open, wait);
  }
  function refused(why) {
    lastError = `refused: ${why}`;
    state = 'refused';
    const w = ws; ws = null;
    if (w) { try { w.removeAllListeners?.(); w.on?.('error', () => {}); w.terminate ? w.terminate() : w.close(); } catch {} }
    reset();
    refusedUntil = now() + o.refusedMs;
    retryT = clear(retryT);
    retryT = setTimer(() => { refusedUntil = null; state = 'waiting'; open(); }, o.refusedMs);
    log(`Kalshi stream: ${lastError}; trying again in ${Math.round(o.refusedMs / 60e3)} min`);
  }
  function open() {
    retryT = null;
    if (state === 'stopped') return;
    let headers;
    try { headers = authHeaders({ keyId, pem, now: now() }); } catch (e) { refused(`key: ${e.message}`); return; }
    state = 'connecting';
    let w;
    try { w = new WebSocket(url, { headers, handshakeTimeout: 15e3 }); } catch (e) { lastError = e.message; drop(); return; }
    ws = w;
    w.on('open', () => { if (ws !== w) return; state = 'live'; openedAt = now(); counts.connects++; heard(); sync(); });
    w.on('message', d => { if (ws === w) onMessage(d); });
    w.on('ping', () => { if (ws === w) heard(); });
    w.on('pong', () => { if (ws === w) heard(); });
    w.on('unexpected-response', (req, res) => {
      if (ws !== w) return;
      const code = res?.statusCode;
      if (code === 401 || code === 403) refused(`handshake HTTP ${code}`);
      else { lastError = `handshake HTTP ${code}`; drop(); }
    });
    w.on('error', e => { if (ws === w) lastError = e?.message || String(e); });
    w.on('close', (code, reason) => { if (ws !== w) return; lastError = lastError || `closed ${code}${reason ? ` ${reason}` : ''}`; drop(); });
  }

  return {
    start() { if (state === 'off' || state === 'stopped') { state = 'waiting'; open(); } },
    stop() { state = 'stopped'; retryT = clear(retryT); const w = ws; ws = null; if (w) { try { w.removeAllListeners?.(); w.on?.('error', () => {}); w.close(); } catch {} } reset(); },
    // the tickers the polls track now, most wanted first; the rest of the cap is dropped
    track(tickers) {
      const list = [...new Set((tickers || []).map(String).filter(Boolean))];
      asked = list.length;
      want = new Set(list.slice(0, cap));
      for (const t of [...quotes.keys()]) if (!want.has(t)) quotes.delete(t);
      sync();
    },
    // a tracked market's last streamed price, only while the socket is live
    quote(ticker) { return state === 'live' ? quotes.get(String(ticker)) || null : null; },
    // tickers with a new price since the last call
    takeDirty() { const out = [...dirty]; dirty.clear(); return state === 'live' ? out : []; },
    live() { return state === 'live' && heardAt != null && now() - heardAt < o.idleMs; },
    // every market the polls asked for is subscribed (none cut by the cap, none waiting on Kalshi)
    covers() { return this.live() && asked <= want.size && [...want].every(t => subscribed.has(t)); },
    heardAt: () => heardAt,
    status() {
      return { state, url: String(url).replace(/^wss:\/\//, '').split('/')[0], asked, tracked: want.size, subscribed: subscribed.size, quotes: quotes.size, cap,
        commandGapMs: gap, openedAt: openedAt ? new Date(openedAt).toISOString() : null, heardAt: heardAt ? new Date(heardAt).toISOString() : null,
        refusedUntil: refusedUntil ? new Date(refusedUntil).toISOString() : null, lastError, ...counts };
    },
  };
}

// ── putting the streamed prices on the polled rows ──
// rows: Kalshi rows from the polls ({ id: ticker, yesAsk, noAsk, yesBid?, noBid? }).
// A streamed quote replaces the row's prices in place (NO's ask is 1 − YES's
// bid) and stamps `quoteAt`. → how many rows changed
function patchRows(rowsByTicker, tickers, stream) {
  let n = 0;
  for (const t of tickers) {
    const q = stream.quote(t);
    if (!q) continue;
    for (const row of rowsByTicker.get(t) || []) {
      row.yesAsk = q.yesAsk;
      row.noAsk = q.yesBid == null ? null : r4(1 - q.yesBid);
      if ('yesBid' in row) row.yesBid = q.yesBid;
      if ('noBid' in row) row.noBid = q.yesAsk == null ? null : r4(1 - q.yesAsk);
      row.quoteAt = new Date(q.at).toISOString();
      n++;
    }
  }
  return n;
}
// bigmoney.gameIndex output ({ rows, bets }): rebuild the Kalshi venue of
// every bet a changed ticker prices, the cheaper of its candidate rows (YES on
// one team or NO on the other). venueOf: bigmoney.exchangeVenue.
const betIndexes = new WeakMap();
function betIndexOf(games) {
  let ix = betIndexes.get(games);
  if (ix) return ix;
  ix = { byTicker: new Map(), byBet: new Map() };
  for (const x of games.rows.values()) {
    if (x.row?.exchange !== 'kalshi' || !x.row.tradable) continue;
    for (const [side, key] of [['yes', x.yes], ['no', x.no]]) {
      if (!key || !games.bets.has(key)) continue;
      const t = String(x.row.id);
      if (!ix.byTicker.has(t)) ix.byTicker.set(t, new Set());
      ix.byTicker.get(t).add(key);
      if (!ix.byBet.has(key)) ix.byBet.set(key, []);
      ix.byBet.get(key).push({ row: x.row, side });
    }
  }
  betIndexes.set(games, ix);
  return ix;
}
function patchBets(games, tickers, venueOf) {
  if (!games?.rows || !games?.bets) return 0;
  const ix = betIndexOf(games);
  const keys = new Set();
  for (const t of tickers) for (const k of ix.byTicker.get(String(t)) || []) keys.add(k);
  for (const key of keys) {
    const b = games.bets.get(key);
    let best = null;
    for (const c of ix.byBet.get(key) || []) { const v = venueOf(c.row, c.side); if (v && (!best || v.implied < best.implied)) best = v; }
    const i = b.venues.findIndex(v => v.venue === 'kalshi');
    if (i >= 0) { if (best) b.venues[i] = best; else b.venues.splice(i, 1); } else if (best) b.venues.push(best);
  }
  return keys.size;
}
const rowsByTicker = (...lists) => {
  const m = new Map();
  for (const list of lists) for (const r of list || []) {
    if (r?.exchange !== 'kalshi' || !r.id) continue;
    const t = String(r.id);
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(r);
  }
  return m;
};

module.exports = { WS_URL, WS_PATH, DEFAULTS, sign, authHeaders, pemFromEnv, parseTicker, backoffMs, createKalshiStream, patchRows, patchBets, rowsByTicker };
