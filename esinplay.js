// ─── LIVE ESPORTS MAPS ON KALSHI ──────────────────────────────────────────────
// Kalshi lists a market for every map and every match of CS2, LoL, Dota 2 and
// Valorant series, and both trade while the match is played. This module turns
// the live game state (CS2 and Valorant round score, LoL gold/towers/dragons/
// barons/inhibitors, Dota 2 net-worth lead and kills) into a win probability
// for the map being played and for the series, anchored on Kalshi's own price
// just before the map started, and compares it with Kalshi's live ask.
//
// A flag is a moment our probability beats the ask by more than Kalshi's fee
// plus EDGE_MIN, with real size resting at that ask. Every flag is logged once
// per market per state, with Kalshi's price at the flag, 15 s / 1 min / 5 min
// after, and at the end of the map, then graded from Kalshi's settlement.
// Its own record kind (esportsInplay); no alerts; judged at 50 graded.
//
// Nothing here places a trade.

const { kalshiFee } = require('./exchanges');
const { createMemoryStore } = require('./evtrack');
const { sameTeam } = require('./esmatch');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// ── round-based maps (CS2 MR12 with MR3 overtime; Valorant first to 13, win by two) ──
// P(team A wins the map from a:b) when A wins each round with probability q.
function csOtBlock(q) {
  // one MR3 overtime block: first to 4 of 6, 3:3 starts another block
  const p = q, r = 1 - q;
  const W = p ** 4 * (1 + 4 * r + 10 * r * r);
  const L = r ** 4 * (1 + 4 * p + 10 * p * p);
  return W / (W + L);
}
function raceProb(q, a, b, target, tie) {
  // DP: P(A reaches `target` first from a:b); at tie:tie returns tieValue
  const memo = new Map();
  const f = (x, y) => {
    if (x >= target) return 1;
    if (y >= target) return 0;
    if (tie && x === tie.at && y === tie.at) return tie.value;
    const k = x * 64 + y;
    if (memo.has(k)) return memo.get(k);
    const v = q * f(x + 1, y) + (1 - q) * f(x, y + 1);
    memo.set(k, v);
    return v;
  };
  return f(a, b);
}
function mapWinGivenQ(game, q, a = 0, b = 0) {
  q = clamp(q, 1e-6, 1 - 1e-6);
  if (game === 'VAL') {
    const deuce = q * q / (q * q + (1 - q) * (1 - q));
    if (a >= 12 && b >= 12) {
      const d = a - b;
      if (d >= 2) return 1;
      if (d <= -2) return 0;
      return d === 1 ? q + (1 - q) * deuce : d === -1 ? q * deuce : deuce;
    }
    return raceProb(q, a, b, 13, { at: 12, value: deuce });
  }
  // CS2
  const ot = csOtBlock(q);
  if (a >= 12 && b >= 12 && a + b >= 24) {
    const block = Math.floor((a + b - 24) / 6);
    let x = a - 12 - 3 * block, y = b - 12 - 3 * block;
    if (x === 3 && y === 3) return ot;   // 15:15, a new block starts
    return raceProb(q, x, y, 4, { at: 3, value: ot });
  }
  return raceProb(q, a, b, 13, { at: 12, value: ot });
}
// Beta(q0·κ + a, (1 − q0)·κ + b) on a grid: the rounds already played say
// something about how strong A is on this map.
const GRID = 120;
function betaWeights(al, be) {
  const xs = [], ws = [];
  let tot = 0;
  for (let i = 0; i < GRID; i++) {
    const x = (i + 0.5) / GRID;
    const lw = (al - 1) * Math.log(x) + (be - 1) * Math.log(1 - x);
    xs.push(x); ws.push(lw);
  }
  const mx = Math.max(...ws);
  for (let i = 0; i < GRID; i++) { ws[i] = Math.exp(ws[i] - mx); tot += ws[i]; }
  return { xs, ws: ws.map(w => w / tot) };
}
function mapWin(game, q0, a, b, kappa) {
  if (!kappa || kappa === Infinity) return mapWinGivenQ(game, q0, a, b);
  const { xs, ws } = betaWeights(q0 * kappa + a, (1 - q0) * kappa + b);
  let p = 0;
  for (let i = 0; i < GRID; i++) if (ws[i] > 1e-9) p += ws[i] * mapWinGivenQ(game, xs[i], a, b);
  return p;
}
// the round-win rate q0 that makes the map price p0 at 0:0
function roundRateFor(game, p0, kappa) {
  let lo = 0.02, hi = 0.98;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mapWin(game, mid, 0, 0, kappa) < p0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── state models (LoL, Dota 2): logit P(A) = w·logit(p0) + Σ β(minute)·x ──
// x: gold lead in thousands and the other diffs, team A minus team B;
// coefficients interpolate linearly between the fitted minute marks.
function stateModelProb(model, p0, minute, x) {
  const marks = model.marks;
  let lo = marks[0], hi = marks[marks.length - 1];
  for (let i = 0; i < marks.length - 1; i++) if (minute >= marks[i].min && minute <= marks[i + 1].min) { lo = marks[i]; hi = marks[i + 1]; break; }
  if (minute < marks[0].min) hi = lo;
  if (minute > marks[marks.length - 1].min) lo = hi;
  const f = hi.min === lo.min ? 0 : (minute - lo.min) / (hi.min - lo.min);
  let z = (model.w ?? 1) * logit(clamp(p0, 0.02, 0.98));
  const keys = new Set([...Object.keys(lo.b), ...Object.keys(hi.b)]);
  for (const k of keys) z += ((lo.b[k] || 0) * (1 - f) + (hi.b[k] || 0) * f) * (x[k] || 0);
  return sigmoid(z);
}

// ── series: maps won so far, the live map's probability and the next maps' ──
// Future maps: Beta(m0·k + a, (1 − m0)·k + b) around the per-map rate implied
// by the series price before it started (k ~ 10: favourites sweep more than
// independent maps say).
function seriesWinGivenM(m, a, b, need, pLive) {
  const memo = new Map();
  const g = (x, y) => {
    if (x >= need) return 1;
    if (y >= need) return 0;
    const k = x * 16 + y;
    if (memo.has(k)) return memo.get(k);
    const v = m * g(x + 1, y) + (1 - m) * g(x, y + 1);
    memo.set(k, v);
    return v;
  };
  if (pLive == null) return g(a, b);
  return pLive * g(a + 1, b) + (1 - pLive) * g(a, b + 1);
}
function seriesWin(m0, a, b, bo, pLive = null, k = 10) {
  const need = Math.ceil(bo / 2);
  if (!k || k === Infinity) return seriesWinGivenM(m0, a, b, need, pLive);
  const { xs, ws } = betaWeights(m0 * k + a, (1 - m0) * k + b);
  let p = 0;
  for (let i = 0; i < GRID; i++) if (ws[i] > 1e-9) p += ws[i] * seriesWinGivenM(xs[i], a, b, need, pLive);
  return p;
}
function mapRateFor(pSeries, bo, k = 10) {
  if (bo <= 1) return pSeries;
  let lo = 0.01, hi = 0.99;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (seriesWin(mid, 0, 0, bo, null, k) < pSeries) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Kalshi side: the all-in cost of a contract and the edge ──
const costOf = (ask, n = 100) => r4(ask + kalshiFee(ask, n) / n);
// one market's two sides → the flags (0, 1 or 2) where p beats cost by edgeMin
// book: { yesAsk, yesAskSize, noAsk, noAskSize } (no side = 1 − yes bid)
function edgeOf(p, book, { edgeMin = 0.03, minSize = 10, minPrice = 0.05, maxPrice = 0.95 } = {}) {
  const out = [];
  const sides = [['yes', p, book.yesAsk, book.yesAskSize], ['no', 1 - p, book.noAsk, book.noAskSize]];
  for (const [side, fair, ask, size] of sides) {
    if (!(ask > 0 && ask < 1) || ask < minPrice || ask > maxPrice) continue;
    if (!(size >= minSize)) continue;
    const cost = costOf(ask);
    const edge = r4(fair - cost);
    if (edge >= edgeMin - 1e-9) out.push({ side, fair: r4(fair), ask, cost, edge, size });
  }
  return out;
}


// ════ live readers ════
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMES = {
  CS2: { map: 'KXCS2MAP', match: 'KXCS2GAME' },
  LOL: { map: 'KXLOLMAP', match: 'KXLOLGAME' },
  DOTA: { map: 'KXDOTA2MAP', match: 'KXDOTA2GAME' },
  VAL: { map: 'KXVALORANTMAP', match: 'KXVALORANTGAME' },
};
const num = v => (v == null || v === '' ? null : Number(v));
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function etToUtc(y, mo, d, h, mi) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const off of [4, 5]) { const t = Date.UTC(y, mo, d, h + off, mi); const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value])); if (+p.hour % 24 === h && +p.minute === mi && +p.day === d) return t; }
  return Date.UTC(y, mo, d, h + 4, mi);
}
// "KXCS2MAP-26OCT241200YAWGRE-2" → { game: 'CS2', kind: 'map', base: '26OCT241200YAWGRE', map: 2, start }
function parseTicker(eventTicker) {
  const m = /^KX(CS2|LOL|DOTA2|VALORANT)(MAP|GAME)-((\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})[A-Z0-9]*)(?:-(\d+))?$/.exec(String(eventTicker || ''));
  if (!m) return null;
  const game = { CS2: 'CS2', LOL: 'LOL', DOTA2: 'DOTA', VALORANT: 'VAL' }[m[1]];
  return { game, kind: m[2] === 'MAP' ? 'map' : 'match', base: m[3], map: m[9] ? +m[9] : null, start: etToUtc(2000 + +m[4], MON[m[5]], +m[6], +m[7], +m[8]) };
}
// one market row → its book
const bookOf = m => ({ ticker: m.ticker, team: m.yes_sub_title, status: m.status, yesBid: num(m.yes_bid_dollars), yesAsk: num(m.yes_ask_dollars), yesBidSize: num(m.yes_bid_size_fp), yesAskSize: num(m.yes_ask_size_fp), result: m.result || '' });
// a team's mid from its own market and the other team's (1 − theirs), books 10¢ wide or less
function teamMid(own, other) {
  const mids = [];
  const mid = b => (b && b.yesBid > 0 && b.yesAsk > 0 && b.yesAsk < 1 && b.yesAsk - b.yesBid <= 0.10 + 1e-9 ? (b.yesBid + b.yesAsk) / 2 : null);
  const a = mid(own), b = mid(other);
  if (a != null) mids.push(a);
  if (b != null) mids.push(1 - b);
  return mids.length ? r4(mids.reduce((x, y) => x + y, 0) / mids.length) : null;
}
// Kalshi events (open, nested markets) → series keyed by base: teams, the match market, each map's
function groupKalshi(events, { now = Date.now() } = {}) {
  const out = new Map();
  for (const e of events || []) {
    const t = parseTicker(e.event_ticker);
    if (!t || t.start > now + 15 * 60e3 || t.start < now - 10 * 3600e3) continue;
    const key = `${t.game}:${t.base}`;
    const s = out.get(key) || { key, game: t.game, base: t.base, start: t.start, title: e.title || '', teams: [], match: null, maps: {} };
    const books = (e.markets || []).map(bookOf).filter(b => b.team);
    for (const b of books) if (!s.teams.some(x => x === b.team)) s.teams.push(b.team);
    if (t.kind === 'match') s.match = { event: e.event_ticker, books };
    else s.maps[t.map] = { event: e.event_ticker, books };
    out.set(key, s);
  }
  return [...out.values()];
}
const bookFor = (books, team) => (books || []).find(b => b.team === team) || null;
const otherBook = (books, team) => (books || []).find(b => b.team !== team) || null;

// ── live game state → { teams: [A, B], series: [wa, wb], bo, map, live: {...}, at } ──
// LoL: getLive + getEventDetails + live-stats window
function lolState(event, details, frame, meta, firstTs) {
  const teams = (details?.teams || event?.match?.teams || []).map(t => ({ id: t.id, name: t.name, code: t.code, wins: t.result?.gameWins ?? 0 }));
  if (teams.length !== 2 || !frame) return null;
  const blueId = meta?.blueTeamMetadata?.esportsTeamId, redId = meta?.redTeamMetadata?.esportsTeamId;
  const aBlue = blueId ? teams[0].id === blueId : redId ? teams[0].id !== redId : null;
  if (aBlue == null) return null;
  const A = aBlue ? frame.blueTeam : frame.redTeam, B = aBlue ? frame.redTeam : frame.blueTeam;
  const ts = Date.parse(frame.rfc460Timestamp);
  const games = details?.games || [];
  const live = games.find(g => g.state === 'inProgress');
  return {
    game: 'LOL', teams: teams.map(t => t.name), codes: teams.map(t => t.code), series: [teams[0].wins, teams[1].wins], bo: event?.match?.strategy?.count || games.length || 1,
    map: live?.number ?? null, gameId: live?.id ?? null, at: ts, startedAt: firstTs || null,
    minute: firstTs ? (ts - firstTs) / 60e3 : null, finished: frame.gameState === 'finished',
    x: { gd: (A.totalGold - B.totalGold) / 1000, kd: A.totalKills - B.totalKills, td: A.towers - B.towers, id: A.inhibitors - B.inhibitors, bd: A.barons - B.barons, dd: (A.dragons || []).length - (B.dragons || []).length },
  };
}
// Dota 2: OpenDota /live row (radiant lead is net worth); series score unknown here
function dotaState(row, now = Date.now()) {
  if (!row?.team_name_radiant || !row?.team_name_dire || !row.league_id) return null;
  return {
    game: 'DOTA', teams: [row.team_name_radiant, row.team_name_dire], series: null, bo: null, map: null, matchId: String(row.match_id),
    at: (row.last_update_time || 0) * 1000 || now, minute: (row.game_time || 0) / 60, delaySec: row.delay ?? null, finished: !!row.deactivate_time,
    x: { gd: (row.radiant_lead || 0) / 1000, kd: (row.radiant_score || 0) - (row.dire_score || 0) },
  };
}
// CS2: bo3 current match, its games and the live game's rounds
function csState(match, games, rounds, now = Date.now()) {
  const names = String(match?.slug || '').replace(/-\d{2}-\d{2}-\d{4}$/, '').split('-vs-');
  if (names.length !== 2) return null;
  const live = (games || []).find(g => g.status === 'current' || g.state === 'live' || g.state === 'in_progress');
  const finished = (games || []).filter(g => g.status === 'finished');
  const A = names[0].replace(/-/g, ' '), B = names[1].replace(/-/g, ' ');
  const sideOf = clan => (sameTeam(clan, A) || squashed(clan) === squashed(A) ? 0 : sameTeam(clan, B) || squashed(clan) === squashed(B) ? 1 : null);
  const series = [0, 0];
  for (const g of finished) { const w = sideOf(g.winner_clan_name); if (w != null) series[w]++; }
  let score = null;
  if (live && Array.isArray(rounds)) {
    score = [0, 0];
    for (const r of rounds) { const w = sideOf(r.winner_clan_name); if (w == null) return null; score[w]++; }
  }
  return { game: 'CS2', teams: [A, B], series, bo: match.bo_type || 1, map: live?.number ?? null, gameId: live?.id ?? null, at: now, score, startedAt: Date.parse(live?.begin_at || '') || null, finished: !live };
}
const squashed = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Kalshi's two team names → which live state they are, and which way round
function alignTeams(kTeams, sTeams) {
  if (kTeams.length !== 2 || sTeams.length !== 2) return null;
  const same = (a, b) => sameTeam(a, b) || squashed(a) === squashed(b) || (squashed(a).length >= 4 && squashed(b).length >= 4 && (squashed(a).includes(squashed(b)) || squashed(b).includes(squashed(a))));
  if (same(kTeams[0], sTeams[0]) && same(kTeams[1], sTeams[1])) return [0, 1];
  if (same(kTeams[0], sTeams[1]) && same(kTeams[1], sTeams[0])) return [1, 0];
  return null;
}

// ── model per game (fitted on free history; see INPLAY_FITS) ──
const INPLAY_FITS = {
  DOTA: { data: 'OpenDota gold curves for 1,342 Kalshi Dota 2 maps, Apr to Oct 2026, Kalshi minute prices', verdict: 'no edge', note: 'Kalshi settles about 15 minutes after the real end: the spectator delay everyone (and the free live feed) watches on. Gold-lead model at Kalshi\'s ask, books 4c wide or less, from minute 10, held-out 40%: 279 maps -6.7%; buying the live favourite at the ask breaks even' },
  CS2: { data: 'bo3.gg rounds, 2,203 matches Jul 15 to Oct 24 2026, 49,578 round states', prior: 'bookmaker match odds via the series model', note: 'independent rounds overreact to the score: the swing is cut to 70% (log loss 0.4254 vs 0.4365 uncut; a Beta update on rounds made it worse)' },
  LOL: { data: 'lolesports live-stats frames for 259 Kalshi LoL maps, Jun to Oct 2026, Kalshi minute prices', verdict: 'no edge', note: 'the free feed reaches us about 55 s late and Kalshi has already moved. Gold, towers, dragons, barons and kills model anchored on Kalshi\'s pre-map mid, acting at the next minute\'s ask after the frame arrives, held-out 104 maps: -40% at 3c edge (t -3.9); log loss 0.471 vs Kalshi mid 0.435. Even reading frames a minute early it loses (-19%)' },
};
const MODELS = {
  CS2: { kind: 'rounds', shrink: 0.7 },
  VAL: null,     // no live Valorant feed without scraping vlr.gg
  LOL: null,     // backtest: no edge (see INPLAY_FITS)
  DOTA: null,    // backtest: no edge (see INPLAY_FITS)
};
// P(team A wins the live map), from its pre-map price p0 and the state (from A's side)
function liveMapProb(game, p0, st, models = MODELS) {
  const md = models[game];
  if (!md || p0 == null || !(p0 > 0.02 && p0 < 0.98)) return null;
  if (md.kind === 'rounds') {
    if (!st.score) return null;
    const q0 = roundRateFor(game, p0, Infinity);
    const pf = clamp(mapWinGivenQ(game, q0, st.score[0], st.score[1]), 1e-4, 1 - 1e-4);
    return r4(sigmoid(logit(p0) + md.shrink * (logit(pf) - logit(p0))));
  }
  if (st.minute == null || !st.x) return null;
  return r4(stateModelProb(md, p0, st.minute, st.x));
}
// state seen from the other team's side
function flipState(st) {
  return { ...st, teams: [st.teams[1], st.teams[0]], series: st.series ? [st.series[1], st.series[0]] : null, score: st.score ? [st.score[1], st.score[0]] : null,
    x: st.x ? Object.fromEntries(Object.entries(st.x).map(([k, v]) => [k, -v])) : null };
}

const DEFAULTS = { edgeMin: 0.03, minSize: 10, minPrice: 0.05, maxPrice: 0.95, maxFeedAgeMs: 90e3, repeatMs: 3 * 60e3, anchorWindowMs: 8 * 60e3 };

// One series: Kalshi books + a live state (already aligned so state team 0 = Kalshi team 0)
// + the pre-map anchor for the live map → flag candidates
function evaluate(series, st, anchors, { now = Date.now(), models = MODELS, ...o } = {}) {
  const opts = { ...DEFAULTS, ...o };
  const out = [];
  if (!st || st.finished || st.map == null) return { pMap: null, flags: out };
  if (now - st.at > opts.maxFeedAgeMs) return { pMap: null, flags: out, stale: true };
  const mapMk = series.maps[st.map];
  const A = series.teams[0];
  const p0 = anchors?.[`${series.key}:map${st.map}`];
  const pMap = liveMapProb(series.game, p0, st, models);
  if (pMap == null || !mapMk) return { pMap, flags: out };
  const pushFlags = (market, pA, kind) => {
    for (const team of series.teams) {
      const own = bookFor(market.books, team);
      if (!own) continue;
      const p = team === A ? pA : 1 - pA;
      const flags = edgeOf(p, { yesAsk: own.yesAsk, yesAskSize: own.yesAskSize, noAsk: own.yesBid > 0 ? r4(1 - own.yesBid) : null, noAskSize: own.yesBidSize }, opts);
      for (const f of flags) {
        const backs = f.side === 'yes' ? team : series.teams.find(x => x !== team);
        out.push({ ...f, kind, ticker: own.ticker, event: market.event, team, backs, game: series.game, series: series.key, map: st.map,
          mid: teamMid(bookFor(market.books, backs), otherBook(market.books, backs)), p0: kind === 'map' ? p0 : null });
      }
    }
  };
  pushFlags(mapMk, pMap, 'map');
  // match market: maps won so far + the live map; future maps from the series price before map 1
  let pMatch = null;
  const m0 = anchors?.[`${series.key}:match`];
  if (series.match && st.series && st.bo && m0 != null && m0 > 0.02 && m0 < 0.98) {
    const k = 10, mr = mapRateFor(m0, st.bo, k);
    pMatch = r4(seriesWin(mr, st.series[0], st.series[1], st.bo, pMap, k));
    pushFlags(series.match, pMatch, 'match');
  }
  // the cheaper of the two ways to back one team (YES on its market, NO on the other's)
  const best = new Map();
  for (const f of out) { const key = `${f.kind}:${f.backs}`; if (!best.has(key) || f.cost < best.get(key).cost) best.set(key, f); }
  return { pMap, pMatch, flags: [...best.values()] };
}

// ── record ──
function createInplayTracker({ store = createMemoryStore(), http = null, now = () => Date.now(), log = console } = {}) {
  const ready = store.init();
  const open = new Map(), lastFlag = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r); });
  async function record(flags = [], ctx = {}) {
    await loaded;
    const t = now(), fresh = [];
    for (const f of flags) {
      const key = `${f.ticker}:${f.side}`;
      if (t - (lastFlag.get(key) || 0) < (ctx.repeatMs ?? DEFAULTS.repeatMs)) continue;
      lastFlag.set(key, t);
      const mapKey = `${f.series}:${f.kind}:${f.kind === 'map' ? f.map : 'm'}:${f.backs}`;
      const first = ![...open.values()].some(r => r.cluster === mapKey) && !(await store.all()).some(r => r.cluster === mapKey);
      const r = { id: `${key}:${t}`, status: 'open', flaggedAt: new Date(t).toISOString(), game: f.game, kind: f.kind, series: f.series, map: f.map, ticker: f.ticker, event: f.event, side: f.side, backs: f.backs,
        fair: f.fair, ask: f.ask, cost: f.cost, edge: f.edge, size: f.size, p0: f.p0, midAt: f.mid, cluster: mapKey, first, state: ctx.state?.[f.series] || null, marks: {} };
      open.set(r.id, r); fresh.push(r);
    }
    await Promise.all(fresh.map(r => store.put(r))).catch(e => log.warn?.(`In-play: ${e.message}`));
    return fresh;
  }
  // every read: our side's mid 15 s, 1 min, 5 min after the flag; the last mid while the map was live
  async function mark(books = new Map(), { ended = new Set() } = {}) {
    await loaded;
    const t = now(), writes = [];
    for (const r of open.values()) {
      const own = books.get(r.ticker); if (!own) continue;
      const yesMid = own.yesBid > 0 && own.yesAsk > 0 && own.yesAsk < 1 ? (own.yesBid + own.yesAsk) / 2 : null;
      if (yesMid == null) continue;
      const mid = r4(r.side === 'yes' ? yesMid : 1 - yesMid);
      const age = t - Date.parse(r.flaggedAt);
      let changed = false;
      for (const [k, ms] of [['s15', 15e3], ['m1', 60e3], ['m5', 300e3]]) if (age >= ms && r.marks[k] == null) { r.marks[k] = mid; r.marks[`${k}At`] = Math.round(age / 1000); changed = true; }
      if (!ended.has(`${r.series}:${r.kind === 'map' ? r.map : 'm'}`)) { if (r.marks.end !== mid) { r.marks.end = mid; changed = true; } }
      if (changed) writes.push(store.put(r));
    }
    await Promise.all(writes).catch(e => log.warn?.(`In-play: ${e.message}`));
  }
  async function grade() {
    await loaded;
    if (!http) return 0;
    let n = 0;
    const byTicker = new Map();
    for (const r of open.values()) if (now() - Date.parse(r.flaggedAt) > 10 * 60e3) (byTicker.get(r.ticker) || byTicker.set(r.ticker, []).get(r.ticker)).push(r);
    for (const [ticker, rows] of byTicker) {
      let m = null;
      try { m = (await http.get(`${K}/markets/${encodeURIComponent(ticker)}`, { timeout: 10000 }))?.data?.market; } catch (e) { log.warn?.(`In-play: ${ticker}: ${e.message}`); continue; }
      const res = String(m?.result || '').toLowerCase();
      if (res !== 'yes' && res !== 'no') {
        for (const r of rows) if (now() - Date.parse(r.flaggedAt) > 4 * 86400e3) { r.status = 'ungraded'; open.delete(r.id); await store.put(r).catch(() => {}); }
        continue;
      }
      for (const r of rows) {
        const win = res === r.side;
        Object.assign(r, { status: 'graded', outcome: win ? 'win' : 'loss', profit: r4(((win ? 1 : 0) - r.cost) / r.cost), gradedAt: new Date(now()).toISOString() });
        open.delete(r.id); n++;
        await store.put(r).catch(e => log.warn?.(`In-play: ${e.message}`));
      }
    }
    return n;
  }
  async function list() { await loaded; return store.all(); }
  return { record, mark, grade, list, ready: () => loaded, store };
}

// the record: every flag, and the first flag per map and team (the one that counts toward 50)
function summarize(rows = []) {
  const sum = rs => {
    const g = rs.filter(r => r.status === 'graded');
    const units = g.reduce((a, r) => a + r.profit, 0);
    const sd = g.length > 1 ? Math.sqrt(g.reduce((a, r) => a + (r.profit - units / g.length) ** 2, 0) / (g.length - 1)) : null;
    const lag = k => { const v = rs.filter(r => r.marks?.[k] != null && r.midAt != null && r.fair != null && Math.abs(r.fair - r.midAt) > 0.005).map(r => (r.marks[k] - r.midAt) / (r.fair - r.midAt)); return v.length ? r4(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const mv = k => { const v = rs.filter(r => r.marks?.[k] != null && r.midAt != null).map(r => r.marks[k] - r.midAt); return v.length ? r4(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    return { flags: rs.length, open: rs.filter(r => r.status === 'open').length, graded: g.length, wins: g.filter(r => r.outcome === 'win').length, losses: g.filter(r => r.outcome === 'loss').length,
      units: Math.round(units * 100) / 100, roi: g.length ? r4(units / g.length) : null, t: sd ? r4((units / g.length) / (sd / Math.sqrt(g.length))) : null,
      avgEdge: rs.length ? r4(rs.reduce((a, r) => a + r.edge, 0) / rs.length) : null, avgSize: rs.length ? Math.round(rs.reduce((a, r) => a + (r.size || 0), 0) / rs.length) : null,
      move15s: mv('s15'), move1m: mv('m1'), move5m: mv('m5'), gapClosed1m: lag('m1'), gapClosed5m: lag('m5') };
  };
  const firsts = rows.filter(r => r.first);
  const byGame = {};
  for (const g of ['CS2', 'LOL', 'DOTA', 'VAL']) { const rs = firsts.filter(r => r.game === g); if (rs.length) byGame[g] = sum(rs); }
  const counted = sum(firsts);
  const verdict = counted.graded < 50 ? 'not enough graded' : counted.t >= 2 && counted.roi > 0 ? 'promising' : counted.roi <= 0 ? 'no edge' : 'not proven';
  return { counted, all: sum(rows), byGame, verdict, bar: 50 };
}

// ── the live loop (server.js runs tick() every 20 s unless ESPORTS_INPLAY=off) ──
const LOLE = 'https://esports-api.lolesports.com/persisted/gw', LFEED = 'https://feed.lolesports.com/livestats/v1/window';
const LH = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper live maps)' };
const BO3 = 'https://api.bo3.gg/api/v1', BH = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper live maps)', Accept: 'application/json' };
const iso10 = t => new Date(Math.floor(t / 10e3) * 10e3).toISOString();
// the latest mid at or before t (within windowMs) from a [t, mid] history
function midAt(hist, t, windowMs) {
  let best = null;
  for (const [ts, mid] of hist || []) if (ts <= t && t - ts <= windowMs && (!best || ts > best[0])) best = [ts, mid];
  return best ? best[1] : null;
}
function createInplay({ http, tracker, now = () => Date.now(), log = console, models = MODELS, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hist = new Map();       // `${series}:map${n}` | `${series}:match` → [[t, team-0 mid]]
  const anchors = {};           // same keys → mid just before that map (or the series) started
  const lolFirst = new Map();   // LoL game id → first frame time
  const settled = new Map();    // map event ticker → winning team (for series scores Kalshi alone knows)
  const state = { updated: null, live: [], counts: {}, errors: {} };
  const get = async (url, params, headers) => (await http.get(url, { params, headers, timeout: 15000 }))?.data;
  async function kalshiEvents() {
    const all = [];
    for (const g of Object.values(GAMES)) for (const series of [g.map, g.match]) {
      try { all.push(...((await get(`${K}/events`, { series_ticker: series, status: 'open', with_nested_markets: true, limit: 200 }))?.events || [])); }
      catch (e) { state.errors.kalshi = e.message; }
    }
    return all;
  }
  async function lolStates() {
    const live = (await get(`${LOLE}/getLive`, { hl: 'en-US' }, LH))?.data?.schedule?.events || [];
    const out = [];
    for (const e of live.filter(x => x.type === 'match' && x.state === 'inProgress' && x.match)) {
      const det = (await get(`${LOLE}/getEventDetails`, { hl: 'en-US', id: e.match.id }, LH))?.data?.event?.match;
      const g = (det?.games || []).find(x => x.state === 'inProgress');
      if (!g) continue;
      // the window refuses a start too close to now (400): step back until frames come
      let w = null;
      for (const back of [60e3, 120e3, 240e3]) { w = await get(`${LFEED}/${g.id}`, { startingTime: iso10(now() - back) }, LH).catch(() => null); if (w?.frames?.length) break; }
      const fr = w?.frames || [];
      if (!fr.length) continue;
      if (!lolFirst.has(g.id)) {
        // the window with no start time returns the game's first frames
        const w0 = await get(`${LFEED}/${g.id}`, {}, LH).catch(() => null);
        const first = w0?.frames?.length ? Date.parse(w0.frames[0].rfc460Timestamp) : null;
        lolFirst.set(g.id, first);
      }
      const st = lolState(e, det, fr[fr.length - 1], w.gameMetadata, lolFirst.get(g.id));
      if (st) out.push(st);
    }
    return out;
  }
  async function csStates() {
    const ms = (await get(`${BO3}/matches`, { 'page[limit]': 50, 'filter[matches.status][in]': 'current', 'filter[matches.discipline_id][eq]': 1 }, BH))?.results || [];
    const out = [];
    for (const m of ms) {
      const games = (await get(`${BO3}/games`, { 'filter[games.match_id][eq]': m.id, 'page[limit]': 10 }, BH))?.results || [];
      const live = games.find(g => g.status === 'current' || g.state === 'live' || g.state === 'in_progress');
      const rounds = live ? (await get(`${BO3}/games/${live.id}/rounds`, {}, BH))?.game_rounds || [] : null;
      const st = csState(m, games, rounds, now());
      if (st) out.push(st);
    }
    return out;
  }
  async function dotaStates() {
    const rows = await get('https://api.opendota.com/api/live');
    return (Array.isArray(rows) ? rows : []).map(r => dotaState(r, now())).filter(Boolean);
  }
  // Kalshi alone: the live map is the lowest map still open; earlier maps' winners from their settled markets
  async function kalshiSeriesScore(sr) {
    const open = Object.keys(sr.maps).map(Number).sort((a, b) => a - b);
    if (!open.length) return null;
    const live = open[0], score = [0, 0];
    for (let n = 1; n < live; n++) {
      const ev = `${GAMES[sr.game].map}-${sr.base}-${n}`;
      if (!settled.has(ev)) {
        const ms = (await get(`${K}/markets`, { event_ticker: ev }).catch(() => null))?.markets || [];
        const w = ms.find(m => m.result === 'yes');
        if (w) settled.set(ev, w.yes_sub_title); else return null;
      }
      const w = settled.get(ev);
      if (w === sr.teams[0]) score[0]++; else if (w === sr.teams[1]) score[1]++; else return null;
    }
    return { live, score };
  }
  async function tick() {
    const t = now();
    state.errors = {};
    const series = groupKalshi(await kalshiEvents(), { now: t });
    const books = new Map();
    for (const sr of series) {
      for (const [k, mk] of [...Object.entries(sr.maps).map(([n, v]) => [`map${n}`, v]), ...(sr.match ? [['match', sr.match]] : [])]) {
        for (const b of mk.books) books.set(b.ticker, b);
        const mid = teamMid(bookFor(mk.books, sr.teams[0]), otherBook(mk.books, sr.teams[0]));
        if (mid == null) continue;
        const key = `${sr.key}:${k}`, h = hist.get(key) || [];
        h.push([t, mid]); while (h.length && t - h[0][0] > 30 * 60e3) h.shift();
        hist.set(key, h);
      }
    }
    const games = new Set(series.map(s => s.game));
    const feeds = {};
    const want = { LOL: lolStates, CS2: csStates, DOTA: dotaStates };
    for (const [g, fn] of Object.entries(want)) {
      if (!games.has(g) || !models[g]) continue;
      try { feeds[g] = await fn(); } catch (e) { state.errors[g] = e.message; feeds[g] = []; }
    }
    const live = [], flags = [], ctxState = {}, ended = new Set();
    for (const sr of series) {
      let st = null;
      for (const cand of feeds[sr.game] || []) { const al = alignTeams(sr.teams, cand.teams); if (al) { st = al[0] === 0 ? cand : flipState(cand); break; } }
      if (!st) continue;
      if (sr.game === 'DOTA') {
        const ks = await kalshiSeriesScore(sr);
        if (!ks) continue;
        st = { ...st, map: ks.live, series: ks.score, startedAt: st.at - st.minute * 60e3 };
        const bo = Object.keys(sr.maps).length ? Math.max(...Object.keys(sr.maps).map(Number)) : null;
        st.bo = bo && bo >= 2 ? (bo <= 3 ? 3 : 5) : 1;
      }
      if (st.finished && st.map) ended.add(`${sr.key}:${st.map}`);
      // anchors: Kalshi's mid just before the map started (30 s slack), and before the series started
      const mk = `${sr.key}:map${st.map}`;
      if (anchors[mk] === undefined && st.startedAt) anchors[mk] = midAt(hist.get(mk), st.startedAt - 30e3, o.anchorWindowMs);
      const sk = `${sr.key}:match`;
      if (anchors[sk] === undefined && st.series && st.series[0] + st.series[1] === 0 && st.startedAt) anchors[sk] = midAt(hist.get(sk), st.startedAt - 30e3, o.anchorWindowMs);
      const ev = evaluate(sr, st, anchors, { now: t, models, ...o });
      ctxState[sr.key] = { score: st.score || null, series: st.series || null, minute: st.minute != null ? Math.round(st.minute * 10) / 10 : null, x: st.x || null, pMap: ev.pMap, pMatch: ev.pMatch ?? null };
      live.push({ game: sr.game, series: sr.key, teams: sr.teams, map: st.map, p0: anchors[mk] ?? null, pMap: ev.pMap, pMatch: ev.pMatch ?? null,
        mid: teamMid(bookFor(sr.maps[st.map]?.books, sr.teams[0]), otherBook(sr.maps[st.map]?.books, sr.teams[0])), state: ctxState[sr.key], flags: ev.flags.length, stale: !!ev.stale });
      flags.push(...ev.flags);
    }
    const fresh = tracker ? await tracker.record(flags, { state: ctxState, repeatMs: o.repeatMs }) : [];
    if (tracker) await tracker.mark(books, { ended });
    Object.assign(state, { updated: new Date(t).toISOString(), live, counts: { kalshiSeries: series.length, matched: live.length, flags: flags.length, logged: fresh.length, feeds: Object.fromEntries(Object.entries(feeds).map(([g, a]) => [g, a.length])) } });
    return fresh;
  }
  return { tick, state, anchors };
}

module.exports = {
  INPLAY_FITS, createInplay, midAt,
  GAMES, DEFAULTS, MODELS, parseTicker, groupKalshi, teamMid, lolState, dotaState, csState, alignTeams, liveMapProb, flipState, evaluate, createInplayTracker, summarize,
  csOtBlock, raceProb, mapWinGivenQ, mapWin, roundRateFor,
  stateModelProb, seriesWin, mapRateFor, costOf, edgeOf, logit, sigmoid,
};
