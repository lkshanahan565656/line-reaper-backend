// ─── NHL AND SOCCER PROPS: EVERY APP LEG AT A SHARP'S OWN NUMBER ─────────────
// PrizePicks, Underdog, Sleeper and DK Pick6 post NHL shots, points, goals,
// assists and saves, and soccer shots, shots on target, goals and assists.
// Each leg is priced only where a sharp hangs the app's exact number, never
// on a curve of ours:
//
//   Pinnacle    NHL player props (its guest feed posts ~600 a night), no-vig
//   Kalshi      NHL and soccer player ladders, the mid where it lists them
//   FanDuel     NHL shots, goals, saves (two-way), read direct: support only
//   BetRivers   NHL "at least 1 assist" (Yes/No): support only. Soccer:
//               Kambi posts player shots, shots on target, "To Score", "To
//               give an assist" and "To score or give an assist" as ONE-SIDED
//               Over/Yes prices. A one-sided price keeps its margin, so its
//               implied chance is an upper bound on the Over; 1 minus it is a
//               lower bound on the Under, the only side it can back.
//
// Kinds, fixed 10-25 before any result (checks/nhlsoc-2026-10-25/PREREGISTERED.md):
//   nhs-pin     NHL: Pinnacle at the app's number says this side clears the
//               app's break-even by 2+ points of win chance
//   nhs-kalshi  no Pinnacle at that number, Kalshi does, same 2+ points
//   nhs-bound   soccer Unders: BetRivers' one-sided Over, margin left in,
//               still leaves the Under 2+ points past break-even
// Each is its own record (sporttrack.js), out of the headline, Best Plays and
// alerts, judged at 50 graded vs the same source's close and the results.
// Break-evens are the board record's (nflsunday.breakEven): PrizePicks 3-pick
// Power 55.03%, Pick6 its 3-pick table over the pick's multiplier, Underdog
// and Sleeper by multiplier. Action Network's books never price a leg here.

const { canonName } = require('./ev');
const { breakEven } = require('./nflsunday');

const SPORTS = new Set(['NHL', 'SOCCER']);
const KINDS = ['nhs-pin', 'nhs-kalshi', 'nhs-bound'];
const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const OPTS = { minPts: 0.02, slackMs: 3 * 3600e3 };
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = x => Math.round(x * 1e4) / 1e4;

// ── BetRivers (Kambi) soccer ──
// Kambi's soccer leagues (listView paths) the apps post players from
const KAMBI_SOCCER = ['football/england/premier_league', 'football/spain/la_liga', 'football/italy/serie_a', 'football/germany/bundesliga',
  'football/france/ligue_1', 'football/usa/mls', 'football/mexico/liga_mx', 'football/netherlands/eredivisie',
  'football/champions_league', 'football/europa_league', 'football/conference_league', 'football/england/championship',
  'football/portugal/liga_portugal', 'football/brazil/brasileirao_serie_a'];
// criterion → the board's soccer key and how its line reads. "Player's X"
// offers carry the line ("Over 0.5"); the Yes offers are the 0.5 (2 goals: 1.5).
// First-half, headed and outside-the-box shots are other stats: skipped.
const KB_SOCCER = [
  [/^player'?s shots on target\b(?!.*(1st half|2nd half|headed|outside))/i, 'shots_on_target', 'line'],
  [/^player'?s shots\b(?!.*(on target|1st half|2nd half|headed|outside))/i, 'shots_attempted', 'line'],
  [/^to score$/i, 'goals', 0.5],
  [/^to score at least 2 goals$/i, 'goals', 1.5],
  [/^to give an assist\b/i, 'assists', 0.5],
  [/^to score or give an assist\b/i, 'goals_+_assists', 0.5],
];
const kbName = p => (p.includes(',') ? p.split(',').map(x => x.trim()).reverse().join(' ') : p.trim());
// betoffer/event payload → { event, props: [{ player, mkey, line, over }] } (over: American, one-sided)
function kambiSoccerProps(payload, now = Date.now()) {
  const e = payload?.events?.[0];
  const start = Date.parse(e?.start || '');
  if (!e || e.state !== 'NOT_STARTED' || !(start > now)) return null;
  const [home, away] = String(e.englishName || '').split(' - ').map(s => s.trim());
  const props = [], seen = new Set();
  for (const b of payload.betOffers || []) {
    if (b.suspended) continue;
    const label = String(b?.criterion?.englishLabel || '').replace(/[’]/g, "'").replace(/\s*\(settled using opta data\)\s*/i, '').trim();
    const hit = KB_SOCCER.find(([re]) => re.test(label));
    if (!hit) continue;
    for (const o of b.outcomes || []) {
      if (o.status !== 'OPEN' || !o.participant || !(o.type === 'OT_OVER' || o.type === 'OT_YES')) continue;
      const line = hit[2] === 'line' ? (num(o.line) != null ? num(o.line) / 1000 : null) : hit[2];
      const over = num(o.oddsAmerican);
      if (line == null || over == null || Math.abs(over) < 100) continue;
      const player = kbName(String(o.participant));
      const k = `${canonName(player)}|${hit[1]}|${line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      props.push({ player, mkey: hit[1], line, over });
    }
  }
  return { event: { id: e.id, home, away, start: new Date(start).toISOString() }, props };
}
// listView → ids of matches not started within withinMs, soonest first
function kambiEventIds(payload, { now = Date.now(), withinMs = 30 * 3600e3 } = {}) {
  return (payload?.events || []).map(x => x.event).filter(e => e && e.state === 'NOT_STARTED' && Date.parse(e.start) > now && Date.parse(e.start) - now < withinMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map(e => e.id);
}
// parsed events → Map('SOCCER|player|mkey' → [{ line, over, pOverMax, start, event }])
function indexSoccer(events) {
  const idx = new Map();
  for (const ev of events || []) for (const p of ev.props || []) {
    const k = `SOCCER|${canonName(p.player)}|${p.mkey}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ line: p.line, over: p.over, pOverMax: r4(toProb(p.over)), start: ev.event.start, event: `${ev.event.home} - ${ev.event.away}` });
  }
  return idx;
}

// BetRivers' soccer board: each league's list every everyMs, then the match
// pages starting inside withinMs, maxEvents a pass, gapMs apart. A 403/429
// holds the reader for its Retry-After (5 minutes at least). Nothing logs in.
function createSoccerBooks({ http, enabled = true, base = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj', leagues = KAMBI_SOCCER,
  everyMs = 10 * 60e3, withinMs = 30 * 3600e3, maxEvents = 60, gapMs = 400, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const st = { enabled, at: null, events: [], idx: new Map(), errors: [], holdUntil: 0, counts: { leagues: 0, events: 0, props: 0 }, running: false };
  const q = 'lang=en_US&market=US';
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
  async function tick() {
    if (!st.enabled || st.running || now() < st.holdUntil || (st.at && now() - Date.parse(st.at) < everyMs)) return st;
    st.running = true;
    const errors = [];
    try {
      const ids = [];
      let listed = 0;
      for (const path of leagues) {
        try {
          const r = await http.get(`${base}/listView/${path}/all/matches.json?${q}`, { headers, timeout: 20000 });
          const got = kambiEventIds(r.data, { now: now(), withinMs });
          if (got.length) listed++;
          ids.push(...got.map(id => ({ id, t: (r.data.events || []).find(x => x.event?.id === id)?.event?.start })));
        } catch (e) {
          const s = e.response?.status;
          if (s === 403 || s === 429) { st.holdUntil = now() + Math.max(Number(e.response?.headers?.['retry-after']) * 1000 || 0, 5 * 60e3); throw e; }
          if (s !== 404) errors.push(`${path}: ${s || ''} ${e.message}`.slice(0, 120));
        }
        await wait(gapMs);
      }
      ids.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const events = [];
      // a match listed under two paths (a cup, a group) is read once
      for (const id of [...new Set(ids.map(x => x.id))].slice(0, maxEvents)) {
        try {
          const r = await http.get(`${base}/betoffer/event/${id}.json?${q}&includeParticipants=true`, { headers, timeout: 20000 });
          const ev = kambiSoccerProps(r.data, now());
          if (ev?.props.length) events.push(ev);
        } catch (e) {
          const s = e.response?.status;
          if (s === 403 || s === 429) { st.holdUntil = now() + Math.max(Number(e.response?.headers?.['retry-after']) * 1000 || 0, 5 * 60e3); break; }
          errors.push(`event ${id}: ${s || ''} ${e.message}`.slice(0, 120));
        }
        await wait(gapMs);
      }
      // a pass that read nothing (blocked, or between match days) keeps the last board
      if (events.length || !st.events.length) { st.events = events; st.idx = indexSoccer(events); }
      st.counts = { leagues: listed, events: events.length, props: events.reduce((a, e) => a + e.props.length, 0) };
      st.at = new Date(now()).toISOString();
    } catch (e) { errors.push(`${e.response?.status || ''} ${e.message}`.slice(0, 160)); st.at = new Date(now()).toISOString(); }
    finally { st.errors = errors.slice(0, 6); st.running = false; }
    return st;
  }
  // BetRivers' one-sided quotes for a board row (same match: start within slackMs)
  function quotesFor(row, slackMs = OPTS.slackMs) {
    const list = st.idx.get(`${row.sport}|${canonName(row.player)}|${row.mkey}`);
    const t = Date.parse(row.startTime || '');
    if (!list || !t) return [];
    return list.filter(q => Math.abs(Date.parse(q.start) - t) <= slackMs);
  }
  return { state: st, tick, quotesFor };
}

// ── pricing at the app's number ──
// src: { pin: Pinnacle quotes [{ line, pOver }] for the row's game, books:
// [{ book, line, pOver }] (FanDuel, BetRivers two-way), kalshi: Map(line →
// P(over)), bound: [{ line, pOverMax }] (BetRivers soccer, one-sided) }
// → every source's P(over) at exactly `line` (null where it doesn't hang it)
function exactAt(line, { pin = [], books = [], kalshi = null, bound = [] } = {}) {
  const at = (qs, f) => { const q = (qs || []).find(x => x.line === line); return q ? r4(f(q)) : null; };
  return {
    pinnacle: at(pin, q => q.pOver),
    fanduel: at(books.filter(q => q.book === 'fanduel'), q => q.pOver),
    betrivers: at(books.filter(q => q.book === 'betrivers'), q => q.pOver),
    kalshi: kalshi?.has?.(line) ? r4(kalshi.get(line)) : null,
    betriversOverMax: at(bound, q => q.pOverMax),
  };
}
const sideP = (side, p) => (p == null ? null : side === 'Over' ? p : r4(1 - p));
// one app cell's open sides → [{ side, be, mult, decimal }]
function cellSides(book, c) {
  const v = [c.line, book === 'prizepicks' ? null : num(c.over), book === 'prizepicks' ? null : num(c.under), c.overOpen === false ? 0 : 1, c.underOpen === false ? 0 : 1];
  const out = [];
  for (const side of ['Over', 'Under']) {
    if ((side === 'Over' ? v[3] : v[4]) === 0) continue;
    const be = breakEven(book, side, v);
    if (!(be > 0 && be < 1)) continue;
    out.push({ side, be: r4(be), mult: (side === 'Over' ? v[1] : v[2]) ?? 1, decimal: r4(1 / be) });
  }
  return out;
}
// the kind a side takes, and the price it takes it on, or null
function kindFor(sport, side, q, be, o = OPTS) {
  const clears = p => p != null && p >= be + o.minPts;
  if (q.pinnacle != null) return clears(sideP(side, q.pinnacle)) ? { kind: 'nhs-pin', fair: sideP(side, q.pinnacle) } : null;
  if (q.kalshi != null) return clears(sideP(side, q.kalshi)) ? { kind: 'nhs-kalshi', fair: sideP(side, q.kalshi) } : null;
  // the one-sided bound backs an Under only: 1 - an Over price with its margin in
  if (sport === 'SOCCER' && side === 'Under' && q.betriversOverMax != null) {
    const f = r4(1 - q.betriversOverMax);
    return clears(f) ? { kind: 'nhs-bound', fair: f } : null;
  }
  return null;
}
// one board row → { legs: [{ book, priced: { pinnacle, ... } }], plays: [{ play, kind }] }
// play is sporttrack's shape: book, side, line, mult, decimal (1 / break-even), fair, ev, sources
function rowPlays(row, src, o = OPTS) {
  const legs = [], plays = [];
  if (!SPORTS.has(row?.sport) || row.esports) return { legs, plays };
  for (const [book, c] of Object.entries(row.books || {})) {
    if (!APPS.includes(book) || c?.line == null) continue;
    const q = exactAt(c.line, src);
    legs.push({ book, q });
    for (const s of cellSides(book, c)) {
      const k = kindFor(row.sport, s.side, q, s.be, o);
      if (!k) continue;
      const sources = Object.fromEntries(Object.entries(q).filter(([, p]) => p != null).map(([b, p]) => [b, sideP(s.side, p)]));
      plays.push({ kind: k.kind, play: { book, side: s.side, line: c.line, mult: s.mult, decimal: s.decimal, be: s.be, fair: k.fair, ev: +((k.fair * s.decimal - 1) * 100).toFixed(2), sources, entry: book === 'prizepicks' ? '3-pick power' : null } });
    }
  }
  return { legs, plays };
}
// the close a leg of `kind` is judged on: the same source at the same number now (P(over))
function closeAt(kind, line, src) {
  const q = exactAt(line, src);
  if (kind === 'nhs-pin') return q.pinnacle;
  if (kind === 'nhs-kalshi') return q.kalshi;
  if (kind === 'nhs-bound') return q.betriversOverMax;
  return null;
}
// every source at the number now, as P(over), for the record's closeSources
function sourcesAt(line, src) {
  return Object.fromEntries(Object.entries(exactAt(line, src)).filter(([, p]) => p != null));
}

// ── coverage: what was priced, per sport and app, since boot ──
// each leg (sport, player, stat, app, line, day) counted once
function createCoverage() {
  const seen = new Map();   // id → { sport, book, priced: Set }
  const flags = new Map();  // kind|sport|book → Set(id)
  function observe(row, legs, plays) {
    const day = String(row.startTime || '').slice(0, 10);
    for (const { book, q } of legs) {
      const id = `${row.sport}|${canonName(row.player)}|${row.mkey}|${book}|${day}`;
      const e = seen.get(id) || { sport: row.sport, book, mkey: row.mkey, priced: new Set() };
      for (const [b, p] of Object.entries(q)) if (p != null) e.priced.add(b);
      seen.set(id, e);
    }
    for (const { kind, play } of plays) {
      const k = `${kind}|${row.sport}|${play.book}`;
      if (!flags.has(k)) flags.set(k, new Set());
      flags.get(k).add(`${canonName(row.player)}|${row.mkey}|${play.side}|${play.line}|${day}`);
    }
  }
  function summary() {
    const by = {};
    for (const e of seen.values()) {
      const k = `${e.sport}|${e.book}`;
      const o = by[k] ||= { legs: 0, priced: 0, pinnacle: 0, kalshi: 0, fanduel: 0, betrivers: 0, betriversOverMax: 0 };
      o.legs++;
      if (e.priced.size) o.priced++;
      for (const b of e.priced) o[b]++;
    }
    const byStat = {};
    for (const e of seen.values()) {
      const k = `${e.sport}|${e.mkey}`;
      const o = byStat[k] ||= { legs: 0, priced: 0 };
      o.legs++; if (e.priced.size) o.priced++;
    }
    return { legs: by, byStat, flags: Object.fromEntries([...flags].map(([k, s]) => [k, s.size])) };
  }
  // keep a week
  function prune(t = Date.now()) {
    const cut = new Date(t - 7 * 86400e3).toISOString().slice(0, 10);
    for (const [id] of seen) if (id.split('|').pop() < cut) seen.delete(id);
    for (const s of flags.values()) for (const id of s) if (id.split('|').pop() < cut) s.delete(id);
  }
  return { observe, summary, prune };
}

module.exports = { SPORTS, KINDS, APPS, OPTS, KAMBI_SOCCER, kambiSoccerProps, kambiEventIds, indexSoccer, createSoccerBooks, exactAt, cellSides, kindFor, rowPlays, closeAt, sourcesAt, createCoverage };
