// ─── KALSHI PLAYER PROPS AS THE SHARP LINE FOR PICK'EM APPS ──────────────────
// Kalshi lists player stat ladders ("Logan Henderson: 6+ strikeouts?", one
// market per rung). A rung's yes price is the market's probability the player
// goes over that number, with no sportsbook vig in it. That prices Underdog's
// More/Less lines for free, no Odds API key needed.
//
// Each Underdog line is matched to a ladder for the same player and stat in a
// game that settles within hours of the line's start. The line must sit on a
// rung, or between two close rungs (a 54.5 between 49.5 and 59.5 yards), where
// the probability is read off a straight line between them. Rungs with a wide
// or empty book are skipped: a one-sided quote is not a price.
//
// Output is games in the props shape ev.js reads (books[].props[]), under the
// book key `kalshi_props`, so the existing screener scores the Underdog legs.

const { canonName, canonMarket, probToAmerican } = require('./ev');

const KALSHI_EVENTS = 'https://api.elections.kalshi.com/trade-api/v2/events';
// Ladder series by league. Tickers Kalshi doesn't list just come back empty.
const SERIES = {
  MLB: ['KXMLBKS', 'KXMLBHITS', 'KXMLBTB', 'KXMLBHR', 'KXMLBRBI'],
  NFL: ['KXNFLRECYDS', 'KXNFLRSHYDS', 'KXNFLPASSYDS', 'KXNFLREC', 'KXNFLPASSTDS'],
  NBA: ['KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBA3PT'],
  WNBA: ['KXWNBAPTS', 'KXWNBAREB', 'KXWNBAAST'],
  NHL: ['KXNHLGOAL', 'KXNHLSOG', 'KXNHLPTS', 'KXNHLAST'],
};
const DEFAULTS = {
  maxSpread: 0.06,      // widest yes bid/ask gap we treat as a price
  minProb: 0.03,        // rungs priced near 0 or 1 carry no information
  matchWindowMs: 10 * 3600e3,   // a game settles within this long after it starts
};
const num = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };

// "Amon-Ra St. Brown: 50+ receiving yards" → { player, stat }
function parseRung(title) {
  const m = /^(.+?):\s*\d+(?:\.\d+)?\+\s*(.+?)\??$/.exec(String(title || '').trim());
  return m ? { player: m[1].trim(), stat: m[2].trim() } : null;
}

// One Kalshi event → ladders keyed by player|stat: [{ strike, p }] ascending
function laddersFromEvent(ev, o = DEFAULTS, now = Date.now()) {
  const out = new Map();
  for (const mk of ev.markets || []) {
    if (mk.strike_type !== 'greater' || mk.status && !/^(active|open|initialized)$/.test(mk.status)) continue;
    const strike = num(mk.floor_strike);
    const settles = Date.parse(mk.expected_expiration_time || '');
    if (strike == null || !(settles > now)) continue;
    const r = parseRung(mk.title || mk.yes_sub_title);
    if (!r) continue;
    const bid = num(mk.yes_bid_dollars), ask = num(mk.yes_ask_dollars);
    if (!(bid > 0) || !(ask < 1) || !(ask > bid) || ask - bid > o.maxSpread) continue;
    const p = (bid + ask) / 2;
    if (p < o.minProb || p > 1 - o.minProb) continue;
    const key = `${canonName(r.player)}|${canonMarket(r.stat)}`;
    if (!out.has(key)) out.set(key, { player: r.player, market: canonMarket(r.stat), settles, rungs: [] });
    out.get(key).rungs.push({ strike, p, ticker: mk.ticker });
  }
  for (const l of out.values()) l.rungs.sort((a, b) => a.strike - b.strike);
  return out;
}

// P(over line) from a ladder: on a rung, or between two close rungs
function probAt(rungs, line) {
  const on = rungs.find(r => Math.abs(r.strike - line) < 1e-6);
  if (on) return { p: on.p, interpolated: false };
  for (let i = 0; i + 1 < rungs.length; i++) {
    const a = rungs[i], b = rungs[i + 1];
    if (a.strike < line && line < b.strike) {
      if (b.strike - a.strike > Math.max(1.01, 0.25 * line)) return null;
      if (b.p > a.p) return null;   // a ladder that rises with the strike is a stale quote
      const t = (line - a.strike) / (b.strike - a.strike);
      return { p: a.p + t * (b.p - a.p), interpolated: true };
    }
  }
  return null;
}

// Kalshi events + Underdog lines → props-shape games for the EV screener
function buildGames(events, dfsLines, o = DEFAULTS, now = Date.now()) {
  const ladders = [];
  for (const { ev, league } of events) {
    for (const l of laddersFromEvent(ev, o, now).values()) ladders.push({ ...l, ev, league });
  }
  const byKey = new Map();
  for (const l of ladders) {
    const k = `${canonName(l.player)}|${l.market}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }
  const games = new Map();
  let matched = 0, interpolated = 0;
  for (const d of dfsLines) {
    const start = Date.parse(d.startTime || '');
    const line = Number(d.line);
    if (!(start > now) || !Number.isFinite(line) || Number.isInteger(line)) continue;   // whole-number lines can push
    const cands = byKey.get(`${canonName(d.player)}|${canonMarket(d.market)}`) || [];
    const lad = cands.find(l => l.settles > start && l.settles - start < o.matchWindowMs);
    if (!lad) continue;
    const at = probAt(lad.rungs, line);
    if (!at) continue;
    matched++;
    if (at.interpolated) interpolated++;
    const gid = lad.ev.event_ticker;
    if (!games.has(gid)) {
      const [away, home] = String(lad.ev.title || '').replace(/:.*$/, '').split(/\s+(?:vs\.?|at|@)\s+/i);
      games.set(gid, {
        id: gid, sport_key: lad.league, commence_time: new Date(start).toISOString(),
        ...(away && home ? { away_team: away.trim(), home_team: home.trim() } : {}),
        books: [{ key: 'kalshi_props', props: [] }],
      });
    }
    const props = games.get(gid).books[0].props;
    if (props.some(p => canonName(p.player) === canonName(d.player) && p.market === lad.market && p.line === line)) continue;
    props.push({ player: d.player, market: lad.market, line, overPrice: probToAmerican(at.p), underPrice: probToAmerican(1 - at.p), interpolated: at.interpolated });
  }
  return { games: [...games.values()], counts: { ladders: ladders.length, matched, interpolated } };
}

// Polite fetch of every ladder series → [{ ev, league }]
async function fetchEvents(http, series = SERIES) {
  const out = [], errors = [];
  for (const [league, tickers] of Object.entries(series)) {
    for (const t of tickers) {
      try {
        const res = await http.get(KALSHI_EVENTS, { params: { series_ticker: t, status: 'open', with_nested_markets: true, limit: 200 }, timeout: 20000 });
        for (const ev of res?.data?.events || []) out.push({ ev, league });
      } catch (e) { errors.push(`${t}: ${e.response?.status || e.message}`); }
    }
  }
  return { events: out, errors };
}

module.exports = { SERIES, DEFAULTS, parseRung, laddersFromEvent, probAt, buildGames, fetchEvents };
