const fs = require('fs');
const U = 'http://localhost:3999';
const get = async p => { try { const r = await fetch(U + p, { signal: AbortSignal.timeout(120000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const t0 = Date.now();
  let st = {};
  // wait for the books, the Kalshi ladders and one esports build
  while (Date.now() - t0 < 13 * 60e3) {
    await sleep(20000);
    st = await get('/api/status');
    const ok = st.underdog?.count > 0 && st.sleeper?.sports > 0 && st.kalshiProps?.updated && st.esports?.picks > 0;
    console.log(Math.round((Date.now() - t0) / 1000), 'ud', st.underdog?.count, 'pp', st.prizepicks?.count, st.prizepicks?.lastError?.status, 'sl', st.sleeper?.count, st.sleeper?.sports, 'kalshi', JSON.stringify(st.kalshiProps?.counts), 'es', st.esports?.picks);
    if (ok && Date.now() - t0 > 7 * 60e3) break;
  }
  console.log('status', JSON.stringify({ ud: st.underdog, pp: st.prizepicks, sl: st.sleeper, kalshi: st.kalshiProps, es: st.esports, board: st.propsBoard }));
  const views = { all: '', nfl: 'sport=NFL', nhl: 'sport=NHL', pp: 'book=prizepicks', sl: 'book=sleeper', ud: 'book=underdog', es: 'sport=ESPORTS', gap: 'sort=gap&multi=1', priced: 'priced=1', cs: 'sport=CS', mlb: 'sport=MLB', search: 'q=allen' };
  const dump = {};
  for (const [k, q] of Object.entries(views)) {
    const d = await get('/api/props/board?limit=150&' + q);
    dump[k] = d;
    const rows = d.rows || [];
    console.log(`==== ${k} total=${d.total} rows=${rows.length} priced=${rows.filter(r => r.best).length} multi=${rows.filter(r => r.nBooks > 1).length}`);
    for (const r of rows.slice(0, 4)) console.log(JSON.stringify({ p: r.player, s: r.sport, m: r.market, st: r.startTime, books: r.books, best: r.best, gap: r.gap }));
  }
  console.log('counts', JSON.stringify(dump.all.counts));
  fs.writeFileSync('out/board.json', JSON.stringify(dump));
  const ev = await get('/api/ev?limit=5000');
  const er = ev.rows || [];
  const cnt = {};
  for (const r of er.filter(r => r.dfs)) cnt[r.book] = (cnt[r.book] || 0) + 1;
  console.log('ev dfs rows by book', JSON.stringify(cnt), 'top', JSON.stringify(er.filter(r => r.dfs).slice(0, 5).map(r => [r.book, r.player, r.market, r.point, r.side, r.ev, r.fairProb, r.multiplier])));
  const best = await get('/api/best?limit=500');
  const bp = (best.plays || best.rows || []).filter(p => p.kind === 'sportsProp');
  const v = {};
  for (const p of bp) v[p.venue] = (v[p.venue] || 0) + 1;
  console.log('best plays sportsProp by venue', JSON.stringify(v), Object.keys(best));
  // a sanity sweep: same player+stat with very different fair across books' lines must be monotone
  let bad = 0, checked = 0;
  const all = await get('/api/props/board?limit=500&priced=1&multi=1');
  for (const r of all.rows || []) {
    const cs = Object.values(r.books).filter(c => c.fair != null).sort((a, b) => a.line - b.line);
    for (let i = 1; i < cs.length; i++) { checked++; if (cs[i].fair > cs[i - 1].fair + 0.5) bad++; }
  }
  console.log('fair monotone check', checked, 'pairs', bad, 'rising');
})();
