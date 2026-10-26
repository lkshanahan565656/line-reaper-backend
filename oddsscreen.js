// ─── ODDS SCREEN: EVERY PRICED VENUE ON ONE ROW, WITH PINNACLE'S FAIR ────────
// The screen OddsJam leads with, built on the free feeds the server already
// reads (freebooks.js): Pinnacle's game lines with the margin taken out are the
// fair; FanDuel and BetRivers (read direct), the US exchanges a Texan can trade
// (Kalshi, Polymarket US, Gemini; fees already in their prices), Matchbook (a
// sharp exchange, shown as a reference) and Action Network's copies of
// DraftKings, BetMGM, Caesars, bet365, Fanatics, Hard Rock and theScore
// (second-hand: a copy can be minutes old, so it is never a play on its own).
//
// One row per side of each game's moneyline, main spread and main total. The
// main number is Pinnacle's most even-priced line; a venue that hangs another
// number shows it with "line differs" and no EV, because a price at another
// number isn't the same bet.
//
// With a state picked (?state=TX) venues not legal there are dropped, ones no
// source vouches for are greyed (legal: 'unknown'), and only legal ones can be
// "best". Pinnacle's fair stays as the reference column: nobody bets it there.
//
// History: each side's fair and venue prices every few minutes while the game
// is upcoming (createHistory), so a row can draw its line movement. It rides
// the results backup through a deploy.
//
// Pure functions, no I/O.

const { devig, americanToDecimal, decimalToAmerican } = require('./ev');
const venues = require('./venues');
const venueLinks = require('./venuelinks');
const { SOFT_BOOKS, TITLES: XTITLES } = require('./xbooks');

const REFS = new Set(['pinnacle', 'matchbook']);
const SECOND_HAND = new Set(SOFT_BOOKS);
// column order: the sharp references, the exchanges, the books read direct, the copies
const ORDER = ['pinnacle', 'matchbook', 'kalshi', 'polymarketus', 'gemini', 'fanduel', 'betrivers', ...SOFT_BOOKS];
const NAME = k => venues.NAMES[k] || XTITLES[k] || k;
const LEAGUE_LABEL = {
  nfl: 'NFL', ncaaf: 'CFB', nba: 'NBA', wnba: 'WNBA', nhl: 'NHL', mlb: 'MLB', ncaab: 'CBB', epl: 'EPL', laliga: 'La Liga', bundesliga: 'Bundesliga',
  seriea: 'Serie A', ligue1: 'Ligue 1', mls: 'MLS', ligamx: 'Liga MX', eredivisie: 'Eredivisie', brasileirao: 'Brasileirao', ucl: 'Champions League',
  uel: 'Europa League', tennis: 'Tennis', ufc: 'UFC', khl: 'KHL', ahl: 'AHL', shl: 'SHL', kbo: 'KBO', npb: 'NPB',
};

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const probAmerican = p => (p > 0 && p < 1 ? decimalToAmerican(1 / p) : null);

// an outcome's page at its venue: the feed's own link, else the exact market
// page built from the outcome's exchange reference (a Polymarket US market
// slug, a Kalshi ticker); a venue with only a board link gets none here (the
// app links the board itself)
function linkOf(bm, o) {
  if (o.link || bm.link) return o.link || bm.link;
  if (!o.ref?.id) return null;
  const l = venueLinks.link(o.ref.venue || bm.key, { id: o.ref.id });
  return l && l.exact ? l.href : null;
}
// a bookmaker's outcomes for one market at one point: { sideName: american }
function pricesAt(bm, mkey, point, home) {
  const m = (bm.markets || []).find(x => x.key === mkey);
  if (!m) return null;
  const out = {};
  for (const o of m.outcomes || []) {
    const a = num(o.price);
    if (a == null || Math.abs(a) < 100) continue;
    if (mkey === 'h2h') out[o.name] = { american: a, url: linkOf(bm, o) };
    else if (mkey === 'spreads') {
      const hp = o.name === home ? num(o.point) : num(o.point) == null ? null : -num(o.point);
      if (hp === point) out[o.name] = { american: a, url: linkOf(bm, o) };
    } else if (num(o.point) === point) out[o.name] = { american: a, url: linkOf(bm, o) };
  }
  return Object.keys(out).length ? out : null;
}
// every point a bookmaker hangs for a spread (home's number) or total, most even first
function pointsOf(bm, mkey, home) {
  const m = (bm.markets || []).find(x => x.key === mkey);
  if (!m) return [];
  const by = new Map();
  for (const o of m.outcomes || []) {
    const p = num(o.point), a = num(o.price);
    if (p == null || a == null) continue;
    const k = mkey === 'spreads' ? (o.name === home ? p : -p) : p;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(americanToDecimal(a));
  }
  return [...by].filter(([, ds]) => ds.length === 2 && ds.every(d => d > 1))
    .map(([k, ds]) => ({ point: k, gap: Math.abs(1 / ds[0] - 1 / ds[1]) }))
    .sort((a, b) => a.gap - b.gap).map(x => x.point);
}

// One game (freebooks' Odds API shape) → its markets. kalshi: the game's
// Kalshi prices from bigmoney.gameIndex bets (key → venues).
function gameMarkets(g, { kalshi = null } = {}) {
  const home = g.home_team, away = g.away_team;
  const pin = (g.bookmakers || []).find(b => b.key === 'pinnacle');
  const books = (g.bookmakers || []).filter(b => b.key !== 'pinnacle' && ORDER.includes(b.key));
  const gid = String(g.id || '').replace(/^pin-/, '');
  const out = [];
  const kal = (key) => (kalshi?.get(key)?.venues || []).find(v => v.venue === 'kalshi') || null;

  // moneyline (two-way or soccer's three-way)
  const pinMl = pin && pricesAt(pin, 'h2h', null, home);
  const mlNames = pinMl ? Object.keys(pinMl) : [home, away];
  const three = mlNames.length === 3;
  const mlSides = three ? [home, 'Draw', away] : [home, away];
  out.push(market('ml', 'Moneyline', null, mlSides, pinMl, books.map(b => ({ key: b.key, prices: pricesAt(b, 'h2h', null, home) })),
    side => kal(`${gid}|${three ? 'ml3' : 'ml'}|${side === home ? 'home' : side === away ? 'away' : 'draw'}`)));

  for (const [mkey, label] of [['spreads', 'Spread'], ['totals', 'Total']]) {
    const main = pin ? pointsOf(pin, mkey, home)[0] : null;
    if (main == null) continue;
    const sides = mkey === 'spreads' ? [home, away] : ['Over', 'Under'];
    const pinP = pricesAt(pin, mkey, main, home);
    const rows = books.map(b => {
      const at = pricesAt(b, mkey, main, home);
      if (at && sides.every(s => at[s])) return { key: b.key, prices: at };
      // the venue's own main number, shown without an EV
      const own = pointsOf(b, mkey, home)[0];
      return own == null ? { key: b.key, prices: at } : { key: b.key, prices: pricesAt(b, mkey, own, home), point: own };
    });
    const kk = side => mkey === 'spreads' ? kal(`${gid}|spread|${main}|${side === home ? 'home' : 'away'}`) : kal(`${gid}|total|${main}|${side.toLowerCase()}`);
    out.push(market(mkey === 'spreads' ? 'spread' : 'total', label, main, sides, pinP, rows, kk));
  }
  return out.filter(m => m.sides.some(s => s.venues.length));

  function market(key, mlabel, point, sides, pinP, rows, kalFor) {
    let fair = null;
    if (pinP && sides.every(s => pinP[s])) {
      const f = devig(sides.map(s => americanToDecimal(pinP[s].american)), 'power');
      if (f) fair = Object.fromEntries(sides.map((s, i) => [s, f[i]]));
    }
    return {
      key, label: mlabel, point,
      sides: sides.map(s => {
        const vs = [];
        if (pinP?.[s]) vs.push(cell('pinnacle', pinP[s].american, null, point));
        for (const r of rows) if (r.prices?.[s]) vs.push(cell(r.key, r.prices[s].american, r.prices[s].url, r.point ?? point, r.point != null && r.point !== point));
        const k = kalFor(s);
        if (k && !vs.some(v => v.venue === 'kalshi')) vs.push(cell('kalshi', k.american ?? decimalToAmerican(k.decimal), k.url || null, point));
        const p = fair?.[s] ?? null;
        for (const v of vs) v.ev = p == null || v.lineDiffers || v.ref ? null : r4(p * v.decimal - 1);
        return { name: s, label: sideLabel(key, s, point, home), fair: r4(p), fairAmerican: probAmerican(p), venues: vs.sort((a, b) => ORDER.indexOf(a.venue) - ORDER.indexOf(b.venue)) };
      }),
    };
  }
}
function cell(venue, american, url, point, lineDiffers = false) {
  const d = americanToDecimal(american);
  return { venue, name: NAME(venue), american, decimal: r4(d), implied: d ? r4(1 / d) : null, url: url || null,
    point: point ?? null, lineDiffers: !!lineDiffers, ref: REFS.has(venue), secondHand: SECOND_HAND.has(venue) };
}
function sideLabel(key, side, point, home) {
  if (key === 'ml') return side;
  if (key === 'total') return `${side} ${point}`;
  const p = side === home ? point : -point;
  return `${side} ${p > 0 ? '+' : ''}${p}`;
}

// Mark each side's best bettable price. With a state: a venue legal there is
// marked legal 'yes'; one no source vouches for stays, greyed, as 'unknown'
// and can't be best; one not legal there is dropped (venues.js).
function finish(markets, { state = null } = {}) {
  const st = venues.stateOf(state);
  for (const m of markets) for (const s of m.sides) {
    if (st) {
      for (const v of s.venues) if (!v.ref) v.legal = venues.statusOf(st, v.venue);
      s.venues = s.venues.filter(v => v.ref || v.legal !== 'no');
    }
    const bettable = s.venues.filter(v => !v.ref && !v.lineDiffers && v.decimal > 1 && (!st || v.legal === 'yes'));
    const top = bettable.sort((a, b) => b.decimal - a.decimal)[0] || null;
    for (const v of s.venues) v.best = !!top && v === top;
    s.best = top ? { venue: top.venue, name: top.name, american: top.american, ev: top.ev } : null;
    s.venues.sort((a, b) => ORDER.indexOf(a.venue) - ORDER.indexOf(b.venue));
  }
  // the hold at the best bettable price on every side: low is cheap to bet, under 0 an arb
  for (const m of markets) {
    const best = m.sides.map(s => s.venues.find(v => v.best));
    m.bestHold = best.every(Boolean) ? r4(best.reduce((a, v) => a + 1 / v.decimal, 0) - 1) : null;
  }
  return markets.filter(m => m.sides.some(s => s.venues.some(v => !v.ref && (!st || v.legal === 'yes'))));
}

// The whole screen. gamesByLeague: freeBooksState.games; kalshi: Map of bets
// (bigmoney.gameIndex(...).bets) or null. → { games, venues, leagues, counts }
function build(gamesByLeague = {}, { kalshi = null, now = Date.now(), horizonMs = 48 * 3600e3, league = null, state = null, q = '' } = {}) {
  const want = String(q || '').trim().toLowerCase();
  const games = [];
  const leagues = {};
  for (const [lg, list] of Object.entries(gamesByLeague || {})) {
    for (const g of list || []) {
      const t = ms(g.commence_time);
      if (t == null || t < now - 5 * 60e3 || t > now + horizonMs) continue;
      leagues[lg] = (leagues[lg] || 0) + 1;
      if (league && lg !== league) continue;
      if (want && !`${g.home_team} ${g.away_team}`.toLowerCase().includes(want)) continue;
      const markets = finish(gameMarkets(g, { kalshi }), { state });
      if (!markets.length) continue;
      const sides = markets.flatMap(m => m.sides);
      const evs = sides.map(s => s.best?.ev).filter(e => e != null);
      games.push({ id: String(g.id), league: lg, leagueLabel: LEAGUE_LABEL[lg] || lg.toUpperCase(), start: g.commence_time, home: g.home_team, away: g.away_team,
        markets, maxEv: evs.length ? Math.max(...evs) : null, venues: [...new Set(sides.flatMap(s => s.venues.map(v => v.venue)))].length });
    }
  }
  games.sort((a, b) => ms(a.start) - ms(b.start) || a.home.localeCompare(b.home));
  const seen = new Set(games.flatMap(g => g.markets.flatMap(m => m.sides.flatMap(s => s.venues.map(v => v.venue)))));
  const cols = ORDER.filter(k => seen.has(k)).map(k => ({ key: k, name: NAME(k), ref: REFS.has(k), secondHand: SECOND_HAND.has(k), tx: venues.legalIn('TX')(k), ...(venues.stateOf(state) && !REFS.has(k) ? { legal: venues.statusOf(state, k) } : {}) }));
  const sides = games.flatMap(g => g.markets.flatMap(m => m.sides));
  return { games, venues: cols, leagues: Object.entries(leagues).map(([k, n]) => ({ key: k, label: LEAGUE_LABEL[k] || k.toUpperCase(), games: n })).sort((a, b) => b.games - a.games),
    counts: { games: games.length, sides: sides.length, priced: sides.filter(s => s.fair != null).length, plusEv: sides.filter(s => s.best?.ev > 0).length, lowHold: games.flatMap(g => g.markets).filter(m => m.bestHold != null && m.bestHold < 0.01).length } };
}

// Free viewers see every price; the fair and the EV are Pro.
function stripPro(screen) {
  return { ...screen, games: screen.games.map(g => ({ ...g, maxEv: null, markets: g.markets.map(m => ({ ...m, sides: m.sides.map(s => ({ ...s, fair: null, fairAmerican: null,
    best: s.best ? { ...s.best, ev: null } : null, venues: s.venues.map(v => ({ ...v, ev: null })) })) })) })) };
}

// ── line history ──
// key `${gameId}|${market}|${side}` → { id, game, start, label, pts: [[t, point, fair, { venue: american }]] }
// A point is added when anything moved and minGapMs has passed, or every
// heartbeatMs regardless; a game is dropped keepMs after its start.
function createHistory({ minGapMs = 4 * 60e3, heartbeatMs = 30 * 60e3, keepMs = 6 * 3600e3, maxPts = 400 } = {}) {
  const series = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function observe(screen, now = Date.now()) {
    let added = 0;
    for (const g of screen.games || []) for (const m of g.markets) for (const s of m.sides) {
      const id = `${g.id}|${m.key}|${s.name}`;
      const px = {};
      for (const v of s.venues) if (!v.lineDiffers) px[v.venue] = v.american;
      const pt = [now, m.point, s.fair == null ? null : r4(s.fair), px];
      let x = series.get(id);
      if (!x) { x = { id, game: g.id, start: g.start, label: s.label, market: m.key, pts: [] }; series.set(id, x); }
      x.start = g.start; x.label = s.label;
      const last = x.pts[x.pts.length - 1];
      const moved = !last || last[1] !== pt[1] || last[2] !== pt[2] || !same(last[3], pt[3]);
      if (!last || (moved && now - last[0] >= minGapMs) || now - last[0] >= heartbeatMs) {
        x.pts.push(pt); added++;
        if (x.pts.length > maxPts) x.pts.splice(0, x.pts.length - maxPts);
      }
    }
    prune(now);
    return added;
  }
  function prune(now = Date.now()) {
    for (const [k, x] of series) if (ms(x.start) != null && ms(x.start) < now - keepMs) series.delete(k);
  }
  const forGame = id => [...series.values()].filter(x => x.game === String(id));
  const dump = () => [...series.values()];
  function load(docs) {
    for (const d of docs || []) {
      if (!d || !d.id || !Array.isArray(d.pts)) continue;
      const had = series.get(d.id);
      if (!had) { series.set(d.id, { ...d, pts: d.pts.slice(-maxPts) }); continue; }
      // a restore after the live series started: older points go in front
      const first = had.pts[0]?.[0] ?? Infinity;
      had.pts = [...d.pts.filter(p => p[0] < first), ...had.pts].slice(-maxPts);
    }
  }
  return { observe, prune, forGame, dump, load, size: () => series.size, points: () => [...series.values()].reduce((a, x) => a + x.pts.length, 0) };
}

module.exports = { ORDER, REFS, SECOND_HAND, LEAGUE_LABEL, pricesAt, pointsOf, gameMarkets, finish, build, stripPro, createHistory };
