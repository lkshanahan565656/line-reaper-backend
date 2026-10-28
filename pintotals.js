// ─── PINNACLE'S MAP TOTALS AGAINST WHAT WAS PLAYED ──────────────────────────
// Every esports kill model leans on one Pinnacle number per map: the round
// total (CS2, Valorant: the round model) or each team's kills (LoL, Dota: the
// kill-share model, and the team kill gaps in pingap.js). A clear is really a
// bet that number is right, and the models' spread around it was assumed
// (team kills sd 6 a map for LoL, 8 for Dota; rounds kappa 35) because no
// Pinnacle history existed. This keeps that history:
//
//   record  each pregame Pinnacle match's per-map totals, first seen (signal)
//           and last seen before the start (close): the main line (nearest
//           50/50) with its no-vig over chance, the 50/50 point read off the
//           ladder (median), each team's total, and for rounds the round
//           model's q0 and expected rounds on that ladder
//   grade   against the rounds and kills each map actually had (bo3.gg for
//           CS2, vlr.gg for Valorant, lolesports for LoL, OpenDota for Dota);
//           a match the sources can't pin down (teams, start, map number)
//           stays ungraded and ends ungradable, never guessed
//   score   by title: mean error, sd, how often the over hit against how
//           often Pinnacle said it would
//   fit     once a title has minMaps graded maps, the team kill sd (LoL,
//           Dota) and the rounds kappa (CS2, Valorant) come from the history;
//           until then the assumed values, labelled assumed
//
// Pure, apart from the source readers at the bottom (createSources), which
// take the server's http client.

const { teamsMatch, teamCode } = require('./context');
const { probit } = require('./esboard');
const roundmodel = require('./roundmodel');
const { vlrMatchPage, vlrResultsList, vlrTeamIs } = require('./graders');

const ROUND_GAMES = new Set(['CS2', 'VAL']);
const KILL_GAMES = new Set(['LOL', 'DOTA']);
const DEFAULTS = {
  minMaps: 50,          // graded maps before a title's fit replaces the assumption
  teamSd: { LOL: 6, DOTA: 8 },               // assumed (sharemodel.TEAM_SD)
  // a line's spread when the ladder has one point and the median is read
  // off it: team kills as above, a map's total kills √2 × that, rounds ~4.5
  totalSd: { LOL: 8.5, DOTA: 11.3, CS2: 4.5, VAL: 4.5 },
  ttSd: { LOL: 6, DOTA: 8, CS2: 2.5, VAL: 2.5 },
  kappaGrid: [8, 12, 16, 20, 25, 30, 35, 45, 60, 80, 110, 150, 200],
  graceMs: 45 * 60e3,   // after the start before a match is looked up
  giveUpMs: 48 * 3600e3,
  windowMs: 6 * 3600e3, // a source's start this close to Pinnacle's
};

const { r2, r4 } = require('./mathutil');
const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
const sdOf = xs => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };

// Pure: a ladder ([{ x: −line, p: P(over) }]) → { line, p, median, points }
//   line, p  the point nearest 50/50 (the main line)
//   median   where the over is 50/50: between the two points around it,
//            interpolated in z; off a one-sided ladder, line + sd × z(p)
function ladderLine(points, sd) {
  const pts = (points || []).filter(q => q && Number.isFinite(q.x) && q.p > 0.02 && q.p < 0.98)
    .map(q => ({ line: -q.x, p: q.p })).sort((a, b) => a.line - b.line);
  if (!pts.length) return null;
  const main = pts.reduce((b, q) => (Math.abs(q.p - 0.5) < Math.abs(b.p - 0.5) ? q : b));
  let median = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.p >= 0.5 && b.p <= 0.5 && a.p > b.p) {
      const za = probit(a.p), zb = probit(b.p);
      median = a.line + (b.line - a.line) * (za / (za - zb));
      break;
    }
  }
  if (median == null && sd > 0) median = main.line + sd * probit(main.p);
  return { line: main.line, p: r4(main.p), median: median != null ? r2(median) : null, points: pts.length };
}

// Pure: one parsed Pinnacle match (esbooks.parsePinnacle) → its maps' totals
//   [{ map, kind: 'rounds'|'kills', total, teams: [tt0, tt1], q0, modelRounds }]
function matchTotals(m, o = DEFAULTS) {
  const kind = ROUND_GAMES.has(m?.game) ? 'rounds' : KILL_GAMES.has(m?.game) ? 'kills' : null;
  if (!kind) return [];
  const out = [];
  for (let n = 1; n <= 5; n++) {
    const total = ladderLine(m.ladders.get(`${kind}|${n}|total`), o.totalSd[m.game]);
    const teams = [0, 1].map(i => ladderLine(m.ladders.get(`${kind}|${n}|tt|${i}`), o.ttSd[m.game]));
    if (!total && !teams.some(Boolean)) continue;
    const row = { map: n, kind, total, teams };
    if (kind === 'rounds') {
      const f = roundmodel.fitMap(m.ladders, n, m.game);
      if (f) { row.q0 = f.q; row.modelRounds = f.rounds; }
    }
    out.push(row);
  }
  return out;
}

// Pure: the rows to save after a Pinnacle read. rows: Map(id → row).
// A pregame match's map gets a row the first time it's seen (signal) and its
// close moves with every later pregame read. Returns the rows it changed.
function observe(rows, pin, now = Date.now(), o = DEFAULTS) {
  const changed = [];
  for (const m of pin || []) {
    if (!m?.start || m.start <= now) continue;
    for (const t of matchTotals(m, o)) {
      const id = `${m.game}|${m.id}|${t.map}`;
      const snap = { at: new Date(now).toISOString(), total: t.total, teams: t.teams, ...(t.q0 != null ? { q0: t.q0, modelRounds: t.modelRounds } : {}) };
      let row = rows.get(id);
      if (!row) {
        row = { id, game: m.game, pinId: m.id, league: m.league || null, teams: m.teams, start: new Date(m.start).toISOString(), map: t.map, kind: t.kind,
          signal: snap, close: snap, status: 'open', actual: null };
      } else if (row.status === 'open') {
        row.close = snap;
        row.start = new Date(m.start).toISOString();
      } else continue;
      rows.set(id, row);
      changed.push(row);
    }
  }
  return changed;
}

// Pure: is a source's pair of team names this Pinnacle match's, and which
// way round? → 'same' | 'flip' | null. Both teams must match, one way only.
function nameIs(a, b) { return !!a && !!b && (teamsMatch(a, b) || teamCode(a, b) || teamCode(b, a)); }
function orient(pinTeams, names) {
  if (!pinTeams || !names || names.length < 2) return null;
  const same = nameIs(pinTeams[0], names[0]) && nameIs(pinTeams[1], names[1]);
  const flip = nameIs(pinTeams[0], names[1]) && nameIs(pinTeams[1], names[0]);
  return same === flip ? null : same ? 'same' : 'flip';
}

// Pure: a found match → the map results in Pinnacle's team order.
//   found: { names: [a, b], start, complete, maps: { N: { teams: [x, y], total? } } }
//   → { complete, maps: { N: { total, teams: [t0, t1] } } } or null
function alignFound(row, found, o = DEFAULTS) {
  if (!found) return null;
  const or = orient(row.teams, found.names);
  if (!or) return null;
  if (found.start != null && Math.abs(found.start - Date.parse(row.start)) > o.windowMs) return null;
  const maps = {};
  for (const [n, v] of Object.entries(found.maps || {})) {
    const t = or === 'same' ? v.teams : [v.teams[1], v.teams[0]];
    if (!t.every(Number.isFinite)) continue;
    maps[n] = { total: t[0] + t[1], teams: t };
  }
  // played: the map numbers the series had (a map in it without numbers stays open)
  const played = (found.played || Object.keys(found.maps || {})).map(Number);
  return { complete: !!found.complete, played, maps, source: found.source || null, matchId: found.matchId ?? null };
}

// Pure: grade one row from an aligned result. Returns true when it changed.
function gradeRow(row, res, now = Date.now(), o = DEFAULTS) {
  if (row.status !== 'open') return false;
  const hit = res?.maps?.[row.map];
  if (hit) {
    row.actual = { total: hit.total, teams: hit.teams };
    row.status = 'graded';
    row.source = res.source; row.matchId = res.matchId;
    row.gradedAt = new Date(now).toISOString();
    return true;
  }
  if (res?.complete && !res.played.includes(row.map)) {
    row.status = 'not played';
    row.source = res.source; row.matchId = res.matchId;
    row.gradedAt = new Date(now).toISOString();
    return true;
  }
  if (now - Date.parse(row.start) > o.giveUpMs) {
    row.status = 'ungradable';
    row.note = res ? 'the map never showed in the results' : 'no source result matched the teams and start';
    row.gradedAt = new Date(now).toISOString();
    return true;
  }
  return false;
}

// Pure: open rows a grading sweep should look up, grouped by Pinnacle match
function dueMatches(rows, now = Date.now(), o = DEFAULTS) {
  const by = new Map();
  for (const r of rows) {
    if (r.status !== 'open' || now - Date.parse(r.start) < o.graceMs + (r.map - 1) * 30 * 60e3) continue;
    const k = `${r.game}|${r.pinId}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return by;
}

// Pure: the scoreboard. snap 'close' (default) or 'signal'.
// Per title: maps graded, and against the map total
//   err   actual − Pinnacle's median (mean, sd, rmse)
//   over  the over at the main line: how often it hit vs Pinnacle's chance
// and against each team's total (team-maps): the same errors; for rounds the
// round model's expected rounds too.
function stats(errs) {
  if (!errs.length) return null;
  const m = mean(errs), sd = sdOf(errs);
  return { n: errs.length, mean: r2(m), sd: sd != null ? r2(sd) : null, rmse: r2(Math.sqrt(mean(errs.map(e => e * e)))) };
}
function scoreboard(rows, { snap = 'close' } = {}) {
  const by = {};
  for (const r of rows || []) {
    const g = by[r.game] ||= { maps: 0, open: 0, notPlayed: 0, ungradable: 0, totalErr: [], teamErr: [], modelErr: [], over: 0, overN: 0, expOver: [] };
    if (r.status === 'open') { g.open++; continue; }
    if (r.status === 'not played') { g.notPlayed++; continue; }
    if (r.status !== 'graded') { g.ungradable++; continue; }
    g.maps++;
    const s = r[snap] || r.close || r.signal;
    if (s?.total?.median != null) g.totalErr.push(r.actual.total - s.total.median);
    if (s?.total?.line != null && r.actual.total !== s.total.line) {
      g.overN++;
      if (r.actual.total > s.total.line) g.over++;
      g.expOver.push(s.total.p);
    }
    for (const i of [0, 1]) {
      const t = s?.teams?.[i];
      if (t?.median != null && Number.isFinite(r.actual.teams?.[i])) g.teamErr.push(r.actual.teams[i] - t.median);
    }
    if (s?.modelRounds != null) g.modelErr.push(r.actual.total - s.modelRounds);
  }
  const out = {};
  for (const [game, g] of Object.entries(by)) {
    out[game] = {
      maps: g.maps, open: g.open, notPlayed: g.notPlayed, ungradable: g.ungradable,
      total: stats(g.totalErr),
      overShare: g.overN ? r2((g.over / g.overN) * 100) : null,
      pinOverShare: g.expOver.length ? r2(mean(g.expOver) * 100) : null,
      teams: stats(g.teamErr),
      ...(g.modelErr.length ? { model: stats(g.modelErr) } : {}),
    };
  }
  return out;
}

// Pure: the rounds kappa the history wants: the grid value under which the
// rounds actually played were likeliest, each map at its close q0.
function fitKappa(maps, game, o = DEFAULTS) {
  const usable = (maps || []).filter(x => x.q0 > 0 && x.q0 < 1 && Number.isFinite(x.total));
  if (!usable.length) return null;
  let best = null;
  for (const kappa of o.kappaGrid) {
    const opt = { ...roundmodel.DEFAULTS, kappa: { ...roundmodel.DEFAULTS.kappa, [game]: kappa } };
    let ll = 0;
    for (const x of usable) {
      let p = 0;
      for (const [a, b, q] of roundmodel.rounds(x.q0, game, opt)) if (a + b === x.total) p += q;
      ll += Math.log(Math.max(p, 1e-6));
    }
    if (!best || ll > best.ll) best = { kappa, ll };
  }
  return best.kappa;
}

// Pure: what the models should use now, by title, and where it came from.
//   LOL, DOTA: { teamSd, n, source: 'fitted'|'assumed' }
//   CS2, VAL:  { kappa, n, source }
function fitted(rows, o = DEFAULTS) {
  const out = {};
  for (const game of ['LOL', 'DOTA', 'CS2', 'VAL']) {
    const g = (rows || []).filter(r => r.game === game && r.status === 'graded');
    if (KILL_GAMES.has(game)) {
      const errs = [];
      for (const r of g) for (const i of [0, 1]) { const t = (r.close || r.signal)?.teams?.[i]; if (t?.median != null && Number.isFinite(r.actual?.teams?.[i])) errs.push(r.actual.teams[i] - t.median); }
      const sd = sdOf(errs);
      out[game] = g.length >= o.minMaps && sd != null
        ? { teamSd: r2(Math.min(15, Math.max(3, sd))), n: g.length, source: 'fitted' }
        : { teamSd: o.teamSd[game], n: g.length, source: 'assumed' };
    } else {
      const maps = g.map(r => ({ q0: (r.close || r.signal)?.q0, total: r.actual?.total }));
      const k = g.length >= o.minMaps ? fitKappa(maps, game, o) : null;
      out[game] = k != null ? { kappa: k, n: g.length, source: 'fitted' } : { kappa: roundmodel.DEFAULTS.kappa[game], n: g.length, source: 'assumed' };
    }
  }
  return out;
}

// ─── SOURCES (the server's http) ─────────────────────────────────────────────
// Each finds a Pinnacle match's series and returns its maps in the source's
// own team order: { names, start, complete, maps: { N: { teams: [a, b] } }, source, matchId }.

// Pure: bo3.gg finished matches (with games) → the series for these teams
function bo3Found(matches, pinTeams, startMs, o = DEFAULTS) {
  const cands = [];
  for (const m of matches || []) {
    const games = (m.games || []).filter(g => Number.isFinite(g.winner_clan_score) && Number.isFinite(g.loser_clan_score));
    if (!games.length) continue;
    const names = [];
    for (const g of games) for (const n of [g.winner_clan_name, g.loser_clan_name]) if (n && !names.some(x => teamsMatch(x, n))) names.push(n);
    if (names.length !== 2 || !orient(pinTeams, names)) continue;
    const t = Date.parse(m.start_date);
    if (!Number.isFinite(t) || Math.abs(t - startMs) > o.windowMs) continue;
    const maps = {};
    for (const g of games) {
      if (!(g.number > 0)) continue;
      const w = teamsMatch(names[0], g.winner_clan_name) ? 0 : 1;
      const v = [0, 0]; v[w] = g.winner_clan_score; v[1 - w] = g.loser_clan_score;
      maps[g.number] = { teams: v };
    }
    cands.push({ names, start: t, complete: m.status === 'finished', played: games.map(g => g.number), maps, source: 'bo3.gg', matchId: m.slug || m.id, gap: Math.abs(t - startMs) });
  }
  cands.sort((a, b) => a.gap - b.gap);
  return cands[0] || null;
}

// Pure: a vlr.gg match page → found
function vlrFound(page) {
  if (!page?.teams?.length) return null;
  const maps = {};
  for (const m of page.maps || []) if (m.done) maps[m.number] = { teams: m.score };
  return { names: page.teams.map(t => t.name), start: page.start, complete: page.final, played: (page.maps || []).filter(m => m.done).map(m => m.number), maps, source: 'vlr.gg', matchId: page.id };
}

// Pure: OpenDota /proMatches rows → the series for these teams: games of one
// series_id (or, without one, back to back within 90 minutes), in start order
function dotaFound(matches, pinTeams, startMs, o = DEFAULTS) {
  const series = new Map();
  for (const g of matches || []) {
    if (!g?.radiant_name || !g?.dire_name || !Number.isFinite(g.start_time)) continue;
    const names = [g.radiant_name, g.dire_name];
    const or = orient(pinTeams, names);
    if (!or) continue;
    const t = g.start_time * 1000;
    if (t < startMs - 3600e3 || t > startMs + 10 * 3600e3) continue;
    const key = g.series_id || `${[...names].sort().join('|')}|${Math.round(t / 864e5)}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(g);
  }
  let best = null;
  for (const games of series.values()) {
    games.sort((a, b) => a.start_time - b.start_time);
    const first = games[0];
    const names = [first.radiant_name, first.dire_name];
    const maps = {};
    games.forEach((g, i) => {
      // sides swap between games: put each game's kills in the first game's order
      const same = teamsMatch(g.radiant_name, names[0]) || (g.radiant_team_id && g.radiant_team_id === first.radiant_team_id);
      maps[i + 1] = { teams: same ? [g.radiant_score, g.dire_score] : [g.dire_score, g.radiant_score] };
    });
    // a Bo1/Bo3/Bo5 is over once a side has the wins it needs
    const need = { 0: 1, 1: 2, 2: 3 }[first.series_type] ?? 2;
    let w0 = 0, w1 = 0;
    for (const g of games) { const r0 = teamsMatch(g.radiant_name, names[0]) || (g.radiant_team_id && g.radiant_team_id === first.radiant_team_id); if (g.radiant_win === r0) w0++; else w1++; }
    const cand = { names, start: first.start_time * 1000, complete: Math.max(w0, w1) >= need, played: games.map((g, i) => i + 1), maps, source: 'opendota', matchId: first.series_id || first.match_id, gap: Math.abs(first.start_time * 1000 - startMs) };
    if (!best || cand.gap < best.gap) best = cand;
  }
  return best;
}

// Pure: lolesports event + final windows → found
//   event: getEventDetails' event; windows: Map(game id → window data)
function loleFound(event, windows) {
  const match = event?.match;
  if (!match?.teams?.length) return null;
  const ids = match.teams.map(t => t.id);
  const maps = {};
  for (const g of match.games || []) {
    const w = windows.get(g.id);
    const last = w?.frames?.[w.frames.length - 1];
    if (!last || last.gameState !== 'finished') continue;
    const blueId = w.gameMetadata?.blueTeamMetadata?.esportsTeamId, redId = w.gameMetadata?.redTeamMetadata?.esportsTeamId;
    const v = [null, null];
    for (const [id, k] of [[blueId, last.blueTeam?.totalKills], [redId, last.redTeam?.totalKills]]) { const i = ids.indexOf(id); if (i >= 0) v[i] = Number(k); }
    if (v.every(Number.isFinite)) maps[g.number] = { teams: v };
  }
  const need = Math.ceil((match.strategy?.count || 3) / 2);
  const done = match.teams.some(t => (t.result?.gameWins || 0) >= need) || (match.games || []).every(g => g.state !== 'inProgress' && g.state !== 'unstarted');
  return { names: match.teams.map(t => t.name), codes: match.teams.map(t => t.code), complete: done, played: (match.games || []).filter(g => g.state === 'completed').map(g => g.number),
    maps, source: 'lolesports', matchId: match.id || event.id || null };
}

function createSources(http, { now = () => Date.now(), ttlMs = 10 * 60e3, pause = 800 } = {}) {
  const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : null);
  const BO3 = 'https://api.bo3.gg/api/v1', BO3_HEADERS = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper map totals)', Accept: 'application/json' };
  const LOLE = 'https://esports-api.lolesports.com/persisted/gw', LOLE_HEADERS = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper map totals)' };
  const VLR_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };
  const cache = {};
  async function cached(key, fn) {
    const c = cache[key];
    if (c && now() - c.at < ttlMs) return c.v;
    const v = await fn();
    cache[key] = { at: now(), v };
    return v;
  }
  const bo3List = from => cached(`bo3|${Math.floor(from / 864e5)}`, async () => {
    const rows = [];
    for (let page = 0; page < 6; page++) {
      const res = await http.get(`${BO3}/matches`, { headers: BO3_HEADERS, timeout: 20000, params: {
        'page[offset]': page * 100, 'page[limit]': 100, sort: '-start_date', with: 'games',
        'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } });
      const got = Array.isArray(res.data?.results) ? res.data.results : [];
      rows.push(...got);
      if (got.length < 100 || Math.min(...got.map(m => Date.parse(m.start_date) || Infinity)) < from) break;
      await wait(pause);
    }
    return rows;
  });
  const vlrList = () => cached('vlr', async () => {
    const res = await http.get('https://www.vlr.gg/matches/results', { headers: VLR_HEADERS, timeout: 20000, responseType: 'text' });
    return vlrResultsList(res?.data);
  });
  const vlrPages = new Map();
  async function vlrPage(id) {
    const hit = vlrPages.get(id);
    if (hit && (hit.page.final || now() - hit.at < ttlMs)) return hit.page;
    const res = await http.get(`https://www.vlr.gg/${id}`, { headers: VLR_HEADERS, timeout: 20000, responseType: 'text' });
    const page = { ...vlrMatchPage(res?.data), id: String(id) };
    vlrPages.set(id, { at: now(), page });
    while (vlrPages.size > 300) vlrPages.delete(vlrPages.keys().next().value);
    await wait(pause);
    return page;
  }
  const dotaList = from => cached(`dota|${Math.floor(from / 36e5)}`, async () => {
    const rows = [];
    let before = null;
    for (let page = 0; page < 5; page++) {
      const res = await http.get('https://api.opendota.com/api/proMatches', { params: before ? { less_than_match_id: before } : {}, timeout: 20000 });
      const got = Array.isArray(res.data) ? res.data : [];
      rows.push(...got);
      if (got.length < 100 || Math.min(...got.map(g => g.start_time * 1000)) < from) break;
      before = Math.min(...got.map(g => g.match_id));
      await wait(pause);
    }
    return rows;
  });
  const loleSchedule = from => cached(`lole|${Math.floor(from / 864e5)}`, async () => {
    const events = [];
    let token = null;
    for (let page = 0; page < 4; page++) {
      const res = await http.get(`${LOLE}/getSchedule`, { params: { hl: 'en-US', ...(token ? { pageToken: token } : {}) }, headers: LOLE_HEADERS, timeout: 20000 });
      const sc = res.data?.data?.schedule;
      events.push(...(sc?.events || []));
      token = sc?.pages?.older;
      if (!token || Math.min(...events.map(e => Date.parse(e.startTime) || Infinity)) <= from) break;
    }
    return events;
  });
  const loleWindows = new Map();
  async function loleWindow(gameId, startMs) {
    if (loleWindows.has(gameId)) return loleWindows.get(gameId);
    const t = Math.floor(Math.min(now() - 60e3, startMs + 14 * 3600e3) / 10000) * 10000;
    const res = await http.get(`https://feed.lolesports.com/livestats/v1/window/${gameId}`, { params: { startingTime: new Date(t).toISOString() }, headers: { 'User-Agent': LOLE_HEADERS['User-Agent'] }, timeout: 20000 });
    const frames = res.data?.frames || [];
    if (frames[frames.length - 1]?.gameState === 'finished') loleWindows.set(gameId, res.data);
    while (loleWindows.size > 400) loleWindows.delete(loleWindows.keys().next().value);
    return res.data;
  }

  // row: any open row of the match (game, teams, start) → found or null
  return async function find(row) {
    const start = Date.parse(row.start);
    if (row.game === 'CS2') return bo3Found(await bo3List(start - 6 * 3600e3), row.teams, start);
    if (row.game === 'DOTA') return dotaFound(await dotaList(start - 3600e3), row.teams, start);
    if (row.game === 'VAL') {
      const cands = (await vlrList()).filter(r => (r.day == null || Math.abs(r.day - start) <= 36 * 3600e3)
        && row.teams.every(pt => r.teams.some(t => vlrTeamIs({ name: t }, pt) || nameIs(pt, t))));
      let best = null;
      for (const r of cands.slice(0, 3)) {
        const f = vlrFound(await vlrPage(r.id));
        if (!f || f.start == null || !orient(row.teams, f.names)) continue;
        const gap = Math.abs(f.start - start);
        if (gap <= DEFAULTS.windowMs && (!best || gap < best.gap)) best = { ...f, gap };
      }
      return best;
    }
    if (row.game === 'LOL') {
      const evs = (await loleSchedule(start - 6 * 3600e3)).filter(e => e?.type === 'match' && e.match?.id && Math.abs(Date.parse(e.startTime) - start) <= DEFAULTS.windowMs);
      const ev = evs.map(e => ({ e, or: orient(row.teams, (e.match.teams || []).map(t => t.name)) || orient(row.teams, (e.match.teams || []).map(t => t.code)) }))
        .filter(x => x.or).sort((a, b) => Math.abs(Date.parse(a.e.startTime) - start) - Math.abs(Date.parse(b.e.startTime) - start))[0]?.e;
      if (!ev) return null;
      const det = await http.get(`${LOLE}/getEventDetails`, { params: { hl: 'en-US', id: ev.match.id }, headers: LOLE_HEADERS, timeout: 20000 });
      const event = det.data?.data?.event;
      const windows = new Map();
      for (const g of event?.match?.games || []) if (g.state === 'completed') windows.set(g.id, await loleWindow(g.id, start));
      const f = loleFound(event, windows);
      if (!f) return null;
      // Pinnacle may name a team by its code: orient on whichever list matches
      if (!orient(row.teams, f.names) && orient(row.teams, f.codes)) f.names = f.codes;
      return { ...f, start: Date.parse(ev.startTime) };
    }
    return null;
  };
}

// The grading sweep: look up each due match once, grade its maps.
// find(row) → found (above). Returns { looked, graded, notPlayed, ungradable, errors }.
async function gradeDue(rows, find, { now = Date.now(), limit = 12, o = DEFAULTS, lastTry = new Map(), retryMs = 15 * 60e3, log = console } = {}) {
  const out = { looked: 0, graded: 0, notPlayed: 0, ungradable: 0, errors: 0, changed: [] };
  const due = [...dueMatches(rows, now, o)].filter(([k]) => now - (lastTry.get(k) || 0) >= retryMs)
    .sort((a, b) => (lastTry.get(a[0]) || 0) - (lastTry.get(b[0]) || 0)).slice(0, limit);
  for (const [k, list] of due) {
    lastTry.set(k, now);
    out.looked++;
    let res = null;
    try { res = alignFound(list[0], await find(list[0]), o); }
    catch (e) { out.errors++; log.warn?.(`Pinnacle totals: ${k}: ${e.message}`); continue; }
    for (const r of list) {
      if (!gradeRow(r, res, now, o)) continue;
      out.changed.push(r);
      if (r.status === 'graded') out.graded++; else if (r.status === 'not played') out.notPlayed++; else out.ungradable++;
    }
  }
  return out;
}

module.exports = { DEFAULTS, ladderLine, matchTotals, observe, orient, alignFound, gradeRow, dueMatches, scoreboard, fitKappa, fitted, bo3Found, vlrFound, dotaFound, loleFound, createSources, gradeDue };
