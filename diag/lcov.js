// League coverage audit: prod PROPS board (sports) per app/league/market,
// classified by what prices each leg; plus what Pinnacle's guest feed and
// Kalshi list for the leagues that lack a price.
const fs = require('fs');
const P = process.env.SITE || 'https://line-reaper-backend-production.up.railway.app';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u, h = {}) => { try { const r = await fetch(u, { headers: { Accept: 'application/json', ...h }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const PH = { 'User-Agent': 'Mozilla/5.0' };

const pbc = require('./pb');
function classify(r, c) { const k = pbc.legSource(r, c); return k;
}
function classifyOld(r, c) {
  const src = new Set((r.consensus?.sources || []).map(s => s.book));
  if (r.pinnacle || src.has('pinnacle')) return 'pinnacle';
  if (c.fair != null || src.has('kalshi')) return 'kalshi';
  if (r.consensus) return 'books';
  if (r.nBooks > 1) return 'apps';
  return 'none';
}
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const log = [];
  const say = s => { log.push(s); console.log(s); };
  for (let i = 0; i < 30 && process.env.WAITVER; i++) { const st = await get(P + '/api/status'); if (st.version === process.env.WAITVER) break; await wait(60e3); }
  await wait(+(process.env.SETTLE || 0) * 60e3);
  const st = await get(P + '/api/status');
  say(`version ${st.version} at ${new Date().toISOString()}`);
  const rows = [];
  for (let off = 0; off < 40000; off += 500) {
    const d = await get(`${P}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`);
    rows.push(...(d.rows || []));
    if (!d.rows || d.rows.length < 500) { if (d.error) say('board error ' + d.error); break; }
  }
  const cov = await get(P + '/api/props/coverage');
  fs.writeFileSync('out/board.json', JSON.stringify(rows));
  if (!cov.error) fs.writeFileSync('out/coverage.json', JSON.stringify(cov));
  const agg = {};
  const add = (k, cls) => { agg[k] = agg[k] || { legs: 0, pinnacle: 0, kalshi: 0, books: 0, apps: 0, none: 0 }; agg[k].legs++; agg[k][cls]++; };
  for (const r of rows) for (const [b, c] of Object.entries(r.books || {})) {
    const cls = classify(r, c);
    add(`L|${r.sport}`, cls); add(`B|${b}|${r.sport}`, cls); add(`M|${r.sport}|${r.market}`, cls);
  }
  const line = (k, a) => `${k.padEnd(48)} legs ${String(a.legs).padStart(5)}  pin ${String(a.pinnacle).padStart(4)}  kal ${String(a.kalshi).padStart(4)}  books ${String(a.books).padStart(4)}  apps ${String(a.apps).padStart(4)}  none ${String(a.none).padStart(5)}`;
  say(`\n== BY LEAGUE (${rows.length} rows)`);
  for (const [k, a] of Object.entries(agg).filter(([k]) => k.startsWith('L|')).sort((x, y) => y[1].legs - x[1].legs)) say(line(k, a));
  say('\n== BY APP x LEAGUE');
  for (const [k, a] of Object.entries(agg).filter(([k]) => k.startsWith('B|')).sort((x, y) => x[0].localeCompare(y[0]))) say(line(k, a));
  say('\n== BY MARKET (legs >= 5)');
  for (const [k, a] of Object.entries(agg).filter(([k, a]) => k.startsWith('M|') && a.legs >= 5).sort((x, y) => x[0].split('|')[1].localeCompare(y[0].split('|')[1]) || y[1].legs - x[1].legs)) say(line(k, a));

  // ── Pinnacle: sports, leagues, special categories
  const sports = await get(PIN + '/sports', PH);
  fs.writeFileSync('out/pin-sports.json', JSON.stringify(sports));
  say('\n== PINNACLE SPORTS ' + (sports.error || (sports || []).map(s => `${s.id}:${s.name}(${s.matchupCount || ''})`).join(' ')));
  const want = (sports || []).filter?.(s => /mixed martial|soccer|tennis|golf|auto|motor|formula|nascar|racing|boxing|basketball|baseball|hockey|football/i.test(s.name)) || [];
  for (const s of want) {
    const leagues = await get(`${PIN}/sports/${s.id}/leagues?all=false`, PH);
    const ls = Array.isArray(leagues) ? leagues.filter(l => (l.matchupCount || 0) > 0).sort((a, b) => (b.matchupCount || 0) - (a.matchupCount || 0)) : [];
    say(`\n-- ${s.id} ${s.name}: ${ls.length} leagues with matchups; top: ${ls.slice(0, 25).map(l => `${l.id}:${l.name}(${l.matchupCount})`).join(', ')}`);
    const mu = await get(`${PIN}/sports/${s.id}/matchups?withSpecials=true`, PH);
    const mk = await get(`${PIN}/sports/${s.id}/markets/straight?primaryOnly=false&withSpecials=true`, PH);
    fs.writeFileSync(`out/pin-${s.id}-matchups.json`, JSON.stringify(mu));
    fs.writeFileSync(`out/pin-${s.id}-markets.json`, JSON.stringify(mk));
    if (!Array.isArray(mu)) { say('   matchups error ' + JSON.stringify(mu).slice(0, 200)); continue; }
    const types = {}, cats = {}, descs = {};
    for (const m of mu) {
      types[m.type] = (types[m.type] || 0) + 1;
      if (m.type === 'special') {
        const c = m.special?.category || '?'; cats[c] = (cats[c] || 0) + 1;
        const d = String(m.special?.description || '').replace(/^.+?\s+(Total|To|Anytime|Method|Over)/, '<X> $1').replace(/\d+(\.\d+)?/g, 'N');
        const k = `${c} :: ${d}`; descs[k] = (descs[k] || 0) + 1;
      }
    }
    const mtypes = {};
    if (Array.isArray(mk)) for (const x of mk) { const k = `${x.type}/p${x.period}${x.side ? '/' + x.side : ''}`; mtypes[k] = (mtypes[k] || 0) + 1; }
    say(`   matchup types ${JSON.stringify(types)}; market types ${JSON.stringify(mtypes)}`);
    say(`   special categories ${JSON.stringify(cats)}`);
    for (const [k, n] of Object.entries(descs).sort((a, b) => b[1] - a[1]).slice(0, 40)) say(`     ${n}  ${k}`);
    const lg = {};
    for (const m of mu) { const k = m.league?.name || '?'; lg[k] = (lg[k] || 0) + 1; }
    say(`   by league ${JSON.stringify(Object.fromEntries(Object.entries(lg).sort((a, b) => b[1] - a[1]).slice(0, 30)))}`);
    await wait(500);
  }

  // ── Kalshi sports series
  const ser = await get(`${KAL}/series?category=Sports`);
  const list = ser.series || [];
  fs.writeFileSync('out/kalshi-series.json', JSON.stringify(list.map(s => ({ t: s.ticker, title: s.title, tags: s.tags }))));
  say(`\n== KALSHI sports series ${list.length}${ser.error ? ' error ' + ser.error : ''}`);
  const re = /UFC|MMA|NASCAR|F1|FORMULA|TENNIS|ATP|WTA|GOLF|PGA|LIV|MLS|EPL|SOCCER|LALIGA|SERIEA|UCL|BUNDES|LIGUE|BOXING|INDY/i;
  const hits = list.filter(s => re.test(s.ticker) || re.test(s.title || ''));
  for (const s of hits) {
    const m = await get(`${KAL}/markets?series_ticker=${s.ticker}&status=open&limit=200`);
    const n = (m.markets || []).length;
    if (n) say(`   ${s.ticker.padEnd(26)} ${String(n).padStart(4)} open  ${s.title}  e.g. ${(m.markets || []).slice(0, 2).map(x => x.title).join(' | ')}`);
    await wait(120);
  }
  fs.writeFileSync('out/report.txt', log.join('\n'));
})();
