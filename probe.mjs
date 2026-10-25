import fs from 'fs';
const out = (f, d) => fs.writeFileSync('out/' + f, typeof d === 'string' ? d : JSON.stringify(d, null, 1));
const log = (...a) => { console.log(...a); fs.appendFileSync('out/summary.txt', a.join(' ') + '\n'); };
async function get(url, headers = {}) {
  try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t: j ? null : t.slice(0, 300) };
  } catch (e) { return { s: 0, e: String(e) }; }
}
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const PM = 'https://gateway.polymarket.us';
fs.mkdirSync('out', { recursive: true });
// ---- Pinnacle
const sp = await get(`${PIN}/sports`); out('pin-sports.json', sp.j || sp);
log('pin sports', sp.s, (sp.j || []).map(s => `${s.id}:${s.name}:${s.matchupCount}`).join(' | '));
const wanted = (sp.j || []).filter(s => /golf|motor|formula|racing|auto/i.test(s.name));
for (const s of wanted) {
  const lg = await get(`${PIN}/sports/${s.id}/leagues?all=false`); out(`pin-leagues-${s.id}.json`, lg.j || lg);
  log('pin leagues', s.name, lg.s, (lg.j || []).map(l => `${l.id}:${l.name}:${l.matchupCount}`).join(' | '));
  for (const l of (lg.j || []).filter(l => l.matchupCount > 0).slice(0, 12)) {
    const [mu, mk] = [await get(`${PIN}/leagues/${l.id}/matchups`), await get(`${PIN}/leagues/${l.id}/markets/straight`)];
    out(`pin-mu-${l.id}.json`, mu.j || mu); out(`pin-mk-${l.id}.json`, mk.j || mk);
    log('  league', l.id, l.name, 'mu', mu.s, (mu.j || []).length, 'mk', mk.s, (mk.j || []).length,
      [...new Set((mu.j || []).map(m => `${m.type}/${m.special?.category || ''}/${m.participants?.length}`))].slice(0, 10).join(','));
    for (const m of (mu.j || []).slice(0, 15)) log('    ', m.id, m.type, m.special?.category, '|', m.special?.description || (m.participants || []).map(p => p.name).join(' v '), m.startTime, 'np', m.participants?.length, m.parent?.id || '');
  }
}
for (const [name, id] of [['NFL', 889], ['NBA', 487], ['NHL', 1456], ['MLB', 246]]) {
  const mu = await get(`${PIN}/leagues/${id}/matchups`);
  const sp2 = (mu.j || []).filter(m => m.type === 'special' && !/player props/i.test(m.special?.category || ''));
  const cats = {}; for (const m of sp2) cats[m.special?.category] = (cats[m.special?.category] || 0) + 1;
  log('pin', name, 'specials non-props', sp2.length, JSON.stringify(cats));
  for (const m of sp2.filter(m => (m.participants || []).length > 2).slice(0, 25)) log('    ', m.id, m.special?.category, '|', m.special?.description, m.startTime, 'np', m.participants.length);
  out(`pin-specials-${name}.json`, sp2);
  if (sp2.length) { const mk = await get(`${PIN}/leagues/${id}/markets/straight`); out(`pin-mk-${name}.json`, (mk.j || []).filter(x => sp2.some(m => m.id === x.matchupId))); }
}
// ---- Kalshi
let series = [], cur = '';
for (let i = 0; i < 20; i++) { const r = await get(`${K}/series?category=Sports${cur ? '&cursor=' + cur : ''}`); if (r.s !== 200) { log('kalshi series', r.s, r.t || r.e); break; } series.push(...(r.j.series || [])); cur = r.j.cursor; if (!cur) break; }
out('kalshi-series.json', series);
log('kalshi sports series', series.length);
const kw = series.filter(s => /golf|pga|f1|formula|grand prix|racing|nascar|indy|champion|winner|mvp|super bowl|nba final|world series|stanley|futures|liv|masters|open|tour/i.test(`${s.ticker} ${s.title}`));
log('kalshi candidate series', kw.length, kw.map(s => `${s.ticker}:${s.title}`).join(' | '));
const kev = [];
for (const s of kw.slice(0, 120)) {
  const r = await get(`${K}/events?series_ticker=${s.ticker}&status=open&with_nested_markets=true&limit=50`);
  for (const e of r.j?.events || []) { kev.push(e); log('  kev', s.ticker, e.event_ticker, '|', e.title, '| mk', (e.markets || []).length, 'vol', (e.markets || []).reduce((a, m) => a + (m.volume || 0), 0), 'close', e.markets?.[0]?.close_time); }
  await new Promise(r => setTimeout(r, 120));
}
out('kalshi-events.json', kev);
// ---- PM US
for (const p of ['/v2/leagues', '/v1/leagues', '/v2/sports', '/v1/sports', '/v1/events?limit=50', '/v2/events?limit=50', '/v1/markets?limit=50',
  '/v2/leagues/golf/events?limit=50', '/v2/leagues/pga/events?limit=50', '/v2/leagues/f1/events?limit=50', '/v2/leagues/nfl/events?limit=50', '/v2/leagues/nba/events?limit=50']) {
  const r = await get(PM + p); out('pmus' + p.replace(/[\/?=&]/g, '_') + '.json', r.j || r);
  const arr = Array.isArray(r.j) ? r.j : (r.j?.events || r.j?.leagues || r.j?.markets || r.j?.sports || r.j?.data || []);
  log('pmus', p, r.s, Array.isArray(arr) ? arr.length : '', r.t || r.e || '', JSON.stringify(r.j)?.slice(0, 400));
  await new Promise(r => setTimeout(r, 400));
}
