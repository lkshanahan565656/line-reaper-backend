// ─── ESPORTS MATCH BOARD ──────────────────────────────────────────────────────
// Every upcoming esports match the exchanges list, priced from free sources:
//
//   • Kalshi: match winner, map winners, total maps and map spreads for CS2,
//     LoL, Valorant, Dota 2, CoD, R6, Overwatch, Rocket League and MLBB
//     (KXCS2GAME, KXCS2MAP, KXCS2TOTALMAPS, KXCS2SPREAD, ...). It's the venue a
//     US bettor can use, so its edges are the ones that matter most.
//   • Polymarket: the same markets for every esport it lists (series ids from
//     Gamma /sports, tag 64), with the match winner, "Map/Game N Winner",
//     "Games Total: O/U 2.5" and "Map Handicap" markets.
//   • A sportsbook price for CS2 from bo3.gg's match list (its bet_updates
//     carry the match and total-maps odds of the book it partners with).
//
// One match is one row: the sources are paired by their two teams (names
// normalised: accents, zero-width marks, "Team"/"Esports" dropped; academy
// rosters never match their main team) and start times within 3 hours.
//
// Fair price: the no-vig consensus of every source with a tight two-sided
// quote (bid and ask within MAX_SPREAD, or a book's two prices). An edge is
// a venue's ask plus its taker fee below the fair price made from the OTHER
// sources only, so a venue never confirms its own price. It's flagged when
// it is at least edgeMin of the stake, before the start, on a quote with a
// real bid behind it, and the references agree with each other.
//
// Model: map-level Elo from free results (OpenDota, bo3.gg, lolesports,
// vlr.gg; see ratings.js) turned into series, map, total and spread prices.
// It is shown next to the market, never used for flags: the exchanges are
// sharper than a rating built from results.
//
// Line moves: the fair price of every outcome is sampled each scan, so the
// board can show where a match opened and what moved in the last hour.

const { teamsMatch, mapToSeriesProb, seriesToMapProb, devig } = require('./context');
const { kalshiFee } = require('./exchanges');
const { kalshiTickerTime, polymarketFeeSchedule, polymarketFee } = require('./xarb');

const KALSHI_EVENTS = 'https://api.elections.kalshi.com/trade-api/v2/events';
const GAMMA = 'https://gamma-api.polymarket.com';
const BO3 = 'https://api.bo3.gg/api/v1';
const BO3_HEADERS = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper esports board)' };

// Our game keys, Polymarket's sport codes and Kalshi's series per market kind.
const GAMES = {
  CS2: { label: 'CS2', pm: 'cs2', elo: 'CS', kalshi: { match: ['KXCS2GAME'], map: ['KXCS2MAP'], total: ['KXCS2TOTALMAPS'], spread: ['KXCS2SPREAD'] } },
  LOL: { label: 'LoL', pm: 'lol', elo: 'LOL', kalshi: { match: ['KXLOLGAME'], map: ['KXLOLMAP'], total: ['KXLOLTOTALMAPS'], spread: ['KXLOLSPREAD'] } },
  VAL: { label: 'Valorant', pm: 'val', elo: 'VAL', kalshi: { match: ['KXVALORANTGAME'], map: ['KXVALORANTMAP'], total: ['KXVALORANTTOTALMAPS'], spread: ['KXVALORANTSPREAD'] } },
  DOTA: { label: 'Dota 2', pm: 'dota2', elo: 'DOTA', kalshi: { match: ['KXDOTA2GAME'], map: ['KXDOTA2MAP'], total: ['KXDOTA2TOTALMAPS'], spread: ['KXDOTA2SPREAD'] } },
  COD: { label: 'Call of Duty', pm: 'codmw', kalshi: { match: ['KXCODGAME'], map: ['KXCODMAP'], total: ['KXCODTOTALMAPS'], spread: ['KXCODSPREAD'] } },
  R6: { label: 'Rainbow Six', pm: 'r6siege', kalshi: { match: ['KXR6GAME'], map: ['KXR6MAP'], total: ['KXR6TOTALMAPS'], spread: ['KXR6SPREAD'] } },
  OW: { label: 'Overwatch', pm: 'ow', kalshi: { match: ['KXOWGAME'], total: ['KXOWTOTALMAPS'], spread: ['KXOWSPREAD'] } },
  RL: { label: 'Rocket League', pm: 'rl', kalshi: { match: ['KXRLGAME', 'KXROCKETLEAGUEGAME'], map: ['KXRLMAP'], total: ['KXRLTOTALMAPS'], spread: ['KXRLSPREAD'] } },
  MLBB: { label: 'Mobile Legends', pm: 'mlbb', kalshi: { match: ['KXMLBBGAME'] } },
  HOK: { label: 'Honor of Kings', pm: 'hok', kalshi: {} },
  SC2: { label: 'StarCraft II', pm: 'sc2', kalshi: {} },
};
const PM_TO_GAME = Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [g.pm, k]));
// Gamma /sports series ids as of 2026-10-10, used until /sports answers
const PM_SERIES_FALLBACK = { cs2: 10310, lol: 10311, dota2: 10309, val: 10369, r6siege: 10432, ow: 10430, mlbb: 10426, hok: 10434, codmw: 10427, rl: 10433, sc2: 10435 };

const DEFAULTS = {
  edgeMin: 0.02,          // flag at 2% of the stake or more
  maxSpread: 0.08,        // a quote wider than 8¢ says little about the price
  maxRefGap: 0.08,        // two references further apart than this don't agree
  minCost: 0.10,          // longshots: a cent or two of noise reads as a huge %
  maxCost: 0.90,          // a 90¢+ buy wins too little to be worth flagging
  minEdgeCents: 0.015,    // and at least 1.5¢ a contract in absolute terms
  pinMinLimit: 250,       // Pinnacle is the fair on its own only where it takes $250+
  pairHours: 3,           // sources' start times within this are the same match
  lookbackHours: 8,       // keep matches that started this long ago (live)
  aheadDays: 10,
  feeLot: 100,            // Kalshi's fee rounds up per order: quoted on 100 contracts
  kalshiFeeRate: 0.07,
  // limit bids: Kalshi charges a maker about a quarter of the taker fee;
  // Polymarket charges makers nothing
  makerShare: { kalshi: 0.25, polymarket: 0 },
};

// A limit bid worth resting when taking the ask has no edge. Esports books
// are wide (24/28¢ is common), so the value sits between bid and ask: a bid
// that improves the best bid by at least a cent, as high as it can go while
// it still clears edgeMin over the fair price after the maker fee. Returns
// null when no such cent exists, or when the take is already an edge.
function bidPlan(q, ref, venue, o) {
  if (q.edge || ref == null || q.bid == null || q.ask == null) return null;
  const rate = (o.makerShare?.[venue] ?? 0) * o.kalshiFeeRate;
  const cost = p => p + (venue === 'kalshi' ? rate * p * (1 - p) : 0);
  const evAt = p => (ref - cost(p)) / cost(p);
  let p = Math.round((q.ask - 0.01) * 100) / 100;
  while (p > q.bid + 0.005 && (evAt(p) < o.edgeMin || ref - cost(p) < o.minEdgeCents - 1e-9)) p = Math.round((p - 0.01) * 100) / 100;
  if (!(p >= q.bid + 0.01 - 1e-9) || p < o.minCost || cost(p) > o.maxCost) return null;
  if (evAt(p) < o.edgeMin || ref - cost(p) < o.minEdgeCents - 1e-9) return null;
  return { price: p, cost: r4(cost(p)), ev: r4(evAt(p)) };
}

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const price = v => { const x = num(v); return x != null && x > 0 && x < 1 ? Math.round(x * 1e4) / 1e4 : null; };
const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
const toMs = v => {
  if (v == null || v === '') return null;
  // Gamma's gameStartTime: "2026-10-14 16:00:00+00"
  const s = String(v).replace(' ', 'T').replace(/\+00$/, 'Z');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const parseJson = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return null; } };

// ── team names ──
// "⁠Movistar KOI Fénix" (with a word joiner) is "Movistar KOI Fenix".
function cleanName(n) {
  return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[​-‏⁠-⁤﻿]/g, '').replace(/\s+/g, ' ').trim();
}
const sameTeam = (a, b) => teamsMatch(cleanName(a), cleanName(b));
// orientation of [x0, x1] against canonical [A, B]: 'same', 'flipped' or null
function orient(teams, other) {
  if (!teams || !other) return null;
  const direct = sameTeam(teams[0], other[0]) && sameTeam(teams[1], other[1]);
  const swap = sameTeam(teams[0], other[1]) && sameTeam(teams[1], other[0]);
  if (direct === swap) return null;
  return direct ? 'same' : 'flipped';
}
const teamIndex = (teams, name) => (sameTeam(teams[0], name) && !sameTeam(teams[1], name) ? 0 : sameTeam(teams[1], name) && !sameTeam(teams[0], name) ? 1 : -1);

// "LoL: Galions vs Movistar KOI Fénix (BO5) - EMEA Masters Playoffs"
function parsePmTitle(title) {
  const t = cleanName(title);
  const bo = t.match(/\(BO(\d)\)/i);
  const tournament = t.includes(' - ') ? t.slice(t.indexOf(' - ') + 3).trim() : null;
  return { bestOf: bo ? Number(bo[1]) : null, tournament };
}

// ── series math (independent maps at per-map probability p for team 0) ──
const C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
// [{ a, b, prob }] final map scores of a best-of-n
function seriesScores(p, bestOf) {
  const need = Math.ceil(bestOf / 2), out = [];
  for (let k = 0; k < need; k++) {
    out.push({ a: need, b: k, prob: C(need - 1 + k, k) * p ** need * (1 - p) ** k });
    out.push({ a: k, b: need, prob: C(need - 1 + k, k) * (1 - p) ** need * p ** k });
  }
  return out;
}
// model price of every outcome of a market from a per-map probability
function modelFor(market, p, bestOf) {
  if (p == null) return null;
  const bo = bestOf || 3;
  if (market.kind === 'map') return [p, 1 - p];
  if (market.kind === 'match') { const s = bo === 1 ? p : mapToSeriesProb(p, bo); return [s, 1 - s]; }
  if (bo < 2) return null;
  const scores = seriesScores(p, bo);
  if (market.kind === 'total') {
    const over = scores.filter(s => s.a + s.b > market.line).reduce((x, s) => x + s.prob, 0);
    return [over, 1 - over];
  }
  if (market.kind === 'spread') {
    // outcome 0: team `team` wins by more than |line| maps
    const by = Math.abs(market.line);
    const covers = scores.filter(s => (market.team === 0 ? s.a - s.b : s.b - s.a) > by).reduce((x, s) => x + s.prob, 0);
    return [covers, 1 - covers];
  }
  return null;
}

// ── parsing: Polymarket ──
// bestBid/bestAsk quote the first outcome; the second's ask is 1 − bestBid.
function pmQuotes(m) {
  const bid = price(m.bestBid), ask = price(m.bestAsk);
  const fee = polymarketFeeSchedule(m);
  const q = (b, a) => ({ bid: b, ask: a, fee: a == null ? 0 : r4(polymarketFee(a, 1, fee)) });
  return [q(bid, ask), q(ask == null ? null : r4(1 - ask), bid == null ? null : r4(1 - bid))];
}
// → { game, teams, start, bestOf, tournament, title, url, volume, markets: [{ key, kind, n?, line?, team?, outcomes: [name, name], quotes: [q, q], conditionId }] } | null
function parsePolymarketEvent(ev, game) {
  const markets = (ev.markets || []).filter(m => m.active !== false && !m.closed && m.acceptingOrders !== false);
  const ml = markets.find(m => m.sportsMarketType === 'moneyline') || null;
  const mlOutcomes = ml ? parseJson(ml.outcomes) : null;
  let teams = mlOutcomes && mlOutcomes.length === 2 ? mlOutcomes.map(cleanName) : null;
  if (!teams) {
    const vs = cleanName(ev.title).replace(/^[^:]*:\s*/, '').replace(/\s*\(BO\d\).*$/i, '').split(/\s+vs\.?\s+/i);
    teams = vs.length === 2 ? vs.map(s => s.trim()) : null;
  }
  if (!teams) return null;
  const { bestOf, tournament } = parsePmTitle(ev.title);
  const start = toMs(ev.startTime) ?? toMs(ml?.gameStartTime) ?? toMs(markets[0]?.gameStartTime) ?? toMs(ev.endDate);
  const out = [];
  for (const m of markets) {
    const names = (parseJson(m.outcomes) || []).map(cleanName);
    if (names.length !== 2) continue;
    const quotes = pmQuotes(m);
    const base = { quotes, conditionId: m.conditionId || null, tokens: parseJson(m.clobTokenIds) || null, liquidity: num(m.liquidity) };
    const type = m.sportsMarketType;
    if (type === 'moneyline') {
      const o = orient(teams, names);
      if (!o) continue;
      out.push({ ...base, key: 'match', kind: 'match', ...flip(o, names, base) });
    } else if (type === 'child_moneyline') {
      const n = Number((String(m.groupItemTitle || m.question).match(/(?:game|map)\s*(\d+)/i) || [])[1]);
      const o = orient(teams, names);
      if (!n || !o) continue;
      out.push({ ...base, key: `map:${n}`, kind: 'map', n, ...flip(o, names, base) });
    } else if (type === 'totals') {
      const line = num((String(m.groupItemTitle || m.question).match(/(\d+(?:\.5))/) || [])[1]);
      if (line == null || !/^over$/i.test(names[0])) continue;
      out.push({ ...base, key: `total:${line}`, kind: 'total', line, outcomes: ['Over', 'Under'] });
    } else if (type === 'map_handicap') {
      // "Map Handicap: MARS (-1.5) vs SportsBetExpert (+1.5)": outcome 0 gives the maps
      const h = String(m.groupItemTitle || m.question).match(/\(([+-]\d+(?:\.5))\)/);
      const line = h ? num(h[1]) : null;
      if (line == null || line >= 0) continue;
      const t = teamIndex(teams, names[0]);
      if (t < 0 || teamIndex(teams, names[1]) !== 1 - t) continue;
      out.push({ ...base, key: `spread:${t}:${Math.abs(line)}`, kind: 'spread', team: t, line, outcomes: [`${teams[t]} ${line}`, `${teams[1 - t]} +${-line}`] });
    }
  }
  return {
    game, teams, start, bestOf, tournament, title: cleanName(ev.title), url: `https://polymarket.com/event/${ev.slug || ''}`,
    volume: num(ev.volume), slug: ev.slug || null, markets: out,
  };
}
// put a market's quotes into canonical team order
function flip(o, names, base) {
  return o === 'same' ? { outcomes: names, quotes: base.quotes } : { outcomes: [names[1], names[0]], quotes: [base.quotes[1], base.quotes[0]], flipped: true };
}

// ── parsing: Kalshi ──
// "KXCS2MAP-26OCT101700BHELARGA-1" → "26OCT101700BHELARGA"
const kalshiTail = t => (String(t || '').split('-')[1] || '');
function kalshiQuote(m, o) {
  const bid = price(m.yes_bid_dollars ?? (num(m.yes_bid) != null ? num(m.yes_bid) / 100 : null));
  const ask = price(m.yes_ask_dollars ?? (num(m.yes_ask) != null ? num(m.yes_ask) / 100 : null));
  const fee = c => (c == null ? 0 : r4(kalshiFee(c, o.feeLot, o.kalshiFeeRate) / o.feeLot));
  return {
    yes: { bid, ask, fee: fee(ask), ticker: m.ticker },
    no: { bid: ask == null ? null : r4(1 - ask), ask: bid == null ? null : r4(1 - bid), fee: fee(bid == null ? null : 1 - bid), ticker: m.ticker, side: 'no' },
    volume: num(m.volume_fp ?? m.volume),
  };
}
const live = m => !m.status || m.status === 'active' || m.status === 'open';
// "Spirit vs. MOUZ: Total Maps" → ['Spirit', 'MOUZ']
const kalshiTitleTeams = title => {
  const parts = cleanName(title).replace(/:.*$/, '').split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? parts.map(s => s.trim()) : null;
};
// One Kalshi event → the market(s) it holds, keyed like Polymarket's.
function parseKalshiEvent(ev, kind, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ms = (ev.markets || []).filter(live);
  const url = `https://kalshi.com/markets/${String(ev.event_ticker || '').toLowerCase()}`;
  let teams = null;
  const out = [];
  if (kind === 'match' || kind === 'map') {
    if (ms.length !== 2) return null;
    teams = ms.map(m => cleanName(m.yes_sub_title));
    const q = ms.map(m => kalshiQuote(m, o));
    const n = kind === 'map' ? Number((String(ev.event_ticker).match(/-(\d+)$/) || String(ev.title).match(/map\s*(\d+)/i) || [])[1]) : null;
    if (kind === 'map' && !n) return null;
    out.push({ key: kind === 'match' ? 'match' : `map:${n}`, kind, ...(n ? { n } : {}), outcomes: teams, quotes: [q[0].yes, q[1].yes], volume: (q[0].volume || 0) + (q[1].volume || 0) });
  } else {
    teams = kalshiTitleTeams(ev.title);
    if (!teams) return null;
    for (const m of ms) {
      const q = kalshiQuote(m, o);
      const label = cleanName(m.yes_sub_title || m.title);
      if (kind === 'total') {
        // "Over 2.5 maps"
        const line = num((label.match(/over\s+(\d+(?:\.5))/i) || [])[1]);
        if (line == null) continue;
        out.push({ key: `total:${line}`, kind: 'total', line, outcomes: ['Over', 'Under'], quotes: [q.yes, q.no], volume: q.volume });
      } else if (kind === 'spread') {
        // "Spirit wins by over 1.5 maps"
        const s = label.match(/^(.+?)\s+wins by over\s+(\d+(?:\.5))/i);
        if (!s) continue;
        const t = teamIndex(teams, s[1]);
        if (t < 0) continue;
        const line = -num(s[2]);
        out.push({ key: `spread:${t}:${-line}`, kind: 'spread', team: t, line, outcomes: [`${teams[t]} ${line}`, `${teams[1 - t]} +${-line}`], quotes: [q.yes, q.no], volume: q.volume });
      }
    }
  }
  if (!out.length) return null;
  for (const mk of out) mk.url = url;
  const t = kalshiTickerTime(ev.event_ticker);
  return { tail: kalshiTail(ev.event_ticker), teams, start: t?.start ?? t?.day ?? null, url, eventTicker: ev.event_ticker, markets: out };
}

// ── parsing: bo3.gg (CS2 sportsbook odds) ──
// bet_updates: { team_1: { name, coeff, active }, team_2, additional_markets: [{ bet_type: 'total_maps_over_2_5', coeff, active }] }
function parseBo3Match(m) {
  const bu = m?.bet_updates;
  const a = bu?.team_1, b = bu?.team_2;
  if (!a?.name || !b?.name || m.status === 'finished') return null;
  const teams = [cleanName(a.name), cleanName(b.name)];
  const markets = [];
  const dec = x => { const d = num(x); return d != null && d > 1 ? d : null; };
  if (a.active !== false && b.active !== false && dec(a.coeff) && dec(b.coeff)) {
    markets.push({ key: 'match', kind: 'match', outcomes: teams, book: [dec(a.coeff), dec(b.coeff)] });
  }
  const totals = {};
  for (const x of bu.additional_markets || []) {
    const t = String(x.bet_type || '').match(/^total_maps_(over|under)_(\d+)_5$/);
    if (!t || x.active === false || !dec(x.coeff)) continue;
    const line = Number(t[2]) + 0.5;
    (totals[line] ??= {})[t[1]] = dec(x.coeff);
  }
  for (const [line, t] of Object.entries(totals)) {
    if (t.over && t.under) markets.push({ key: `total:${Number(line)}`, kind: 'total', line: Number(line), outcomes: ['Over', 'Under'], book: [t.over, t.under] });
  }
  if (!markets.length) return null;
  return { teams, start: toMs(m.start_date), bestOf: num(m.bo_type), live: m.status === 'current', markets, slug: m.slug || null };
}

// ── parsing: Pinnacle (the sharp book: match, map, total-maps and map-spread prices) ──
// Pinnacle's guest feed (guest.api.arcadia.pinnacle.com, sport 12) lists each
// match as a "matchup" (units Regular) and prices it in straight markets:
// period 0 is the series, period N is map N. Its no-vig price is the sharpest
// free number for esports; Kalshi's tight books sit about a cent from it.
// matchups: [{ id, parentId, type, units, league: { name }, participants: [{ alignment, name }], startTime, isLive }]
// markets:  [{ matchupId, period, type, isAlternate, status, limits: [{ amount }], prices: [{ designation, points, price }] }]
const PIN_GAMES = [[/^(cs2|cs:go|counter-strike)/i, 'CS2'], [/^league of legends|^lol/i, 'LOL'], [/^valorant/i, 'VAL'], [/^dota/i, 'DOTA'], [/^call of duty/i, 'COD'], [/^rainbow six/i, 'R6']];
const pinGame = league => (PIN_GAMES.find(([re]) => re.test(String(league || ''))) || [])[1] || null;
const amProb = a => { const x = num(a); return x == null || x === 0 ? null : x > 0 ? 100 / (x + 100) : -x / (-x + 100); };
// power devig: p^k + q^k = 1, so the longshot gives up more of the margin
// (Pinnacle shades favourite-longshot prices that way)
function devigPower(a, b) {
  const pa = amProb(a), pb = amProb(b);
  if (!(pa > 0 && pb > 0) || pa + pb < 1) return pa > 0 && pb > 0 ? pa / (pa + pb) : null;
  let lo = 1, hi = 3;
  for (let i = 0; i < 50; i++) { const k = (lo + hi) / 2; if (pa ** k + pb ** k > 1) lo = k; else hi = k; }
  return pa ** ((lo + hi) / 2);
}
// standard normal quantile (Acklam's approximation, |error| < 1.2e-9)
function probit(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) { const r = q * q; return q * (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  const r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  const x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  return q < 0 ? x : -x;
}
// a team's kills on one map, by game: spread of the count around its mean
const KILL_SD = { LOL: 6, DOTA: 8 };
// Pinnacle's team kill totals ("Kills" child matchups, one team_total per team
// per map, main and alternate lines) → the mean each line implies: line +
// sd × z(P over), averaged over the lines that aren't lopsided.
function pinTeamKills(markets, childId, game) {
  const sd = KILL_SD[game];
  if (!sd) return null;
  const acc = {};
  for (const k of markets || []) {
    if (k.matchupId !== childId || k.type !== 'team_total' || !(k.period > 0) || (k.status && k.status !== 'open')) continue;
    const side = /;(home|away)$/.exec(k.key || '')?.[1];
    const o = k.prices?.find(p => p.designation === 'over'), u = k.prices?.find(p => p.designation === 'under');
    if (!side || !o || !u || o.points == null) continue;
    const p = devigPower(o.price, u.price);
    if (!(p >= 0.15 && p <= 0.85)) continue;
    const a = ((acc[k.period] ??= { home: [], away: [] })[side]);
    a.push(num(o.points) + sd * probit(p));
  }
  const out = {};
  for (const [per, v] of Object.entries(acc)) {
    if (!v.home.length || !v.away.length) continue;
    const avg = xs => r4(xs.reduce((x, y) => x + y, 0) / xs.length);
    out[per] = [avg(v.home), avg(v.away)];
  }
  return Object.keys(out).length ? out : null;
}
function parsePinnacle(matchups, markets) {
  const byId = new Map(), killsOf = new Map();
  for (const m of matchups || []) {
    if (m.type === 'matchup' && m.parentId != null && m.units === 'Kills') { killsOf.set(m.parentId, m.id); continue; }
    if (m.type !== 'matchup' || m.parentId != null || (m.units && m.units !== 'Regular')) continue;
    const game = pinGame(m.league?.name);
    const home = m.participants?.find(p => p.alignment === 'home')?.name, away = m.participants?.find(p => p.alignment === 'away')?.name;
    if (!game || !home || !away) continue;
    byId.set(m.id, { game, teams: [cleanName(home), cleanName(away)], start: toMs(m.startTime), live: !!m.isLive, league: m.league?.name || null, id: m.id, markets: [], maxPeriod: 0 });
  }
  for (const k of markets || []) {
    const m = byId.get(k.matchupId);
    if (!m || (k.status && k.status !== 'open')) continue;
    const at = d => k.prices?.find(p => p.designation === d);
    const limit = num(k.limits?.[0]?.amount);
    if (k.type === 'moneyline') {
      const h = at('home'), a = at('away');
      if (!h || !a) continue;
      m.maxPeriod = Math.max(m.maxPeriod, k.period || 0);
      const p = devigPower(h.price, a.price);
      if (p == null) continue;
      m.markets.push(k.period === 0 ? { key: 'match', kind: 'match', outcomes: m.teams, prob: p, limit, price: [h.price, a.price] }
        : { key: `map:${k.period}`, kind: 'map', n: k.period, outcomes: m.teams, prob: p, limit, price: [h.price, a.price] });
    } else if (k.period === 0 && k.type === 'total') {
      const o = at('over'), u = at('under');
      if (!o || !u || o.points == null || o.points !== u.points) continue;
      const p = devigPower(o.price, u.price);
      if (p != null) m.markets.push({ key: `total:${num(o.points)}`, kind: 'total', line: num(o.points), outcomes: ['Over', 'Under'], prob: p, limit, price: [o.price, u.price] });
    } else if (k.period === 0 && k.type === 'spread') {
      const h = at('home'), a = at('away');
      if (!h || !a || h.points == null || num(h.points) === 0 || num(h.points) !== -num(a.points)) continue;
      const t = num(h.points) < 0 ? 0 : 1, line = Math.abs(num(h.points));
      const p = devigPower(t === 0 ? h.price : a.price, t === 0 ? a.price : h.price);
      if (p != null) m.markets.push({ key: `spread:${t}:${line}`, kind: 'spread', team: t, line: -line, outcomes: [`${m.teams[t]} -${line}`, `${m.teams[1 - t]} +${line}`], prob: p, limit, price: t === 0 ? [h.price, a.price] : [a.price, h.price] });
    }
  }
  const out = [];
  for (const m of byId.values()) {
    if (!m.markets.length) continue;
    const teamKills = killsOf.has(m.id) ? pinTeamKills(markets, killsOf.get(m.id), m.game) : null;
    // a map-4 price or a 3.5-map total only exists in a best-of-5
    const bo5 = m.maxPeriod >= 4 || m.markets.some(k => k.kind === 'total' && k.line >= 3);
    out.push({ game: m.game, teams: m.teams, start: m.start, live: m.live, league: m.league, id: m.id, bestOf: bo5 ? 5 : null, markets: m.markets, ...(teamKills ? { teamKills } : {}) });
  }
  return out;
}

// ── merging ──
function blankMatch(game, src) {
  return {
    id: null, game, label: GAMES[game]?.label || game, teams: src.teams, start: src.start, bestOf: src.bestOf || null,
    tournament: src.tournament || null, links: {}, volume: { kalshi: 0, polymarket: src.volume || 0 }, markets: new Map(),
  };
}
function marketSlot(match, mk) {
  if (!match.markets.has(mk.key)) {
    match.markets.set(mk.key, {
      key: mk.key, kind: mk.kind, ...(mk.n ? { n: mk.n } : {}), ...(mk.line != null ? { line: mk.line } : {}), ...(mk.team != null ? { team: mk.team } : {}),
      outcomes: mk.outcomes.map(name => ({ name, quotes: {} })),
    });
  }
  return match.markets.get(mk.key);
}
// re-key a source's market against the match's team order
function alignMarket(mk, o) {
  if (o === 'same') return mk;
  if (mk.kind === 'match' || mk.kind === 'map') return { ...mk, outcomes: [mk.outcomes[1], mk.outcomes[0]], quotes: mk.quotes && [mk.quotes[1], mk.quotes[0]], book: mk.book && [mk.book[1], mk.book[0]] };
  if (mk.kind === 'spread') return { ...mk, team: 1 - mk.team, key: `spread:${1 - mk.team}:${Math.abs(mk.line)}` };
  return mk;
}
function findMatch(list, game, teams, start, o) {
  const win = o.pairHours * 3600e3;
  let best = null;
  for (const m of list) {
    if (m.game !== game) continue;
    const or = orient(m.teams, teams);
    if (!or) continue;
    const gap = start != null && m.start != null ? Math.abs(start - m.start) : 0;
    if (gap > win) continue;
    if (!best || gap < best.gap) best = { m, or, gap };
  }
  return best;
}

// pm: parsed Polymarket events; kalshi: parsed Kalshi events with .game; book: parsed bo3 matches with .game
function mergeSources({ pm = [], kalshi = [], book = [], sharp = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = [];
  for (const p of pm) {
    const match = blankMatch(p.game, p);
    match.links.polymarket = p.url;
    match.slug = p.slug;
    for (const mk of p.markets) {
      const slot = marketSlot(match, mk);
      mk.outcomes.forEach((_, i) => { slot.outcomes[i].quotes.polymarket = { ...mk.quotes[i], conditionId: mk.conditionId, token: mk.tokens?.[mk.flipped ? 1 - i : i] ?? null, liquidity: mk.liquidity }; });
    }
    list.push(match);
  }
  // Kalshi: the events of one match share a ticker tail; group them first
  const groups = new Map();
  for (const k of kalshi) {
    const id = `${k.game}|${k.tail}`;
    if (!groups.has(id)) groups.set(id, { game: k.game, parts: [] });
    groups.get(id).parts.push(k);
  }
  for (const g of groups.values()) {
    const lead = g.parts.find(x => x.markets.some(m => m.kind === 'match')) || g.parts[0];
    const hit = findMatch(list, g.game, lead.teams, lead.start, o);
    const match = hit ? hit.m : blankMatch(g.game, { teams: lead.teams, start: lead.start });
    if (!hit) list.push(match);
    match.links.kalshi = lead.url;
    for (const part of g.parts) {
      const or = orient(match.teams, part.teams);
      if (!or) continue;
      for (const raw of part.markets) {
        const mk = alignMarket(raw, or);
        const slot = marketSlot(match, mk);
        mk.quotes.forEach((q, i) => { slot.outcomes[i].quotes.kalshi = { ...q, url: mk.url }; });
        if (mk.kind === 'match') match.volume.kalshi += mk.volume || 0;
      }
    }
  }
  for (const b of book) {
    const hit = findMatch(list, b.game, b.teams, b.start, o);
    if (!hit) continue;   // a book price alone isn't a tradable market
    if (!hit.m.bestOf && b.bestOf) hit.m.bestOf = b.bestOf;
    if (b.live) hit.m.live = true;
    for (const raw of b.markets) {
      const mk = alignMarket(raw, hit.or);
      if (!hit.m.markets.has(mk.key)) continue;
      const slot = hit.m.markets.get(mk.key);
      const p0 = devig(mk.book[0], mk.book[1]);
      if (p0 == null) continue;
      slot.outcomes[0].quotes.book = { decimal: mk.book[0], prob: r4(p0) };
      slot.outcomes[1].quotes.book = { decimal: mk.book[1], prob: r4(1 - p0) };
    }
  }
  for (const p of sharp) {
    const hit = findMatch(list, p.game, p.teams, p.start, o);
    if (!hit) continue;   // Pinnacle alone isn't a market a subscriber can trade
    if (!hit.m.bestOf && p.bestOf) hit.m.bestOf = p.bestOf;
    if (p.live) hit.m.live = true;
    hit.m.links.pinnacle = p.id;
    // per-map team kills, in the board's team order
    if (p.teamKills) hit.m.pinTeamKills = Object.fromEntries(Object.entries(p.teamKills).map(([n, v]) => [n, hit.or === 'same' ? v : [v[1], v[0]]]));
    for (const raw of p.markets) {
      const mk = alignMarket({ ...raw, book: [raw.prob, 1 - raw.prob], price: raw.price }, hit.or);
      if (!hit.m.markets.has(mk.key)) continue;
      const slot = hit.m.markets.get(mk.key);
      const p0 = mk.book[0];
      slot.outcomes[0].quotes.pinnacle = { prob: r4(p0), american: mk.price?.[0] ?? null, limit: raw.limit ?? null };
      slot.outcomes[1].quotes.pinnacle = { prob: r4(1 - p0), american: mk.price?.[1] ?? null, limit: raw.limit ?? null };
    }
  }
  for (const m of list) {
    m.id = `${m.game}:${m.teams.map(t => cleanName(t).toLowerCase().replace(/[^a-z0-9]+/g, '')).join('-')}:${m.start ? new Date(m.start).toISOString().slice(0, 10) : 'tbd'}`;
  }
  return list;
}

// ── prices ──
// a venue's probability for outcome 0 from tight two-sided quotes
function venueProb(market, venue, o) {
  const [a, b] = market.outcomes.map(x => x.quotes[venue]);
  if (venue === 'book' || venue === 'pinnacle') return a?.prob ?? null;
  const mid = q => (q && q.bid != null && q.ask != null && q.ask - q.bid <= o.maxSpread + 1e-9 ? (q.bid + q.ask) / 2 : null);
  const ma = mid(a), mb = mid(b);
  if (ma != null && mb != null) return ma / (ma + mb);
  if (ma != null) return ma;
  if (mb != null) return 1 - mb;
  return null;
}
const VENUES = ['kalshi', 'polymarket', 'book', 'pinnacle'];
const TRADABLE = ['kalshi', 'polymarket'];
// fair price, model, best buy and edges for one market
function priceMarket(market, { model = null, start = null, now = Date.now(), opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const probs = {};
  for (const v of VENUES) { const p = venueProb(market, v, o); if (p != null) probs[v] = p; }
  const srcs = Object.keys(probs);
  const avg = list => (list.length ? list.reduce((x, v) => x + probs[v], 0) / list.length : null);
  // Pinnacle, when it prices the market, is the fair price on its own: the
  // sharpest book outranks an average that folds in thinner venues
  // A small limit ($50-$100 on tier-3 matches) is Pinnacle saying it isn't
  // sure either: there it averages in like any other source.
  const pinLimit = market.outcomes[0].quotes.pinnacle?.limit;
  const sharp = o.sharpRef !== false && probs.pinnacle != null && (pinLimit == null || pinLimit >= o.pinMinLimit);
  const fair0 = sharp ? probs.pinnacle : avg(srcs);
  market.sources = srcs;
  market.outcomes.forEach((oc, i) => {
    oc.fair = fair0 == null ? null : r4(i === 0 ? fair0 : 1 - fair0);
    oc.model = model ? r4(model[i]) : null;
    let best = null;
    for (const v of TRADABLE) {
      const q = oc.quotes[v];
      if (!q || q.ask == null) continue;
      const cost = r4(q.ask + (q.fee || 0));
      // the fair price from every OTHER source
      const refs = srcs.filter(s => s !== v);
      const ref0 = sharp ? probs.pinnacle : avg(refs);
      const refAgree = refs.length < 2 || Math.max(...refs.map(s => probs[s])) - Math.min(...refs.map(s => probs[s])) <= o.maxRefGap + 1e-9;
      const ref = ref0 == null ? null : (i === 0 ? ref0 : 1 - ref0);
      const ev = ref == null ? null : r4((ref - cost) / cost);
      q.cost = cost;
      q.ref = ref == null ? null : r4(ref);
      q.refSource = ref == null ? null : sharp ? 'pinnacle' : 'consensus';
      q.ev = ev;
      // a real bid close behind the ask (and close relative to the price: 3¢/6¢ is no market)
      const tight = q.bid != null && q.ask - q.bid <= Math.min(o.maxSpread, 0.35 * q.ask) + 1e-9;
      q.edge = ev != null && ev >= o.edgeMin && ref - cost >= o.minEdgeCents - 1e-9 && tight && refAgree
        && cost >= o.minCost && cost <= o.maxCost && (start == null || start > now) ? true : undefined;
      q.bidPlan = refAgree && (start == null || start > now) ? bidPlan(q, ref, v, o) : null;
      if (!q.bidPlan) delete q.bidPlan;
      if (!best || cost < best.cost) best = { venue: v, cost, ev };
    }
    oc.best = best;
  });
  // both sides bought for under $1 (two venues, or one venue's two books:
  // Kalshi lists each team as its own market)
  market.arb = null;
  if (start == null || start > now) {
    let best = null;
    for (const v0 of TRADABLE) for (const v1 of TRADABLE) {
      const q0 = market.outcomes[0].quotes[v0], q1 = market.outcomes[1].quotes[v1];
      if (q0?.cost == null || q1?.cost == null) continue;
      // one Polymarket book quotes both sides: buying both is never under $1
      if (v0 === v1 && v0 === 'polymarket') continue;
      const total = q0.cost + q1.cost;
      if (total < 1 && (!best || total < best.total)) best = { total, legs: [[v0, q0], [v1, q1]] };
    }
    if (best) {
      const tight = best.legs.every(([, q]) => q.bid != null && q.ask - q.bid <= o.maxSpread + 1e-9);
      market.arb = { legs: best.legs.map(([v, q], i) => ({ venue: v, outcome: market.outcomes[i].name, cost: q.cost })), profitPct: r4((1 - best.total) / best.total), tight };
    }
  }
  return market;
}

// ── line moves ──
function createMoveTracker({ keepMs = 36 * 3600e3, maxSamples = 400 } = {}) {
  const series = new Map();
  return {
    note(key, p, t) {
      if (p == null) return;
      let s = series.get(key);
      if (!s) series.set(key, s = { open: { t, p }, samples: [] });
      const last = s.samples[s.samples.length - 1];
      if (!last || Math.abs(last.p - p) >= 0.0025 || t - last.t > 15 * 60e3) s.samples.push({ t, p });
      if (s.samples.length > maxSamples) s.samples.splice(0, s.samples.length - maxSamples);
    },
    move(key, now) {
      const s = series.get(key);
      if (!s || !s.samples.length) return null;
      const cur = s.samples[s.samples.length - 1];
      const hourAgo = [...s.samples].reverse().find(x => x.t <= now - 3600e3) || s.samples[0];
      return { open: s.open.p, openAt: new Date(s.open.t).toISOString(), now: cur.p, h1: r4(cur.p - hourAgo.p), sinceOpen: r4(cur.p - s.open.p) };
    },
    prune(now) { for (const [k, s] of series) if (now - s.samples[s.samples.length - 1].t > keepMs) series.delete(k); },
    size: () => series.size,
  };
}

// Kalshi doesn't say best-of: its total-maps lines and map markets do.
function inferBestOf(markets) {
  const lines = markets.filter(mk => mk.kind === 'total').map(mk => mk.line);
  const maps = markets.filter(mk => mk.kind === 'map').map(mk => mk.n);
  if (lines.some(l => l >= 3.5) || maps.some(n => n >= 4)) return 5;
  if (lines.includes(2.5) || maps.includes(3) || markets.some(mk => mk.kind === 'spread')) return 3;
  return null;
}

// A map already played (or a total already over): someone bids 97¢+, or
// nobody quotes the other side above 3¢.
function decided(mk) {
  return mk.outcomes.some(oc => Object.values(oc.quotes).some(q => (q.bid != null && q.bid >= 0.97) || (q.ask != null && q.ask <= 0.03)));
}

// ── ratings calibration ──
// Elo from free results runs hot: it ranked teams sensibly but its prices sat
// 12 points from the market on average, because a rating gap built on
// regional leagues and stand-in rosters says less than it seems. Fitting one
// number per game, the share of the gap the market agrees with (logit of the
// market's map price ≈ scale × logit of Elo's), fixes most of that. The fit
// reruns every scan over the matches that have both, and keeps its last value
// when too few do.
const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clampP = p => Math.min(0.99, Math.max(0.01, p));
function fitScale(pairs, { min = 12, lo = 0.15, hi = 1.5 } = {}) {
  if (pairs.length < min) return null;
  let xy = 0, xx = 0;
  for (const { raw, market } of pairs) { const x = logit(clampP(raw)), y = logit(clampP(market)); xy += x * y; xx += x * x; }
  return xx > 1e-9 ? Math.min(hi, Math.max(lo, xy / xx)) : null;
}
const scaled = (p, s) => sigmoid(s * logit(clampP(p)));

// Price every market of every match; matches come out sorted by start.
// calib: { [game]: { scale, n, maeRaw, maeCal } }, carried between scans.
function buildBoard(matches, { elo = {}, moves = null, now = Date.now(), opts = {}, calib = null } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const rated = [];
  for (const m of matches) {
    const rating = elo[GAMES[m.game]?.elo];
    let p = null, ratingInfo = null;
    if (rating && rating.games(m.teams[0]) >= 8 && rating.games(m.teams[1]) >= 8) {
      p = (rating.rawMapProb || rating.mapProb).call(rating, m.teams[0], m.teams[1]);
      ratingInfo = { mapProb: r4(p), raw: r4(p), games: [rating.games(m.teams[0]), rating.games(m.teams[1])], ratings: [Math.round(rating.rating(m.teams[0])), Math.round(rating.rating(m.teams[1]))] };
    }
    const markets = [...m.markets.values()].filter(mk => mk.outcomes.some(oc => TRADABLE.some(v => oc.quotes[v]?.ask != null)) && !decided(mk));
    for (const mk of markets) {
      priceMarket(mk, { model: modelFor(mk, p, m.bestOf), start: m.start, now, opts: o });
      if (moves) {
        const key = `${m.id}|${mk.key}`;
        moves.note(key, mk.outcomes[0].fair, now);
        mk.move = moves.move(key, now);
      }
    }
    if (!markets.length) continue;
    if (!m.bestOf) m.bestOf = inferBestOf(markets);
    const order = { match: 0, map: 1, total: 2, spread: 3 };
    markets.sort((a, b) => order[a.kind] - order[b.kind] || (a.n || 0) - (b.n || 0) || (a.line || 0) - (b.line || 0) || (a.team || 0) - (b.team || 0));
    const edges = [];
    for (const mk of markets) mk.outcomes.forEach(oc => TRADABLE.forEach(v => { if (oc.quotes[v]?.edge) edges.push({ market: mk.key, kind: mk.kind, outcome: oc.name, venue: v, cost: oc.quotes[v].cost, fair: oc.quotes[v].ref, ev: oc.quotes[v].ev, refSource: oc.quotes[v].refSource, ...(oc.quotes.pinnacle?.limit != null ? { pinLimit: oc.quotes.pinnacle.limit } : {}) }); }));
    edges.sort((a, b) => b.ev - a.ev);
    const bids = [];
    for (const mk of markets) mk.outcomes.forEach(oc => TRADABLE.forEach(v => { const b = oc.quotes[v]?.bidPlan; if (b) bids.push({ market: mk.key, kind: mk.kind, outcome: oc.name, venue: v, price: b.price, cost: b.cost, fair: oc.quotes[v].ref, ev: b.ev, ask: oc.quotes[v].ask, bid: oc.quotes[v].bid }); }));
    bids.sort((a, b) => b.ev - a.ev);
    const main = markets.find(mk => mk.kind === 'match') || null;
    if (p != null) rated.push({ m, p, markets, ratingInfo, main });
    out.push({
      id: m.id, game: m.game, label: m.label, teams: m.teams, start: m.start ? new Date(m.start).toISOString() : null,
      live: !!m.live || (m.start != null && m.start <= now), bestOf: m.bestOf, tournament: m.tournament, links: m.links, slug: m.slug || null,
      volume: m.volume, rating: ratingInfo, markets, edges, bids, arbs: markets.filter(mk => mk.arb).map(mk => ({ market: mk.key, ...mk.arb })),
      fair: main ? main.outcomes.map(oc => oc.fair) : null, move: main?.move || null,
      ...(m.pinTeamKills ? { pinTeamKills: m.pinTeamKills } : {}),
    });
  }
  calibrate(rated, { elo, calib });
  if (moves) moves.prune(now);
  return out.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
}

function calibrate(rated, { elo = {}, calib = null } = {}) {
  const byGame = {};
  for (const r of rated) (byGame[r.m.game] ||= []).push(r);
  for (const [game, rows] of Object.entries(byGame)) {
    const bestOfOf = r => r.m.bestOf || 3;
    const pairs = rows.filter(r => r.main?.outcomes[0].fair != null).map(r => ({
      raw: r.p, market: bestOfOf(r) === 1 ? r.main.outcomes[0].fair : seriesToMapProb(r.main.outcomes[0].fair, bestOfOf(r)), r,
    }));
    const prev = calib?.[game];
    const fit = fitScale(pairs);
    const scale = fit ?? prev?.scale ?? 1;
    // mean error on the match price, before and after
    const err = f => (pairs.length ? pairs.reduce((s, x) => s + Math.abs((bestOfOf(x.r) === 1 ? f(x.raw) : mapToSeriesProb(f(x.raw), bestOfOf(x.r))) - x.r.main.outcomes[0].fair), 0) / pairs.length : null);
    // out of sample: each match priced with the scale fitted on the others
    let holdout = null;
    if (fit != null) {
      let sum = 0;
      for (const x of pairs) {
        const s = fitScale(pairs.filter(y => y !== x), { min: 1 }) ?? 1;
        const p = scaled(x.raw, s);
        sum += Math.abs((bestOfOf(x.r) === 1 ? p : mapToSeriesProb(p, bestOfOf(x.r))) - x.r.main.outcomes[0].fair);
      }
      holdout = r4(sum / pairs.length);
    }
    if (calib) calib[game] = { scale: r4(scale), n: pairs.length, maeRaw: pairs.length ? r4(err(x => x)) : prev?.maeRaw ?? null, maeCal: pairs.length ? r4(err(x => scaled(x, scale))) : prev?.maeCal ?? null, maeHoldout: holdout ?? prev?.maeHoldout ?? null, fitted: fit != null || !!prev?.fitted };
    const rating = elo[GAMES[game]?.elo];
    if (rating) rating.scale = scale;
    for (const r of rows) {
      const p = scaled(r.p, scale);
      r.ratingInfo.mapProb = r4(p);
      r.ratingInfo.scale = r4(scale);
      for (const mk of r.markets) {
        const model = modelFor(mk, p, r.m.bestOf);
        mk.outcomes.forEach((oc, i) => { oc.model = model ? r4(model[i]) : null; });
      }
    }
  }
}

// ── fetching ──
async function fetchPmSeries(http) {
  try {
    const res = await http.get(`${GAMMA}/sports`, { timeout: 20000 });
    const ids = {};
    for (const s of Array.isArray(res?.data) ? res.data : []) {
      if (PM_TO_GAME[s.sport] && String(s.tags || '').split(',').includes('64') && s.series) ids[s.sport] = Number(s.series);
    }
    return Object.keys(ids).length ? { ...PM_SERIES_FALLBACK, ...ids } : PM_SERIES_FALLBACK;
  } catch { return PM_SERIES_FALLBACK; }
}
async function fetchPmGame(http, sport, seriesId, { now = Date.now(), opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  for (let page = 0; page < 3; page++) {
    // old events can stay open for months: ask only for games ending in the window
    const res = await http.get(`${GAMMA}/events`, {
      params: {
        series_id: seriesId, closed: false, limit: 100, offset: page * 100, order: 'startDate', ascending: false,
        end_date_min: new Date(now - o.lookbackHours * 3600e3).toISOString(), end_date_max: new Date(now + (o.aheadDays + 1) * 86400e3).toISOString(),
      }, timeout: 25000,
    });
    const evs = Array.isArray(res?.data) ? res.data : [];
    for (const ev of evs) {
      const m = parsePolymarketEvent(ev, PM_TO_GAME[sport]);
      if (!m || m.start == null) continue;
      if (m.start < now - o.lookbackHours * 3600e3 || m.start > now + o.aheadDays * 86400e3) continue;
      out.push(m);
    }
    if (evs.length < 100) break;
  }
  return out;
}
async function fetchKalshiSeries(http, ticker) {
  const res = await http.get(KALSHI_EVENTS, { params: { series_ticker: ticker, status: 'open', with_nested_markets: true, limit: 200 }, timeout: 20000 });
  return res?.data?.events || [];
}
const PIN_API = 'https://guest.api.arcadia.pinnacle.com/0.1';
async function fetchPinnacle(http, key = '') {
  const headers = { Accept: 'application/json', ...(key ? { 'X-API-Key': key } : {}) };
  const [mu, mk] = await Promise.all([
    http.get(`${PIN_API}/sports/12/matchups`, { headers, timeout: 20000 }),
    http.get(`${PIN_API}/sports/12/markets/straight`, { headers, timeout: 20000 }),
  ]);
  return parsePinnacle(mu?.data, mk?.data);
}
async function fetchBo3Upcoming(http, { pages = 3 } = {}) {
  const out = [];
  for (let page = 0; page < pages; page++) {
    const res = await http.get(`${BO3}/matches`, {
      params: { 'page[offset]': page * 50, 'page[limit]': 50, sort: 'start_date', 'filter[matches.status][in]': 'upcoming,current', 'filter[matches.discipline_id][eq]': 1 },
      headers: BO3_HEADERS, timeout: 20000,
    });
    const rows = res?.data?.results || [];
    out.push(...rows);
    if (rows.length < 50) break;
  }
  return out;
}

// The board: one scan pulls every source (a series that listed nothing is
// skipped for emptySkipMs), merges and prices.
// pinnacle: () => ({ on, key }) turns the sharp source on per scan
function createEsportsBoard({ http, log = console, ratings = () => ({}), opts = {}, now = () => Date.now(), emptySkipMs = 30 * 60e3, seriesTtlMs = 6 * 3600e3, pinnacle = () => ({ on: false }) } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const moves = createMoveTracker();
  const empty = new Map();
  let pmSeries = null, pmSeriesAt = 0;
  const state = { matches: [], updated: null, durationMs: null, running: false, errors: [], counts: null, calibration: {} };
  async function scan() {
    if (state.running) return state;
    state.running = true;
    const t0 = now(), errors = [];
    try {
      if (!pmSeries || t0 - pmSeriesAt > seriesTtlMs) { pmSeries = await fetchPmSeries(http); pmSeriesAt = t0; }
      const pmJobs = Object.entries(pmSeries).map(([sport, id]) => fetchPmGame(http, sport, id, { now: t0, opts: o })
        .catch(e => { errors.push({ source: 'polymarket', key: sport, message: e.message }); return []; }));
      const kalshiJobs = [];
      for (const [game, g] of Object.entries(GAMES)) {
        for (const [kind, tickers] of Object.entries(g.kalshi || {})) {
          for (const ticker of tickers) {
            if ((empty.get(ticker) || 0) > t0) continue;
            kalshiJobs.push(fetchKalshiSeries(http, ticker).then(evs => {
              if (!evs.length) empty.set(ticker, t0 + emptySkipMs);
              return evs.map(ev => { const p = parseKalshiEvent(ev, kind, o); return p && { ...p, game }; }).filter(Boolean);
            }).catch(e => { errors.push({ source: 'kalshi', key: ticker, message: e.message }); return []; }));
          }
        }
      }
      const bookJob = fetchBo3Upcoming(http).then(rows => rows.map(parseBo3Match).filter(Boolean).map(b => ({ ...b, game: 'CS2' })))
        .catch(e => { errors.push({ source: 'bo3', key: 'matches', message: e.message }); return []; });
      const pin = pinnacle() || {};
      const sharpJob = pin.on ? fetchPinnacle(http, pin.key).catch(e => { errors.push({ source: 'pinnacle', key: 'esports', message: e.message }); return []; }) : Promise.resolve([]);
      const [pm, kalshi, book, sharp] = await Promise.all([Promise.all(pmJobs).then(x => x.flat()), Promise.all(kalshiJobs).then(x => x.flat()), bookJob, sharpJob]);
      const merged = mergeSources({ pm, kalshi, book, sharp }, o);
      const matches = buildBoard(merged, { elo: ratings() || {}, moves, now: t0, opts: o, calib: state.calibration });
      const byGame = {};
      for (const m of matches) byGame[m.game] = (byGame[m.game] || 0) + 1;
      Object.assign(state, {
        matches, updated: new Date(t0).toISOString(), durationMs: now() - t0, errors: errors.slice(0, 20),
        counts: {
          matches: matches.length, byGame, polymarketEvents: pm.length, kalshiEvents: kalshi.length, bookMatches: book.length,
          both: matches.filter(m => m.links.kalshi && m.links.polymarket).length,
          withBook: matches.filter(m => m.markets.some(mk => mk.sources.includes('book'))).length,
          pinnacleMatches: sharp.length, withPinnacle: matches.filter(m => m.markets.some(mk => mk.sources.includes('pinnacle'))).length,
          edges: matches.reduce((x, m) => x + m.edges.length, 0), arbs: matches.reduce((x, m) => x + m.arbs.length, 0),
          rated: matches.filter(m => m.rating).length, tracked: moves.size(),
        },
      });
      log.log?.(`Esports board: ${matches.length} matches (${state.counts.both} on both exchanges, ${state.counts.edges} edges) in ${state.durationMs}ms`);
    } finally { state.running = false; }
    return state;
  }
  return { scan, state, moves };
}

module.exports = {
  bidPlan,
  GAMES, DEFAULTS, cleanName, sameTeam, orient, parsePmTitle, seriesScores, modelFor,
  parsePolymarketEvent, parseKalshiEvent, parseBo3Match, parsePinnacle, pinTeamKills, probit, devigPower, fetchPinnacle, mergeSources, priceMarket, buildBoard, createMoveTracker, fitScale, calibrate,
  createEsportsBoard, fetchPmSeries, PM_SERIES_FALLBACK,
};
