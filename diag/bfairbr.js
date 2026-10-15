// (1) Grading audit: every prod-recorded leg and every priced prod board leg by
// league and market → which results source settles it; the combined grader run
// for real on prod's locked/graded legs (graded ones compared with ESPN's
// earlier grade) and on legs built from finished tennis, UFC, NASCAR and
// soccer events. (2) This branch's server on live feeds: book-fair legs by
// league, both vs single, clearing at 2%+, plus PROPS renders.
const fs = require('fs'); const { spawn } = require('child_process'); const axios = require('axios');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const pb = require('../propsboard'); const xg = require('../extragrade'); const sg = require('../sportgrade');
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function board(base) { const rows = []; for (let off = 0; off < 40000; off += 500) { const d = await get(`${base}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
const tally = (list, key) => { const m = {}; for (const x of list) { const k = key(x); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const t0 = Date.now();
  const box = sg.createSportsGrader({ http: axios }), extra = xg.createExtraGrader({ http: axios });
  const G = xg.combineGraders(box, extra);
  if (!process.env.RENDER_ONLY) {
  // ── 1a. prod record
  const picks = []; for (const s of ['open', 'locked', 'graded', 'void']) picks.push(...((await get(`${P}/api/props/record/picks?status=${s}&limit=1000`)).picks || []));
  say(`prod record legs ${picks.length} at ${new Date().toISOString()}`);
  const src = b => (G.canGrade(b) ? G.sourceOf(b) : 'NONE');
  say('\n== RECORDED LEGS: will they grade? (sport | market | source: count)');
  for (const [k, n] of tally(picks, b => `${b.sport} | ${b.mkey} | ${src(b)}`).sort((a, b) => a[0].localeCompare(b[0]))) say(`${k.padEnd(52)} ${n}`);
  say('\n== RECORDED LEGS BY SPORT: gradeable / total');
  for (const [s] of tally(picks, b => b.sport)) { const l = picks.filter(b => b.sport === s); say(`${s.padEnd(12)} ${l.filter(G.canGrade).length} / ${l.length}`); }
  // regrade prod's graded legs and try its locked ones, for real
  let same = 0, diff = 0, miss = 0; const diffs = [];
  for (const b of picks.filter(b => b.status === 'graded')) { let g = null; try { g = await G.grade(b); } catch (e) { g = { error: e.message }; } if (g?.outcome === b.outcome) same++; else { diff++; diffs.push(`${b.sport} ${b.player} ${b.mkey} ${b.signalSide} ${b.signalLine}: prod ${b.outcome} ${b.result} vs now ${JSON.stringify(g)}`); } }
  say(`\nregrade of prod's ${same + diff} graded legs with the combined grader: same ${same}, different/missing ${diff}`); diffs.slice(0, 15).forEach(d => say('  ' + d));
  const locked = picks.filter(b => b.status === 'locked'); const lockRes = [];
  for (const b of locked) { let g; try { g = G.canGrade(b) ? await G.grade(b) : 'no source'; } catch (e) { g = { error: e.message }; } lockRes.push(`${b.sport} ${b.player} ${b.mkey} ${b.signalSide} ${b.signalLine} start ${b.start}: ${JSON.stringify(g)}`); }
  say(`\nprod locked legs (${locked.length}) graded now:`); lockRes.forEach(x => say('  ' + x));
  // ── 1b. prod board: priced legs in the new sports by market → source
  const prod = await board(P);
  fs.writeFileSync('out/prod-board.json', JSON.stringify(prod));
  say('\n== PROD BOARD sharp-priced legs (Pinnacle or Kalshi) in TENNIS, MMA, MOTORSPORTS, SOCCER, CFB, NHL: results source');
  const legs = [];
  for (const r of prod) for (const [bk, c] of Object.entries(r.books || {})) { const k = pb.legSource(r, c); legs.push({ r, c, k, sport: r.sport, mkey: r.mkey, line: c.line }); }
  const fake = x => ({ sport: x.sport, mkey: x.mkey, signalLine: x.line });
  for (const [k, n] of tally(legs.filter(x => (x.k === 'pinnacle' || x.k === 'kalshi') && /^(TENNIS|MMA|MOTORSPORTS|SOCCER|CFB|NHL|NFL|NBA|WNBA|MLB)$/.test(x.sport)), x => `${x.sport} | ${x.mkey} | ${G.canGrade(fake(x)) ? G.sourceOf(fake(x)) : 'NONE'}`).sort((a, b) => a[0].localeCompare(b[0]))) say(`${k.padEnd(52)} ${n}`);
  // ── 1c. grade legs built from finished events (does the live fetch path find them?)
  const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const y = Date.now() - 86400e3;
  let found = 0, tried = 0; const samp = [];
  for (const tour of ['tennis/atp', 'tennis/wta']) {
    const d = await get(`${ESPN}/${tour}/scoreboard?dates=${ymd(y)}`);
    const ms = xg.tennisMatches(d).filter(m => m.completed && Math.abs(Date.parse(m.date) - y) < 30 * 3600e3).slice(0, 15);
    for (const m of ms) { tried++; const g = await G.grade({ sport: 'TENNIS', mkey: 'games_played', player: m.players[0].name, signalSide: 'Over', signalLine: 21.5, startTime: new Date(Date.parse(m.date) + 20 * 60e3).toISOString() }); if (g?.outcome) found++; if (samp.length < 6) samp.push(`${m.players.map(p => p.name).join(' v ')} → ${JSON.stringify(g)}`); }
  }
  say(`\ntennis legs built from yesterday's finished matches: graded ${found} of ${tried}`); samp.forEach(s => say('  ' + s));
  found = 0; tried = 0; samp.length = 0;
  const u = await get(`${ESPN}/mma/ufc/scoreboard?dates=20261010`);
  for (const bt of xg.ufcBouts(u)) for (const f of bt.fighters) for (const mk of ['fight_time', 'finishes', '1st_round_finish', 'knockouts', 'submissions']) {
    tried++; const g = await G.grade({ sport: 'MMA', mkey: mk, player: f.name, signalSide: 'Over', signalLine: mk === 'fight_time' ? 7.5 : 0.5, startTime: bt.date });
    if (g?.outcome) found++; if (samp.length < 12 && (mk === 'fight_time' || mk === 'knockouts')) samp.push(`${f.name} ${mk} → ${JSON.stringify(g)}`);
  }
  say(`UFC legs (10-10 card, five markets per fighter): graded ${found} of ${tried} (Kalshi lists only some cards' method markets)`); samp.forEach(s => say('  ' + s));
  found = 0; tried = 0; samp.length = 0;
  for (const top of [3, 5, 10, 20]) for (const dr of ['Denny Hamlin', 'Joey Logano', 'Kyle Larson', 'Chase Elliott', 'Ross Chastain']) { tried++; const g = await G.grade({ sport: 'MOTORSPORTS', mkey: 'finishing_position', player: dr, signalSide: 'Under', signalLine: top + 0.5, startTime: '2026-10-11T18:00:00Z' }); if (g?.outcome) found++; if (samp.length < 6) samp.push(`${dr} top ${top} → ${JSON.stringify(g)}`); }
  say(`NASCAR legs (10-11 race): graded ${found} of ${tried}`); samp.forEach(s => say('  ' + s));
  found = 0; tried = 0; samp.length = 0;
  for (const pl of ['Sven Botman', 'Harvey Barnes', 'Mohamed Salah', 'Erling Haaland', 'Bukayo Saka']) for (const st of ['2026-10-11T14:00:00Z', '2026-10-12T19:00:00Z', '2026-10-11T16:30:00Z']) { tried++; const g = await G.grade({ sport: 'SOCCER', mkey: 'goals', player: pl, signalSide: 'Over', signalLine: 0.5, startTime: st }); if (g?.outcome) { found++; samp.push(`${pl} ${st} → ${JSON.stringify(g)}`); } }
  say(`soccer goal legs (players x weekend kickoffs, most combos are no match): graded ${found} of ${tried}`); samp.forEach(s => say('  ' + s));
  }
  // ── 2. branch server
  const runMin = +(process.env.RUNMIN || 22);
  while (Date.now() - t0 < runMin * 60e3) await wait(20e3);
  const br = await board(B); const cov = await get(B + '/api/props/coverage'); const st = await get(B + '/api/status');
  fs.writeFileSync('out/branch-board.json', JSON.stringify(br)); fs.writeFileSync('out/coverage.json', JSON.stringify(cov));
  say(`\n== BRANCH ${st.version} board ${br.length} rows at ${new Date().toISOString()}`);
  const L = {};
  for (const r of br) for (const [bk, c] of Object.entries(r.books || {})) { const a = (L[r.sport] ||= { legs: 0, sharp: 0, both: 0, single: 0, clear2: 0, clear2single: 0 }); a.legs++; const k = pb.legSource(r, c); if (k === 'pinnacle' || k === 'kalshi') a.sharp++; if (c.ev?.bookFair) { a[c.ev.bookFair]++; if (c.ev.ev >= 2) a[c.ev.bookFair === 'both' ? 'clear2' : 'clear2single']++; } }
  say('league       legs   sharp  bookfair-both  bookfair-single  clear2%(both)  clear2%(single)');
  for (const [k, a] of Object.entries(L).sort((x, y) => y[1].legs - x[1].legs)) say(`${k.padEnd(12)} ${String(a.legs).padStart(5)} ${String(a.sharp).padStart(6)} ${String(a.both).padStart(13)} ${String(a.single).padStart(16)} ${String(a.clear2).padStart(13)} ${String(a.clear2single).padStart(16)}`);
  const cp = pb.coverage(prod), cb = pb.coverage(br);
  say(`sharp legs prod ${cp.total.sharp} / ${cp.total.legs}, branch ${cb.total.sharp} / ${cb.total.legs}; branch bookFair legs ${cb.total.bookFair}`);
  say('\n== BOOK-FAIR EXAMPLES (clearing first)');
  const ex = []; for (const r of br) for (const [bk, c] of Object.entries(r.books || {})) if (c.ev?.bookFair) ex.push({ r, bk, c });
  ex.sort((a, b) => b.c.ev.ev - a.c.ev.ev);
  for (const { r, bk, c } of ex.slice(0, 25)) say(`${r.sport} ${r.player} ${r.market} ${bk} ${c.ev.side} ${c.line} ev ${c.ev.ev} fair ${c.ev.fair} [${c.ev.bookFair}] books ${(r.bookFair?.sources || []).map(s => `${s.book} ${s.line} ${s.p}%`).join(', ')} start ${r.startTime}`);
  const rec = await get(B + '/api/props/record');
  say('\nbranch record byKind: ' + JSON.stringify(Object.fromEntries(Object.entries(rec.byKind || {}).map(([k, v]) => [k, v.signals]))));
  say('branch headline signals ' + rec.overall?.signals);
  const sb = await get(B + '/api/ev/scoreboard');
  say('scoreboard byKind props-book-fair*: ' + JSON.stringify(Object.fromEntries(Object.entries(sb.byKind || {}).filter(([k]) => /book-fair/.test(k)).map(([k, v]) => [k, { label: v.kindLabel, recorded: v.recorded, mark: v.mark }]))));
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
      for (const [tag, setup] of [['cfb-lines', "pbState.sport='CFB';pbState.view='lines';pbState.lineBook='prizepicks'"], ['nhl-lines', "pbState.sport='NHL';pbState.view='lines';pbState.lineBook='underdog'"], ['cfb-cards', "pbState.sport='CFB';pbState.view='cards';pbState.sort='ev';pbState.show='priced'"]]) {
        await page.evaluate(s => { eval(s); try { localStorage.setItem('lr_pb_view', pbState.view); } catch (e) {} loadPropsBoard(); }, setup);
        await wait(6000);
        await page.screenshot({ path: `out/bfair-${tag}-${name}.png`, fullPage: false });
      }
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
