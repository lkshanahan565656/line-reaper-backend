// One-shot: per-map player box scores for CS2, Dota 2, Valorant and LoL,
// grouped by series, for the same-match stack correlation fit. Writes out/<game>.json.gz.
const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const { vlrMatchPage, vlrResultsList } = require('../graders');
const http = axios.create({ validateStatus: s => s < 500 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const DAYS = Number(process.env.DAYS || 200);
const SINCE = Date.now() - DAYS * 86400e3;
const DEADLINE = Date.now() + Number(process.env.MINUTES || 32) * 60e3;
fs.mkdirSync('out', { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(s); fs.appendFileSync('out/log.txt', s + '\n'); };
const save = (name, rows) => { fs.writeFileSync(`out/${name}.json.gz`, zlib.gzipSync(JSON.stringify(rows))); log(name, 'saved', rows.length); };
async function get(url, opt = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await http.get(url, { timeout: 30000, ...opt });
      if (r.status === 429 || r.status >= 500) { await wait(2000 * 2 ** i); continue; }
      return r;
    } catch (e) { await wait(2000 * 2 ** i); }
  }
  return null;
}

// ── CS2: bo3.gg ──
const BO3 = 'https://api.bo3.gg/api/v1';
const BH = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper stack fit)', Accept: 'application/json' };
async function cs() {
  const ms = [];
  for (let p = 0; p < 60 && Date.now() < DEADLINE; p++) {
    const r = await get(`${BO3}/matches`, { headers: BH, params: { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', with: 'games,teams',
      'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } });
    const rows = r?.data?.results || [];
    ms.push(...rows.filter(m => ['s', 'a', 'b', 'c'].includes(m.tier) && Date.parse(m.start_date) > SINCE));
    if (rows.length < 100 || Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity)) < SINCE) break;
    await wait(200);
  }
  log('cs matches', ms.length);
  const names = {};
  const ids = [...new Set(ms.flatMap(m => [m.team1_id, m.team2_id]).filter(x => x != null))];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await get(`${BO3}/teams`, { headers: BH, params: { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 } });
    for (const t of r?.data?.results || []) names[t.id] = t.name;
    await wait(200);
  }
  const out = [];
  let games = 0;
  for (const m of ms) {
    if (Date.now() > DEADLINE) { log('cs deadline'); break; }
    const tn = [names[m.team1_id], names[m.team2_id]];
    if (!tn[0] || !tn[1]) continue;
    const s = { g: 'cs', id: `bo3:${m.id}`, t: m.start_date, tier: m.tier, bo: m.bo_type, teams: tn, score: [m.team1_score, m.team2_score], maps: [] };
    for (const g of (m.games || []).filter(x => x.status === 'finished').sort((a, b) => a.number - b.number)) {
      const r = await get(`${BO3}/games/${g.id}/players_stats`, { headers: BH });
      games++;
      const rows = Array.isArray(r?.data) ? r.data : r?.data?.results || [];
      const p = rows.map(x => [x.clan_name ?? x.team_clan?.clan_name ?? null, x?.steam_profile?.player?.slug || x?.steam_profile?.player?.nickname || x?.steam_profile?.nickname,
        Number(x.kills), Number(x.headshots), Number(x.assists)]).filter(x => x[1] && Number.isFinite(x[2]));
      s.maps.push({ n: g.number, R: Number(g.rounds_count ?? (Number(g.winner_clan_score) + Number(g.loser_clan_score))), w: g.winner_clan_name || null, p });
      await wait(120);
    }
    if (s.maps.length) out.push(s);
    if (out.length % 200 === 0) save('cs', out);
  }
  log('cs games read', games);
  save('cs', out);
}

// ── Dota 2: OpenDota explorer ──
async function dota() {
  const out = new Map();
  const step = 15 * 86400;
  for (let t0 = Math.floor(SINCE / 1000); t0 < Date.now() / 1000 && Date.now() < DEADLINE; t0 += step) {
    const sql = `SELECT m.match_id, m.start_time, m.duration, m.radiant_win, m.radiant_score, m.dire_score, m.series_id, m.series_type, m.radiant_team_id, m.dire_team_id,
      pm.player_slot, pm.account_id, pm.kills, pm.assists, rt.name rn, dt.name dn, l.tier
      FROM matches m JOIN player_matches pm USING(match_id) JOIN leagues l USING(leagueid)
      LEFT JOIN teams rt ON rt.team_id = m.radiant_team_id LEFT JOIN teams dt ON dt.team_id = m.dire_team_id
      WHERE m.start_time > ${t0} AND m.start_time <= ${t0 + step} AND l.tier IN ('premium','professional','excluded') AND m.radiant_team_id IS NOT NULL AND m.dire_team_id IS NOT NULL
      ORDER BY m.match_id LIMIT 40000`;
    const r = await get('https://api.opendota.com/api/explorer', { params: { sql }, timeout: 120000 });
    const rows = r?.data?.rows || [];
    log('dota window', new Date(t0 * 1000).toISOString().slice(0, 10), rows.length, r?.data?.err || '');
    for (const x of rows) {
      const g = out.get(x.match_id) || out.set(x.match_id, { id: x.match_id, t: x.start_time, dur: x.duration, rw: x.radiant_win, sid: x.series_id, st: x.series_type,
        teams: [x.rn || String(x.radiant_team_id), x.dn || String(x.dire_team_id)], tid: [x.radiant_team_id, x.dire_team_id], tier: x.tier, p: [] }).get(x.match_id);
      g.p.push([x.player_slot < 128 ? 0 : 1, x.account_id, x.kills, x.assists]);
    }
    await wait(1500);
  }
  save('dota', [...out.values()]);
}

// ── Valorant: vlr.gg (licence gate: one pass, polite pause) ──
const VLR = 'https://www.vlr.gg';
const VH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };
async function val() {
  const list = [];
  for (let p = 1; p <= 40 && Date.now() < DEADLINE; p++) {
    const r = await get(`${VLR}/matches/results${p > 1 ? `/?page=${p}` : ''}`, { headers: VH, responseType: 'text' });
    const rows = vlrResultsList(r?.data);
    if (!rows.length) break;
    list.push(...rows);
    await wait(1000);
  }
  const ids = [...new Set(list.map(r => r.id))];
  log('val ids', ids.length);
  const out = [];
  for (const id of ids) {
    if (Date.now() > DEADLINE) { log('val deadline'); break; }
    const r = await get(`${VLR}/${id}`, { headers: VH, responseType: 'text' });
    const pg = vlrMatchPage(r?.data);
    if (pg && pg.final && pg.teams?.length === 2) {
      out.push({ g: 'val', id: `vlr:${id}`, t: pg.start, teams: pg.teams.map(t => t.name),
        maps: pg.maps.filter(m => m.done).map(m => ({ n: m.number, R: m.score[0] + m.score[1], score: m.score, p: m.players.map(x => [x.team, x.id || x.name, x.kills, x.assists]) })) });
    }
    if (out.length % 100 === 0) save('val', out);
    await wait(900);
  }
  save('val', out);
}

// ── LoL: Leaguepedia Cargo ──
const LP = 'https://lol.fandom.com/api.php';
const LH = { 'User-Agent': 'LineReaper/4.0 (stack correlation fit; one pass)', Accept: 'application/json' };
const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function lol() {
  const rows = [];
  let t = SINCE;
  const end = Date.now();
  while (t < end && Date.now() < DEADLINE) {
    let off = 0, got;
    const t1 = t + 2 * 86400e3;
    do {
      const r = await get(LP, { headers: LH, params: { action: 'cargoquery', format: 'json', limit: '500', offset: String(off),
        tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG,MatchSchedule=MS', join_on: 'SP.GameId=SG.GameId,SG.MatchId=MS.MatchId',
        fields: 'SP.Link=Link,SP.Team=Team,SP.Kills=Kills,SP.Assists=Assists,SP.Role=Role,SG.GameId=GameId,SG.MatchId=MatchId,SG.N_GameInMatch=GameN,SG.DateTime_UTC=DateTime,SG.Gamelength_Number=Len,SG.WinTeam=Win,SG.Team1=T1,SG.Team2=T2,SG.Team1Kills=K1,SG.Team2Kills=K2,MS.BestOf=BestOf,SG.Tournament=Tour',
        where: `SG.DateTime_UTC >= '${iso(t)}' AND SG.DateTime_UTC < '${iso(t1)}'`, order_by: 'SG.DateTime_UTC ASC' } });
      if (r?.data?.error) { log('lol err', JSON.stringify(r.data.error).slice(0, 200)); await wait(20000); got = []; break; }
      got = (r?.data?.cargoquery || []).map(x => x.title);
      rows.push(...got);
      off += 500;
      await wait(3500);
    } while (got.length === 500);
    t = t1;
    if (rows.length && rows.length % 5000 < 500) save('lol', rows);
  }
  log('lol rows', rows.length);
  save('lol', rows);
}

(async () => {
  const which = (process.env.GAMES || 'cs,dota,val,lol').split(',');
  const jobs = { cs, dota, val, lol };
  await Promise.all(which.map(w => jobs[w]().catch(e => log(w, 'failed', e.message))));
  log('done');
})();
