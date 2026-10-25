// ─── PROVIDER ADAPTERS: EVERY FEED THE SERVER READS → QUOTE RECORDS ──────────
// The server already reads each venue on its own schedule (refreshFreeBooks
// for Pinnacle, FanDuel, BetRivers, Matchbook, Action Network's books, Gemini
// and Polymarket US; the exchange poll for Kalshi). These adapters do not
// fetch again: they turn what those reads left in memory into
// oddsschema quotes, one adapter per feed, each in its own try so one bad
// feed never empties the others, and report each provider's health.
//
// createSource is the fetch policy a NEW adapter should use (timeout, retries
// with exponential backoff, Retry-After, cancellation, a TTL cache, health),
// so a provider added later gets the same guarantees without copying them.
//
// Pure functions except createSource, which runs the fetch it is given.

const schema = require('./oddsschema');
const { canonMarket, canonName } = require('./ev');

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const decOfAmerican = a => schema.toDecimal(num(a), 'american');
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };

// ── adapter: the merged free-books games (freeBooksState.games) ──
// gamesByLeague: { league: [Odds API shaped games] }; readAt: when they were
// read (an ISO time, or { provider: time, default: time })
function sideOfName(name, g) {
  if (name === g.home_team) return 'home';
  if (name === g.away_team) return 'away';
  if (/^draw$/i.test(name)) return 'draw';
  if (/^over$/i.test(name)) return 'over';
  if (/^under$/i.test(name)) return 'under';
  return null;
}
function fromFreeGames(gamesByLeague = {}, { readAt = null, sportOf = lg => lg } = {}) {
  const quotes = [];
  const mk = new Map();
  const canonM = k => { let v = mk.get(k); if (v === undefined) { v = canonMarket(k); mk.set(k, v); } return v; };
  const seen = {};
  for (const [league, games] of Object.entries(gamesByLeague || {})) {
    for (const g of games || []) {
      const base = { sport: sportOf(league), league, competition: league, eventId: String(g.id), home: g.home_team, away: g.away_team, startUtc: g.commence_time || null };
      for (const bm of g.bookmakers || []) {
        const pid = bm.key;
        if (!schema.PROVIDERS[pid]) continue;
        // each feed's own read time when the caller knows it (Gemini and the
        // copies are read on their own clocks), else the merge's
        const updatedAt = readAt && typeof readAt === 'object' ? (readAt[pid] ?? readAt.default ?? null) : readAt;
        const st = seen[pid] || (seen[pid] = { events: new Set(), quotes: 0 });
        const push = f => {
          const decimal = decOfAmerican(f.price);
          if (!decimal) return;
          const q = schema.makeQuote({ ...base, updatedAt, providerId: pid, originalFormat: 'american', originalPrice: num(f.price), decimal,
            externalEventId: bm.eventId || null, sourceIds: f.ref ? { ...f.ref } : null, ...f.q });
          quotes.push(q);
          st.events.add(base.eventId); st.quotes++;
        };
        for (const m of bm.markets || []) {
          const n = (m.outcomes || []).length;
          for (const o of m.outcomes || []) {
            if (m.key === 'h2h') {
              const side = sideOfName(o.name, g);
              if (!side) continue;
              push({ price: o.price, ref: o.ref, q: { marketType: 'moneyline', marketName: n === 3 ? 'Moneyline (3-way)' : 'Moneyline', marketId: `${base.eventId}|ml${n === 3 ? 3 : ''}`,
                selectionName: o.name, side, line: null, period: league && /^(epl|laliga|bundesliga|seriea|ligue1|mls|ligamx|eredivisie|brasileirao|ucl|uel)$/.test(league) ? 'regulation' : 'full_game' } });
            } else if (m.key === 'spreads') {
              const side = sideOfName(o.name, g), pt = num(o.point);
              if (!side || pt == null) continue;
              push({ price: o.price, ref: o.ref, q: { marketType: 'spread', marketName: 'Spread', selectionName: `${o.name} ${pt > 0 ? '+' : ''}${pt}`, side, line: pt, period: 'full_game' } });
            } else if (m.key === 'totals') {
              const side = sideOfName(o.name, g), pt = num(o.point);
              if (!side || pt == null) continue;
              push({ price: o.price, ref: o.ref, q: { marketType: 'total', marketName: 'Total', selectionName: `${side === 'over' ? 'Over' : 'Under'} ${pt}`, side, line: pt, period: 'full_game' } });
            } else if (o.description && /^(over|under)$/i.test(o.name)) {
              const pt = num(o.point);
              if (pt == null) continue;
              const side = o.name.toLowerCase();
              push({ price: o.price, q: { marketType: 'player_prop', marketName: canonM(m.key), player: o.description,
                selectionName: `${o.description} ${side === 'over' ? 'Over' : 'Under'} ${pt}`, side, line: pt, period: 'full_game' } });
            }
          }
        }
        // one-way alternate rungs (FanDuel, BetRivers): a price on one side only
        for (const a of bm.altLines || []) {
          const side = sideOfName(a.name, g), pt = num(a.point);
          if (!side || pt == null) continue;
          const type = a.kind === 'totals' ? 'total' : 'spread';
          push({ price: a.price, q: { marketType: type, marketName: type === 'total' ? 'Total (alt)' : 'Spread (alt)', oneWay: true, line: pt, side, period: 'full_game',
            selectionName: type === 'total' ? `${side === 'over' ? 'Over' : 'Under'} ${pt}` : `${a.name} ${pt > 0 ? '+' : ''}${pt}` } });
        }
      }
    }
  }
  const stats = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { events: v.events.size, quotes: v.quotes }]));
  return { quotes, stats };
}

// ── adapter: Kalshi game contracts (bigmoney.gameIndex bets) ──
// bets: Map key → { key `${pinId}|ml|home` …, game, league, venues [{ venue,
// decimal (ask + fee), american, url, marketId, price, side, mid }] }
function fromKalshiBets(bets, { readAt = null, sportOf = lg => lg, venue = 'kalshi' } = {}) {
  const quotes = [];
  const events = new Set();
  for (const b of (bets && bets.values ? bets.values() : []) || []) {
    const v = (b.venues || []).find(x => x.venue === venue);
    if (!v || !(v.decimal > 1)) continue;
    const parts = String(b.key).split('|');
    const gid = parts[0], kind = parts[1];
    const g = b.game || {};
    const eventId = `pin-${gid}`;
    const base = { providerId: venue, sport: sportOf(b.league), league: b.league, competition: b.league, eventId, home: g.home, away: g.away, startUtc: g.start || null,
      updatedAt: readAt, decimal: v.decimal, effectiveDecimal: v.decimal, originalFormat: 'probability', originalPrice: v.implied ?? null, marketId: v.marketId || null,
      sourceIds: { marketId: v.marketId || null, buy: v.side || null, url: v.url || null }, period: 'full_game' };
    let q = null;
    if (kind === 'ml' || kind === 'ml3') {
      const side = parts[2];
      const name = side === 'home' ? g.home : side === 'away' ? g.away : 'Draw';
      q = { ...base, marketType: 'moneyline', marketName: kind === 'ml3' ? 'Moneyline (3-way)' : 'Moneyline', marketId: `${eventId}|${kind}`, selectionName: name, side, line: null };
    } else if (kind === 'spread') {
      const homePt = num(parts[2]), side = parts[3];
      if (homePt == null) continue;
      const pt = side === 'home' ? homePt : -homePt;
      const name = side === 'home' ? g.home : g.away;
      q = { ...base, marketType: 'spread', marketName: 'Spread', selectionName: `${name} ${pt > 0 ? '+' : ''}${pt}`, side, line: pt };
    } else if (kind === 'total') {
      const pt = num(parts[2]), side = parts[3];
      if (pt == null) continue;
      q = { ...base, marketType: 'total', marketName: 'Total', selectionName: `${side === 'over' ? 'Over' : 'Under'} ${pt}`, side, line: pt };
    }
    if (!q) continue;
    quotes.push(schema.makeQuote(q));
    events.add(eventId);
  }
  return { quotes, stats: { [venue]: { events: events.size, quotes: quotes.length } } };
}

// ── health ──
// One row per provider: off (switched off by a setting), down (nothing read
// and an error), degraded (read, with errors), stale (last read too old),
// ok. errors: strings like "fanduel nfl: 403" from the reads.
function health({ stats = {}, errors = [], readAt = {}, enabled = {}, maxAgeMs = 15 * 60e3, now = Date.now() } = {}) {
  return schema.providerList().map(p => {
    const s = stats[p.id] || { events: 0, quotes: 0 };
    const errs = (errors || []).filter(e => {
      const t = String(e).toLowerCase();
      if (p.access === 'second_hand') return t.startsWith('action') || t.startsWith(p.id);
      return t.startsWith(p.id) || t.startsWith(p.name.toLowerCase());
    }).slice(0, 3);
    const at = readAt[p.id] || null;
    const age = at ? now - ms(at) : null;
    let status = 'ok';
    if (enabled[p.id] === false) status = 'off';
    else if (!s.quotes && (errs.length || !at)) status = 'down';
    else if (age != null && age > maxAgeMs) status = 'stale';
    else if (errs.length) status = 'degraded';
    else if (!s.quotes) status = 'empty';
    return { id: p.id, name: p.name, type: p.type, access: p.access, texas: p.texas, reference: !!p.reference, feed: p.feed, status,
      events: s.events, quotes: s.quotes, readAt: at, ageSec: age == null ? null : Math.round(age / 1000), errors: errs, fee: p.fee, note: p.note || null };
  });
}

// ── the fetch policy for new adapters ──
// fetch(signal) → Promise(payload). validate(payload) → true or an error
// string. A 429 or 503 honours Retry-After (seconds) up to maxWaitMs.
function retryAfterMs(err) {
  const h = err?.response?.headers;
  const v = h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']);
  const s = num(v);
  return s != null ? s * 1000 : null;
}
function createSource({ id, fetch, timeoutMs = 10000, retries = 2, backoffMs = 500, maxWaitMs = 30000, ttlMs = 60e3, validate = null,
  sleep = t => new Promise(r => setTimeout(r, t)), now = () => Date.now(), log = null } = {}) {
  if (!id || typeof fetch !== 'function') throw new Error('createSource needs an id and a fetch');
  const st = { ok: null, error: null, lastOkAt: null, lastErrorAt: null, calls: 0, failures: 0, blockedUntil: 0 };
  let cache = null, inflight = null;
  async function once() {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { rej(Object.assign(new Error(`${id}: timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })); ac?.abort(); }, timeoutMs); });
    try { return await Promise.race([fetch(ac?.signal), timeout]); } finally { clearTimeout(timer); }
  }
  async function run() {
    let last;
    for (let i = 0; i <= retries; i++) {
      if (now() < st.blockedUntil) throw Object.assign(new Error(`${id}: rate limited for ${Math.ceil((st.blockedUntil - now()) / 1000)} s`), { code: 'RATE_LIMITED' });
      st.calls++;
      try {
        const payload = await once();
        const v = validate ? validate(payload) : true;
        if (v !== true) throw Object.assign(new Error(`${id}: bad response: ${v || 'failed validation'}`), { code: 'INVALID' });
        Object.assign(st, { ok: true, error: null, lastOkAt: now() });
        cache = { at: now(), payload };
        return payload;
      } catch (e) {
        last = e;
        st.failures++;
        const code = e?.response?.status;
        const wait = retryAfterMs(e);
        if ((code === 429 || code === 503) && wait != null) {
          st.blockedUntil = now() + Math.min(wait, maxWaitMs);
          if (wait > maxWaitMs) break;
          await sleep(Math.min(wait, maxWaitMs));
          continue;
        }
        // client errors other than 408/429 will not get better by asking again
        if (code && code >= 400 && code < 500 && code !== 408 && code !== 429) break;
        if (e?.code === 'INVALID') break;
        if (i < retries) await sleep(backoffMs * 2 ** i);
      }
    }
    // a message without query strings, so a key in a URL never lands in a log
    const msg = String(last?.response?.status ? `${id}: HTTP ${last.response.status}` : last?.message || 'failed').replace(/\?\S*/g, '?…');
    Object.assign(st, { ok: false, error: msg, lastErrorAt: now() });
    if (log) log(msg);
    throw Object.assign(new Error(msg), { code: last?.code || last?.response?.status || 'FAILED' });
  }
  async function get({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return cache.payload;
    if (inflight) return inflight;
    inflight = run().finally(() => { inflight = null; });
    return inflight;
  }
  const healthOf = () => ({ id, status: st.ok == null ? 'unknown' : st.ok ? 'ok' : 'down', error: st.error, lastOkAt: st.lastOkAt, lastErrorAt: st.lastErrorAt,
    calls: st.calls, failures: st.failures, cachedAt: cache?.at || null, rateLimitedUntil: st.blockedUntil > now() ? st.blockedUntil : null });
  return { get, health: healthOf, cached: () => cache };
}

module.exports = { fromFreeGames, fromKalshiBets, health, createSource, retryAfterMs, canonName };
