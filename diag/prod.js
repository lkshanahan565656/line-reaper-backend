const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let st = null;
  // the new version, then CS2 results folded in (ratings refresh at boot, matchups every 10 min)
  for (let i = 0; i < 50; i++) {
    try { st = await (await fetch(B + '/api/status')).json(); const g = st.matchupGames || {}; if (st.version === '3.161.0' && g.CS2 && g.VAL && !g.CS2.error && !g.VAL.error) break; } catch (e) { console.error('status', e.message); }
    await sleep(20000);
  }
  const out = { at: new Date().toISOString(), version: st && st.version, matchupGames: st && st.matchupGames, games: {} };
  for (const g of ['LOL', 'CS2', 'VAL']) {
    const o = {};
    for (const p of ['', '/ratings', '/record', '/backtest']) {
      try { const r = await fetch(`${B}/api/esports/matchups${p}?game=${g}`); const b = await r.json(); o[p || '/'] = { status: r.status, ...(p === '' ? { count: b.count, priced: b.priced, withKalshi: b.withKalshi, withPmus: (b.matchups || []).filter(m => m.markets.pmus).length, error: b.status && b.status.error, rows: (b.matchups || []).slice(0, 10).map(m => [m.start, m.teams.map(t => t.name).join(' v '), m.model.confidence, m.model.win, m.markets.kalshi && m.markets.kalshi.prob, m.markets.pmus && m.markets.pmus.prob]) } : p === '/ratings' ? { teams: (b.teams || []).length, top: (b.teams || []).slice(0, 5).map(t => `${t.name} ${t.rating}`) } : p === '/backtest' ? { verdict: b.verdict } : { graded: b.summary && b.summary.graded, tracked: b.summary && b.summary.tracked }) }; } catch (e) { o[p || '/'] = { error: e.message }; }
    }
    out.games[g] = o;
  }
  const page = await (await fetch(B + '/app')).text();
  out.pageHasGames = page.includes('setEmuGame') && page.includes('emuGames');
  process.stdout.write(JSON.stringify(out));
})();
