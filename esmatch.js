// ─── ESPORTS: WHICH MATCH AN APP'S LINE IS FOR (esmatch.js) ─────────────────
// CS round robins put a team in two or three Bo1s a day, and the apps list a
// player's "Kills on Map 1" once per match. Keyed by player and stat alone,
// the board took whichever listing came first: a PrizePicks line priced
// against Underdog's line for another opponent, the pick flipping between
// matches every few minutes. Here each line gets the match it belongs to.
//
// The apps don't agree on start times (WBT vs ENCE on 10-15: Underdog 14:00,
// PrizePicks 12:00 UTC), so the opponent decides, not the clock:
//   Underdog   "WBT vs ENCE" and the player's team
//   PrizePicks "ENCE MAP 1" (the opponent's code and the span)
//   Sleeper    no title or start, but both teams' lines share one game id
//   Pick6      "A vs B" like Underdog
// A line with no opponent joins a match by start time (within an hour and a
// half), or the player's only match. Anything still unsure stands alone.
const { opponentFrom, teamsMatch, teamCode, splitMatchTitle } = require('./context');

const START_SLACK = 90 * 60e3;

// two names for one team: "EAC" and "Esport Academy Copenhagen", "Vitality"
// and "Team Vitality". exact first, so a code can't take a team it merely fits
// (the matchers ask about the same two names thousands of times a build: the
// answers are kept, strings only; the memo is dropped whole when it fills)
const SAME_MEMO_MAX = 50000;
const sameMemo = new Map();
const sameTeamOnce = (a, b) => teamsMatch(a, b) || teamCode(a, b) || teamCode(b, a);
function sameTeam(a, b) {
  if (!a || !b) return false;
  if (typeof a !== 'string' || typeof b !== 'string') return sameTeamOnce(a, b);
  const key = `${a}\u0000${b}`;
  if (sameMemo.has(key)) return sameMemo.get(key);
  const v = sameTeamOnce(a, b);
  if (sameMemo.size >= SAME_MEMO_MAX) sameMemo.clear();
  sameMemo.set(key, v);
  return v;
}

// looser, for one player's own opponents only: "BB Team" is BetBoom
const initials = n => String(n || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(w => w && !/^(team|esports?|gaming|club)$/i.test(w)).map(w => w[0]).join('').toLowerCase();
const bare = n => String(n || '').toLowerCase().replace(/\b(team|esports?|gaming|club)\b/g, '').replace(/[^a-z0-9]/g, '');
const looseTeam = (a, b) => sameTeam(a, b) || (bare(a).length >= 2 && (initials(a) === bare(b) || initials(b) === bare(a)));

// "KOIA" and "Movistar KOI Fénix", "BRO" and "OKSavingsBank BRION": a word of
// one starts the other's code, or the code runs through a word. Too
// loose to split a board on; enough to keep one Bo5's map lines (PrizePicks
// times each map) from counting as two matches in the record check
const shareWord = (a, b) => {
  const words = n => String(n || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !/^(team|esports?|gaming|club|academy)$/.test(w));
  const sq = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // a short code running through one word in order, from its first letter ("BRO" in "brion")
  const runs = (code, w) => { if (code.length < 3 || code.length > 4 || code[0] !== w[0]) return false; let i = 0; for (const ch of w) if (ch === code[i]) i++; return i === code.length; };
  const one = (x, y) => words(x).some(w => sq(y).startsWith(w) || runs(sq(y), w));
  return one(a, b) || one(b, a);
};

// the other team on one line, or null. slOpp: Sleeper game id → its teams
function lineOpponent(l, slOpp = null) {
  if (!l) return null;
  if (l.book === 'sleeper') {
    const teams = slOpp?.get(String(l.gameId)) || [];
    const others = teams.filter(t => !sameTeam(t, l.team));
    return others.length === 1 ? others[0] : null;
  }
  const t = String(l.matchTitle || '');
  const pp = /^(.+?)\s+MAPS?\s+\d/i.exec(t);
  if (pp && !splitMatchTitle(t)) return pp[1].trim();
  return opponentFrom(l.team, t, null) || null;
}

// Sleeper game id → the teams with lines on it
function sleeperTeams(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (l?.book !== 'sleeper' || l.gameId == null || !l.team) continue;
    const k = String(l.gameId), list = m.get(k) || m.set(k, []).get(k);
    if (!list.some(t => sameTeam(t, l.team))) list.push(l.team);
  }
  return m;
}

// Every line's match, per player: a Map line → tag. Lines of one player in one
// match share a tag; a player in two matches gets two. The tag is the match's
// earliest Underdog or PrizePicks start (a game id when neither lists it), so
// the esports board and the props board, clustering the same lines, agree on
// it. A Sleeper line that can't be placed in a multi-match day gets null:
// it has no start of its own and the board leaves it out.
// playerOf(l) and sportOf(l) say whose line it is (callers normalise names).
/** @param {any} lines @param {any} [opts] */
function matchTags(lines, { playerOf, sportOf = l => l.sport } = {}) {
  const slOpp = sleeperTeams(lines);
  const byPlayer = new Map();
  for (const l of lines || []) {
    if (!l || !l.player) continue;
    const k = `${sportOf(l)}|${playerOf(l)}`;
    (byPlayer.get(k) || byPlayer.set(k, []).get(k)).push(l);
  }
  const out = new Map();
  for (const list of byPlayer.values()) {
    const clusters = [];   // { opp, starts: [ms], refStarts: [ms], ids: Set, lines: [] }
    const idOf = l => (l.gameId != null && l.gameId !== '' ? `${l.book}|${l.gameId}` : null);
    const add = (c, l, opp) => {
      c.lines.push(l);
      if (opp && !c.opp) c.opp = opp;
      const t = Date.parse(l.startTime || '');
      if (Number.isFinite(t)) { c.starts.push(t); if (l.book === 'underdog' || l.book === 'prizepicks') c.refStarts.push(t); }
      const id = idOf(l);
      if (id) c.ids.add(id);
    };
    const pending = [];
    // Sleeper last: its opponent comes from the other team's lines and its names differ most
    list.sort((a, b) => Number(a.book === 'sleeper') - Number(b.book === 'sleeper'));
    // first the lines that name their opponent (or share a game id with one that does)
    for (const l of list) {
      const opp = lineOpponent(l, slOpp), id = idOf(l);
      let c = id ? clusters.find(x => x.ids.has(id)) : null;
      if (!c && opp) {
        const exact = clusters.filter(x => x.opp && teamsMatch(x.opp, opp));
        const near = exact.length ? exact : clusters.filter(x => x.opp && sameTeam(x.opp, opp));
        const loose = near.length ? near : clusters.filter(x => x.opp && looseTeam(x.opp, opp));
        if (loose.length === 1) c = loose[0];
        else if (loose.length > 1) { out.set(l, null); continue; }
      }
      // a Sleeper opponent nobody else names ("BB Team") is placed like a line with none
      if (!c && (!opp || (l.book === 'sleeper' && clusters.length))) { pending.push(l); continue; }
      if (!c) { c = { opp, starts: [], refStarts: [], ids: new Set(), lines: [] }; clusters.push(c); }
      add(c, l, opp);
    }
    // then the rest: by start time, or the only match there is
    for (const l of pending) {
      const t = Date.parse(l.startTime || ''), id = idOf(l);
      let c = id ? clusters.find(x => x.ids.has(id)) || null : null;
      const otherSleeper = x => l.book === 'sleeper' && [...x.ids].some(k => k.startsWith('sleeper|') && k !== id);
      if (c) { /* its game id is already placed */ } else if (Number.isFinite(t)) {
        const near = clusters.filter(x => x.starts.some(s => Math.abs(s - t) <= START_SLACK));
        if (near.length === 1) c = near[0];
        else if (!near.length && !clusters.some(x => x.starts.length)) c = clusters.length === 1 ? clusters[0] : null;
        if (!c && !near.length) { c = { opp: null, starts: [], refStarts: [], ids: new Set(), lines: [] }; clusters.push(c); }
      } else if (clusters.length === 1 && !otherSleeper(clusters[0])) c = clusters[0];
      else if (!clusters.length && l.book === 'sleeper') { c = { opp: null, starts: [], refStarts: [], ids: new Set(), lines: [] }; clusters.push(c); }
      if (!c) { out.set(l, null); continue; }
      add(c, l, null);
    }
    for (const c of clusters) {
      const s = c.refStarts;
      const tag = s.length ? new Date(Math.min(...s)).toISOString()
        : `id:${[...c.ids].sort()[0] || c.opp || 'none'}`;
      for (const l of c.lines) out.set(l, tag);
    }
  }
  return out;
}

// A Sleeper line's start and title, from an Underdog (first) or PrizePicks line
// on the same team against the same opponent. With no opponent, only when the
// team has one upcoming match. null when nothing fits: the line can't be timed.
// bySport (borrowRefs): the refs that can lend a match, by sport, read once for many lines
function borrowMatch(l, refs, { slOpp = null, sportOf = x => x.sport, now = Date.now(), bySport = null } = {}) {
  if (!l?.team) return null;
  const opp = lineOpponent(l, slOpp);
  const mine = bySport ? (bySport.get(sportOf(l)) || []).filter(r => sameTeam(r.team, l.team))
    : (refs || []).filter(r => r.team && sportOf(r) === sportOf(l) && Date.parse(r.startTime || '') > now && sameTeam(r.team, l.team));
  let fit;
  if (opp) fit = mine.filter(r => { const o = lineOpponent(r); return o && looseTeam(o, opp); });
  else {
    const opps = [];
    for (const r of mine) { const o = lineOpponent(r); if (o && !opps.some(x => sameTeam(x, o))) opps.push(o); }
    fit = opps.length <= 1 ? mine : [];
  }
  if (!fit.length) return null;
  const ref = fit.find(r => r.book === 'underdog') || fit.slice().sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))[0];
  return { ...l, team: ref.team, startTime: ref.startTime, matchTitle: ref.matchTitle || '' };
}

// refs → Map sport → the refs with a team and a start still ahead, in their order
function borrowRefs(refs, { sportOf = x => x.sport, now = Date.now() } = {}) {
  const out = new Map();
  for (const r of refs || []) {
    if (!(r.team && Date.parse(r.startTime || '') > now)) continue;
    const k = sportOf(r);
    (out.get(k) || out.set(k, []).get(k)).push(r);
  }
  return out;
}

// The opponent on a pick (or a tracker row): the board's matchup, an "A vs B"
// title, or PrizePicks' "OPP MAP 1"
function pickOpponent(p) {
  return p?.context?.opponent || lineOpponent({ ...p, book: p?.book === 'sleeper' ? 'x' : p?.book }) || null;
}

// A Pinnacle (or any board) match for a pick: the player's team on one side
// and, when the pick names its opponent, that team on the other; with no
// opponent and several of the team's matches, the nearest start within the
// slack, else none. teamsOf(m) → [a, b], startOf(m) → ms.
function sideFor(matches, p, { teamsOf = m => m.teams, startOf = m => Date.parse(m.start), windowMs = 12 * 3600e3, fits = (full, n) => !!teamCode(full, n) } = {}) {
  const t = Date.parse(p.startTime || ''), opp = pickOpponent(p);
  const hits = [];
  for (const m of matches || []) {
    const s = startOf(m);
    if (Number.isFinite(t) && Number.isFinite(s) && Math.abs(s - t) > windowMs) continue;
    const teams = teamsOf(m) || [];
    const i = [0, 1].find(j => fits(teams[j], p.team) && (!opp || fits(teams[1 - j], opp)));
    if (i != null) hits.push({ m, i, gap: Number.isFinite(t) && Number.isFinite(s) ? Math.abs(s - t) : Infinity });
  }
  if (hits.length <= 1 || opp) return hits.sort((a, b) => a.gap - b.gap)[0] || null;
  // the team plays more than once and the pick doesn't say whom: only a clear nearest start
  hits.sort((a, b) => a.gap - b.gap);
  return hits[0].gap <= START_SLACK && hits[1].gap > START_SLACK ? hits[0] : null;
}

// Record rows from days a team played more than one match: the team, a
// different opponent (or a start 90+ minutes away when either names none),
// within 20 hours. rows: tracker rows from every esports record.
// Returns the set of rows exposed to the old player-and-stat key.
function multiMatchRows(rows, { sportOf = r => r.sport } = {}) {
  const byTeam = new Map();
  const teamOf = r => String(r.team || '').trim();
  for (const r of rows || []) {
    const t = Date.parse(r.startTime || '');
    if (!teamOf(r) || !Number.isFinite(t)) continue;
    const k = sportOf(r);
    (byTeam.get(k) || byTeam.set(k, []).get(k)).push({ r, t, team: teamOf(r), opp: pickOpponent(r) });
  }
  const out = new Set();
  for (const list of byTeam.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (Math.abs(a.t - b.t) > 20 * 3600e3 || !sameTeam(a.team, b.team)) continue;
        const differ = a.opp && b.opp ? !sameTeam(a.opp, b.opp) && !looseTeam(a.opp, b.opp) && !shareWord(a.opp, b.opp) : Math.abs(a.t - b.t) >= START_SLACK;
        if (differ) { out.add(a.r); out.add(b.r); }
      }
    }
  }
  return out;
}

module.exports = { sameTeam, looseTeam, lineOpponent, sleeperTeams, matchTags, borrowMatch, borrowRefs, pickOpponent, sideFor, multiMatchRows, START_SLACK };
