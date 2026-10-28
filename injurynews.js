// ─── INJURY NEWS: PICK'EM LINES LEFT OPEN AFTER A PLAYER IS RULED OUT ────────
// When an NBA rotation player is ruled out, his teammates' numbers go up
// (more minutes, more shots) and Pinnacle reprices their props within minutes.
// A pick'em app that is slow to react still hangs the pre-news number. This
// module finds those legs:
//
//   news     a rotation player (MIN_MPG+ minutes a game over his last 5 games
//            in our box-score history) goes to Out or Doubtful. Live: ESPN's
//            injury list, read every few minutes (createInjuryWatch). The
//            backtest reads the official NBA injury report instead. A player
//            already out at the first read we have of him is not news.
//   before   the quotes as they stood PRE_MS before the news (a report or a
//            feed can list it up to 15 minutes late)
//   leg      a teammate's prop on an app whose number is the same as before
//            the news, while Pinnacle's chance at that number has moved
//            MIN_PTS+ points of win chance since (its own price where it sits
//            on the number, else the stat's curve through its line). Side:
//            the way Pinnacle moved. Flagged from the news to tip-off, at
//            most WINDOW_MS after it.
//
// Pre-registered 2026-10-25 before any result was read
// (checks/injury-stale-2026-10-25/PREREGISTERED.md). Kinds, one per app,
// never pooled: injury-stale (PrizePicks), p6-injury-stale, ud-injury-stale,
// sl-injury-stale. Research until one app has 50+ graded live legs with the
// hit rate 2+ standard errors over its break-even, CLV t 2+ against
// Pinnacle's close and an independent re-check. No alerts.
//
// Pure functions plus one small stateful watcher; the server and the backtest
// feed both the same way.

const { canonName } = require('./ev');
const SP = require('./sportprops');
const NS = require('./nflsunday');

const MIN_MPG = 20;
const MIN_PTS = 2;
const PRE_MS = 15 * 60e3;
const WINDOW_MS = 3 * 3600e3;
const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const KIND = { prizepicks: 'injury-stale', pick6: 'p6-injury-stale', underdog: 'ud-injury-stale', sleeper: 'sl-injury-stale' };
const KINDS = new Set(Object.values(KIND));
const BE = { prizepicks: 0.5503, pick6: 0.567, underdog: 0.5623, sleeper: null };
const appOfKind = k => Object.keys(KIND).find(a => KIND[a] === k) || null;
const isOut = s => /^(out|doubtful)\b/i.test(String(s || '').trim());
const { r4 } = require('./mathutil');
const EPS = 1e-9;

// ESPN's abbreviations are the keys; the apps' map onto them (as nbadata.js)
const ABBR_FIX = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN' };
const fixAbbr = a => ABBR_FIX[String(a || '').toUpperCase()] || String(a || '').toUpperCase();

// ── the news feed ──
// ESPN's NBA injury list → [{ key, name, team, status, date, comment }]. The
// team's abbreviation is on each athlete (the list's own team block carries
// only an id and a name).
function espnEntries(data) {
  const out = [];
  for (const tm of data?.injuries || []) {
    for (const i of tm.injuries || []) {
      const name = i.athlete?.displayName;
      const team = fixAbbr(i.athlete?.team?.abbreviation || tm.team?.abbreviation || tm.abbreviation || '');
      if (!name || !team) continue;
      const status = String(i.status || i.details?.fantasyStatus?.description || '').trim();
      const date = Date.parse(i.date || '');
      out.push({ key: canonName(name), name, team, status, date: Number.isFinite(date) ? date : null, comment: String(i.shortComment || '').slice(0, 280) });
    }
  }
  return out;
}

// Status changes between reads. The first read is the baseline: nobody on it
// is news. A player who goes to Out (or Doubtful) from anything else, or who
// shows up already out after the baseline, is an event. Its news time is the
// feed's own time for the entry when that falls between our last read and
// this one, else this read's time.
function createInjuryWatch({ keepMs = 36 * 3600e3 } = {}) {
  const now = new Map();          // key → { status, team, name, at }
  const events = [];              // newest last
  let lastRead = null, reads = 0;
  function observe(entries, t) {
    const seen = new Set();
    const fresh = [];
    for (const e of entries || []) {
      if (!e?.key) continue;
      seen.add(e.key);
      const prev = now.get(e.key);
      if (lastRead != null && isOut(e.status) && !(prev && isOut(prev.status))) {
        const newsAt = e.date != null && e.date > lastRead - PRE_MS && e.date <= t ? e.date : t;
        const ev = { key: e.key, name: e.name, team: e.team, status: e.status, from: prev ? prev.status : 'not listed', newsAt, seenAt: t, comment: e.comment || '' };
        events.push(ev); fresh.push(ev);
      }
      now.set(e.key, { status: e.status, team: e.team, name: e.name, at: t });
    }
    // a player off the list is back (or never was): his next Out is news again
    for (const k of [...now.keys()]) if (!seen.has(k)) now.delete(k);
    while (events.length && t - events[0].newsAt > keepMs) events.shift();
    lastRead = t; reads++;
    return fresh;
  }
  return { observe, events: () => events.slice(), status: () => ({ reads, listed: now.size, out: [...now.values()].filter(x => isOut(x.status)).length, lastRead: lastRead && new Date(lastRead).toISOString(), events: events.length }) };
}

// a player's team and minutes from box-score history (nbamodel buildHistory's
// players map: key → [{ t, team, min }], in time order), games before t
function rotationOf(players, key, t, n = 5) {
  const list = (players?.get(key) || []).filter(g => g.t < t);
  if (!list.length) return null;
  const last = list.slice(-n);
  const mpg = last.reduce((a, g) => a + (g.min || 0), 0) / last.length;
  return { team: last[last.length - 1].team, mpg: Math.round(mpg * 10) / 10, games: last.length, rotation: mpg >= MIN_MPG };
}

// Pinnacle's P(over) at `line` off its quote { line, pOver }: its own price on
// the number, else the stat's curve through its line → { p, exact } | null
function pinAtLine(mkey, pin, line, sport = 'NBA') {
  if (!pin || !Number.isFinite(pin.line) || !(pin.pOver > 0 && pin.pOver < 1)) return null;
  if (Math.abs(pin.line - line) < EPS) return { p: pin.pOver, exact: true };
  if (SP.K[mkey] == null) return null;
  const mean = SP.meanFor(mkey, sport, pin.line, pin.pOver);
  const p = mean == null ? null : SP.pOver(mkey, sport, mean, line);
  return Number.isFinite(p) && p > 0 && p < 1 ? { p, exact: false } : null;
}

// One app cell against Pinnacle before and now → the leg, or null.
// app cells: { line, over, under, overOpen, underOpen } (over/under: the
// app's multipliers, null for PrizePicks). pin quotes: { line, pOver }.
function checkLeg({ app, mkey, pinPre, pinNow, appPre, appNow, sport = 'NBA', minPts = MIN_PTS }) {
  if (!appPre || !appNow || !Number.isFinite(appNow.line) || appPre.line !== appNow.line) return null;
  const line = appNow.line;
  const a = pinAtLine(mkey, pinPre, line, sport), b = pinAtLine(mkey, pinNow, line, sport);
  if (!a || !b) return null;
  const d = b.p - a.p;
  if (!(Math.abs(d) >= minPts / 100 - EPS)) return null;
  const side = d > 0 ? 'Over' : 'Under';
  if (side === 'Over' ? appNow.overOpen === false : appNow.underOpen === false) return null;
  const v = [line, appNow.over ?? null, appNow.under ?? null, appNow.overOpen === false ? 0 : 1, appNow.underOpen === false ? 0 : 1];
  const be = NS.breakEven(app, side, v);
  if (!(be > 0 && be < 1)) return null;
  const fair = side === 'Over' ? b.p : 1 - b.p;
  const mult = (side === 'Over' ? appNow.over : appNow.under) ?? 1;
  return { app, kind: KIND[app], side, line, mult, be: r4(be), fair: r4(fair), ev: +((fair / be - 1) * 100).toFixed(2),
    dPts: +(Math.abs(d) * 100).toFixed(1), pinPre: { line: pinPre.line, pOver: r4(pinPre.pOver) }, pinNow: { line: pinNow.line, pOver: r4(pinNow.pOver) }, exact: !!b.exact };
}

// Every leg for one news event.
//   event      { key, name, team, newsAt }
//   rows       props-board rows (sport, player, mkey, startTime, books)
//   teamOf     (player key, t) → { team, mpg, rotation } | null (rotationOf)
//   pinAt      (row, t) → Pinnacle's quote { line, pOver } as of t (null = none)
//   appAt      (row, app, t) → the app's cell as of t (null = not listed)
//   t          now
// The out player must be in the rotation; the row's game must start after
// now and within 18 hours of the news.
function legsFor(event, rows, { teamOf, pinAt, appAt, t, apps = APPS, minPts = MIN_PTS, windowMs = WINDOW_MS }) {
  const out = [];
  if (!(t - event.newsAt <= windowMs) || t < event.newsAt) return out;
  const me = teamOf(event.key, event.newsAt);
  if (!me?.rotation) return out;
  const pre = event.newsAt - PRE_MS;
  for (const row of rows || []) {
    if (row?.sport !== 'NBA' || row.esports || !row.mkey || String(row.mkey).includes('|')) continue;
    const start = Date.parse(row.startTime || '');
    if (!(start > t) || start - event.newsAt > 18 * 3600e3) continue;
    const pk = canonName(row.player);
    if (pk === event.key) continue;
    const mate = teamOf(pk, event.newsAt);
    if (!mate || mate.team !== event.team) continue;
    const pinPre = pinAt(row, pre), pinNow = pinAt(row, t);
    if (!pinPre || !pinNow) continue;
    for (const app of apps) {
      const leg = checkLeg({ app, mkey: row.mkey, pinPre, pinNow, appPre: appAt(row, app, pre), appNow: appAt(row, app, t), minPts });
      if (leg) out.push({ row, leg, event, mins: Math.round((t - event.newsAt) / 60e3), mateMpg: mate.mpg });
    }
  }
  return out;
}

// a found leg → what sporttrack.record logs
function playOf({ row, leg, event, mins }) {
  return { row, kind: leg.kind, research: true,
    play: { book: leg.app, side: leg.side, line: leg.line, mult: leg.mult, decimal: r4(1 / leg.be), fair: leg.fair, ev: leg.ev,
      pinLine: leg.pinNow.line, pinOver: leg.pinNow.pOver, gapPts: leg.dPts, exact: leg.exact,
      injury: { out: event.name, outKey: event.key, team: event.team, newsAt: new Date(event.newsAt).toISOString(), mins, pinPre: leg.pinPre, pinNow: leg.pinNow, dPts: leg.dPts } } };
}

// ── the bar ──
function zOf(w, n, be) { return n && be ? +((w - n * be) / Math.sqrt(n * be * (1 - be))).toFixed(2) : null; }
const BAR = 'Not a bet until one app has 50+ graded live legs with the hit rate 2+ standard errors above its break-even (PrizePicks 55.03%, Pick6 56.7%, Underdog and Sleeper at their payouts), CLV 2+ standard errors over Pinnacle\'s close, and an independent re-check.';

module.exports = { MIN_MPG, MIN_PTS, PRE_MS, WINDOW_MS, APPS, KIND, KINDS, BE, BAR, appOfKind, isOut, fixAbbr, espnEntries, createInjuryWatch, rotationOf, pinAtLine, checkLeg, legsFor, playOf, zOf };
