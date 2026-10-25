// ─── GEMINI PREDICTIONS: GAME LINES A TEXAN CAN TRADE ────────────────────────
// Gemini Predictions is a CFTC-regulated exchange open in every state,
// Texas included, with no sportsbook licence needed (10-19: its own site,
// defirate's and oddsassist's state pages). Its game contracts are $1 YES/NO
// pairs, and its public REST answers without a key:
//
//   GET https://api.gemini.com/v1/prediction-markets/events
//       ?status=active&sport=american_football&sports_market_type=moneyline
//       &sports_market_scope=full_contest&limit=500
//
// Each event names its teams (participants, full names, home/away) and start,
// and each contract carries prices.buy.yes / prices.buy.no (the price to buy
// either side now). Three kinds per game (ticker suffix):
//
//   -M  moneyline   one contract per team (sportsSide home / away)
//   -S  spread      "<team> wins by more than 2.5": YES is that team -2.5,
//                   NO is the other team +2.5, a rung per half line
//   -T  total       "More than 44.5 points scored": YES over, NO under
//
// The taker fee is 0.07 × p × (1 − p) a contract (gemini.com/fees/predictions,
// contracts listed from 2026-03-18), rounded up to the cent per order, so a
// side costs p plus that fee; the price here is that cost as American odds,
// for an order of 100 contracts or more (one contract at 50c pays 2c, not
// 1.75c). Out come freebooks' book games ({ book: 'gemini', home, away,
// start, h2h, spreads, totals }), merged onto Pinnacle's games beside FanDuel
// and BetRivers, so the +EV screen prices them against Pinnacle's no-vig and
// the main-lines tracker grades them on Pinnacle's close, at two minutes and
// on the result. mainLinesOnly keeps the spread and total rungs at Pinnacle's
// own main number: a rung Pinnacle only prices as an alternate, or not at
// all, is left off (the alt-lines and stale-lines failures came from closes
// that weren't Pinnacle's price at the venue's number).
//
// A lead, not a claim: no alerts, not in Best Plays, its own row on the
// record until 50 graded games and the raw-data re-check. A documented public
// API (not a scrape), so it reads by default like Kalshi's; GEMINI=off stops it.

const URL = 'https://api.gemini.com/v1/prediction-markets/events';
const TAKER_RATE = 0.07;
// Gemini's sport → its leagues (ticker prefix) → the free-books sport key
const SPORTS = ['american_football', 'basketball', 'hockey', 'baseball'];
const LEAGUES = { NFL: 'nfl', NCAAF: 'ncaaf', NBA: 'nba', WNBA: 'wnba', NHL: 'nhl', MLB: 'mlb' };

const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
// the cost of one contract bought at p, with the taker fee
const costOf = (p, rate = TAKER_RATE) => p + rate * p * (1 - p);
function american(cost) {
  if (!(cost > 0 && cost < 1)) return null;
  const d = 1 / cost;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
// a buyable side: a price between 2c and 98c
const side = p => { const x = num(p); return x != null && x >= 0.02 && x <= 0.98 ? x : null; };

function eventUrl({ sports = SPORTS, types = ['moneyline', 'spread', 'total'], limit = 500, offset = 0 } = {}) {
  const q = ['status=active', ...sports.map(s => `sport=${s}`), ...types.map(t => `sports_market_type=${t}`), 'sports_market_scope=full_contest', `limit=${limit}`, `offset=${offset}`];
  return `${URL}?${q.join('&')}`;
}

// "Anaheim vs New York R: Point Spread" names the away side first; a spread
// contract names a team by that short name. → 'home' | 'away' | null
function sideOf(short, ev) {
  const s = String(short || '').trim().toLowerCase();
  if (!s) return null;
  const parts = ev.participants || [];
  const hits = parts.filter(p => { const n = String(p.name || '').toLowerCase(); return n === s || n.startsWith(`${s} `) || n.startsWith(s); });
  if (hits.length === 1) return hits[0].side === 'home' || hits[0].side === 'away' ? hits[0].side : null;
  const t = /^(.+?)\s+vs\.?\s+(.+?)(?::|$)/i.exec(String(ev.title || ''));
  if (t) { if (t[1].trim().toLowerCase() === s) return 'away'; if (t[2].trim().toLowerCase() === s) return 'home'; }
  return null;
}

// payload(s) of /events → { nfl: [book games], … }. Events are deduped by id,
// nested ones (a moneyline event carries its spread and total) included.
function parseGemini(payloads, { now = Date.now(), rate = TAKER_RATE } = {}) {
  const evs = new Map();
  const add = e => { if (e && e.id != null && !evs.has(String(e.id))) evs.set(String(e.id), e); for (const x of e?.events || []) add(x); };
  for (const p of [].concat(payloads || [])) for (const e of p?.data || []) add(e);
  const games = new Map();
  for (const e of evs.values()) {
    const parts = String(e.ticker || '').split('-');
    const sport = LEAGUES[parts[0]];
    const kind = parts[parts.length - 1];
    if (!sport || !['M', 'S', 'T'].includes(kind) || (e.status && e.status !== 'active')) continue;
    if (e.sportsMarket?.scope?.type && e.sportsMarket.scope.type !== 'full_contest') continue;
    const start = ms(e.startTime);
    if (!(start > now)) continue;
    const home = (e.participants || []).find(p => p.side === 'home')?.name, away = (e.participants || []).find(p => p.side === 'away')?.name;
    if (!home || !away) continue;
    const key = e.gameId || parts.slice(0, -1).join('-');
    if (!games.has(key)) games.set(key, { sport, g: { book: 'gemini', eventId: `gem-${key}`, home, away, start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [], props: [], ladders: [], alts: [] } });
    const g = games.get(key).g;
    const open = (e.contracts || []).filter(c => !c.marketState || c.marketState === 'open');
    const cost = p => { const x = side(p); return x == null ? null : american(costOf(x, rate)); };
    if (kind === 'M') {
      if (open.some(c => c.sportsSide === 'tie') || g.h2h.length) continue;   // three-way: not a two-way moneyline
      const h = open.find(c => c.sportsSide === 'home'), a = open.find(c => c.sportsSide === 'away');
      if (!h || !a) continue;
      // home wins: home's YES or away's NO, whichever is cheaper
      const best = (...ps) => { const xs = ps.map(side).filter(x => x != null); return xs.length ? Math.min(...xs) : null; };
      const ph = best(h.prices?.buy?.yes, a.prices?.buy?.no), pa = best(a.prices?.buy?.yes, h.prices?.buy?.no);
      if (ph == null || pa == null) continue;
      g.h2h.push({ name: home, price: american(costOf(ph, rate)) }, { name: away, price: american(costOf(pa, rate)) });
    } else if (kind === 'S') {
      for (const c of open) {
        const m = /^(.+?)\s+wins by more than\s+([\d.]+)/i.exec(String(c.label || ''));
        const x = num(c.strike?.value) ?? (m ? num(m[2]) : null);
        const who = m ? sideOf(m[1], e) : null;
        const yes = cost(c.prices?.buy?.yes), no = cost(c.prices?.buy?.no);
        if (!who || x == null || !(x > 0) || yes == null || no == null) continue;
        // YES: `who` gives x; NO: the other side gets x
        const fav = who === 'home' ? home : away, dog = who === 'home' ? away : home;
        const homePt = who === 'home' ? -x : x;
        if (g.spreads.some(o => o.name === home && o.point === homePt)) continue;
        g.spreads.push({ name: fav, price: yes, point: -x }, { name: dog, price: no, point: x });
      }
    } else {
      for (const c of open) {
        if (c.strike?.type && c.strike.type !== 'over') continue;
        const x = num(c.strike?.value);
        const over = cost(c.prices?.buy?.yes), under = cost(c.prices?.buy?.no);
        if (x == null || over == null || under == null || g.totals.some(o => o.point === x)) continue;
        g.totals.push({ name: 'Over', price: over, point: x }, { name: 'Under', price: under, point: x });
      }
    }
  }
  const out = Object.fromEntries(Object.values(LEAGUES).map(s => [s, []]));
  for (const { sport, g } of games.values()) if (g.h2h.length || g.spreads.length || g.totals.length) out[sport].push(g);
  return out;
}

// merged games (freebooks.mergeGames) + Pinnacle's games → the same games with
// Gemini's spread and total rungs cut to Pinnacle's main number. The
// moneyline stays. A Gemini bookmaker left with nothing is dropped.
function mainLinesOnly(gamesBySport, pinGames) {
  const pin = new Map((pinGames || []).map(pg => [`pin-${pg.id}`, pg]));
  const out = {};
  for (const [s, games] of Object.entries(gamesBySport || {})) {
    out[s] = (games || []).map(g => {
      const bm = (g.bookmakers || []).find(b => b.key === 'gemini');
      const pg = pin.get(g.id);
      if (!bm) return g;
      const homePts = new Set((pg?.spreads || []).filter(x => !x.alt).map(x => x.home));
      const lines = new Set((pg?.totals || []).filter(x => !x.alt).map(x => x.line));
      const markets = bm.markets.map(m => {
        if (m.key === 'spreads') return { ...m, outcomes: m.outcomes.filter(o => homePts.has(o.name === g.home_team ? o.point : -o.point)) };
        if (m.key === 'totals') return { ...m, outcomes: m.outcomes.filter(o => lines.has(o.point)) };
        return m;
      }).filter(m => m.outcomes.length);
      const rest = g.bookmakers.filter(b => b !== bm);
      return { ...g, bookmakers: markets.length ? [...rest, { ...bm, markets }] : rest };
    });
  }
  return out;
}

// → { books: { nfl: [book games], … }, events, errors }
async function fetchGemini(http, { now = Date.now(), pages = 4 } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const payloads = [], errors = [];
  for (let i = 0; i < pages; i++) {
    try {
      const d = (await http.get(eventUrl({ offset: i * 500 }), { headers, timeout: 30000 }))?.data;
      payloads.push(d);
      if (!d?.data?.length || (d.pagination && (i + 1) * 500 >= d.pagination.total)) break;
    } catch (e) { errors.push(`gemini: ${e.response?.status || e.message}`); break; }
  }
  return { books: parseGemini(payloads, { now }), events: payloads.reduce((n, p) => n + (p?.data?.length || 0), 0), errors };
}

module.exports = { URL, TAKER_RATE, SPORTS, LEAGUES, costOf, american, eventUrl, sideOf, parseGemini, mainLinesOnly, fetchGemini };
