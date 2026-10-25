// Live MLB board and record from the site, plus MLB postseason box scores
// (MLB Stats API and ESPN) for grading the recorded playoff boards.
const fs = require('fs');
const U = 'https://line-reaper-backend-production.up.railway.app';
const j = async (url) => { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }); if (!r.ok) return { _err: r.status }; return await r.json(); } catch (e) { return { _err: String(e.message) }; } };
const w = (f, o) => fs.writeFileSync('out/' + f, JSON.stringify(o));
(async () => {
  fs.mkdirSync('out', { recursive: true });
  w('status.json', await j(U + '/api/status'));
  w('board-mlb.json', await j(U + '/api/props/board?sport=MLB&limit=5000'));
  w('record.json', await j(U + '/api/props/record'));
  const picks = [];
  for (const st of ['graded', 'locked']) {
    let before = '';
    for (let i = 0; i < 40; i++) {
      const r = await j(`${U}/api/props/record/picks?status=${st}&limit=1000${before ? '&before=' + encodeURIComponent(before) : ''}`);
      const l = r.picks || [];
      picks.push(...l);
      if (l.length < 1000) break;
      before = l[l.length - 1].signalAt;
    }
  }
  w('picks-mlb.json', picks.filter(p => p.sport === 'MLB'));
  w('picks-count.json', { all: picks.length, mlb: picks.filter(p => p.sport === 'MLB').length });
  // postseason schedule and box scores
  const sch = await j('https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-09-28&endDate=2026-10-25&gameType=F,D,L,W');
  const games = (sch.dates || []).flatMap(d => d.games || []);
  const boxes = {};
  for (const g of games) {
    if (g.status?.abstractGameState !== 'Final') continue;
    const b = await j(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const players = [];
    for (const side of ['home', 'away']) for (const p of Object.values(b.teams?.[side]?.players || {})) {
      const bat = p.stats?.batting || {}, pit = p.stats?.pitching || {};
      if (!Object.keys(bat).length && !Object.keys(pit).length) continue;
      players.push({ name: p.person?.fullName, team: b.teams[side].team?.name, bat, pit });
    }
    boxes[g.gamePk] = { gamePk: g.gamePk, date: g.gameDate, type: g.gameType, home: g.teams.home.team.name, away: g.teams.away.team.name, players };
  }
  w('mlb-boxes.json', { games: games.map(g => ({ gamePk: g.gamePk, date: g.gameDate, type: g.gameType, status: g.status?.detailedState, home: g.teams.home.team.name, away: g.teams.away.team.name })), boxes });
  // ESPN for the same window (second source)
  const espn = {};
  for (let t = Date.parse('2026-09-28'); t <= Date.parse('2026-10-25'); t += 86400e3) {
    const d = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    const sb = await j(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${d}`);
    for (const ev of sb.events || []) {
      if (!ev.status?.type?.completed) continue;
      const s = await j(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${ev.id}`);
      espn[ev.id] = { date: ev.date, name: ev.name, players: s.boxscore?.players || [] };
    }
  }
  w('espn-boxes.json', espn);
  // Pinnacle MLB right now (guest feed), to see whether Game 3 props are up
  
  const h = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.pinnacle.com/', Origin: 'https://www.pinnacle.com' };
  const get = async u => { try { const r = await fetch(u, { headers: h }); return r.ok ? r.json() : { _err: r.status }; } catch (e) { return { _err: e.message }; } };
  w('pin-mlb.json', { matchups: await get('https://guest.api.arcadia.pinnacle.com/0.1/leagues/246/matchups'), markets: await get('https://guest.api.arcadia.pinnacle.com/0.1/leagues/246/markets/straight') });
})();
