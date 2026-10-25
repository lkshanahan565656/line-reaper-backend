// Runs this branch's server on live feeds ~RUNMIN minutes, then dumps the NHL
// and soccer coverage, the BetRivers soccer reader, the flags it recorded, and
// the NHL/soccer board rows.
const fs = require('fs'); const { spawn } = require('child_process');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); return await r.json(); } catch (e) { return { error: e.message }; } };
(async () => {
  fs.mkdirSync('out', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on', PICK6: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const snaps = [];
  const total = +(process.env.RUNMIN || 16);
  for (let m = 4; m <= total; m += 4) {
    await wait(4 * 60e3);
    const n = await get(B + '/api/props/nhlsoc');
    snaps.push({ t: new Date().toISOString(), n });
    fs.writeFileSync('out/nhlsoc-snaps.json', JSON.stringify(snaps));
  }
  const rows = [];
  for (const s of ['NHL', 'SOCCER']) for (let off = 0; off < 20000; off += 500) {
    const d = await get(`${B}/api/props/board?sport=${s}&sort=start&limit=500&offset=${off}`);
    rows.push(...(d.rows || []));
    if (!d.rows || d.rows.length < 500) break;
  }
  fs.writeFileSync('out/board.json', JSON.stringify(rows));
  const picks = {};
  for (const k of ['nhs-pin', 'nhs-kalshi', 'nhs-bound']) picks[k] = (await get(`${B}/api/props/record/picks?kind=${k}&limit=1000`)).picks;
  fs.writeFileSync('out/picks.json', JSON.stringify(picks));
  const st = await get(B + '/api/status');
  fs.writeFileSync('out/status.json', JSON.stringify(st));
  const last = snaps[snaps.length - 1]?.n || {};
  const L = [`branch ${st.version} at ${new Date().toISOString()}, ${rows.length} NHL/SOCCER rows`];
  L.push('soccerBooks ' + JSON.stringify(last.soccerBooks));
  L.push('coverage legs:'); for (const [k, v] of Object.entries(last.coverage?.legs || {})) L.push(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
  L.push('coverage by stat:'); for (const [k, v] of Object.entries(last.coverage?.byStat || {}).sort((a, b) => b[1].legs - a[1].legs)) L.push(`  ${k.padEnd(34)} ${JSON.stringify(v)}`);
  L.push('flags ' + JSON.stringify(last.coverage?.flags));
  L.push('record ' + JSON.stringify(last.record));
  for (const [k, l] of Object.entries(picks)) for (const b of (l || []).slice(0, 40)) L.push(`  ${k} ${b.sport} ${b.player} ${b.mkey} ${b.signalBook} ${b.signalSide} ${b.signalLine} mult ${b.signalMult} be ${b.be} fair ${b.signalFair} ev ${b.signalEv} src ${JSON.stringify(b.sources)} start ${b.start}`);
  L.push('pinnacleProps ' + JSON.stringify(st.pinnacleProps || null).slice(0, 600));
  L.push('kalshiProps ' + JSON.stringify(st.kalshiProps || null).slice(0, 600));
  L.push('errors: ' + fs.readFileSync('out/server.err', 'utf8').split('\n').filter(x => /nhl|soccer|Sports props/i.test(x)).slice(0, 10).join(' | '));
  fs.writeFileSync('out/report.txt', L.join('\n'));
  srv.kill();
})();
