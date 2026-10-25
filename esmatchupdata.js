// ─── ESPORTS MATCHUPS: DATA, MARKETS AND THE FORWARD RECORD ──────────────────
// Feeds the head-to-head engine (esmatchup.js) and puts each upcoming League
// of Legends series next to the prices you can actually trade from Texas.
//
// Sources (all free, no account):
//   • lolesports schedule (esports-api.lolesports.com getSchedule, the public
//     key its own site uses): finished series with map scores, upcoming series
//     with best-of and league. Seeded from seeds/lol-series.json.gz (11.4k
//     series, 2024-01 to 2026-10, pulled from Actions), then topped up live.
//   • Kalshi and Polymarket match prices from the esports board (esboard.js),
//     paired by team names within a few hours. Kalshi is the venue: its no-vig
//     mid is the market price. Polymarket's global book is a reference only
//     and is never linked for US users.
//   • Riot's developer API is listed as a provider and stays off: it serves
//     public ranked games, not pro results, and needs a key (RIOT_API_KEY)
//     this project doesn't have. Nothing pretends to read it.
//
// Forward record: every LoL series with a Kalshi price gets the model's
// number frozen 10 to 45 minutes before the start (the price we'd compare
// against), the Kalshi price follows it to the start (the close), and the
// result grades it. Same bar as every record: model view until it has 50+
// graded and beats Kalshi's price; it does not, so far, in the backtest.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const M = require('./esmatchup');

const LOLE = 'https://esports-api.lolesports.com/persisted/gw/getSchedule';
const LOLE_HEADERS = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper matchups)' };
const SEED = path.join(__dirname, 'seeds', 'lol-series.json.gz');
const BACKTEST = path.join(__dirname, 'seeds', 'lol-matchup-backtest.json');

const DEFAULTS = {
  aheadDays: 8,
  pairHours: 4,          // a venue's start within this of lolesports' start is the same series
  minNameScore: 0.6,
  maxSpread: 0.08,       // a Kalshi quote wider than this says little
  freezeFrom: 45,        // minutes before the start: freeze the model's number
  freezeTo: 10,
  kalshiFeeRate: 0.07,
  sideMin: 0.05,         // the record's model-side bets: model 5+ points off Kalshi
  minN: 50,
};

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// lolesports events → finished series and upcoming ones
function parseSchedule(events) {
  const done = [], upcoming = [];
  for (const e of events || []) {
    if (e?.type !== 'match' || !e.match) continue;
    const t = e.match.teams || [];
    if (t.length !== 2) continue;
    const row = {
      id: String(e.match.id), t: e.startTime, lg: e.league?.name || null, bo: num(e.match.strategy?.count),
      a: t[0].name, ac: t[0].code || null, b: t[1].name, bc: t[1].code || null,
    };
    if (e.state === 'completed') {
      const s1 = num(t[0].result?.gameWins), s2 = num(t[1].result?.gameWins);
      if (s1 == null || s2 == null || s1 + s2 === 0) continue;
      done.push({ ...row, s1, s2 });
    } else if (e.state === 'unstarted' || e.state === 'inProgress') {
      // "TBD" placeholders have no team yet
      if (/^tbd$/i.test(row.a) || /^tbd$/i.test(row.b)) continue;
      upcoming.push({ ...row, state: e.state, block: e.blockName || null });
    }
  }
  return { done, upcoming };
}

function loadSeed(file = SEED) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); } catch { return []; }
}
function loadBacktest(file = BACKTEST) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Kalshi's no-vig price for team a (both books' mids, normalised) and the
// cost to buy each side (ask + taker fee).
function kalshiPrice(mk, flipped, o = DEFAULTS) {
  const qa = mk?.outcomes?.[0]?.quotes?.kalshi, qb = mk?.outcomes?.[1]?.quotes?.kalshi;
  const mid = q => (q && q.bid != null && q.ask != null && q.ask - q.bid <= o.maxSpread + 1e-9 ? (q.bid + q.ask) / 2 : null);
  const ma = mid(qa), mb = mid(qb);
  let p = null;
  if (ma != null && mb != null) p = ma / (ma + mb);
  else if (ma != null) p = ma;
  else if (mb != null) p = 1 - mb;
  const fee = x => (x == null ? null : r4(x + o.kalshiFeeRate * x * (1 - x)));
  const side = q => (q ? { ask: q.ask ?? null, bid: q.bid ?? null, cost: fee(q.ask) } : null);
  const sides = [side(qa), side(qb)];
  if (p == null && !sides[0]?.ask && !sides[1]?.ask) return null;
  return flipped ? { prob: p == null ? null : r4(1 - p), sides: [sides[1], sides[0]] } : { prob: p == null ? null : r4(p), sides };
}
function polymarketProb(mk, flipped) {
  const q = mk?.outcomes?.[0]?.quotes?.polymarket;
  if (!q || q.bid == null || q.ask == null || q.ask - q.bid > 0.08) return null;
  const p = (q.bid + q.ask) / 2;
  return r4(flipped ? 1 - p : p);
}

// the esports board's LoL match for a lolesports series (both teams fit, start close)
function pairBoard(series, board, o = DEFAULTS) {
  const t = Date.parse(series.t);
  let best = null;
  for (const m of board || []) {
    if (m.game !== 'LOL' || !m.teams) continue;
    const st = Date.parse(m.start);
    if (Number.isFinite(st) && Number.isFinite(t) && Math.abs(st - t) > o.pairHours * 3600e3) continue;
    const d = Math.min(M.nameScore(m.teams[0], series.a, series.ac), M.nameScore(m.teams[1], series.b, series.bc));
    const f = Math.min(M.nameScore(m.teams[0], series.b, series.bc), M.nameScore(m.teams[1], series.a, series.ac));
    const sc = Math.max(d, f);
    if (sc < o.minNameScore) continue;
    const key = sc * 10 - (Number.isFinite(st) ? Math.abs(st - t) / 3600e3 : 2);
    if (!best || key > best.key) best = { m, flipped: f > d, key, score: sc };
  }
  return best;
}

// one upcoming series → its matchup page data
function buildMatchup(series, R, board, { now = Date.now(), o = DEFAULTS } = {}) {
  const pred = R.predict(series.a, series.b, { bestOf: series.bo || 1, t: now });
  const pair = pairBoard(series, board, o);
  const main = pair?.m?.markets?.find(mk => mk.kind === 'match') || null;
  const kalshi = main ? kalshiPrice(main, pair.flipped, o) : null;
  const pm = main ? polymarketProb(main, pair.flipped) : null;
  let compare = null;
  if (pred.priced && pred.series && kalshi?.prob != null) {
    const win = pred.series.win;
    const sides = [0, 1].map(i => {
      const cost = kalshi.sides[i]?.cost;
      const p = i === 0 ? win : (pred.series.loss ?? 1 - win);
      return cost ? { cost, modelEv: r4(p / cost - 1) } : null;
    });
    compare = { kalshi: kalshi.prob, model: win, diff: r4(win - kalshi.prob), sides };
  }
  const market = kalshi?.prob != null ? { venue: 'Kalshi', prob: kalshi.prob } : null;
  return {
    id: series.id, start: series.t, league: series.lg, bestOf: series.bo, state: series.state, block: series.block,
    teams: [{ name: series.a, code: series.ac }, { name: series.b, code: series.bc }],
    model: pred.series ? {
      priced: !!pred.priced, confidence: pred.confidence, reasons: pred.reasons, map: pred.map, win: pred.series.win, band: pred.band,
      scores: pred.series.scores, totalMaps: pred.series.totalMaps || null, allMaps: pred.series.allMaps ?? null,
      minus1p5: pred.series.aMinus1p5 != null ? [pred.series.aMinus1p5, pred.series.bMinus1p5] : null, draw: pred.series.draw ?? null,
    } : { priced: false, confidence: 'insufficient', reasons: pred.reasons },
    rating: pred.rating || null, h2h: pred.h2h || null, teamViews: pred.teams,
    markets: {
      kalshi: kalshi ? { ...kalshi, url: pair?.m?.links?.kalshi || null } : null,
      polymarketRef: pm,   // reference only: polymarket.com is not a US venue
      paired: pair ? { teams: pair.m.teams, start: pair.m.start, score: r4(pair.score) } : null,
    },
    compare,
    explain: M.explain(pred, { market }),
    label: 'model',
  };
}

// ── forward record ──
const llOf = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
function summarize(rows, o = DEFAULTS) {
  const g = rows.filter(r => r.status === 'graded' && (r.y === 0 || r.y === 1));
  const n = g.length;
  const out = { tracked: rows.length, graded: n, open: rows.filter(r => r.status === 'open').length };
  if (!n) return { ...out, verdict: 'early', note: `0 of ${o.minN} graded` };
  const mean = f => g.reduce((s, r) => s + f(r), 0) / n;
  out.logLoss = { model: r4(mean(r => llOf(r.model, r.y))), kalshi: r4(mean(r => llOf(r.kalshi, r.y))) };
  out.brier = { model: r4(mean(r => (r.model - r.y) ** 2)), kalshi: r4(mean(r => (r.kalshi - r.y) ** 2)) };
  const closed = g.filter(r => r.close != null);
  out.closeLogLoss = closed.length ? r4(closed.reduce((s, r) => s + llOf(r.close, r.y), 0) / closed.length) : null;
  // the model's side at Kalshi's ask + fee when it was 5+ points off
  const bets = g.filter(r => Math.abs(r.model - r.kalshi) >= o.sideMin).map(r => {
    const a = r.model > r.kalshi, cost = a ? r.costA : r.costB;
    if (!cost) return null;
    const won = a ? r.y : 1 - r.y;
    const close = r.close == null ? null : a ? r.close : 1 - r.close;
    return { won, cost, roi: (won - cost) / cost, clv: close == null ? null : (close - cost) / cost };
  }).filter(Boolean);
  const nb = bets.length;
  out.sides = nb ? {
    bets: nb, won: bets.filter(b => b.won).length, roi: r1((bets.reduce((s, b) => s + b.roi, 0) / nb) * 100),
    clv: bets.some(b => b.clv != null) ? r1((bets.filter(b => b.clv != null).reduce((s, b) => s + b.clv, 0) / bets.filter(b => b.clv != null).length) * 100) : null,
  } : { bets: 0 };
  // per-series log loss gap: model minus Kalshi (positive = Kalshi better)
  const d = g.map(r => llOf(r.model, r.y) - llOf(r.kalshi, r.y));
  const md = d.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  out.llGap = { mean: r4(md), t: n > 1 && sd > 0 ? r1(md / (sd / Math.sqrt(n))) : null };
  out.verdict = n < o.minN ? 'early' : md > 0 && out.llGap.t >= 2 ? 'kalshi better' : md < 0 && out.llGap.t <= -2 ? 'model better (needs re-check)' : 'no clear difference';
  out.note = n < o.minN ? `${n} of ${o.minN} graded` : null;
  return out;
}

function createMatchupEngine({ http, board = () => [], store = null, log = console, now = () => Date.now(), opts = {}, modelOpts = {}, seed = null } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const series = new Map();
  for (const s of seed || loadSeed()) if (s && s.id) series.set(String(s.id), s);
  const state = {
    ratings: null, upcoming: [], updated: null, error: null, pages: 0, seedSeries: series.size, fetched: 0,
    lastResult: null, record: new Map(), ready: false, backtest: loadBacktest(),
  };
  function rebuild() {
    state.ratings = M.buildRatings([...series.values()], modelOpts);
    const last = state.ratings.last();
    state.lastResult = last ? new Date(last).toISOString() : null;
  }
  rebuild();

  async function page(token) {
    const res = await http.get(LOLE, { params: { hl: 'en-US', ...(token ? { pageToken: token } : {}) }, headers: LOLE_HEADERS, timeout: 20000 });
    const sc = res?.data?.data?.schedule;
    if (!sc) throw new Error('lolesports: no schedule in the answer');
    return sc;
  }
  // first call reaches back to the seed's last day; later calls read the
  // current page, two newer and two older
  let backfilled = false;
  async function refresh() {
    const t0 = now();
    const evs = [];
    let pages = 0;
    try {
      const first = await page(null); pages++;
      evs.push(...(first.events || []));
      let tok = first.pages?.newer;
      for (let i = 0; i < 3 && tok; i++) { const p = await page(tok); pages++; evs.push(...(p.events || [])); tok = p.pages?.newer; }
      tok = first.pages?.older;
      const seedLast = Math.max(0, ...[...series.values()].map(s => Date.parse(s.t) || 0));
      const maxOlder = backfilled ? 2 : 20;
      for (let i = 0; i < maxOlder && tok; i++) {
        const p = await page(tok); pages++;
        const list = p.events || [];
        evs.push(...list);
        tok = p.pages?.older;
        const oldest = Math.min(...list.map(e => Date.parse(e.startTime) || Infinity));
        if (!list.length || oldest < seedLast - 3 * 86400e3) break;
      }
      backfilled = true;
      const { done, upcoming } = parseSchedule(evs);
      let added = 0;
      for (const s of done) { if (!series.has(s.id)) added++; series.set(s.id, s); }
      const seen = new Set();
      state.upcoming = upcoming.filter(u => !seen.has(u.id) && seen.add(u.id)).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      if (added) rebuild();
      Object.assign(state, { updated: new Date(t0).toISOString(), error: null, pages, fetched: state.fetched + added, ready: true });
      log.log?.(`Matchups (LoL): ${state.upcoming.length} upcoming, ${added} new results, ${series.size} series, ${pages} pages in ${now() - t0}ms`);
    } catch (e) {
      state.error = `${e.response?.status || ''} ${e.message}`.trim();
      state.ready = state.ready || series.size > 0;
      log.warn?.(`Matchups (LoL): ${state.error}`);
    }
    await track().catch(e => log.warn?.(`Matchups record: ${e.message}`));
    return state;
  }

  // board: the esports board's matches as this viewer may see them
  function list({ days = o.aheadDays, league = null, board: b = null } = {}) {
    const bd = b || board() || [];
    const t = now(), out = [];
    for (const s of state.upcoming) {
      const st = Date.parse(s.t);
      if (Number.isFinite(st) && (st > t + days * 86400e3 || st < t - 6 * 3600e3)) continue;
      if (league && s.lg !== league) continue;
      out.push(buildMatchup(s, state.ratings, bd, { now: t, o }));
    }
    return out;
  }
  function get(id, { board: b = null } = {}) {
    const s = state.upcoming.find(u => u.id === String(id));
    return s ? buildMatchup(s, state.ratings, b || board() || [], { now: now(), o }) : null;
  }

  // freeze, follow and grade
  async function track() {
    if (!store) return;
    if (!state.recordLoaded) { for (const r of await store.all()) state.record.set(r.id, r); state.recordLoaded = true; }
    const t = now(), changed = [];
    const ms = list({ days: 1 });
    for (const mu of ms) {
      const st = Date.parse(mu.start);
      const id = `lol:${mu.id}`;
      const mins = (st - t) / 60e3;
      let row = state.record.get(id);
      if (!row && mins <= o.freezeFrom && mins >= o.freezeTo && mu.compare && mu.model.priced) {
        row = {
          id, matchId: mu.id, start: mu.start, league: mu.league, bestOf: mu.bestOf, teams: mu.teams.map(x => x.name),
          model: mu.compare.model, band: mu.model.band, confidence: mu.model.confidence, kalshi: mu.compare.kalshi,
          costA: mu.markets.kalshi?.sides?.[0]?.cost ?? null, costB: mu.markets.kalshi?.sides?.[1]?.cost ?? null,
          polymarketRef: mu.markets.polymarketRef, frozenAt: new Date(t).toISOString(), close: null, status: 'open',
        };
        state.record.set(id, row); changed.push(row);
      } else if (row && row.status === 'open' && mins > 0 && mu.compare?.kalshi != null) {
        row.close = mu.compare.kalshi; row.closeAt = new Date(t).toISOString(); changed.push(row);
      }
    }
    for (const row of state.record.values()) {
      if (row.status !== 'open') continue;
      const d = series.get(row.matchId);
      if (d) {
        row.result = `${d.s1}-${d.s2}`;
        if (d.s1 === d.s2) { row.status = 'void'; row.y = null; } else { row.status = 'graded'; row.y = d.s1 > d.s2 ? 1 : 0; }
        row.gradedAt = new Date(t).toISOString(); changed.push(row);
      } else if (t - Date.parse(row.start) > 4 * 86400e3) { row.status = 'void'; row.why = 'no result in four days'; changed.push(row); }
    }
    if (changed.length) await store.putMany(changed);
  }

  function record() {
    const rows = [...state.record.values()].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    return { summary: summarize(rows, o), rows: rows.slice(0, 200) };
  }

  function status() {
    return {
      game: 'LOL', ready: state.ready, updated: state.updated, error: state.error, series: series.size, seedSeries: state.seedSeries,
      fetched: state.fetched, lastResult: state.lastResult, upcoming: state.upcoming.length, teams: state.ratings?.size() || 0,
      providers: providers(),
    };
  }

  return { refresh, list, get, record, status, state, ratings: () => state.ratings, series };
}

// what the engine reads, and what it can't
function providers(env = process.env) {
  return [
    { id: 'lolesports', name: 'LoL Esports schedule', type: 'results and schedule', state: 'on', note: "Unofficial use of the public key lolesports.com's own site uses; finished series and upcoming matches." },
    { id: 'kalshi', name: 'Kalshi', type: 'exchange', state: 'on', note: 'Match winner books (KXLOLGAME) via the esports board; the market price the model is judged against.' },
    { id: 'polymarket', name: 'Polymarket (global)', type: 'exchange', state: 'reference', note: 'Reference price only; not a venue for US users and never linked.' },
    { id: 'riot', name: 'Riot developer API', type: 'stats', state: env.RIOT_API_KEY ? 'key set, not used' : 'missing key', note: 'Serves public ranked games, not pro match results; nothing here reads it. Set RIOT_API_KEY only if a ranked-play feature is built.' },
  ];
}

module.exports = { DEFAULTS, parseSchedule, loadSeed, loadBacktest, kalshiPrice, polymarketProb, pairBoard, buildMatchup, summarize, createMatchupEngine, providers, SEED, BACKTEST };
