// Live check of the slip log on the branch's own server: wait for the boards,
// build legs from tonight's real lines, grade them, re-grade after a few reads.
const fs = require('fs');
const B = 'http://localhost:3999';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, o) => { const r = await fetch(B + p, o); return r.json(); };
const post = legs => j('/api/slips/grade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legs }) });
(async () => {
  const out = { t0: new Date().toISOString() };
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await sleep(30000);
    try {
      const b = await j('/api/props/board?limit=500&sort=ev&priced=1');
      rows = (b.rows || []).filter(r => !r.esports);
      out.counts = b.counts; out.boardTotal = b.total; out.sportsRows = rows.length;
      const priced = rows.filter(r => Object.values(r.books || {}).some(c => c.fair != null || c.ev != null));
      console.log(i, 'rows', rows.length, 'priced', priced.length);
      if (i >= 16 && rows.length >= 30) break;
    } catch (e) { out.err = String(e); }
  }
  out.sample = rows.slice(0, 3);
  // up to 14 real legs: different players, sports and apps, game still ahead
  const legs = [], seen = new Set();
  const now = Date.now();
  // rows the sharp consensus or Kalshi prices first, then the rest
  const rank = r => (r.best?.kind === 'sharp' ? 0 : /pinnacle|kalshi/.test(r.best?.source || '') ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b));
  out.ranks = [0, 1, 2].map(k => rows.filter(r => rank(r) === k).length);
  out.bestKinds = rows.reduce((a, r) => { const k = `${r.best?.kind}|${r.best?.source}`; a[k] = (a[k] || 0) + 1; return a; }, {});
  for (const r of rows) {
    if (legs.length >= 14) break;
    if (seen.has(r.player) || !(Date.parse(r.startTime) > now + 20 * 60e3)) continue;
    const apps = Object.entries(r.books || {}).filter(([, c]) => c.line != null);
    if (!apps.length) continue;
    const [app, c] = apps[legs.length % apps.length];
    seen.add(r.player);
    legs.push({ id: `real${legs.length}`, app, sport: r.sport, player: r.player, market: r.market, side: legs.length % 3 ? 'Over' : 'Under', line: c.line, betAt: new Date(now).toISOString() });
  }
  const p0 = rows[0];
  const nohist = [
    { id: 'old', app: 'prizepicks', sport: p0?.sport, player: p0?.player, market: p0?.market, side: 'Over', line: 10.5, betAt: new Date(now - 5 * 86400e3).toISOString() },
    { id: 'fake', app: 'underdog', player: 'Nobody Realname', market: 'Points', side: 'Over', line: 20.5, betAt: new Date(now).toISOString() },
    { id: 'stat', app: 'prizepicks', sport: p0?.sport, player: p0?.player, market: 'Hot Dogs Eaten', side: 'Over', line: 2.5, betAt: new Date(now).toISOString() },
    { id: 'late', app: 'underdog', sport: 'NFL', player: 'Josh Allen', market: 'Pass Yards', side: 'Over', line: 230.5, betAt: new Date(now - 9 * 86400e3).toISOString() },
    { id: 'es', app: 'prizepicks', sport: 'CS', player: 'ZywOo', market: 'Kills', side: 'Over', line: 35.5, betAt: new Date(now).toISOString() },
  ];
  out.legs = [...legs, ...nohist];
  out.first = await post(out.legs);
  await sleep(6 * 60e3);
  out.second = await post(out.legs);
  out.record = await j('/api/slips/record');
  out.status = await j('/api/status').catch(e => String(e));
  fs.writeFileSync('out/sliplog.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.second).slice(0, 3000));
})();
// v3
