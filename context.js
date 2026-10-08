// ─── MATCH CONTEXT ────────────────────────────────────────────────────────────
// Player averages ignore who they're playing tonight. Context fixes three things:
//
//  1. Is the last map in the span even played?  A "Maps 1-3" prop in a Bo3 only
//     gets a map 3 when the series goes 1-1:  P(map 3) = 2·p·(1−p).
//     A heavy favourite's 1-3 line is often priced as if map 3 is likely.
//     We price it as a MIXTURE: (1−P3) × "2 maps" + P3 × "3 maps".
//  2. How many rounds per map (CS2 / Valorant)?  Even matchups run long,
//     stomps end around 13-4. Fewer rounds, fewer kills for everyone.
//  3. Which side is favoured?  Players on the stronger team get more kills
//     (LoL/Dota: team kills; CS/VAL: rounds won), relative to how favoured
//     their team usually is (their averages already include that).
//
// Win probability comes from, in order: odds entered by hand (or from a feed)
// for the match, then Elo ratings built from recent results (LoL from
// Leaguepedia, Dota from OpenDota, Valorant from vlrggapi). CS2 has no free
// results feed we can call from a server, so CS2 context needs entered odds.
//
// Every constant below is a starting point. The pick tracker splits results by
// context source, so these can be tuned on real graded picks.

const TUNING = {
  // kills scale with how favoured the team is versus its usual matchup
  strength: { CS: 0.30, VAL: 0.30, LOL: 0.50, DOTA: 0.40 },
  // rounds per map shrink as a matchup gets lopsided (CS/VAL only)
  roundsCurve: 0.8,
  // a typical pro matchup is ~65/35, so that's where the rounds factor is 1.0
  typicalGap: 0.15,
  eloK: 24,
  eloStart: 1500,
};

// ── odds math ──
function americanToProb(ml) {
  const m = parseFloat(ml);
  if (!isFinite(m) || m === 0 || Math.abs(m) < 100) return null;
  return m > 0 ? 100 / (m + 100) : -m / (-m + 100);
}

function decimalToProb(d) {
  const x = parseFloat(d);
  return isFinite(x) && x > 1 ? 1 / x : null;
}

// Two-way no-vig probability for side A, from American or decimal prices.
function devig(priceA, priceB) {
  const conv = v => (Math.abs(parseFloat(v)) >= 100 ? americanToProb(v) : decimalToProb(v));
  const a = conv(priceA), b = conv(priceB);
  if (a == null || b == null) return null;
  return a / (a + b);
}

// P(team wins a best-of-N series) given per-map win probability p
function mapToSeriesProb(p, bestOf = 3) {
  const need = Math.ceil(bestOf / 2);
  let total = 0;
  // win `need` maps having lost k (k < need); last map played is a win
  for (let k = 0; k < need; k++) total += binom(need - 1 + k, k) * Math.pow(p, need) * Math.pow(1 - p, k);
  return total;
}

function seriesToMapProb(ps, bestOf = 3) {
  if (bestOf <= 1) return ps;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mapToSeriesProb(mid, bestOf) < ps) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}

// P(map n gets played) in a best-of-N, with per-map win prob p for one side.
// Map n is played iff neither side reached the target in the first n−1 maps.
function pMapPlayed(n, p, bestOf = 3) {
  const need = Math.ceil(bestOf / 2);
  if (n <= need) return 1;
  if (n > bestOf) return 0;
  const played = n - 1;
  let open = 0;
  for (let w = 0; w <= played; w++) {
    const l = played - w;
    if (w < need && l < need) open += binom(played, w) * Math.pow(p, w) * Math.pow(1 - p, l);
  }
  return open;
}

// Scenarios for a span: [{ maps, weight }], weights sum to 1.
// Map m+1 can only be played if map m was, so P(exactly k maps) is a difference.
function spanScenarios(maps, p, bestOf = 3) {
  const sorted = (maps || [1]).slice().sort((a, b) => a - b);
  const probs = sorted.map(m => pMapPlayed(m, p, bestOf));
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const pThis = probs[i], pNext = i + 1 < sorted.length ? probs[i + 1] : 0;
    const w = pThis - pNext;
    if (w > 1e-9) out.push({ maps: i + 1, weight: w });
  }
  // span starts past the guaranteed maps (e.g. "Map 3" alone): renormalise
  const tot = out.reduce((s, x) => s + x.weight, 0);
  return tot > 0 ? out.map(x => ({ maps: x.maps, weight: x.weight / tot })) : [{ maps: sorted.length, weight: 1 }];
}

function inferBestOf(maps) {
  const last = Math.max(...(maps || [1]));
  return last >= 4 ? 5 : 3;
}

// Kills-per-map multiplier from the matchup (pMap = this player's team per-map win prob).
function killFactor(sport, pMap, pTypical = 0.5) {
  const s = sportKey(sport);
  const S = TUNING.strength[s] ?? 0;
  let f = 1 + S * (pMap - pTypical);
  if (s === 'CS' || s === 'VAL') {
    const gap = pMap - 0.5;
    f *= 1 + TUNING.roundsCurve * (TUNING.typicalGap ** 2 - gap * gap);
  }
  return f;
}

function sportKey(sport) {
  const s = (sport || '').toUpperCase();
  if (s.includes('VAL')) return 'VAL';
  if (s.includes('CS') || s.includes('COUNTER')) return 'CS';
  if (s.includes('LOL') || s.includes('LEAGUE')) return 'LOL';
  if (s.includes('DOTA')) return 'DOTA';
  if (s.includes('COD') || s.includes('CALL OF DUTY')) return 'COD';
  return s;
}

// Over/under probability under a mixture of map-count scenarios.
// mean scales with maps; variance = k × mean, as in the base model.
function mixtureProb(line, side, scenarios, meanPerMap, k, normalCDF) {
  let pUnder = 0;
  for (const sc of scenarios) {
    const mean = meanPerMap * sc.maps;
    const std = Math.sqrt(Math.max(mean * k, 1e-6));
    pUnder += sc.weight * normalCDF(line, mean, std);
  }
  return side === 'UNDER' ? pUnder : 1 - pUnder;
}

// ── team names ──
function teamKey(n) {
  return (n || '').toLowerCase()
    .replace(/\b(team|esports?|gaming|club|academy)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function teamsMatch(a, b) {
  const x = teamKey(a), y = teamKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) return true;
  return false;
}

// "Vitality vs NAVI", "VIT @ NAVI", "G2 - FaZe" → ['Vitality', 'NAVI']
function splitMatchTitle(title) {
  const parts = String(title || '').split(/\s+(?:vs\.?|v|@|-|–)\s+/i).map(s => s.trim()).filter(Boolean);
  return parts.length === 2 ? parts : null;
}

// Given the player's team and the match title, the other side.
function opponentFrom(team, title, explicitOpponent) {
  if (explicitOpponent) return explicitOpponent;
  const sides = splitMatchTitle(title);
  if (!sides || !team) return null;
  if (teamsMatch(team, sides[0])) return sides[1];
  if (teamsMatch(team, sides[1])) return sides[0];
  return null;
}

// ── Elo ratings from results ──
// games: [{ a, b, aWon: bool, t }] at MAP level, any order.
function buildElo(games, { k = TUNING.eloK, start = TUNING.eloStart } = {}) {
  const r = {}, seen = {}, expSum = {};
  const get = n => (r[n] ??= start);
  for (const g of games.slice().sort((x, y) => (x.t || 0) - (y.t || 0))) {
    const a = teamKey(g.a), b = teamKey(g.b);
    if (!a || !b || a === b) continue;
    const ea = 1 / (1 + Math.pow(10, (get(b) - get(a)) / 400));
    const sa = g.aWon ? 1 : 0;
    r[a] += k * (sa - ea);
    r[b] -= k * (sa - ea);
    seen[a] = (seen[a] || 0) + 1; seen[b] = (seen[b] || 0) + 1;
    expSum[a] = (expSum[a] || 0) + ea; expSum[b] = (expSum[b] || 0) + (1 - ea);
  }
  const names = Object.keys(r);
  return {
    rating: n => { const key = resolve(n); return key ? r[key] : null; },
    games: n => { const key = resolve(n); return key ? seen[key] : 0; },
    // how favoured this team usually was, so we only adjust for the DIFFERENCE tonight
    typical: n => { const key = resolve(n); return key && seen[key] ? expSum[key] / seen[key] : 0.5; },
    mapProb(a, b) {
      const ra = this.rating(a), rb = this.rating(b);
      if (ra == null || rb == null) return null;
      return 1 / (1 + Math.pow(10, (rb - ra) / 400));
    },
    size: names.length,
  };
  function resolve(n) {
    const key = teamKey(n);
    if (!key) return null;
    if (r[key] != null) return key;
    return names.find(x => teamsMatch(x, key)) || null;
  }
}

// Leaguepedia ScoreboardGames rows → map-level games
function lolGamesFromRows(rows) {
  return (rows || []).map(x => ({
    a: x.Team1, b: x.Team2, aWon: (x.WinTeam || '') === x.Team1, t: Date.parse((x.DateTime || '').replace(' ', 'T') + 'Z') || 0,
  })).filter(g => g.a && g.b && g.a !== g.b);
}

// OpenDota /proMatches rows → map-level games
function dotaGamesFromRows(rows) {
  return (rows || []).filter(m => m.radiant_name && m.dire_name).map(m => ({
    a: m.radiant_name, b: m.dire_name, aWon: !!m.radiant_win, t: (m.start_time || 0) * 1000,
  }));
}

// vlrggapi /match?q=results rows (series scores) → map-level games
function valGamesFromRows(rows) {
  // Results come newest first. Without a parseable timestamp, fall back to
  // list position so Elo still replays oldest → newest.
  const out = [];
  (rows || []).forEach((m, i) => {
    const s1 = parseInt(m.score1), s2 = parseInt(m.score2);
    if (!m.team1 || !m.team2 || !isFinite(s1) || !isFinite(s2) || s1 + s2 > 7) return;
    const ts = m.unix_timestamp != null && isFinite(+m.unix_timestamp) ? +m.unix_timestamp * 1000 : Date.parse(m.unix_timestamp || '');
    const t = isFinite(ts) && ts > 0 ? ts : -i;
    for (let i = 0; i < s1; i++) out.push({ a: m.team1, b: m.team2, aWon: true, t });
    for (let i = 0; i < s2; i++) out.push({ a: m.team1, b: m.team2, aWon: false, t });
  });
  return out;
}

// ── manual / fed match odds ──
function createOddsBook({ ttlMs = 36 * 3600000, now = () => Date.now() } = {}) {
  const rows = [];
  return {
    // { sport, teamA, teamB, priceA, priceB } or { ..., pA } (series win prob), bestOf
    set(entry) {
      const pSeries = entry.pA != null ? parseFloat(entry.pA) : devig(entry.priceA, entry.priceB);
      if (!(pSeries > 0 && pSeries < 1)) throw new Error('need pA between 0 and 1, or two prices');
      const bestOf = parseInt(entry.bestOf) || 3;
      const row = {
        sport: sportKey(entry.sport), teamA: entry.teamA, teamB: entry.teamB, bestOf,
        pSeriesA: pSeries, pMapA: seriesToMapProb(pSeries, bestOf), at: now(),
        // prices quoted on a single map (Bo1 or a map line) are already map probs
        ...(entry.perMap ? { pMapA: pSeries } : {}),
      };
      const i = rows.findIndex(r => r.sport === row.sport && teamsMatch(r.teamA, row.teamA) && teamsMatch(r.teamB, row.teamB));
      if (i >= 0) rows[i] = row; else rows.push(row);
      return row;
    },
    // per-map win prob for `team` against `opponent`, or null
    lookup(sport, team, opponent) {
      const s = sportKey(sport), t = now();
      for (const r of rows) {
        if (r.sport !== s || t - r.at > ttlMs) continue;
        if (teamsMatch(r.teamA, team) && (!opponent || teamsMatch(r.teamB, opponent))) return { pMap: r.pMapA, bestOf: r.bestOf };
        if (teamsMatch(r.teamB, team) && (!opponent || teamsMatch(r.teamA, opponent))) return { pMap: 1 - r.pMapA, bestOf: r.bestOf };
      }
      return null;
    },
    list() { const t = now(); return rows.filter(r => t - r.at <= ttlMs); },
  };
}

// ── the one call the pick generator makes ──
// Returns null when we can't say anything about this match.
function matchContext({ sport, team, opponent, maps }, { oddsBook, elo = {} }) {
  if (!team) return null;
  const s = sportKey(sport);
  let pMap = null, source = null, bestOf = inferBestOf(maps), pTypical = 0.5;
  const fed = oddsBook?.lookup(s, team, opponent);
  if (fed) { pMap = fed.pMap; source = 'odds'; bestOf = fed.bestOf || bestOf; }
  const ratings = elo[s];
  if (ratings) pTypical = ratings.typical(team);
  if (pMap == null && ratings && opponent) {
    const p = ratings.mapProb(team, opponent);
    if (p != null && ratings.games(team) >= 5 && ratings.games(opponent) >= 5) { pMap = p; source = 'elo'; }
  }
  if (pMap == null) return null;
  const scenarios = spanScenarios(maps, pMap, bestOf);
  const expMaps = scenarios.reduce((acc, sc) => acc + sc.maps * sc.weight, 0);
  const lastMap = Math.max(...(maps || [1]));
  return {
    source, opponent: opponent || null, pMap, bestOf, pTypical,
    pLastMap: pMapPlayed(lastMap, pMap, bestOf),
    scenarios, expMaps,
    factor: killFactor(s, pMap, pTypical),
  };
}

function describeContext(c) {
  if (!c) return '';
  const bits = [];
  if (c.opponent) bits.push(`vs ${c.opponent}`);
  bits.push(`${Math.round(c.pMap * 100)}% map win (${c.source})`);
  if (c.scenarios.length > 1) bits.push(`last map played ${Math.round(c.pLastMap * 100)}%`);
  if (Math.abs(c.factor - 1) >= 0.01) bits.push(`kills ×${c.factor.toFixed(2)}`);
  return bits.join(' · ');
}

module.exports = {
  TUNING, americanToProb, decimalToProb, devig, mapToSeriesProb, seriesToMapProb,
  pMapPlayed, spanScenarios, inferBestOf, killFactor, mixtureProb,
  teamKey, teamsMatch, splitMatchTitle, opponentFrom,
  buildElo, lolGamesFromRows, dotaGamesFromRows, valGamesFromRows,
  createOddsBook, matchContext, describeContext, sportKey,
};
