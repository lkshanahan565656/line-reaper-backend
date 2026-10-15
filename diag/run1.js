// node diag/run1.js <server module> <label>: the esports board and props board from out/raw.json
const [mod, label] = process.argv.slice(2);
process.env.LR_DATA_DIR = `/tmp/lr-sd-${label}`;
for (const k of ['DATABASE_URL', 'ALERT_WEBHOOK_URL']) delete process.env[k];
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
const fs = require('fs'); fs.mkdirSync(process.env.LR_DATA_DIR, { recursive: true });
const raw = JSON.parse(fs.readFileSync('out/raw.json', 'utf8'));
const S = require(mod);
const http = require('http');
(async () => {
  const now = Date.now();
  S.cache.underdog = { data: raw.ud || [], updated: raw.at };
  S.cache.prizepicks = { data: raw.pp || [], updated: raw.at };
  S.cache.sleeper = { data: raw.sl || [], updated: raw.at };
  const leagues = {}; for (const l of raw.pp || []) if (l.leagueId) leagues[l.leagueId] = now;
  Object.assign(S.ppState, { fullOkAt: now, leagueOkAt: leagues });
  const t0 = Date.now();
  const picks = await S.generateEsportsPicks();
  S.esportsCache.picks = picks; S.esportsCache.updated = new Date().toISOString();
  const ms = Date.now() - t0;
  // the CS teams in two or three matches today, from the raw lines
  const esm = require('../esmatch');
  const tags = esm.matchTags([...(raw.ud || []), ...(raw.pp || []), ...(raw.sl || [])], { playerOf: l => S.normalizeName(l.player), sportOf: l => (/CS/i.test(l.sport) ? 'CS' : l.sport) });
  const per = new Map();
  for (const [l, t] of tags) if (t) { const k = S.normalizeName(l.player); (per.get(k) || per.set(k, new Set()).get(k)).add(t); }
  const multi = new Set([...per].filter(([, s]) => s.size > 1).map(([k]) => k));
  const mine = picks.filter(p => multi.has(S.normalizeName(p.player))).map(p => ({ player: p.player, team: p.team, market: p.market, matchTitle: p.matchTitle, start: p.startTime, gameId: p.gameId,
    matchTag: p.matchTag ?? null, pp: p.ppLine, ud: p.udLine, sl: p.sleeperLine, side: p.side, prob: p.prob, bestBook: p.bestBook, bestEv: p.bestEv, fair: p.fairSource, marketPred: p.marketPred, opp: p.context?.opponent ?? p.matchup?.opponent ?? null, quotes: p.marketQuotes }));
  // serve the app's endpoints for the renders
  const srv = http.createServer(S.app).listen(0);
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port, api = {};
  for (const p of ['/api/esports/picks', '/api/esports/matches', '/api/status', '/api/props/board?sport=ESPORTS&limit=500', '/api/props/coverage', '/api/esports/auto-slips', '/api/tracker/picks', '/api/tracker/summary']) {
    try { const r = await fetch(`http://127.0.0.1:${port}${p}`); api[p] = await r.json(); } catch (e) { api[p] = { error: e.message }; }
  }
  const board = api['/api/props/board?sport=ESPORTS&limit=500'];
  const brows = (board.rows || board.data || []).filter(r => multi.has(S.normalizeName(r.player || '')));
  fs.writeFileSync(`out/${label}.json`, JSON.stringify({ label, ms, picks: picks.length, multiPlayers: [...multi], multiPicks: mine, propsRows: brows.length, propsSample: brows.slice(0, 40), split: S.esportsCache.matchSplit || null, sameDay: api['/api/status']?.sameDay || null }));
  fs.mkdirSync(`out/api-${label}`, { recursive: true });
  for (const [p, v] of Object.entries(api)) fs.writeFileSync(`out/api-${label}/${encodeURIComponent(p)}.json`, JSON.stringify(v));
  if (label === 'after') {
    // the live record rows through this version's same-day check
    const live = JSON.parse(fs.readFileSync('out/live.json', 'utf8'));
    const rows = (live['/api/tracker/picks?limit=1000']?.picks || []).filter(r => Date.parse(r.startTime) >= Date.parse('2026-10-13T00:00:00Z'));
    const exp = esm.multiMatchRows(rows);
    const hit = rows.filter(r => exp.has(r) && r.status !== 'void');
    fs.writeFileSync('out/record-check.json', JSON.stringify({ rows: rows.length, exposed: hit.length, graded: hit.filter(r => r.status === 'graded').length,
      byStatus: hit.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
      graded2: hit.filter(r => r.status === 'graded').map(r => ({ id: r.id, player: r.player, team: r.team, title: r.matchTitle, start: r.startTime, outcome: r.outcome, profit: r.profit, clv: r.clv, signalBook: r.signalBook, signalLine: r.signalLine, signalLines: r.signalLines, closeLines: r.closeLines, result: r.result })) }));
  }
  console.log(label, 'picks', picks.length, 'multi players', multi.size, 'their picks', mine.length, 'props rows', brows.length, 'ms', ms);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
