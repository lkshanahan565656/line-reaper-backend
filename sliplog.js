// ─── SLIP LOG: A USER'S PICK'EM LEGS FOLLOWED TO THE CLOSE ───────────────────
// MY SLIPS (slips.js) sends every leg of a user's slips here, without stakes
// or payouts. A leg is matched to its props-board row (sport, player, stat,
// the game after the bet) and handed to a sports tracker of its own
// (sporttrack.js, kind 'slip'): the same machinery as the props record, so
// the close is found the same way. Until the start each read keeps the sharp
// consensus fair at the leg's own line and the apps' lines, the close counts
// only when that fair was read within the hour before the start (closeOk),
// and ESPN's box score grades it.
//
// A leg is the same for everyone who sends it (app, player, stat, side, line,
// game day): the record holds legs, never people.
//
// A leg we can't follow says why, never a guess:
//   'before'    the game started before the leg reached us (a slip pasted
//               late, an old Pikkit bet): its line was never read here
//   'player'    no app on our board lists the player near the bet's time
//   'market'    the player is on the board, that stat isn't
//   'esports'   esports legs are graded in the esports record, not here yet

const { canonName } = require('./ev');
const { sportMarketKey, boardSport } = require('./propsboard');
const { idOf, CODE, legDecimal: appLegDecimal } = require('./sporttrack');
const { legDecimal: slipLegDecimal } = require('./slips');

const KIND = 'slip';
const ESPORTS = new Set(['CS', 'LOL', 'VAL', 'DOTA', 'COD', 'R6', 'HALO', 'RL', 'OW']);
// a leg belongs to the player's first game starting from an hour before the bet
// to a week after (the apps post Sunday's NFL lines midweek)
const BEFORE_MS = 60 * 60e3, AFTER_MS = 7 * 86400e3;
const r4 = x => Math.round(x * 1e4) / 1e4;
const sideOf = s => (/^(over|more|higher|o)$/i.test(String(s || '')) ? 'Over' : /^(under|less|lower|u)$/i.test(String(s || '')) ? 'Under' : null);
const lastName = n => canonName(String(n || '').trim().split(/\s+/).pop());
const initial = n => canonName(n).slice(0, 1);

// the board's sports rows → Map(canonName → rows), with a last-name index for "J. Allen"
function indexRows(rows) {
  const byName = new Map(), byLast = new Map();
  for (const r of rows || []) {
    if (r.esports || !r.startTime || !r.mkey) continue;
    const k = canonName(r.player);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
    const l = lastName(r.player);
    if (!byLast.has(l)) byLast.set(l, []);
    byLast.get(l).push(r);
  }
  return { byName, byLast };
}

// one leg → { row } or { reason }
function matchLeg(leg, idx, { now = Date.now() } = {}) {
  const sport = leg.sport ? boardSport(leg.sport).sport : null;
  if (sport && ESPORTS.has(sport)) return { reason: 'esports' };
  const betAt = Date.parse(leg.betAt || '') || now;
  let cands = idx.byName.get(canonName(leg.player)) || [];
  if (!cands.length) {
    // "J. Allen" or "Allen": a unique player by last name (and first initial)
    const words = String(leg.player || '').trim().split(/\s+/);
    // a first initial narrows it; a full first name that didn't match exactly is someone else
    const first = words.length > 1 ? words[0].replace(/\.$/, '') : '';
    const pool = first.length > 1 ? [] : (idx.byLast.get(lastName(leg.player)) || []).filter(r => !first || initial(r.player) === initial(first));
    if (new Set(pool.map(r => canonName(r.player))).size === 1) cands = pool;
  }
  if (sport) cands = cands.filter(r => r.sport === sport);
  cands = cands.filter(r => { const s = Date.parse(r.startTime); return s >= betAt - BEFORE_MS && s <= betAt + AFTER_MS; });
  if (!cands.length) return { reason: 'player' };
  const mk = sportMarketKey(leg.market, cands[0].sport);
  let hit = cands.filter(r => r.mkey === mk);
  if (!hit.length) hit = cands.filter(r => canonName(r.market) === canonName(leg.market));
  if (!hit.length) return { reason: 'market', near: [...new Set(cands.map(r => r.market))].slice(0, 6) };
  // the first game from the bet on; the app's own line breaks a tie
  hit.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const first = hit.filter(r => r.startTime === hit[0].startTime);
  const own = first.find(r => r.books?.[leg.app]?.line === leg.line);
  return { row: own || first[0] };
}

// a tracked leg → what MY SLIPS shows
function view(b, leg) {
  const code = CODE[b.book] || b.book;
  const appClose = b.closeLines?.[code] ?? null;
  // the app's line moved the leg's way: up for an over, down for an under
  const lineMove = appClose == null ? null : r4((appClose - b.signalLine) * (b.signalSide === 'Over' ? 1 : -1));
  return {
    id: leg.id, status: b.status, final: b.status === 'graded' || b.status === 'void',
    matched: { sport: b.sport, player: b.player, market: b.market, mkey: b.mkey, start: b.start, matchTitle: b.matchTitle },
    trackedAt: b.signalAt, decimal: b.signalDecimal, signalFair: b.signalFair, closeFair: b.closeFair,
    closeEv: b.status === 'open' ? null : b.closeEv ?? null, evNow: b.status === 'open' && b.closeFair != null ? Math.round((b.closeFair * b.signalDecimal - 1) * 1e4) / 100 : null,
    fairMove: b.fairMove ?? null, closeOk: b.closeOk ?? null, closeAgeMin: b.closeAgeMin ?? null, appClose, lineMove, closeLines: b.closeLines || null,
    outcome: b.outcome || null, result: b.result ?? null, voidReason: b.voidReason || null,
  };
}

// tracker: a createSportTracker for the slip legs. fairAt(row, book, line) →
// P(over) on the sharp consensus now, or null.
function createSlipLog({ tracker, now = () => Date.now() } = {}) {
  const byId = async () => new Map((await tracker.list({ limit: 1e9 })).map(b => [b.id, b]));

  // legs: [{ id, app, sport, player, market, side, line, betAt }] → { results: { id: view } }
  async function grade(legs, { rows = [], fairAt } = {}) {
    const t = now();
    const idx = indexRows(rows);
    const known = await byId();
    const results = {}, fresh = [];
    for (const leg of (legs || []).slice(0, 300)) {
      const id = String(leg?.id || '').slice(0, 200);
      const side = sideOf(leg?.side), line = Number(leg?.line);
      if (!id || !side || !Number.isFinite(line) || !leg.player || !leg.market) { if (id) results[id] = { id, status: 'nohistory', reason: 'unread', final: true }; continue; }
      const app = String(leg.app || '').toLowerCase();
      const m = matchLeg({ ...leg, app, side, line }, idx, { now: t });
      if (!m.row) {
        // no row now: a game long over can never come back, a bet still ahead might
        const betAt = Date.parse(leg.betAt || '') || t;
        results[id] = { id, status: 'nohistory', reason: m.reason === 'player' && t - betAt > AFTER_MS ? 'before' : m.reason, near: m.near || null,
          final: m.reason === 'esports' || t - betAt > AFTER_MS };
        continue;
      }
      const row = m.row;
      // the app's own payout on this pick where its board shows our line (a
      // Sleeper or Underdog pick multiplier), else its break-even
      const cell = row.books?.[app];
      const mult = cell && cell.line === line ? Number(side === 'Over' ? cell.over : cell.under) : NaN;
      const priced = mult > 0 && ['prizepicks', 'underdog', 'sleeper', 'pick6'].includes(app);
      const play = { book: app, side, line, mult: priced ? mult : 1, decimal: priced ? r4(appLegDecimal(app, mult)) : slipLegDecimal(app) };
      const tid = idOf(row, play, KIND);
      const b = known.get(tid);
      if (b) { results[id] = view(b, { id }); continue; }
      if (!(Date.parse(row.startTime) > t)) { results[id] = { id, status: 'nohistory', reason: 'before', final: true, matched: { sport: row.sport, player: row.player, market: row.market, start: row.startTime } }; continue; }
      const pOver = fairAt ? fairAt(row, app, line) : null;
      play.fair = pOver == null ? null : side === 'Over' ? pOver : 1 - pOver;
      play.ev = play.fair == null ? null : Math.round((play.fair * play.decimal - 1) * 1e4) / 100;
      fresh.push({ id, tid, row, play });
    }
    if (fresh.length) {
      // first sight: logged now, followed by every read from here (record() with the board's rows)
      await tracker.record({ rows, flagged: fresh.map(f => ({ row: f.row, play: f.play, kind: KIND })), fairAt });
      const after = await byId();
      for (const f of fresh) { const b = after.get(f.tid); results[f.id] = b ? view(b, { id: f.id }) : { id: f.id, status: 'nohistory', reason: 'before', final: true }; }
    }
    return { results, at: new Date(t).toISOString() };
  }
  return { grade, tracker };
}

module.exports = { createSlipLog, matchLeg, indexRows, view, KIND, sideOf };
