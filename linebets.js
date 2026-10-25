// ─── LINE BETS: A USER'S GAME-LINE BETS FOLLOWED TO PINNACLE'S CLOSE ─────────
// MY BETS logs a moneyline, spread or total from the ODDS SCREEN (any venue:
// Kalshi, Polymarket US, Gemini, FanDuel, BetRivers, the copies) with a track
// reference { kind: 'line', game, league, market, side, point }. The first time
// POST /api/bets/settle sees that reference before the start, the line is
// logged here with Pinnacle's no-vig chance of the side at the bet's exact
// number and Pinnacle's raw prices. Every odds-screen read until the start
// keeps both current; at the start the last read is the close, and it counts
// only when Pinnacle was still pricing that number within the hour before
// (closeOk, the same rule as the +EV record). ESPN's final grades it.
//
// A row is the same for everyone who bet that side at that number: no stake,
// no price, no user. The user's own price stays in their browser, and CLV is
// worked out there: their decimal × the closing fair − 1.
//
// Pure apart from the store and the grader handed in.

const { devig, americanToDecimal } = require('./ev');
const { pricesAt } = require('./oddsscreen');
const { outcomeOf } = require('./evtrack');

const MKEY = { ml: 'h2h', spread: 'spreads', total: 'totals' };
const CLOSE_FRESH_MS = 60 * 60e3, SEEN_SAVE_MS = 10 * 60e3;
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => Math.round(x * 100) / 100;
const numOrNull = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// a track reference from the browser → the clean key fields, or null
function clean(t) {
  if (!t || typeof t !== 'object' || t.kind !== 'line') return null;
  const market = MKEY[t.market] ? t.market : null;
  const game = String(t.game || '').slice(0, 80), side = String(t.side || '').slice(0, 80);
  const point = market === 'ml' ? null : numOrNull(t.point);
  if (!market || !game || !side || (market !== 'ml' && point == null)) return null;
  return { game, market, side, point };
}
const idOf = c => `${c.game}|${c.market}|${c.side}|${c.point ?? ''}`;

// every game the free books read, by id → { game, league }
function indexGames(gamesByLeague) {
  const m = new Map();
  for (const [league, list] of Object.entries(gamesByLeague || {})) for (const g of list || []) m.set(String(g.id), { g, league });
  return m;
}

// Pinnacle's no-vig chance of SIDE at the exact number, with its raw prices
// → { p, raw: { side: american } } | null (Pinnacle doesn't hang that number)
function pinFair(g, c) {
  const pin = (g?.bookmakers || []).find(b => b.key === 'pinnacle');
  if (!pin) return null;
  const at = pricesAt(pin, MKEY[c.market], c.point, g.home_team);
  if (!at || !at[c.side]) return null;
  const sides = c.market === 'ml' ? Object.keys(at) : c.market === 'spread' ? [g.home_team, g.away_team] : ['Over', 'Under'];
  if (sides.length < 2 || !sides.every(s => at[s])) return null;
  const f = devig(sides.map(s => americanToDecimal(at[s].american)), 'power');
  const i = sides.indexOf(c.side);
  if (!f || i < 0 || !(f[i] > 0 && f[i] < 1)) return null;
  return { p: r4(f[i]), raw: Object.fromEntries(sides.map(s => [s, at[s].american])) };
}

// the side's own number: a spread is kept as the home team's number
const ownPoint = r => (r.market === 'spread' ? (r.side === r.home ? r.point : -r.point) : r.point);

// what the browser gets back for one bet
function view(r) {
  if (!r) return null;
  const closed = r.status === 'closed';
  const close = {
    status: r.status, logFair: r.logFair ?? null, fair: r.closeFair ?? null, pin: r.closePin?.[r.side] ?? null, pinRaw: r.closePin || null,
    closeOk: closed ? !!r.closeOk : null, closeAgeMin: r.closeAgeMin ?? null, seenAt: r.seenAt || null, start: r.start,
    outcome: r.outcome || null, score: r.score || null,
  };
  const out = { close, note: 'Pinnacle close' };
  if (closed && r.closeOk && r.closeFair > 0) out.closeOdds = r4(1 / r.closeFair);
  if (r.outcome) out.result = r.outcome;
  return out;
}

function createLineBets({ store, now = () => Date.now(), log = console } = {}) {
  const rows = new Map();
  const ready = (async () => { await store.init(); for (const r of await store.all()) if (r && r.id) rows.set(r.id, r); })();
  const save = list => (list.length ? (store.putMany ? store.putMany(list) : Promise.all(list.map(r => store.put(r)))).catch(e => log.warn?.(`Line bets: ${e.message}`)) : null);

  // tracks: [{ id (the user's bet id), track }] → { [bet id]: view }
  // A track first seen after its start can't get a close: 'late'.
  async function settle(list, { games = {} } = {}) {
    await ready;
    const t = now(), idx = indexGames(games), out = {}, fresh = [];
    for (const { id, track } of list || []) {
      const c = clean(track);
      if (!id || !c) continue;
      const key = idOf(c);
      let r = rows.get(key);
      if (!r) {
        const hit = idx.get(c.game);
        if (!hit) { out[id] = { close: { status: 'unknown' }, note: 'game not on the odds screen' }; continue; }
        const start = Date.parse(hit.g.commence_time);
        if (!(start > t)) { out[id] = { close: { status: 'late' }, note: 'logged after the start' }; continue; }
        const pf = pinFair(hit.g, c);
        if (!pf) { out[id] = { close: { status: 'nopin' }, note: 'Pinnacle does not hang this number' }; continue; }
        const at = new Date(t).toISOString();
        r = { id: key, ...c, league: hit.league, home: hit.g.home_team, away: hit.g.away_team, start: hit.g.commence_time, status: 'open',
          firstAt: at, logFair: pf.p, logPin: pf.raw, closeFair: pf.p, closePin: pf.raw, seenAt: at };
        rows.set(key, r); fresh.push(r);
      }
      out[id] = view(r);
    }
    await save(fresh);
    return out;
  }

  // every odds-screen read: keep open rows on Pinnacle's current price, close
  // the ones whose game started
  async function observe(games = {}) {
    await ready;
    const t = now(), idx = indexGames(games), dirty = [];
    for (const r of rows.values()) {
      if (r.status !== 'open') continue;
      const hit = idx.get(r.game);
      // a moved start (postponement) follows the feed while the game is still ahead
      if (hit && hit.g.commence_time && hit.g.commence_time !== r.start && Date.parse(hit.g.commence_time) > t) { r.start = hit.g.commence_time; dirty.push(r); }
      const start = Date.parse(r.start);
      if (start > t) {
        const pf = hit ? pinFair(hit.g, r) : null;
        if (!pf) continue;
        if (pf.p !== r.closeFair || JSON.stringify(pf.raw) !== JSON.stringify(r.closePin)) { Object.assign(r, { closeFair: pf.p, closePin: pf.raw, seenAt: new Date(t).toISOString() }); dirty.includes(r) || dirty.push(r); }
        else if (!(t - Date.parse(r.seenAt) < SEEN_SAVE_MS)) { r.seenAt = new Date(t).toISOString(); dirty.includes(r) || dirty.push(r); }
        r._seen = t;   // exact in memory, saved at most every SEEN_SAVE_MS
        continue;
      }
      const seenT = Math.max(r._seen || 0, Date.parse(r.seenAt) || 0);
      delete r._seen;
      Object.assign(r, { status: 'closed', seenAt: new Date(seenT).toISOString(), closeAgeMin: r2((start - seenT) / 60e3), closeOk: start - seenT <= CLOSE_FRESH_MS });
      dirty.includes(r) || dirty.push(r);
    }
    await save(dirty.map(({ _seen, ...r }) => r));
    return dirty.length;
  }

  // ESPN finals for closed rows: grader.gradeGame({ league, home, away, start });
  // leagueOf(feed league) → ESPN board key or null (no grader: CLV only)
  async function grade(grader, leagueOf, { minAgeMs = 2.5 * 3600e3, maxAgeMs = 10 * 86400e3, limit = 60 } = {}) {
    await ready;
    const t = now();
    const due = [...rows.values()].filter(r => r.status === 'closed' && !r.outcome && leagueOf(r.league) && !(r.resultTries >= 12)
      && t - Date.parse(r.start) >= minAgeMs && t - Date.parse(r.start) <= maxAgeMs).slice(0, limit);
    const dirty = [];
    let graded = 0;
    for (const r of due) {
      let sc = null;
      try { sc = await grader.gradeGame({ league: leagueOf(r.league), home: r.home, away: r.away, start: r.start }); }
      catch (e) { log.warn?.(`Line bets: grade ${r.league}: ${e.message}`); continue; }
      if (sc?.pending) continue;
      const outcome = sc ? outcomeOf({ market: MKEY[r.market], side: r.side, point: ownPoint(r), event: `${r.away} @ ${r.home}` }, sc) : null;
      if (outcome) { Object.assign(r, { outcome, score: { home: sc.home, away: sc.away }, gradedAt: new Date(t).toISOString() }); graded++; }
      else r.resultTries = (r.resultTries || 0) + 1;
      dirty.push(r);
    }
    await save(dirty);
    return { due: due.length, graded };
  }

  const counts = () => { const c = { open: 0, closed: 0, graded: 0 }; for (const r of rows.values()) { c[r.status] = (c[r.status] || 0) + 1; if (r.outcome) c.graded++; } return c; };
  return { settle, observe, grade, counts, ready: () => ready, rows };
}

module.exports = { createLineBets, clean, idOf, pinFair, ownPoint, view, indexGames, MKEY, CLOSE_FRESH_MS };
