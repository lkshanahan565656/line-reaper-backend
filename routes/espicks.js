// Esports pick generation (Underdog first, PrizePicks as a bonus)
// Moved out of server.js as it was (the route split). It registers no routes,
// so mount(ctx) runs lower than the section used to sit, after the esports
// board and trackers it reads. ctx carries what it reads from server.js; it
// returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
const {
  CLV_WARN_N, CLV_WARN_SHARE, GAP_MIN_PTS, MATCHUP_PROVEN_N, alerter, anchorToMarket,
  attachLinesFair, autoPredAcceptable, autoSlips, bo3Health, cache, calcBookEV, calcEsportsEV,
  clvKind, createSlicer, describeContext, describePlayer, dotaCache, esSlipLog, esStaleState, escal,
  esgaps, esmarket, esmatch, esportsBoard, esportsCache, evenContext, fetchBo3PlayerStats,
  fetchDotaPlayerStats, fetchVLRPlayerStats, inferMapSpan, lineIsPlausible, lineSkew, lolPlayer,
  mapUndersState, marketFairProb, matchContext, nameKey, normalizeMarket, normalizeName,
  observeEsStale, oddsBook, opponentFrom, parseMapCount, parseMapSpan, pick6SlipOpts, pickCtx,
  pinGapTracker, pingap, ppLinesNow, predictKillsFromStats, predictLoLStat, priceH2HKills,
  priceKillShares, priceRoundKills, ratingsState, relabelMarket, runMapUnders, sleeperPricing,
  slipTracker, spanToMapList, splitMatchTitle, stackLegLookup, teamsMatch, tracker, trackerSportKey,
  trackerStatKind, udPricing, vlrKey, vlrStats, vlrTable
} = ctx;

const ES_TOKENS = ['CS','VAL','COD','CALL OF DUTY','DOTA','LOL','LEAGUE','ESPORT','CSGO','COUNTER','OVERWATCH','OW2','HALO','R6','RAINBOW','ROCKET'];
function isEsports(s) {
  const u = (s || '').toUpperCase();
  return ES_TOKENS.some(k => u.includes(k));
}

async function generateEsportsPicks() {
  // the build hands the event loop back every 20 ms (ops.createSlicer)
  const slice = createSlicer();
  const ppLines = ppLinesNow();
  const udLines = cache.underdog.data || [];

  // a started match's lines can't be played; a blocked book's cache keeps them
  const t0 = Date.now(), open = l => !(Date.parse(l.startTime || '') <= t0);
  const ppEsports = ppLines.filter(l => isEsports(l.sport) && open(l));
  const udEsports = udLines.filter(l => isEsports(l.sport) && open(l));

  // Each line's match (esmatch.js): a CS player in two or three Bo1s a day has
  // a "Kills on Map 1" per match, so lines are keyed by player, stat and match.
  // Sleeper lines take their start and title from an Underdog or PrizePicks line
  // against the same opponent (both teams' Sleeper lines share a game id).
  const slTeams = esmatch.sleeperTeams(cache.sleeper.data || []);
  const slEsports = [];
  const slSportOf = x => trackerSportKey(x.sport);
  const slRefs = esmatch.borrowRefs([...udEsports, ...ppEsports], { sportOf: slSportOf, now: t0 });
  for (const l of cache.sleeper.data || []) {
    const b = esmatch.borrowMatch(l, null, { slOpp: slTeams, sportOf: slSportOf, now: t0, bySport: slRefs });
    if (b) slEsports.push(b);
  }
  const tags = esmatch.matchTags([...ppEsports, ...udEsports, ...slEsports], { playerOf: l => normalizeName(l.player), sportOf: l => trackerSportKey(l.sport) });
  const lineKey = l => `${normalizeName(l.player)}|${normalizeMarket(l.market)}|${tags.get(l)}`;
  let unplaced = 0;
  const placed = l => { if (tags.get(l) == null) { unplaced++; return false; } return true; };

  // UD lookup, side-aware multipliers
  const udMap = {};
  for (const l of udEsports) {
    if (!l.player || l.line == null || !placed(l)) continue;
    udMap[lineKey(l)] = {
      line: l.line, overMultiplier: l.overMultiplier || 1.00, underMultiplier: l.underMultiplier || 1.00,
      overOpen: l.overOpen !== false, underOpen: l.underOpen !== false,
      market: l.market, sport: l.sport, player: l.player, team: l.team || '', startTime: l.startTime || '',
      matchTitle: l.matchTitle || '',
      gameId: l.gameId || null, matchTag: tags.get(l),
      matched: false,
    };
  }
  const slMap = {};
  for (const l of slEsports) if (placed(l)) slMap[lineKey(l)] = { ...l, matchTag: tags.get(l), matched: false };
  esportsCache.matchSplit = { players: new Set([...tags].filter(([, t]) => t != null).map(([l, t]) => `${normalizeName(l.player)}|${t}`)).size, unplaced };
  console.log(`Esports: PP=${ppEsports.length} UD=${udEsports.length} SL=${slEsports.length}/${(cache.sleeper.data || []).length} udMap=${Object.keys(udMap).length}`);

  // Limit fresh stat lookups per cycle so pick generation stays fast;
  // cached players are free and refresh hourly.
  let freshLookups = 0;
  const MAX_FRESH_LOOKUPS = 40;
  const implausibleLines = [];
  const spanCounts = { inferred: 0 };
  let priceMismatches = 0, closedSides = 0;
  const contextCounts = {};

  // What the record says so far: kinds of pick that keep losing get their
  // probability pulled down, kinds that keep winning get a little more (escal.js)
  // The market price (esmarket.js) is the default: the books' own lines and
  // payouts set the number, and our projection only nudges it by what the
  // record says it's worth. ESPORTS_MARKET=off goes back to model-first pricing.
  const marketOn = process.env.ESPORTS_MARKET !== 'off';
  let calib = null, weights = esmarket.modelWeights([]);
  let graded = [];
  try { graded = await tracker.list({ status: 'graded', limit: 100000 }); } catch (e) { console.warn('Esports: graded record unavailable:', e.message); }
  weights = esmarket.modelWeights(graded);
  const biases = esmarket.lineBias(graded);
  const matchupW = esmarket.matchupWeights(graded);
  if (process.env.ESPORTS_CALIBRATION !== 'off') {
    try {
      const prior = parseFloat(process.env.ESPORTS_CAL_PRIOR);
      // calibrate on picks priced the way the board prices now: the model-first
      // record says how wrong that model was, not how the market price does
      const rows = marketOn ? graded.filter(r => r.fair === 'market') : graded.filter(r => r.fair !== 'market');
      calib = escal.calibrate(rows, Number.isFinite(prior) && prior > 0 ? { prior } : {});
    } catch (e) { console.warn('Esports: calibration skipped:', e.message); }
  }
  esportsCache.calibration = calib ? { prior: calib.prior, buckets: Object.values(calib.buckets), at: new Date().toISOString() } : null;
  esportsCache.modelWeights = { market: marketOn, weights: Object.values(weights.table), lineBias: Object.values(biases.table), matchup: Object.values(matchupW.table), at: new Date().toISOString() };
  const marketCounts = { priced: 0, marketOnly: 0, multiBook: 0, dropped: 0 };

  // Where the books put this player, and the number the board prices with.
  // quotes: [{ book, line, over, under, overOpen, underOpen }]
  function marketize(base, g, quotes) {
    if (!marketOn || g.predSource === 'manual') return g;
    const statKind = normalizeMarket(base.market).split('|')[0];
    if (!['k', 'hs', 'ast'].includes(statKind)) return g;
    const ctxOpts = { context: g.context || null };
    const skews = new Map();
    const skewOf = ln => { if (!skews.has(ln)) skews.set(ln, lineSkew(ln, base.sport, base.market, ctxOpts)); return skews.get(ln); };
    const overFair = (ln, m) => {
      const r = calcEsportsEV(ln, m, 'OVER', base.sport, base.market, ctxOpts);
      return r ? Math.max(0.001, Math.min(0.999, (r.prob + skewOf(ln)) / 100)) : null;
    };
    const sk = trackerSportKey(base.sport), st = trackerStatKind(base.market);
    const cons = esmarket.consensus(quotes.filter(Boolean).map(q => ({ ...q, bias: biases.bias(sk, st, q.book) })), overFair);
    if (!cons) return g;
    const raw = g.predSource === 'auto' ? g.rawPred : null;
    let w = weights.weight(sk, st);
    if (g.sampleSize != null) w *= Math.min(1, Math.max(0.25, g.sampleSize / 40));
    // Matchup: the market's number moved by how favoured the player's team is
    // tonight against its usual opponent (context.js killFactor), at the weight
    // the graded record gives it (esmarket.matchupWeights)
    const mu = g.matchup && g.matchup.factor > 0 ? g.matchup : null;
    const muW = mu ? matchupW.weight(sk) : 0;
    const muAdj = mu ? 1 + muW * (mu.factor - 1) : 1;
    const mean = esmarket.blend(cons.mean, raw, w) * muAdj;
    const kept = cons.quotes.filter(q => !q.dropped);
    marketCounts.priced++;
    if (raw == null) marketCounts.marketOnly++;
    if (kept.length > 1) marketCounts.multiBook++;
    marketCounts.dropped += cons.quotes.length - kept.length;
    const fmtQ = q => `${q.book} ${q.line}${q.book === 'PP' ? '' : ` ${Math.round(q.pOver * 100)}% over`}${q.bias ? `, runs ${q.bias > 0 ? 'low' : 'high'} ${Math.abs(q.bias * 100).toFixed(0)}%` : ''}${q.dropped ? ' (left out)' : ''}`;
    const note = `market ${cons.mean.toFixed(1)} (${cons.quotes.map(fmtQ).join(', ')})${raw != null ? ` · model ${raw.toFixed(1)} at ${Math.round(w * 100)}% weight` : ''}${mu && Math.abs(muAdj - 1) >= 0.005 ? ` · matchup ×${muAdj.toFixed(3)} (${describeContext(mu)}, at ${Math.round(muW * 100)}% weight)` : ''}`;
    return {
      ...g, modelPred: mean, predSource: raw != null ? 'auto' : 'market', fair: 'market',
      market: { mean: cons.mean, quotes: cons.quotes, modelWeight: +w.toFixed(3), raw: raw != null ? +raw.toFixed(2) : null },
      matchupInfo: mu ? { source: mu.source, opponent: mu.opponent, pMap: +mu.pMap.toFixed(3), factor: +mu.factor.toFixed(4), weight: +muW.toFixed(3), adj: +muAdj.toFixed(4), baseMean: +esmarket.blend(cons.mean, raw, w).toFixed(3), h2h: mu.h2h || null } : null,
      statLine: [g.statLine, note].filter(Boolean).join(' · '),
    };
  }
  const udQuote = udm => udm && { book: 'UD', line: udm.line, over: udm.overMultiplier, under: udm.underMultiplier, overOpen: udm.overOpen, underOpen: udm.underOpen };
  const slQuote = slm => slm && { book: 'SL', line: slm.line, over: slm.overMultiplier, under: slm.underMultiplier, overOpen: slm.overOpen, underOpen: slm.underOpen };

  // Manual predictions are stored under the exact 'player|market' string the user
  // clicked on — but the same pick reads "MAPS 1-2 Kills" on PP and
  // "Kills on Maps 1+2" on UD. Normalized index makes a manual number stick to
  // the pick no matter which book's format is on screen.
  const manualNorm = {};
  for (const [k, v] of Object.entries(esportsCache.manualPredictions)) {
    const i = k.indexOf('|');
    if (i > 0) manualNorm[`${normalizeName(k.slice(0, i))}|${normalizeMarket(k.slice(i + 1))}`] = v;
  }

  async function getModelPred(lineObj) {
    const manualKey = `${lineObj.player}|${lineObj.market}`;
    let modelPred = esportsCache.manualPredictions[manualKey];
    if (modelPred == null) modelPred = manualNorm[`${normalizeName(lineObj.player)}|${normalizeMarket(lineObj.market)}`];
    let predSource = modelPred != null ? 'manual' : null;
    let rawPred = null, sampleSize = null, spanInferred = null, statLine = null, context = null;

    // only kills, headshots, assists and fantasy are modelled; a first-blood
    // line priced as kills would read as a huge under
    const statKind = normalizeMarket(lineObj.market).split('|')[0];
    if (modelPred == null && !['k', 'hs', 'ast', 'fp'].includes(statKind)) {
      return { modelPred: null, predSource: null, manualKey, rawPred, sampleSize, spanInferred, statLine, context };
    }
    if (modelPred == null) {
      const sportU = (lineObj.sport || '').toUpperCase();
      const mapCount = parseMapCount(lineObj.market);
      const plausible = lineIsPlausible(lineObj.line, mapCount, sportU, lineObj.market);
      if (!plausible) {
        implausibleLines.push(`${lineObj.player} · ${lineObj.market} · line ${lineObj.line} / ${mapCount} maps`);
      }
      let sportKey = null;
      if (sportU.includes('VAL')) sportKey = 'VAL';
      else if (sportU.includes('CS') || sportU.includes('COUNTER')) sportKey = 'CS';
      else if (sportU.includes('LOL') || sportU.includes('LEAGUE')) sportKey = 'LOL';
      else if (sportU.includes('DOTA')) sportKey = 'DOTA';

      let autoPred = null, usualWin = null;
      if (sportKey === 'LOL') {
        // Oracle's Elixir aggregates are in memory — no lookup budget needed
        const mk = (lineObj.market || '').toLowerCase();
        if (mk.includes('fantasy')) autoPred = null;   // FP needs the book's scoring formula — manual for now
        else autoPred = predictLoLStat(lineObj.player, mapCount, mk.includes('assist') ? 'assists' : 'kills');
        const lp = lolPlayer(lineObj.player);
        sampleSize = lp?.games ?? null;
        if (lp) statLine = `${lp.kpg.toFixed(1)} k/game · ${(lp.apg ?? 0).toFixed(1)} a/game · ${(lp.killShare != null ? (lp.killShare * 100).toFixed(0) + '% of team kills · ' : lp.kp ? Math.round(lp.kp * 100) + '% kill participation · ' : '')}${lp.games} games`;
      } else if (sportKey === 'VAL') {
        // the bulk table is free; a vlr.gg page lookup spends the per-cycle budget
        let player = null;
        const known = !!vlrTable.players[vlrKey(lineObj.player)] || vlrStats.cache.has(nameKey(lineObj.player));
        if (known || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!known) freshLookups++;
          player = await fetchVLRPlayerStats(lineObj.player, lineObj.team);
        }
        if (player) {
          autoPred = predictKillsFromStats(player, 'VAL', mapCount, lineObj.market);
          sampleSize = player.mapsPlayed ?? null;
          statLine = describePlayer(player);
        }
      } else if (sportKey === 'DOTA') {
        const hasCached = !!dotaCache.players[vlrKey(lineObj.player)];
        if (hasCached || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!hasCached) freshLookups++;
          const player = await fetchDotaPlayerStats(lineObj.player);
          if (player) {
            const mk = (lineObj.market || '').toLowerCase();
            // fantasy points need the book's scoring table, which we can't verify yet
            const per = mk.includes('fantasy') ? null : mk.includes('assist') ? player.avgAssistsPerMap : player.avgKillsPerMap;
            if (per) autoPred = per * mapCount;
            sampleSize = player.mapsPlayed ?? null;
            statLine = `${player.avgKillsPerMap.toFixed(1)} k/game · ${player.avgAssistsPerMap.toFixed(1)} a/game · ${player.mapsPlayed} ${player.pro === false ? 'public' : 'pro'} games`;
          }
        }
      } else if (sportKey) {
        let player = null;
        const hasCached = !!esportsCache.hltvPlayers[(lineObj.player || '').toLowerCase()];
        if (hasCached || freshLookups < MAX_FRESH_LOOKUPS) {
          if (!hasCached) freshLookups++;
          player = await fetchBo3PlayerStats(lineObj.player);
        }
        if (player) {
          autoPred = predictKillsFromStats(player, sportKey, mapCount, lineObj.market);
          sampleSize = player.mapsPlayed ?? null;
          statLine = describePlayer(player);
          // shrunk toward 50% by 10 maps, so a hot 6-map run doesn't read as his norm
          if (player.mapWinRate != null && player.mapsPlayed) {
            usualWin = (player.mapWinRate * player.mapsPlayed + 5) / (player.mapsPlayed + 10);
          }
        }
      }
      rawPred = autoPred;

      // A line far above the player's own per-map rate for the labelled span
      // ("Maps 1+2" priced like three maps) used to be rescaled to a longer
      // span. Underdog settles on its label, so the tracker graded those on a
      // span the book never used. Now the line is left unpriced: when the book
      // and our rate disagree by a whole map, the error is almost always ours.
      if (autoPred && sportKey !== 'LOL' && inferMapSpan(lineObj.line, autoPred, mapCount)) {
        spanCounts.inferred++;
        autoPred = null;
        rawPred = null;
      }

      // MATCH CONTEXT — scale per-map rate by the matchup and price the span
      // by how many maps are actually likely to be played.
      if (autoPred && plausible) {
        const spanMaps = spanInferred ? spanInferred : mapCount;
        const label = spanInferred ? `1-${spanInferred}` : parseMapSpan(lineObj.market).label;
        const maps = spanToMapList(label, spanMaps);
        // PrizePicks names the opponent in "ENCE MAP 1": without it a team in
        // three Bo1s a day was priced on whichever of its matches came up first
        const opponent = opponentFrom(lineObj.team, lineObj.matchTitle, null)
          || (lineObj.book !== 'sleeper' ? esmatch.lineOpponent({ ...lineObj, book: 'x' }) : null)
          || (lineObj.matchTitle && !splitMatchTitle(lineObj.matchTitle) && !/\d|map|game/i.test(lineObj.matchTitle) && !teamsMatch(lineObj.team, lineObj.matchTitle) ? lineObj.matchTitle : null);
        // the title's own name for the player's side, when it differs from the
        // roster name ("Team WE" vs "Xi'an Team WE"): the match prices use it
        const sides = splitMatchTitle(lineObj.matchTitle);
        const titleTeam = sides && opponent ? (sides[0] === opponent ? sides[1] : sides[1] === opponent ? sides[0] : null) : null;
        const ctxArgs = { sport: sportU, opponent, maps, usual: usualWin }, ctxDeps = { oddsBook, elo: ratingsState.elo };
        context = (titleTeam && titleTeam !== lineObj.team && matchContext({ ...ctxArgs, team: titleTeam }, ctxDeps))
          || matchContext({ ...ctxArgs, team: lineObj.team }, ctxDeps);
        // No price and no rating, but the span runs past the maps a Bo3 always
        // plays ("Maps 1+2+3"): a deciding map happens about half the time, not
        // always, so price it as an even matchup rather than a sure 3 maps.
        if (!context && Math.max(...maps) > 2) context = evenContext(maps, opponent);
        if (context) {
          const perMap = autoPred / spanMaps;
          autoPred = perMap * context.factor * context.expMaps;
          rawPred = autoPred;
          contextCounts[context.source] = (contextCounts[context.source] || 0) + 1;
        } else contextCounts.none = (contextCounts.none || 0) + 1;
      }

      // Never auto-model a line whose implied per-map rate is impossible
      autoPred = plausible ? anchorToMarket(autoPred, lineObj.line, sampleSize) : null;

      // SANITY GATE — his rule, kept: big % deviations are usually bad data,
      // with an absolute-diff pass for tiny LoL lines.
      if (autoPred && lineObj.line) {
        if (autoPredAcceptable(autoPred, lineObj.line)) {
          modelPred = autoPred;
          predSource = 'auto';
          if (sportKey === 'CS') bo3Health.predsAccepted++;
        } else {
          if (sportKey === 'CS') {
            bo3Health.predsRejected++;
            bo3Health.lastRejected = `${lineObj.player} line ${lineObj.line} → pred ${autoPred.toFixed(1)}`;
          }
          console.log(`Esports: rejected auto-pred for ${lineObj.player} (line=${lineObj.line}, pred=${autoPred.toFixed(1)}, ${(Math.abs(autoPred - lineObj.line) / lineObj.line * 100).toFixed(0)}% diff)`);
        }
      }
    }
    // The matchup (who's favoured, by the exchanges or ratings, plus head-to-head)
    // for the market price: read for every line, not only ones our model priced.
    let matchup = predSource === 'auto' ? context : null;
    if (!matchup && predSource !== 'manual' && ['k', 'hs', 'ast'].includes(statKind)) matchup = lineMatchup(lineObj);
    if (predSource !== 'auto') context = null;   // manual numbers are the user's own model
    if (context) statLine = [statLine, describeContext(context)].filter(Boolean).join(' · ');
    return { modelPred, predSource, manualKey, rawPred, sampleSize, spanInferred, statLine, context, matchup };
  }
  function lineMatchup(lineObj) {
    try {
      const span = parseMapSpan(lineObj.market);
      const maps = spanToMapList(span.label, span.count);
      // PrizePicks titles a line by the opponent's code and the span: "BFX MAPS 1-3"
      const ppOpp = /^(\S+)\s+MAPS?\s/i.exec(String(lineObj.matchTitle || ''))?.[1] || null;
      const opponent = opponentFrom(lineObj.team, lineObj.matchTitle, null) || ppOpp;
      const sides = splitMatchTitle(lineObj.matchTitle);
      const titleTeam = sides && opponent ? (sides[0] === opponent ? sides[1] : sides[1] === opponent ? sides[0] : null) : null;
      const ctxArgs = { sport: (lineObj.sport || '').toUpperCase(), opponent, maps }, ctxDeps = { oddsBook, elo: ratingsState.elo };
      return (titleTeam && titleTeam !== lineObj.team && matchContext({ ...ctxArgs, team: titleTeam }, ctxDeps))
        || matchContext({ ...ctxArgs, team: lineObj.team }, ctxDeps);
    } catch { return null; }
  }

  // Build one pick object. Only books that ACTUALLY carry the line get an EV —
  // no more fabricated Betr/ParlayPlay/Sleeper numbers with default multipliers.
  function assemble(base, modelPred, predSource, manualKey, udm, lineSource, g = {}, slm = null) {
    const lineVal = base.line;
    const pick = {
      sport: base.sport, player: base.player, team: base.team || '', matchTitle: base.matchTitle || '', market: base.market,
      ppLine: lineVal, startTime: base.startTime || '', lineSource,
      modelPred: modelPred != null ? parseFloat(modelPred.toFixed(2)) : null,
      predSource: modelPred != null ? predSource : null,
      rawPred: (predSource === 'auto' && g.rawPred != null) ? parseFloat(g.rawPred.toFixed(2)) : null,
      fairSource: modelPred != null ? (g.fair || 'model') : null,
      marketPred: g.market ? g.market.mean : null,
      matchup: g.matchupInfo || null,
      marketQuotes: g.market ? g.market.quotes : null,
      modelWeight: g.market ? g.market.modelWeight : null,
      sampleSize: g.sampleSize ?? null,
      spanInferred: g.spanInferred ?? null,
      displayMarket: g.spanInferred ? relabelMarket(base.market, g.spanInferred) : base.market,
      statLine: g.statLine ?? null,
      context: g.context ? {
        source: g.context.source, opponent: g.context.opponent, pMap: +g.context.pMap.toFixed(3),
        pLastMap: +g.context.pLastMap.toFixed(3), expMaps: +g.context.expMaps.toFixed(2),
        factor: +g.context.factor.toFixed(3), bestOf: g.context.bestOf,
      } : null,
      edge: null, edgePct: null,
      manualKey,
      side: null, prob: null, ev: null,
      ppEv: null, udEv: null, betrEv: null, parlayEv: null, sleeperEv: null,
      udMultiplier: null, sleeperMultiplier: null, udLine: udm ? udm.line : null, sleeperLine: slm ? slm.line : null, sleeperFlag: null,
      // both sides' payouts and which are open, for pricing either side (sharemodel.js)
      udSides: udm ? { over: udm.overMultiplier ?? null, under: udm.underMultiplier ?? null, overOpen: udm.overOpen !== false, underOpen: udm.underOpen !== false } : null,
      slSides: slm ? { over: slm.overMultiplier ?? null, under: slm.underMultiplier ?? null, overOpen: slm.overOpen !== false, underOpen: slm.underOpen !== false } : null,
      udRegime: null, udImplied: null, udFlag: null,
      bestBook: null, bestEv: null, bookEdge: null, confidence: null, varianceK: null,
      model: null, pushProb: 0, gameId: base.gameId ?? null,
      // the match this line is for (esmatch.js): one player, two Bo1s, two picks
      matchTag: base.matchTag ?? tags.get(base) ?? null,
      pricing: null,
    };
    if (modelPred == null || !lineVal) return pick;   // no model yet — still listed for input

    const ctxOpts = { context: g.context || null };
    pickCtx.set(pick, ctxOpts);   // the tracker prices CLV on the same curve
    // The book hangs its line where it sees 50/50, the median. Kill counts are
    // right-skewed, so a projection sitting right on the line still prices the
    // under at 55 to 62%: a lean that comes from the curve's shape, not from
    // anything we know. The skew is measured at the line and taken back out.
    // Auto projections only: they're anchored toward the line, which treats the
    // line as the book's mean. A hand-entered number is the user's own mean.
    const skewAt = ln => (predSource === 'auto' || predSource === 'market') ? lineSkew(ln, base.sport, base.market, ctxOpts) : 0;
    const skew = skewAt(lineVal);
    const over = calcEsportsEV(lineVal, modelPred, 'OVER', base.sport, base.market, ctxOpts);
    if (!over) return pick;
    const overFair = over.prob + skew;
    const side = overFair > 50.05 ? 'OVER' : overFair < 49.95 ? 'UNDER' : null;
    if (!side) return pick;
    // Only a side the book actually takes is a pick. UD-only lines with the
    // model's side closed stay listed with the projection but no side, so they
    // never reach Best Plays, entries, alerts or the tracked record.
    const onlyBook = lineSource === 'ud' ? udm : lineSource === 'sl' ? slm : null;
    if (onlyBook && (side === 'OVER' ? !onlyBook.overOpen : !onlyBook.underOpen)) {
      pick.sideClosed = side;
      const bookName = lineSource === 'sl' ? 'Sleeper' : 'Underdog';
      pick.statLine = [pick.statLine, `model leans ${side === 'OVER' ? 'Higher' : 'Lower'}, ${bookName} only offers ${side === 'OVER' ? 'Lower' : 'Higher'} on this line`].filter(Boolean).join(' · ');
      closedSides++;
      return pick;
    }
    const r = calcEsportsEV(lineVal, modelPred, side, base.sport, base.market, ctxOpts);
    if (!r) return pick;
    const sideSkew = side === 'OVER' ? skew : -skew;
    r.prob = escal.adjustPct(r.prob, sideSkew / 100);
    pick.skewPts = parseFloat(sideSkew.toFixed(2));

    // calibrate on the record: same shift on every line this pick is priced at
    const calShift = calib ? calib.shift(trackerSportKey(base.sport), trackerStatKind(base.market), side) : 0;
    pick.rawProb = parseFloat(r.prob.toFixed(2));
    pick.calShift = calShift || 0;
    if (calShift) {
      r.prob = escal.adjustPct(r.prob, calShift);
      r.confidence = r.prob > 62 ? 'HIGH' : r.prob > 56 ? 'MED' : 'LOW';
      const b = calib.bucket(trackerSportKey(base.sport), trackerStatKind(base.market), side);
      const rec = `${b.wins}-${b.losses} on ${b.sport} ${b.stat} ${side === 'OVER' ? 'overs' : 'unders'}`;
      pick.statLine = [pick.statLine, `record ${rec}: ${calShift > 0 ? '+' : ''}${(calShift * 100).toFixed(1)} pts`].filter(Boolean).join(' · ');
    }

    pick.side = side;
    pick.prob = parseFloat(r.prob.toFixed(2));
    // How far our number sits from the book's, in stat units and percent
    pick.edge = parseFloat((modelPred - lineVal).toFixed(2));
    pick.edgePct = parseFloat(((modelPred - lineVal) / lineVal * 100).toFixed(1));
    pick.confidence = r.confidence;
    pick.varianceK = r.varianceK;
    pick.model = r.model;
    pick.pushProb = r.pushProb;
    // everything a slip needs to re-price this leg inside a shared scenario
    pick.pricing = {
      line: lineVal, side, meanPerMap: r.meanPerMap, k: r.varianceK, stat: r.stat,
      scenarios: r.scenarios.map(x => ({ maps: x.maps, weight: +x.weight.toFixed(4) })),
      shift: (calShift || 0) + sideSkew / 100,
    };

    // each book's own line, probability and payout, for slips built on that book (slipbuild.js)
    const bookLegs = {};
    if (lineSource === 'pp') {
      pick.ppEv = parseFloat(calcBookEV(r.prob, 'prizepicks').toFixed(2));
      bookLegs.PP = { line: lineVal, shift: pick.pricing.shift, prob: r.prob / 100 };
    }
    pick.pricing.books = bookLegs;

    // Underdog listing the player isn't Underdog taking this side: a Higher-only
    // line gets no UD price on a Lower pick (it used to be priced at 1x and
    // could win best book on a PrizePicks-sourced pick).
    const udOpen = udm && (side === 'OVER' ? udm.overOpen !== false : udm.underOpen !== false);
    if (udm && !udOpen) pick.udClosed = true;
    if (udOpen) {
      const udSideMult = side === 'OVER' ? (udm.overMultiplier || 1.00) : (udm.underMultiplier || 1.00);
      let udShift = pick.pricing.shift;
      // UD's line can differ from PP's — price UD against ITS OWN line
      let udProb = r.prob;
      if (udm.line != null && udm.line !== lineVal) {
        const r2 = calcEsportsEV(udm.line, modelPred, side, base.sport, base.market, ctxOpts);
        const s2 = skewAt(udm.line);
        if (r2) udProb = escal.adjustPct(r2.prob, calShift + (side === 'OVER' ? s2 : -s2) / 100);
        udShift = calShift + (side === 'OVER' ? s2 : -s2) / 100;
      }
      const udP = udPricing(udProb, udSideMult, side === 'OVER' ? udm.underMultiplier : udm.overMultiplier);
      if (udP.ev != null) {
        bookLegs.UD = { line: udm.line ?? lineVal, shift: udShift, prob: udProb / 100, mult: udSideMult, decimal: udP.regime === 'decimal' };
      }
      pick.udEv = udP.ev != null ? parseFloat(udP.ev.toFixed(2)) : null;
      pick.udMultiplier = udSideMult;
      pick.udRegime = udP.regime;
      pick.udImplied = parseFloat(udP.implied.toFixed(1));
      pick.udProb = parseFloat(udProb.toFixed(2));   // our chance at Underdog's own line
      pick.udFlag = udP.flag;
      if (udP.flag) priceMismatches++;
    }

    if (slm) {
      const slMult = side === 'OVER' ? slm.overMultiplier : slm.underMultiplier;
      if (slMult) {
        let slProb = r.prob, slShift = pick.pricing.shift;
        if (slm.line !== lineVal) {
          const r3 = calcEsportsEV(slm.line, modelPred, side, base.sport, base.market, ctxOpts);
          const s3 = skewAt(slm.line);
          if (r3) slProb = escal.adjustPct(r3.prob, calShift + (side === 'OVER' ? s3 : -s3) / 100);
          slShift = calShift + (side === 'OVER' ? s3 : -s3) / 100;
        }
        const slP = sleeperPricing(slProb, slMult, side === 'OVER' ? slm.underMultiplier : slm.overMultiplier);
        if (slP.ev != null) bookLegs.SL = { line: slm.line, shift: slShift, prob: slProb / 100, mult: slMult };
        pick.sleeperEv = slP.ev != null ? parseFloat(slP.ev.toFixed(2)) : null;
        pick.sleeperMultiplier = slMult;
        pick.sleeperImplied = parseFloat(slP.implied.toFixed(1));
        pick.sleeperProb = parseFloat(slProb.toFixed(2));
        pick.sleeperFlag = slP.flag;
        if (slP.flag) priceMismatches++;
      }
    }

    const books = [['PP', pick.ppEv], ['UD', pick.udEv], ['SL', pick.sleeperEv]].filter(b => b[1] != null);
    if (books.length) {
      const best = books.reduce((a, b) => (b[1] > a[1] ? b : a));
      pick.bestBook = best[0];
      pick.bestEv = best[1];
      pick.ev = pick.ppEv ?? pick.udEv ?? pick.sleeperEv;
      // book-vs-book EV gap — under its own name so it can't clobber pick.edge,
      // which is our projection's distance from the line
      pick.bookEdge = parseFloat((best[1] - (pick.ppEv ?? best[1])).toFixed(2));
    }
    return pick;
  }

  const picks = [];

  // PP lines first (when PP is alive) — cross-matched to UD
  for (const line of ppEsports) {
    await slice();
    if (!line.player || line.line == null || !placed(line)) continue;
    const key = lineKey(line);
    const udm = udMap[key] || null, slm = slMap[key] || null;
    if (udm) udm.matched = true;
    if (slm) slm.matched = true;
    const g = marketize(line, await getModelPred(line), [{ book: 'PP', line: line.line }, udQuote(udm), slQuote(slm)]);
    picks.push(assemble(line, g.modelPred, g.predSource, g.manualKey, udm, 'pp', g, slm));
  }

  // UD lines with no PP counterpart — the board stays full even when PP is blocked
  for (const udm of Object.values(udMap)) {
    await slice();
    if (udm.matched) continue;
    const base = { sport: udm.sport, player: udm.player, team: udm.team, market: udm.market, line: udm.line, startTime: udm.startTime, matchTitle: udm.matchTitle, gameId: udm.gameId, matchTag: udm.matchTag };
    const slm = slMap[`${normalizeName(udm.player)}|${normalizeMarket(udm.market)}|${udm.matchTag}`] || null;
    if (slm) slm.matched = true;
    const g = marketize(base, await getModelPred(base), [udQuote(udm), slQuote(slm)]);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, udm, 'ud', g, slm));
  }

  // Sleeper lines neither PP nor UD carries
  for (const slm of Object.values(slMap)) {
    await slice();
    if (slm.matched) continue;
    const base = { sport: slm.sport, player: slm.player, team: slm.team, market: slm.market, line: slm.line, startTime: slm.startTime, matchTitle: slm.matchTitle, gameId: slm.gameId, matchTag: slm.matchTag };
    const g = marketize(base, await getModelPred(base), [slQuote(slm)]);
    picks.push(assemble(base, g.modelPred, g.predSource, g.manualKey, null, 'sl', g, slm));
  }

  if (implausibleLines.length) {
    esportsCache.implausible = implausibleLines.slice(0, 20);
    console.warn(`Esports: ${implausibleLines.length} lines skipped as implausible (market string may be parsed wrong) e.g. ${implausibleLines[0]}`);
  } else esportsCache.implausible = [];
  esportsCache.spanInferred = spanCounts.inferred;
  esportsCache.contextCounts = contextCounts;
  esportsCache.priceMismatches = priceMismatches;
  esportsCache.closedSides = closedSides;
  esportsCache.marketCounts = marketCounts;
  if (priceMismatches) console.log(`Esports: ${priceMismatches} book prices withheld — our fair sat more than 10 points above the book's implied chance`);
  if (spanCounts.inferred) console.log(`Esports: ${spanCounts.inferred} picks rescaled — line implied a longer map span than the market label claimed`);

  // Pinnacle's team kills against the books' five players (esmarket.teamKillBudget):
  // measured and tracked (byPinTeam), not priced until the record says so
  esportsCache.pinTeams = 0;
  try {
    const pinMatches = (esportsBoard.state.matches || []).filter(m => m.pinTeamKills && !m.live);
    const fam = p => { const s = trackerSportKey(p.sport); return s === 'LOL' || s === 'DOTA' ? s : null; };
    const sides = new Map();
    const sideOf = p => {
      if (sides.has(p)) return sides.get(p);
      // the pick's own match: its opponent (PrizePicks' "ENCE MAP 1" too), or the nearest start (esmatch.js)
      const g = fam(p);
      const hit = g ? esmatch.sideFor(pinMatches.filter(m => m.game === g), p) : null;
      sides.set(p, hit);
      return hit;
    };
    if (pinMatches.length) {
      esportsCache.pinTeams = esmarket.teamKillBudget(picks, {
        perMap: p => (fam(p) && normalizeMarket(p.market).split('|')[0] === 'k' && p.marketPred != null ? (p.matchup?.baseMean ?? p.marketPred) / parseMapCount(p.market) : null),
        teamOf: p => { const s = sideOf(p); return s ? `${s.m.id}|${s.i}` : null; },
        pinFor: p => {
          const s = sideOf(p);
          const v = spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market)).map(n => s?.m.pinTeamKills[n]?.[s.i]).filter(x => x > 0);
          return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
        },
      });
      const gaps = pingap.gapPlays(picks, { mapsOf: p => spanToMapList(parseMapSpan(p.market).label, parseMapCount(p.market)) });
      esportsCache.pinGapPlays = gaps.length;
      if (gaps.length) pinGapTracker.recordBoard(gaps).catch(e => console.warn('Pin gap tracker:', e.message));
      priceKillShares(picks, { fam, sideOf });
      for (const p of picks) if (p.pinTeam) {
        const f = p.pinTeam.factor;
        p.statLine = [p.statLine, `Pinnacle team kills ${p.pinTeam.pin.toFixed(1)} a map vs the books' ${p.pinTeam.books.toFixed(1)} (x${f.toFixed(2)})`].filter(Boolean).join(' · ');
      }
    }
  } catch (e) { console.warn('Esports: Pinnacle team kills skipped:', e.message); }
  await slice();
  try { priceRoundKills(picks); } catch (e) { console.warn('Esports: round model skipped:', e.message); }
  await slice();
  try { runMapUnders(picks); } catch (e) { mapUndersState.error = e.message; console.warn('Esports: map unders skipped:', e.message); }
  await slice();
  try { priceH2HKills(picks); } catch (e) { console.warn('Esports: head-to-head model skipped:', e.message); }
  await slice();
  try { attachLinesFair(picks); } catch (e) { console.warn('Esports: Lines fair for slips skipped:', e.message); }

  // Line gaps: the book a pick is played at sits on the soft side of another
  // book's line (PP Over 1.5 where Underdog and Sleeper hang 3.5). Worth
  // GAP_MIN_PTS points of win chance on the consensus or it's just noise.
  for (const p of picks) {
    if (!p.side || p.bestBook == null || p.marketPred == null) continue;
    const g = esgaps.lineGap(p, l => marketFairProb(p, l, p.side, pickCtx.get(p)), { minProbPts: GAP_MIN_PTS });
    if (g) p.lineGap = g;
  }

  // Matchup-led plays: +EV only because the matchup moved the number. The
  // matchup's weight is a prior until graded picks set it, so these stay on
  // the board (and in the record, BY MATCHUP) but leave Best Plays and alerts
  // until matchup-moved picks beat the close: MATCHUP_PROVEN_N moves, half or
  // more our way.
  let matchupProven = false, gapRecord = null;
  try {
    const sum = await tracker.summary();
    const mm = sum.byMatchup?.['matchup-led (no edge without it)'];
    matchupProven = !!mm && mm.mktMoved >= MATCHUP_PROVEN_N && mm.mktBeatShare >= 0.5;
    gapRecord = sum.byGap?.['line gap'] || null;
  } catch { /* unproven */ }
  esportsCache.matchupProven = matchupProven;
  for (const p of picks) {
    const m = p.matchup;
    if (!m || m.baseMean == null || !p.side || !(p.bestEv > 0) || !(p.prob > 0) || p.ppLine == null) continue;
    const at = mean => marketFairProb({ ...p, marketPred: mean }, p.ppLine, p.side, pickCtx.get(p));
    const withMu = at(p.modelPred), without = at(m.baseMean);
    if (withMu == null || without == null) continue;
    const d = (p.bestEv / 100 + 1) / (p.prob / 100);
    const evWithout = p.bestEv - (withMu - without) * d * 100;
    if (evWithout <= 0) { p.matchupLed = +evWithout.toFixed(2); if (!matchupProven) p.clvWarn = true; }
  }

  // Closing-line value by kind of pick (sport, stat, book, side): each play
  // carries how its kind's signals have done against the close. A kind whose
  // signals keep losing the close (CLV_WARN_N moves, under CLV_WARN_SHARE our
  // way) stays on the board but leaves Best Plays and alerts.
  try {
    const kinds = await tracker.clvByKind();
    for (const p of picks) {
      if (!p.side) continue;
      // a line gap is judged on the gaps' own record against the close, not
      // on its sport and stat's: a book off the others is a different bet
      if (p.lineGap) {
        const k = gapRecord;
        if (k && k.mktClvSample) {
          p.clvRecord = { n: k.mktClvSample, moved: k.mktMoved, beat: k.mktBeat, share: k.mktBeatShare, closeEv: k.closeEvAvg, gap: true };
          if (k.mktMoved >= CLV_WARN_N && k.mktBeatShare < CLV_WARN_SHARE) p.clvWarn = true;
        }
        continue;
      }
      const k = kinds[clvKind(p)];
      if (!k || !k.mktClvSample) continue;
      p.clvRecord = { n: k.mktClvSample, moved: k.mktMoved, beat: k.mktBeat, share: k.mktBeatShare, closeEv: k.closeEvAvg };
      if (k.mktMoved >= CLV_WARN_N && k.mktBeatShare < CLV_WARN_SHARE) p.clvWarn = true;
    }
  } catch (e) { console.warn('Esports: CLV by kind unavailable:', e.message); }

  await slice();
  picks.sort((a, b) => (b.bestEv ?? -999) - (a.bestEv ?? -999));
  esportsCache.picks = picks;
  esportsCache.lastUpdated = new Date().toISOString();
  esSlipLog.follow(picks).catch(e => console.warn('Esports slip legs:', e.message));
  try { observeEsStale(picks); } catch (e) { esStaleState.errors = [e.message, ...esStaleState.errors].slice(0, 5); console.warn('Esports stale lines:', e.message); }
  tracker.recordBoard(picks).catch(e => console.warn('Tracker: recordBoard failed:', e.message));
  await slice();
  try { const built = autoSlips(picks, pick6SlipOpts(picks)); slipTracker.record([...built.slips, ...(built.stacks || [])]).catch(e => console.warn('Slip tracker: record failed:', e.message)); }
  catch (e) { console.warn('Slip tracker: build failed:', e.message); }
  slipTracker.follow(stackLegLookup(picks)).catch(e => console.warn('Slip tracker: follow failed:', e.message));
  alerter.onBoard(picks.filter(p => !p.clvWarn)).catch(e => console.warn('Alerts: failed:', e.message));
  console.log(`Esports: generated ${picks.length} picks (${picks.filter(p => p.lineSource === 'ud').length} UD-sourced, ${picks.filter(p => p.lineSource === 'sl').length} Sleeper-sourced, ${picks.filter(p => p.sleeperEv != null).length} Sleeper-priced, ${picks.filter(p => p.predSource === 'manual').length} manual, ${picks.filter(p => p.modelPred == null).length} need model input)`);
  return picks;
}


return {
  isEsports, generateEsportsPicks
};
};
