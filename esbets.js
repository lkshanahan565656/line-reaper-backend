// ─── ESPORTS BETS: A SERIES-WINNER BET FROM MATCHUPS, FOLLOWED TO PINNACLE ───
// MATCHUPS lists every upcoming LoL, CS2 and VALORANT series with Kalshi's and
// Polymarket US's price to buy each team. LOG on a team opens MY BETS with a
// track reference { kind: 'es', game, match, side }: the matchup engine's
// series id and the team's place (0 or 1) on that series.
//
// The first time the server sees that reference (POST /api/bets/stamp, the
// settle pass or a published record's grading pass) it looks the series up in
// the matchup engine. The START comes from there, never from the browser: a
// series that has started is refused, one we can't find is refused. Then:
//   - Pinnacle's esports feed (esbooks.parsePinnacle, read every two minutes)
//     is searched for the same series (same game, both teams fit, start within
//     12 hours). Where Pinnacle prices the series winner, its no-vig chance of
//     the team is kept now and followed on every read to the start.
//   - At the start the last read is the close. It counts only when Pinnacle
//     was still pricing the series within the hour before (closeOk, the same
//     rule as the game lines). A series Pinnacle never priced closes UNPRICED:
//     on the record, never graded against a close.
//   - The result comes from the matchup engine's own finished series (the
//     lolesports schedule for LoL, bo3.gg and vlr.gg for CS2 and VALORANT).
//
// A row is the same for everyone who backed that team in that series: no
// stake, no price, no user. The user's price stays with the bet.
//
// Pure apart from the store and the lookups handed in.

const M = require('./esmatchup');

const GAMES = new Set(['LOL', 'CS2', 'VAL']);
const CLOSE_FRESH_MS = 60 * 60e3, SEEN_SAVE_MS = 10 * 60e3, PAIR_MS = 12 * 3600e3, PIN_MAX_AGE_MS = 10 * 60e3;
const MIN_NAME = 0.75;
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => Math.round(x * 100) / 100;

// a track reference from the browser → the clean key fields, or null
function clean(t) {
  if (!t || typeof t !== 'object' || t.kind !== 'es') return null;
  const game = String(t.game || '').toUpperCase();
  const match = String(t.match ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 100);
  const side = Number(t.side);
  if (!GAMES.has(game) || !match || !(side === 0 || side === 1)) return null;
  return { game, match, side };
}
const idOf = c => `${c.game}|${c.match}|${c.side}`;

// Pinnacle's series for these two teams: same game, both names fit, start close.
// pin: esbooks.parsePinnacle() rows { id, game, teams, start (ms), ladders }
function pinMatch(pin, game, teams, start) {
  const t = Date.parse(start);
  let best = null;
  for (const m of pin || []) {
    if (m?.game !== game || !m.teams) continue;
    if (Number.isFinite(m.start) && Number.isFinite(t) && Math.abs(m.start - t) > PAIR_MS) continue;
    const d = Math.min(M.nameScore(m.teams[0], teams[0]), M.nameScore(m.teams[1], teams[1]));
    const f = Math.min(M.nameScore(m.teams[0], teams[1]), M.nameScore(m.teams[1], teams[0]));
    const sc = Math.max(d, f);
    if (sc < MIN_NAME) continue;
    const key = sc * 10 - (Number.isFinite(m.start) && Number.isFinite(t) ? Math.abs(m.start - t) / 3600e3 : 2);
    if (!best || key > best.key) best = { m, flipped: f > d, key };
  }
  return best;
}
// Pinnacle's no-vig chance that teams[side] wins the series → { p, pinId, limit } | null
function pinFair(pin, game, teams, start, side) {
  const hit = pinMatch(pin, game, teams, start);
  const pt = hit?.m.ladders?.get?.('series|0|ml')?.[0];
  if (!pt || !(pt.p > 0 && pt.p < 1)) return null;
  const p0 = hit.flipped ? 1 - pt.p : pt.p;   // chance of OUR teams[0]
  return { p: r4(side === 0 ? p0 : 1 - p0), pinId: hit.m.id, limit: pt.limit ?? null };
}

// what the browser (and a published record) gets back for one bet: the same
// shape as linebets.view, so MY BETS and /r/<handle> read both alike
function view(r) {
  if (!r) return null;
  const closed = r.status === 'closed';
  const priced = r.closeFair != null;
  const close = {
    status: r.status, logFair: r.logFair ?? null, fair: r.closeFair ?? null, pin: null, pinRaw: null,
    closeOk: closed ? !!r.closeOk : null, closeAgeMin: r.closeAgeMin ?? null, seenAt: r.seenAt || null, start: r.start,
    outcome: r.outcome || null, score: r.score || null, unpriced: closed && !priced ? true : undefined, team: r.team, teams: r.teams,
  };
  const out = { close, note: priced ? 'Pinnacle close' : closed ? 'Pinnacle did not price this series: unpriced' : 'Pinnacle has no price on this series yet' };
  if (closed && r.closeOk && r.closeFair > 0) out.closeOdds = r4(1 / r.closeFair);
  if (r.outcome) out.result = r.outcome;
  return out;
}

// lookup(game, match) → the matchup engine's series { id, start, teams: [{ name }], league, state } | null
// pin: { list, at } (Pinnacle's esports rows and when they were read)
function createEsBets({ store, now = () => Date.now(), log = console } = {}) {
  const rows = new Map();
  const ready = (async () => { await store.init(); for (const r of await store.all()) if (r && r.id) rows.set(r.id, r); })();
  const save = list => (list.length ? (store.putMany ? store.putMany(list) : Promise.all(list.map(r => store.put(r)))).catch(e => log.warn?.(`Esports bets: ${e.message}`)) : null);
  const pinFresh = (pin, t) => !!pin && Array.isArray(pin.list) && Number.isFinite(Date.parse(pin.at)) && t - Date.parse(pin.at) <= PIN_MAX_AGE_MS;

  // tracks: [{ id (the user's bet id), track }] → { [bet id]: view }
  async function settle(list, { lookup = () => null, pin = null } = {}) {
    await ready;
    const t = now(), out = {}, fresh = [];
    for (const { id, track } of list || []) {
      const c = clean(track);
      if (!id || !c) continue;
      const key = idOf(c);
      let r = rows.get(key);
      if (!r) {
        let mu = null;
        try { mu = lookup(c.game, c.match); } catch { mu = null; }
        if (!mu || !mu.teams?.[0]?.name || !mu.teams?.[1]?.name) { out[id] = { close: { status: 'unknown' }, note: 'series not on MATCHUPS right now' }; continue; }
        const start = Date.parse(mu.start);
        if (!Number.isFinite(start)) { out[id] = { close: { status: 'unknown' }, note: 'series has no start time yet' }; continue; }
        if (!(start > t) || mu.state === 'inProgress') { out[id] = { close: { status: 'late', start: new Date(start).toISOString() }, note: 'logged after the start' }; continue; }
        const teams = [mu.teams[0].name, mu.teams[1].name];
        const at = new Date(t).toISOString();
        const pf = pinFresh(pin, t) ? pinFair(pin.list, c.game, teams, mu.start, c.side) : null;
        r = { id: key, ...c, teams, team: teams[c.side], league: mu.league || null, start: new Date(start).toISOString(), status: 'open', firstAt: at,
          logFair: pf?.p ?? null, closeFair: pf?.p ?? null, pinId: pf?.pinId ?? null, seenAt: pf ? at : null };
        rows.set(key, r); fresh.push(r);
      }
      out[id] = view(r);
    }
    await save(fresh);
    return out;
  }

  // every Pinnacle esports read: keep open rows on Pinnacle's current price
  // (a moved start follows the matchup engine while the series is ahead), and
  // close the ones whose series started
  async function observe({ lookup = () => null, pin = null } = {}) {
    await ready;
    const t = now(), dirty = [], fresh = pinFresh(pin, t), mark = r => { if (!dirty.includes(r)) dirty.push(r); };
    for (const r of rows.values()) {
      if (r.status !== 'open') continue;
      let mu = null;
      try { mu = lookup(r.game, r.match); } catch { mu = null; }
      const ms = mu ? Date.parse(mu.start) : NaN;
      if (Number.isFinite(ms) && ms > t && new Date(ms).toISOString() !== r.start && mu.state !== 'inProgress') { r.start = new Date(ms).toISOString(); mark(r); }
      const start = Date.parse(r.start);
      if (start > t && mu?.state !== 'inProgress') {
        if (!fresh) continue;
        const pf = pinFair(pin.list, r.game, r.teams, r.start, r.side);
        if (!pf) continue;
        const seen = Date.parse(pin.at);
        if (r.logFair == null) { r.logFair = pf.p; r.pinId = pf.pinId; mark(r); }
        if (pf.p !== r.closeFair) { Object.assign(r, { closeFair: pf.p, pinId: pf.pinId, seenAt: new Date(seen).toISOString() }); mark(r); }
        else if (!(seen - Date.parse(r.seenAt || 0) < SEEN_SAVE_MS)) { r.seenAt = new Date(seen).toISOString(); mark(r); }
        r._seen = Math.max(r._seen || 0, seen);
        continue;
      }
      const seenT = Math.max(r._seen || 0, Date.parse(r.seenAt || '') || 0);
      delete r._seen;
      const priced = r.closeFair != null && seenT > 0;
      Object.assign(r, { status: 'closed', seenAt: priced ? new Date(seenT).toISOString() : null, closeAgeMin: priced ? r2((start - seenT) / 60e3) : null,
        closeOk: priced && start - seenT <= CLOSE_FRESH_MS });
      mark(r);
    }
    await save(dirty.map(({ _seen, ...r }) => r));
    return dirty.length;
  }

  // results: result(game, row) → { s1, s2 } oriented to row.teams, or null
  async function grade(result, { minAgeMs = 45 * 60e3, maxAgeMs = 6 * 86400e3, limit = 200 } = {}) {
    await ready;
    const t = now(), dirty = [];
    let graded = 0;
    for (const r of rows.values()) {
      if (dirty.length >= limit) break;
      if (r.status !== 'closed' || r.outcome || r.noResult) continue;
      const age = t - Date.parse(r.start);
      if (!(age >= minAgeMs)) continue;
      if (age > maxAgeMs) { r.noResult = true; dirty.push(r); continue; }
      let d = null;
      try { d = result(r.game, r); } catch (e) { log.warn?.(`Esports bets: result ${r.game}: ${e.message}`); continue; }
      if (!d || !Number.isFinite(d.s1) || !Number.isFinite(d.s2) || d.s1 === d.s2) continue;
      const won = r.side === 0 ? d.s1 > d.s2 : d.s2 > d.s1;
      Object.assign(r, { outcome: won ? 'win' : 'loss', score: { s1: d.s1, s2: d.s2 }, gradedAt: new Date(t).toISOString() });
      graded++; dirty.push(r);
    }
    await save(dirty);
    return { graded, changed: dirty.length };
  }

  const counts = () => {
    const c = { open: 0, closed: 0, graded: 0, closeOk: 0, noClose: 0 };
    for (const r of rows.values()) {
      c[r.status] = (c[r.status] || 0) + 1;
      if (r.outcome) c.graded++;
      if (r.status === 'closed') c[r.closeOk ? 'closeOk' : 'noClose']++;
    }
    return c;
  };
  return { settle, observe, grade, counts, ready: () => ready, rows };
}

module.exports = { createEsBets, clean, idOf, pinMatch, pinFair, view, CLOSE_FRESH_MS, PIN_MAX_AGE_MS };
