// ─── NFL GAME-LINE MODEL (nflmodel.js) ───────────────────────────────────────
// Our own NFL number for moneylines, spreads and totals, built from final
// scores alone so every part can be explained:
//
//   1. Margin rating per team, in points over an average team. Predicted home
//      margin = r_home - r_away + home field + a rest term (days of rest
//      difference, capped). After each game both ratings move by k times the
//      miss, with the final margin capped first so a blowout counts like a
//      big win, not like three. A new season pulls every rating part of the
//      way back to 0 (rosters change).
//   2. Points: an offence and a defence rating per team around a league mean
//      that drifts slowly, the same update shape, plus a dome term. Predicted
//      total = mean + both offences - both defences.
//   3. Score shapes. NFL margins pile up on 3, 7, 10 ... and totals on a few
//      numbers too, so the chance of each whole-number margin (or total) is a
//      normal around the prediction times a key-number weight measured on the
//      training seasons. Every line's chance comes from that one table:
//      P(home by more than 3.5), P(over 44.5), P(home wins) with a tie split.
//
// The parameters were fitted on 2006-2023 by walk-forward squared error,
// checked on 2024, and frozen (seeds/nflmodel-params.json). Pure: the data
// layer feeds finished games in kickoff order and asks for predictions.
// A model, never a proven edge: the backtest against Kalshi says how it does.

const DEFAULTS = {
  k: 0.1, cap: 21, shrink: 0.33, hfa: 1.8, kh: 0, rest: 0.15, restCap: 7,
  kt: 0.07, shrinkT: 0.4, mean0: 44, meanRate: 0.01, dome: 1.0,
  sd: 13.4, sdT: 13.6, sdMarket: 13.2, sdTMarket: 13.4,
  keyMargin: null, keyTotal: null, keyMarginMarket: null, keyTotalMarket: null,
};

// franchises that moved keep one rating
const ALIAS = { OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', JAC: 'JAX', WSH: 'WAS', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU' };
const code = c => { const u = String(c || '').toUpperCase(); return ALIAS[u] || u; };

// nflverse codes → the names books and exchanges use (nickname last word is
// enough to tell every team apart; Washington's has changed, so its city)
const TEAMS = {
  ARI: ['Arizona Cardinals', 'Cardinals', 'Arizona'], ATL: ['Atlanta Falcons', 'Falcons', 'Atlanta'], BAL: ['Baltimore Ravens', 'Ravens', 'Baltimore'],
  BUF: ['Buffalo Bills', 'Bills', 'Buffalo'], CAR: ['Carolina Panthers', 'Panthers', 'Carolina'], CHI: ['Chicago Bears', 'Bears', 'Chicago'],
  CIN: ['Cincinnati Bengals', 'Bengals', 'Cincinnati'], CLE: ['Cleveland Browns', 'Browns', 'Cleveland'], DAL: ['Dallas Cowboys', 'Cowboys', 'Dallas'],
  DEN: ['Denver Broncos', 'Broncos', 'Denver'], DET: ['Detroit Lions', 'Lions', 'Detroit'], GB: ['Green Bay Packers', 'Packers', 'Green Bay'],
  HOU: ['Houston Texans', 'Texans', 'Houston'], IND: ['Indianapolis Colts', 'Colts', 'Indianapolis'], JAX: ['Jacksonville Jaguars', 'Jaguars', 'Jacksonville'],
  KC: ['Kansas City Chiefs', 'Chiefs', 'Kansas City'], LA: ['Los Angeles Rams', 'Rams', 'Los Angeles R', 'LA Rams'], LAC: ['Los Angeles Chargers', 'Chargers', 'Los Angeles C', 'LA Chargers'],
  LV: ['Las Vegas Raiders', 'Raiders', 'Las Vegas'], MIA: ['Miami Dolphins', 'Dolphins', 'Miami'], MIN: ['Minnesota Vikings', 'Vikings', 'Minnesota'],
  NE: ['New England Patriots', 'Patriots', 'New England'], NO: ['New Orleans Saints', 'Saints', 'New Orleans'], NYG: ['New York Giants', 'Giants', 'New York G', 'NY Giants'],
  NYJ: ['New York Jets', 'Jets', 'New York J', 'NY Jets'], PHI: ['Philadelphia Eagles', 'Eagles', 'Philadelphia'], PIT: ['Pittsburgh Steelers', 'Steelers', 'Pittsburgh'],
  SEA: ['Seattle Seahawks', 'Seahawks', 'Seattle'], SF: ['San Francisco 49ers', '49ers', 'San Francisco'], TB: ['Tampa Bay Buccaneers', 'Buccaneers', 'Tampa Bay'],
  TEN: ['Tennessee Titans', 'Titans', 'Tennessee'], WAS: ['Washington Commanders', 'Commanders', 'Washington'],
};
const NICK = Object.fromEntries(Object.entries(TEAMS).map(([c, n]) => [n[1].toLowerCase(), c]));
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// "Kansas City Chiefs", "Chiefs", "KC", "Washington", "NY Jets" → nflverse code | null
function teamCode(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const up = code(raw);
  if (TEAMS[up]) return up;
  const s = squash(raw);
  for (const w of s.split(' ').reverse()) if (NICK[w]) return NICK[w];
  if (/redskins|football team/.test(s)) return 'WAS';
  for (const [c, names] of Object.entries(TEAMS)) if (names.some(n => squash(n) === s)) return c;
  // a city alone, when only one team plays there
  const hits = Object.entries(TEAMS).filter(([, n]) => squash(n[2]) === s);
  return hits.length === 1 ? hits[0][0] : null;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;

// ── score shapes ──
const npdf = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2);
// whole-number masses around mu, normal times key weights (keyed by |k| for
// margins, by k for totals) → Map k → p
function shape(mu, sd, keys, { lo, hi, abs }) {
  const out = new Map();
  let sum = 0;
  const a = Math.max(lo, Math.floor(mu - 5 * sd)), b = Math.min(hi, Math.ceil(mu + 5 * sd));
  for (let k = a; k <= b; k++) {
    const w = keys ? (keys[abs ? Math.abs(k) : k] ?? 1) : 1;
    const p = npdf(k, mu, sd) * w;
    out.set(k, p); sum += p;
  }
  for (const [k, p] of out) out.set(k, p / sum);
  return out;
}
const marginShape = (mu, o) => shape(mu, o.sd, o.keyMargin, { lo: -80, hi: 80, abs: true });
const totalShape = (mu, o) => shape(mu, o.sdT, o.keyTotal, { lo: 0, hi: 130, abs: false });
// P(value > line); a whole-number line counts a push as half (moneyline at 0)
function over(dist, line) {
  let p = 0;
  for (const [k, q] of dist) { if (k > line) p += q; else if (k === line) p += q / 2; }
  return p;
}

// ── ratings ──
function createRatings(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const teams = new Map();   // code → { m, off, def, games, last }
  let season = null, mean = o.mean0, hfa = o.hfa, games = 0, lastGame = null;
  const team = c => {
    if (!teams.has(c)) teams.set(c, { m: 0, off: 0, def: 0, games: 0, last: null });
    return teams.get(c);
  };
  function newSeason(s) {
    if (season != null && s !== season) {
      for (const t of teams.values()) { t.m *= 1 - o.shrink; t.off *= 1 - o.shrinkT; t.def *= 1 - o.shrinkT; }
    }
    season = s;
  }
  // g: { season, home, away, neutral, homeRest, awayRest, dome }
  function predict(g) {
    // the first game of a new season starts the off-season pull-back, read or update alike
    if (g.season != null && season != null && g.season > season) newSeason(g.season);
    const h = team(code(g.home)), a = team(code(g.away));
    const restD = Number.isFinite(g.homeRest) && Number.isFinite(g.awayRest) ? clamp(g.homeRest - g.awayRest, -o.restCap, o.restCap) : 0;
    const margin = h.m - a.m + (g.neutral ? 0 : hfa) + o.rest * restD;
    const total = mean + h.off + a.off - h.def - a.def + (g.dome ? o.dome : 0);
    return { margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, homeGames: h.games, awayGames: a.games };
  }
  // g plus { homeScore, awayScore }
  function update(g) {
    if (g.season != null) newSeason(g.season);
    const p = predict(g);
    const h = team(code(g.home)), a = team(code(g.away));
    const m = g.homeScore - g.awayScore;
    const mCap = clamp(m, -o.cap, o.cap);
    const err = mCap - clamp(p.margin, -o.cap, o.cap);
    h.m += o.k * err; a.m -= o.k * err;
    if (!g.neutral) hfa += o.kh * err;   // home field drifts with results (it fell from about 3 points to under 2 after 2020)
    const eh = g.homeScore - p.homePts, ea = g.awayScore - p.awayPts;
    h.off += o.kt * eh; a.def -= o.kt * eh;
    a.off += o.kt * ea; h.def -= o.kt * ea;
    mean += o.meanRate * (g.homeScore + g.awayScore - p.total);
    for (const t of [h, a]) { t.games++; t.last = g.kickoff || null; }
    games++; lastGame = g.kickoff || lastGame;
    return p;
  }
  const table = () => [...teams.entries()].map(([c, t]) => ({ team: c, name: TEAMS[c]?.[0] || c, rating: r2(t.m), off: r2(t.off), def: r2(t.def), games: t.games }))
    .sort((x, y) => y.rating - x.rating);
  return { opts: o, predict, update, table, status: () => ({ season, games, mean: r2(mean), hfa: r2(hfa), lastGame }) };
}

// Chances for every line on one game from a prediction.
// → { pHome, home(line) P(home margin > line), over(line) P(total > line) }
function chances(pred, o = DEFAULTS) {
  const opt = { ...DEFAULTS, ...o };
  const md = marginShape(pred.margin, opt), td = totalShape(pred.total, opt);
  return {
    pHome: r4(over(md, 0)),
    // P(home wins by more than `line`): Kalshi's "home wins by over 3.5" is home(3.5); the away team's is 1 - home(-3.5)
    home: line => r4(over(md, line)),
    away: line => r4(1 - over(md, -line)),
    over: line => r4(over(td, line)),
  };
}
// The market close the same way: home margin = closing spread (home favoured
// by s → +s), total = closing total, the market's own residual sd.
function marketChances(spreadHome, totalLine, o = DEFAULTS) {
  const opt = { ...DEFAULTS, ...o };
  return chances({ margin: spreadHome, total: totalLine }, { ...opt, sd: opt.sdMarket, sdT: opt.sdTMarket, keyMargin: opt.keyMarginMarket || opt.keyMargin, keyTotal: opt.keyTotalMarket || opt.keyTotal });
}

// Key-number weights from training games: observed share of each whole
// number over what a plain normal around each prediction expected.
// rows: [{ mu, actual }] → { [k]: weight }
function keyWeights(rows, sd, { abs, lo, hi, prior = 20 }) {
  const obs = new Map(), exp = new Map();
  for (const r of rows) {
    const d = shape(r.mu, sd, null, { lo, hi, abs });
    for (const [k, p] of d) { const j = abs ? Math.abs(k) : k; exp.set(j, (exp.get(j) || 0) + p); }
    const j = abs ? Math.abs(r.actual) : r.actual;
    obs.set(j, (obs.get(j) || 0) + 1);
  }
  const out = {};
  for (const [j, e] of exp) if (e > 0.5) out[j] = r4((((obs.get(j) || 0) + prior * 1) / (e + prior)));
  return out;
}

// Kickoff in UTC from nflverse's Eastern date and time (DST: second Sunday
// of March to first Sunday of November).
function easternToUtc(day, time = '13:00') {
  const [y, mo, d] = String(day).split('-').map(Number);
  const [hh, mm] = String(time || '13:00').split(':').map(Number);
  const nthSunday = (yy, m, n) => { const first = new Date(Date.UTC(yy, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  const guess = Date.UTC(y, mo - 1, d, hh + 5, mm);
  const dst = guess - 3600e3 >= dstStart && guess - 3600e3 < dstEnd;
  return guess - (dst ? 3600e3 : 0);
}

// nflverse games.csv text → finished and scheduled games in kickoff order
function parseNflverse(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const hd = lines[0].split(',');
  const ix = Object.fromEntries(hd.map((k, i) => [k, i]));
  const n = v => (v === '' || v == null || v === 'NA' ? null : Number(v));
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    if (c.length < hd.length - 2) continue;
    const g = {
      id: c[ix.game_id], season: n(c[ix.season]), type: c[ix.game_type], week: n(c[ix.week]), day: c[ix.gameday], time: c[ix.gametime] || null,
      home: code(c[ix.home_team]), away: code(c[ix.away_team]), homeScore: n(c[ix.home_score]), awayScore: n(c[ix.away_score]),
      neutral: c[ix.location] === 'Neutral', homeRest: n(c[ix.home_rest]), awayRest: n(c[ix.away_rest]),
      spread: n(c[ix.spread_line]), total: n(c[ix.total_line]), homeMl: n(c[ix.home_moneyline]), awayMl: n(c[ix.away_moneyline]),
      dome: /dome|closed/.test(c[ix.roof] || ''), roof: c[ix.roof] || null, espn: c[ix.espn] || null,
    };
    g.kickoff = easternToUtc(g.day, g.time || '13:00');
    g.done = g.homeScore != null && g.awayScore != null;
    out.push(g);
  }
  return out.sort((a, b) => a.kickoff - b.kickoff);
}

module.exports = { DEFAULTS, TEAMS, ALIAS, code, teamCode, createRatings, chances, marketChances, keyWeights, marginShape, totalShape, over, easternToUtc, parseNflverse };
