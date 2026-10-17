// Saturday read: prod's own board (book-consensus legs by league), the props
// record for that kind, the close scoreboard, Best Plays and alerts kinds.
const fs = require('fs');
const P = 'https://line-reaper-backend-production.up.railway.app';
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(180000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const pb = require('../propsboard');
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
const save = (n, d) => fs.writeFileSync('out/' + n, JSON.stringify(d));
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const st = await get(P + '/api/status'); save('status.json', st);
  say(`prod ${st.version} at ${new Date().toISOString()}`);
  const rows = []; for (let off = 0; off < 80000; off += 500) { const d = await get(`${P}/api/props/board?sport=SPORTS&sort=start&limit=500&offset=${off}`); rows.push(...(d.rows || [])); if (!d.rows || d.rows.length < 500) break; }
  save('board.json', rows);
  const L = {};
  for (const r of rows) for (const [bk, c] of Object.entries(r.books || {})) {
    const a = (L[r.sport] ||= { legs: 0, sharp: 0, cons: 0, consClear: 0, consPos: 0, bf: 0, bfClear: 0 }); a.legs++;
    const k = pb.legSource(r, c); if (k === 'pinnacle' || k === 'kalshi') a.sharp++;
    if (c.ev?.bookFair === 'consensus') { a.cons++; if (c.ev.ev > 0) a.consPos++; if (c.ev.ev >= 2) a.consClear++; } else if (c.ev?.bookFair) { a.bf++; if (c.ev.ev >= 2) a.bfClear++; }
  }
  say(`board ${rows.length} rows`);
  say('league        legs  sharp  3+books  >0EV  clear2%  FD/BR-fair  clear2%');
  for (const [k, a] of Object.entries(L).sort((x, y) => y[1].legs - x[1].legs)) say(`${k.padEnd(12)} ${String(a.legs).padStart(5)} ${String(a.sharp).padStart(6)} ${String(a.cons).padStart(8)} ${String(a.consPos).padStart(5)} ${String(a.consClear).padStart(8)} ${String(a.bf).padStart(11)} ${String(a.bfClear).padStart(8)}`);
  const used = {}, nDist = {}, apps = {};
  const ex = []; for (const r of rows) for (const [bk, c] of Object.entries(r.books || {})) if (c.ev?.bookFair === 'consensus') { ex.push({ r, bk, c }); nDist[c.ev.n] = (nDist[c.ev.n] || 0) + 1; apps[bk] = (apps[bk] || 0) + 1; for (const s of c.ev.books || []) used[s.book] = (used[s.book] || 0) + 1; }
  say('books in consensus legs ' + JSON.stringify(used) + ' ; per leg ' + JSON.stringify(nDist) + ' ; apps ' + JSON.stringify(apps));
  ex.sort((a, b) => b.c.ev.ev - a.c.ev.ev);
  say('\n== CONSENSUS best EV first');
  for (const { r, bk, c } of ex.slice(0, 40)) say(`${r.sport} ${r.player} ${r.market} ${bk} ${c.ev.side} ${c.line} ev ${c.ev.ev} fair ${c.ev.fair} n${c.ev.n} [${(c.ev.books || []).map(s => `${s.book} ${s.p}${s.price ? ' ' + s.price : ''}`).join(', ')}] start ${r.startTime}`);
  save('cons-legs.json', ex.map(({ r, bk, c }) => ({ sport: r.sport, player: r.player, market: r.market, start: r.startTime, app: bk, cell: c, row: { bookConsensus: r.bookConsensus, best: r.best } })));
  for (const [n, u] of [['scoreboard.json', '/api/ev/scoreboard'], ['props-record.json', '/api/props/record'], ['results.json', '/api/results'], ['best.json', '/api/best'], ['ev-record.json', '/api/ev/record'], ['coverage.json', '/api/props/coverage'], ['alerts.json', '/api/alerts']]) save(n, await get(P + u));
  const picks = []; for (const s of ['open', 'locked', 'graded', 'void']) picks.push(...((await get(`${P}/api/props/record/picks?status=${s}&limit=3000`)).picks || []));
  save('picks.json', picks);
  const bets = async q => (await get(`${P}/api/ev/record/bets?limit=2000&${q}`)).bets || [];
  save('ev-closed.json', await bets('status=closed')); save('ev-open.json', await bets('status=open'));
  save('alt-closed.json', await bets('alt=1&status=closed')); save('stale.json', await bets('stale=1')); save('es.json', await bets('es=1'));
  say('\npicks by kind/status ' + JSON.stringify(picks.reduce((m, p) => { const k = `${p.kind}|${p.status}`; m[k] = (m[k] || 0) + 1; return m; }, {})));
  const bp = await get(P + '/api/best');
  say('Best Plays kinds ' + JSON.stringify((bp.rows || []).reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {})));
  say('done ' + new Date().toISOString());
})();
