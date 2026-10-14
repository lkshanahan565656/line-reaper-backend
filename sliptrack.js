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
const r2 = x => Math.round(x * 100) / 100;

function legKey(l) {
  const day = l.startTime ? String(l.startTime).slice(0, 10) : 'nostart';
  return [sportKey(l.sport), norm(l.player), norm(l.rawMarket || l.market), l.line, l.side, l.gameId ?? day].join('|');
}
// A same-match stack is logged once per match, book and side: the board
// rebuilds every few minutes and the best stack's legs shift as lines move,
// and counting each version would weigh one match many times.
const slipId = s => (s.kind === 'stack'
  ? `${s.book}|stack|${s.picks[0]?.gameId ?? legKey(s.picks[0])}|${s.picks[0]?.side}`
  : `${s.book}|${s.table}|${s.picks.map(legKey).sort().join('+')}`);

// a slip's payout on h hits, 1u staked
function payout(row, hits) {
  return row.payTable?.[hits] ?? 0;
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
    const rows = all.filter(r => !isStack(r));
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
    const stacks = { ...cut(sGraded), open: sRows.filter(r => r.status === 'open').length, void: sRows.filter(r => r.status === 'void').length, byBook: sByBook };
    return { ...cut(graded), open: rows.filter(r => r.status === 'open').length, void: rows.filter(r => r.status === 'void').length, byBook, stacks };
  }
  async function list() { await loaded; return store.all(); }
  return { record, grade, summary, list, ready: () => loaded };
}

module.exports = { createSlipTracker, slipId, legKey };
