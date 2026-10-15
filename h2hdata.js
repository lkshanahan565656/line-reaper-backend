// ─── HEAD-TO-HEAD KILL MODEL: THE DATA BEHIND IT ──────────────────────────────
// What h2hmodel.js needs for one player line: the league's pace, his team's
// kills for and the opponent's kills against (a game, or a round), his share
// of his team's kills and his own average a map.
//
//   LoL:  gol.gg's season tables, the team list (kills and deaths a game) and
//         the player list (kills a game), one page each
//   Dota: OpenDota's explorer (pro and premium leagues), every game since the
//         seed's last one, kept as running averages
//   CS2:  bo3.gg's s/a/b-tier maps with each player's kills (players_stats),
//         every map since the seed's last one, kept as running averages
//
// Dota and CS2 keep exponentially weighted running totals per team and player
// (a half-life of hl games each), exactly the state the walk-forward fit used.
// A seed of that state ships in seeds/ so a cold start prices at once; each
// refresh adds the games played since. Parsing and the running state are pure
// and unit-tested; the fetchers take an http client.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { teamsMatch, teamCode } = require('./context');

const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// a name without the words teams add and drop ("9Z Team" ↔ "9z", "Team Envy"
// ↔ "Envy", "MVK Esports" ↔ "MVK")
const core = s => sq(s).replace(/^team(?=..)/, '').replace(/(?<=..)(team|esports?|gaming|clan|club)$/, '');
const initials = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join('');
// how well a stored name fits an app's name: 1 same core, 2 one name starts
// the other ("FURIA" ↔ "FURIA Esports"), 3 a code ("KC" ↔ "Karmine Corp",
// "EAC" ↔ "Esport Academy Copenhagen"), 4 one contains the other; 0 no fit.
// A full name always beats a code, so "MVK" never takes Movistar KOI when the
// store also has MVK Esports.
function nameTier(stored, name) {
  const a = core(stored), b = core(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (teamsMatch(stored, name)) return 2;
  if ((b.length <= 4 && teamCode(stored, name)) || (a.length <= 4 && initials(name) === sq(stored))) return 3;
  if (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))) return 4;
  return 0;
}
const ROUNDS_PER_MAP = 21.3;

// ── running state (Dota, CS2) ──
// map: { t, R (rounds, CS2 only), teams: [{ key, name, tag?, K }], players: [{ id, name, ti, k }] }
function createStore({ title, hl, unit = 'game', pace0 }) {
  const dec = Math.pow(0.5, 1 / hl);
  const s = { title, unit, hl, pace: pace0, rounds: ROUNDS_PER_MAP, lastT: 0, maps: 0, teams: {}, players: {}, names: {}, teamNames: {} };
  return wrapStore(s, dec);
}
function wrapStore(s, dec = Math.pow(0.5, 1 / s.hl)) {
  function ingest(m) {
    if (!m || !(m.t > s.lastT) || m.teams?.length !== 2) return false;
    const R = s.unit === 'round' ? m.R : 0;
    if (s.unit === 'round' && !(R >= 13)) return false;
    for (let i = 0; i < 2; i++) {
      const a = m.teams[i], b = m.teams[1 - i];
      const x = s.teams[a.key] || (s.teams[a.key] = { kf: 0, ka: 0, n: 0, r: 0 });
      x.kf = x.kf * dec + a.K; x.ka = x.ka * dec + b.K; x.n = x.n * dec + 1; x.r = x.r * dec + R; x.t = m.t;
      for (const nm of [a.name, a.tag]) if (sq(nm)) s.teamNames[sq(nm)] = a.key;
    }
    for (const p of m.players) {
      const q = s.players[p.id] || (s.players[p.id] = { k: 0, tk: 0, n: 0, r: 0 });
      q.k = q.k * dec + p.k; q.tk = q.tk * dec + m.teams[p.ti].K; q.n = q.n * dec + 1; q.r = q.r * dec + R; q.team = m.teams[p.ti].key; q.t = m.t;
      if (sq(p.name)) s.names[sq(p.name)] = p.id;
    }
    if (s.unit === 'round') { s.pace = s.pace * 0.999 + 0.001 * (m.teams[0].K + m.teams[1].K) / (2 * R); s.rounds = s.rounds * 0.999 + 0.001 * R; }
    else s.pace = s.pace * 0.995 + 0.005 * (m.teams[0].K + m.teams[1].K) / 2;
    s.lastT = m.t; s.maps++;
    return true;
  }
  // a team by name: its exact key, then the best tier of nameTier (most
  // maps wins a tie)
  function findTeam(name) {
    const k = sq(name);
    if (!k) return null;
    if (s.teamNames[k]) return s.teamNames[k];
    let best = null, bt = 0;
    for (const [nm, key] of Object.entries(s.teamNames)) {
      const t = nameTier(nm, name);
      if (t && (!best || t < bt || (t === bt && (s.teams[key]?.n || 0) > (s.teams[best]?.n || 0)))) { best = key; bt = t; }
    }
    return best;
  }
  // everything h2hmodel needs for one player line, or why not
  function inputs(player, team, opp, { minGames = 6, minTeamGames = 3, shareGames = 4 } = {}) {
    const id = s.names[sq(player)] ?? s.names[sq(String(player || '').split(/\s+/).pop())];
    const q = id != null ? s.players[id] : null;
    if (!q) return { why: 'player' };
    if (q.n < minGames) return { why: 'games' };
    const tk = (team && findTeam(team)) || q.team, ok = opp ? findTeam(opp) : null;
    const ta = s.teams[tk], tb = ok != null ? s.teams[ok] : null;
    if (!ta || !tb || tk === ok) return { why: 'team' };
    if (ta.n < minTeamGames || tb.n < minTeamGames) return { why: 'team games' };
    const round = s.unit === 'round';
    const own = q.k / q.n;
    // share of the team's kills; CS2 shrinks it toward a fifth both ways (the
    // fit's form), Dota keeps it raw (a carry's share is his role)
    const avgTK = q.tk / q.n;
    const share = round ? (q.k + 0.2 * shareGames * avgTK) / (q.tk + shareGames * avgTK) : q.k / q.tk;
    return {
      pace: s.pace, rounds: round ? s.rounds : null, own, share, games: +q.n.toFixed(1),
      team: round ? { kf: ta.kf / ta.r, n: ta.r / ROUNDS_PER_MAP } : { kf: ta.kf / ta.n, n: ta.n },
      opp: round ? { ka: tb.ka / tb.r, n: tb.r / ROUNDS_PER_MAP } : { ka: tb.ka / tb.n, n: tb.n },
      teamKey: tk, oppKey: ok,
    };
  }
  // drop players and teams idle for `days` (keeps the seed small)
  function prune(days = 150) {
    const cut = s.lastT - days * 86400e3;
    for (const [k, v] of Object.entries(s.players)) if (!(v.t >= cut)) delete s.players[k];
    for (const [k, v] of Object.entries(s.teams)) if (!(v.t >= cut)) delete s.teams[k];
    for (const [k, v] of Object.entries(s.names)) if (!s.players[v]) delete s.names[k];
    for (const [k, v] of Object.entries(s.teamNames)) if (!s.teams[v]) delete s.teamNames[k];
  }
  const round4 = o => { for (const v of Object.values(o)) for (const f of ['kf', 'ka', 'n', 'r', 'k', 'tk']) if (typeof v[f] === 'number') v[f] = Math.round(v[f] * 1e3) / 1e3; };
  function toJSON() { round4(s.players); round4(s.teams); return s; }
  return { state: s, ingest, findTeam, inputs, prune, toJSON };
}
function loadStore(file) {
  try {
    const buf = fs.readFileSync(file);
    const s = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString());
    return s && s.players && s.teams ? wrapStore(s) : null;
  } catch { return null; }
}
function saveStore(store, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(store.toJSON());
  fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(body) : body);
}

// ── CS2: bo3.gg ──
const BO3 = 'https://api.bo3.gg/api/v1';
const BO3_HEADERS = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper h2h model)', Accept: 'application/json' };
// one game and its players_stats rows → a map for the store (null when the
// stats aren't parsed yet or don't give two full lineups)
function bo3Map(match, game, rows, names) {
  const tn = [names[match.team1_id] || match.an, names[match.team2_id] || match.bn];
  if (!tn[0] || !tn[1] || !Array.isArray(rows)) return null;
  const R = Number(game.rounds_count ?? (Number(game.winner_clan_score) + Number(game.loser_clan_score)));
  const ps = rows.map(r => ({ name: r?.steam_profile?.player?.nickname || r?.steam_profile?.nickname || null, slug: r?.steam_profile?.player?.slug || null,
    team: r.clan_name ?? r.team_clan?.clan_name ?? r.clan?.name ?? null, k: Number(r.kills) }))
    .filter(p => p.name && Number.isFinite(p.k));
  const ti = p => tn.findIndex(t => sq(t) === sq(p.team) || teamsMatch(t, p.team));
  const players = ps.map(p => ({ id: `cs:${p.slug || sq(p.name)}`, name: p.name, ti: ti(p), k: p.k })).filter(p => p.ti >= 0);
  if (players.filter(p => p.ti === 0).length !== 5 || players.filter(p => p.ti === 1).length !== 5 || !(R >= 13)) return null;
  const K = [0, 1].map(i => players.filter(p => p.ti === i).reduce((a, p) => a + p.k, 0));
  const t = Date.parse(game.begin_at || match.start_date);
  return Number.isFinite(t) ? { t, R, teams: tn.map((name, i) => ({ key: `cs:${sq(name)}`, name, K: K[i] })), players } : null;
}
async function fetchCsMaps(http, { since, maxPages = 10, pause = 250 } = {}) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ms = [];
  for (let p = 0; p < maxPages; p++) {
    const res = await http.get(`${BO3}/matches`, { headers: BO3_HEADERS, timeout: 20000, params: { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date',
      'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } });
    const rows = res?.data?.results || [];
    ms.push(...rows.filter(m => ['s', 'a', 'b'].includes(m.tier) && Date.parse(m.start_date) > since - 6 * 3600e3));
    if (rows.length < 100 || Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity)) < since - 6 * 3600e3) break;
    await wait(pause);
  }
  if (!ms.length) return [];
  const ids = [...new Set(ms.flatMap(m => [m.team1_id, m.team2_id]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const res = await http.get(`${BO3}/teams`, { headers: BO3_HEADERS, timeout: 20000, params: { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 } });
    for (const t of res?.data?.results || []) if (t?.id != null) names[t.id] = t.name;
    await wait(pause);
  }
  const byId = new Map(ms.map(m => [m.id, m]));
  const games = [];
  for (let i = 0; i < ms.length; i += 60) {
    const res = await http.get(`${BO3}/games`, { headers: BO3_HEADERS, timeout: 20000, params: { 'filter[games.match_id][in]': ms.slice(i, i + 60).map(m => m.id).join(','), 'page[limit]': 100 } });
    for (const g of res?.data?.results || []) if (g.status === 'finished' && Date.parse(g.begin_at) > since) games.push(g);
    await wait(pause);
  }
  const out = [];
  for (const g of games.sort((a, b) => Date.parse(a.begin_at) - Date.parse(b.begin_at))) {
    let rows = null;
    try { const res = await http.get(`${BO3}/games/${g.id}/players_stats`, { headers: BO3_HEADERS, timeout: 20000 }); rows = Array.isArray(res?.data) ? res.data : res?.data?.results || null; } catch { /* one map */ }
    const m = rows ? bo3Map(byId.get(g.match_id), g, rows, names) : null;
    if (m) out.push(m);
    else if (Date.now() - Date.parse(g.begin_at) < 6 * 3600e3) break;   // stats not parsed yet: try again next refresh, in order
    await wait(pause);
  }
  return out;
}

// ── Dota: OpenDota explorer ──
const DOTA_COLS = ['match_id', 'start_time', 'radiant_score', 'dire_score', 'radiant_team_id', 'dire_team_id', 'player_slot', 'account_id', 'kills'];
function dotaSql(sinceSec) {
  return `SELECT m.match_id, m.start_time, m.radiant_score, m.dire_score, m.radiant_team_id, m.dire_team_id, pm.player_slot, pm.account_id, pm.kills
    FROM matches m JOIN player_matches pm USING(match_id) JOIN leagues l USING(leagueid)
    WHERE m.start_time > ${Math.floor(sinceSec)} AND l.tier IN ('premium','professional') AND m.radiant_team_id IS NOT NULL AND m.dire_team_id IS NOT NULL
    ORDER BY m.match_id LIMIT 20000`;
}
// explorer rows (one per player) → maps. teams: { id → { name, tag } }, pros: { account → name }
function dotaMaps(rows, { teams = {}, pros = {} } = {}) {
  const by = new Map();
  for (const r of rows || []) {
    const id = r.match_id ?? r[0];
    const g = by.get(id) || by.set(id, { t: (r.start_time ?? r[1]) * 1000, rs: r.radiant_score ?? r[2], ds: r.dire_score ?? r[3], rt: r.radiant_team_id ?? r[4], dt: r.dire_team_id ?? r[5], p: [] }).get(id);
    g.p.push({ rad: (r.player_slot ?? r[6]) < 128, acct: r.account_id ?? r[7], k: r.kills ?? r[8] });
  }
  const out = [];
  for (const g of by.values()) {
    if (g.p.length !== 10 || !g.rt || !g.dt || g.p.some(p => !p.acct)) continue;
    const team = (id, K) => ({ key: `dota:${id}`, name: teams[id]?.name || String(id), tag: teams[id]?.tag || null, K });
    out.push({ t: g.t, teams: [team(g.rt, g.rs), team(g.dt, g.ds)], players: g.p.map(p => ({ id: `dota:${p.acct}`, name: pros[p.acct] || null, ti: p.rad ? 0 : 1, k: p.k })) });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function fetchDotaMaps(http, { since }) {
  const res = await http.get('https://api.opendota.com/api/explorer', { params: { sql: dotaSql(since / 1000) }, timeout: 60000 });
  if (res?.data?.err) throw new Error(`OpenDota explorer: ${String(res.data.err).slice(0, 120)}`);
  const [teams, pros] = await Promise.all([
    http.get('https://api.opendota.com/api/teams', { timeout: 30000 }).then(r => r.data).catch(() => []),
    http.get('https://api.opendota.com/api/proPlayers', { timeout: 30000 }).then(r => r.data).catch(() => []),
  ]);
  const tm = {}, pr = {};
  for (const t of Array.isArray(teams) ? teams : []) tm[t.team_id] = { name: t.name, tag: t.tag };
  for (const p of Array.isArray(pros) ? pros : []) pr[p.account_id] = p.name;
  return dotaMaps(res?.data?.rows || [], { teams: tm, pros: pr });
}

// ── LoL: gol.gg's team list ──
const text = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
const num = s => { const v = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(v) ? v : null; };
// → { [sq(name)]: { name, games, kpg, dpg, minutes } }
function parseGolTeams(html) {
  const s = String(html || '');
  const at = s.indexOf('Kills / game');
  if (at < 0) return {};
  const head = s.slice(s.lastIndexOf('<thead', at), s.indexOf('</thead>', at));
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => text(m[1]).toLowerCase());
  const iG = cols.indexOf('games'), iK = cols.indexOf('kills / game'), iD = cols.indexOf('deaths / game'), iL = cols.indexOf('game duration');
  if (iG < 0 || iK < 0 || iD < 0) return {};
  const body = s.slice(s.indexOf('</thead>', at), s.indexOf('</table>', at));
  const out = {};
  for (const row of body.split(/<tr[\s>]/).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (cells.length <= Math.max(iK, iD)) continue;
    const name = text(cells[0]), games = num(text(cells[iG])), kpg = num(text(cells[iK])), dpg = num(text(cells[iD]));
    if (!name || !(games > 0) || kpg == null || dpg == null) continue;
    const dur = iL >= 0 ? /(\d+):(\d+)/.exec(text(cells[iL])) : null;
    const k = sq(name);
    if (out[k] && out[k].games >= games) continue;
    out[k] = { name, games, kpg, dpg, minutes: dur ? +dur[1] + dur[2] / 60 : null };
  }
  return out;
}
async function fetchGolTeams(http, { season }) {
  const res = await http.get(`https://gol.gg/teams/list/season-${season}/split-ALL/tournament-ALL/`, { timeout: 60000, responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' } });
  const teams = parseGolTeams(res?.data);
  if (!Object.keys(teams).length) throw new Error('gol.gg: no team rows parsed');
  return teams;
}
// a LoL team in gol.gg's list by an app's name or code ("KC", "Karmine Corp")
function findGolTeam(teams, name) {
  const k = sq(name);
  if (!k) return null;
  if (teams[k]) return teams[k];
  let best = null, bt = 0;
  for (const t of Object.values(teams)) {
    const r = nameTier(t.name, name);
    if (r && (!best || r < bt || (r === bt && t.games > best.games))) { best = t; bt = r; }
  }
  return best;
}
// LoL inputs: the season tables, games-weighted pace
function golInputs(teams, player, team, opp, { minGames = 6, minTeamGames = 3 } = {}) {
  if (!player || !(player.kpg > 0)) return { why: 'player' };
  if (!(player.games >= minGames)) return { why: 'games' };
  const ta = findGolTeam(teams, team), tb = opp ? findGolTeam(teams, opp) : null;
  if (!ta || !tb || ta === tb) return { why: 'team' };
  if (ta.games < minTeamGames || tb.games < minTeamGames) return { why: 'team games' };
  let g = 0, k = 0;
  for (const t of Object.values(teams)) if (t.games >= minTeamGames) { g += t.games; k += t.kpg * t.games; }
  return { pace: g ? k / g : 15, own: player.kpg, games: player.games, rate: player.kpg,
    team: { kf: ta.kpg, n: ta.games }, opp: { ka: tb.dpg, n: tb.games }, teamKey: ta.name, oppKey: tb.name, teamKpg: ta.kpg };
}

module.exports = { createStore, wrapStore, loadStore, saveStore, bo3Map, fetchCsMaps, dotaSql, dotaMaps, fetchDotaMaps, parseGolTeams, fetchGolTeams, findGolTeam, golInputs, nameTier, ROUNDS_PER_MAP };
