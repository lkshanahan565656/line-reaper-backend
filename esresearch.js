// ─── ESPORTS PROP RESEARCH: A PLAYER'S PAST AGAINST TODAY'S APP LINE ────────
// For every esports player prop the pick'em apps list (PrizePicks, Underdog,
// Sleeper, DK Pick6), the research a bettor does by hand:
//
//   hit rate   how often his past total over the same maps went over the
//              app's current line, over his last 5, 10 and 20 series
//   splits     against this opponent, in series his team won or lost, and
//              his average on each map number
//   map log    every recent map: date, opponent, league, kills, deaths,
//              assists, champion, result
//   line log   each app's line on his past matches, first read and last read
//              before the start, from our own records, with his result
//
// Where the numbers come from, and only from there:
//   LoL   lolesports.com's own feed (schedule, game details, live-stats
//         windows: the source our LoL grader already reads), then
//         Leaguepedia's Cargo API (free, documented) for other leagues
//   Dota  OpenDota's explorer (free, documented): his pro games
//   CS2, Valorant, CoD, R6: no free per-map source we may use (HLTV's terms
//         forbid scraping), so these pages show only what our own line
//         records hold: the app lines we read and the graded results
//
// This is research. Nothing here is a projection, a pick or a price: a past
// hit rate doesn't make a bet good, the apps' lines sit near the sharp
// median, and our esports prop models lost to the close. Every page says so.
//
// The data part is pure and unit-tested; the log cache takes fetchers; the
// pages are plain HTML drawn by the server in the site's dark look.

'use strict';
const { CSS, LOGO, FAVICON, esc } = require('./learn');
const { normalizeMarket } = require('./esmarkets');
const esmatch = require('./esmatch');

const GAMES = {
  LOL: { label: 'LoL', name: 'League of Legends', source: 'lolesports.com and Leaguepedia', maps: true },
  DOTA: { label: 'Dota 2', name: 'Dota 2', source: 'OpenDota', maps: true },
  CS: { label: 'CS2', name: 'Counter-Strike 2', source: null, maps: false },
  VAL: { label: 'VALORANT', name: 'VALORANT', source: null, maps: false },
  COD: { label: 'CoD', name: 'Call of Duty', source: null, maps: false },
  R6: { label: 'R6', name: 'Rainbow Six', source: null, maps: false },
};
const GAME_ORDER = ['LOL', 'DOTA', 'CS', 'VAL', 'COD', 'R6'];
const NO_SOURCE_NOTE = {
  CS: 'CS2 has no free per-map stats source we may use (HLTV\'s terms forbid scraping), so this page shows only what our own records hold: the app lines we read on his past matches and the graded results.',
  VAL: 'VALORANT has no free, documented per-map stats API, so this page shows only what our own records hold: the app lines we read on his past matches and the graded results.',
  COD: 'Call of Duty has no free per-map stats source, so this page shows only what our own records hold.',
  R6: 'Rainbow Six has no free per-map stats source, so this page shows only what our own records hold.',
};
const APPS = { prizepicks: 'PP', underdog: 'UD', sleeper: 'SL', pick6: 'P6' };
const APP_NAME = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper', P6: 'DK Pick6' };
const STAT_LABEL = { k: 'Kills', ast: 'Assists', hs: 'Headshots', death: 'Deaths', fp: 'Fantasy points', fb: 'First bloods' };
// the stat a map log carries for a market's stat key
const MAP_STAT = { k: 'k', ast: 'a', death: 'd' };
const WINDOWS = [5, 10, 20, null];

const canon = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const gameOf = s => {
  const k = String(s || '').toUpperCase();
  if (GAMES[k]) return k;
  if (/^(CS2?|CSGO|COUNTER)/.test(k)) return 'CS';
  if (/^(LOL|LEAGUE)/.test(k)) return 'LOL';
  if (/^VAL/.test(k)) return 'VAL';
  if (/^DOTA/.test(k)) return 'DOTA';
  if (/^(COD|CALL)/.test(k)) return 'COD';
  if (/^(R6|RAINBOW)/.test(k)) return 'R6';
  return null;
};
// "k|1-2" → { stat: 'k', span: '1-2', maps: [1, 2] }
function parseMkey(mkey) {
  const [stat, span = '1'] = String(mkey || '').split('|');
  const m = /^(\d)(?:-(\d))?$/.exec(span);
  const a = m ? +m[1] : 1, b = m && m[2] ? +m[2] : a;
  const maps = [];
  for (let i = a; i <= b; i++) maps.push(i);
  return { stat, span: m ? span : '1', maps };
}
function marketLabel(mkey) {
  const { stat, maps } = parseMkey(mkey);
  const s = STAT_LABEL[stat] || (stat.startsWith('x:') ? stat.slice(2) : stat);
  return `${s}, ${maps.length > 1 ? `Maps ${maps[0]}-${maps[maps.length - 1]}` : `Map ${maps[0]}`}`;
}
const playerKey = (game, player) => `${game}|${canon(player)}`;
const cleanOpp = o => (o ? String(o).replace(/\s+(MAPS?|GAMES?)\s+[\d+\-\s]+$/i, '').trim() || null : null);
const opponentOf = x => {
  if (x.opponent) return cleanOpp(x.opponent);
  try { return cleanOpp(esmatch.lineOpponent({ team: x.team || '', matchTitle: x.matchTitle || '', book: 'x' })); } catch { return null; }
};
const sameTeam = (a, b) => { try { return !!a && !!b && esmatch.sameTeam(a, b); } catch { return canon(a) === canon(b); } };

// ── today's board: the props board's esports rows → one entry per player ──
// rows: propsboard rows ({ key, sport, esports, player, team, mkey, startTime, matchTitle, opponent, books })
function boardPlayers(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const game = gameOf(r?.sport);
    if (!r?.esports || !game || !r.player) continue;
    const pk = playerKey(game, r.player);
    let p = by.get(pk);
    if (!p) by.set(pk, p = { key: pk, game, player: r.player, team: r.team || '', opponent: opponentOf(r), startTime: r.startTime || '', matchTitle: r.matchTitle || '', markets: [] });
    if (!p.team && r.team) p.team = r.team;
    if (!p.opponent) p.opponent = opponentOf(r);
    // the soonest match first: a player in two Bo1s today shows the next one
    const t = ms(r.startTime), pt = ms(p.startTime);
    if (t != null && (pt == null || t < pt)) Object.assign(p, { startTime: r.startTime, matchTitle: r.matchTitle || p.matchTitle, opponent: opponentOf(r) || p.opponent });
    const lines = [];
    for (const [book, app] of Object.entries(APPS)) {
      const c = r.books?.[book];
      if (c && num(c.line) != null) lines.push({ app, line: num(c.line), overOpen: c.overOpen !== false, underOpen: c.underOpen !== false });
    }
    if (!lines.length) continue;
    const mkey = r.mkey || normalizeMarket(r.market);
    const old = p.markets.find(m => m.mkey === mkey);
    if (old) { if (t != null && ms(old.startTime) != null && t < ms(old.startTime)) Object.assign(old, { lines, startTime: r.startTime, opponent: opponentOf(r) }); continue; }
    p.markets.push({ mkey, label: marketLabel(mkey), market: r.market || '', lines, startTime: r.startTime || '', opponent: opponentOf(r) });
  }
  for (const p of by.values()) p.markets.sort((a, b) => mkeyOrder(a.mkey) - mkeyOrder(b.mkey));
  return [...by.values()].sort((a, b) => (ms(a.startTime) ?? Infinity) - (ms(b.startTime) ?? Infinity) || a.player.localeCompare(b.player));
}
const mkeyOrder = mk => { const { stat, maps } = parseMkey(mk); return (['k', 'hs', 'ast', 'death', 'fb', 'fp'].indexOf(stat) + 1 || 9) * 10 + maps.length; };

// ── our records: graded esports rows → each player's past matches ──
// rows: tracker rows from every esports record (the signal and close lines of
// each app, and the result over the line's maps). A match a player was in for
// more than one record is one entry: its lines joined, the first read kept as
// the first and the last as the last.
function recordEntry(row) {
  const game = gameOf(row?.sport);
  if (!game || !row.player || !row.market) return null;
  const t = ms(row.startTime);
  if (t == null) return null;
  const mkey = normalizeMarket(row.market);
  const sig = { ...(row.signalLines || {}) }, cls = { ...(row.closeLines || {}) };
  const app = String(row.appKey || row.signalBook || '').toUpperCase();
  if (APP_NAME[app]) {
    if (sig[app] == null && num(row.signalLine) != null) sig[app] = num(row.signalLine);
    if (cls[app] == null && num(row.closeLine ?? row.signalLine) != null) cls[app] = num(row.closeLine ?? row.signalLine);
  }
  const result = row.status === 'graded' && num(row.result) != null ? num(row.result) : null;
  if (!Object.keys(sig).length && !Object.keys(cls).length && result == null) return null;
  return {
    key: playerKey(game, row.player), game, player: row.player, team: row.team || '', opponent: opponentOf(row), title: row.matchTitle || '',
    mkey, t, first: sig, last: cls, result, short: /^Series ended after/.test(row.note || ''),
  };
}
function buildRecordIndex(rows) {
  const players = new Map();
  const seen = new Map();
  let n = 0;
  for (const row of rows || []) {
    const e = recordEntry(row);
    if (!e) continue;
    const id = `${e.key}|${e.mkey}|${new Date(e.t).toISOString().slice(0, 10)}|${canon(e.opponent || e.title)}`;
    const old = seen.get(id);
    if (old) {
      for (const [k, v] of Object.entries(e.first)) if (old.first[k] == null) old.first[k] = v;
      for (const [k, v] of Object.entries(e.last)) if (old.last[k] == null) old.last[k] = v;
      if (old.result == null && e.result != null) { old.result = e.result; old.short = e.short; }
      if (!old.team && e.team) old.team = e.team;
      if (!old.opponent && e.opponent) old.opponent = e.opponent;
      continue;
    }
    seen.set(id, e);
    if (!players.has(e.key)) players.set(e.key, []);
    players.get(e.key).push(e);
    n++;
  }
  for (const list of players.values()) list.sort((a, b) => b.t - a.t);
  return { players, entries: n };
}

// ── per-map logs → series totals for a span ──
// maps: [{ mid, n, t, team, opp, win, k, a, d, champ, league }] (any order).
// A span's total counts only series where every map in it was played, except
// a "Maps 1-3" line on a series that ended 2-0: the apps grade that on the
// maps played, so it counts too, marked short.
function seriesTotals(maps, mkey) {
  const { stat, maps: span } = parseMkey(mkey);
  const field = MAP_STAT[stat];
  if (!field) return [];
  const by = new Map();
  for (const m of maps || []) {
    if (!m || m.mid == null || !(m.n >= 1)) continue;
    let s = by.get(m.mid);
    if (!s) by.set(m.mid, s = { mid: m.mid, t: m.t, team: m.team, opp: m.opp, league: m.league || '', maps: new Map(), wins: 0, played: 0 });
    s.t = Math.min(s.t, m.t);
    if (!s.maps.has(m.n)) { s.maps.set(m.n, m); s.played++; if (m.win === true) s.wins++; }
    if (typeof m.sw === 'boolean') s.sw = m.sw;
  }
  const out = [];
  for (const s of by.values()) {
    const have = span.filter(n => s.maps.has(n) && num(s.maps.get(n)[field]) != null);
    let short = false;
    if (have.length !== span.length) {
      const missing = span.filter(n => !have.includes(n));
      // a 2-0 on a Maps 1-3 line: maps 1 and 2 played, map 3 never was
      if (!(span.length === 3 && missing.length === 1 && missing[0] === 3 && have.length === 2 && s.played === 2)) continue;
      short = true;
    }
    out.push({ mid: s.mid, t: s.t, team: s.team, opp: s.opp, league: s.league, value: have.reduce((x, n) => x + num(s.maps.get(n)[field]), 0), maps: have.length, short,
      won: typeof s.sw === 'boolean' ? s.sw : [...s.maps.values()].every(x => typeof x.win === 'boolean') ? s.wins * 2 > s.played : null });
  }
  return out.sort((a, b) => b.t - a.t);
}

// newest-first values → over/under/push against a line in each window
function hitRates(values, line, windows = WINDOWS) {
  const v = (values || []).filter(x => Number.isFinite(x));
  return windows.map(w => {
    const xs = w == null ? v : v.slice(0, w);
    const over = xs.filter(x => x > line).length, under = xs.filter(x => x < line).length;
    const sorted = xs.slice().sort((a, b) => a - b);
    const median = !xs.length ? null : xs.length % 2 ? sorted[(xs.length - 1) / 2] : (sorted[xs.length / 2 - 1] + sorted[xs.length / 2]) / 2;
    return { window: w, n: xs.length, full: w == null || xs.length >= w, over, under, push: xs.length - over - under,
      avg: xs.length ? r1(xs.reduce((s, x) => s + x, 0) / xs.length) : null, median };
  });
}
// the distinct current lines, each with the apps on it
function currentLines(market) {
  const by = new Map();
  for (const l of market?.lines || []) {
    if (!by.has(l.line)) by.set(l.line, { line: l.line, apps: [] });
    by.get(l.line).apps.push(l.app);
  }
  return [...by.values()].sort((a, b) => a.line - b.line);
}
function splitRow(label, xs, line) {
  const v = xs.map(x => x.value);
  const [all] = hitRates(v, line, [null]);
  return { label, ...all };
}
// splits for one line: this opponent, series won, series lost
function splits(series, line, opponent) {
  const out = [];
  if (opponent) out.push(splitRow(`vs ${opponent}`, series.filter(s => sameTeam(s.opp, opponent)), line));
  out.push(splitRow('Series his team won', series.filter(s => s.won === true), line));
  out.push(splitRow('Series his team lost', series.filter(s => s.won === false), line));
  return out;
}
// his average on each map number (the stat a map log carries)
function byMapNumber(maps, stat) {
  const field = MAP_STAT[stat];
  if (!field) return [];
  const by = new Map();
  for (const m of maps || []) {
    const v = num(m?.[field]);
    if (v == null || !(m.n >= 1)) continue;
    if (!by.has(m.n)) by.set(m.n, []);
    by.get(m.n).push(v);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([n, xs]) => ({ map: n, n: xs.length, avg: r1(xs.reduce((s, x) => s + x, 0) / xs.length), min: Math.min(...xs), max: Math.max(...xs) }));
}

// ── Leaguepedia (LoL) ──
const LP_API = 'https://lol.fandom.com/api.php';
const LP_HEADERS = { 'User-Agent': 'LineReaper/4.0 (prop research; one query per player, cached)', Accept: 'application/json' };
// a name Cargo can take as-is (no quotes or operators): letters, digits, space, . _ -
const SAFE_NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;
function lolQuery(player, limit = 60) {
  const n = String(player || '').trim();
  if (!SAFE_NAME.test(n)) return null;
  return {
    action: 'cargoquery', format: 'json', limit: String(limit),
    tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG', join_on: 'SP.GameId=SG.GameId',
    fields: 'SP.Link=Link,SP.Team=Team,SP.Kills=Kills,SP.Deaths=Deaths,SP.Assists=Assists,SP.Champion=Champion,SP.PlayerWin=Win,SG.Team1=Team1,SG.Team2=Team2,SG.MatchId=MatchId,SG.N_GameInMatch=GameN,SG.DateTime_UTC=DateTime,SG.Tournament=Tournament',
    where: `SP.Link = '${n}' OR SP.Link LIKE '${n} (%'`,
    order_by: 'SG.DateTime_UTC DESC',
  };
}
// Cargo rows → map log. Leaguepedia gives players who share a name a link
// with their real name in brackets; the one on the board's team is taken,
// else the one who played most recently, and the page says which.
function lolMaps(rows, team = '') {
  const list = (rows || []).map(r => r?.title || r).filter(r => r && r.Link && r.MatchId);
  if (!list.length) return { maps: [], link: null, links: [] };
  const links = [...new Set(list.map(r => r.Link))];
  const latest = l => list.filter(r => r.Link === l).sort((a, b) => String(b.DateTime).localeCompare(String(a.DateTime)))[0];
  let link = links.length === 1 ? links[0] : (team && links.find(l => sameTeam(latest(l).Team, team))) || links.sort((a, b) => String(latest(b).DateTime).localeCompare(String(latest(a).DateTime)))[0];
  const maps = [];
  for (const r of list) {
    if (r.Link !== link) continue;
    const t = ms(String(r.DateTime || '').replace(' ', 'T') + 'Z');
    if (t == null) continue;
    const opp = sameTeam(r.Team1, r.Team) || canon(r.Team1) === canon(r.Team) ? r.Team2 : r.Team1;
    maps.push({ mid: r.MatchId, n: parseInt(r.GameN, 10) || 1, t, team: r.Team || '', opp: opp || '', win: r.Win === 'Yes' ? true : r.Win === 'No' ? false : null,
      k: num(r.Kills), d: num(r.Deaths), a: num(r.Assists), champ: r.Champion || '', league: r.Tournament || '' });
  }
  return { maps: maps.sort((a, b) => b.t - a.t), link, links };
}
async function fetchLolMaps(http, player, team) {
  const params = lolQuery(player);
  if (!params) return { maps: [], link: null, links: [], note: 'This name has characters we don\'t send to Leaguepedia.' };
  const res = await http.get(LP_API, { params, headers: LP_HEADERS, timeout: 20000 });
  if (res.data?.error) throw new Error(`Leaguepedia: ${String(res.data.error.info || res.data.error.code || 'error').slice(0, 120)}`);
  return lolMaps(res.data?.cargoquery || [], team);
}

// ── lolesports (LoL, Riot's own feed) ──
// Leaguepedia rate-limits shared IPs (Railway and GitHub's runners alike), so
// LoL reads first from the feed lolesports.com itself uses: the schedule
// lists each league's matches with both teams and the series result, the
// event's details list its games, and each finished game's last live-stats
// frame holds all ten players' kills, deaths and assists. One read covers a
// team's last few matches for all five players and both teams, so it's cached
// per team. Leagues lolesports lists only (LCK, LPL, LEC, LCS, CBLOL, Worlds
// and the like); Leaguepedia after it for the rest.
const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// a schedule team ({ name, code }) is the board's team
function loleTeamIs(t, team) {
  if (!t || !team) return false;
  const q = sq(team);
  return sq(t.code) === q || sq(t.name) === q || sameTeam(t.name, team) || (q.length <= 5 && sq(t.code) === q);
}
// a finished game's last frame → each player's line ({ name, side, k, d, a, champ })
function loleGameLines(data) {
  const frames = data?.frames || [];
  const last = frames[frames.length - 1];
  if (!last || last.gameState !== 'finished') return null;
  const out = [];
  for (const side of ['blue', 'red']) {
    const meta = data.gameMetadata?.[`${side}TeamMetadata`]?.participantMetadata || [];
    const rows = last[`${side}Team`]?.participants || [];
    for (const m of meta) {
      const r = rows.find(x => x.participantId === m.participantId);
      if (r) out.push({ name: m.summonerName || '', side, k: num(r.kills), d: num(r.deaths), a: num(r.assists), champ: m.championId || '' });
    }
  }
  return out.length ? out : null;
}
// "T1 Faker" or "Faker" is the player
const loleNameIs = (summoner, player) => {
  const s = sq(summoner), p = sq(player);
  return !!p && (s === p || (p.length >= 3 && s.endsWith(p) && s.length - p.length <= 5));
};
// completed schedule events → a team's last n matches, newest first
function loleTeamMatches(events, team, n = 6) {
  return (events || []).filter(e => e?.type === 'match' && e.state === 'completed' && e.match?.id && (e.match.teams || []).some(t => loleTeamIs(t, team)))
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime)).slice(0, n);
}
function createLolesportsLog(http, { LOLE_API, LOLE_FEED, LOLE_HEADERS }, { schedTtlMs = 3 * 3600e3, pages = 10, matches = 6, pause = 350, now = () => Date.now(), sleep = t => new Promise(r => setTimeout(r, t)) } = {}) {
  let sched = { at: 0, events: [] };
  const games = new Map();   // game id → lines (finished games only; compact)
  const get = async (url, params, headers = LOLE_HEADERS) => { await sleep(pause); return http.get(url, { params, headers, timeout: 20000 }); };
  async function schedule() {
    if (now() - sched.at < schedTtlMs) return sched.events;
    const events = [];
    let token = null;
    for (let i = 0; i < pages; i++) {
      const res = await get(`${LOLE_API}/getSchedule`, { hl: 'en-US', ...(token ? { pageToken: token } : {}) });
      const sc = res.data?.data?.schedule;
      for (const e of sc?.events || []) if (e?.type === 'match' && e.state === 'completed') events.push({ startTime: e.startTime, state: e.state, type: e.type, league: { name: e.league?.name || '' }, match: { id: e.match?.id, teams: (e.match?.teams || []).map(t => ({ name: t.name, code: t.code, outcome: t.result?.outcome || null })) } });
      token = sc?.pages?.older;
      if (!token) break;
    }
    sched = { at: now(), events };
    return events;
  }
  async function gameLines(id, startMs) {
    if (games.has(id)) return games.get(id);
    const t = Math.floor(Math.min(now() - 60e3, startMs + 14 * 3600e3) / 10000) * 10000;
    const res = await get(`${LOLE_FEED}/${id}`, { startingTime: new Date(t).toISOString() }, { 'User-Agent': LOLE_HEADERS['User-Agent'] });
    const lines = loleGameLines(res.data);
    if (lines) { games.set(id, lines); while (games.size > 600) games.delete(games.keys().next().value); }
    return lines;
  }
  return async function lolesportsMaps(player, team) {
    if (!team) return { maps: [] };
    const list = loleTeamMatches(await schedule(), team, matches);
    const maps = [];
    for (const ev of list) {
      const mine = ev.match.teams.find(t => loleTeamIs(t, team)), opp = ev.match.teams.find(t => t !== mine);
      const det = await get(`${LOLE_API}/getEventDetails`, { hl: 'en-US', id: ev.match.id });
      const gs = (det.data?.data?.event?.match?.games || []).filter(g => g.state === 'completed');
      const t0 = Date.parse(ev.startTime);
      for (const g of gs) {
        const lines = await gameLines(g.id, t0);
        const me = (lines || []).find(l => loleNameIs(l.name, player));
        if (!me) continue;
        maps.push({ mid: `lole:${ev.match.id}`, n: Number(g.number) || 1, t: t0 + ((Number(g.number) || 1) - 1) * 45 * 60e3, team: mine?.name || team, opp: opp?.name || '',
          win: null, sw: mine?.outcome === 'win' ? true : mine?.outcome === 'loss' ? false : null, k: me.k, d: me.d, a: me.a, champ: me.champ, league: ev.league?.name || '' });
      }
    }
    return { maps: maps.sort((a, b) => b.t - a.t) };
  };
}
// LoL: lolesports first, Leaguepedia when it has nothing for the player
function lolChain(...fetchers) {
  return async (player, team) => {
    let lastErr = null;
    for (const [source, f] of fetchers) {
      try { const r = await f(player, team); if (r?.maps?.length) return { ...r, source }; }
      catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return { maps: [] };
  };
}

// ── OpenDota (Dota 2) ──
function dotaPlayerSql(accountId, limit = 60) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return `SELECT m.match_id, m.start_time, m.series_id, m.radiant_win, pm.player_slot, pm.kills, pm.deaths, pm.assists, rt.name radiant_name, dt.name dire_name, l.name league_name
    FROM player_matches pm JOIN matches m USING(match_id) LEFT JOIN leagues l USING(leagueid)
    LEFT JOIN teams rt ON rt.team_id = m.radiant_team_id LEFT JOIN teams dt ON dt.team_id = m.dire_team_id
    WHERE pm.account_id = ${id} ORDER BY m.start_time DESC LIMIT ${Math.min(100, Math.max(1, limit | 0))}`;
}
// explorer rows → map log. A series is OpenDota's series id; a game without
// one joins the game before it when it starts within 90 minutes of its end.
function dotaMaps(rows) {
  const games = (rows || []).filter(r => r && r.match_id != null && Number.isFinite(Number(r.start_time)))
    .map(r => {
      const rad = Number(r.player_slot) < 128;
      return { id: r.match_id, t: Number(r.start_time) * 1000, sid: Number(r.series_id) > 0 ? `s${r.series_id}` : null, team: (rad ? r.radiant_name : r.dire_name) || '', opp: (rad ? r.dire_name : r.radiant_name) || '',
        win: r.radiant_win == null ? null : !!r.radiant_win === rad, k: num(r.kills), d: num(r.deaths), a: num(r.assists), league: r.league_name || '' };
    })
    .sort((a, b) => a.t - b.t);
  let cur = null, prevT = null;
  const groups = new Map();
  for (const g of games) {
    let mid = g.sid;
    if (!mid) {
      if (cur && prevT != null && g.t - prevT <= 150 * 60e3 && canon(cur.opp) === canon(g.opp)) mid = cur.mid;
      else mid = `m${g.id}`;
    }
    prevT = g.t;
    cur = { mid, opp: g.opp };
    if (!groups.has(mid)) groups.set(mid, []);
    groups.get(mid).push(g);
  }
  const maps = [];
  for (const [mid, list] of groups) list.forEach((g, i) => maps.push({ mid, n: i + 1, t: g.t, team: g.team, opp: g.opp, win: g.win, k: g.k, d: g.d, a: g.a, champ: '', league: g.league }));
  return { maps: maps.sort((a, b) => b.t - a.t) };
}
async function fetchDotaMaps(http, accountId) {
  const sql = dotaPlayerSql(accountId);
  if (!sql) return { maps: [] };
  const res = await http.get('https://api.opendota.com/api/explorer', { params: { sql }, timeout: 30000 });
  if (res.data?.err) throw new Error(`OpenDota: ${String(res.data.err).slice(0, 120)}`);
  return dotaMaps(res.data?.rows || []);
}

// ── the map-log cache: one polite queue per source ──
// fetchers: { LOL: (player, team) → { maps, link? }, DOTA: ... }. A player's
// log is kept okTtl after a good read and failTtl after a failed one, at most
// max players (oldest out). Reads run one at a time per source, gapMs apart,
// and the queue refuses past maxQueue, so a crawl can't flood a free API.
function createMapLogs({ fetchers = {}, okTtlMs = 3 * 3600e3, failTtlMs = 20 * 60e3, max = 200, maxQueue = 12, gapMs = { LOL: 2500, DOTA: 1200 }, now = () => Date.now(), sleep = t => new Promise(r => setTimeout(r, t)) } = {}) {
  const cache = new Map();
  const lanes = {};
  const stats = { reads: 0, errors: 0, refused: 0 };
  const keyOf = (game, player) => playerKey(game, player);
  function peek(game, player) {
    const hit = cache.get(keyOf(game, player));
    if (!hit) return null;
    if (now() - hit.at >= (hit.error ? failTtlMs : okTtlMs)) return null;
    return hit;
  }
  function put(k, v) {
    cache.delete(k);
    cache.set(k, v);
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }
  async function get(game, player, team = '') {
    const fetcher = fetchers[game];
    if (!fetcher) return { status: 'unsupported' };
    const hit = peek(game, player);
    if (hit) return hit;
    const k = keyOf(game, player);
    const lane = lanes[game] || (lanes[game] = { chain: Promise.resolve(), pending: new Map(), last: 0 });
    if (lane.pending.has(k)) return lane.pending.get(k);
    if (lane.pending.size >= maxQueue) { stats.refused++; return { status: 'busy' }; }
    const p = lane.chain.then(async () => {
      const wait = lane.last + (gapMs[game] || 1000) - now();
      if (wait > 0) await sleep(wait);
      lane.last = now();
      stats.reads++;
      try {
        const r = await fetcher(player, team);
        const v = { status: r?.maps?.length ? 'ok' : 'none', at: now(), maps: (r?.maps || []).slice(0, 80), link: r?.link || null, links: r?.links || [], note: r?.note || null, source: r?.source || null, error: null };
        put(k, v);
        return v;
      } catch (e) {
        stats.errors++;
        const v = { status: 'error', at: now(), maps: [], error: e?.response?.status ? `HTTP ${e.response.status}` : String(e?.message || e).slice(0, 120) };
        put(k, v);
        return v;
      } finally { lane.pending.delete(k); }
    });
    lane.chain = p.catch(() => {});
    lane.pending.set(k, p);
    return p;
  }
  return { get, peek, stats: () => ({ ...stats, cached: cache.size, queued: Object.fromEntries(Object.entries(lanes).map(([g, l]) => [g, l.pending.size])) }) };
}

// ── one player's research, for the page and the API ──
// board: boardPlayers() entry or null; records: this player's record entries
// (newest first); log: the map log read ({ status, maps, ... }) or null.
function research({ game, player, board = null, records = [], log = null, mkey = null, now = Date.now() }) {
  const g = GAMES[game];
  const recMkeys = [...new Set(records.map(e => e.mkey))];
  const markets = (board?.markets || []).map(m => ({ mkey: m.mkey, label: m.label, lines: m.lines, startTime: m.startTime, opponent: m.opponent || null }));
  for (const mk of recMkeys) if (!markets.some(m => m.mkey === mk)) markets.push({ mkey: mk, label: marketLabel(mk), lines: [], startTime: null, opponent: null, recordOnly: true });
  markets.sort((a, b) => (a.recordOnly ? 1 : 0) - (b.recordOnly ? 1 : 0) || mkeyOrder(a.mkey) - mkeyOrder(b.mkey));
  const market = markets.find(m => m.mkey === mkey) || markets[0] || null;
  const mk = market?.mkey || null;
  const { stat } = parseMkey(mk);
  const opponent = market?.opponent || board?.opponent || null;
  const lines = currentLines(market);
  const maps = log?.maps || [];
  const fromMaps = g?.maps && MAP_STAT[stat];
  const series = fromMaps ? seriesTotals(maps, mk) : [];
  // this market's past matches in our records, newest first
  const rec = records.filter(e => e.mkey === mk && e.t < now);
  const recValues = rec.filter(e => e.result != null);
  const hitFrom = fromMaps && series.length ? 'maps' : recValues.length ? 'records' : null;
  const values = hitFrom === 'maps' ? series : hitFrom === 'records' ? recValues.map(e => ({ value: e.result, t: e.t, opp: e.opponent, won: null })) : [];
  const hit = lines.map(l => ({ ...l, windows: hitRates(values.map(x => x.value), l.line), splits: splits(values, l.line, opponent) }));
  // how his results sat against the line each app posted then (its last read)
  const vsPosted = {};
  for (const e of recValues) for (const [app, line] of Object.entries(e.last)) {
    if (num(line) == null) continue;
    const s = vsPosted[app] || (vsPosted[app] = { app, n: 0, over: 0, under: 0, push: 0 });
    s.n++;
    if (e.result > line) s.over++; else if (e.result < line) s.under++; else s.push++;
  }
  return {
    game, label: g?.label || game, player: board?.player || records[0]?.player || player, team: board?.team || records[0]?.team || '', opponent,
    startTime: market?.startTime || board?.startTime || null, matchTitle: board?.matchTitle || '',
    markets, market: mk, marketLabel: mk ? marketLabel(mk) : null, lines,
    source: { maps: g?.maps ? (log?.source || g.source) : null, note: g?.maps ? null : NO_SOURCE_NOTE[game] || null, statOnMaps: !!fromMaps, status: log?.status || (g?.maps ? 'not-read' : 'unsupported'), error: log?.error || null, at: log?.at ? new Date(log.at).toISOString() : null, link: log?.link || null, links: log?.links || [], note2: log?.note || null },
    hitFrom, hit, series: series.slice(0, 40), byMap: fromMaps ? byMapNumber(maps, stat) : [], maps: maps.slice(0, 40),
    records: rec.slice(0, 40).map(e => ({ t: new Date(e.t).toISOString(), opponent: e.opponent, first: e.first, last: e.last, result: e.result, short: e.short })),
    vsPosted: Object.values(vsPosted),
    otherRecords: records.length - rec.length,
    note: 'Research, not a bet. A past hit rate is history, not a price: the apps set their lines near the sharp median, and our esports prop models lost to the close. Nothing here is a projection or a pick.',
  };
}

// ── pages ──
const PAGE_CSS = `
.top-in, main, footer .in { max-width:980px; }
.warn { background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.35); color:#fcd34d; border-radius:10px; padding:10px 14px; margin:0 0 18px; font-size:14px; }
.warn b { font:700 11px var(--mono); letter-spacing:.12em; margin-right:6px; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px; }
.chip { font:600 11px var(--mono); letter-spacing:.06em; color:var(--text2); text-decoration:none; border:1px solid var(--border2); border-radius:6px; padding:5px 10px; white-space:nowrap; }
.chip.on { color:var(--bg); background:var(--green2); border-color:var(--green2); }
.note { color:var(--text2); font-size:14px; }
.sub { display:block; color:var(--muted); font-size:11px; font-family:var(--mono); }
.empty { background:var(--card); border:1px dashed var(--border2); border-radius:10px; padding:14px 16px; color:var(--text2); margin:0 0 18px; }
.st-pick { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 16px; font:500 12px var(--mono); color:var(--muted); }
.st-pick select, .st-pick button, .st-pick input { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:600 12px var(--mono); max-width:100%; min-width:0; }
.st-pick button { cursor:pointer; letter-spacing:1px; }
td.n, th.n { text-align:right; white-space:nowrap; }
td.o { color:var(--green2); } td.u { color:#f87171; }
.ln { display:inline-block; font:600 11px var(--mono); border:1px solid var(--border2); border-radius:4px; padding:1px 6px; margin:0 4px 2px 0; color:var(--text); white-space:nowrap; }
.ln i { font-style:normal; color:var(--muted); margin-right:4px; }
ul.pl { list-style:none; padding:0; margin:0 0 18px; border-top:1px solid var(--border); }
ul.pl li { border-bottom:1px solid var(--border); margin:0; }
ul.pl a { display:block; padding:10px 0; color:var(--text); text-decoration:none; overflow-wrap:anywhere; }
ul.pl a b { font-weight:600; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:0 0 18px; }
.cell { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.cell .k { font:600 10px var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.cell .v { font:600 18px var(--mono); color:var(--text); }
.chart { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px; margin:0 0 10px; overflow:hidden; }
.legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin:0 0 14px; font:500 12px var(--mono); color:var(--text2); }
.legend i { display:inline-block; width:12px; height:3px; border-radius:2px; margin-right:6px; vertical-align:middle; }
`;
function head({ title, description, canonical = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#080b10">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<link rel="icon" href="${FAVICON}">
<style>${CSS}${PAGE_CSS}</style>
</head>`;
}
const top = () => `<header class="top"><div class="top-in"><a class="brand" href="/">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app?start=props">OPEN THE APP</a></div></header>`;
const foot = () => `<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/esports/research">Esports research</a><a href="/lines">Line history</a><a href="/leagues">Leagues</a><a href="/developers">API</a><a href="/learn">Learn</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook. It does not take or place bets. Hit rates are past results, not predictions; a player's history is not a proven edge. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>`;
const WARN = '<p class="warn" role="note"><b>RESEARCH · NOT A BET</b>A hit rate is how often his past total beat this line. It is history, not a price or a pick: the apps set their lines near the sharp median, and our esports prop models lost to the close.</p>';
const whenUtc = t => { const x = ms(t); return x == null ? '' : `${new Date(x).toISOString().slice(5, 16).replace('T', ' ')} UTC`; };
const dateUtc = t => { const x = typeof t === 'number' ? t : ms(t); return x == null ? '' : new Date(x).toISOString().slice(0, 10); };
const pct = (a, n) => (n ? `${Math.round((a / n) * 100)}%` : '–');
const lineChips = lines => lines.map(l => `<span class="ln" title="${esc(APP_NAME[l.app])}"><i>${esc(l.app)}</i>${esc(String(l.line))}</span>`).join('');
const playerHref = (game, player, mkey) => `/esports/research/${encodeURIComponent(game)}/${encodeURIComponent(player)}${mkey ? `?m=${encodeURIComponent(mkey)}` : ''}`;

function indexPage({ players = [], counts = {}, game = '', q = '', builtAt = null, origin = '', recordsBuiltAt = null } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const shown = players.filter(p => (!game || p.game === game) && words.every(w => `${p.player} ${p.team} ${p.opponent || ''}`.toLowerCase().includes(w)));
  const byGame = GAME_ORDER.map(g => [g, shown.filter(p => p.game === g)]).filter(([, l]) => l.length);
  const item = p => {
    const n = counts[p.key] || 0;
    return `<li><a href="${esc(playerHref(p.game, p.player))}"><b>${esc(p.player)}</b> <span class="note">${esc(p.team || '')}${p.opponent ? ` vs ${esc(p.opponent)}` : ''}</span><span class="sub">${p.startTime ? `starts ${esc(whenUtc(p.startTime))} · ` : ''}${n ? `${n} past match${n === 1 ? '' : 'es'} in our records` : 'none in our records yet'}</span>${p.markets.map(m => `<span class="sub">${esc(m.label)}: ${lineChips(m.lines)}</span>`).join('')}</a></li>`;
  };
  const form = `<form class="st-pick" method="get" action="/esports/research"><label for="rg">Game</label><select id="rg" name="game"><option value="">All</option>${GAME_ORDER.map(g => `<option value="${g}"${g === game ? ' selected' : ''}>${esc(GAMES[g].label)} (${players.filter(p => p.game === g).length})</option>`).join('')}</select><label for="rq">Find</label><input id="rq" name="q" value="${esc(q)}" placeholder="player or team" maxlength="40"><button type="submit">SHOW</button></form>`;
  const src = GAME_ORDER.map(g => `<tr><td>${esc(GAMES[g].label)}</td><td>${GAMES[g].maps ? `Every recent map from ${esc(GAMES[g].source)} (free API), plus our records` : 'Our records only: no free per-map source'}</td></tr>`).join('');
  return `${head({ title: 'Esports prop research: hit rates against the app line | Line Reaper', description: 'For every LoL, Dota 2, CS2 and VALORANT player prop on PrizePicks, Underdog, Sleeper and DK Pick6: how often the player beat the current line, splits by opponent and map, and the app line history from our records. Research, not picks.', canonical: origin ? `${origin}/esports/research` : null })}
<body>
${top()}
<main id="main">
<p class="kicker">Esports · research</p>
<h1>Esports prop research</h1>
<p class="lead">Every esports player prop the pick'em apps list today, with how often the player went over that line before, splits by opponent and map, and each app's past lines on him from our own records.</p>
${WARN}
${form}
${byGame.length ? byGame.map(([g, list]) => `<h2>${esc(GAMES[g].label)} <span class="note">${list.length} player${list.length === 1 ? '' : 's'}</span></h2><ul class="pl">${list.map(item).join('')}</ul>`).join('') : `<div class="empty">${players.length ? 'No player on the board matches that search.' : 'No esports player props are on the apps we read right now. Lines usually go up a day before the matches.'}</div>`}
<h2>Where the numbers come from</h2>
<div class="scroll"><table><thead><tr><th>Game</th><th>Past maps</th></tr></thead><tbody>${src}</tbody></table></div>
<p class="note">App lines: PrizePicks, Underdog, Sleeper and DK Pick6 as we read them${builtAt ? ` (board built ${esc(whenUtc(builtAt))})` : ''}. Our records: every esports leg our trackers followed to the start and graded${recordsBuiltAt ? `, read ${esc(whenUtc(recordsBuiltAt))}` : ''}. Nothing is filled in or modelled.</p>
<div class="chips"><a class="chip" href="/api/esports/research">THIS LIST AS JSON</a><a class="chip" href="/app?start=props">PROPS IN THE APP</a></div>
</main>
${foot()}
</body>
</html>`;
}

// a small chart: each past match's last app line (one line per app) and his result (dots)
const APP_COLOR = { PP: '#a78bfa', UD: '#fbbf24', SL: '#60a5fa', P6: '#f472b6' };
function lineChart(records) {
  const rs = records.filter(r => Object.keys(r.last || {}).length).slice(0, 20).reverse();
  if (rs.length < 2) return '';
  const vals = rs.flatMap(r => [...Object.values(r.last), ...(r.result != null ? [r.result] : [])]).filter(Number.isFinite);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.1 || 1;
  const W = 640, H = 180, L = 34, R = 10, T = 10, B = 22;
  const x = i => L + (rs.length === 1 ? 0 : (i * (W - L - R)) / (rs.length - 1));
  const y = v => T + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T - B);
  const apps = [...new Set(rs.flatMap(r => Object.keys(r.last)))].filter(a => APP_COLOR[a]);
  const paths = apps.map(a => {
    const pts = rs.map((r, i) => (num(r.last[a]) != null ? `${x(i).toFixed(1)},${y(r.last[a]).toFixed(1)}` : null)).filter(Boolean);
    return pts.length ? `<polyline fill="none" stroke="${APP_COLOR[a]}" stroke-width="2" points="${pts.join(' ')}"/>` : '';
  }).join('');
  const dots = rs.map((r, i) => (r.result != null ? `<circle cx="${x(i).toFixed(1)}" cy="${y(r.result).toFixed(1)}" r="3.5" fill="#e2e8f0"/>` : '')).join('');
  const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" fill="#8391a7" font-size="10" text-anchor="end" font-family="monospace">${r1(v)}</text><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#1e2738"/>`).join('');
  const dates = [0, rs.length - 1].map(i => `<text x="${x(i).toFixed(1)}" y="${H - 6}" fill="#8391a7" font-size="10" text-anchor="${i ? 'end' : 'start'}" font-family="monospace">${esc(rs[i].t.slice(5, 10))}</text>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Each app's last line on his past matches, with his result as dots">${ticks}${paths}${dots}${dates}</svg></div>
<div class="legend">${apps.map(a => `<span><i style="background:${APP_COLOR[a]}"></i>${esc(APP_NAME[a])} line</span>`).join('')}<span><i style="background:#e2e8f0;height:6px;width:6px;border-radius:50%"></i>His result</span></div>`;
}

function playerPage(d, { origin = '' } = {}) {
  const g = GAMES[d.game] || { label: d.game };
  const title = `${d.player}${d.marketLabel ? ` ${d.marketLabel.toLowerCase()}` : ''}: hit rates and line history (${g.label}) | Line Reaper`;
  const chips = d.markets.map(m => `<a class="chip${m.mkey === d.market ? ' on' : ''}" href="${esc(playerHref(d.game, d.player, m.mkey))}"${m.mkey === d.market ? ' aria-current="page"' : ''}>${esc(m.label)}${m.recordOnly ? ' · records' : ''}</a>`).join('');
  const src = d.source;
  const srcLine = src.maps
    ? (src.status === 'ok' ? `Past maps: ${esc(src.maps)}${src.link ? ` (${esc(src.link)})` : ''}, read ${esc(whenUtc(src.at))}.${src.links.length > 1 ? ` ${esc(src.maps)} lists ${src.links.length} players by this name (${esc(src.links.join(', '))}); this is the one on ${esc(d.team || 'his team')} or, failing that, the one who played last.` : ''}`
      : src.status === 'none' ? `${esc(src.maps)} has no pro maps under this name${src.note2 ? `: ${esc(src.note2)}` : ''}. The tables below use our records only.`
        : src.status === 'error' ? `${esc(src.maps)} didn't answer (${esc(src.error)}). The tables below use our records only; this page reads it again in about 20 minutes.`
          : src.status === 'busy' ? `${esc(src.maps)} is being read for other players right now. The tables below use our records only; reload in a minute.`
            : `${esc(src.maps)} hasn't been read for this player yet.`)
    : esc(src.note || 'No free per-map source for this game: our records only.');
  const statNote = src.maps && !src.statOnMaps && d.market ? ` ${esc(src.maps)} doesn't carry ${esc((STAT_LABEL[parseMkey(d.market).stat] || 'this stat').toLowerCase())}, so this market uses our records only.` : '';
  const wLabel = w => (w.window == null ? `All (${w.n})` : `Last ${w.window}${w.full ? '' : ` (${w.n})`}`);
  const hitTable = h => `<h3 class="kicker">Line ${esc(String(h.line))} · ${esc(h.apps.map(a => APP_NAME[a]).join(', '))}</h3>
<div class="scroll"><table><thead><tr><th>Window</th><th class="n">Over</th><th class="n">Under</th><th class="n">Push</th><th class="n">Over rate</th><th class="n">Average</th><th class="n">Median</th></tr></thead><tbody>${h.windows.map(w => `<tr><td>${esc(wLabel(w))}</td><td class="n">${w.over}</td><td class="n">${w.under}</td><td class="n">${w.push}</td><td class="n">${pct(w.over, w.n)}</td><td class="n">${w.avg ?? '–'}</td><td class="n">${w.median ?? '–'}</td></tr>`).join('')}</tbody></table></div>
<div class="scroll"><table><thead><tr><th>Split</th><th class="n">Series</th><th class="n">Over</th><th class="n">Under</th><th class="n">Over rate</th><th class="n">Average</th></tr></thead><tbody>${h.splits.map(s => `<tr><td>${esc(s.label)}</td><td class="n">${s.n}</td><td class="n">${s.over}</td><td class="n">${s.under}</td><td class="n">${pct(s.over, s.n)}</td><td class="n">${s.avg ?? '–'}</td></tr>`).join('')}</tbody></table></div>`;
  const hitFromTxt = d.hitFrom === 'maps' ? `Each value is his total over the line's maps in one series, from ${esc(src.maps)}. A Maps 1-3 line on a series that ended 2-0 counts the two maps played, as the apps grade it.`
    : d.hitFrom === 'records' ? 'Each value is his graded result on this market in our records.' : '';
  const hitHtml = !d.lines.length
    ? `<div class="empty">No app lists this market for ${esc(d.player)} right now, so there is no current line to measure against. His past lines and results are below.</div>`
    : !d.hitFrom ? `<div class="empty">No past results for this market yet${src.maps && src.statOnMaps ? '' : ' in our records'}.</div>`
      : `<p class="note">${hitFromTxt}</p>${d.hit.map(hitTable).join('')}`;
  const field = MAP_STAT[parseMkey(d.market).stat];
  const mapLog = d.maps.length ? `<h2>Recent maps</h2>
<div class="scroll"><table><thead><tr><th>Date</th><th>Opponent</th><th class="n">Map</th><th class="n">K</th><th class="n">D</th><th class="n">A</th>${d.game === 'LOL' ? '<th>Champion</th>' : ''}<th>Result</th><th>Event</th></tr></thead><tbody>${d.maps.slice(0, 30).map(m => `<tr><td>${esc(dateUtc(m.t))}</td><td>${esc(m.opp || '?')}</td><td class="n">${m.n}</td><td class="n${field === 'k' ? ' o' : ''}">${m.k ?? '–'}</td><td class="n${field === 'd' ? ' o' : ''}">${m.d ?? '–'}</td><td class="n${field === 'a' ? ' o' : ''}">${m.a ?? '–'}</td>${d.game === 'LOL' ? `<td>${esc(m.champ || '')}</td>` : ''}<td>${m.win == null ? '–' : m.win ? 'W' : 'L'}</td><td>${esc(m.league || '')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const byMap = d.byMap.length ? `<h2>By map number</h2><p class="note">His ${esc((STAT_LABEL[parseMkey(d.market).stat] || '').toLowerCase())} on each map of a series, every map we have.</p>
<div class="scroll"><table><thead><tr><th>Map</th><th class="n">Maps</th><th class="n">Average</th><th class="n">Low</th><th class="n">High</th></tr></thead><tbody>${d.byMap.map(b => `<tr><td>Map ${b.map}</td><td class="n">${b.n}</td><td class="n">${b.avg}</td><td class="n">${b.min}</td><td class="n">${b.max}</td></tr>`).join('')}</tbody></table></div>` : '';
  const apps = [...new Set(d.records.flatMap(r => [...Object.keys(r.first), ...Object.keys(r.last)]))].filter(a => APP_NAME[a]);
  const recRow = r => {
    const ref = r.last.UD ?? r.last.PP ?? r.last.SL ?? r.last.P6;
    const cls = r.result == null || ref == null ? '' : r.result > ref ? ' o' : r.result < ref ? ' u' : '';
    return `<tr><td>${esc(dateUtc(r.t))}</td><td>${esc(r.opponent || '?')}</td>${apps.map(a => `<td class="n">${r.first[a] == null && r.last[a] == null ? '–' : r.first[a] != null && r.last[a] != null && r.first[a] !== r.last[a] ? `${r.first[a]} → ${r.last[a]}` : esc(String(r.last[a] ?? r.first[a]))}</td>`).join('')}<td class="n${cls}">${r.result == null ? 'not graded' : `${r.result}${r.short ? '*' : ''}`}</td></tr>`;
  };
  const recHtml = d.records.length ? `${lineChart(d.records)}
<div class="scroll"><table><thead><tr><th>Date</th><th>Opponent</th>${apps.map(a => `<th class="n">${esc(APP_NAME[a])}</th>`).join('')}<th class="n">Result</th></tr></thead><tbody>${d.records.map(recRow).join('')}</tbody></table></div>
<p class="note">Each app's line at our first read and our last read before the start ("first → last" when it moved). Result is his total over the line's maps${d.records.some(r => r.short) ? '; * the series ended before the last map, graded on the maps played' : ''}. Green: over the last line read, red: under.</p>
${d.vsPosted.length ? `<div class="grid">${d.vsPosted.map(v => `<div class="cell"><div class="k">vs ${esc(APP_NAME[v.app])}'s line</div><div class="v">${v.over}-${v.under}${v.push ? `-${v.push}` : ''}</div><div class="sub">over-under${v.push ? '-push' : ''} on ${v.n} graded</div></div>`).join('')}</div>` : ''}`
    : `<div class="empty">Our records hold no past ${esc(d.marketLabel ? d.marketLabel.toLowerCase() : 'lines')} for ${esc(d.player)} yet. A line joins them when one of our trackers follows it to the start.${d.otherRecords ? ` ${d.otherRecords} record${d.otherRecords === 1 ? '' : 's'} on his other markets.` : ''}</div>`;
  const current = d.lines.length ? `<div class="grid">${d.markets.find(m => m.mkey === d.market).lines.map(l => `<div class="cell"><div class="k">${esc(APP_NAME[l.app])}</div><div class="v">${esc(String(l.line))}</div><div class="sub">${l.overOpen && l.underOpen ? 'over and under open' : l.overOpen ? 'over only' : l.underOpen ? 'under only' : 'closed'}</div></div>`).join('')}</div>` : '';
  return `${head({ title, description: `${d.player} (${d.team || g.label}) ${d.marketLabel || ''}: how often he beat the current pick'em line, splits by opponent and map, and each app's past lines from our records. Research, not a pick.`, canonical: origin ? `${origin}${playerHref(d.game, d.player)}` : null })}
<body>
${top()}
<main id="main">
<p class="kicker"><a href="/esports/research">Esports research</a> · ${esc(g.label)}</p>
<h1>${esc(d.player)}</h1>
<p class="lead">${esc(d.team || '')}${d.opponent ? ` vs ${esc(d.opponent)}` : ''}${d.startTime ? ` · starts ${esc(whenUtc(d.startTime))}` : ''}</p>
${WARN}
${d.markets.length ? `<nav class="chips" aria-label="Markets">${chips}</nav>` : ''}
${d.market ? `<h2>${esc(d.marketLabel)}: today's lines</h2>${current || '<p class="note">Not on the apps right now.</p>'}
<h2>Hit rate against the current line</h2>
${hitHtml}
${byMap}${mapLog}
<h2>App line history <span class="note">our records</span></h2>
${recHtml}` : `<div class="empty">Nothing for ${esc(d.player)}: no app lists him and our records hold none of his lines.</div>`}
<h2>Sources</h2>
<p class="note">${srcLine}${statNote}</p>
<p class="note">${esc(d.note)}</p>
<div class="chips"><a class="chip" href="/api${esc(playerHref(d.game, d.player, d.market))}">THIS PAGE AS JSON</a><a class="chip" href="/esports/research">ALL PLAYERS</a></div>
</main>
${foot()}
</body>
</html>`;
}

module.exports = {
  GAMES, GAME_ORDER, APPS, APP_NAME, gameOf, parseMkey, marketLabel, playerKey, boardPlayers, recordEntry, buildRecordIndex,
  seriesTotals, hitRates, currentLines, splits, byMapNumber, loleTeamIs, loleGameLines, loleNameIs, loleTeamMatches, createLolesportsLog, lolChain, lolQuery, lolMaps, fetchLolMaps, dotaPlayerSql, dotaMaps, fetchDotaMaps,
  createMapLogs, research, indexPage, playerPage, playerHref,
};
