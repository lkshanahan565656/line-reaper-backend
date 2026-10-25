const B = 'https://line-reaper-backend-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) }); return { s: r.status, b: await r.json() }; } catch (e) { return { s: 0, e: e.message }; } };
(async () => {
  for (let i = 0; i < 80; i++) { const s = await j('/api/status'); if (s.b?.version === '3.180.0') { console.log('live 3.180.0 at', new Date().toISOString()); break; } await sleep(30000); }
  for (let i = 0; i < 16; i++) {
    const st = await j('/api/status'); const sm = st.b?.soccerModel;
    if (sm?.refreshedAt) { console.log('status', JSON.stringify(sm).slice(0, 1500)); break; }
    await sleep(60000);
  }
  const m = await j('/api/soccer/model');
  const g = m.b?.games || [];
  console.log('model', m.s, 'games', g.length, 'priced', g.filter(x => x.model).length, 'kalshi', g.filter(x => x.rows.some(r => r.kalshi)).length, 'pmus', g.filter(x => x.rows.some(r => r.pmus)).length,
    'flags', g.reduce((s, x) => s + x.rows.filter(r => r.flag?.kalshi || r.flag?.pmus).length, 0), 'unrated', JSON.stringify(g.filter(x => !x.model).map(x => `${x.league}:${x.home}|${x.away}`).slice(0, 30)));
  for (const x of g.slice(0, 5)) console.log(x.league, x.home, 'v', x.away, x.start, JSON.stringify(x.rows.map(r => [r.pick, r.model, r.pin, r.kalshi?.cost ?? null, r.pmus?.cost ?? null])));
  const r = await j('/api/soccer/model/record'); console.log('record', r.s, JSON.stringify(r.b?.kinds || r.b).slice(0, 800));
  const t = await j('/api/soccer/model/ratings?league=E0'); console.log('ratings', t.s, (t.b?.teams || []).length);
})();
