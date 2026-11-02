// LoL fallback: player stats when the main LoL source is down
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.esPicksRebuild is defined further down server.js: called, never copied
const {
  axios, createOEAggregator, fetchGolPlayers, golSeason, lolStats, nameKey,
  oeCandidateUrls, parseCsvLine
} = ctx;

const LP_API = 'https://lol.fandom.com/api.php';

async function lpFetchPage(sinceDate, offset, limit = 500) {
  const params = {
    action: 'cargoquery', format: 'json', limit: String(limit), offset: String(offset),
    tables: 'ScoreboardPlayers=SP,ScoreboardGames=SG',
    join_on: 'SP.GameId=SG.GameId',
    fields: 'SP.Link=Link,SP.Team=Team,SP.Kills=Kills,SP.Assists=Assists,SP.GameId=GameId,SG.DateTime_UTC=DateTime',
    where: `SG.DateTime_UTC >= '${sinceDate}'`,
    order_by: 'SG.DateTime_UTC DESC',
  };
  const res = await axios.get(LP_API, { params, timeout: 30000,
    headers: { 'User-Agent': 'LineReaper/3.5 (personal analytics)', 'Accept': 'application/json' } });
  if (res.data?.error) throw new Error('Cargo error: ' + JSON.stringify(res.data.error).slice(0, 200));
  return (res.data?.cargoquery || []).map(r => r.title || r);
}

// Pure aggregator — same output shape as the OE one, unit-tested offline.
function aggregateLPRows(rows) {
  const players = {}, teams = {}, games = {};
  for (const r of rows) {
    const name = (r.Link || '').trim();
    const team = (r.Team || '').trim();
    const gid = r.GameId || '';
    const k = parseFloat(r.Kills) || 0;
    const a = parseFloat(r.Assists) || 0;
    if (!name || !team || !gid) continue;
    const key = name.toLowerCase();
    const P = players[key] || (players[key] = { name, team: '', games: 0, kills: 0, assists: 0, league: 'LP' });
    P.games++; P.kills += k; P.assists += a; P.team = team;
    const G = games[gid] || (games[gid] = {});
    const T = G[team] || (G[team] = { kills: 0, assists: 0 });
    T.kills += k; T.assists += a;
  }
  // team per-game aggregates + kills allowed from the opposing side
  for (const G of Object.values(games)) {
    const sides = Object.entries(G);
    if (sides.length !== 2) continue;
    for (let i = 0; i < 2; i++) {
      const [name, own] = sides[i], [, opp] = sides[1 - i];
      const tk = name.toLowerCase();
      const T = teams[tk] || (teams[tk] = { name, games: 0, kills: 0, assists: 0, killsAllowed: 0 });
      T.games++; T.kills += own.kills; T.assists += own.assists; T.killsAllowed += opp.kills;
    }
  }
  for (const p of Object.values(players)) {
    p.kpg = p.games ? p.kills / p.games : 0;
    p.apg = p.games ? p.assists / p.games : 0;
    const T = teams[(p.team || '').toLowerCase()];
    p.teamKpg = T && T.games ? T.kills / T.games : null;
    p.teamApg = T && T.games ? T.assists / T.games : null;
    p.oppKillsAllowedPg = T && T.games ? T.killsAllowed / T.games : null;
    p.killShare = p.teamKpg ? p.kpg / p.teamKpg : null;
    p.assistShare = p.teamApg ? p.apg / p.teamApg : null;
  }
  for (const t of Object.values(teams)) {
    t.kpg = t.games ? t.kills / t.games : 0;
    t.kapg = t.games ? t.killsAllowed / t.games : 0;
  }
  return { players, teams, games: Object.keys(games).length };
}

async function refreshLoLFromLeaguepedia(windowDays = 120) {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (let page = 0; page < 24; page++) {          // up to 12k rows
    const batch = await lpFetchPage(since, page * 500);
    rows.push(...batch);
    if (batch.length < 500) break;
    await new Promise(r => setTimeout(r, 250));    // be polite to the wiki
  }
  if (!rows.length) throw new Error('no rows returned');
  const out = aggregateLPRows(rows);
  Object.assign(lolStats, out, { updated: new Date().toISOString(), state: 'ready', lastError: null, source: 'leaguepedia' });
  console.log(`Leaguepedia: ${rows.length} scoreboard rows → ${Object.keys(out.players).length} players, ${Object.keys(out.teams).length} teams, ${out.games} games (last ${windowDays}d)`);
  ctx.esPicksRebuild().catch(() => {});
}

// gol.gg's season table: every pro's games and per-game kills/assists on one
// page. Tried first now that Oracle's Elixir is gone and Leaguepedia
// rate-limits datacenter IPs.
async function refreshLoLFromGol() {
  const rows = await fetchGolPlayers(axios);
  const players = {};
  for (const r of Object.values(rows)) players[r.name.toLowerCase()] = { kpg: r.kpg, apg: r.apg, dpg: r.dpg, kp: r.kp, games: r.games };
  Object.assign(lolStats, { players, teams: {}, games: Object.values(rows).reduce((a, r) => a + r.games, 0) / 5 | 0, updated: new Date().toISOString(), state: 'ready', lastError: null, source: 'gol.gg' });
  console.log(`gol.gg: ${Object.keys(players).length} LoL players (${golSeason()})`);
  ctx.esPicksRebuild().catch(() => {});
}

async function refreshLoLStats(windowDays = 120) {
  if (lolStats.state === 'downloading') return;
  lolStats.state = 'downloading';
  const errors = [];
  try { await refreshLoLFromGol(); return; } catch (e) { errors.push(`gol.gg → ${e.response?.status || e.message}`); }
  for (const url of await oeCandidateUrls()) {
    try {
      console.log('OE: downloading', url.slice(0, 90), '...');
      const res = await axios.get(url, { responseType: 'stream', timeout: 180000, maxRedirects: 5 });
      const sinceMs = Date.now() - windowDays * 86400000;
      let agg = null, carry = '', bytes = 0;
      await new Promise((resolve, reject) => {
        res.data.on('data', chunk => {
          bytes += chunk.length;
          carry += chunk.toString('utf8');
          let idx;
          while ((idx = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, idx).replace(/\r$/, '');
            carry = carry.slice(idx + 1);
            if (!agg) agg = createOEAggregator(parseCsvLine(line), sinceMs);
            else if (line) agg.push(parseCsvLine(line));
          }
        });
        res.data.on('end', resolve);
        res.data.on('error', reject);
      });
      if (carry.trim() && agg) agg.push(parseCsvLine(carry));
      if (!agg) throw new Error('empty CSV');
      const out = agg.finish();
      Object.assign(lolStats, out, { updated: new Date().toISOString(), state: 'ready', lastError: null });
      console.log(`OE: ${(bytes / 1048576).toFixed(1)}MB → ${Object.keys(out.players).length} players, ${Object.keys(out.teams).length} teams, ${out.games} games (last ${windowDays}d)`);
      ctx.esPicksRebuild().catch(() => {});
      return;
    } catch (e) {
      const s = e.response?.status;
      errors.push(`${url.split('/').pop().slice(0, 40)} → ${s || e.message}`);
      console.warn('OE attempt failed:', s || e.message);
    }
  }
  console.warn('OE: all URL candidates failed —', errors.join(' | '), '· falling back to Leaguepedia');
  try {
    await refreshLoLFromLeaguepedia(windowDays);
    return;
  } catch (e2) {
    lolStats.state = 'error';
    lolStats.lastError = `OE: ${errors.join(' | ')} · Leaguepedia: ${e2.message}`;
    console.warn('Leaguepedia fallback also failed:', e2.message,
      '· inspect /api/esports/probe/lolsource for the raw response. Auto-retrying every 30 min.');
  }
}

// Lifetime rate blended with kill-share formulation:
//   half player's own kills/game, half (share of team kills × team pace).
// Identical today, but the share half becomes opponent-aware once lines
// carry match context (then team pace blends with opponent kills-allowed).
function lolPlayer(playerName) {
  const p = lolStats.players[(playerName || '').toLowerCase()];
  if (p) return p;
  const key = nameKey(playerName);
  if (!key) return null;
  const hit = Object.keys(lolStats.players).find(k => nameKey(k) === key);
  return hit ? lolStats.players[hit] : null;
}
function predictLoLStat(playerName, mapCount, stat = 'kills') {
  const p = lolPlayer(playerName);
  if (!p || !p.games || p.games < 4) return null;
  let perGame, share, teamPg;
  if (stat === 'assists') { perGame = p.apg; share = p.assistShare; teamPg = p.teamApg; }
  else { perGame = p.kpg; share = p.killShare; teamPg = p.teamKpg; }
  if (!perGame) return null;
  if (share && teamPg) perGame = 0.5 * perGame + 0.5 * (share * teamPg);
  return perGame * (mapCount || 1);
}
function predictLoLKills(playerName, mapCount) { return predictLoLStat(playerName, mapCount, 'kills'); }


return {
  lpFetchPage, aggregateLPRows, refreshLoLFromLeaguepedia, refreshLoLStats, lolPlayer,
  predictLoLStat, predictLoLKills
};
};
