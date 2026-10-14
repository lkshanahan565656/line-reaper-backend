// Runs this branch's server on live feeds (PINNACLE=on) ~14 min, snapshots what Best Plays reads,
// and checks each new Best Plays prop row against its source (props board / +EV rows) and, for
// sportsbook props, against FanDuel / BetRivers / Pinnacle read directly at that moment.
const fs = require('fs'); const { spawn } = require('child_process');
const axios = require('axios');
const pingames = require('../pingames'), pinprops = require('../pinprops'), freebooks = require('../freebooks'), ev = require('../ev');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const EP = ['/api/status', '/api/best?limit=500', '/api/ev?limit=1000', '/api/props/board?sport=SPORTS&sort=ev&limit=500&priced=1', '/api/props/record', '/api/results'];
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < 14; i++) {
    await wait(60e3);
    const b = await get('/api/best?limit=500'); let d = {}; try { d = JSON.parse(b.tx); } catch {}
    polls.push({ at: new Date().toISOString(), st: b.st, total: d.total, counts: d.counts });
  }
  const pin = await pingames.fetchPinnacleGames(axios, { sports: { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball } });
  const pp = await pinprops.fetchPinnacleProps(axios);
  const fb = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps: pp.props, fdProps: true });
  const fresh = ev.screen({ feeds: Object.entries(fb.games).map(([s, games]) => ({ sport: s, label: 'free-odds', games })), minEv: -100 });
  const freshBy = new Map(fresh.map(r => [ev.rowKey(r), r]));
  const snap = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); try { snap[p] = JSON.parse(r.tx); } catch { snap[p] = {}; } }
  const best = snap['/api/best?limit=500'], evRows = snap['/api/ev?limit=1000'].rows || [], board = snap['/api/props/board?sport=SPORTS&sort=ev&limit=500&priced=1'].rows || [];
  const evBy = new Map(evRows.map(r => [ev.rowKey(r), r]));
  const bookProps = (best.rows || []).filter(r => r.kind === 'bookProp').map(r => {
    const key = r.id.slice('bprop:'.length); const e = evBy.get(key), f = freshBy.get(key);
    return { key, bet: r.bet, title: r.title, ev: r.ev, american: r.american, units: r.units, verdict: r.verdict, why: r.why, inEv: !!e, evPrice: e?.price, freshPrice: f?.price ?? null, freshFair: f?.fairProb ?? null, freshEv: f?.ev ?? null };
  });
  const boardBy = new Map(board.map(r => [`${r.sport}|${ev.canonName(r.player)}|${r.mkey}`, r]));
  const sportsProps = (best.rows || []).filter(r => r.kind === 'sportsProp').map(r => {
    const parts = r.id.split('|'); const row = r.id.startsWith('sprop:') ? boardBy.get(`${parts[0].slice(6)}|${parts[1]}|${parts[2]}`) : null;
    const cell = row && row.books && row.books[parts[3]];
    return { id: r.id, bet: r.bet, title: r.title, venue: r.venue, ev: r.ev, verdict: r.verdict, why: r.why, onBoard: !!row, cellLine: cell?.line ?? null, cellEv: cell?.ev ?? null, rowBest: row?.best ?? null, pinnacle: row?.pinnacle ?? null };
  });
  fs.writeFileSync('out/check.json', JSON.stringify({ polls, counts: best.counts, total: best.total, dropped: best.dropped, bookProps, sportsProps, sources: snap['/api/results'].sources, propsRecord: snap['/api/props/record'].overall }, null, 1));
  srv.kill();
})();
