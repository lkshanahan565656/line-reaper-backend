// ─── KALSHI LINK: A BETTOR'S OWN KALSHI FILLS INTO THEIR PUBLIC RECORD ──────
// The owner of a published record (/r/<handle>) can connect their Kalshi
// account with a READ-ONLY API key. Every few minutes the server reads the
// account's fills (GET /portfolio/fills) and adds each new order on a game
// line we follow (moneyline, spread or total on a game Pinnacle prices) to the
// record as a game-line bet, graded exactly like a bet logged in MY BETS:
// against Pinnacle's no-vig close at the bet's own number, settled from the
// final score (linebets.js, pubrecord.js).
//
// Why a fill counts for more than a logged bet: the price, the side and the
// time come from Kalshi, read by us with the bettor's key, never typed in.
//
// Rules this file keeps:
//   - read-only keys only. On connect we ask Kalshi for the key's own scopes
//     (GET /api_keys) and refuse, without saving anything, a key that can
//     write (trade, transfer, anything). If Kalshi can't tell us, we refuse.
//   - the private key is kept encrypted (AES-256-GCM, a key derived from
//     AUTH_SECRET), never logged, never sent back, never put in the results
//     backup. DISCONNECT (or UNPUBLISH) overwrites it.
//   - forward only: fills before the connect time are never imported, so a
//     good run can't be connected after the fact.
//   - no bet placement, no sizing, no contract counts or money on the record:
//     one order is one bet of 1 unit, the same for every user.
//   - authenticated reads never share the polite queue's response cache (two
//     users' fills must never be mixed up): this file keeps its own one-at-a-
//     time queue to Kalshi.
//
// Pure apart from the store, the http handed in and the clock.

const crypto = require('crypto');

const API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KEY_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PEM = 8192, MAX_LINKS = 500, MAX_PAGES = 10, PAGE = 200, SEEN_KEEP = 3000, OVERLAP_MS = 5 * 60e3;
const AUTH_FAILS_TO_PAUSE = 3;
const err = (status, message) => Object.assign(new Error(message), { status });
const r4 = x => Math.round(x * 1e4) / 1e4;
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// ── secrets at rest ──
const keyFrom = secret => Buffer.from(crypto.hkdfSync('sha256', String(secret), 'line-reaper', 'kalshi-link v1', 32));
function seal(secret, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(secret, box) {
  if (!box || box.v !== 1) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch { return null; }
}

// ── the key the bettor pastes ──
// → { keyId, pem, type } or { error }
function cleanKey(keyId, privateKey) {
  const id = String(keyId ?? '').trim();
  const pem = String(privateKey ?? '').trim();
  if (!KEY_ID_RE.test(id)) return { error: 'Paste the Key ID Kalshi showed when you made the key.' };
  if (!pem || pem.length > MAX_PEM || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return { error: 'Paste the whole private key, from -----BEGIN to -----END.' };
  let k;
  try { k = crypto.createPrivateKey(pem); } catch { return { error: 'That private key could not be read. Paste the whole file Kalshi gave you.' }; }
  if (!['rsa', 'ed25519'].includes(k.asymmetricKeyType)) return { error: 'Kalshi keys are RSA or Ed25519; this one is neither.' };
  return { keyId: id, pem, type: k.asymmetricKeyType };
}

// Kalshi's request signature: the timestamp (ms), the method and the path
// (no query), signed with RSA-PSS SHA-256 or Ed25519, base64.
function sign(pem, ts, method, path) {
  const key = crypto.createPrivateKey(pem);
  const msg = Buffer.from(`${ts}${method}${path}`, 'utf8');
  const sig = key.asymmetricKeyType === 'ed25519' ? crypto.sign(null, msg, key)
    : crypto.sign('sha256', msg, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  return sig.toString('base64');
}

// a key's scopes may only read: 'read' or a 'read::' child, nothing that writes
const readOnly = scopes => Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => s === 'read' || /^read::[a-z_]+$/.test(String(s)));

// ── a client for one key ──
// http: axios-style get(url, { params, headers, timeout }). queue: run(fn) one
// request at a time across every linked account.
function createQueue({ gapMs = 250, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let tail = Promise.resolve();
  return { run(fn) { const p = tail.then(fn); tail = p.then(() => sleep(gapMs), () => sleep(gapMs)); return p; } };
}
function client({ http, queue, base = API_BASE, keyId, pem, now = () => Date.now() }) {
  const root = new URL(base);
  return {
    get(sub, params = {}) {
      return queue.run(async () => {
        const path = `${root.pathname.replace(/\/+$/, '')}${sub}`;
        const ts = String(now());
        const res = await http.get(`${root.origin}${path}`, {
          params, timeout: 15000,
          headers: { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sign(pem, ts, 'GET', path), Accept: 'application/json' },
        });
        return res.data;
      });
    },
  };
}
// a Kalshi error in plain words, never echoing the request (it carries the key id)
function why(e) {
  const s = e?.response?.status;
  if (s === 401) return { status: 401, message: 'Kalshi did not accept this key. Check the Key ID and private key, or make a new read-only key.' };
  if (s === 403) return { status: 403, message: 'Kalshi refused this read for that key.' };
  if (s === 429) return { status: 429, message: 'Kalshi asked us to slow down; trying again on the next pass.' };
  if (s) return { status: s, message: `Kalshi answered ${s}.` };
  return { status: 0, message: 'Kalshi could not be reached.' };
}

// ── fills → record bets ──
// One order is one bet: its fills seen together are averaged by contracts,
// the fee spread over them. A fill positions for YES or NO (outcome_side);
// selling YES is buying NO at 1 − price, the same bet, so each fill is read as
// a buy of its own side at its own side's price.
//   lookup(ticker) → null | { yes: bet, no: bet|null } where a bet is
//   { track, event, pick, start } (server.js builds it from the odds screen)
// → { bets: [...], skipped: { before, unmatched, noSide, price }, unmatched: [ticker] }
function fillTime(f) {
  const t = Date.parse(f.created_time || '');
  if (Number.isFinite(t)) return t;
  const ts = num(f.ts);
  return ts == null ? NaN : ts < 1e12 ? ts * 1000 : ts;
}
function fillSide(f) {
  const s = String(f.outcome_side || f.side || '').toLowerCase();
  if (s === 'yes' || s === 'no') {
    // the deprecated pair (side, action): selling YES positions for NO
    if (!f.outcome_side && String(f.action || '').toLowerCase() === 'sell') return s === 'yes' ? 'no' : 'yes';
    return s;
  }
  const b = String(f.book_side || '').toLowerCase();
  return b === 'bid' ? 'yes' : b === 'ask' ? 'no' : null;
}
function fillPrice(f, side) {
  const d = num(side === 'yes' ? f.yes_price_dollars : f.no_price_dollars);
  if (d != null) return d;
  const c = num(side === 'yes' ? f.yes_price : f.no_price);   // older responses: cents
  return c == null ? null : c / 100;
}
function fillsToBets(fills, lookup, { since = 0 } = {}) {
  const skipped = { before: 0, unmatched: 0, noSide: 0, price: 0 };
  const unmatched = new Set();
  const orders = new Map();
  for (const f of fills || []) {
    if (!f || !f.fill_id && !f.trade_id) continue;
    const t = fillTime(f);
    if (!(t >= since)) { skipped.before++; continue; }
    const side = fillSide(f);
    const px = side && fillPrice(f, side);
    const n = num(f.count_fp ?? f.count);
    if (!side) { skipped.noSide++; continue; }
    if (!(px > 0 && px < 1) || !(n > 0)) { skipped.price++; continue; }
    const ticker = String(f.ticker || f.market_ticker || '');
    const hit = ticker ? lookup(ticker) : null;
    const bet = hit && hit[side];
    if (!bet) { skipped.unmatched++; if (ticker) unmatched.add(ticker); continue; }
    const id = String(f.order_id || f.fill_id || f.trade_id);
    const o = orders.get(id) || { id, bet, ticker, side, n: 0, cost: 0, fee: 0, first: t, fills: 0 };
    o.n += n; o.cost += n * px; o.fee += Math.max(0, num(f.fee_cost) ?? 0); o.first = Math.min(o.first, t); o.fills++;
    orders.set(id, o);
  }
  const bets = [];
  for (const o of orders.values()) {
    const per = (o.cost + o.fee) / o.n;
    if (!(per > 0 && per < 1)) { skipped.price++; continue; }
    bets.push({
      id: `kalshi-${o.id}`.slice(0, 80), venue: 'kalshi_fill', venueName: 'Kalshi (connected)', event: o.bet.event, pick: o.bet.pick,
      decimal: r4(1 / per), track: o.bet.track, start: o.bet.start || null,
      verified: { by: 'kalshi', filledAt: new Date(o.first).toISOString(), ticker: o.ticker, side: o.side, fills: o.fills },
    });
  }
  return { bets, skipped, unmatched: [...unmatched] };
}

// a line shop bet key ('<id>|ml|home', '<id>|total|<pts>|over',
// '<id>|spread|<home pts>|away'; bigmoney.rowBets) on an odds-screen game →
// the record bet MY BETS would log for it, or null (a three-way result, a
// period line: not followed to Pinnacle's close)
function betForKey(key, g, league) {
  if (!key || !g) return null;
  const p = String(key).split('|'), kind = p[1], side = p[p.length - 1];
  const team = side === 'home' ? g.home_team : side === 'away' ? g.away_team : null;
  let t = null;
  if (kind === 'ml' && team) t = { market: 'ml', side: team, point: null };
  else if (kind === 'total' && (side === 'over' || side === 'under')) t = { market: 'total', side: side === 'over' ? 'Over' : 'Under', point: num(p[2]) };
  else if (kind === 'spread' && team) t = { market: 'spread', side: team, point: num(p[2]) };
  if (!t || (t.market !== 'ml' && t.point == null)) return null;
  const own = t.market === 'spread' ? (side === 'home' ? t.point : -t.point) : t.point;
  const pick = t.market === 'ml' ? `${team} ML` : t.market === 'total' ? `${t.side} ${t.point}` : `${team} ${own > 0 ? '+' : ''}${own}`;
  return { track: { kind: 'line', game: String(g.id), league, ...t, start: g.commence_time }, event: `${g.away_team} @ ${g.home_team}`, pick, start: g.commence_time };
}

// ── the links ──
// store: { init(), all(), put(doc) }. Docs: { id: 'kl|<handle>', handle,
// status: 'active'|'paused'|'off', box (sealed { keyId, pem }), keyHint,
// scopes, connectedAt, lastPollAt, lastOkAt, lastFillAt, lastError, authFails,
// seen: [fill ids], counts: { fills, imported, sameOrder, before, unmatched, ... },
// unmatched: [tickers] }.
function createKalshiLinks({ store, secret, http, base = API_BASE, now = () => Date.now(), log = console, queue = createQueue(), maxLinks = MAX_LINKS } = {}) {
  const links = new Map();
  let ready = null;
  const state = { lastRun: null, lastMs: null, polled: 0, imported: 0, errors: 0, running: false };
  function init() {
    if (!ready) ready = (async () => { await store.init?.(); for (const d of await store.all()) if (d && d.handle) links.set(d.handle, d); })()
      .catch(e => log.warn?.(`Kalshi link: load failed: ${e.message}`));
    return ready;
  }
  const put = async d => { links.set(d.handle, d); await store.put(d); };
  // a poll's write, unless the owner disconnected or reconnected while it ran
  const putIfSame = async (was, d) => { if (links.get(was.handle) !== was) return; await put(d); };
  const active = () => [...links.values()].filter(d => d.status === 'active' && d.box);

  // what the owner sees: never the key itself
  function view(d) {
    if (!d || d.status === 'off' || !d.box) return { connected: false };
    return { connected: true, status: d.status, keyHint: d.keyHint, scopes: d.scopes, connectedAt: d.connectedAt, lastPollAt: d.lastPollAt || null, lastOkAt: d.lastOkAt || null,
      lastFillAt: d.lastFillAt || null, lastError: d.lastError || null, counts: { ...(d.counts || {}) }, unmatched: (d.unmatched || []).slice(0, 10) };
  }

  // the key's scopes, from Kalshi itself → [scope] (throws in plain words)
  async function scopesOf(k) {
    let data;
    try { data = await client({ http, queue, base, keyId: k.keyId, pem: k.pem, now }).get('/api_keys'); }
    catch (e) { throw err(e?.response?.status === 401 ? 400 : 502, why(e).message); }
    const mine = (data?.api_keys || []).find(x => x && x.api_key_id === k.keyId);
    if (!mine || !Array.isArray(mine.scopes)) throw err(400, 'Kalshi did not list this key\'s permissions, so we can\'t confirm it is read-only. Nothing was saved.');
    return mine.scopes.map(String);
  }

  async function connect(handle, keyId, privateKey) {
    await init();
    const k = cleanKey(keyId, privateKey);
    if (k.error) throw err(400, k.error);
    if (!links.has(handle) && active().length >= maxLinks) throw err(503, 'No new Kalshi connections can be made right now.');
    const scopes = await scopesOf(k);
    if (!readOnly(scopes)) throw err(400, `This key can ${scopes.filter(s => /^write/.test(s)).join(', ') || 'more than read'}. Line Reaper only takes a read-only key: make one with the read scope only. Nothing was saved.`);
    const at = new Date(now()).toISOString();
    const doc = { id: `kl|${handle}`, handle, status: 'active', box: seal(secret, { keyId: k.keyId, pem: k.pem }), keyHint: `…${k.keyId.slice(-4)}`, keyType: k.type, scopes,
      connectedAt: at, lastPollAt: null, lastOkAt: null, lastFillAt: null, lastError: null, authFails: 0, seen: [], counts: { fills: 0, imported: 0, sameOrder: 0, before: 0, unmatched: 0, noSide: 0, price: 0 }, unmatched: [] };
    await put(doc);
    return view(doc);
  }

  // the key is overwritten, the counts kept for the owner's own reference
  async function disconnect(handle) {
    await init();
    const d = links.get(handle);
    if (!d || d.status === 'off') return { connected: false };
    await put({ id: d.id, handle, status: 'off', box: null, disconnectedAt: new Date(now()).toISOString(), counts: d.counts || {} });
    return { connected: false };
  }
  const status = async handle => { await init(); return view(links.get(handle)); };

  // one account's new fills → the record. addBets(handle, bets) → { added, skipped }
  async function pollOne(d, { lookup, addBets }) {
    const k = open(secret, d.box);
    if (!k) { await putIfSame(d, { ...d, status: 'paused', lastError: 'The saved key could not be read (the server secret changed). Connect again.' }); return 0; }
    const t = now();
    const since = Date.parse(d.connectedAt);
    const from = Math.max(since, (Date.parse(d.lastFillAt || '') || since) - OVERLAP_MS);
    const c = client({ http, queue, base, keyId: k.keyId, pem: k.pem, now });
    const fills = [];
    try {
      let cursor = '';
      for (let i = 0; i < MAX_PAGES; i++) {
        const data = await c.get('/portfolio/fills', { min_ts: Math.floor(from / 1000), limit: PAGE, ...(cursor ? { cursor } : {}) });
        fills.push(...(Array.isArray(data?.fills) ? data.fills : []));
        cursor = data?.cursor || '';
        if (!cursor || !(data?.fills?.length)) break;
      }
    } catch (e) {
      const w = why(e);
      const authFails = w.status === 401 ? (d.authFails || 0) + 1 : 0;
      const paused = authFails >= AUTH_FAILS_TO_PAUSE;
      await putIfSame(d, { ...d, lastPollAt: new Date(t).toISOString(), lastError: paused ? `${w.message} Paused after ${authFails} tries: connect again.` : w.message, authFails, status: paused ? 'paused' : d.status });
      state.errors++;
      return 0;
    }
    const seen = new Set(d.seen || []);
    const fresh = fills.filter(f => { const id = String(f?.fill_id || f?.trade_id || ''); return id && !seen.has(id); });
    const out = fillsToBets(fresh, lookup, { since });
    let added = 0, same = 0;
    if (links.get(d.handle) !== d) return 0;
    if (out.bets.length) { const r = await addBets(d.handle, out.bets); added = r.added || 0; same = r.skipped || 0; }
    for (const f of fresh) seen.add(String(f.fill_id || f.trade_id));
    const latest = fills.reduce((m, f) => Math.max(m, fillTime(f) || 0), Date.parse(d.lastFillAt || '') || 0);
    const cnt = { ...(d.counts || {}) };
    cnt.fills = (cnt.fills || 0) + fresh.length; cnt.imported = (cnt.imported || 0) + added; cnt.sameOrder = (cnt.sameOrder || 0) + same;
    for (const [k2, v] of Object.entries(out.skipped)) cnt[k2] = (cnt[k2] || 0) + v;
    await putIfSame(d, { ...d, lastPollAt: new Date(t).toISOString(), lastOkAt: new Date(t).toISOString(), lastError: null, authFails: 0,
      lastFillAt: latest ? new Date(latest).toISOString() : d.lastFillAt || null, seen: [...seen].slice(-SEEN_KEEP), counts: cnt,
      unmatched: [...new Set([...out.unmatched, ...(d.unmatched || [])])].slice(0, 20) });
    return added;
  }

  // every active link, one after another; onAdded(handle) after a record got bets
  async function pollAll({ lookup, addBets, onAdded = () => {} } = {}) {
    if (state.running) return state;
    state.running = true;
    const t0 = now();
    let polled = 0, imported = 0;
    try {
      await init();
      for (const d of active()) {
        try { const n = await pollOne(d, { lookup, addBets }); polled++; imported += n; if (n) onAdded(d.handle); }
        catch (e) { state.errors++; log.warn?.(`Kalshi link: ${d.handle}: ${e.message}`); }
      }
    } finally { Object.assign(state, { running: false, lastRun: new Date(now()).toISOString(), lastMs: now() - t0, polled, imported }); }
    return state;
  }
  const stats = () => ({ active: active().length, paused: [...links.values()].filter(d => d.status === 'paused').length, ...state });
  return { init, connect, disconnect, status, pollAll, pollOne, stats, links };
}

module.exports = { betForKey, createKalshiLinks, createQueue, client, cleanKey, sign, readOnly, fillsToBets, fillSide, fillPrice, seal, open, API_BASE };
