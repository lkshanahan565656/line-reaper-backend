// ─── PLAYER RESEARCH: GAME LOGS AND HIT RATES ────────────────────────────────
// A player page for every prop on the PROPS board: the season's game log with
// the stat, each app's current line drawn across it, how often the stat went
// over that exact line (last 5, 10, 20, season, home, away, against tonight's
// opponent), and a usage trend (minutes, opportunities, ice time).
//
// Hit rates describe what happened. They are not a price and not an edge: a
// line the apps hang is already set off the same games. The page says so.
//
// Where the history comes from:
//   • ESPN's public box scores (site.api.espn.com, no key): the season's
//     finished games per league, read in the background a request at a time
//     (newest first, so last-5 and last-10 fill first), each player's stats
//     read with sportgrade.statValue, the same reader that grades the record.
//   • A model's own history where one is attached (the NBA and CFB models
//     already hold every box score): attach(sport, ...) and that league is
//     read from the model instead of fetched twice.
//   • Esports: the stat values our esports record graded (setEsports).
//
// Players are keyed by ESPN athlete id, so a traded player keeps one log and
// two players with one name stay apart (the row's team picks between them).
// Everything here is precomputed or cached per history version: the board
// asks for hit rates on hundreds of rows at a time.

const { canonName } = require('./ev');
const { LEAGUES, MARKETS, statValue } = require('./sportgrade');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const DAY = 86400e3;
const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const r1 = x => Math.round(x * 10) / 10;
// US Eastern date for ESPN's scoreboard (a 10pm ET game sits on its own day)
const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// The leagues read from ESPN, and where each season starts (month index, day).
// A season that crosses the new year starts in the previous year until the
// month passes `roll` (NFL's season year runs August to February).
const SEASONS = {
  NFL: { start: [7, 25], roll: 6 }, CFB: { start: [7, 20], roll: 6 },
  NBA: { start: [9, 1], roll: 7 }, NHL: { start: [9, 1], roll: 7 }, CBB: { start: [10, 1], roll: 7 },
  WNBA: { start: [4, 1], roll: 3 }, MLB: { start: [2, 15], roll: 1 },
};
// MLB plays 2,430 games: only its last few weeks are read
const MAX_DAYS = { MLB: 40 };
function seasonStart(sport, now = Date.now()) {
  const s = SEASONS[sport];
  if (!s) return null;
  const d = new Date(now), y = d.getUTCFullYear();
  const year = d.getUTCMonth() >= s.roll ? y : y - 1;
  return Date.UTC(year, s.start[0], s.start[1]);
}

// Fantasy score on PrizePicks and Underdog NBA/WNBA: points 1, rebound 1.2,
// assist 1.5, block 3, steal 3, turnover -1 (both apps post the same table)
const fantasyNba = g => {
  const v = k => statValue('NBA', k, g);
  const p = v('points');
  if (p == null) return null;
  return r1(p + 1.2 * v('rebounds') + 1.5 * v('assists') + 3 * v('blocks') + 3 * v('steals') - v('turnovers'));
};
const EXTRA = { NBA: { fantasy_score: fantasyNba }, WNBA: { fantasy_score: fantasyNba } };
// the stats a page can show per sport (the record's grader set plus fantasy score)
const statsFor = sport => [...(MARKETS[sport] || []), ...Object.keys(EXTRA[sport] || {})];
const canLog = (sport, mkey) => statsFor(sport).includes(mkey);

// "18:32" → 18.5 minutes
const clock = v => { const m = /^(\d+):(\d{2})$/.exec(String(v ?? '').trim()); return m ? r1(+m[1] + +m[2] / 60) : num(v); };
const pair = v => String(v ?? '').split(/[/-]/).map(x => num(x) ?? 0);

// What a player's workload was in one game, by sport: [value, label]
function usageOf(sport, g) {
  switch (sport) {
    case 'NBA': case 'WNBA': case 'CBB': return g.basketball ? [num(g.basketball.minutes), 'min'] : [null, null];
    case 'NFL': case 'CFB': {
      const pa = g.passing ? pair(g.passing['completions/passingAttempts'])[1] : 0;
      const ra = g.rushing ? num(g.rushing.rushingAttempts) || 0 : 0;
      // ESPN's college box has no targets: catches stand in
      const tg = g.receiving ? (g.receiving.receivingTargets != null ? num(g.receiving.receivingTargets) : num(g.receiving.receptions)) || 0 : 0;
      return pa + ra + tg > 0 ? [pa + ra + tg, 'opp'] : [null, null];
    }
    case 'NHL': {
      const s = g.forwards || g.defenses || g.skaters || g.goalies;
      return s ? [clock(s.timeOnIce), 'toi'] : [null, null];
    }
    case 'MLB': {
      if (g.pitching) return [num(g.pitching.pitches), 'pitches'];
      if (g.batting) return [(num(g.batting.atBats) || 0) + (num(g.batting.walks) || 0), 'pa'];
      return [null, null];
    }
    default: return [null, null];
  }
}
const USAGE_LABEL = { min: 'Minutes', opp: 'Opportunities (pass attempts + carries + targets)', toi: 'Time on ice (min)', pitches: 'Pitches thrown', pa: 'Plate appearances (at-bats + walks)' };

// ── parse one ESPN game ──────────────────────────────────────────────────────
// teams come from the summary's header (abbreviation, names, home/away)
function teamsOf(comp) {
  return (comp?.competitors || []).map(c => ({ id: String(c.team?.id || c.id || ''), abbr: String(c.team?.abbreviation || ''), name: c.team?.displayName || '',
    short: c.team?.shortDisplayName || '', loc: c.team?.location || '', nick: c.team?.name || '', home: c.homeAway === 'home', score: num(c.score) }));
}
// summary → { id, t, sport, stype, teams, players: [{ id, k, n, tm, s: { mkey: v }, u, ul }] } | null
function parseGame(sport, data, { id = null, t = null, stype = null } = {}) {
  const comp = data?.header?.competitions?.[0] || {};
  const teams = teamsOf(comp);
  const box = data?.boxscore;
  if (!box?.players?.length || teams.length !== 2) return null;
  const byName = n => teams.find(x => x.name === n || x.short === n || x.abbr === n) || null;
  const byAth = new Map();
  for (const team of box.players) {
    const tm = teams.find(x => (team.team?.id && x.id === String(team.team.id)) || (team.team?.abbreviation && x.abbr === team.team.abbreviation)) || byName(team.team?.displayName);
    if (!tm) continue;
    for (const g of team.statistics || []) {
      const keys = g.keys || [];
      const name = g.name || (keys.includes('points') ? 'basketball' : keys.includes('hits-atBats') ? 'batting'
        : keys.includes('fullInnings.partInnings') ? 'pitching' : 'other');
      for (const a of g.athletes || []) {
        const who = a.athlete?.displayName;
        if (!who || !Array.isArray(a.stats) || !a.stats.length) continue;
        const aid = String(a.athlete?.id || `n:${canonName(who)}`);
        if (!byAth.has(aid)) byAth.set(aid, { id: aid, k: canonName(who), n: who, tm: tm.abbr, groups: {} });
        const row = {};
        keys.forEach((key, i) => { row[key] = a.stats[i]; });
        byAth.get(aid).groups[name] ||= row;
      }
    }
  }
  const players = [];
  for (const p of byAth.values()) {
    const s = {};
    for (const mk of MARKETS[sport] || []) { const v = statValue(sport, mk, p.groups); if (v != null) s[mk] = v; }
    for (const [mk, f] of Object.entries(EXTRA[sport] || {})) { const v = f(p.groups); if (v != null) s[mk] = v; }
    if (!Object.keys(s).length) continue;
    const [u, ul] = usageOf(sport, p.groups);
    players.push({ id: p.id, k: p.k, n: p.n, tm: p.tm, s, u, ul });
  }
  if (!players.length) return null;
  return { id: String(id || data?.header?.id || comp.id || ''), t: t ?? Date.parse(comp.date || ''), sport, stype, src: 'espn',
    teams: teams.map(({ score, ...x }) => ({ ...x, score })), players };
}

// ── team names ───────────────────────────────────────────────────────────────
// "LAL", "Lakers", "Los Angeles Lakers" and a team record all name one team
// the apps' abbreviations where ESPN uses another ("GSW" is ESPN's "GS")
const ABBR = { gsw: 'gs', nop: 'no', nyk: 'ny', sas: 'sa', uta: 'utah', was: 'wsh', pho: 'phx', brk: 'bkn', jac: 'jax' };
function teamWords(t) {
  if (!t) return [];
  const w = typeof t === 'string' ? [t] : [t.abbr, t.name, t.short, t.loc, t.nick];
  return w.filter(Boolean).map(canonName).filter(Boolean).map(x => ABBR[x] || x);
}
function sameTeam(a, b) {
  const A = teamWords(a), B = teamWords(b);
  if (!A.length || !B.length) return false;
  return A.some(x => B.some(y => x === y || (x.length > 4 && y.length > 4 && (x.endsWith(y) || y.endsWith(x)))));
}
// a props row's two teams: "CLE @ ORL", "Bills vs Jets", PrizePicks' team + opponent
function rowTeams(row) {
  const mt = String(row?.matchTitle || '');
  // "GEN vs LYON MAPS 1-2", "UTAH @ HOU 2nd Half": the period words are not a team
  const parts = mt.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(x => x.replace(/\s+(maps?\s.*|\d(st|nd|rd|th)\s+(half|quarter|period).*|1h|2h|1q)$/i, '').trim()).filter(Boolean);
  const away = parts.length === 2 && /\s@\s|\sat\s/i.test(mt) ? parts[0] : null, home = away ? parts[1] : null;
  return { team: row?.team || '', opponent: row?.opponent || '', parts, home, away };
}

// ── the store ────────────────────────────────────────────────────────────────
function createPlayerLog({ http = null, now = () => Date.now(), gapMs = 200, maxPerRun = 1200, wanted = () => null, log = () => {} } = {}) {
  const games = new Map();          // game id → parsed game (ESPN-read leagues)
  const players = new Map();        // athlete id → entries (time order)
  const names = new Map();          // sport|canon name → Set(athlete id)
  const days = new Map();           // league|yyyymmdd → { at, final }
  const attached = new Map();       // sport → { players(), names(), toEntry, version() }
  const state = { running: false, runs: 0, reads: 0, errors: [], startedAt: null, finishedAt: null, pending: {} };
  let version = 0;
  let es = { index: new Map(), at: null };

  function addGame(g) {
    if (!g || !g.id || games.has(g.id)) return false;
    games.set(g.id, g);
    for (const p of g.players) {
      const mine = g.teams.find(x => x.abbr === p.tm), opp = g.teams.find(x => x.abbr !== p.tm);
      const e = { t: g.t, gid: g.id, tm: p.tm, team: mine?.name || p.tm, opp: opp?.abbr || '', oppName: opp?.name || '', home: mine ? mine.home : null,
        s: p.s, u: p.u, ul: p.ul, won: mine?.score != null && opp?.score != null ? (mine.score > opp.score ? 'W' : mine.score < opp.score ? 'L' : 'T') : null,
        score: mine?.score != null && opp?.score != null ? `${mine.score}-${opp.score}` : null };
      const list = players.get(p.id) || players.set(p.id, []).get(p.id);
      list.push(e);
      if (list.length > 1 && list[list.length - 2].t > e.t) list.sort((a, b) => a.t - b.t);
      const nk = `${g.sport}|${p.k}`;
      (names.get(nk) || names.set(nk, new Set()).get(nk)).add(p.id);
    }
    version++;
    return true;
  }

  // A model's history stands in for ESPN reads in its league. players():
  // Map(id → rows), names(): Map(canon → Set(id)) (or null when ids are canon
  // names), toEntry(row) → { t, tm, opp, home, s, u, ul }.
  function attach(sport, src) { attached.set(sport, { cache: new Map(), at: null, ...src }); version++; }

  // ── fetch side ──
  const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
  async function get(url, params) {
    state.reads++;
    const r = await http.get(url, { params, timeout: 20000 });
    await sleep(gapMs);
    return r?.data;
  }
  async function readLeague(sport, budget) {
    const base = `${ESPN}/${LEAGUES[sport]}`;
    const t0 = now(), from = Math.max(seasonStart(sport, t0) || t0, t0 - (MAX_DAYS[sport] || 220) * DAY);
    // newest day first, so the last few games are in before the season's start
    const list = [];
    for (let t = t0; t >= from - DAY; t -= DAY) list.push(ymd(t));
    let used = 0, added = 0;
    const todo = [];
    for (const d of [...new Set(list)]) {
      if (used >= budget) break;
      const dk = `${sport}|${d}`, seen = days.get(dk);
      // a day whose games are all final is read once; today and yesterday every run
      if (seen?.final) continue;
      let events;
      try {
        const data = await get(`${base}/scoreboard`, { dates: d, limit: 300, ...(sport === 'CFB' ? { groups: 80 } : {}) });
        used++;
        events = data?.events || [];
      } catch (e) { used++; state.errors.unshift(`${sport} scoreboard ${d}: ${e.message}`); continue; }
      const live = events.filter(ev => !ev.status?.type?.completed);
      days.set(dk, { at: now(), final: !live.length && d < ymd(t0 - DAY) });
      for (const ev of events) {
        if (!ev.status?.type?.completed || games.has(String(ev.id))) continue;
        if (ev.season?.type === 1) continue;   // preseason: the apps don't post it
        todo.push({ id: String(ev.id), t: Date.parse(ev.date), stype: ev.season?.type ?? null });
      }
      // summaries as soon as their day is listed, newest first
      while (todo.length && used < budget) {
        const g = todo.shift();
        try {
          const data = await get(`${base}/summary`, { event: g.id });
          used++;
          const parsed = parseGame(sport, data, g);
          if (parsed && addGame(parsed)) added++;
        } catch (e) { used++; state.errors.unshift(`${sport} summary ${g.id}: ${e.message}`); }
      }
      if (todo.length) { days.delete(dk); break; }   // ran out mid-day: list it again next run
    }
    state.errors = state.errors.slice(0, 12);
    return { used, added };
  }
  // one pass over the leagues on the board (or every league when the board is
  // empty), skipping the ones a model already holds
  async function refresh() {
    if (!http || state.running) return null;
    state.running = true; state.startedAt = new Date(now()).toISOString(); state.runs++;
    let budget = maxPerRun;
    const out = {};
    try {
      const want = wanted();
      // the board not loaded yet: wait for it rather than read every league (the WNBA off-season, say)
      if (!want) return { waiting: true };
      const leagues = Object.keys(SEASONS).filter(s => LEAGUES[s] && !attached.has(s) && (!want || want.has(s)));
      for (const s of leagues) {
        if (budget <= 0) break;
        const r = await readLeague(s, Math.max(40, Math.floor(budget / Math.max(1, leagues.length - Object.keys(out).length))));
        out[s] = r; budget -= r.used;
      }
    } finally { state.running = false; state.finishedAt = new Date(now()).toISOString(); state.last = out; }
    return out;
  }

  // ── reading a player ──
  // entries for one athlete in a sport → [{ t, gid, tm, team, opp, oppName, home, s, u, ul, won, score }]
  function entriesOf(sport, id) {
    const a = attached.get(sport);
    if (a) {
      const v = a.version ? a.version() : null;
      if (v !== a.at) { a.cache.clear(); a.at = v; }
      if (a.cache.has(id)) return a.cache.get(id);
      const rows = a.players()?.get(id) || [];
      const list = rows.map(a.toEntry).filter(Boolean).sort((x, y) => x.t - y.t);
      if (a.cache.size > 4000) a.cache.clear();
      a.cache.set(id, list);
      return list;
    }
    return players.get(id) || [];
  }
  function idsFor(sport, key) {
    const a = attached.get(sport);
    if (a) {
      const nm = a.names ? a.names() : null;
      if (nm) return [...(nm.get(key) || [])];
      return a.players()?.has(key) ? [key] : [];
    }
    return [...(names.get(`${sport}|${key}`) || [])];
  }
  // The athlete a props row names: one id, or the one whose latest team is
  // the row's team; two namesakes and no team to tell them apart → ambiguous
  function resolve(row) {
    const sport = row?.sport, key = canonName(row?.player);
    if (!sport || !key) return null;
    const ids = idsFor(sport, key);
    if (!ids.length) return null;
    if (ids.length === 1) return { id: ids[0], ambiguous: false };
    const { team, parts } = rowTeams(row);
    const last = id => { const l = entriesOf(sport, id); return l[l.length - 1]; };
    // his team in any of his last five games (a trade, a two-team row)
    const teamsOf = id => entriesOf(sport, id).slice(-5).map(e => ({ abbr: e.tm, name: e.team }));
    const byTeam = ids.filter(id => teamsOf(id).some(t => (team ? sameTeam(team, t) : parts.some(p => sameTeam(p, t)))));
    if (byTeam.length === 1) return { id: byTeam[0], ambiguous: false };
    const pick = (byTeam.length ? byTeam : ids).slice().sort((a, b) => (last(b)?.t || 0) - (last(a)?.t || 0))[0];
    return { id: pick, ambiguous: true };
  }

  // esports: graded stat values from our record, by sport|canon name|stat key
  function setEsports(index) { es = { index: index || new Map(), at: now() }; version++; }
  function esEntries(row) { return es.index.get(`${row.sport}|${canonName(row.player)}|${row.mkey}`) || []; }

  // the row's game log: entries with this stat, oldest first
  function logFor(row) {
    if (row?.esports) {
      const list = esEntries(row);
      return { list, source: list.length ? 'esports-record' : null, ambiguous: false };
    }
    if (!canLog(row?.sport, row?.mkey) && !attachedHas(row)) return { list: [], source: null, unsupported: true };
    const who = resolve(row);
    if (!who) return { list: [], source: attached.has(row.sport) ? 'model' : 'espn', ambiguous: false };
    const list = entriesOf(row.sport, who.id).filter(e => e.s && e.s[row.mkey] != null);
    return { list, id: who.id, source: attached.has(row.sport) ? 'model' : 'espn', ambiguous: who.ambiguous };
  }
  const attachedHas = row => !!attached.get(row?.sport)?.stats?.includes(row?.mkey);

  // ── hit rates ──
  // over / under / push at a line over a list of values (newest last)
  function tally(vals, line) {
    let o = 0, u = 0, p = 0;
    for (const v of vals) { if (v > line) o++; else if (v < line) u++; else p++; }
    const n = o + u;
    return { over: o, under: u, push: p, n: vals.length, pct: n ? Math.round(o / n * 1000) / 10 : null };
  }
  // the row's opponent tonight, if the row names one
  function oppOf(row, mine) {
    const { opponent, parts, home } = rowTeams(row);
    const atHome = () => (home ? (mine && sameTeam(home, mine)) || (!!row.team && sameTeam(home, row.team)) : null);
    if (opponent) return { name: opponent, home: atHome() };
    if (parts.length === 2 && mine) {
      const [a, b] = parts;
      if (sameTeam(a, mine)) return { name: b, home: home ? sameTeam(home, mine) : null };
      if (sameTeam(b, mine)) return { name: a, home: home ? sameTeam(home, mine) : null };
    }
    if (parts.length === 2 && row.team) {
      const [a, b] = parts;
      if (sameTeam(a, row.team)) return { name: b, home: home ? sameTeam(home, row.team) : null };
      if (sameTeam(b, row.team)) return { name: a, home: home ? sameTeam(home, row.team) : null };
    }
    return null;
  }
  // one line's splits over a log
  function splits(list, mkey, line, { opp = null, since = null } = {}) {
    const vals = list.map(e => e.s[mkey]);
    const last = k => tally(vals.slice(-k), line);
    const season = since != null ? list.filter(e => e.t >= since) : list;
    const out = { line, l5: last(5), l10: last(10), l20: last(20), season: tally(season.map(e => e.s[mkey]), line),
      home: tally(season.filter(e => e.home === true).map(e => e.s[mkey]), line), away: tally(season.filter(e => e.home === false).map(e => e.s[mkey]), line) };
    if (opp) out.vs = tally(list.filter(e => sameTeam(opp, { abbr: e.opp, name: e.oppName })).map(e => e.s[mkey]), line);
    return out;
  }

  // the board's two columns at one app's line: last 10 and season, cached
  // per history version
  const hitCache = new Map();
  let hitVersion = -1;
  function boardHits(row, line) {
    if (!Number.isFinite(line)) return null;
    if (hitVersion !== version) { hitCache.clear(); hitVersion = version; }
    const ck = `${row.key}|${line}`;
    if (hitCache.has(ck)) return hitCache.get(ck);
    const { list } = logFor(row);
    let r = null;
    if (list.length) {
      const since = row.esports ? null : seasonStart(row.sport, now());
      const vals = list.map(e => e.s[row.mkey]);
      const season = since != null ? list.filter(e => e.t >= since).map(e => e.s[row.mkey]) : vals;
      const l10 = tally(vals.slice(-10), line), szn = tally(season, line);
      r = { l10: l10.pct, l10n: l10.n, szn: szn.pct, sznN: szn.n, games: list.length };
    }
    if (hitCache.size > 20000) hitCache.clear();
    hitCache.set(ck, r);
    return r;
  }

  // The page for one props row. extra: what the server adds (model, books, moves).
  function page(row, extra = {}) {
    const lg = logFor(row);
    const sport = row.sport, mkey = row.mkey;
    const since = row.esports ? null : seasonStart(sport, now());
    const lines = [...new Set(Object.values(row.books || {}).map(c => c?.line).filter(Number.isFinite))].sort((a, b) => a - b);
    const byApp = Object.fromEntries(Object.entries(row.books || {}).filter(([, c]) => Number.isFinite(c?.line)).map(([b, c]) => [b, c.line]));
    const latest = lg.list[lg.list.length - 1];
    const opp = oppOf(row, latest ? { abbr: latest.tm, name: latest.team } : null);
    const hits = lines.map(l => splits(lg.list, mkey, l, { opp: opp?.name || null, since }));
    const log = lg.list.slice(-82).reverse().map(e => ({ t: e.t, gid: e.gid || null, opp: e.opp || e.oppName || '', oppName: e.oppName || '', home: e.home ?? null,
      v: e.s[mkey], u: e.u ?? null, won: e.won || null, score: e.score || null, season: since != null && e.t < since ? 'prev' : 'this', match: e.match || null }));
    const useList = lg.list.filter(e => Number.isFinite(e.u));
    const ul = useList.length ? useList[useList.length - 1].ul : null;
    const avg = xs => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const vals = lg.list.map(e => e.s[mkey]);
    const seasonVals = since != null ? lg.list.filter(e => e.t >= since).map(e => e.s[mkey]) : vals;
    return {
      key: row.key, sport, esports: !!row.esports, player: row.player, team: latest?.team || row.team || '', market: row.market, mkey,
      start: row.startTime || null, matchTitle: row.matchTitle || '', opponent: opp?.name || null, homeTonight: opp?.home ?? null,
      apps: byApp, lines, source: lg.source, ambiguous: !!lg.ambiguous, unsupported: !!lg.unsupported,
      games: lg.list.length, seasonGames: seasonVals.length, seasonFrom: since ? new Date(since).toISOString().slice(0, 10) : null,
      avg: { l5: avg(vals.slice(-5)), l10: avg(vals.slice(-10)), season: avg(seasonVals) },
      hits, log,
      usage: ul ? { label: USAGE_LABEL[ul] || ul, kind: ul, l5: avg(useList.slice(-5).map(e => e.u)), season: avg(useList.filter(e => since == null || e.t >= since).map(e => e.u)), n: useList.length } : null,
      ...extra,
    };
  }

  function status() {
    const bySport = {};
    for (const g of games.values()) bySport[g.sport] = (bySport[g.sport] || 0) + 1;
    return { games: games.size, bySport, players: players.size, attached: [...attached.keys()], esportsAt: es.at, esportsKeys: es.index.size,
      reads: state.reads, runs: state.runs, running: state.running, startedAt: state.startedAt, finishedAt: state.finishedAt, last: state.last || null, errors: state.errors.slice(0, 6), version };
  }
  return { refresh, addGame, attach, setEsports, resolve, logFor, boardHits, page, splits, tally, status, version: () => version };
}

// ── adapters for the models' own histories ───────────────────────────────────
// NBA model (nbamodel.buildHistory): players Map(canon name → [{ t, gid, team,
// opp, home, min, points, rebounds, assists, threes, steals, blocks, turnovers }])
const NBA_COMBOS = { pra: ['points', 'rebounds', 'assists'], pts_rebs: ['points', 'rebounds'], pts_asts: ['points', 'assists'], rebs_asts: ['rebounds', 'assists'], stocks: ['steals', 'blocks'] };
function nbaEntry(p) {
  if (!p || !Number.isFinite(p.t)) return null;
  const s = {};
  for (const k of ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers']) if (Number.isFinite(p[k])) s[k] = p[k];
  for (const [k, parts] of Object.entries(NBA_COMBOS)) if (parts.every(x => Number.isFinite(p[x]))) s[k] = parts.reduce((a, x) => a + p[x], 0);
  if (Number.isFinite(p.points)) s.fantasy_score = r1(p.points + 1.2 * (p.rebounds || 0) + 1.5 * (p.assists || 0) + 3 * (p.blocks || 0) + 3 * (p.steals || 0) - (p.turnovers || 0));
  return { t: p.t, gid: p.gid || null, tm: p.team || '', team: p.team || '', opp: p.opp || '', oppName: p.opp || '', home: p.home ?? null, s, u: Number.isFinite(p.min) ? r1(p.min) : null, ul: 'min', won: null, score: null };
}
const NBA_STATS = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', ...Object.keys(NBA_COMBOS), 'fantasy_score'];
// CFB model (cfbmodel.buildHistory): players Map(athlete id → [{ t, team, opp,
// pa, pc, py, ptd, pint, ra, ry, rtd, rushlong, rec, recy, rectd, reclong, fgm, kp }]),
// names Map(canon name → Set(athlete id))
function cfbEntry(p) {
  if (!p || !Number.isFinite(p.t)) return null;
  const f = k => (Number.isFinite(p[k]) ? p[k] : null);
  const s = {};
  const set = (k, v) => { if (v != null && Number.isFinite(v)) s[k] = v; };
  const passer = f('pa') != null && f('pa') > 0, runner = f('ra') != null, catcher = f('rec') != null;
  if (passer) { set('pass_att', f('pa')); set('pass_comp', f('pc')); set('pass_yds', f('py')); set('pass_tds', f('ptd')); set('pass_ints', f('pint')); }
  if (runner || catcher || passer) { set('rush_att', f('ra') ?? 0); set('rush_yds', f('ry') ?? 0); }
  if (runner || catcher) {
    set('receptions', f('rec') ?? 0); set('rec_yds', f('recy') ?? 0); set('rush_rec_yds', (f('ry') ?? 0) + (f('recy') ?? 0));
    set('anytime_td', (f('rtd') ?? 0) + (f('rectd') ?? 0));
  }
  if (passer) set('pass_rush_yds', (f('py') ?? 0) + (f('ry') ?? 0));
  if (f('reclong') != null) set('longest_rec', f('reclong'));
  if (f('rushlong') != null) set('longest_rush', f('rushlong'));
  if (f('fgm') != null) set('fg_made', f('fgm'));
  if (f('kp') != null) set('kicking_points', f('kp'));
  const opp = (f('pa') || 0) + (f('ra') || 0) + (f('rec') || 0);
  return { t: p.t, gid: p.gid || null, tm: p.team || '', team: p.team || '', opp: p.opp || '', oppName: p.opp || '', home: p.home ?? null, s,
    u: opp > 0 ? opp : null, ul: 'opp', won: null, score: null };
}
const CFB_STATS = ['pass_att', 'pass_comp', 'pass_yds', 'pass_tds', 'pass_ints', 'rush_att', 'rush_yds', 'receptions', 'rec_yds', 'rush_rec_yds', 'anytime_td', 'pass_rush_yds', 'longest_rec', 'longest_rush', 'fg_made', 'kicking_points'];

// Attach the NBA model (nbadata.createNbaModel) to a player log
function attachNbaModel(plog, model) {
  if (!plog || !model || typeof model.history !== 'function') return false;
  plog.attach('NBA', { players: () => model.history()?.players, names: null, toEntry: nbaEntry, stats: NBA_STATS, version: () => model.history() });
  return true;
}
function attachCfbModel(plog, model) {
  if (!plog || !model || typeof model.history !== 'function') return false;
  plog.attach('CFB', { players: () => model.history()?.players, names: () => model.history()?.names, toEntry: cfbEntry, stats: CFB_STATS, version: () => model.history() });
  return true;
}

// ── esports: our record's graded legs as a game log ──────────────────────────
// rows: tracker rows ({ sport, player, market, status, result, startTime,
// matchTitle, team }); key(row) → the board's stat key (normalizeMarket).
// One entry per match and stat (the record can hold a leg per app).
function esportsIndex(rows, { key, boardSport = s => s } = {}) {
  const idx = new Map(), seen = new Set();
  for (const r of rows || []) {
    if (r.status !== 'graded' || !Number.isFinite(Number(r.result)) || !r.player) continue;
    const t = Date.parse(r.startTime || '');
    if (!Number.isFinite(t)) continue;
    const mk = key(r.market);
    const k = `${boardSport(r.sport)}|${canonName(r.player)}|${mk}`;
    const dk = `${k}|${Math.round(t / 600e3)}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const teams = String(r.matchTitle || '').split(/\s+(?:@|vs\.?|v)\s+/i).map(s => s.trim()).filter(Boolean);
    const oppName = r.team && teams.length === 2 ? (sameTeam(teams[0], r.team) ? teams[1] : sameTeam(teams[1], r.team) ? teams[0] : '') : '';
    (idx.get(k) || idx.set(k, []).get(k)).push({ t, gid: null, tm: r.team || '', team: r.team || '', opp: oppName, oppName, home: null,
      s: { [mk]: Number(r.result) }, u: null, ul: null, won: null, score: null, match: r.matchTitle || null });
  }
  for (const list of idx.values()) list.sort((a, b) => a.t - b.t);
  return idx;
}

module.exports = { createPlayerLog, parseGame, seasonStart, statsFor, canLog, sameTeam, rowTeams, usageOf, nbaEntry, cfbEntry, attachNbaModel, attachCfbModel, esportsIndex, USAGE_LABEL, SEASONS };
