// Probe: what FanDuel/BetRivers/Action books post for NBA combos, what Pinnacle posts for singles, Sleeper combo legs; and Pick6's loader shape
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; } };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
async function board(sport) { const rows = []; for (let off = 0; off < 60000; off += 500) { const d = await get(`${B}/api/props/board?sport=${sport}&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; } return rows; }
async function pick6Probe() {
  const axios = require('axios'); const { decodeTurboStream, pick6Home } = require('../pickem');
  const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: '*/*', Referer: 'https://pick6.draftkings.com/' };
  for (const sport of ['NBA', 'NHL', 'NFL', 'CFB']) {
    try {
      const r = await axios.get('https://pick6.draftkings.com/_root.data', { params: { sport }, headers: H, responseType: 'text', transformResponse: x => x, timeout: 20000 });
      const dec = decodeTurboStream(r.data); const home = pick6Home(dec);
      fs.writeFileSync(`out/p6-${sport}.json`, JSON.stringify(home));
      say(`Pick6 ${sport}: top keys ${Object.keys(home || {}).join(',')}`);
      say(`  pickGroups ${JSON.stringify((home.pickGroups || []).map(g => ({ id: g.pickGroupId, n: g.name || g.title || g.label, ...Object.fromEntries(Object.entries(g).filter(([k, v]) => typeof v !== 'object').slice(0, 12)) })).slice(0, 12))}`);
      const pc = home.pickCardsResponse || {};
      say(`  pickCardsResponse keys ${Object.keys(pc).join(',')} cards ${Object.keys(pc.pickCardByPickableId || {}).length} markets ${JSON.stringify(Object.values(pc.pickSixMarketById || {}).map(m => m.name))}`);
      await wait(1500);
    } catch (e) { say(`Pick6 ${sport} error ${e.response?.status} ${e.message}`); }
  }
}
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  await pick6Probe();
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const runMin = +(process.env.RUNMIN || 20), t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < runMin * 60e3) {
    await wait(6 * 60e3); i++;
    const q = await get(B + '/api/diag/q');
    const rows = (await board('SPORTS')).filter(r => r.sport === 'NBA');
    fs.writeFileSync(`out/q-${i}.json`, JSON.stringify(q)); fs.writeFileSync(`out/nba-${i}.json`, JSON.stringify(rows));
    const bq = (q.book || []).flatMap(([, l]) => l), pq = (q.pin || []).flatMap(([, l]) => l);
    const cnt = {}; for (const x of bq) cnt[`${x.book}|${x.mkey}`] = (cnt[`${x.book}|${x.mkey}`] || 0) + 1;
    const pc = {}; for (const x of pq) pc[x.mkey || x.key.split('|')[2]] = (pc[x.mkey || x.key.split('|')[2]] || 0) + 1;
    const cells = {}; for (const r of rows) for (const b of Object.keys(r.books || {})) cells[`${b}|${r.mkey}`] = (cells[`${b}|${r.mkey}`] || 0) + 1;
    say(`\n${new Date().toISOString()} read ${i}: NBA board rows ${rows.length}`);
    say('book quotes NBA: ' + Object.entries(cnt).sort().map(([k, v]) => `${k} ${v}`).join('  '));
    say('pinnacle NBA: ' + Object.entries(pc).sort().map(([k, v]) => `${k} ${v}`).join('  '));
    say('app cells NBA: ' + Object.entries(cells).sort().map(([k, v]) => `${k} ${v}`).join('  '));
  }
  srv.kill(); process.exit(0);
})();
