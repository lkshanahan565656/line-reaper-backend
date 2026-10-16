// Live check for the book-consensus lead and the proven labels: this branch's
// server on live feeds next to prod, the labels recomputed on prod's records,
// and PROPS / Track Record renders at phone and desktop width.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999', P = 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(180000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const pb = require('../propsboard'); const closeBoard = require('../closeboard'); const results = require('../results');
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function board(base) { const rows = []; for (let off = 0; off < 60000; off += 500) { const d = await get(`${base}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const t0 = Date.now();
  // ── 1. labels on prod's own records, before (prod) and after (this branch's rules)
  const ps = await get(`${P}/api/status`);
  say(`prod ${ps.version} at ${new Date().toISOString()}`);
  const prodBoard = await get(`${P}/api/ev/scoreboard`); fs.writeFileSync('out/prod-scoreboard.json', JSON.stringify(prodBoard));
  const lists = {};
  const bets = async q => (await get(`${P}/api/ev/record/bets?limit=500&${q}`)).bets || [];
  lists.ev = [...await bets('status=closed'), ...await bets('status=open')];
  lists.alt = [...await bets('alt=1&status=closed'), ...await bets('alt=1&status=open')];
  lists.stale = await bets('stale=1');
  lists.esports = await bets('es=1');
  lists.props = []; for (const s of ['open', 'locked', 'graded']) lists.props.push(...((await get(`${P}/api/props/record/picks?status=${s}&limit=1000`)).picks || []));
  const after = closeBoard.scoreboard(lists); fs.writeFileSync('out/branch-scoreboard.json', JSON.stringify({ ...after, at: new Date().toISOString() }));
  const mk = b => Object.fromEntries(Object.entries(b.byBook || {}).map(([k, v]) => [k, `${v.graded} ${v.avgClv} ${v.mark}`]));
  say(`\n== SCOREBOARD overall prod ${prodBoard.overall?.graded} ${prodBoard.overall?.mark} -> branch ${after.overall.graded} ${after.overall.mark}`);
  say('prod byBook   ' + JSON.stringify(mk(prodBoard)));
  say('branch byBook ' + JSON.stringify(mk(after)));
  say('branch rows proven: ' + JSON.stringify(after.rows.filter(r => r.mark === 'proven').map(r => `${r.kind} ${r.book} ${r.graded}`)));
  say('branch ev rows: ' + after.rows.filter(r => r.kind === 'ev').map(r => `${r.book} ${r.graded} ${r.avgClv} ${r.mark}`).join(' | '));
  const prodRes = await get(`${P}/api/results`);
  say('\n== RESULTS proven on prod: ' + JSON.stringify((prodRes.plays || []).filter(p => p.verdict === 'proven').map(p => `${p.source}:${p.by || 'all'}:${p.play} n${p.n}`)));
  const gas = (await get(`${P}/api/gas-locks`)).recent || [];
  const r2 = results.scoreboard({ ev: lists.ev.filter(b => b.status === 'closed'), sportsProps: lists.props, gasLocks: gas });
  say('branch rules on prod ev/props/gas records, proven: ' + JSON.stringify(r2.plays.filter(p => p.verdict === 'proven').map(p => `${p.source}:${p.by || 'all'}:${p.play}`)));
  say('branch ev by book: ' + r2.plays.filter(p => p.source === 'ev' && p.by === 'book').map(p => `${p.play} ${p.verdict} ${p.provenNote || ''}`).join(' | '));
  say('branch gas: ' + r2.plays.filter(p => p.source === 'gasLocks').map(p => `${p.play} n${p.n} ${p.verdict}`).join(' | '));
  // ── 2. this branch's server on live feeds
  const runMin = +(process.env.RUNMIN || 22);
  while (Date.now() - t0 < runMin * 60e3) await wait(20e3);
  const st = await get(B + '/api/status');
  const br = await board(B); const prod = await board(P);
  fs.writeFileSync('out/branch-board.json', JSON.stringify(br));
  say(`\n== BRANCH ${st.version} board ${br.length} rows, prod ${prod.length} rows, at ${new Date().toISOString()}`);
  const L = {};
  for (const r of br) for (const [bk, c] of Object.entries(r.books || {})) {
    const a = (L[r.sport] ||= { legs: 0, sharp: 0, cons: 0, consClear: 0, consPos: 0, bf: 0, bfClear: 0 }); a.legs++;
    const k = pb.legSource(r, c); if (k === 'pinnacle' || k === 'kalshi') a.sharp++;
    if (c.ev?.bookFair === 'consensus') { a.cons++; if (c.ev.ev > 0) a.consPos++; if (c.ev.ev >= 2) a.consClear++; } else if (c.ev?.bookFair) { a.bf++; if (c.ev.ev >= 2) a.bfClear++; }
  }
  say('league        legs  sharp  3+books  >0EV  clear2%  FD/BR-fair  clear2%');
  for (const [k, a] of Object.entries(L).sort((x, y) => y[1].legs - x[1].legs)) say(`${k.padEnd(12)} ${String(a.legs).padStart(5)} ${String(a.sharp).padStart(6)} ${String(a.cons).padStart(8)} ${String(a.consPos).padStart(5)} ${String(a.consClear).padStart(8)} ${String(a.bf).padStart(11)} ${String(a.bfClear).padStart(8)}`);
  const cp = pb.coverage(prod), cb = pb.coverage(br);
  say(`sharp legs prod ${cp.total.sharp}/${cp.total.legs}, branch ${cb.total.sharp}/${cb.total.legs}; branch bookCons ${cb.total.bookCons}, bookFair ${cb.total.bookFair}; prod bookFair ${cp.total.bookFair}`);
  // books behind each consensus, and how often each was dropped as an outlier
  const used = {}, nDist = {};
  for (const r of br) for (const c of Object.values(r.books || {})) if (c.ev?.bookFair === 'consensus') { nDist[c.ev.n] = (nDist[c.ev.n] || 0) + 1; for (const s of c.ev.books || []) used[s.book] = (used[s.book] || 0) + 1; }
  say('books in the consensus legs: ' + JSON.stringify(used) + ' ; books per leg: ' + JSON.stringify(nDist));
  say('\n== CONSENSUS EXAMPLES (best EV first)');
  const ex = []; for (const r of br) for (const [bk, c] of Object.entries(r.books || {})) if (c.ev?.bookFair === 'consensus') ex.push({ r, bk, c });
  ex.sort((a, b) => b.c.ev.ev - a.c.ev.ev);
  for (const { r, bk, c } of ex.slice(0, 30)) say(`${r.sport} ${r.player} ${r.market} ${bk} ${c.ev.side} ${c.line} ev ${c.ev.ev} fair ${c.ev.fair} n${c.ev.n} [${(c.ev.books || []).map(s => `${s.book} ${s.p}`).join(', ')}] start ${r.startTime}`);
  // quarter leagues stay off the full-game price
  const q = br.filter(r => /^(1h|2h|[1-4]q|[1-3]p)\|/.test(r.mkey || ''));
  say(`\nperiod rows ${q.length}; priced by a sharp or books: ${q.filter(r => Object.values(r.books).some(c => c.ev)).length}; sports named like NFL4Q: ${br.filter(r => /\d[QHP]$/.test(r.sport)).length} (prod ${prod.filter(r => /\d[QHP]$/.test(r.sport)).length})`);
  const rec = await get(B + '/api/props/record');
  say('\nbranch record byKind: ' + JSON.stringify(Object.fromEntries(Object.entries(rec.byKind || {}).map(([k, v]) => [k, v.signals]))) + ' ; headline signals ' + rec.overall?.signals);
  const sb = await get(B + '/api/ev/scoreboard');
  say('branch scoreboard book kinds: ' + JSON.stringify(Object.fromEntries(Object.entries(sb.byKind || {}).filter(([k]) => /book-/.test(k)).map(([k, v]) => [k, { label: v.kindLabel, recorded: v.recorded, mark: v.mark }]))));
  const bp = await get(B + '/api/best');
  say('branch Best Plays kinds: ' + JSON.stringify((bp.rows || []).reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {})));
  // ── renders
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const sbBody = JSON.stringify({ ...after, at: new Date().toISOString() });
    for (const [name, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile });
      const page = await ctx.newPage();
      await page.route(/line-reaper-backend-production\.up\.railway\.app/, route => route.continue({ url: route.request().url().replace(/https:\/\/line-reaper-backend-production\.up\.railway\.app/, B) }));
      // the scoreboard as this branch marks prod's records
      await page.route(/\/api\/ev\/scoreboard/, route => route.fulfill({ status: 200, contentType: 'application/json', body: sbBody }));
      await page.goto(B + '/app?start=app', { waitUntil: 'domcontentloaded' }); await wait(4000);
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => b.textContent.trim() === 'PROPS'); if (t) t.click(); });
      await wait(5000);
      for (const [tag, setup] of [['nhl-pp', "pbState.sport='NHL';pbState.view='lines';pbState.lineBook='prizepicks'"], ['cfb-pp', "pbState.sport='CFB';pbState.view='lines';pbState.lineBook='prizepicks'"], ['nhl-ud', "pbState.sport='NHL';pbState.view='lines';pbState.lineBook='underdog'"], ['cfb-cards', "pbState.sport='CFB';pbState.view='cards';pbState.sort='ev';pbState.show='priced'"]]) {
        await page.evaluate(s => { eval(s); try { localStorage.setItem('lr_pb_view', pbState.view); } catch (e) {} loadPropsBoard(); }, setup);
        await wait(6000);
        await page.screenshot({ path: `out/bcons-${tag}-${name}.png`, fullPage: false });
      }
      // +EV track record: the scoreboard
      await page.evaluate(() => { const t = [...document.querySelectorAll('.tab')].find(b => /\+EV/.test(b.textContent)); if (t) t.click(); });
      await wait(5000);
      await page.evaluate(() => { try { evSet('kind', 'record'); } catch (e) {} });
      await wait(6000);
      await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find(x => /BY BOOK/.test(x.textContent) && x.children.length < 3); if (el) el.scrollIntoView(); });
      await wait(1500);
      await page.screenshot({ path: `out/bcons-record-${name}.png`, fullPage: false });
      await ctx.close();
    }
    await browser.close(); say('renders done');
  } catch (e) { say('render error ' + e.message); }
  srv.kill(); process.exit(0);
})();
