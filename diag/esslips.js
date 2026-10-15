// Branch check of MY SLIPS esports legs and the Pick6 Best Slips builder, on live feeds.
// A: run the branch server, paste a real-looking esports slip made from the live board, grade it, grade it again later.
// B: replay the grading chain on finished matches the production record already graded.
const fs = require('fs'); const { spawn } = require('child_process');
fs.mkdirSync('out/snap', { recursive: true });
const App = p => require('../app/' + p);
const S = App('slips'), M = App('esmatch'), T = App('tracker'), E = App('esslips');
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const env = { ...process.env, PORT: '3999', PINNACLE: 'on', PICK6: 'on', LR_DATA_DIR: '/tmp/lrdata' };
const srv = spawn('node', ['server.js'], { cwd: 'app', env, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
const get = async (p, opt) => { try { const r = await fetch('http://localhost:3999' + p, opt); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (n, o) => fs.writeFileSync(`out/${n}`, typeof o === 'string' ? o : JSON.stringify(o, null, 1));
const TAG = { CS: 'CS', LOL: 'LOL', VAL: 'VAL', DOTA: 'DOTA' };
const tagOf = s => TAG[T.sportKey(s)] || null;

async function partA() {
  const log = [];
  let picks = [];
  for (let i = 0; i < 24; i++) {
    await sleep(30000);
    const r = await get('/api/esports/picks');
    try { picks = JSON.parse(r.body).picks || []; } catch { picks = []; }
    log.push({ t: new Date().toISOString(), picks: picks.length });
    save('status-log.json', log);
    if (picks.length >= 30 && i >= 8) break;
  }
  save('snap/picks.json', JSON.stringify({ picks }));
  const upcoming = picks.filter(p => Date.parse(p.startTime) > Date.now() + 15 * 60e3 && tagOf(p.sport) && /kill|headshot|assist/i.test(p.market));
  // a player with two matches the same day (one board pick per match)
  const byPlayer = new Map();
  for (const p of upcoming) { const k = `${tagOf(p.sport)}|${p.player.toLowerCase()}|${T.statKind(p.market)}|${p.market.replace(/\D/g, '')}`; (byPlayer.get(k) || byPlayer.set(k, []).get(k)).push(p); }
  const multi = [...byPlayer.values()].find(g => new Set(g.map(p => p.matchTag)).size > 1);
  const appOf = p => (p.udLine != null ? 'underdog' : p.lineSource === 'pp' ? 'prizepicks' : 'sleeper');
  const lineOf = (p, app) => app === 'underdog' ? p.udLine : app === 'sleeper' ? p.sleeperLine : p.ppLine;
  const usedPlayers = new Set(multi ? [multi[0].player] : []);
  const single = upcoming.filter(p => !byPlayer.get(`${tagOf(p.sport)}|${p.player.toLowerCase()}|${T.statKind(p.market)}|${p.market.replace(/\D/g, '')}`) || byPlayer.get(`${tagOf(p.sport)}|${p.player.toLowerCase()}|${T.statKind(p.market)}|${p.market.replace(/\D/g, '')}`).length === 1);
  const pickLegs = [];
  const seenMatch = new Set();
  for (const p of single) { if (pickLegs.length >= 3) break; if (usedPlayers.has(p.player) || seenMatch.has(p.matchTag)) continue; seenMatch.add(p.matchTag); usedPlayers.add(p.player); pickLegs.push(p); }
  const legText = (p, side, withOpp) => { const app = appOf(p); const opp = M.pickOpponent(p); return `${p.player} ${side} ${lineOf(p, app)} ${p.market} ${tagOf(p.sport)}${withOpp && opp ? ` (vs ${opp})` : ''}`; };
  const blocks = [];
  if (pickLegs.length) blocks.push(`${S.appLabel(appOf(pickLegs[0]))} ${pickLegs.length}-pick $10\n` + pickLegs.map((p, i) => legText(p, i % 2 ? 'Under' : 'Over', i === 0)).join('\n'));
  if (multi) {
    const [a, b] = multi.slice(0, 2);
    blocks.push(`${S.appLabel(appOf(a))} 2-pick $5\n${legText(a, 'Over', true)}\n${legText(b, 'Under', false)}\n${legText(b, 'Over', true).replace(/\(vs .*\)/, '(vs Nobody United)')}`);
  }
  blocks.push(`Underdog 2-pick $5\nNoSuchPlayer Over 20.5 MAPS 1-2 Kills CS\n${pickLegs[0] ? legText(pickLegs[0], 'Over', true).replace(/Kills|kills/, 'Deaths') : 'x'}`);
  const text = blocks.join('\n\n');
  save('pasted-slip.txt', text);
  const { slips, skipped } = S.parseSlips(text, { now: Date.now() });
  const reqs = S.gradeRequest(slips, undefined, {});
  save('requests.json', { skipped, reqs });
  const post = async n => { const r = await get('/api/slips/grade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legs: reqs }) }); let j; try { j = JSON.parse(r.body); } catch { j = { error: r.body.slice(0, 300) }; } save(`grade-${n}.json`, { status: r.status, ...j }); return j; };
  const g1 = await post(1);
  save('slips.json', slips);
  for (const k of ['/api/esports/auto-slips']) save(`snap/${k.split('/').pop()}-1.json`, (await get(k)).body);
  await sleep(+(process.env.MINS || 14) * 60e3);
  const g2 = await post(2);
  for (const [n, p] of [['auto-slips', '/api/esports/auto-slips'], ['record', '/api/slips/record'], ['status', '/api/status'], ['picks2', '/api/esports/picks']]) save(`snap/${n}.json`, (await get(p)).body);
  console.log('A done', JSON.stringify(Object.values(g1.results || {}).map(r => [r.status, r.reason, r.matchUncertain])));
}

// B: finished matches the production record graded, replayed through MY SLIPS' tracker and the same graders
async function partB() {
  const axios = require('../app/node_modules/axios');
  const G = App('graders');
  const rows = ((await (await fetch(`${PROD}/api/tracker/picks?status=graded&limit=1000`)).json()).picks || [])
    .filter(r => r.outcome && r.result != null && r.maps && Date.parse(r.startTime) > Date.now() - 4 * 86400e3 && ['CS', 'LOL', 'VAL'].includes(r.sport) && r.stat !== 'fantasy');
  const per = {}; const chosen = [];
  for (const r of rows.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))) { per[r.sport] = (per[r.sport] || 0) + 1; if (per[r.sport] <= 8) chosen.push(r); }
  const normalizeName = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parseMapSpan = t => { const m = String(t || '').toUpperCase().replace(/(\d)\s+(\d)/g, '$1+$2').match(/(?:MAPS?|GAMES?)\s*([\d\s+\-–]+)/); if (!m) return { count: 1, label: '1' }; const nums = m[1].replace(/\s+/g, '').split(/[+\-–]/).map(n => parseInt(n)).filter(Number.isFinite); return nums.length > 1 ? { count: Math.max(...nums) - Math.min(...nums) + 1, label: `${Math.min(...nums)}-${Math.max(...nums)}` } : { count: 1, label: String(nums[0] || 1) }; };
  let clock = Date.now();
  const tracker = T.createTracker({ store: T.createMemoryStore(), normalizeName, parseMapSpan, minEv: -1000, idSuffix: p => p.slipKey, now: () => clock, fairProb: () => 0.5, gradeAfterMs: 0,
    graders: { LOL: G.createLoLGraderChain(G.createLoLesportsGrader(axios), G.createLoLGrader(axios)), CS: G.createCsGrader(axios), VAL: G.createValGrader(axios) } });
  const log = E.createEsSlipLog({ tracker, normalizeName, parseMapSpan, now: () => clock });
  const out = [];
  for (const r of chosen) {
    clock = Date.parse(r.startTime) - 3 * 3600e3;
    const pick = { sport: r.sport, player: r.player, team: r.team, market: r.market, displayMarket: r.displayMarket || r.market, lineSource: 'pp', ppLine: r.signalLine, udLine: null, sleeperLine: null,
      startTime: r.startTime, matchTitle: r.matchTitle, gameId: r.gameId, matchTag: r.matchTag || null, marketPred: r.marketPred ?? r.signalLine, context: null };
    const leg = { id: r.id, app: 'prizepicks', sport: r.sport, player: r.player, market: r.market, side: r.signalSide === 'OVER' ? 'Over' : 'Under', line: r.signalLine, betAt: new Date(clock).toISOString() };
    const g0 = await log.grade([leg], { picks: [pick] });
    clock = Date.parse(r.startTime) + 60e3; await tracker.lockStarted();
    clock = Date.parse(r.startTime) + 6 * 3600e3;
    let g = null;
    for (let i = 0; i < 3 && !(g && g.final); i++) { await tracker.gradeDue({ limit: 50 }); g = (await log.grade([leg], { picks: [pick] })).results[r.id]; }
    out.push({ player: r.player, sport: r.sport, market: r.market, line: r.signalLine, side: r.signalSide, prod: { outcome: r.outcome, result: r.result }, mine: { status: g?.status, outcome: g?.outcome, result: g?.result, note: g?.voidReason }, first: g0.results[r.id]?.status });
    save('replay.json', out);
  }
  const agree = out.filter(o => o.mine.outcome && o.mine.outcome === o.prod.outcome && o.mine.result === o.prod.result).length;
  console.log(`B: ${agree} of ${out.length} agree with production`);
  save('replay-summary.json', { agree, total: out.length, notGraded: out.filter(o => !o.mine.outcome).length });
}

(async () => {
  try { await Promise.all([process.env.SKIP_A ? Promise.resolve() : partA(), partB().catch(e => save('replay-error.txt', String(e.stack || e)))]); } catch (e) { save('error.txt', String(e.stack || e)); }
  srv.kill(); process.exit(0);
})();
