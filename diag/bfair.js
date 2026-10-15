// Grading audit + book-fair probe: prod props record by sport/market/status,
// prod board legs by price source, ESPN result feeds for tennis/MMA/NASCAR/soccer,
// Kalshi settled markets for the fight/race/tennis/goal series.
const fs = require('fs');
const P = process.env.SITE || 'https://line-reaper-backend-production.up.railway.app';
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (u, h = {}) => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...h }, signal: AbortSignal.timeout(120000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const log = []; const say = s => { log.push(s); console.log(s); };
const save = (n, d) => fs.writeFileSync('out/' + n + '.json', JSON.stringify(d));
const ymd = t => new Date(t - 4 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const st = await get(P + '/api/status');
  say(`version ${st.version} at ${new Date().toISOString()}`);
  // A. record
  const rec = await get(P + '/api/props/record'); save('record', rec);
  const picks = [];
  for (const s of ['open', 'locked', 'graded', 'void']) { const d = await get(`${P}/api/props/record/picks?status=${s}&limit=1000`); say(`picks ${s}: ${d.picks?.length ?? JSON.stringify(d).slice(0, 100)}`); picks.push(...(d.picks || [])); }
  save('picks', picks);
  const agg = {};
  for (const b of picks) { const k = `${b.sport}|${b.mkey}`; agg[k] ||= {}; agg[k][b.status] = (agg[k][b.status] || 0) + 1; }
  say('\n== RECORD BY SPORT|MKEY (status counts)');
  for (const [k, v] of Object.entries(agg).sort()) say(`${k.padEnd(44)} ${JSON.stringify(v)}`);
  const kinds = {}; for (const b of picks) { const k = `${b.sport}|${b.kind}|${b.status}`; kinds[k] = (kinds[k] || 0) + 1; }
  say('\n== RECORD BY SPORT|KIND|STATUS'); for (const [k, v] of Object.entries(kinds).sort()) say(`${k.padEnd(44)} ${v}`);
  const voids = {}; for (const b of picks.filter(b => b.status === 'void')) { const k = `${b.sport}|${b.voidReason}`; voids[k] = (voids[k] || 0) + 1; }
  say('\n== VOIDS'); for (const [k, v] of Object.entries(voids).sort()) say(`${k.padEnd(44)} ${v}`);
  // sharp kind with only book sources
  const bo = picks.filter(b => b.kind === 'sharp' && !(b.sources || []).some(s => s.book === 'pinnacle' || s.book === 'kalshi'));
  say(`\nsharp-kind legs priced only by books (no Pinnacle/Kalshi): ${bo.length} of ${picks.filter(b => b.kind === 'sharp').length}; by sport ${JSON.stringify(bo.reduce((a, b) => (a[b.sport] = (a[b.sport] || 0) + 1, a), {}))}; statuses ${JSON.stringify(bo.reduce((a, b) => (a[b.status] = (a[b.status] || 0) + 1, a), {}))}`);
  // B. board
  const rows = [];
  for (let off = 0; off < 40000; off += 500) { const d = await get(`${P}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; }
  save('board', rows);
  const L = {};
  for (const r of rows) for (const [b, c] of Object.entries(r.books || {})) {
    const src = new Set((r.consensus?.sources || []).filter(s => !s.shadow).map(s => s.book));
    const cls = r.pinnacle || src.has('pinnacle') || c.fair != null || src.has('kalshi') ? 'sharp' : r.consensus ? `books2(${[...src].sort().join('+')})` : (r.sharpBooks || []).length ? `book1(${r.sharpBooks.join('+')})` : 'none';
    const k = `${r.sport}`; L[k] ||= {}; L[k][cls] = (L[k][cls] || 0) + 1; L[k].legs = (L[k].legs || 0) + 1;
  }
  say(`\n== BOARD LEGS BY LEAGUE (${rows.length} rows)`); for (const [k, v] of Object.entries(L).sort((a, b) => b[1].legs - a[1].legs)) say(`${k.padEnd(12)} ${JSON.stringify(v)}`);
  // C. ESPN
  const now = Date.now();
  const days = [1, 2, 3, 4, 5, 6].map(d => ymd(now - d * 86400e3));
  for (const lg of ['tennis/atp', 'tennis/wta']) {
    const d = await get(`${ESPN}/${lg}/scoreboard?dates=${days[0]}`); save(`espn-${lg.replace('/', '-')}`, d);
    say(`\nESPN ${lg} ${days[0]}: ${d.error || `events ${d.events?.length}`}`);
    const ev = d.events?.[0]; if (ev) say('  first event keys ' + Object.keys(ev).join(',') + ' groupings ' + (ev.groupings || []).length + ' comps ' + (ev.groupings || []).reduce((a, g) => a + (g.competitions || []).length, 0));
  }
  const ufc = await get(`${ESPN}/mma/ufc/scoreboard`); save('espn-ufc-now', ufc); say(`\nESPN UFC now: ${ufc.error || `events ${ufc.events?.length} ${ufc.events?.map(e => e.date + ' ' + e.name).join('; ')}`}`);
  for (const d of days) { const x = await get(`${ESPN}/mma/ufc/scoreboard?dates=${d}`); if (x.events?.length) { save(`espn-ufc-${d}`, x); say(`ESPN UFC ${d}: ${x.events.map(e => e.name + ' comps ' + (e.competitions || []).length).join('; ')}`); const id = x.events[0].id; const s = await get(`${ESPN}/mma/ufc/summary?event=${id}`); save(`espn-ufc-summary-${id}`, s); say('  summary keys ' + Object.keys(s).join(',')); } }
  for (const lg of ['racing/nascar-premier', 'racing/f1']) { const x = await get(`${ESPN}/${lg}/scoreboard`); save(`espn-${lg.replace('/', '-')}`, x); say(`ESPN ${lg}: ${x.error || `events ${x.events?.length} ${x.events?.map(e => e.date + ' ' + e.name).join('; ')}`}`); }
  for (const d of days.slice(0, 4)) { const x = await get(`${ESPN}/soccer/all/scoreboard?dates=${d}`); save(`espn-soccer-all-${d}`, x); say(`ESPN soccer/all ${d}: ${x.error || `events ${x.events?.length}`}`); if (x.events?.length) { const e = x.events.find(e => e.status?.type?.completed); if (e) { const lg = e.season?.slug || ''; say('  e ' + e.name + ' uid ' + e.uid + ' league? ' + JSON.stringify(e.competitions?.[0]?.league || e.league || null).slice(0, 200)); } } }
  const epl = await get(`${ESPN}/soccer/eng.1/scoreboard?dates=20261004`); save('espn-epl-1004', epl); say(`ESPN EPL 10-04: ${epl.error || `events ${epl.events?.length}`}`);
  if (epl.events?.[0]) { const s = await get(`${ESPN}/soccer/eng.1/summary?event=${epl.events[0].id}`); save('espn-epl-summary', s); say('  summary keys ' + Object.keys(s).join(',') + ' rosters ' + (s.rosters || []).length); }
  // D. Kalshi settled
  for (const t of ['KXUFCMOV', 'KXUFCVICROUND', 'KXUFCDISTANCE', 'KXNASCARTOP10', 'KXNASCARRACE', 'KXATPGTOTAL', 'KXWTAGTOTAL', 'KXEPLGOAL', 'KXUCLGOAL', 'KXMLSGOAL']) {
    const d = await get(`${KAL}/events?series_ticker=${t}&status=settled&with_nested_markets=true&limit=5`); save(`kal-${t}`, d);
    const ev = d.events?.[0];
    say(`\nKalshi ${t} settled: ${d.error || `events ${d.events?.length}`}${ev ? ` e.g. ${ev.title} | ${ev.markets?.length} mkts; ${ev.markets?.slice(0, 3).map(m => `${m.title} / ${m.yes_sub_title} = ${m.result} exp ${m.expected_expiration_time} close ${m.close_time}`).join(' || ')}` : ''}`);
    await wait(500);
  }
  const ser = await get(`${KAL}/series?category=Sports`); const goal = (ser.series || []).filter(s => /GOAL|SCORER/i.test(s.ticker)).map(s => s.ticker); say('\nKalshi GOAL series: ' + goal.join(' '));
  fs.writeFileSync('out/log.txt', log.join('\n'));
})();
