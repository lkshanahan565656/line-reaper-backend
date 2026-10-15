// NBA end to end on live feeds: (1) each source read directly (Pinnacle NBA and
// preseason leagues, FanDuel event pages and tabs, BetRivers, Action Network),
// (2) grading on finished NBA games from ESPN (every stat the apps post vs the
// box score, and the real grader on legs built from those games), (3) this
// branch's server ~RUNMIN min: NBA legs per app, sharp-priced, clearing, plus
// PROPS renders.
const fs = require('fs'); const { spawn } = require('child_process'); const axios = require('axios');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const pb = require('../propsboard'); const sg = require('../sportgrade'); const pin = require('../pinprops'); const fb = require('../freebooks'); const xb = require('../xbooks');
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
const tally = (list, key) => { const m = {}; for (const x of list) { const k = key(x); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
async function board(base) { const rows = []; for (let off = 0; off < 40000; off += 500) { const d = await get(`${base}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const t0 = Date.now();
  say(`NBA end to end, started ${new Date().toISOString()}`);
  // ── 1. sources, read directly
  const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
  for (const [name, id] of [['NBA', 487], ['NBA Preseason', 5270], ['NCAA basketball', 493]]) {
    try {
      const [mu, mk] = await Promise.all([axios.get(`${PIN}/leagues/${id}/matchups`, { timeout: 30000 }), axios.get(`${PIN}/leagues/${id}/markets/straight`, { timeout: 30000 })]);
      const games = mu.data.filter(m => m.type === 'matchup' && !m.parentId);
      const specials = mu.data.filter(m => m.type === 'special');
      const props = pin.parseLeague('NBA', mu.data, mk.data);
      const raw = specials.filter(m => /player props/i.test(m.special?.category || ''));
      say(`\nPinnacle ${name} (${id}): ${games.length} games, ${specials.length} specials, ${raw.length} player props, ${props.length} priced and parsed`);
      say('  games: ' + games.map(g => `${g.startTime.slice(5, 16)} ${(g.participants || []).map(p => p.name).join(' v ')}`).slice(0, 14).join(' | '));
      say('  prop stats: ' + tally(raw, m => m.special.description.replace(/^.+? Total /, '')).map(x => x.join(':')).join(', '));
      say('  unparsed: ' + raw.filter(m => !pin.parseDescription(m.special.description)).map(m => m.special.description).slice(0, 5).join(' | '));
      say('  parsed by stat/day: ' + tally(props, p => `${p.mkey} ${p.start.slice(5, 10)}`).map(x => x.join(':')).join(', '));
    } catch (e) { say(`Pinnacle ${name}: ${e.response?.status || e.message}`); }
  }
  // FanDuel: league page, then each upcoming game's event page and every tab
  try {
    const page = (await axios.get(fb.FD_URL('nba'), { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 })).data;
    const games = fb.parseFanDuel(page);
    say(`\nFanDuel NBA: ${games.length} games on the league page: ` + games.map(g => `${g.start.slice(5, 16)} ${g.away} @ ${g.home}`).slice(0, 14).join(' | '));
    const lp = fb.parseFanDuelLadders(page);
    say(`  league page: ${lp.ladders.length} rungs ${JSON.stringify(tally(lp.ladders, l => l.mkey))}`);
    for (const g of games.slice(0, 6)) {
      const tot = { props: 0, ladders: 0 }, types = new Set(); const perTab = [];
      for (const tab of fb.LEAGUES.nba.fdTabs.concat(['player-specials', 'popular'])) {
        const r = await axios.get(fb.FD_EVENT_URL(g.eventId, tab), { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }).then(x => x.data).catch(e => ({ error: e.response?.status || e.message }));
        if (r.error) { perTab.push(`${tab || '(default)'}: ${r.error}`); continue; }
        const mks = Object.values(r.attachments?.markets || {}); mks.forEach(m => types.add(m.marketType));
        const pr = fb.parseFanDuelProps(r), l = fb.parseFanDuelLadders(r); tot.props += pr.length; tot.ladders += l.ladders.length;
        perTab.push(`${tab || '(default)'}: ${mks.length} mkts, ${pr.length} props, ${l.ladders.length} rungs`);
      }
      say(`  event ${g.eventId} ${g.away} @ ${g.home} ${g.start}: props ${tot.props}, rungs ${tot.ladders}; ${perTab.join(' | ')}`);
      say(`    market types: ${[...types].filter(t => !/^NBA_|^TO_MAKE|SEED|DIVISION/.test(t)).slice(0, 60).join(', ')}`);
    }
  } catch (e) { say('FanDuel NBA: ' + (e.response?.status || e.message)); }
  // BetRivers (Kambi)
  try {
    const list = (await axios.get(`${fb.KAMBI}/listView/basketball/nba/all/all/matches.json?lang=en_US&market=US`, { timeout: 30000 })).data;
    const ids = fb.kambiEventIds(list);
    say(`\nBetRivers NBA: ${ids.length} events`);
    for (const id of ids.slice(0, 6)) {
      const d = (await axios.get(`${fb.KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`, { timeout: 30000 })).data;
      const g = fb.parseKambiEvent(d); const kp = fb.kambiProps(d), kl = fb.kambiLadders(d);
      say(`  ${id} ${g ? `${g.away} @ ${g.home} ${g.start}` : '(no game)'}: props ${kp.length} ${JSON.stringify(tally(kp, p => p.mkey).slice(0, 12))}, rungs ${kl.length}`);
    }
  } catch (e) { say('BetRivers NBA: ' + (e.response?.status || e.message)); }
  // Action Network books
  try {
    let n = 0;
    for (const url of xb.actionUrls('nba')) {
      const d = (await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 })).data;
      const gs = xb.parseAction(d, { props: xb.AN_PROPS.nba, now: Date.now() - 6 * 3600e3 });
      const raw = (d.games || []).map(g => `${g.start_time.slice(5, 16)} ${(g.teams || []).map(t => t.abbr).join('/')}`);
      say(`\nAction Network ${url.match(/date=(\d+)/)[1]}: ${(d.games || []).length} games (${raw.slice(0, 8).join(', ')}); book-games ${gs.length}; props by book ${JSON.stringify(Object.fromEntries(tally(gs.filter(g => g.props.length), g => g.book).map(([k]) => [k, gs.filter(g => g.book === k).reduce((a, g) => a + g.props.length, 0)])))}`);
      n += gs.length;
    }
  } catch (e) { say('Action NBA: ' + (e.response?.status || e.message)); }
  // ── 2. grading on finished NBA games (preseason from the last days)
  say('\n== GRADING: finished NBA games, last 6 days');
  const grader = sg.createSportsGrader({ http: axios });
  const markets = ['points', 'rebounds', 'assists', 'threes', 'steals', 'blocks', 'turnovers', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts', 'stocks', 'ftm', 'off_rebounds', 'def_rebounds', 'fgm', 'fga', 'threes_att', 'fta', 'fouls', 'double_double', 'triple_double'];
  let games = 0, players = 0, graded = 0, dnp = 0, mismatches = [], ok = 0, bad = 0; const nullBy = {}; const samples = [];
  for (let d = 0; d < 6; d++) {
    const day = ymd(Date.now() - d * 86400e3);
    const sb = await get(`${ESPN}/scoreboard?dates=${day}`);
    for (const ev of (sb.events || []).filter(e => e.status?.type?.completed)) {
      games++;
      const sum = await get(`${ESPN}/summary?event=${ev.id}`);
      const box = sg.parseBox(sum.boxscore);
      const rawCount = (sum.boxscore?.players || []).reduce((a, t) => a + (t.statistics || []).reduce((b, g) => b + (g.athletes || []).length, 0), 0);
      players += box.size; dnp += Math.max(0, rawCount - box.size);
      const comp = ev.competitions[0].competitors; const home = comp.find(c => c.homeAway === 'home')?.team?.displayName, away = comp.find(c => c.homeAway === 'away')?.team?.displayName;
      let line = `${day} ${away} @ ${home}: ${box.size} players with a line (${rawCount - box.size} DNP/no stats)`;
      const first = [...box.values()].sort((a, b) => Number(b.groups.basketball?.points) - Number(a.groups.basketball?.points)).slice(0, 4);
      for (const p of box.values()) {
        const g = p.groups; const b = g.basketball || {};
        // independent read of the same box
        const pts = +b.points, reb = +b.rebounds, ast = +b.assists;
        const exp = { points: pts, rebounds: reb, assists: ast, pra: pts + reb + ast, pts_rebs: pts + reb, pts_asts: pts + ast, rebs_asts: reb + ast, steals: +b.steals, blocks: +b.blocks, stocks: +b.steals + +b.blocks, turnovers: +b.turnovers,
          threes: +String(b['threePointFieldGoalsMade-threePointFieldGoalsAttempted']).split('-')[0], fga: +String(b['fieldGoalsMade-fieldGoalsAttempted']).split('-')[1] };
        for (const m of markets) {
          const v = sg.statValue('NBA', m, g);
          if (v == null) { nullBy[m] = (nullBy[m] || 0) + 1; continue; }
          if (m in exp) { if (v === exp[m]) ok++; else { bad++; if (mismatches.length < 8) mismatches.push(`${p.name} ${m}: ${v} vs ${exp[m]}`); } }
        }
      }
      // the real grader (scoreboard → event → box) on legs built from this game, titled like the apps do
      for (const p of first) {
        const team = p.team; const start = ev.date;
        for (const [mk, side, ln] of [['points', 'Over', +p.groups.basketball.points - 0.5], ['pra', 'Under', +p.groups.basketball.points + +p.groups.basketball.rebounds + +p.groups.basketball.assists + 0.5], ['double_double', 'Over', 0.5]]) {
          const g = await grader.grade({ sport: 'NBA', player: p.name, team, mkey: mk, signalSide: side, signalLine: ln, startTime: start, matchTitle: `${away} @ ${home}` });
          samples.push(g?.outcome ? `${p.name} ${mk} ${side} ${ln} → ${g.outcome} (${g.result})` : `${p.name} ${mk} → ${JSON.stringify(g)}`);
          if (g?.outcome) graded++;
        }
      }
      say(line);
    }
  }
  say(`games ${games}, players ${players}, box vs independent read: ${ok} equal, ${bad} different ${bad ? JSON.stringify(mismatches) : ''}`);
  say(`stats the box could not give (null): ${JSON.stringify(nullBy)}`);
  say(`real grader on legs built from the finished games: ${graded} graded of ${samples.length}`);
  samples.slice(0, 12).forEach(s => say('  ' + s));
  // prod's record: NBA legs
  const picks = []; for (const s of ['open', 'locked', 'graded', 'void']) picks.push(...((await get(`${P}/api/props/record/picks?status=${s}&limit=1000`)).picks || []));
  const nbaP = picks.filter(b => b.sport === 'NBA');
  say(`\nprod record: ${picks.length} legs, NBA ${nbaP.length}: ${JSON.stringify(tally(nbaP, b => `${b.status}/${b.kind}`))}`);
  // ── 3. branch server
  const runMin = +(process.env.RUNMIN || 14);
  while (Date.now() - t0 < runMin * 60e3) await wait(20e3);
  const br = await board(B), prod = await board(P);
  const cov = await get(B + '/api/props/coverage'); const st = await get(B + '/api/status');
  fs.writeFileSync('out/branch-board-nba.json', JSON.stringify(br.filter(r => r.sport === 'NBA'))); fs.writeFileSync('out/coverage.json', JSON.stringify(cov));
  say(`\n== BRANCH ${st.version} board ${br.length} rows at ${new Date().toISOString()}; freeBooks nba ${JSON.stringify(st.freeBooks?.counts?.nba)} errors ${JSON.stringify(st.freeBooks?.errors || []).slice(0, 400)}`);
  say('pinnacle props status: ' + JSON.stringify(st.pinnacleProps || st.pinnacle || null).slice(0, 400));
  for (const [label, rows] of [['PROD (before)', prod], ['BRANCH', br]]) {
    const nba = rows.filter(r => r.sport === 'NBA');
    say(`\n-- ${label}: NBA rows ${nba.length} (all NBA legs by app; sharp = Pinnacle or Kalshi price; clear = EV 2%+ on a sharp price)`);
    const legs = []; for (const r of nba) for (const [bk, c] of Object.entries(r.books || {})) legs.push({ r, bk, c, src: pb.legSource(r, c) });
    const byApp = {};
    for (const l of legs) { const a = (byApp[l.bk] ||= { legs: 0, sharp: 0, bookOnly: 0, clear: 0, never: 0 }); a.legs++; if (l.src === 'pinnacle' || l.src === 'kalshi') a.sharp++; else if (pb.noSharpMarket(l.r)) a.never++; if (l.c.ev && l.c.ev.ev >= 2 && (l.src === 'pinnacle' || l.src === 'kalshi')) a.clear++; }
    say('app          legs  sharp  clear2%  no-sharp-market'); for (const [k, a] of Object.entries(byApp)) say(`${k.padEnd(11)} ${String(a.legs).padStart(5)} ${String(a.sharp).padStart(6)} ${String(a.clear).padStart(8)} ${String(a.never).padStart(10)}`);
    say('by stat (legs/sharp): ' + tally(legs, l => `${l.r.mkey}`).map(([k, n]) => `${k} ${n}/${legs.filter(l => l.r.mkey === k && (l.src === 'pinnacle' || l.src === 'kalshi')).length}`).join(', '));
    say('by day (legs/sharp): ' + tally(legs, l => (l.r.startTime || '').slice(5, 10)).map(([k, n]) => `${k} ${n}/${legs.filter(l => (l.r.startTime || '').slice(5, 10) === k && (l.src === 'pinnacle' || l.src === 'kalshi')).length}`).join(', '));
    const unmapped = [...new Set(nba.map(r => r.mkey))].filter(k => !/season|per_game|triple_doubles/.test(k) && !sg.canGrade({ sport: 'NBA', mkey: k }));
    say('stats the grader cannot settle: ' + (unmapped.join(', ') || 'none'));
  }
  const nbaB = br.filter(r => r.sport === 'NBA');
  say('\n== BRANCH NBA examples with a sharp price');
  for (const r of nbaB.filter(r => Object.values(r.books).some(c => ['pinnacle', 'kalshi'].includes(pb.legSource(r, c)))).slice(0, 25)) say(`${r.player} ${r.market} [${r.mkey}] ${r.startTime} pin=${JSON.stringify(r.pinnacle || null)} ${Object.entries(r.books).map(([b, c]) => `${b} ${c.line} fair=${c.fair ?? '-'} ev=${c.ev ? c.ev.side + ' ' + c.ev.ev : '-'}`).join(' | ')}`);
  say('\ncoverage NBA: ' + JSON.stringify(cov.leagues?.NBA || cov.byLeague?.NBA || null));
  say('coverage CBB: ' + JSON.stringify(cov.leagues?.CBB || null));
  say('coverage NBA markets: ' + JSON.stringify((cov.markets || []).filter(m => m.sport === 'NBA').slice(0, 40)));
  const rec = await get(B + '/api/props/record'); say('branch record byKind: ' + JSON.stringify(Object.fromEntries(Object.entries(rec.byKind || {}).map(([k, v]) => [k, v.signals]))));
  const alt = await get(B + '/api/ev/alt'); say('alt lines summary: ' + JSON.stringify(alt.summary || alt.counts || Object.keys(alt)).slice(0, 600));
  // ── renders
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'PROPS'); if (t) t.click(); });
      await wait(5000);
      for (const [tag, setup] of [['lines', "pbState.sport='NBA';pbState.view='lines';pbState.lineBook='prizepicks'"], ['cards', "pbState.sport='NBA';pbState.view='cards';pbState.sort='start';pbState.show='all'"]]) {
        await page.evaluate(s => { eval(s); try { localStorage.setItem('lr_pb_view', pbState.view); } catch (e) {} loadPropsBoard(); }, setup);
        await wait(6000);
        await page.screenshot({ path: `out/nba-${tag}-${name}.png`, fullPage: false });
      }
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
