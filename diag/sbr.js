// Runs this branch's server on live feeds (PINNACLE=on) for ~13 min, then snapshots the sports views
// and checks its +EV rows against FanDuel, BetRivers and Pinnacle read directly at that moment.
const fs = require('fs'); const { spawn } = require('child_process');
const axios = require('axios');
const pingames = require('../pingames'), pinprops = require('../pinprops'), freebooks = require('../freebooks'), ev = require('../ev');
const B = 'http://localhost:3999';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { try { const r = await fetch(B + p, { signal: AbortSignal.timeout(120000) }); return { st: r.status, tx: await r.text() }; } catch (e) { return { st: 'ERR', tx: JSON.stringify({ error: e.message }) }; } };
const EP = ['/api/status', '/api/props/board?sport=SPORTS&sort=ev&limit=500&priced=1', '/api/props/board?sport=SPORTS&sort=ev&limit=150', '/api/props/board?sport=SPORTS&sort=ev&limit=150&sharp=1', '/api/best?limit=500', '/api/props/record', '/api/results'];
(async () => {
  fs.mkdirSync('out/snap', { recursive: true }); fs.mkdirSync('/tmp/lr', { recursive: true });
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3999', LR_DATA_DIR: '/tmp/lr', PINNACLE: 'on' }, stdio: ['ignore', fs.openSync('out/server.log', 'w'), fs.openSync('out/server.err', 'w')] });
  const polls = [];
  for (let i = 0; i < 14; i++) {
    await wait(60e3);
    const [st, e] = await Promise.all([get('/api/status'), get('/api/ev?limit=1000')]);
    let S = {}, E = {}; try { S = JSON.parse(st.tx); } catch {} try { E = JSON.parse(e.tx); } catch {}
    const c = {}; for (const r of E.rows || []) { const k = (r.dfs ? 'dfs ' : '') + r.book; c[k] = (c[k] || 0) + 1; }
    polls.push({ at: new Date().toISOString(), fb: S.freeBooks && { updated: S.freeBooks.updated, gamesAt: S.freeBooks.gamesAt, errors: S.freeBooks.errors }, pin: S.pinnacleProps && { updated: S.pinnacleProps.updated, props: S.pinnacleProps.props }, evCount: E.count, byBook: c });
  }
  // fresh read, then the server's rows right after
  const pin = await pingames.fetchPinnacleGames(axios, { sports: { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball } });
  const pp = await pinprops.fetchPinnacleProps(axios);
  const fb = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps: pp.props, fdProps: true });
  const fresh = ev.screen({ feeds: Object.entries(fb.games).map(([s, games]) => ({ sport: s, label: 'free-odds', games })), minEv: -100 });
  const freshBy = new Map(fresh.map(r => [ev.rowKey(r), r]));
  const index = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.tx.length }; }
  let E = {}; try { E = JSON.parse(fs.readFileSync('out/snap/' + index['/api/ev?limit=1000'].f)); } catch {}
  const check = (E.rows || []).filter(r => !r.dfs).map(r => { const f = freshBy.get(ev.rowKey(r)); return [ev.rowKey(r), r.ev, r.price, r.fairProb, f ? f.price : null, f ? f.fairProb : null]; });
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
  fs.writeFileSync('out/polls.json', JSON.stringify({ polls, check }, null, 1));
  srv.kill();
})();
