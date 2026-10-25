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
//   • Polymarket US (gateway.polymarket.us, the CFTC exchange US users can
//     trade): its LoL match-winner markets (sportsMarketType
//     esports_match_winner, read straight from /v2/leagues/lol/events),
//     paired the same way. A second Texas venue next to Kalshi. POLYMARKET_US=off
//     turns it off with the rest of Polymarket US.
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
const { GAMES } = require('./esgames');

const LOLE = 'https://esports-api.lolesports.com/persisted/gw/getSchedule';
const LOLE_HEADERS = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper matchups)' };
const PMUS = 'https://gateway.polymarket.us';
const PMUS_SITE = 'https://polymarket.us';
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
  pmusFeeRate: 0.0695,   // Polymarket US taker fee coefficient (each market says its own)
  pmusEveryMs: 90e3,     // re-read Polymarket US's LoL markets at most this often
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

// Polymarket US /v2/leagues/lol/events → its open match-winner markets:
// { slug, marketSlug, start, teams, codes, bid, ask (the long team's), feeRate, url }.
// teams[0] is the long side: buying it costs the ask, the other team 1 − bid.
const pnum = v => num(v && typeof v === 'object' ? v.value : v);
const unit = p => (p != null && p > 0 && p < 1 ? p : null);
function parsePmusEvents(events, o = DEFAULTS, league = 'lol') {
  const out = [];
  for (const e of events || []) {
    if (!e?.slug || e.closed === true || e.active === false || e.ended === true) continue;
    for (const m of e.markets || []) {
      if (String(m?.sportsMarketType || '').toLowerCase() !== 'esports_match_winner' || !m.slug) continue;
      const status = String(m.status || '').toLowerCase();
      if (m.closed === true || m.active === false || (status && status !== 'market_status_open')) continue;
      const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
      const L = sides.find(x => x?.long === true || x?.long === 'true'), S = sides.find(x => x && x !== L && (x.long === false || x.long === 'false'));
      if (!L || !S) continue;
      const name = x => x.description || x.team?.name || null, code = x => x.team?.displayAbbreviation || x.team?.abbreviation || null;
      if (!name(L) || !name(S)) continue;
      const fr = num(m.feeCoefficient);
      out.push({
        slug: e.slug, marketSlug: m.slug, start: e.startTime || m.gameStartTime || e.startDate || null,
        teams: [name(L), name(S)], alt: [L.team?.name || null, S.team?.name || null], codes: [code(L), code(S)],
        bid: unit(pnum(m.bestBidQuote)), ask: unit(pnum(m.bestAskQuote)),
        feeRate: fr != null && fr >= 0 && fr < 1 ? fr : o.pmusFeeRate,
        url: `${PMUS_SITE}/sports/${encodeURIComponent(league)}/${encodeURIComponent(e.slug)}`,
      });
    }
  }
  return out;
}
// Polymarket US's no-vig price for team a (the long side's mid when the
// spread is 8c or less) and the cost to buy each side (ask + taker fee)
function pmusPrice(ev, flipped, o = DEFAULTS) {
  if (!ev) return null;
  const fee = x => (x == null ? null : r4(x + ev.feeRate * x * (1 - x)));
  const longAsk = ev.ask, shortAsk = ev.bid != null ? r4(1 - ev.bid) : null;
  if (longAsk == null && shortAsk == null) return null;
  const p = ev.bid != null && ev.ask != null && ev.ask - ev.bid <= o.maxSpread + 1e-9 ? (ev.bid + ev.ask) / 2 : null;
  const sides = [
    longAsk != null ? { ask: longAsk, bid: ev.bid, cost: fee(longAsk) } : null,
    shortAsk != null ? { ask: shortAsk, bid: ev.ask != null ? r4(1 - ev.ask) : null, cost: fee(shortAsk) } : null,
  ];
  return flipped ? { prob: p == null ? null : r4(1 - p), sides: [sides[1], sides[0]] } : { prob: p == null ? null : r4(p), sides };
}

// a venue's match for a lolesports series (both teams fit, start close);
// items carry teams [a, b], optional codes / alt names, and a start
function pairList(series, items, o = DEFAULTS) {
  const t = Date.parse(series.t);
  let best = null;
  const fit = (m, i, name, code) => Math.max(M.nameScore(m.teams[i], name, code), m.alt?.[i] ? M.nameScore(m.alt[i], name, code) : 0,
    m.codes?.[i] && code && String(m.codes[i]).toLowerCase() === String(code).toLowerCase() ? 0.7 : 0);
  for (const m of items || []) {
    if (!m?.teams) continue;
    const st = Date.parse(m.start);
    if (Number.isFinite(st) && Number.isFinite(t) && Math.abs(st - t) > o.pairHours * 3600e3) continue;
    const d = Math.min(fit(m, 0, series.a, series.ac), fit(m, 1, series.b, series.bc));
    const f = Math.min(fit(m, 0, series.b, series.bc), fit(m, 1, series.a, series.ac));
    const sc = Math.max(d, f);
    if (sc < o.minNameScore) continue;
    const key = sc * 10 - (Number.isFinite(st) ? Math.abs(st - t) / 3600e3 : 2);
    if (!best || key > best.key) best = { m, flipped: f > d, key, score: sc };
  }
  return best;
}
// the esports board's LoL match for a lolesports series (both teams fit, start close)
function pairBoard(series, board, o = DEFAULTS, game = 'LOL') {
  return pairList(series, (board || []).filter(m => m.game === game), o);
}

// ── CS2 and VALORANT: results the ratings refresh already reads ──
// ratings.js reads bo3.gg (CS2) and vlr.gg (VALORANT) every six hours for the
// board's Elo and keeps the map-level games (state.raw). Those become series
// here, so the matchup engines add no second read of either site.
// games: [{ a, b, aWon, t, id?, tier?, bo? }] → [{ id, t, lg, bo, a, b, s1, s2 }]
const CS_TIER = { s: 'CS2 S-tier', a: 'CS2 A-tier', b: 'CS2 B-tier', c: 'CS2 C-tier' };
function seriesFromGames(games, game) {
  const by = new Map();
  for (const g of games || []) {
    if (!g?.a || !g?.b || !Number.isFinite(g.t) || g.t <= 0) continue;
    const key = g.id != null ? String(g.id) : `${M.teamKey(g.a)}|${M.teamKey(g.b)}|${g.t}`;
    let r = by.get(key);
    if (!r) {
      r = { key, idRaw: g.id ?? null, t: g.t, a: g.a, b: g.b, s1: 0, s2: 0, tier: g.tier || null, bo: num(g.bo) };
      by.set(key, r);
    }
    const aSide = M.teamKey(g.a) === M.teamKey(r.a);
    if (g.aWon === aSide) r.s1++; else r.s2++;
  }
  const out = [];
  for (const r of by.values()) {
    if (r.s1 + r.s2 === 0) continue;
    if (game === 'CS2') {
      out.push({ id: r.idRaw != null ? `bo3:${r.idRaw}` : `bo3:${r.key}`, t: new Date(r.t).toISOString(), lg: CS_TIER[r.tier] || 'CS2 other', bo: r.bo || null, a: r.a, b: r.b, s1: r.s1, s2: r.s2 });
    } else {
      // vlr.gg's list gives the day only: midday UTC keeps the day's order
      const day = new Date(r.t); day.setUTCHours(17, 0, 0, 0);
      out.push({ id: r.idRaw != null ? `vlr:${r.idRaw}` : `vlr:${r.key}`, t: day.toISOString(), lg: null, bo: Math.max(r.s1, r.s2) * 2 - 1, a: r.a, b: r.b, s1: r.s1, s2: r.s2 });
    }
  }
  return out;
}

// The matches a venue lists for one game (Kalshi via the esports board, then
// Polymarket US's own list), as series rows the model can price. CS2 and
// VALORANT have no schedule feed we read, so the venues are the schedule:
// every row here is a match you could trade.
const venueId = (game, a, b, t) => `${game.toLowerCase()}-${new Date(Date.parse(t) || 0).toISOString().slice(0, 13).replace(/[^0-9]/g, '')}-${[M.teamKey(a), M.teamKey(b)].sort().join('-')}`;
function venueUpcoming(game, board, pmEvents, { now = Date.now(), o = DEFAULTS } = {}) {
  const out = [];
  const t0 = now - 6 * 3600e3, t1 = now + o.aheadDays * 86400e3;
  const inWindow = t => { const x = Date.parse(t); return Number.isFinite(x) && x >= t0 && x <= t1; };
  for (const m of board || []) {
    if (m.game !== game || !m.teams || !m.teams[0] || !m.teams[1] || !inWindow(m.start)) continue;
    // a Kalshi book on the match winner: Polymarket's global book alone is not a US venue
    if (!(m.markets || []).some(k => k.kind === 'match' && (k.outcomes || []).some(x => x?.quotes?.kalshi))) continue;
    const t = new Date(Date.parse(m.start)).toISOString();
    out.push({ id: venueId(game, m.teams[0], m.teams[1], t), t, lg: m.tournament || m.league || null, bo: m.bestOf || null, a: m.teams[0], ac: null, b: m.teams[1], bc: null,
      state: Date.parse(t) <= now ? 'inProgress' : 'unstarted', block: null, source: 'kalshi' });
  }
  for (const e of pmEvents || []) {
    if (!inWindow(e.start)) continue;
    const t = new Date(Date.parse(e.start)).toISOString();
    const row = { t, a: e.teams[0], ac: e.codes?.[0] || null, b: e.teams[1], bc: e.codes?.[1] || null };
    if (out.some(u => pairList(u, [{ teams: [row.a, row.b], codes: [row.ac, row.bc], alt: e.alt, start: t }], o))) continue;
    out.push({ id: venueId(game, row.a, row.b, t), ...row, lg: null, bo: null, state: Date.parse(t) <= now ? 'inProgress' : 'unstarted', block: null, source: 'polymarketus' });
  }
  return out.sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
}

// a finished series for a venue match: both teams fit, within 12 hours
function findResult(seriesList, row, o = DEFAULTS) {
  const t = Date.parse(row.start);
  let best = null;
  for (const s of seriesList) {
    const st = Date.parse(s.t);
    if (!Number.isFinite(st) || Math.abs(st - t) > 12 * 3600e3) continue;
    const [a, b] = row.teams;
    const d = Math.min(M.nameScore(a, s.a), M.nameScore(b, s.b)), f = Math.min(M.nameScore(a, s.b), M.nameScore(b, s.a));
    const sc = Math.max(d, f);
    if (sc < 0.75) continue;
    if (!best || sc > best.sc) best = { s, flipped: f > d, sc };
  }
  if (!best) return null;
  return best.flipped ? { s1: best.s.s2, s2: best.s.s1, id: best.s.id } : { s1: best.s.s1, s2: best.s.s2, id: best.s.id };
}
// one upcoming series → its matchup page data. pmus: Polymarket US's parsed
// LoL markets ({ events, at }) or null.
function buildMatchup(series, R, board, { now = Date.now(), o = DEFAULTS, pmus = null, game = 'LOL' } = {}) {
  const pred = R.predict(series.a, series.b, { bestOf: series.bo || (game === 'LOL' ? 1 : 3), t: now });
  const pair = pairBoard(series, board, o, game);
  const main = pair?.m?.markets?.find(mk => mk.kind === 'match') || null;
  const kalshi = main ? kalshiPrice(main, pair.flipped, o) : null;
  const pm = main ? polymarketProb(main, pair.flipped) : null;
  const ppair = pmus?.events?.length ? pairList(series, pmus.events, o) : null;
  const us = ppair ? pmusPrice(ppair.m, ppair.flipped, o) : null;
  let compare = null;
  const ref = kalshi?.prob != null ? { venue: 'Kalshi', prob: kalshi.prob } : us?.prob != null ? { venue: 'Polymarket US', prob: us.prob } : null;
  if (pred.priced && pred.series && ref) {
    const win = pred.series.win;
    const pOf = i => (i === 0 ? win : (pred.series.loss ?? 1 - win));
    const sides = [0, 1].map(i => {
      const cost = kalshi?.sides?.[i]?.cost;
      return cost ? { cost, modelEv: r4(pOf(i) / cost - 1) } : null;
    });
    // the cheaper Texas venue for each side, with what the model makes of it
    const best = [0, 1].map(i => {
      const c = [['Kalshi', kalshi?.sides?.[i]?.cost], ['Polymarket US', us?.sides?.[i]?.cost]].filter(x => x[1]).sort((a, b) => a[1] - b[1])[0];
      return c ? { venue: c[0], cost: c[1], modelEv: r4(pOf(i) / c[1] - 1) } : null;
    });
    compare = { kalshi: kalshi?.prob ?? null, pmus: us?.prob ?? null, vs: ref.venue, model: win, diff: r4(win - ref.prob), sides, best };
  }
  const market = ref;
  return {
    id: series.id, game, start: series.t, league: series.lg, bestOf: series.bo, bestOfAssumed: !series.bo && game !== 'LOL' ? 3 : null, state: series.state, block: series.block,
    teams: [{ name: series.a, code: series.ac }, { name: series.b, code: series.bc }],
    model: pred.series ? {
      priced: !!pred.priced, confidence: pred.confidence, reasons: pred.reasons, map: pred.map, win: pred.series.win, band: pred.band,
      scores: pred.series.scores, totalMaps: pred.series.totalMaps || null, allMaps: pred.series.allMaps ?? null,
      minus1p5: pred.series.aMinus1p5 != null ? [pred.series.aMinus1p5, pred.series.bMinus1p5] : null, draw: pred.series.draw ?? null,
    } : { priced: false, confidence: 'insufficient', reasons: pred.reasons },
    rating: pred.rating || null, h2h: pred.h2h || null, teamViews: pred.teams,
    markets: {
      kalshi: kalshi ? { ...kalshi, url: pair?.m?.links?.kalshi || null } : null,
      pmus: us ? { ...us, url: ppair.m.url, market: ppair.m.marketSlug, teams: ppair.m.teams, start: ppair.m.start, score: r4(ppair.score), asOf: pmus.at || null } : null,
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

// game: 'LOL' reads lolesports' schedule; 'CS2' and 'VAL' take their
// schedule from the venues and their results from results() (the ratings
// refresh's raw games: { games, at }).
function createMatchupEngine({ game = 'LOL', http, board = () => [], results = null, pmusOn = true, store = null, log = console, now = () => Date.now(), opts = {}, modelOpts = {}, seed = null } = {}) {
  const G = GAMES[game] || GAMES.LOL;
  const venueGame = G.id !== 'LOL';
  const o = { ...DEFAULTS, ...opts };
  const mOpts = { ...G.model, ...modelOpts };
  const prefix = `${G.id.toLowerCase()}:`;
  const series = new Map();
  for (const s of seed || loadSeed(G.seed)) if (s && s.id) series.set(String(s.id), s);
  // a series the ratings refresh also lists under another id (bo3.gg without
  // an id, or the seed's exact start) is the same series
  const sameKey = s => `${[M.teamKey(s.a), M.teamKey(s.b)].sort().join('|')}|${String(s.t).slice(0, 10)}|${[s.s1, s.s2].sort().join('-')}`;
  const seen = new Set([...series.values()].map(sameKey));
  const state = {
    ratings: null, upcoming: [], updated: null, error: null, pages: 0, seedSeries: series.size, fetched: 0,
    lastResult: null, record: new Map(), ready: false, backtest: loadBacktest(G.backtest),
    pmus: { on: !!pmusOn, events: [], at: null, error: null, reads: 0 }, resultsAt: null,
  };
  function rebuild() {
    state.ratings = M.buildRatings([...series.values()], mOpts);
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
  // Polymarket US's LoL match winners (two pages of 50 at most); a failed
  // read keeps the last good list but marks it, and quotes older than 10
  // minutes are dropped rather than shown as current
  let pmusBusy = null;
  async function refreshPmus() {
    if (!state.pmus.on || !http) return state.pmus;
    if (pmusBusy) return pmusBusy;
    pmusBusy = (async () => {
      const t0 = now();
      try {
        const evs = [];
        for (let page = 0; page < 2; page++) {
          const res = await http.get(`${PMUS}/v2/leagues/${encodeURIComponent(G.pmLeague)}/events`, { params: { limit: 50, offset: page * 50 }, timeout: 8000 });
          const list = Array.isArray(res?.data?.events) ? res.data.events : [];
          evs.push(...list);
          if (list.length < 50) break;
        }
        Object.assign(state.pmus, { events: parsePmusEvents(evs, o, G.pmLeague), at: new Date(t0).toISOString(), error: null, reads: state.pmus.reads + 1 });
      } catch (e) {
        state.pmus.error = `${e.response?.status || ''} ${e.message}`.trim();
        log.warn?.(`Matchups (${G.label}): Polymarket US: ${state.pmus.error}`);
      } finally { pmusBusy = null; }
      return state.pmus;
    })();
    return pmusBusy;
  }
  const pmusNow = () => {
    const p = state.pmus;
    if (!p.on) return null;
    const age = p.at ? now() - Date.parse(p.at) : Infinity;
    if (age > o.pmusEveryMs) refreshPmus().catch(() => {});
    return age <= 10 * 60e3 ? p : null;
  };

  // first call reaches back to the seed's last day; later calls read the
  // current page, two newer and two older
  let backfilled = false;
  // CS2 / VALORANT: fold in the ratings refresh's newest results
  async function refreshVenueGame() {
    const t0 = now();
    try {
      const raw = typeof results === 'function' ? results() : null;
      let added = 0;
      if (raw?.games?.length && raw.at !== state.resultsAt) {
        for (const s of seriesFromGames(raw.games, G.id)) {
          const k = sameKey(s);
          if (series.has(s.id) || seen.has(k)) continue;
          series.set(s.id, s); seen.add(k); added++;
        }
        state.resultsAt = raw.at;
        if (added) rebuild();
      }
      Object.assign(state, { updated: new Date(t0).toISOString(), error: raw?.games?.length ? null : 'results not read yet (the ratings refresh runs at boot and every six hours)', fetched: state.fetched + added, ready: true });
      log.log?.(`Matchups (${G.label}): ${added} new results, ${series.size} series`);
    } catch (e) {
      state.error = e.message; state.ready = series.size > 0;
      log.warn?.(`Matchups (${G.label}): ${e.message}`);
    }
    await refreshPmus().catch(() => {});
    await track().catch(e => log.warn?.(`Matchups record (${G.label}): ${e.message}`));
    return state;
  }
  async function refresh() {
    if (venueGame) return refreshVenueGame();
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
    await refreshPmus().catch(() => {});
    await track().catch(e => log.warn?.(`Matchups record: ${e.message}`));
    return state;
  }

  // board: the esports board's matches as this viewer may see them
  const upcomingNow = (bd, pm) => (venueGame ? venueUpcoming(G.id, bd, pm?.events || [], { now: now(), o }) : state.upcoming);
  function list({ days = o.aheadDays, league = null, board: b = null } = {}) {
    const bd = b || board() || [];
    const pm = pmusNow();
    const t = now(), out = [];
    for (const s of upcomingNow(bd, pm)) {
      const st = Date.parse(s.t);
      if (Number.isFinite(st) && (st > t + days * 86400e3 || st < t - 6 * 3600e3)) continue;
      if (league && s.lg !== league) continue;
      out.push(buildMatchup(s, state.ratings, bd, { now: t, o, pmus: pm, game: G.id }));
    }
    return out;
  }
  function get(id, { board: b = null } = {}) {
    const bd = b || board() || [];
    const pm = pmusNow();
    const s = upcomingNow(bd, pm).find(u => u.id === String(id));
    return s ? buildMatchup(s, state.ratings, bd, { now: now(), o, pmus: pm, game: G.id }) : null;
  }

  // freeze, follow and grade
  async function track() {
    if (!store) return;
    if (!state.recordLoaded) { for (const r of await store.all()) if (String(r.id).startsWith(prefix)) state.record.set(r.id, r); state.recordLoaded = true; }
    const t = now(), changed = [];
    const ms = list({ days: 1 });
    for (const mu of ms) {
      const st = Date.parse(mu.start);
      const id = `${prefix}${mu.id}`;
      const mins = (st - t) / 60e3;
      let row = state.record.get(id);
      if (!row && mins <= o.freezeFrom && mins >= o.freezeTo && mu.compare?.kalshi != null && mu.model.priced) {
        row = {
          id, game: G.id, matchId: mu.id, start: mu.start, league: mu.league, bestOf: mu.bestOf, teams: mu.teams.map(x => x.name),
          model: mu.compare.model, band: mu.model.band, confidence: mu.model.confidence, kalshi: mu.compare.kalshi,
          costA: mu.markets.kalshi?.sides?.[0]?.cost ?? null, costB: mu.markets.kalshi?.sides?.[1]?.cost ?? null,
          pmus: mu.compare.pmus ?? null, pmusCostA: mu.markets.pmus?.sides?.[0]?.cost ?? null, pmusCostB: mu.markets.pmus?.sides?.[1]?.cost ?? null,
          polymarketRef: mu.markets.polymarketRef, frozenAt: new Date(t).toISOString(), close: null, status: 'open',
        };
        state.record.set(id, row); changed.push(row);
      } else if (row && row.status === 'open' && mins > 0 && mu.compare?.kalshi != null) {
        row.close = mu.compare.kalshi; row.closeAt = new Date(t).toISOString();
        if (mu.compare.pmus != null) row.pmusClose = mu.compare.pmus;
        changed.push(row);
      }
    }
    const recent = venueGame ? [...series.values()].filter(s => Date.parse(s.t) > t - 6 * 86400e3) : null;
    for (const row of state.record.values()) {
      if (row.status !== 'open') continue;
      const d = venueGame ? findResult(recent, row, o) : series.get(row.matchId);
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
      game: G.id, label: G.label, ready: state.ready, updated: state.updated, error: state.error, series: series.size, seedSeries: state.seedSeries,
      fetched: state.fetched, lastResult: state.lastResult, upcoming: venueGame ? list().length : state.upcoming.length, teams: state.ratings?.size() || 0,
      providers: providers(undefined, state.pmus, G.id),
      pmus: { on: state.pmus.on, markets: state.pmus.events.length, at: state.pmus.at, error: state.pmus.error },
    };
  }

  return { refresh, refreshPmus, list, get, record, status, state, ratings: () => state.ratings, series };
}

// what the engine reads, and what it can't
function providers(env = process.env, pm = null, game = 'LOL') {
  const pmus = { id: 'polymarketus', name: 'Polymarket US', type: 'exchange', state: pm && !pm.on ? 'off' : pm?.error ? 'error' : 'on', note: `${GAMES[game]?.label || game} match winner markets (esports_match_winner) from the US exchange, with its taker fee; a second Texas venue next to Kalshi. POLYMARKET_US=off turns it off.` };
  if (game === 'CS2' || game === 'VAL') {
    const src = game === 'CS2'
      ? { id: 'bo3gg', name: 'bo3.gg results', type: 'results', state: 'on', note: "Finished CS2 series from bo3.gg's public API, read by the team ratings refresh every six hours (no second read); seeded with 42.8k series from 2024." }
      : { id: 'vlrgg', name: 'vlr.gg results', type: 'results', state: 'on', note: "Finished VALORANT series from vlr.gg's results list, read by the team ratings refresh every six hours (no second read); seeded with 8.1k series from 2024-05." };
    return [src,
      { id: 'kalshi', name: 'Kalshi', type: 'exchange', state: 'on', note: `Match winner books (${game === 'CS2' ? 'KXCS2GAME' : 'KXVALORANTGAME'}) via the esports board: the schedule and the market price the model is judged against.` },
      pmus];
  }
  return [
    { id: 'lolesports', name: 'LoL Esports schedule', type: 'results and schedule', state: 'on', note: "Unofficial use of the public key lolesports.com's own site uses; finished series and upcoming matches." },
    { id: 'kalshi', name: 'Kalshi', type: 'exchange', state: 'on', note: 'Match winner books (KXLOLGAME) via the esports board; the market price the model is judged against.' },
    pmus,
    { id: 'polymarket', name: 'Polymarket (global)', type: 'exchange', state: 'reference', note: 'Reference price only; not a venue for US users and never linked.' },
    { id: 'riot', name: 'Riot developer API', type: 'stats', state: env.RIOT_API_KEY ? 'key set, not used' : 'missing key', note: 'Serves public ranked games, not pro match results; nothing here reads it. Set RIOT_API_KEY only if a ranked-play feature is built.' },
  ];
}

module.exports = { DEFAULTS, parseSchedule, loadSeed, loadBacktest, kalshiPrice, polymarketProb, parsePmusEvents, pmusPrice, pairList, pairBoard, seriesFromGames, venueUpcoming, findResult, buildMatchup, summarize, createMatchupEngine, providers, SEED, BACKTEST };
