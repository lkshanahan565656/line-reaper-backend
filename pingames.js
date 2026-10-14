// ─── PINNACLE GAME LINES: THE SHARP FAIR FOR EXCHANGE GAME MARKETS ───────────
// Pinnacle takes the sharpest action on game lines and posts both sides at a
// low margin, on the same guest feed its website reads. With the margin taken
// out (power method), its price is the market's best guess at each side's
// chance. Kalshi and Polymarket US list the same games as $1 contracts: when
// the ask plus the taker fee is under Pinnacle's fair, the contract is a bet
// with an edge, priced off a book that isn't one of the exchanges.
//
//   moneyline  Kalshi / Polymarket US team contracts (kind 'teams') and
//              soccer's three-way result (game3: team A, the draw, team B)
//   spread     "<team> wins by more than 1.5": Pinnacle's line where that
//              team gives 1.5 (alternate lines too), half lines only
//   total      Over / Under a half line
//
// Everything here is full game (period 0), pregame. Not a licensed feed: it
// sits behind the PINNACLE switch like the props and esports prices. Pure
// parsers and matchers are tested on saved shapes; fetch is a thin wrapper.

const { teamMatches } = require('./exchanges');
const { nameMatch, kalshiTickerTime } = require('./xarb');

const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
// Pinnacle sport ids (esports, 12, is feeds.js's)
const SPORTS = { baseball: 3, basketball: 4, football: 15, hockey: 19, soccer: 29, tennis: 33, mma: 22 };

const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const halfLine = x => Number.isFinite(x) && Math.abs(((Math.abs(x) * 2) % 2) - 1) < 1e-9;

// power devig over any number of outcomes: Σ p_i^k = 1, so a longshot gives
// up more of the margin than a favourite → fair probabilities, or null
function devig(americans) {
  const ps = americans.map(Number).map(a => (Number.isFinite(a) && a !== 0 ? toProb(a) : NaN));
  if (ps.length < 2 || !ps.every(p => p > 0 && p < 1)) return null;
  const sum = ps.reduce((s, p) => s + p, 0);
  if (sum < 1) return ps.map(p => p / sum);   // no margin to take out (never at Pinnacle)
  let lo = 1, hi = 3;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (ps.reduce((s, p) => s + p ** k, 0) > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return ps.map(p => p ** k);
}
const vigOf = americans => r4(americans.reduce((s, a) => s + toProb(a), 0) - 1);
const limitOf = m => { const l = (m.limits || []).find(x => x?.type === 'maxRiskStake') || (m.limits || [])[0]; return Number(l?.amount) || null; };

// one sport's matchups + straight markets → games, each { id, sport, league,
// home, away, start, ml: { home, away, draw?, vig, limit, raw }, spreads:
// [{ home (the home side's points), pHome, alt, vig, limit, raw }], totals:
// [{ line, pOver, alt, vig, limit, raw }] }. Pregame only, full game only.
function parseGames(sport, matchups, markets, now = Date.now()) {
  const byMatchup = new Map();
  for (const m of markets || []) {
    if (!m || m.period !== 0 || (m.status && m.status !== 'open')) continue;
    if (!byMatchup.has(m.matchupId)) byMatchup.set(m.matchupId, []);
    byMatchup.get(m.matchupId).push(m);
  }
  const out = [];
  for (const mu of matchups || []) {
    if (!mu || mu.parentId != null || (mu.type && mu.type !== 'matchup') || mu.isLive) continue;
    const start = ms(mu.startTime);
    if (!(start > now)) continue;
    const home = mu.participants?.find(p => p.alignment === 'home')?.name, away = mu.participants?.find(p => p.alignment === 'away')?.name;
    if (!home || !away) continue;
    const g = { id: mu.id, sport, league: mu.league?.name || null, home, away, start: new Date(start).toISOString(), ml: null, spreads: [], totals: [] };
    for (const m of byMatchup.get(mu.id) || []) {
      const price = d => m.prices?.find(p => p.designation === d);
      if (m.type === 'moneyline' && !m.isAlternate) {
        const h = price('home')?.price, a = price('away')?.price, d = price('draw')?.price;
        const raw = d != null ? [h, a, d] : [h, a];
        const f = raw.every(x => x != null) ? devig(raw) : null;
        if (f) g.ml = { home: r4(f[0]), away: r4(f[1]), ...(d != null ? { draw: r4(f[2]) } : {}), vig: vigOf(raw), limit: limitOf(m), raw };
      } else if (m.type === 'spread') {
        const h = price('home'), a = price('away');
        if (!h || !a || h.points == null || Number(h.points) !== -Number(a.points)) continue;
        const f = devig([h.price, a.price]);
        if (f) g.spreads.push({ home: Number(h.points), pHome: r4(f[0]), alt: !!m.isAlternate, vig: vigOf([h.price, a.price]), limit: limitOf(m), raw: [h.price, a.price] });
      } else if (m.type === 'total') {
        const o = price('over'), u = price('under');
        if (!o || !u || o.points == null || Number(o.points) !== Number(u.points)) continue;
        const f = devig([o.price, u.price]);
        if (f) g.totals.push({ line: Number(o.points), pOver: r4(f[0]), alt: !!m.isAlternate, vig: vigOf([o.price, u.price]), limit: limitOf(m), raw: [o.price, u.price] });
      }
    }
    if (g.ml || g.spreads.length || g.totals.length) out.push(g);
  }
  return out;
}

// an exchange team label is one of Pinnacle's names: the built-in leagues'
// city and nickname rules either way round, else the same words
const sameTeam = (label, name) => !!label && !!name && (teamMatches(label, name) || teamMatches(name, label) || nameMatch(label, name));
// labels [a, b] → 'same' (a is home) | 'flipped' | null, one way round only
function sidesOf(labels, game) {
  const [a, b] = labels;
  const same = sameTeam(a, game.home) && sameTeam(b, game.away);
  const flip = sameTeam(a, game.away) && sameTeam(b, game.home);
  return same === flip ? null : same ? 'same' : 'flipped';
}

// Where an exchange game can start: Polymarket US gives its start; Kalshi
// sometimes has it in the ticker, else its expected expiration about 3h after,
// else anywhere on the ticker's (Eastern) date. → [lo, hi] ms | null
function startWindow(row) {
  const t = ms(row.startTime);
  if (t != null) return [t - 3 * 3600e3, t + 3 * 3600e3];
  const exp = ms(row.expectedExpiration);
  if (exp != null) return [exp - 9 * 3600e3, exp];
  const day = row.gameDay ?? (row.exchange === 'kalshi' ? kalshiTickerTime(String(row.eventKey || '').replace(/^kalshi:/, ''))?.day : null);
  return day != null ? [day - 6 * 3600e3, day + 30 * 3600e3] : null;
}

// Exchange rows grouped by game: Kalshi's GAME, TOTAL and SPREAD events share
// gameKey; a Polymarket US game is one event. The group's teams come from its
// team (or three-way result) rows. → [{ key, venue, teams, window, rows }]
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const key = r.exchange === 'kalshi' ? (r.gameKey ? `kalshi:${r.gameKey}` : null) : r.eventKey;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, venue: r.exchange, teams: null, window: null, rows: [] });
    const g = groups.get(key);
    g.rows.push(r);
    if (!g.teams && r.kind === 'teams' && r.outcomeLabel && r.noLabel) g.teams = [r.outcomeLabel, r.noLabel];
    if (!g.teams && r.game3?.teams?.length === 2) g.teams = r.game3.teams;
    if (r.kind === 'teams' || r.game3) g.window = g.window || startWindow(r);
  }
  return [...groups.values()].filter(g => g.teams && g.window);
}

// ── KALSHI AS A SECOND SHARP SOURCE ──
// Kalshi's game contracts trade at a one- or two-cent spread with no book
// margin: the bid/ask mid is its market's chance. Pinnacle-priced Kalshi bets
// lost 5.1% over 205 settled (2026-10-14), so on these games Kalshi is at
// least as sharp as Pinnacle. Each Odds API game (Pinnacle's names) gets a
// 'kalshi_mid' bookmaker built from the mids: moneyline from the team
// contracts, half-line totals and spreads from Kalshi's line contracts. The
// prices are no-vig (both sides add up to 1), so ev.js reads them as a fair
// next to Pinnacle's. Not a book anyone bets at: ev.screen never scores it.
// → Map game id → bookmaker
const KALSHI_MID = { maxSpread: 0.05, minP: 0.03 };
function kalshiMid(r, o = KALSHI_MID) {
  if (r.exchange !== 'kalshi' || r.tradable === false || r.yesAsk == null || r.noAsk == null) return null;
  const bid = 1 - r.noAsk, ask = r.yesAsk;
  if (!(ask >= bid) || ask - bid > o.maxSpread) return null;
  const p = (ask + bid) / 2;
  return p >= o.minP && p <= 1 - o.minP ? p : null;
}
const fairAmerican = p => +(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p).toFixed(2);
function kalshiMidBooks(rows, games, o = KALSHI_MID) {
  const out = new Map();
  const kgroups = groupRows((rows || []).filter(r => r.exchange === 'kalshi' && !r.hasDraw));
  for (const g of kgroups) {
    const [lo, hi] = g.window, mid = (lo + hi) / 2;
    const cands = [];
    for (const game of games || []) {
      const t = ms(game.commence_time);
      if (t == null || t < lo || t > hi) continue;
      const pol = sidesOf(g.teams, { home: game.home_team, away: game.away_team });
      if (pol) cands.push({ game, pol, d: Math.abs(t - mid) });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.d - b.d);
    if (cands.length > 1 && cands[0].d === cands[1].d) continue;
    const { game, pol } = cands[0];
    const home = game.home_team, away = game.away_team;
    const isHome = label => {
      const i = g.teams.findIndex(t => sameTeam(label, t) || t === label);
      return i < 0 ? null : (i === 0) === (pol === 'same');
    };
    const pHomes = [], totals = new Map(), spreads = new Map();
    for (const r of g.rows) {
      const p = kalshiMid(r, o);
      if (p == null) continue;
      if (r.kind === 'teams') {
        const h = isHome(r.outcomeLabel);
        if (h != null) pHomes.push(h ? p : 1 - p);
      } else if (r.kind === 'total' && halfLine(r.line)) totals.set(r.line, p);
      else if (r.kind === 'spread' && halfLine(r.line) && r.lineTeam) {
        const h = isHome(r.lineTeam);
        if (h == null) continue;
        // YES: lineTeam wins by more than line → home gives `line` when it's home's contract
        const homePt = h ? -r.line : r.line;
        spreads.set(homePt, h ? p : 1 - p);
      }
    }
    const markets = [];
    if (pHomes.length) {
      const p = pHomes.reduce((a, x) => a + x, 0) / pHomes.length;
      markets.push({ key: 'h2h', outcomes: [{ name: home, price: fairAmerican(p) }, { name: away, price: fairAmerican(1 - p) }] });
    }
    if (spreads.size) markets.push({ key: 'spreads', outcomes: [...spreads].flatMap(([pt, p]) => [{ name: home, price: fairAmerican(p), point: pt }, { name: away, price: fairAmerican(1 - p), point: -pt }]) });
    if (totals.size) markets.push({ key: 'totals', outcomes: [...totals].flatMap(([line, p]) => [{ name: 'Over', price: fairAmerican(p), point: line }, { name: 'Under', price: fairAmerican(1 - p), point: line }]) });
    if (markets.length && !out.has(game.id)) out.set(game.id, { key: 'kalshi_mid', title: 'Kalshi', markets });
  }
  return out;
}
// games (one feed's) + the Kalshi mids → the same games with a 'kalshi_mid'
// bookmaker added, holding only the markets and lines Pinnacle also prices on
// that game: Kalshi is the second source, never the only one. Alone at its own
// lines it priced a 20.5 "total" (not the game's) and 11.5-point alternates
// nobody else had (live run, 2026-10-14).
function withKalshiMid(games, rows, o = KALSHI_MID) {
  const books = kalshiMidBooks(rows, games, o);
  if (!books.size) return games;
  return games.map(g => {
    const bm = books.get(g.id);
    const pin = (g.bookmakers || []).find(b => b.key === 'pinnacle');
    if (!bm || !pin) return g;
    const has = (key, o2) => (pin.markets || []).some(m => m.key === key && m.outcomes.some(x => x.name === o2.name && (key === 'h2h' || x.point === o2.point)));
    const markets = bm.markets.map(m => ({ ...m, outcomes: m.outcomes.filter(x => has(m.key, x)) }))
      .map(m => ({ ...m, outcomes: m.key === 'h2h' ? (m.outcomes.length === 2 ? m.outcomes : []) : m.outcomes }))
      .filter(m => m.outcomes.length);
    // a spread or total line keeps both its sides or neither
    for (const m of markets) if (m.key !== 'h2h') m.outcomes = m.outcomes.filter(x => m.outcomes.filter(y => Math.abs(y.point) === Math.abs(x.point)).length === 2);
    const kept = markets.filter(m => m.outcomes.length);
    return kept.length ? { ...g, bookmakers: [...g.bookmakers, { ...bm, markets: kept }] } : g;
  });
}

// Fetch every sport → { games, errors }. The feed answered without a key from
// GitHub's runners (2026-10-14); PINNACLE_GUEST_KEY is sent when set.
async function fetchPinnacleGames(http, { key = '', sports = SPORTS, now = Date.now() } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(key ? { 'X-API-Key': key } : {}) };
  const games = [], errors = [];
  await Promise.all(Object.entries(sports).map(async ([sport, id]) => {
    try {
      const [mu, mk] = await Promise.all([
        http.get(`${PIN}/sports/${id}/matchups`, { headers, timeout: 20000 }),
        http.get(`${PIN}/sports/${id}/markets/straight`, { headers, timeout: 20000 }),
      ]);
      games.push(...parseGames(sport, mu?.data, mk?.data, now));
    } catch (e) { errors.push(`${sport}: ${e.response?.status || e.message}`); }
  }));
  return { games, errors };
}

module.exports = { PIN, SPORTS, toProb, devig, parseGames, sameTeam, sidesOf, startWindow, groupRows, fetchPinnacleGames,
  KALSHI_MID, kalshiMid, kalshiMidBooks, withKalshiMid };
