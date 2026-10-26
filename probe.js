// CBB readiness probe: what each source posts for men's college basketball now,
// and real ESPN box scores from last season's opening days for an offline dry run.
const fs = require('fs');
const zlib = require('zlib');
const OUT = 'out';
const LIVE = 'https://line-reaper-backend-production.up.railway.app';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (f, d) => fs.writeFileSync(`${OUT}/${f}`, typeof d === 'string' ? d : JSON.stringify(d));
const saveGz = (f, d) => fs.writeFileSync(`${OUT}/${f}.gz`, zlib.gzipSync(typeof d === 'string' ? d : JSON.stringify(d)));
async function get(url, headers = UA) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, headers: Object.fromEntries(r.headers) };
}
const R = {};
async function step(name, fn) { try { R[name] = await fn(); } catch (e) { R[name] = { error: e.message }; } console.log(name, JSON.stringify(R[name]).slice(0, 1500)); }

(async () => {
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
  // 1. ESPN scoreboards: groups on vs off, last season's opener, this season's
  await step('espn_boards', async () => {
    const o = {};
    for (const [d, q] of [['20251103', ''], ['20251103', '&groups=50&limit=500'], ['20251104', ''], ['20251104', '&groups=50&limit=500'],
      ['20261103', ''], ['20261103', '&groups=50&limit=500'], ['20261025', '&groups=50&limit=500'], ['20261027', '&groups=50&limit=500'], ['20261030', '&groups=50&limit=500'],
      ['20251122', ''], ['20251122', '&groups=50&limit=500'], ['20251122', '&groups=50']]) {
      const r = await get(`${ESPN}/scoreboard?dates=${d}${q}`);
      const ev = r.json?.events || [];
      o[`${d}${q}`] = { status: r.status, events: ev.length, done: ev.filter(e => e.status?.type?.completed).length,
        withOdds: ev.filter(e => (e.competitions?.[0]?.odds || []).length).length, stype: [...new Set(ev.map(e => e.season?.type))],
        late: ev.filter(e => { const h = new Date(e.date).getUTCHours(); return h >= 4 && h < 10; }).map(e => `${e.date} ${e.shortName}`).slice(0, 8),
        sample: ev.slice(0, 3).map(e => ({ id: e.id, date: e.date, name: e.shortName, teams: e.competitions?.[0]?.competitors?.map(c => [c.team?.abbreviation, c.team?.displayName, c.team?.shortDisplayName, c.team?.location, c.team?.name]) })) };
      if (q.includes('groups=50&limit=500') && (d === '20251103' || d === '20261103')) saveGz(`espn-board-${d}.json`, r.json);
      await sleep(300);
    }
    return o;
  });
  // 2. ESPN summaries from last season's opening day for the dry run: 12 finished games
  await step('espn_summaries', async () => {
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${OUT}/espn-board-20251103.json.gz`)));
    const ids = (b.events || []).filter(e => e.status?.type?.completed).slice(0, 12).map(e => e.id);
    const got = [];
    for (const id of ids) {
      const r = await get(`${ESPN}/summary?event=${id}`);
      if (r.json) { saveGz(`espn-summary-${id}.json`, { boxscore: r.json.boxscore, header: r.json.header, pickcenter: r.json.pickcenter }); got.push({ id, players: (r.json.boxscore?.players || []).map(t => (t.statistics?.[0]?.athletes || []).length), keys: r.json.boxscore?.players?.[0]?.statistics?.[0]?.keys }); }
      await sleep(300);
    }
    return got;
  });
  // 3. Pinnacle: basketball leagues, NCAA league 493 matchups and markets
  await step('pinnacle', async () => {
    const P = 'https://guest.api.arcadia.pinnacle.com/0.1';
    const H = UA;
    const lg = await get(`${P}/sports/4/leagues?all=false`, H);
    const ncaa = (lg.json || []).filter(l => /ncaa|college/i.test(l.name)).map(l => ({ id: l.id, name: l.name, matchupCount: l.matchupCount }));
    const mu = await get(`${P}/leagues/493/matchups`, H);
    const mk = await get(`${P}/leagues/493/markets/straight`, H);
    saveGz('pin-493-matchups.json', mu.json); saveGz('pin-493-markets.json', mk.json);
    const m = Array.isArray(mu.json) ? mu.json : [];
    return { leaguesStatus: lg.status, ncaa, matchupsStatus: mu.status, matchups: m.length, types: m.reduce((a, x) => { const k = `${x.type}|${x.special?.category || ''}`; a[k] = (a[k] || 0) + 1; return a; }, {}),
      games: m.filter(x => x.type === 'matchup').slice(0, 8).map(x => `${x.startTime} ${(x.participants || []).map(p => p.name).join(' v ')}`),
      firstStart: m.filter(x => x.type === 'matchup').map(x => x.startTime).sort()[0] || null,
      props: m.filter(x => /player props/i.test(x.special?.category || '')).slice(0, 10).map(x => x.special?.description), markets: Array.isArray(mk.json) ? mk.json.length : mk.status };
  });
  // 4. Kalshi: every series naming men's college basketball, and open events in each
  await step('kalshi', async () => {
    const K = 'https://api.elections.kalshi.com/trade-api/v2';
    const s = await get(`${K}/series?category=Sports`);
    const all = (s.json?.series || []).map(x => x.ticker);
    const cbb = (s.json?.series || []).filter(x => /NCAAMB|NCAAB|CBB|MARMAD|NCAAM/i.test(x.ticker) || /college basketball|ncaa.*basketball|men's college/i.test(x.title || '')).map(x => ({ t: x.ticker, title: x.title }));
    const ev = {};
    for (const c of cbb.slice(0, 40)) {
      const r = await get(`${K}/events?series_ticker=${c.t}&status=open&limit=200`);
      ev[c.t] = { status: r.status, events: (r.json?.events || []).length, sample: (r.json?.events || []).slice(0, 2).map(e => `${e.event_ticker} ${e.title}`) };
      await sleep(250);
    }
    return { status: s.status, series: all.length, nbaPropSeries: all.filter(t => /^KXNBA(PTS|REB|AST)/.test(t)), cbb, ev };
  });
  // 5. PrizePicks: leagues list, then one league read of CBB if it exists (two requests total)
  await step('prizepicks', async () => {
    const PP = { ...UA, Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
    const l = await get('https://partner-api.prizepicks.com/leagues', PP);
    const leagues = (l.json?.data || []).map(x => ({ id: x.id, name: x.attributes?.name, active: x.attributes?.active, count: x.attributes?.projections_count, parent: x.attributes?.parent_name }));
    save('pp-leagues.json', leagues);
    const cbb = leagues.filter(x => /CBB|NCAAB|NCAAM|COLLEGE.?B/i.test(x.name || ''));
    let read = null;
    if (cbb[0]) {
      await sleep(6000);
      const r = await get(`https://partner-api.prizepicks.com/projections?league_id=${cbb[0].id}&per_page=1000&single_stat=true`, PP);
      const d = r.json?.data || [];
      const players = (r.json?.included || []).filter(x => x.type === 'new_player').slice(0, 10).map(x => ({ n: x.attributes?.display_name, team: x.attributes?.team, league: x.attributes?.league }));
      read = { status: r.status, projections: d.length, stats: [...new Set(d.map(x => x.attributes?.stat_type))].slice(0, 30), sample: d.slice(0, 5).map(x => x.attributes && { line: x.attributes.line_score, stat: x.attributes.stat_type, start: x.attributes.start_time, desc: x.attributes.description, odds: x.attributes.odds_type }), players };
      if (d.length) saveGz('pp-cbb.json', r.json);
    }
    return { status: l.status, leagues: leagues.length, basketball: leagues.filter(x => /B|NBA/i.test(x.name || '') && /BB|NBA|CB|NCAA|WNBA/i.test(x.name || '')), cbb, read };
  });
  // 6. Underdog: which sport ids carry lines, and whether CBB is there
  await step('underdog', async () => {
    const r = await get('https://api.underdogfantasy.com/v1/over_under_lines', { ...UA, 'x-api-key': 'undefined' });
    const d = r.json || {};
    const games = {}; for (const g of d.games || []) games[g.id] = g;
    const sp = {}; for (const g of d.games || []) sp[g.sport_id] = (sp[g.sport_id] || 0) + 1;
    const players = {}; for (const p of d.players || []) players[p.id] = p;
    const psp = {}; for (const p of d.players || []) psp[p.sport_id] = (psp[p.sport_id] || 0) + 1;
    const cbbPlayers = (d.players || []).filter(p => /CBB|NCAAB|NCAAM/i.test(p.sport_id || '')).slice(0, 5);
    const cbbGames = (d.games || []).filter(g => /CBB|NCAAB|NCAAM/i.test(g.sport_id || '')).slice(0, 5);
    const sampleNba = (d.players || []).find(p => p.sport_id === 'NBA');
    const sampleCfbGame = (d.games || []).find(g => g.sport_id === 'CFB');
    return { status: r.status, lines: (d.over_under_lines || []).length, gameSports: sp, playerSports: psp, cbbPlayers, cbbGames, sampleNbaPlayerKeys: sampleNba && Object.keys(sampleNba), sampleNba, sampleCfbGame };
  });
  // 7. Sleeper: sports on the lines feed, and the CBB player table
  await step('sleeper', async () => {
    const r = await get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control');
    const rows = Array.isArray(r.json) ? r.json : [];
    const sp = {}; for (const x of rows) sp[x.sport] = (sp[x.sport] || 0) + 1;
    const cbb = rows.filter(x => /cbb|ncaab|ncaam/i.test(x.sport || ''));
    const pl = await get('https://api.sleeper.app/players/cbb');
    const pj = pl.json && typeof pl.json === 'object' ? Object.values(pl.json) : [];
    const sched = await get('https://api.sleeper.com/schedule/cbb/regular/2026');
    return { status: r.status, rows: rows.length, sports: sp, cbbRows: cbb.length, cbbSample: cbb.slice(0, 3), playersStatus: pl.status, cbbPlayers: pj.length, cbbPlayerSample: pj.slice(0, 2), schedStatus: sched.status, schedRows: Array.isArray(sched.json) ? sched.json.length : null, schedSample: Array.isArray(sched.json) ? sched.json.slice(0, 2) : sched.text.slice(0, 200) };
  });
  // 8. Pick6: the sport pills (the repo's own decoder)
  await step('pick6', async () => {
    const P = require('./repo/pickem');
    const r = await fetch('https://pick6.draftkings.com/_root.data', { headers: { 'User-Agent': UA['User-Agent'], Accept: '*/*', Referer: 'https://pick6.draftkings.com/' } });
    const text = await r.text();
    const home = P.pick6Home(P.decodeTurboStream(text));
    return { status: r.status, sports: home ? P.pick6Sports(home) : null };
  });
  // 9. The live server's view
  await step('live', async () => {
    const o = {};
    for (const p of ['/api/status', '/api/props/cbbmodel?limit=5', '/api/ops']) {
      const r = await get(LIVE + p);
      o[p] = r.status;
      if (r.json) saveGz(`live-${p.replace(/\W+/g, '_')}.json`, r.json);
      if (p.startsWith('/api/status')) o.version = r.json?.version;
      if (p.startsWith('/api/props/cbbmodel')) o.cbb = { on: r.json?.on, label: r.json?.label, status: r.json?.status, count: r.json?.count, version: r.json?.version };
      if (p === '/api/ops') o.labels = { pp: r.json?.prizepicks?.leagues || r.json?.ppLeagueLabels, ud: r.json?.underdog?.sports };
    }
    return o;
  });
  save('report.json', R);
})();
