// ─── KILL-SHARE MODEL: PINNACLE'S TEAM KILLS SPLIT BY EACH PLAYER'S SHARE ───
// Pinnacle prices each team's kills on each map (LoL and Dota, its "Kills"
// child matchups); nobody prices a player's kills sharply. A player's kills
// are his team's kills times his share of them, and the share is the stable
// part: who carries a team changes slowly, how many kills a match produces is
// what the market argues about. So the fair for a player line is
//
//   Pinnacle's team total on each map the line covers × the player's share
//
// with the share from his recent games (kills a game over the five players'
// kills a game, the five the books list for his team), a share above a fifth
// shrunk toward it by shrinkGames games. A team with fewer than five players on the
// board, or a player with too few games, is an unknown lineup: no share.
//
// Two numbers for each line, both off Pinnacle's team total:
//   share     the total split by the players' recent shares (this model)
//   pinnacle  the total split by the books' own shares: the player's market
//             mean × Pinnacle / the books' five players (esmarket.teamKillBudget)
// A play clears when the share fair beats the app's break-even by minEv and
// the two agree within agreePts on that side: the kills Pinnacle expects and
// who gets them both point the same way. Graded in a record of their own.
// Pure, so it's unit-tested; the server feeds picks, stats and Pinnacle in.

const { sideProbs } = require('./dist');
const { probToAmerican } = require('./ev');

const DEFAULTS = {
  // games of an even fifth mixed into a share above a fifth: a carry's hot
  // stretch regresses, a support's low share doesn't (it's the role). Fit on
  // 6,661 LoL and 9,299 Dota games: RMSE 2.079 vs 2.089 raw, carries
  // calibrated within a point or two
  shrinkGames: 8,
  // LoL supports (under this share) run over their mean less than the curve
  // says (55% priced, 49% hit), so they aren't priced
  lolMinShare: 0.12,
  minGames: 6,       // fewer games than this and the share is a guess
  need: 5,           // players on the board for a team before its shares mean anything
  minEv: 2,          // percent past the app's break-even
  maxEv: 30,         // past this it's a bad match, not an edge
  agreePts: 5,       // share and Pinnacle-by-the-books within this many points of win chance
  minShare: 0.03, maxShare: 0.5,
};

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;

// One team's players → each one's share of the team's kills.
// players: [{ key, rate (kills a game), games }]
// → Map(key → { share, raw, games }), or null when the lineup isn't known
function teamShares(players, o = {}) {
  const { shrinkGames, minGames, need } = { ...DEFAULTS, ...o };
  const ok = (players || []).filter(p => p && p.rate > 0 && p.games >= minGames);
  if (ok.length < need || ok.length !== (players || []).length) return null;
  const sum = ok.reduce((a, p) => a + p.rate, 0);
  const even = 1 / ok.length;
  const shrunk = ok.map(p => {
    const raw = p.rate / sum;
    const k = raw > even ? shrinkGames : 0;
    return { key: p.key, raw, games: p.games, s: (raw * p.games + even * k) / (p.games + k) };
  });
  const tot = shrunk.reduce((a, x) => a + x.s, 0);
  const out = new Map();
  for (const x of shrunk) out.set(x.key, { share: r4(x.s / tot), raw: r4(x.raw), games: x.games });
  return out;
}

// Spread of a player's kills around share × his team's kills, as a variance
// multiplier on the mean (Dota fit, 29,905 player games: 1.35 calibrates
// within a point in every 10% bin), and of a team's kills around Pinnacle's
// total on one map (esboard.KILL_SD).
const PLAYER_K = { LOL: 1.35, DOTA: 1.35 };
const TEAM_SD = { LOL: 6, DOTA: 8 };

// The chance of a side at a line when the player's mean is `mean` over
// `maps` maps at kill share `share`: a negative binomial with the player's
// own spread plus the team total's (share² × sd² a map), read as a mean, not
// a median (players go over their share × team kills 46% of the time).
function shareProb(mean, line, side, { game = 'LOL', share = 0.2, maps = 1, o = {} } = {}) {
  if (!(mean > 0) || !(line > 0)) return null;
  const k0 = o.playerK ?? PLAYER_K[game] ?? 1.35, sd = o.teamSd ?? TEAM_SD[game] ?? 7;
  const k = Math.max(1.06, k0 + (share * share * sd * sd * maps) / mean);
  const r = sideProbs(line, mean, k, 'kills');
  const win = side === 'UNDER' ? r.under : r.over;
  return r.push < 1 ? win / (1 - r.push) : null;
}

// the player's mean over the maps a line covers: Pinnacle's per-map totals × share
function shareMean(pinPerMap, share) {
  if (!Array.isArray(pinPerMap) || !pinPerMap.length || pinPerMap.some(x => !(x > 0)) || !(share > 0)) return null;
  return r2(pinPerMap.reduce((a, x) => a + x, 0) * share);
}

// One pick (one player and stat, every app's line) priced on the share.
//   p.share:   { mean, pinMean, share, raw, games, pinPerMap }
//   fairAt(mean, line, side) → the chance of the side at the line (0-1) on the
//              board's kills curve with that mean
//   books:     [{ book: 'PP'|'UD'|'SL', line, open: { OVER, UNDER }, evAt(prob, side) → % }]
// → { side, line, book, ev, prob, pinProb, clears, cells: { [book]: { side, ev, prob, pinProb } } } or null
function priceShare(p, { fairAt, books, o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = p?.share;
  if (!s || !(s.mean > 0) || typeof fairAt !== 'function') return null;
  const cells = {};
  let best = null;
  for (const b of books || []) {
    if (!(b.line > 0)) continue;
    let cell = null;
    for (const side of ['OVER', 'UNDER']) {
      if (b.open && b.open[side] === false) continue;
      const prob = fairAt(s.mean, b.line, side);
      if (!(prob > 0 && prob < 1)) continue;
      const ev = b.evAt(prob, side);
      if (ev == null || !Number.isFinite(ev)) continue;
      if (!cell || ev > cell.ev) {
        const pinProb = s.pinMean > 0 ? fairAt(s.pinMean, b.line, side) : null;
        cell = { side, ev: r2(ev), prob: r2(prob * 100), pinProb: pinProb != null ? r2(pinProb * 100) : null, line: b.line };
      }
    }
    if (!cell) continue;
    cell.clears = cell.ev >= o.minEv && cell.ev <= o.maxEv && cell.pinProb != null && Math.abs(cell.prob - cell.pinProb) <= o.agreePts
      // Pinnacle split the books' way must lean our side too
      && cell.pinProb > 50;
    cells[b.book] = cell;
    if (!best || (cell.clears - best.clears || cell.ev - best.ev) > 0) best = { book: b.book, ...cell };
  }
  return best ? { ...best, cells } : null;
}

// A priced pick → the shape the pick tracker records (as pingap.js does).
// Only a cleared play opens a row (bestEv set); the rest still pass through
// so a row already open follows its line and the share's fair to lock.
function sharePlay(p, priced) {
  if (!priced || !p?.share) return null;
  const book = priced.book;
  return {
    sport: p.sport, player: p.player, team: p.team, matchTitle: p.matchTitle, gameId: p.gameId ?? null,
    market: p.market, displayMarket: p.displayMarket || p.market, startTime: p.startTime,
    side: priced.side, bestBook: book, bestEv: priced.clears ? priced.ev : null, prob: priced.prob, rawProb: priced.prob,
    ppLine: book === 'PP' ? priced.line : p.ppLine, udLine: book === 'UD' ? priced.line : p.udLine, sleeperLine: book === 'SL' ? priced.line : p.sleeperLine ?? null,
    udImplied: p.udImplied ?? null, udMultiplier: p.udMultiplier ?? null, sleeperMultiplier: p.sleeperMultiplier ?? null,
    modelPred: p.share.mean, rawPred: null, predSource: 'kill share',
    // the tracker prices the close on this: Pinnacle's total × the share at each refresh
    marketPred: p.share.mean, fairSource: 'share', confidence: null, context: p.context || null,
    shareCtx: { game: p.share.game, share: p.share.share, maps: p.share.maps },
    pinTeam: p.pinTeam || null,
  };
}

// BetRivers' per-map player kill ladders (esbooks.parseKambiEsports players)
// priced on the share. index: Map(`${game}|${nameKey}`) → { share, teamName,
// start, pinByMap: { [map]: Pinnacle's team total }, booksPerMap (Pinnacle
// split the books' way, a map) }. sameTeam(a, b) matches team names;
// toDecimal(american). Rows in the +EV tab's esports shape (esbooks.screen).
function priceBookPlayers(books, index, { nameKey, sameTeam, toDecimal, now = Date.now(), fairs = null, costs = null, o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rows = [];
  let priced = 0;
  for (const g of books || []) {
    if (!g?.players?.length || !['LOL', 'DOTA'].includes(g.game)) continue;
    for (const l of g.players) {
      const e = index.get(`${g.game}|${nameKey(l.player)}`);
      if (!e || !sameTeam(e.teamName, g.teams[l.team])) continue;
      const start = e.start ?? g.start;
      if (!(start > now) || (g.start && e.start && Math.abs(g.start - e.start) > 12 * 3600e3)) continue;
      const vals = Object.values(e.pinByMap || {}).filter(x => x > 0);
      const pin = e.pinByMap?.[l.period] > 0 ? e.pinByMap[l.period] : vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
      if (!pin) continue;
      const mean = r2(pin * e.share), ctx = { game: g.game, share: e.share, maps: 1 };
      const group = `es|${g.game}|share|${nameKey(l.player)}|${l.period}|${l.line}`;
      priced++;
      for (const i of [0, 1]) {
        const side = i === 0 ? 'OVER' : 'UNDER';
        const fair = shareProb(mean, l.line, side, ctx);
        if (!(fair > 0)) continue;
        const sideLabel = `${l.player} ${i === 0 ? 'Over' : 'Under'} ${l.line}`;
        if (fairs) fairs.set(`${group}|${sideLabel}`, r2(fair * 100));
        const d = toDecimal(l.prices[i]);
        if (!d) continue;
        if (costs) costs.set(`${group}|${sideLabel}|betrivers`, Math.round(1e4 / d) / 1e4);
        if (fair < 0.05 || fair > 0.95) continue;
        const ev = (fair * d - 1) * 100;
        if (ev < o.minEv || ev > o.maxEv) continue;
        const pinFair = e.booksPerMap > 0 ? shareProb(e.booksPerMap, l.line, side, ctx) : null;
        const agree = pinFair != null && Math.abs(fair - pinFair) * 100 <= o.agreePts && pinFair * d > 1;
        rows.push({
          sport: g.game.toLowerCase(), game: g.game, gameLabel: g.game === 'LOL' ? 'LoL' : 'Dota 2', league: g.league, event: `${g.teams[0]} vs ${g.teams[1]}`, start: new Date(start).toISOString(),
          group, market: `kills|${l.period}|player`, marketLabel: `Map ${l.period} player kills`, player: l.player, team: e.teamName, point: l.line,
          side: sideLabel, book: 'betrivers', price: l.prices[i], decimal: Math.round(d * 1000) / 1000, fairProb: r2(fair * 100), fairPrice: probToAmerican(fair), ev: r2(ev),
          kelly: r2(Math.max(0, (fair * d - 1) / (d - 1)) * 25),
          source: agree ? 'esbook-share' : 'esbook-share-only', esports: true, clears: agree, single: !agree, model: true, agree, spreadPts: pinFair != null ? r2(Math.abs(fair - pinFair) * 100) : null,
          sharpBooks: ['pinnacle'], share: { pct: r2(e.share * 100), pinTeamKills: r2(pin), mean, pinMean: e.booksPerMap > 0 ? r2(e.booksPerMap) : null },
          sources: [{ book: 'kill share', p: r2(fair * 100), exact: false }, ...(pinFair != null ? [{ book: 'pinnacle', p: r2(pinFair * 100), exact: false }] : [])],
        });
      }
    }
  }
  // one play per player and map: the rungs of one ladder are the same bet
  const best = new Map();
  for (const r of rows) {
    const k = `${r.group.split('|').slice(0, 5).join('|')}`;
    const b = best.get(k);
    if (!b || (r.clears - b.clears || r.ev - b.ev) > 0) best.set(k, r);
  }
  return { rows: [...best.values()], priced, teams: new Set([...best.values()].filter(r => r.clears).map(r => `${r.event}|${r.team}`)).size };
}

// Graded rows → record: overall, by side, by app, and by team (five players on
// one team move together, so the team count is the honest sample size)
function shareRecord(rows) {
  const groups = {};
  const add = (k, r) => {
    const g = groups[k] ||= { plays: 0, wins: 0, losses: 0, pushes: 0, profit: 0, teams: new Set(), clvN: 0, clvBeat: 0, clvSum: 0 };
    g.plays++;
    if (r.outcome === 'win') g.wins++; else if (r.outcome === 'loss') g.losses++; else g.pushes++;
    g.profit += r.profit || 0;
    g.teams.add(`${r.gameId ?? r.startTime}|${String(r.team || '').toLowerCase()}`);
    if (r.signalFair != null && r.closeFair != null) { g.clvN++; g.clvSum += r.closeFair - r.signalFair; if (r.closeFair > r.signalFair) g.clvBeat++; }
  };
  for (const r of rows || []) {
    if (r.status !== 'graded' || !['win', 'loss', 'push'].includes(r.outcome)) continue;
    add('all', r);
    add(r.signalSide === 'OVER' ? 'overs' : 'unders', r);
    add(`book ${r.signalBook}`, r);
    add(`sport ${r.sport}`, r);
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const decided = g.wins + g.losses;
    out[k] = { plays: g.plays, teams: g.teams.size, wins: g.wins, losses: g.losses, pushes: g.pushes,
      hitRate: decided ? +(g.wins / decided).toFixed(4) : null, profit: +g.profit.toFixed(2),
      roi: g.plays ? +(g.profit / g.plays * 100).toFixed(1) : null,
      closeMoved: g.clvN, closeBeat: g.clvBeat, closeAvgPts: g.clvN ? +(g.clvSum / g.clvN * 100).toFixed(2) : null };
  }
  return out;
}

module.exports = { DEFAULTS, PLAYER_K, TEAM_SD, shareProb, teamShares, shareMean, priceShare, priceBookPlayers, sharePlay, shareRecord };
