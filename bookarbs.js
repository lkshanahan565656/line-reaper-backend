// ─── BOOK ARBS AND MIDDLES ────────────────────────────────────────────────────
// The ARBS tab's own scans are exchange against exchange (xarb.js), and a live
// census of those found nothing fillable (2026-10-14). The soft prices are at
// the sportsbooks, and since PR 148 the free feeds carry FanDuel's and
// BetRivers' alternate spreads, totals and player ladders as well as their
// main lines. This pairs every price a US bettor can take on one game:
//
//   FanDuel, BetRivers   main and alternate spreads and totals, moneylines,
//                        two-way player props and one-way "N+" ladders
//   Kalshi               game contracts (YES or NO, taker fee in) and player
//                        prop rungs ("5+" is over 4.5; NO is the under)
//   Polymarket US        game contracts, its taker fee in
//
// Each price is a bet that wins when one number (the home side's margin, the
// total, a player's stat) lands above a line ("up") or below one ("down").
// One up bet at line a and one down bet at line b with b ≥ a cover every
// outcome, so one of them always pays:
//
//   arb      the two cost under $1 for every $1 either pays: locked profit
//            (and when b > a, both pay if it lands between them)
//   middle   they cost more than $1, but both pay when it lands between a
//            and b, often enough (Pinnacle's ladder says how often) to be
//            worth it. The worst case is the miss.
//
// A pair needs at least one sportsbook leg: exchange against exchange is
// xarb.js's. Exchange legs carry the size resting at the price (the server
// reads the books, fillable()); sportsbook limits aren't in their feeds.
// Pure functions; bookarbtrack.js logs each row and checks both legs again two
// minutes on.

const { canonName } = require('./ev');
const { pOver, meanFor } = require('./sportprops');
const { gamePoints, propLines, ladderAt, SD } = require('./altlines');
const { kalshiFee } = require('./exchanges');

const DEFAULTS = {
  maxArbPct: 12,      // past this a "locked" return is a bad match or a stale line, not money
  minMiddleEv: 1,     // percent, average return on a middle
  maxMiddleEv: 25,
  maxGapSd: 0.6,      // a middle's window at most this many of the stat's sd wide
  minMissPct: -12,    // and its worst case no worse than this: past it the pair is two
                      // bets priced on the curve's tails, not a middle
  perSubject: 2,      // rows kept per game line or player stat, of each type
  max: 120,
  matchMs: 6 * 3600e3,   // a Kalshi prop rung's game starts within this of the books'
  pmusFeeRate: 0.0695,
  stake: 100,         // the reference size a fill check asks for (both legs together)
};
const BOOKS = new Set(['fanduel', 'betrivers']);
const EXCHANGES = new Set(['kalshi', 'polymarketus']);
const NAMES = { fanduel: 'FanDuel', betrivers: 'BetRivers', kalshi: 'Kalshi', polymarketus: 'Polymarket US' };
// a stat's player-prop sd, for how wide a middle may be (else the sport's game sd)
// (freebooks' stat keys; a stat not listed gets no middles)
const PROP_SD = { pass_yds: 45, rush_yds: 22, rec_yds: 22, rush_rec_yds: 25, pass_rush_yds: 45, receptions: 1.8, pass_completions: 4, pass_attempts: 5,
  points: 6, rebounds: 2.8, assists: 2.2, threes: 1.3, pra: 8, shots_on_goal: 1.3, saves: 5, strikeouts: 1.8, hits: 0.9, total_bases: 1.4 };

const { r2, r4, num } = require('./mathutil');
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const half = x => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
const toDecimal = a => (a > 0 ? 1 + a / 100 : a < 0 ? 1 + 100 / -a : null);
const signed = x => `${x > 0 ? '+' : ''}${x}`;
const gid = id => String(id ?? '').replace(/^pin-/, '');

// an exchange contract's all-in cost per $1 it pays, at `ask`
function exchangeCost(venue, ask, o = DEFAULTS) {
  if (!(ask > 0 && ask < 1)) return null;
  if (venue === 'kalshi') return r4(ask + kalshiFee(ask, 100) / 100);
  if (venue === 'polymarketus') return r4(ask + o.pmusFeeRate * ask * (1 - ask));
  return null;
}

// ── subjects: one number per game line or player stat ──
// spread: the home side's margin (home −3.5 is up at 3.5, away +3.5 down at
// 3.5); total: the points (over up, under down); moneyline: the home margin
// at 0; prop: the player's stat.
function subjectFor(game, kind, extra = {}) {
  return { key: `${gid(game.id)}|${kind}${extra.player ? `|${canonName(extra.player)}|${extra.mkey}` : ''}`, kind, sport: game.sport, league: game.league,
    title: `${game.away_team} @ ${game.home_team}`, home: game.home_team, away: game.away_team, start: game.commence_time, ...extra };
}
function labelOf(s, dir, at) {
  if (s.kind === 'ml') return `${dir === 'up' ? s.home : s.away} to win`;
  if (s.kind === 'total') return `${dir === 'up' ? 'Over' : 'Under'} ${at}`;
  if (s.kind === 'spread') return dir === 'up' ? `${s.home} ${signed(-at)}` : `${s.away} ${signed(at)}`;
  return `${s.player} ${dir === 'up' ? 'over' : 'under'} ${at} ${String(s.mkey || '').replace(/^player_/, '').replace(/_/g, ' ')}`;
}

// Every price on the free books' games, plus the exchange rows the line shop
// keyed to the same Pinnacle games (bigmoney.gameIndex rows) and Kalshi's
// prop rungs (bigmoney.rungIndex). → Map subject key → { subject, quotes }
// quote: { venue, dir, at, cost, american | price, url, marketId, side, yesSide }
function collect({ gamesBySport = {}, exchangeRows = null, kalshiRungs = null, leagueOf = s => s.toUpperCase(), now = Date.now(), o = DEFAULTS } = {}) {
  const subjects = new Map();
  const games = new Map();
  const propSubjects = new Map();   // `${league}|${canon}|${mkey}` → [{ key, t }]
  const add = (s, q) => {
    if (!(q.cost > 0 && q.cost < 1)) return;
    if (s.kind !== 'ml' && !half(q.at)) return;
    if (!subjects.has(s.key)) subjects.set(s.key, { subject: s, quotes: new Map() });
    const quotes = subjects.get(s.key).quotes;
    const k = `${q.venue}|${q.dir}|${q.at}`;
    const old = quotes.get(k);
    if (!old || q.cost < old.cost) quotes.set(k, { ...q, label: labelOf(s, q.dir, q.at) });
  };
  for (const [sport, list] of Object.entries(gamesBySport || {})) {
    const league = leagueOf(sport);
    for (const g0 of list || []) {
      if (!(ms(g0.commence_time) > now)) continue;
      const g = { ...g0, sport, league };
      games.set(gid(g.id), g);
      const sub = { ml: subjectFor(g, 'ml'), spreads: subjectFor(g, 'spread'), totals: subjectFor(g, 'total') };
      for (const bm of g.bookmakers || []) {
        if (!BOOKS.has(bm.key)) continue;
        const book = (s, dir, at, price, url) => {
          const d = toDecimal(num(price));
          if (d) add(s, { venue: bm.key, dir, at, cost: r4(1 / d), american: num(price), url: url || bm.link || null });
        };
        const line = (key, x, url) => {
          if (key === 'h2h') { if (x.name === g.home_team) book(sub.ml, 'up', 0, x.price, url); else if (x.name === g.away_team) book(sub.ml, 'down', 0, x.price, url); return; }
          const p = num(x.point);
          if (p == null) return;
          if (key === 'totals') { if (/^over$/i.test(x.name)) book(sub.totals, 'up', p, x.price, url); else if (/^under$/i.test(x.name)) book(sub.totals, 'down', p, x.price, url); }
          else if (key === 'spreads') { if (x.name === g.home_team) book(sub.spreads, 'up', -p, x.price, url); else if (x.name === g.away_team) book(sub.spreads, 'down', p, x.price, url); }
        };
        for (const m of bm.markets || []) {
          if (m.key === 'h2h' && (m.outcomes || []).length !== 2) continue;
          if (/^(h2h|spreads|totals)$/.test(m.key)) { for (const x of m.outcomes || []) line(m.key, x, x.link); continue; }
          // two-way player props
          for (const x of m.outcomes || []) {
            const p = num(x.point);
            if (!x.description || p == null) continue;
            const s = subjectFor(g, 'prop', { player: x.description, mkey: m.key });
            if (/^over$/i.test(x.name)) book(s, 'up', p, x.price, x.link); else if (/^under$/i.test(x.name)) book(s, 'down', p, x.price, x.link);
            noteProp(s);
          }
        }
        for (const a of bm.altLines || []) line(a.kind, a);
        for (const r of bm.ladders || []) { const s = subjectFor(g, 'prop', { player: r.player, mkey: r.mkey }); book(s, 'up', r.line, r.price); noteProp(s); }
      }
    }
  }
  function noteProp(s) {
    const k = `${s.league}|${canonName(s.player)}|${s.mkey}`;
    if (!propSubjects.has(k)) propSubjects.set(k, []);
    const list = propSubjects.get(k);
    if (!list.some(x => x.key === s.key)) list.push({ key: s.key, t: ms(s.start), s });
  }
  // exchange game contracts keyed to Pinnacle's games: `${id}|spread|${homePts}|home`
  for (const e of exchangeRows ? (exchangeRows instanceof Map ? exchangeRows.values() : exchangeRows) : []) {
    const row = e.row, venue = row?.exchange;
    if (!EXCHANGES.has(venue) || !row.tradable) continue;
    const g = games.get(gid(e.game?.id));
    if (!g) continue;
    for (const [side, key] of [['yes', e.yes], ['no', e.no]]) {
      if (!key) continue;
      const p = key.split('|'), kind = p[1], dirSide = p[p.length - 1];
      let s, dir, at;
      if (kind === 'ml') { s = subjectFor(g, 'ml'); dir = dirSide === 'home' ? 'up' : 'down'; at = 0; }
      else if (kind === 'total') { s = subjectFor(g, 'total'); dir = dirSide === 'over' ? 'up' : 'down'; at = Number(p[2]); }
      else if (kind === 'spread') { s = subjectFor(g, 'spread'); dir = dirSide === 'home' ? 'up' : 'down'; at = -Number(p[2]); }
      else continue;
      const ask = side === 'yes' ? row.yesAsk : row.noAsk;
      add(s, { venue, dir, at, cost: exchangeCost(venue, ask, o), price: ask, url: row.url || null, marketId: row.id, side, ...(row.yesSide ? { yesSide: row.yesSide } : {}) });
    }
  }
  // Kalshi player rungs: YES is the over at the rung's line, NO the under
  for (const r of kalshiRungs ? (kalshiRungs instanceof Map ? kalshiRungs.values() : kalshiRungs) : []) {
    const t = ms(r.start);
    const cands = (propSubjects.get(`${r.league}|${canonName(r.player)}|${r.mkey}`) || []).filter(x => t == null || x.t == null || Math.abs(x.t - t) <= o.matchMs);
    if (cands.length !== 1) continue;
    const s = cands[0].s;
    const yesAsk = num(r.yesAsk), yesBid = num(r.yesBid);
    if (yesAsk != null) add(s, { venue: 'kalshi', dir: 'up', at: r.line, cost: exchangeCost('kalshi', yesAsk, o), price: yesAsk, url: r.url || null, marketId: r.ticker, side: 'yes' });
    if (yesBid != null && yesBid > 0) add(s, { venue: 'kalshi', dir: 'down', at: r.line, cost: exchangeCost('kalshi', r4(1 - yesBid), o), price: r4(1 - yesBid), url: r.url || null, marketId: r.ticker, side: 'no' });
  }
  return { subjects, games };
}

// P(number > a) for one subject off Pinnacle (its game ladder, or its prop
// read on the stat's curve), or null where Pinnacle has nothing to go on
const propCache = new WeakMap();
function aboveFn(s, game) {
  const pin = (game?.bookmakers || []).find(b => b.key === 'pinnacle');
  if (!pin) return null;
  if (s.kind === 'spread' || s.kind === 'total') {
    const key = s.kind === 'spread' ? 'spreads' : 'totals';
    const pts = gamePoints(pin, key, s.home);
    if (!pts.length) return null;
    const sd = (SD[s.sport] || [12, 12])[s.kind === 'total' ? 1 : 0];
    // spreads: x = home points, p = P(home covers) = P(margin > −x); totals: x = −line, p = P(over)
    return a => { const r = ladderAt(pts, -a, sd); return r ? r.p : null; };
  }
  if (s.kind === 'prop') {
    if (!propCache.has(pin)) propCache.set(pin, propLines(pin));
    const q = propCache.get(pin).get(`${canonName(s.player)}|${s.mkey}`);
    if (!q) return null;
    const mean = meanFor(s.mkey, s.league, q.line, q.p);
    return mean == null ? null : a => pOver(s.mkey, s.league, mean, a);
  }
  return null;
}
const widthSd = s => (s.kind === 'prop' ? PROP_SD[s.mkey] ?? null : (SD[s.sport] || [12, 12])[s.kind === 'total' ? 1 : 0]);

// legs → a row: an arb (cost < 1) or a middle (worth it on Pinnacle's odds)
function pairRow(entry, up, down, above, o) {
  const s = entry.subject;
  const cost = r4(up.cost + down.cost);
  const gap = r2(down.at - up.at);
  const lo = Math.floor(up.at) + 1, hi = Math.ceil(down.at) - 1;
  const window = gap > 0 && hi >= lo ? { lo, hi } : null;
  let hitProb = null;
  if (window && above) { const a = above(up.at), b = above(down.at); if (a != null && b != null) hitProb = r4(Math.max(0, a - b)); }
  const type = cost < 1 ? 'arb' : 'middle';
  const missPct = r2(((1 - cost) / cost) * 100);
  const hitPct = window ? r2(((2 - cost) / cost) * 100) : null;
  const evPct = hitProb != null ? r2(((1 + hitProb) / cost - 1) * 100) : type === 'arb' ? missPct : null;
  if (type === 'arb' && missPct > o.maxArbPct) return null;
  if (type === 'middle') {
    const sd = widthSd(s);
    if (!window || hitProb == null || evPct == null || evPct < o.minMiddleEv || evPct > o.maxMiddleEv || !sd || gap > o.maxGapSd * sd || missPct < o.minMissPct) return null;
  }
  const legs = [up, down].map(q => ({
    venue: q.venue, venueTitle: NAMES[q.venue] || q.venue, pick: q.label, dir: q.dir, at: q.at, cost: q.cost, pct: r2((q.cost / cost) * 100),
    ...(q.american != null ? { american: q.american } : {}), ...(q.price != null ? { price: q.price } : {}),
    url: q.url || null, ...(q.marketId ? { marketId: q.marketId, side: q.side } : {}), ...(q.yesSide ? { yesSide: q.yesSide } : {}),
    qkey: `${s.key}|${q.venue}|${q.dir}|${q.at}`,
  }));
  const venues = [...new Set(legs.map(l => l.venue))].sort();
  const warnings = [];
  // where both pay, in words: "the total is 42 to 47", "Raiders win by 4 to 6"
  let windowText = null;
  if (window) {
    const span = (a, b) => (a === b ? `${a}` : `${a} to ${b}`);
    if (s.kind === 'total') windowText = `the total is ${span(window.lo, window.hi)}`;
    else if (s.kind === 'spread') windowText = window.hi < 0 ? `${s.away} win by ${span(-window.hi, -window.lo)}` : window.lo > 0 ? `${s.home} win by ${span(window.lo, window.hi)}` : `the margin is ${span(window.lo, window.hi)}`;
    else if (s.kind === 'prop') windowText = `${s.player} gets ${span(window.lo, window.hi)} ${String(s.mkey).replace(/^player_/, '').replace(/_/g, ' ')}`;
  }
  if (s.kind === 'ml' && /^(nfl|ncaaf)$/.test(s.sport)) warnings.push('tie');
  if (s.kind === 'prop' && legs.some(l => EXCHANGES.has(l.venue))) warnings.push('inactive');
  return {
    id: `bookarb:${type}:${legs.map(l => l.qkey).join('+')}`, type, kind: s.kind, sport: s.sport, league: s.league, title: s.title, start: s.start,
    subject: s.kind === 'prop' ? `${s.player} ${String(s.mkey).replace(/^player_/, '').replace(/_/g, ' ')}` : s.kind === 'total' ? 'the total' : s.kind === 'spread' ? `${s.home}'s margin` : null,
    player: s.player || null, mkey: s.mkey || null, low: up.at, high: down.at, gap, window, windowText, hitProb, legs, totalCost: cost,
    stakes: { legs: legs.map(l => ({ pct: l.pct })) },
    profitPct: type === 'arb' ? missPct : null, missPct, hitPct, evPct, pair: venues.join('+'), books: legs.filter(l => BOOKS.has(l.venue)).length, warnings,
  };
}

// collect() → { arbs, middles, counts }
function find(collected, { now = Date.now(), o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { subjects, games } = collected;
  const arbs = [], middles = [];
  const counts = { subjects: subjects.size, quotes: 0, pairs: 0, arbs: 0, middles: 0, tooGood: 0, byVenue: {} };
  for (const entry of subjects.values()) {
    const qs = [...entry.quotes.values()];
    counts.quotes += qs.length;
    for (const q of qs) counts.byVenue[q.venue] = (counts.byVenue[q.venue] || 0) + 1;
    const ups = qs.filter(q => q.dir === 'up'), downs = qs.filter(q => q.dir === 'down');
    if (!ups.length || !downs.length) continue;
    let above;   // Pinnacle's curve for this subject, read once on first need
    const curve = () => (above === undefined ? (above = aboveFn(entry.subject, games.get(entry.subject.key.split('|')[0])) || null) : above);
    const mine = { arb: [], middle: [] };
    for (const u of ups) for (const d of downs) {
      if (d.at < u.at || u.venue === d.venue) continue;
      if (!BOOKS.has(u.venue) && !BOOKS.has(d.venue)) continue;   // exchange against exchange is xarb's
      counts.pairs++;
      const c = u.cost + d.cost;
      if (c >= 1 && d.at === u.at) continue;
      const row = pairRow(entry, u, d, d.at > u.at ? curve() : null, o);
      if (!row) { if (c < 1) counts.tooGood++; continue; }
      mine[row.type].push(row);
    }
    mine.arb.sort((a, b) => b.profitPct - a.profitPct || (b.hitProb || 0) - (a.hitProb || 0));
    mine.middle.sort((a, b) => b.evPct - a.evPct);
    arbs.push(...mine.arb.slice(0, o.perSubject));
    middles.push(...mine.middle.slice(0, o.perSubject));
  }
  counts.arbs = arbs.length; counts.middles = middles.length;
  arbs.sort((a, b) => b.profitPct - a.profitPct);
  middles.sort((a, b) => b.evPct - a.evPct);
  return { arbs: arbs.slice(0, o.max), middles: middles.slice(0, o.max), counts, at: new Date(now).toISOString() };
}

// What an exchange leg can fill: contracts resting at or under its shown
// price, and (for an arb) how many more keep the pair under $1 walking up the
// book. asks: [[price, contracts]] (execcheck.kalshiAsks / pmusAsks).
// → { atPrice, contracts, maxStake } (maxStake: both legs together, dollars)
function fillable(row, leg, asks = [], o = DEFAULTS) {
  const other = row.legs.find(l => l !== leg);
  let atPrice = 0, contracts = 0, spent = 0;
  for (const [p, n] of [...asks].sort((a, b) => a[0] - b[0])) {
    if (!(p > 0 && p < 1 && n > 0)) continue;
    if (p <= (leg.price ?? 0) + 1e-9) atPrice += n;
    const c = exchangeCost(leg.venue, p, o);
    const ok = row.type === 'arb' ? c + other.cost < 1 : p <= (leg.price ?? 0) + 1e-9;
    if (!ok) break;
    contracts += n; spent += n * (c + other.cost);
  }
  return { atPrice: Math.floor(atPrice), contracts: Math.floor(contracts), maxStake: Math.round(spent) };
}

// the exchange legs whose books a scan should read, best rows first
function legsToRead(rows = [], max = 20) {
  const out = [], seen = new Set();
  for (const r of rows) for (const l of r.legs) {
    if (!EXCHANGES.has(l.venue) || !l.marketId || seen.has(`${l.venue}:${l.marketId}`)) continue;
    seen.add(`${l.venue}:${l.marketId}`);
    out.push(l);
    if (out.length >= max) return out;
  }
  return out;
}

// the current scan's costs by leg (qkey) → for the two-minute check
function quoteIndex(collected) {
  const out = new Map();
  for (const entry of collected.subjects.values()) for (const q of entry.quotes.values()) out.set(`${entry.subject.key}|${q.venue}|${q.dir}|${q.at}`, q);
  return out;
}

// counts for the status page and the reply
function summarize(found) {
  const by = (rows, f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] || 0) + 1), m), {});
  const med = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const { arbs = [], middles = [] } = found || {};
  return { ...found?.counts, arbs: arbs.length, middles: middles.length, arbPairs: by(arbs, r => r.pair), middlePairs: by(middles, r => r.pair), arbKinds: by(arbs, r => r.kind), middleKinds: by(middles, r => r.kind),
    medianArbPct: med(arbs.map(r => r.profitPct)), medianMiddleEv: med(middles.map(r => r.evPct)), medianMiddleMiss: med(middles.map(r => r.missPct)) };
}

module.exports = { DEFAULTS, NAMES, BOOKS, EXCHANGES, exchangeCost, collect, aboveFn, pairRow, find, fillable, legsToRead, quoteIndex, summarize, labelOf };
