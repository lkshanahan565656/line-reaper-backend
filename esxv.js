// ─── ESPORTS: KALSHI-LED POLYMARKET US (MATCH WINNERS) ───────────────────────
// Esports match winners trade on three US-reachable books: Kalshi, Polymarket
// US and (for reference only) Polymarket. Kalshi's esports match books are now
// tight (LoL 1.7¢ median at T-60) and, on 2026 history, Kalshi's mid was the
// better price: where Polymarket sat 2¢+ away in the last half hour, the
// Polymarket side was the one that won (LoL T-30 +15¢ a contract over 118,
// Valorant T-10 +14¢ over 176, Dota T-10 +9¢ over 81; CS2 flat). Polymarket
// US lists the same esports match winners from Texas, so this follows its
// ask against Kalshi's mid:
//
//   fair      Kalshi's two yes mids, normalised, when both books are 4¢ or
//             tighter (Pinnacle's no-vig is stored next to it, not used)
//   flag      Polymarket US ask + its taker fee at least minEdge under fair,
//             at most windowMin before the scheduled start
//   close     Kalshi's fair at the last read before the start (and Pinnacle's)
//   result    Kalshi's settled market for that team (yes = win)
//
// One row per match and side, logged the first time it flags. Alerts off:
// judged at 50 graded on the close and on results before anyone bets it.

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const amount = v => num(v && typeof v === 'object' ? v.value : v);
const inUnit = p => (p != null && p > 0 && p < 1 ? p : null);

const DEFAULTS = {
  minEdge: 0.02,       // 2¢ a contract under fair, fee in
  windowMin: 90,       // flag only in the last 90 minutes before the start
  maxSpread: 0.04,     // Kalshi books wider than this aren't the fair
  maxPairHours: 3,     // Polymarket US and the board's start within 3 h
  feeRate: 0.0695,     // Polymarket US taker fee coefficient x p(1-p)
  minPrice: 0.08, maxPrice: 0.92,
  gradeAfterMs: 3 * 3600e3,
  minN: 50,
};
const GAME_LEAGUES = { CS2: 'cs2', LOL: 'lol', VAL: 'valorant', DOTA: 'dota2' };
const GATEWAY = 'https://gateway.polymarket.us';
const KALSHI_MARKET = 'https://api.elections.kalshi.com/trade-api/v2/markets/';

const key = n => String(n || '').toLowerCase().replace(/['’]s\b/g, '').replace(/\b(team|esports?|gaming|club|gc)\b/g, '').replace(/[^a-z0-9]/g, '');
const SECOND = /^(academy|rising|nxt|junior|youth|global|next|ii|2|female|fe)/;
function sameTeam(a, b) {
  const x = key(a), y = key(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 3 || y.length < 3) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return l.startsWith(s) && !SECOND.test(l.slice(s.length));
}
const fee = (p, rate = DEFAULTS.feeRate) => (inUnit(p) ? r4(rate * p * (1 - p)) : 0);

// ── Polymarket US ──
// one league's events payload → [{ game, slug, event, start, live, ended, long, short, bid, ask, feeRate }]
// bid / ask are the LONG team's; the short team buys at 1 − bid
function parsePmusEvents(payload, game) {
  const evs = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const e of evs) {
    for (const m of e.markets || []) {
      if (m.sportsMarketType !== 'esports_match_winner') continue;
      const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
      const isLong = s => s?.long === true || s?.long === 'true';
      const name = s => s?.team?.name || s?.description || null;
      const L = sides.find(isLong), S = sides.find(s => s && s !== L);
      if (!name(L) || !name(S)) continue;
      const fr = num(m.feeCoefficient);
      out.push({
        game, slug: m.slug, event: e.slug, start: Date.parse(e.startTime || e.startDate || '') || null,
        live: !!e.live, ended: !!e.ended || m.closed === true, long: name(L), short: name(S),
        bid: inUnit(amount(m.bestBidQuote)), ask: inUnit(amount(m.bestAskQuote)),
        feeRate: fr != null && fr >= 0 && fr < 1 ? fr : DEFAULTS.feeRate,
      });
    }
  }
  return out;
}
async function fetchPmusEsports(http, { leagues = GAME_LEAGUES, pages = 4 } = {}) {
  const out = [];
  for (const [game, lg] of Object.entries(leagues)) {
    for (let p = 0; p < pages; p++) {
      const res = await http.get(`${GATEWAY}/v2/leagues/${lg}/events`, { params: { limit: 50, offset: p * 50 }, timeout: 8000 });
      const rows = parsePmusEvents(res?.data, game);
      out.push(...rows);
      if ((res?.data?.events || []).length < 50) break;
    }
  }
  return out;
}
// the Polymarket US market for a board match: same game, both teams, start close
function pmusFor(board, pmus, o = DEFAULTS) {
  let best = null;
  for (const q of pmus) {
    if (q.game !== board.game) continue;
    const same = sameTeam(q.long, board.teams[0]) && sameTeam(q.short, board.teams[1]);
    const flip = sameTeam(q.long, board.teams[1]) && sameTeam(q.short, board.teams[0]);
    if (!same && !flip) continue;
    const gap = q.start && board.start ? Math.abs(q.start - board.start) : 0;
    if (gap > o.maxPairHours * 3600e3) continue;
    if (!best || gap < best.gap) best = { q, longIdx: same ? 0 : 1, gap };
  }
  return best;
}

// ── fair from Kalshi ──
// the board's match market → { fair: [p0, p1], spread, tickers } | null
function kalshiFair(mk, o = DEFAULTS) {
  const q = mk?.outcomes?.map(oc => oc.quotes?.kalshi);
  if (!q || q.length !== 2 || q.some(x => !x || !inUnit(x.bid) || !inUnit(x.ask))) return null;
  const spread = Math.max(q[0].ask - q[0].bid, q[1].ask - q[1].bid);
  if (spread > o.maxSpread + 1e-9) return null;
  const m0 = (q[0].bid + q[0].ask) / 2, m1 = (q[1].bid + q[1].ask) / 2;
  if (m0 + m1 <= 0) return null;
  return { fair: [r4(m0 / (m0 + m1)), r4(m1 / (m0 + m1))], spread: r4(spread), tickers: [q[0].ticker || null, q[1].ticker || null] };
}
const pinFair = mk => { const p = mk?.outcomes?.map(oc => oc.quotes?.pinnacle?.prob); return p && p.every(x => inUnit(x)) ? { fair: p.map(r4), limit: mk.outcomes[0].quotes.pinnacle.limit ?? null } : null; };

// Pure: board matches + Polymarket US quotes → this scan's signals and the
// fair of every paired match (for the close)
function scanSignals(matches = [], pmus = [], { now = Date.now(), opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const signals = [], fairs = new Map();
  for (const m of matches) {
    if (!GAME_LEAGUES[m.game] || m.live || !m.start) continue;
    const mk = (m.markets || []).find(x => x.kind === 'match');
    const kf = kalshiFair(mk, o);
    if (!kf) continue;
    const hit = pmusFor(m, pmus, o);
    if (!hit || hit.q.live || hit.q.ended) continue;
    const pin = pinFair(mk);
    const id = `${m.game}|${hit.q.slug}`;
    fairs.set(id, { kalshi: kf.fair, pin: pin?.fair || null, at: now });
    const mins = (m.start - now) / 60e3;
    if (mins <= 0 || mins > o.windowMin) continue;
    for (const i of [0, 1]) {
      // buy team i: the long side at the ask, the short side at 1 − bid
      const isLong = hit.longIdx === i;
      const price = isLong ? hit.q.ask : hit.q.bid == null ? null : r4(1 - hit.q.bid);
      if (!inUnit(price) || price < o.minPrice || price > o.maxPrice) continue;
      const cost = r4(price + fee(price, hit.q.feeRate));
      const edge = r4(kf.fair[i] - cost);
      if (edge < o.minEdge - 1e-9) continue;
      signals.push({
        id: `${id}|${i}`, pair: id, game: m.game, label: m.label || m.game, teams: m.teams, team: m.teams[i], side: i,
        start: new Date(m.start).toISOString(), bestOf: m.bestOf || null, slug: hit.q.slug, event: hit.q.event, longSide: isLong,
        price, cost, fair: kf.fair[i], edge, kalshiSpread: kf.spread, kalshiTicker: kf.tickers[i], pinFair: pin ? pin.fair[i] : null, pinLimit: pin?.limit ?? null,
        minsBefore: Math.round(mins),
      });
    }
  }
  return { signals, fairs };
}

// Pure: one graded row's line on the record
function gradeOf(r, won) {
  const profit = won ? r4((1 - r.cost) / r.cost) : -1;
  return { status: 'graded', outcome: won ? 'win' : 'loss', profit };
}
// Pure: rows → the record card at the 50-graded bar
function summarize(rows = [], o = DEFAULTS) {
  const g = rows.filter(r => r.status === 'graded');
  const n = g.length, wins = g.filter(r => r.outcome === 'win').length;
  const units = g.reduce((a, r) => a + (r.profit || 0), 0);
  const be = g.reduce((a, r) => a + r.cost, 0), sd = Math.sqrt(g.reduce((a, r) => a + r.cost * (1 - r.cost), 0));
  const z = n && sd > 0 ? (wins - be) / sd : null;
  const clvRows = rows.filter(r => r.closeFair != null && r.status !== 'void');
  const clv = clvRows.map(r => r.closeFair - r.cost);
  const mean = clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null;
  const sdc = clv.length > 1 ? Math.sqrt(clv.reduce((a, x) => a + (x - mean) ** 2, 0) / (clv.length - 1)) : null;
  const clvT = mean != null && sdc ? mean / (sdc / Math.sqrt(clv.length)) : null;
  const verdict = n < o.minN ? 'early' : z <= -2 ? 'failed' : z >= 2 && clvT >= 2 ? 'beats' : wins < be ? 'losing' : 'ahead';
  return {
    flagged: rows.length, open: rows.filter(r => r.status === 'open' || r.status === 'locked').length,
    graded: n, wins, losses: n - wins, units: r2(units), roi: n ? r2(units / n * 100) : null,
    hitPct: n ? Math.round(wins / n * 1000) / 10 : null, breakEvenPct: n ? Math.round(be / n * 1000) / 10 : null, z: r2(z),
    clvN: clv.length, clvCents: mean != null ? r2(mean * 100) : null, clvT: r2(clvT),
    minN: o.minN, left: Math.max(0, o.minN - n), verdict,
  };
}

// The backtest this record follows (2026-04 to 10-14, Polymarket's price
// history against Kalshi's minute books, results from Kalshi's settlement,
// which matched bo3.gg / lolesports on 99.9% of joined matches). Polymarket's
// price there is its history point, not a live ask: the record decides.
const BACKTEST = {
  source: 'Polymarket price history vs Kalshi minute books, 2026-04-17 to 2026-10-14',
  rows: [
    { game: 'LOL', at: 'T-30', gap: '2c+', n: 118, centsPerContract: 15.3, t: 4.3 },
    { game: 'VAL', at: 'T-10', gap: '2c+', n: 176, centsPerContract: 13.6, t: 4.0 },
    { game: 'DOTA', at: 'T-10', gap: '2c+', n: 81, centsPerContract: 9.1, t: 1.8 },
    { game: 'CS2', at: 'T-10', gap: '2c+', n: 110, centsPerContract: -1.9, t: -0.5 },
  ],
};

function createXvTracker({ store, http = null, now = () => Date.now(), log = console, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ready = store.init();
  const open = new Map(), seen = new Set();
  const loaded = ready.then(async () => { for (const r of await store.all()) { seen.add(r.id); if (r.status === 'open' || r.status === 'locked') open.set(r.id, r); } });
  let last = { at: null, paired: 0, signals: 0, pmus: 0 };

  async function record(matches, pmus) {
    await loaded;
    const t = now();
    const { signals, fairs } = scanSignals(matches, pmus, { now: t, opts: o });
    last = { at: new Date(t).toISOString(), paired: fairs.size, signals: signals.length, pmus: pmus.length };
    const writes = [];
    for (const s of signals) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const r = { ...s, status: 'open', flaggedAt: new Date(t).toISOString(), closeFair: s.fair, closePin: s.pinFair, closeAt: new Date(t).toISOString(), outcome: null, profit: null };
      open.set(r.id, r);
      writes.push(store.put(r));
    }
    for (const r of open.values()) {
      if (r.status !== 'open') continue;
      const f = fairs.get(r.pair);
      const started = Date.parse(r.start) <= t;
      if (f && !started) { r.closeFair = f.kalshi[r.side]; r.closePin = f.pin ? f.pin[r.side] : r.closePin; r.closeAt = new Date(t).toISOString(); writes.push(store.put(r)); }
      if (started) { r.status = 'locked'; writes.push(store.put(r)); }
    }
    await Promise.all(writes).catch(e => log.warn?.(`Esports cross-venue tracker: ${e.message}`));
    return { signals, fairs };
  }

  // results from Kalshi's settled market for the team bought
  async function grade() {
    await loaded;
    if (!http) return;
    const t = now();
    for (const r of [...open.values()]) {
      if (Date.parse(r.start) + o.gradeAfterMs > t || !r.kalshiTicker) continue;
      let m = null;
      try { m = (await http.get(KALSHI_MARKET + encodeURIComponent(r.kalshiTicker), { timeout: 15000 }))?.data?.market; } catch (e) { log.warn?.(`Esports cross-venue tracker: ${r.kalshiTicker}: ${e.message}`); continue; }
      if (m?.result === 'yes' || m?.result === 'no') Object.assign(r, gradeOf(r, m.result === 'yes'), { gradedAt: new Date(t).toISOString() });
      else if (Date.parse(r.start) + 4 * 86400e3 <= t) Object.assign(r, { status: 'void', note: `Kalshi result ${m?.result || 'missing'}` });
      else continue;
      open.delete(r.id);
      await store.put(r).catch(e => log.warn?.(`Esports cross-venue tracker: ${e.message}`));
    }
  }
  async function list() { await loaded; return store.all(); }
  async function summary() { return summarize(await list(), o); }
  return { record, grade, list, summary, status: () => last, ready: () => loaded, store };
}

module.exports = { DEFAULTS, BACKTEST, parsePmusEvents, fetchPmusEsports, pmusFor, kalshiFair, scanSignals, summarize, gradeOf, createXvTracker, sameTeam };
