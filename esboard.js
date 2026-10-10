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

const { teamsMatch, mapToSeriesProb, devig } = require('./context');
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
  pairHours: 3,           // sources' start times within this are the same match
  lookbackHours: 8,       // keep matches that started this long ago (live)
  aheadDays: 10,
  feeLot: 100,            // Kalshi's fee rounds up per order: quoted on 100 contracts
  kalshiFeeRate: 0.07,
};

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
function mergeSources({ pm = [], kalshi = [], book = [] } = {}, opts = {}) {
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
  for (const m of list) {
    m.id = `${m.game}:${m.teams.map(t => cleanName(t).toLowerCase().replace(/[^a-z0-9]+/g, '')).join('-')}:${m.start ? new Date(m.start).toISOString().slice(0, 10) : 'tbd'}`;
  }
  return list;
}

// ── prices ──
// a venue's probability for outcome 0 from tight two-sided quotes
function venueProb(market, venue, o) {
  const [a, b] = market.outcomes.map(x => x.quotes[venue]);
  if (venue === 'book') return a?.prob ?? null;
  const mid = q => (q && q.bid != null && q.ask != null && q.ask - q.bid <= o.maxSpread + 1e-9 ? (q.bid + q.ask) / 2 : null);
  const ma = mid(a), mb = mid(b);
  if (ma != null && mb != null) return ma / (ma + mb);
  if (ma != null) return ma;
  if (mb != null) return 1 - mb;
  return null;
}
const VENUES = ['kalshi', 'polymarket', 'book'];
const TRADABLE = ['kalshi', 'polymarket'];
// fair price, model, best buy and edges for one market
function priceMarket(market, { model = null, start = null, now = Date.now(), opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const probs = {};
  for (const v of VENUES) { const p = venueProb(market, v, o); if (p != null) probs[v] = p; }
  const srcs = Object.keys(probs);
  const avg = list => (list.length ? list.reduce((x, v) => x + probs[v], 0) / list.length : null);
  const fair0 = avg(srcs);
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
      const ref0 = avg(refs);
      const refAgree = refs.length < 2 || Math.max(...refs.map(s => probs[s])) - Math.min(...refs.map(s => probs[s])) <= o.maxRefGap + 1e-9;
      const ref = ref0 == null ? null : (i === 0 ? ref0 : 1 - ref0);
      const ev = ref == null ? null : r4((ref - cost) / cost);
      q.cost = cost;
      q.ref = ref == null ? null : r4(ref);
      q.ev = ev;
      // a real bid close behind the ask (and close relative to the price: 3¢/6¢ is no market)
      const tight = q.bid != null && q.ask - q.bid <= Math.min(o.maxSpread, 0.35 * q.ask) + 1e-9;
      q.edge = ev != null && ev >= o.edgeMin && ref - cost >= o.minEdgeCents - 1e-9 && tight && refAgree
        && cost >= o.minCost && cost <= o.maxCost && (start == null || start > now) ? true : undefined;
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

// A map already played (or a total already over): someone bids 97¢+, or
// nobody quotes the other side above 3¢.
function decided(mk) {
  return mk.outcomes.some(oc => Object.values(oc.quotes).some(q => (q.bid != null && q.bid >= 0.97) || (q.ask != null && q.ask <= 0.03)));
}

// Price every market of every match; matches come out sorted by start.
function buildBoard(matches, { elo = {}, moves = null, now = Date.now(), opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  for (const m of matches) {
    const rating = elo[GAMES[m.game]?.elo];
    let p = null, ratingInfo = null;
    if (rating && rating.games(m.teams[0]) >= 8 && rating.games(m.teams[1]) >= 8) {
      p = rating.mapProb(m.teams[0], m.teams[1]);
      ratingInfo = { mapProb: r4(p), games: [rating.games(m.teams[0]), rating.games(m.teams[1])], ratings: [Math.round(rating.rating(m.teams[0])), Math.round(rating.rating(m.teams[1]))] };
    }
    const markets = [...m.markets.values()].filter(mk => mk.outcomes.some(oc => oc.quotes.kalshi || oc.quotes.polymarket) && !decided(mk));
    for (const mk of markets) {
      priceMarket(mk, { model: modelFor(mk, p, m.bestOf), start: m.start, now, opts: o });
      if (moves) {
        const key = `${m.id}|${mk.key}`;
        moves.note(key, mk.outcomes[0].fair, now);
        mk.move = moves.move(key, now);
      }
    }
    if (!markets.length) continue;
    const order = { match: 0, map: 1, total: 2, spread: 3 };
    markets.sort((a, b) => order[a.kind] - order[b.kind] || (a.n || 0) - (b.n || 0) || (a.line || 0) - (b.line || 0) || (a.team || 0) - (b.team || 0));
    const edges = [];
    for (const mk of markets) mk.outcomes.forEach(oc => TRADABLE.forEach(v => { if (oc.quotes[v]?.edge) edges.push({ market: mk.key, kind: mk.kind, outcome: oc.name, venue: v, cost: oc.quotes[v].cost, fair: oc.quotes[v].ref, ev: oc.quotes[v].ev }); }));
    edges.sort((a, b) => b.ev - a.ev);
    const main = markets.find(mk => mk.kind === 'match') || null;
    out.push({
      id: m.id, game: m.game, label: m.label, teams: m.teams, start: m.start ? new Date(m.start).toISOString() : null,
      live: !!m.live || (m.start != null && m.start <= now), bestOf: m.bestOf, tournament: m.tournament, links: m.links, slug: m.slug || null,
      volume: m.volume, rating: ratingInfo, markets, edges, arbs: markets.filter(mk => mk.arb).map(mk => ({ market: mk.key, ...mk.arb })),
      fair: main ? main.outcomes.map(oc => oc.fair) : null, move: main?.move || null,
    });
  }
  if (moves) moves.prune(now);
  return out.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
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
function createEsportsBoard({ http, log = console, ratings = () => ({}), opts = {}, now = () => Date.now(), emptySkipMs = 30 * 60e3, seriesTtlMs = 6 * 3600e3 } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const moves = createMoveTracker();
  const empty = new Map();
  let pmSeries = null, pmSeriesAt = 0;
  const state = { matches: [], updated: null, durationMs: null, running: false, errors: [], counts: null };
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
      const [pm, kalshi, book] = await Promise.all([Promise.all(pmJobs).then(x => x.flat()), Promise.all(kalshiJobs).then(x => x.flat()), bookJob]);
      const merged = mergeSources({ pm, kalshi, book }, o);
      const matches = buildBoard(merged, { elo: ratings() || {}, moves, now: t0, opts: o });
      const byGame = {};
      for (const m of matches) byGame[m.game] = (byGame[m.game] || 0) + 1;
      Object.assign(state, {
        matches, updated: new Date(t0).toISOString(), durationMs: now() - t0, errors: errors.slice(0, 20),
        counts: {
          matches: matches.length, byGame, polymarketEvents: pm.length, kalshiEvents: kalshi.length, bookMatches: book.length,
          both: matches.filter(m => m.links.kalshi && m.links.polymarket).length,
          withBook: matches.filter(m => m.markets.some(mk => mk.sources.includes('book'))).length,
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
  GAMES, DEFAULTS, cleanName, sameTeam, orient, parsePmTitle, seriesScores, modelFor,
  parsePolymarketEvent, parseKalshiEvent, parseBo3Match, mergeSources, priceMarket, buildBoard, createMoveTracker,
  createEsportsBoard, fetchPmSeries, PM_SERIES_FALLBACK,
};
