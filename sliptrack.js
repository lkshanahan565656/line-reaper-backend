// ─── BEST SLIPS: TRACK RECORD ─────────────────────────────────────────────────
// Every +EV slip the Best Slips panel shows (slipbuild.js) is logged once, at
// the legs, lines and payout it was first shown with, and graded from the same
// match stats the pick tracker uses. 1u staked a slip: a sweep pays the table's
// multiplier, a flex entry pays on its hit count, anything else loses the unit.
//
// A leg's result is the player's stat over the book's span. It's taken from the
// pick tracker when that already graded the same player, market and match, and
// asked of the sport's grader otherwise (slip legs aren't all on the pick
// record, which only logs +EV picks). A leg the books would void (did not play,
// a push, a series that ended before the span) voids the slip: the apps
// re-price those entries, and that re-price isn't modelled here.

const { createMemoryStore } = require('./evtrack');
const { sportKey, statKind, spanToMaps, outcomeFor } = require('./tracker');

const HOUR = 3600e3;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function legKey(l) {
  const day = l.startTime ? String(l.startTime).slice(0, 10) : 'nostart';
  return [sportKey(l.sport), norm(l.player), norm(l.rawMarket || l.market), l.line, l.side, l.gameId ?? day].join('|');
}
// A same-match stack is logged once per match, book and side: the board
// rebuilds every few minutes and the best stack's legs shift as lines move,
// and counting each version would weigh one match many times.
// The model's stacks (kind 'es-stacks', esstackmodel.js) keep their own ids
// the same way, so the two records never share a row.
const isMatchStack = kind => kind === 'stack' || kind === 'es-stacks';
const slipId = s => (isMatchStack(s.kind)
  ? `${s.book}|${s.kind === 'stack' ? 'stack' : 'es-stacks'}|${s.picks[0]?.gameId ?? legKey(s.picks[0])}|${s.picks[0]?.side}`
  : `${s.book}|${s.table}|${s.picks.map(legKey).sort().join('+')}`);

// a slip's payout on h hits, 1u staked
function payout(row, hits) {
  return row.payTable?.[hits] ?? 0;
}

// The stack record: how often stacks swept against what they were priced at,
// how the legs hit against their own prices, and how the legs closed.
//   swept / expectedSwept / independentSwept: every leg won; the sum of the
//     priced chance of that; the same if the legs had been independent.
//   matches: distinct matches behind them (one match is logged once per app
//     and side, so stacks overstate how much evidence there is).
//   legs: how often the legs won against their average price, in points.
//   close: each leg's chance at its own line just before the match (follow());
//     move = average points it moved from its price, lineMoves / toward = legs
//     whose line moved and how many moved our way (up for an OVER).
// stacks that share a player on the same day are one match (the apps name
// teams differently, so players join them)
function countMatches(rows) {
  const parent = rows.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map();
  rows.forEach((r, i) => {
    for (const l of r.legs) {
      const k = `${String(r.start || '').slice(0, 10)}|${norm(l.player)}`;
      if (seen.has(k)) parent[find(i)] = find(seen.get(k)); else seen.set(k, i);
    }
  });
  return new Set(rows.map((_, i) => find(i))).size;
}
function stackStats(graded, started) {
  const legs = graded.flatMap(r => r.legs);
  const won = legs.filter(l => l.outcome === 'win').length;
  const priced = avg(legs.map(l => l.prob));
  const startedLegs = started.flatMap(r => r.legs);
  const closed = startedLegs.filter(l => l.closeProb != null);
  const lineMoves = startedLegs.filter(l => l.closeLine != null && l.closeLine !== l.line);
  return {
    swept: graded.filter(r => r.hits === r.size).length,
    expectedSwept: r2(graded.reduce((a, r) => a + (r.probAll || 0), 0)),
    independentSwept: r2(graded.reduce((a, r) => a + r.legs.reduce((m, l) => m * l.prob / 100, 1), 0)),
    matches: countMatches(graded),
    legs: {
      n: legs.length, won,
      wonPct: legs.length ? r1(won / legs.length * 100) : null,
      pricedPct: priced != null ? r1(priced) : null,
      gap: legs.length ? r1(won / legs.length * 100 - priced) : null,
    },
    close: {
      legs: closed.length,
      move: closed.length ? r1(avg(closed.map(l => l.closeProb - l.prob))) : null,
      lineMoves: lineMoves.length,
      toward: lineMoves.filter(l => (l.side === 'OVER') === (l.closeLine > l.line)).length,
    },
  };
}

// The model stack record (kind 'es-stacks'): graded at the payout its rule
// used (repriced on PrizePicks, Underdog and Sleeper, Pick6's own table) and,
// beside it, at the app's standard table. Pre-registered bar: 50 graded
// (checks/es-stacks-2026-10-25/PREREGISTERED.md).
const ES_STACKS_BAR = 50;
function esStacksSummary(rows, t) {
  const graded = rows.filter(r => r.status === 'graded');
  const units = list => r2(list.reduce((a, r) => a + r.profit, 0));
  const stdUnits = list => r2(list.reduce((a, r) => a + ((r.standardPayTable || r.payTable)?.[r.hits] ?? 0) - 1, 0));
  const started = rows.filter(r => r.status !== 'void' && r.start && Date.parse(r.start) <= t);
  const byBook = {};
  for (const b of [...new Set(graded.map(r => r.book))]) {
    const g = graded.filter(r => r.book === b);
    byBook[b] = { graded: g.length, swept: g.filter(r => r.hits === r.size).length, expectedSwept: r2(g.reduce((a, r) => a + (r.probAll || 0), 0)), units: units(g), unitsStandard: stdUnits(g) };
  }
  const days = {};
  for (const r of rows) { const d = String(r.flaggedAt || '').slice(0, 10); if (d) days[d] = (days[d] || 0) + 1; }
  const s = stackStats(graded, started);
  return {
    label: 'model, not an edge', bar: ES_STACKS_BAR, proven: false,
    flagged: rows.length, graded: graded.length, open: rows.filter(r => r.status === 'open').length, void: rows.filter(r => r.status === 'void').length,
    units: units(graded), unitsStandard: stdUnits(graded),
    roi: graded.length ? Math.round(units(graded) / graded.length * 1e4) / 1e4 : null,
    expectedRoi: graded.length ? Math.round(graded.reduce((a, r) => a + r.ev / 100, 0) / graded.length * 1e4) / 1e4 : null,
    ...s, byBook, flaggedByDay: days,
  };
}

function createSlipTracker({
  store = createMemoryStore(), graders = {}, parseMapSpan = () => ({ label: '1' }),
  lookup = async () => new Map(), keyFor = () => null,
  gradeAfterMs = 2 * HOUR, giveUpMs = 4 * 24 * HOUR, now = () => Date.now(), log = console,
} = {}) {
  const ready = store.init();
  const open = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open') open.set(r.id, r); });

  // slips: autoSlips().slips and .stacks. Only +EV ones are the play.
  async function record(slips = []) {
    await loaded;
    const seen = new Set((await store.all()).map(r => r.id));
    const t = now();
    for (const s of slips) {
      if (s.status !== 'plus' || !s.payTable || !s.picks?.length) continue;
      const id = slipId(s);
      if (seen.has(id)) continue;
      const starts = s.picks.map(l => Date.parse(l.startTime)).filter(Number.isFinite);
      if (starts.length && Math.min(...starts) <= t) continue;
      seen.add(id);
      const row = {
        id, status: 'open', flaggedAt: new Date(t).toISOString(),
        start: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
        end: starts.length ? new Date(Math.max(...starts)).toISOString() : null,
        kind: s.kind || 'best', breakEvenPays: s.breakEvenPays ?? null,
        book: s.book, bookName: s.bookName, table: s.table, tableName: s.tableName, size: s.picks.length,
        ev: s.ev, probAll: s.probAll, paysAll: s.paysAll, payTable: s.payTable, kelly: s.kelly,
        ...(s.kind === 'es-stacks' ? {
          rule: s.rule, standardPayTable: s.standardPayTable, probAllIndependent: s.probAllIndependent,
          evStandard: s.evStandard, evRepriced: s.evRepriced, repricedPays: s.repricedPays, side: s.side,
        } : {}),
        legs: s.picks.map(l => ({
          sport: sportKey(l.sport), player: l.player, team: l.team || '', matchTitle: l.matchTitle || '',
          market: l.rawMarket || l.market, displayMarket: l.market, stat: statKind(l.rawMarket || l.market),
          maps: spanToMaps(parseMapSpan(l.rawMarket || l.market).label),
          line: l.line, side: l.side, mult: l.mult ?? null, prob: l.prob, startTime: l.startTime || null, gameId: l.gameId ?? null,
          result: null, outcome: null,
        })),
        hits: null, profit: null, gradedAt: null, note: null,
      };
      open.set(id, row);
      await store.put(row).catch(e => log.warn?.(`Slip tracker: ${e.message}`));
    }
  }

  // Follow every open stack's legs on the board until its match starts, so each
  // leg keeps its last price: the close. legNow(book, leg) → { line, prob } (prob
  // in %) for that leg's side on that book now, or null when the board no longer
  // carries it. A leg whose line moved keeps the new line and no price (its
  // chance at the old number isn't on the board).
  async function follow(legNow) {
    await loaded;
    const t = now();
    for (const row of open.values()) {
      if (!isMatchStack(row.kind) || !row.start || Date.parse(row.start) <= t) continue;
      let changed = false;
      for (const leg of row.legs) {
        let q = null;
        try { q = legNow(row.book, leg); } catch { q = null; }
        if (!q || q.line == null) continue;
        const closeProb = q.line === leg.line && Number.isFinite(q.prob) ? r1(q.prob) : null;
        if (leg.closeLine !== q.line || leg.closeProb !== closeProb) {
          leg.closeLine = q.line; leg.closeProb = closeProb; changed = true;
        }
      }
      if (changed) {
        row.closeAt = new Date(t).toISOString();
        await store.put(row).catch(e => log.warn?.(`Slip tracker: ${e.message}`));
      }
    }
  }

  // one leg's stat over its span, or { void } / null (not yet)
  async function legResult(leg, known) {
    const k = keyFor(leg);
    if (k && known.has(k)) return { stat: known.get(k) };
    const grader = graders[leg.sport];
    if (!grader || leg.stat === 'fantasy') return null;
    let res = null;
    try { res = await grader({ ...leg, startTime: leg.startTime }); }
    catch (e) { log.warn?.(`Slip tracker: ${leg.sport} grader failed for ${leg.player}: ${e.message}`); return null; }
    if (!res) return null;
    if (res.unavailable) return { void: res.unavailable };
    if (!res.maps) return null;
    const have = leg.maps.filter(m => res.maps[m] != null);
    if (have.length === leg.maps.length) return { stat: have.reduce((a, m) => a + res.maps[m], 0) };
    if (res.complete) {
      // as the pick tracker: a Maps 1-3 line on a 2-0 counts the maps played
      const missing = leg.maps.filter(m => res.maps[m] == null);
      if (missing.every(m => m >= 3) && have.length >= 2) return { stat: have.reduce((a, m) => a + res.maps[m], 0) };
      return { void: `series ended after ${have.length} of ${leg.maps.length} maps` };
    }
    return null;
  }

  async function grade({ limit = 20 } = {}) {
    await loaded;
    const t = now();
    const due = [...open.values()].filter(r => r.end && Date.parse(r.end) + gradeAfterMs <= t).slice(0, limit);
    if (!due.length) return { graded: 0, void: 0, waiting: open.size };
    const known = await lookup().catch(() => new Map());
    const out = { graded: 0, void: 0, waiting: 0 };
    for (const row of due) {
      let voided = null;
      for (const leg of row.legs) {
        if (leg.outcome) continue;
        const r = await legResult(leg, known);
        if (!r) continue;
        if (r.void) { voided = `${leg.player}: ${r.void}`; break; }
        leg.result = r.stat;
        leg.outcome = outcomeFor(leg.side, leg.line, r.stat);
        if (leg.outcome === 'push') { voided = `${leg.player} pushed`; break; }
      }
      if (voided) Object.assign(row, { status: 'void', note: voided, gradedAt: new Date(t).toISOString() });
      else if (row.legs.every(l => l.outcome)) {
        const hits = row.legs.filter(l => l.outcome === 'win').length;
        Object.assign(row, { status: 'graded', hits, profit: r2(payout(row, hits) - 1), gradedAt: new Date(t).toISOString() });
      } else if (Date.parse(row.end) + giveUpMs <= t) {
        Object.assign(row, { status: 'void', note: 'no result found', gradedAt: new Date(t).toISOString() });
      } else { await store.put(row).catch(() => {}); out.waiting++; continue; }
      open.delete(row.id);
      out[row.status === 'graded' ? 'graded' : 'void']++;
      await store.put(row).catch(e => log.warn?.(`Slip tracker: ${e.message}`));
    }
    return out;
  }

  // the record, overall and per book
  async function summary() {
    await loaded;
    const all = await store.all();
    // same-match stacks keep their own record (stacks), apart from Best Slips
    const isStack = r => r.kind === 'stack';
    const rows = all.filter(r => !isMatchStack(r.kind));
    const graded = rows.filter(r => r.status === 'graded');
    const cut = list => {
      const units = list.reduce((a, r) => a + r.profit, 0);
      return {
        slips: list.length, cashed: list.filter(r => r.profit > 0).length,
        units: r2(units), roi: list.length ? Math.round(units / list.length * 1e4) / 1e4 : null,
        // what the board said these would return, to compare against
        expectedRoi: list.length ? Math.round(list.reduce((a, r) => a + r.ev / 100, 0) / list.length * 1e4) / 1e4 : null,
      };
    };
    const byBook = {};
    for (const b of [...new Set(graded.map(r => r.book))]) byBook[b] = cut(graded.filter(r => r.book === b));
    const sRows = all.filter(isStack), sGraded = sRows.filter(r => r.status === 'graded');
    const sByBook = {};
    for (const b of [...new Set(sGraded.map(r => r.book))]) sByBook[b] = cut(sGraded.filter(r => r.book === b));
    for (const b of Object.keys(sByBook)) {
      const g = sGraded.filter(r => r.book === b);
      Object.assign(sByBook[b], { swept: g.filter(r => r.hits === r.size).length, expectedSwept: r2(g.reduce((a, r) => a + (r.probAll || 0), 0)) });
    }
    const t = now();
    const started = sRows.filter(r => r.status !== 'void' && r.start && Date.parse(r.start) <= t);
    const stacks = {
      ...cut(sGraded), ...stackStats(sGraded, started),
      open: sRows.filter(r => r.status === 'open').length, void: sRows.filter(r => r.status === 'void').length, byBook: sByBook,
    };
    return { ...cut(graded), open: rows.filter(r => r.status === 'open').length, void: rows.filter(r => r.status === 'void').length, byBook, stacks, esStacks: esStacksSummary(all.filter(r => r.kind === 'es-stacks'), t) };
  }
  async function list() { await loaded; return store.all(); }
  return { record, follow, grade, summary, list, ready: () => loaded };
}

module.exports = { createSlipTracker, slipId, legKey, esStacksSummary, ES_STACKS_BAR };
