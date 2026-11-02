// Esports endpoints: picks, matchups and the model report card
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.esBetsLib and ctx.esBooksState are set up further down server.js: read per request
const {
  ESPORTS_ALERT_MIN, ESPORTS_OPTS, H2H_ON, H2H_OPTS, MAP_UNDERS_ON, MATCHUPS_ON, MATCHUP_GAMES,
  ROUNDS_OPTS, SHARE_OPTS, TAIL_REGION, aggregateLPRows, app, axios, bo3ExtractProfile, bo3RawStats,
  bo3SearchPlayer, cache, calcEsportsEV, dotaCache, dotaLoadProPlayers,
  esStaleTracker, esboard, esgaps, esportsBoard, esportsBoardFor, esportsCache, fetchBo3PlayerStats,
  fetchDotaPlayerStats, fetchVLRPlayerStats, generateEsportsPicks, h2hState, h2hTracker, h2hmodel,
  hasPro, isAdmin, isEsports, licenceState, lineIsPlausible, lolPlayer, lolStats, lpFetchPage,
  mapUndersModelTracker, mapUndersState, mapUndersTracker, mapunders, matchupEngine, matchupEngines,
  parseMapSpan, pinGapTracker, pinTotals, pingap, pintotals, predictEsportsSide, predictLoLKills,
  redactForFree, refreshVLRTable, requireAdmin, roundmodel, roundsTracker, shareTracker, sharemodel,
  slipTracker, sportProps, tracker, vlrTable
} = ctx;

app.get('/api/esports/matches', (req, res) => {
  let matches = esportsBoardFor(req);
  const game = String(req.query.game || '').toUpperCase();
  if (game && game !== 'ALL') matches = matches.filter(m => m.game === game);
  if (req.query.edges === '1') matches = matches.filter(m => m.edges.length || m.arbs.length);
  if (req.query.live === '0') matches = matches.filter(m => !m.live);
  const st = esportsBoard.state;
  res.json({
    matches, count: matches.length, updated: st.updated, counts: st.counts, calibration: st.calibration, errors: st.errors.slice(0, 5), pro: hasPro(req), region: TAIL_REGION,
    games: Object.fromEntries(Object.entries(esboard.GAMES).map(([k, g]) => [k, g.label])),
    rules: { edgeMin: esboard.DEFAULTS.edgeMin, ...ESPORTS_OPTS, alertMin: ESPORTS_ALERT_MIN },
  });
});
// ── matchups (head-to-head engine): LoL, CS2, VALORANT ──
const GAME_WORD = { LOL: 'LoL', CS2: 'CS2', VAL: 'VALORANT' };
const matchupNote = game => `Our own model: team ratings from every finished ${GAME_WORD[game] || game} series, a series-shape adjustment and a small head-to-head term. It is a model, not a proven edge: in the walk-forward backtest Kalshi's price beat it, and betting its side lost after fees.`;
// ?game= picks the engine (default LoL); null when that game is off
const engineFor = req => matchupEngines[String(req.query.game || 'LOL').toUpperCase()] || null;
function matchupBacktestSummary(engine = matchupEngine) {
  const b = engine?.state.backtest;
  if (!b) return null;
  const k = b.kalshi?.['T-60'], k30 = b.kalshi?.['T-30'];
  return {
    generated: b.generated, verdict: b.verdict, data: b.data,
    allSeries: { test: b.allSeries?.test, coinFlip: b.allSeries?.coinFlip },
    kalshi: k ? { n: k.n, logLoss: k.logLoss, brier: k.brier, t: k.llGapT, sides5: k.bets?.find(x => x.edgePts === 5) || null, major: k.major?.logLoss, other: k.other?.logLoss } : null,
    kalshi30: k30 ? { n: k30.n, logLoss: k30.logLoss } : null,
  };
}
const matchupOff = (res, req) => res.status(503).json({ error: MATCHUPS_ON ? `No matchup engine for ${String(req?.query?.game || 'LOL').toUpperCase()} (ESPORTS_MATCHUPS_GAMES=${MATCHUP_GAMES.join(',')}).` : 'Matchups are off (ESPORTS_MATCHUPS=off).', games: Object.keys(matchupEngines) });
app.get('/api/esports/matchups', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const game = E.status().game;
  const days = Math.min(14, Math.max(1, parseInt(req.query.days, 10) || 8));
  const league = req.query.league ? String(req.query.league) : null;
  const matchups = E.list({ days, league, board: esportsBoardFor(req) });
  // Pinnacle's no-vig series price beside the venues (the number a logged bet is graded against), when its feed is fresh
  const pinAt = Date.parse(ctx.esBooksState.pinAt || '');
  if (Date.now() - pinAt <= ctx.esBetsLib.PIN_MAX_AGE_MS) {
    for (const mu of matchups) {
      const pf = ctx.esBetsLib.pinFair(ctx.esBooksState.pin, game, mu.teams.map(x => x.name), mu.start, 0);
      if (pf) mu.pinnacle = { prob: pf.p, at: ctx.esBooksState.pinAt };
    }
  }
  res.json({
    game, label: 'model', note: matchupNote(game), games: Object.keys(matchupEngines), status: E.status(), count: matchups.length,
    priced: matchups.filter(m => m.model.priced).length, withKalshi: matchups.filter(m => m.markets?.kalshi).length,
    leagues: [...new Set(matchups.map(u => u.league).filter(Boolean))].sort(),
    matchups, backtest: matchupBacktestSummary(E), record: E.record().summary, licence: licenceState(req),
  });
});
app.get('/api/esports/matchups/backtest', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  res.json(E.state.backtest || { error: `No backtest file for ${E.status().game}.` });
});
app.get('/api/esports/matchups/record', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  res.json({ note: `Model number frozen 10-45 minutes before each ${GAME_WORD[E.status().game]} series with a Kalshi price, Kalshi followed to the start, graded on the result. Model view, not a bet.`, ...E.record() });
});
app.get('/api/esports/matchups/ratings', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const R = E.ratings();
  const league = req.query.league ? String(req.query.league) : null;
  res.json({ game: E.status().game, label: 'model', leagues: R.leagues(), teams: R.table({ league }).slice(0, 300), opts: R.opts });
});
app.get('/api/esports/matchups/team/:name', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const R = E.ratings();
  const tm = R.find(req.params.name);
  if (!tm) return res.status(404).json({ error: `No such team in our ${GAME_WORD[E.status().game]} data.` });
  res.json({ game: E.status().game, label: 'model', team: R.teamView(tm) });
});
app.get('/api/esports/matchups/:id', (req, res) => {
  const E = engineFor(req);
  if (!E) return matchupOff(res, req);
  const m = E.get(req.params.id, { board: esportsBoardFor(req) });
  if (!m) return res.status(404).json({ error: `No upcoming ${GAME_WORD[E.status().game]} series with that id.` });
  res.json({ game: E.status().game, label: 'model', note: matchupNote(E.status().game), matchup: m });
});
// one build at a time: a page load and a refresh share a run in flight.
// Two builds at once (new stats landing during a lines rebuild) could finish
// out of order and leave the older board up, and both would log and alert.
let esPicksRun = null, esPicksAgain = false;
function esPicksOnce() {
  if (!esPicksRun) esPicksRun = generateEsportsPicks().finally(() => {
    esPicksRun = null;
    if (esPicksAgain) { esPicksAgain = false; esPicksOnce().catch(() => {}); }
  });
  return esPicksRun;
}
// new data landed: build now, or once more when the build in flight is done
function esPicksRebuild() {
  if (esPicksRun) { esPicksAgain = true; return esPicksRun; }
  return esPicksOnce();
}
// Pinnacle team kill gaps: the record by gap size, and the plays (pingap.js)
app.get('/api/esports/pingaps', async (req, res) => {
  try {
    const rows = await pinGapTracker.list({ limit: 5000 });
    res.json({ note: 'Plays on Pinnacle\'s side where its team kills and the books\' five players part by 3%+. Tracked to test the gap; not priced or alerted.',
      teamsNow: esportsCache.pinTeams || 0, playsNow: esportsCache.pinGapPlays || 0,
      record: pingap.gapRecord(rows), totals: pinTotalsSummary(), rows: rows.slice(0, +req.query.limit || 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pinnacle's map totals against the maps played (pintotals.js): the scoreboard
// by title, what the kill models use now (fitted or assumed), and the rows
function pinTotalsSummary() {
  const rows = [...pinTotals.rows.values()];
  return { graded: rows.filter(r => r.status === 'graded').length, open: rows.filter(r => r.status === 'open').length,
    close: pintotals.scoreboard(rows), signal: pintotals.scoreboard(rows, { snap: 'signal' }), fit: pinTotals.fit, minMaps: pintotals.DEFAULTS.minMaps, last: pinTotals.last };
}
app.get('/api/esports/pintotals', async (req, res) => {
  try {
    await pinTotals.ready;
    const rows = [...pinTotals.rows.values()].sort((a, b) => String(b.start).localeCompare(String(a.start)));
    const status = req.query.status;
    res.json({ note: `Pinnacle's pregame totals on each map (rounds for CS2 and Valorant, team kills for LoL and Dota) against the maps played. err = actual - Pinnacle's 50/50 point; over = how often the over at its main line hit, next to the chance Pinnacle gave it. The kill models use a title's fitted spread once it has ${pintotals.DEFAULTS.minMaps} graded maps; until then the assumed one.`,
      ...pinTotalsSummary(), rows: rows.filter(r => !status || r.status === status).slice(0, Math.min(+req.query.limit || 300, 3000)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kill-share plays: the record (sharemodel.js) and today's priced lines
app.get('/api/esports/share', async (req, res) => {
  try {
    const rows = await shareTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.share?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      share: p.share.share, raw: p.share.raw, games: p.share.games, pinPerMap: p.share.pinPerMap, mean: p.share.mean, pinMean: p.share.pinMean, marketPred: p.marketPred,
      lines: esgaps.bookLines(p), best: p.share.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Pinnacle's team kills x each player's share of his team's kills. ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      now: esportsCache.share || null, minEv: SHARE_OPTS.minEv, agreePts: SHARE_OPTS.agreePts,
      record: sharemodel.shareRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Head-to-head plays: the record (h2hmodel.js), today's priced lines and the
// data behind them
app.get('/api/esports/h2h', async (req, res) => {
  try {
    const rows = await h2hTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.h2h?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      game: p.h2h.game, mean: p.h2h.mean, perMap: p.h2h.perMap, own: p.h2h.own, share: p.h2h.share, teamKills: p.h2h.teamKills, vs: p.h2h.opp, scenarios: p.h2h.scenarios,
      shareMean: p.share?.mean ?? null, marketPred: p.marketPred, lines: esgaps.bookLines(p), best: p.h2h.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Our matchup model: each player's share of his team's kills x the kills his team makes against this opponent. A leg is a play only where Pinnacle's kill-share fair agrees. ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      on: H2H_ON, now: esportsCache.h2h || null, minEv: H2H_OPTS.minEv, agreePts: H2H_OPTS.agreePts,
      data: { refreshedAt: h2hState.refreshedAt, added: h2hState.added, errors: h2hState.errors, golAt: h2hState.golAt },
      params: h2hmodel.TITLES,
      record: h2hmodel.h2hRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Round-model plays: the record (roundmodel.js) and today's priced lines
app.get('/api/esports/rounds', async (req, res) => {
  try {
    const rows = await roundsTracker.list({ limit: 5000 });
    const priced = (esportsCache.picks || []).filter(p => p.rounds?.priced).map(p => ({ player: p.player, team: p.team, sport: p.sport, market: p.market, startTime: p.startTime,
      kpr: p.rounds.kpr, raw: p.rounds.raw, maps: p.rounds.maps, scale: p.rounds.scale, lineup: p.rounds.lineup, roundsPerMap: p.rounds.roundsPerMap, qs: p.rounds.ctx.qs,
      mean: p.rounds.mean, pinMean: p.rounds.pinMean, marketPred: p.marketPred, lines: esgaps.bookLines(p), best: p.rounds.priced }));
    const graded = rows.filter(r => r.status === 'graded').length;
    res.json({ note: `Pinnacle's rounds on each map x the player's kills a round (CS2, Valorant). ${graded ? `${graded} graded` : 'Not graded yet'}; tracked, not alerted.`,
      now: esportsCache.rounds || null, minEv: ROUNDS_OPTS.minEv, agreePts: ROUNDS_OPTS.agreePts, books: ctx.esBooksState.summary?.roundModel || null,
      record: roundmodel.roundsRecord(rows), priced: hasPro(req) ? priced : priced.length, rows: hasPro(req) ? rows.slice(0, +req.query.limit || 500) : rows.filter(r => r.status === 'graded').slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Map kill Unders (mapunders.js): the pre-registered record per game and app,
// and today's app match-maps against Pinnacle's map number. Public: research,
// the same for everyone, nothing alerts.
app.get('/api/esports/map-unders', async (req, res) => {
  try {
    const [ruleRows, modelRows] = await Promise.all([mapUndersTracker.list({ limit: 1e6 }), mapUndersModelTracker.list({ limit: 1e6 })]);
    const pick = r => ({ id: r.id, status: r.status, game: r.game || r.sport, app: r.appKey || r.signalBook, map: r.span ?? r.mapN ?? null, player: r.player, team: r.team, matchTitle: r.matchTitle,
      startTime: r.startTime, signalAt: r.signalAt, line: r.signalLine, closeLine: r.closeLine, be: r.be ?? null, fair: r.modelProb ?? null, closeFair: r.closeFair ?? null,
      appSum: r.appSum ?? null, anchor: r.anchor ?? null, anchorSrc: r.anchorSrc || null, result: r.result, outcome: r.outcome, profit: r.profit, note: r.note || null });
    const recent = rows => rows.filter(r => r.status !== 'open').sort((a, b) => String(b.startTime).localeCompare(String(a.startTime))).slice(0, Math.min(+req.query.limit || 200, 2000)).map(pick);
    res.set('Cache-Control', 'public, max-age=30').json({
      label: 'research, not an edge', alerts: false, on: MAP_UNDERS_ON,
      rule: 'Unders on Map 1, Map 2 and Maps 1-2 kills where Pinnacle\'s number for the map sits under the app\'s own lines summed (4+ players a team, scaled to five). A play is a flagged Under our model prices past the app\'s break-even by a point. Pre-registered 2026-10-26 16:56Z.',
      bar: { graded: mapunders.DEFAULTS.target, matches: mapunders.DEFAULTS.minMatches, z: 2, zBy: 'match' },
      breakEvens: { PP: sportProps.PP_GRADE.be, UD: 'its implied % / the Under multiplier', SL: '1 / the Under multiplier' },
      now: { at: mapUndersState.at, counts: mapUndersState.counts, error: mapUndersState.error, groups: mapUndersState.groups },
      record: { model: mapunders.mapRecord(modelRows), rule: mapunders.mapRecord(ruleRows), rule5: mapunders.mapRecord(ruleRows.filter(r => r.under5)) },
      rows: { model: recent(modelRows), rule: recent(ruleRows) },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ESPORTS MODEL REPORT CARD (esmodels.js, v3.145.0) ──
// Every esports record against the break-even its payouts set, at the
// 50-graded bar, and the same-match stacks' sweeps against the payout the
// app must show. Rebuilt at most every 5 minutes; the Lines table reads the
// verdicts (a failed model's legs stop showing as plays).
const esmodels = require('../esmodels');
const esModelsState = { at: 0, cards: null, stacks: null, error: null };
async function esModelCards(force = false) {
  if (!force && esModelsState.cards && Date.now() - esModelsState.at < 5 * 60e3) return esModelsState;
  try {
    const recs = { esports: tracker, h2h: h2hTracker, rounds: roundsTracker, share: shareTracker, esStale: esStaleTracker };
    const rows = {};
    for (const [k, t] of Object.entries(recs)) rows[k] = await t.list({ limit: 1e6 });
    Object.assign(esModelsState, { at: Date.now(), cards: esmodels.modelCards(rows), stacks: esmodels.stackCards(await slipTracker.list()), error: null });
  } catch (e) { esModelsState.error = e.message; }
  return esModelsState;
}
if (require.main === module) setTimeout(() => esModelCards(true).catch(() => {}), 90e3);
app.get('/api/esports/models', async (req, res) => {
  try {
    const s = await esModelCards();
    if (!s.cards) return res.status(503).json({ error: s.error || 'not ready' });
    res.json({ note: `Each esports record against the hit rate its payouts need, at ${esmodels.MIN_N} graded. failed = 2+ standard errors under break-even; beats = 2+ over, which still needs an independent re-check before anyone bets it. Rows from days a team played twice and priced before the match tag existed are left out. Stacks: the payout an all-legs-win entry needs for the record so far to have broken even.`,
      at: new Date(s.at).toISOString(), minN: esmodels.MIN_N, models: s.cards, stacks: s.stacks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/esports/picks', async (req, res) => {
  const fresh = esportsCache.lastUpdated &&
    (Date.now() - new Date(esportsCache.lastUpdated).getTime()) < 300000;
  // a cold cache waits for the first build; a stale one answers at once and
  // rebuilds behind, so the board never hangs on a slow stats lookup
  if (!(esportsCache.picks || []).length) await esPicksOnce();
  else if (!fresh) esPicksOnce().catch(() => {});
  const pro = hasPro(req);
  // an EV filter would let a free user find each locked pick's EV by bisection
  const minEV = pro ? (parseFloat(req.query.minEV) || -100) : -100;
  const sport = req.query.sport;
  // the board rebuilds every few minutes, and a book that stops answering
  // (PrizePicks 429s) leaves its last lines in place: a line whose match has
  // started can't be played, so it leaves the board the minute it starts
  const now = Date.now();
  let picks = (esportsCache.picks || []).filter(p => !(Date.parse(p.startTime || '') <= now));
  if (sport) picks = picks.filter(p => (p.sport || '').toUpperCase().includes(sport.toUpperCase()));
  picks = picks.filter(p => p.ev == null || p.ev >= minEV);
  if (!pro) picks = redactForFree(picks);
  res.json({ picks, count: picks.length, updated: esportsCache.lastUpdated, pro, locked: pro ? 0 : picks.filter(p => p.locked).length });
});

let lastManualRefresh = 0;
app.post('/api/esports/refresh', async (req, res) => {
  // anyone can ask, but only the admin can force more than one rebuild a minute
  if (!isAdmin(req) && Date.now() - lastManualRefresh < 60000) return res.json({ ok: true, count: esportsCache.picks.length, cached: true });
  lastManualRefresh = Date.now();
  await esPicksOnce();
  res.json({ ok: true, count: esportsCache.picks.length });
});

app.post('/api/esports/predict', (req, res) => {
  const { ppLine, modelPred, sport, propText, side } = req.body;
  if (!ppLine || !modelPred) return res.status(400).json({ error: 'ppLine and modelPred required' });
  const result = side
    ? calcEsportsEV(ppLine, modelPred, side, sport, propText)
    : predictEsportsSide(ppLine, modelPred, sport, propText);
  res.json(result);
});

// Manual model numbers change everyone's board and the public track record.
app.post('/api/esports/manual', requireAdmin, (req, res) => {
  const { player, market, modelPred } = req.body;
  if (!player || !market) return res.status(400).json({ error: 'player and market required' });
  const key = `${player}|${market}`;
  if (modelPred == null) delete esportsCache.manualPredictions[key];
  else esportsCache.manualPredictions[key] = parseFloat(modelPred);
  res.json({ ok: true, key, value: esportsCache.manualPredictions[key] });
});

app.get('/api/esports/manual', (req, res) => {
  res.json(esportsCache.manualPredictions);
});

app.get('/api/esports/player/:sport/:name', async (req, res) => {
  const { sport, name } = req.params;
  let stats = null;
  if (sport.toLowerCase().includes('val')) stats = await fetchVLRPlayerStats(name);
  else if (sport.toLowerCase().includes('lol')) stats = lolPlayer(name);
  else if (sport.toLowerCase().includes('cs')) stats = await fetchBo3PlayerStats(name);
  res.json(stats || { error: 'Player not found' });
});

// What does Underdog ACTUALLY call each esports market, and what lines come
// with it? Distinct market strings with line ranges + how we parse each one.
app.get('/api/esports/probe/udmarkets', (req, res) => {
  const rows = (cache.underdog.data || []).filter(l => isEsports(l.sport));
  const byMarket = {};
  for (const l of rows) {
    const k = `${l.sport} :: ${l.market}`;
    const B = byMarket[k] || (byMarket[k] = { sport: l.sport, market: l.market, count: 0, lines: [], samplePlayers: [] });
    B.count++;
    if (l.line != null) B.lines.push(l.line);
    if (B.samplePlayers.length < 3) B.samplePlayers.push(`${l.player} ${l.line}`);
    if (l.overOpen === false) B.lowerOnly = (B.lowerOnly || 0) + 1;
    if (l.underOpen === false) B.higherOnly = (B.higherOnly || 0) + 1;
  }
  const out = Object.values(byMarket).map(B => {
    const ls = B.lines.slice().sort((a, b) => a - b);
    const span = parseMapSpan(B.market);
    const med = ls.length ? ls[Math.floor(ls.length / 2)] : null;
    return {
      sport: B.sport, market: B.market, count: B.count,
      lineMin: ls[0] ?? null, lineMedian: med, lineMax: ls[ls.length - 1] ?? null,
      parsedMaps: span.count, parsedLabel: span.label,
      impliedPerMap: med != null ? +(med / span.count).toFixed(2) : null,
      plausible: lineIsPlausible(med, span.count, B.sport, B.market),
      higherOnly: B.higherOnly || 0, lowerOnly: B.lowerOnly || 0,
      samplePlayers: B.samplePlayers,
    };
  }).sort((a, b) => b.count - a.count);
  res.json({ totalEsportsLines: rows.length, markets: out });
});

// Which pick'em books answer from Railway (bookprobe.js)
require('../bookprobe').mountBookProbe(app, axios);

// Per-sport source inspectors
// NOTE: two explicit routes instead of an optional ":name?" param — Express 5
// removed optional-param syntax and throws at startup on it.
async function valProbe(req, res) {
  if (!vlrTable.updated) await refreshVLRTable().catch(() => {});
  const name = req.params.name;
  res.json({
    source: 'vlr.gg mirror', players: Object.keys(vlrTable.players).length,
    regions: vlrTable.regions, updated: vlrTable.updated, lastError: vlrTable.lastError,
    lookup: name ? await fetchVLRPlayerStats(name) : null,
    sample: Object.values(vlrTable.players).slice(0, 5),
  });
}
app.get('/api/esports/probe/val', valProbe);
app.get('/api/esports/probe/val/:name', valProbe);

async function dotaProbe(req, res) {
  try {
    const dir = await dotaLoadProPlayers();
    res.json({
      source: 'opendota', indexedNames: Object.keys(dir).length, lastError: dotaCache.lastError,
      lookup: req.params.name ? await fetchDotaPlayerStats(req.params.name) : null,
    });
  } catch (e) { res.json({ error: e.message, status: e.response?.status }); }
}
app.get('/api/esports/probe/dota', dotaProbe);
app.get('/api/esports/probe/dota/:name', dotaProbe);

// Raw Leaguepedia inspector — shows exactly what the wiki returns
app.get('/api/esports/probe/lolsource', async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  try {
    const rows = await lpFetchPage(since, 0, 5);
    res.json({ ok: true, since, rowsReturned: rows.length, sample: rows.slice(0, 5), parsed: aggregateLPRows(rows) });
  } catch (e) {
    res.json({ ok: false, error: e.message, status: e.response?.status, body: String(e.response?.data || '').slice(0, 500) });
  }
});

// Raw-source inspector: paste this output in chat if a parse ever misses
app.get('/api/esports/probe/:sport/:name', async (req, res) => {
  const { sport, name } = req.params;
  const s = sport.toLowerCase();
  try {
    if (s.includes('lol')) {
      return res.json({ source: 'oracles-elixir', updated: lolStats.updated,
        player: lolStats.players[name.toLowerCase()] || null,
        prediction12: predictLoLKills(name, 2) });
    }
    if (s.includes('val')) return res.json({ source: 'vlr', player: await fetchVLRPlayerStats(name) });
    const found = await bo3SearchPlayer(name);
    if (!found?.slug) return res.json({ source: 'bo3', error: 'no search hit for that name' });
    const raw = await bo3RawStats(found.slug);
    res.json({ source: 'bo3', found, raw, parsed: bo3ExtractProfile(name, raw.gen, raw.map, raw.acc) });
  } catch (e) { res.status(502).json({ error: `The stats source did not answer: ${String(e.message || e).slice(0, 120)}` }); }
});

app.get('/api/prizepicks', (req, res) => {
  const sport = req.query.sport;
  let data = cache.prizepicks.data || [];
  if (sport) data = data.filter(l => l.sport.toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.prizepicks.updated, count: data.length });
});

app.get('/api/underdog', (req, res) => {
  const sport = req.query.sport;
  let data = cache.underdog.data || [];
  if (sport) data = data.filter(l => (l.sport||'').toLowerCase() === sport.toLowerCase());
  res.json({ data, updated: cache.underdog.updated, count: data.length });
});

app.get('/api/sleeper', (req, res) => res.json({ data: [...(cache.sleeper.data || []), ...(cache.sleeperSports.data || [])] }));


return {
  esPicksOnce, esPicksRebuild, esModelsState, esModelCards
};
};
