// ─── LATE LEGS: MY SLIPS LEGS GRADED AFTER THE START ─────────────────────────
// The slip log (sliplog.js) follows a leg from the moment it reaches us to the
// start. A leg that reaches us later (a slip typed in after kickoff, a Pikkit
// export of last month) still gets graded here:
//
//   the game     the prop close book (propclose.js) when the board saw the
//                prop with a sharp price; else, for the box-score sports, the
//                player found in the box scores of the games from the bet on
//   the result   the same graders as every record: ESPN box scores (NFL, CFB,
//                NBA, WNBA, CBB, NHL), the MLB Stats API, and extragrade.js
//                for tennis, UFC, NASCAR and soccer
//   the close    Pinnacle's own last number before the start (raw, at the
//                leg's line or read along the curve from Pinnacle's nearest,
//                marked), Kalshi's when Pinnacle had none, none otherwise.
//                closeOk only when that number was read in the hour before
//                the start, the records' rule.
//
// Finished results are kept (store 'slip_late') with the close they were
// graded on, so a leg is fetched once for everyone who logs it. Fetching is
// budgeted per request; a leg past the budget answers 'queued' and comes back
// on the browser's next pass.
//
// A leg we can't settle says why:
//   'sport'    no league on the leg and no prop on the board to say which
//   'game'     no game with that player from the bet on (or not final yet)
//   'stat'     the box score doesn't carry that stat

const { canonName } = require('./ev');
const { LEAGUES, parseBox, ymd } = require('./sportgrade');
const { fairAt: closeFairAt, dayOf } = require('./propclose');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const { r2 } = require('./mathutil');
const VOID_AFTER_MS = 3 * 86400e3;
const READY_AFTER_MS = 3 * 3600e3;    // a game is looked for 3 hours after its start

const LABEL = { espn: 'ESPN box score', 'espn box score': 'ESPN box score', 'mlb-statsapi': 'MLB Stats API box score', kalshi: 'Kalshi settlement' };
const sourceLabel = s => LABEL[String(s || '').toLowerCase()] || (s ? String(s) : 'ESPN box score');

// the server's key for a leg's subject: the same leg logged by two people is one result
const resultId = (sport, player, mkey, side, line, start) => `late|${sport}|${canonName(player)}|${mkey}|${side}|${line}|${start}`;

// fetch: ESPN scoreboards and box scores for the scan. Finished games never
// change, so their boxes are kept for a day; a scoreboard for 10 minutes.
function createBoxScan({ http, now = () => Date.now(), boardTtlMs = 10 * 60e3, boxTtlMs = 24 * 3600e3, maxBoxes = 600 } = {}) {
  const boards = new Map(), boxes = new Map();
  async function board(league, d, budget) {
    const k = `${league}|${d}`, hit = boards.get(k);
    if (hit && now() - hit.at < boardTtlMs) return hit.v;
    if (budget.left-- <= 0) throw Object.assign(new Error('budget'), { budget: true });
    const v = (await http.get(`${ESPN}/${LEAGUES[league]}/scoreboard`, { params: { dates: d, limit: 300, ...(league === 'CFB' || league === 'CBB' ? { groups: league === 'CFB' ? 80 : 50 } : {}) }, timeout: 20000 }))?.data?.events || [];
    boards.set(k, { at: now(), v });
    return v;
  }
  async function box(league, id, budget) {
    const k = `${league}|${id}`, hit = boxes.get(k);
    if (hit && now() - hit.at < boxTtlMs) return hit.v;
    if (budget.left-- <= 0) throw Object.assign(new Error('budget'), { budget: true });
    const v = parseBox((await http.get(`${ESPN}/${LEAGUES[league]}/summary`, { params: { event: id }, timeout: 20000 }))?.data?.boxscore);
    if (boxes.size >= maxBoxes) boxes.delete(boxes.keys().next().value);
    boxes.set(k, { at: now(), v });
    return v;
  }
  // the player's first finished game from `from` (ms) to `to` → { start, team, matchTitle, eventId } | null
  async function findGame(sport, player, from, to, budget) {
    if (!LEAGUES[sport]) return null;
    const name = canonName(player);
    const t = now();
    const dates = [];
    for (let d = from; d <= Math.min(to, t) + 86400e3; d += 86400e3) { const s = ymd(d); if (!dates.includes(s)) dates.push(s); }
    for (const d of dates) {
      const events = (await board(sport, d, budget))
        .filter(e => { const s = Date.parse(e.date); return s >= from && s <= to && e.status?.type?.completed; })
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      for (const e of events) {
        const players = await box(sport, e.id, budget);
        const p = players.get(name);
        if (p) return { start: new Date(Date.parse(e.date)).toISOString(), team: p.team, matchTitle: e.shortName || e.name || '', eventId: e.id };
      }
    }
    return null;
  }
  return { findGame, stats: () => ({ boards: boards.size, boxes: boxes.size }) };
}

// store: evtrack store for finished results; book: the prop close book;
// grader: the combined sports grader (grade, canGrade, sourceOf); scan: a box scan
function createLateGrader({ store, book, grader, scan, now = () => Date.now(), log = console } = {}) {
  const done = new Map();
  const loaded = (async () => {
    if (store.init) await store.init();
    for (const d of await store.all()) if (d?.id) done.set(d.id, d);
  })().catch(e => log.warn?.(`Late slip legs: load failed: ${e.message}`));
  let running = 0;

  // a result (stored or fresh) → what MY SLIPS shows
  function view(id, r, { app, decimal, matchUncertain = false } = {}) {
    const raw = r.close ? { ...r.close, ev: r.close.fair == null ? null : r2((r.close.fair * decimal - 1) * 100) } : null;
    const final = r.status === 'graded' || r.status === 'void';
    return {
      id, status: r.status, final, late: true,
      matched: { sport: r.sport, player: r.player, market: r.market || null, mkey: r.mkey, start: r.start, matchTitle: r.matchTitle || '' },
      ...(matchUncertain || r.matchUncertain ? { matchUncertain: true } : {}),
      decimal, signalFair: null, closeFair: raw?.fair ?? null, closeEv: raw?.ev ?? null, closeOk: raw ? raw.ok !== false : null, closeAgeMin: raw?.ageMin ?? null,
      raw, appClose: r.apps?.[app] ?? null, lineMove: null, fairMove: null,
      outcome: r.outcome || null, result: r.result ?? null, voidReason: r.voidReason || null,
      gradeSource: r.status === 'graded' ? sourceLabel(r.gradeSource) : null, gameSource: r.gameSource || null,
    };
  }

  // legs: [{ id, app, sport, mkey, market, player, side, line, betAt, betAtExact, start? }]
  // decimalOf(app) → the leg's price per unit. → { results: { id: view } }
  // (a leg with no answer is left out: the caller keeps its own)
  async function grade(legs, { decimalOf, budget = { left: 40 } } = {}) {
    await loaded;
    const results = {};
    if (running) budget = { left: 0 };   // one fetching pass at a time server-wide
    running++;
    try {
      for (const leg of legs || []) {
        const decimal = decimalOf(leg.app);
        const t = now();
        const betAt = Date.parse(leg.betAt || '') || t;
        // the game: the close book first, then the box scores
        let entry = leg.start ? book.get(leg.sport, leg.player, leg.mkey, leg.start) || book.find({ ...leg, betAt, start: Date.parse(leg.start) }) : book.find({ ...leg, betAt });
        let game = entry ? { start: entry.start, team: entry.team, matchTitle: entry.matchTitle, sport: entry.sport, player: entry.player, market: entry.market, gameSource: 'board' } : null;
        // a guessed time (a slip pasted with no date) that only fits a game well before it
        const uncertainOf = gm => !!(gm && !leg.betAtExact && Date.parse(gm.start) < betAt - 3600e3);
        let uncertain = uncertainOf(game);
        const stored = game && done.get(resultId(game.sport, game.player, leg.mkey, leg.side, leg.line, game.start));
        if (stored) { results[leg.id] = view(leg.id, stored, { app: leg.app, decimal, matchUncertain: uncertain }); continue; }
        if (!game) {
          if (!leg.sport) { if (t - betAt > 7 * 86400e3) results[leg.id] = { id: leg.id, status: 'nohistory', reason: 'sport', final: true }; continue; }
          if (!LEAGUES[leg.sport]) continue;
          // the scan: games from the bet on (an hour's slack); a guessed time also looks back 18 hours
          const from = betAt - (leg.betAtExact ? 3600e3 : 18 * 3600e3);
          const sid = `scan|${leg.sport}|${canonName(leg.player)}|${dayOf(from)}`;
          let g = done.get(sid);
          if (!g || (g.miss && t - Date.parse(g.at) > 6 * 3600e3 && t - betAt < 8 * 86400e3)) {
            try { g = await scan.findGame(leg.sport, leg.player, from, betAt + 7 * 86400e3, budget); }
            catch (e) { if (e.budget) { results[leg.id] = { id: leg.id, status: 'locked', reason: 'queued', final: false, late: true }; continue; } log.warn?.(`Late slip legs: scan: ${e.message}`); continue; }
            g = g ? { id: sid, status: 'scan', ...g, at: new Date(t).toISOString() } : { id: sid, status: 'scan', miss: true, at: new Date(t).toISOString() };
            done.set(sid, g);
            // only a miss on a bet over a week old is final; a found game is final
            if (!g.miss || t - betAt > 8 * 86400e3) await store.put(g).catch(() => {});
          }
          if (g.miss) {
            if (t - betAt > 8 * 86400e3) results[leg.id] = { id: leg.id, status: 'nohistory', reason: 'game', final: true };
            continue;
          }
          game = { start: g.start, team: g.team, matchTitle: g.matchTitle, sport: leg.sport, player: leg.player, market: leg.market, gameSource: 'box score search' };
          uncertain = uncertainOf(game);
          const again = done.get(resultId(game.sport, game.player, leg.mkey, leg.side, leg.line, game.start));
          if (again) { results[leg.id] = view(leg.id, again, { app: leg.app, decimal, matchUncertain: uncertain }); continue; }
        }
        const start = Date.parse(game.start);
        const close = entry ? closeFairAt(entry, leg.line, leg.side) : null;
        const base = { sport: game.sport, player: game.player, market: game.market || leg.market, mkey: leg.mkey, start: game.start, matchTitle: game.matchTitle, team: game.team,
          apps: entry?.apps || null, close, gameSource: game.gameSource };
        if (start > t) { results[leg.id] = view(leg.id, { ...base, status: 'open' }, { app: leg.app, decimal }); continue; }
        if (t - start < READY_AFTER_MS) { results[leg.id] = view(leg.id, { ...base, status: 'locked' }, { app: leg.app, decimal, matchUncertain: uncertain }); continue; }
        const pick = { sport: game.sport, mkey: leg.mkey, player: game.player, team: game.team, matchTitle: game.matchTitle, startTime: game.start, start: game.start, signalLine: leg.line, signalSide: leg.side };
        const id = resultId(game.sport, game.player, leg.mkey, leg.side, leg.line, game.start);
        let r = null;
        if (grader.canGrade && !grader.canGrade(pick)) r = { ...base, id, status: 'void', voidReason: 'no results source for this stat' };
        else {
          if (budget.left <= 0) { results[leg.id] = view(leg.id, { ...base, status: 'locked' }, { app: leg.app, decimal, matchUncertain: uncertain }); continue; }
          budget.left -= 2;
          let g = null;
          try { g = await grader.grade(pick); } catch (e) { log.warn?.(`Late slip legs: grade: ${e.message}`); }
          if (g && !g.pending && g.outcome) r = { ...base, id, status: 'graded', outcome: g.outcome, result: g.result, eventId: g.eventId || null, gradeSource: g.source || grader.sourceOf?.(pick) || 'espn' };
          else if (g?.void) r = { ...base, id, status: 'void', voidReason: g.void };
          else if (t - start > VOID_AFTER_MS) r = { ...base, id, status: 'void', voidReason: g?.pending ? 'never final' : 'not in the box score (did not play?)' };
        }
        if (r) { r.gradedAt = new Date(t).toISOString(); done.set(id, r); await store.put(r).catch(e => log.warn?.(`Late slip legs: save: ${e.message}`)); }
        results[leg.id] = view(leg.id, r || { ...base, status: 'locked' }, { app: leg.app, decimal, matchUncertain: uncertain });
      }
    } finally { running--; }
    return { results, budgetLeft: budget.left };
  }

  // finished results by source, for /api/ops
  function status() {
    let graded = 0, voided = 0, scans = 0;
    for (const d of done.values()) { if (d.status === 'graded') graded++; else if (d.status === 'void') voided++; else if (d.status === 'scan') scans++; }
    return { graded, voided, scans };
  }
  return { grade, view, status, ready: () => loaded };
}

module.exports = { createLateGrader, createBoxScan, resultId, sourceLabel, closeOf: closeFairAt };
