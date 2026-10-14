// Sports side check: poll the live +EV tab, sports PROPS board and Best Plays
// every 60 s, and each time read the books ourselves to spot-check them.
const fs = require('fs');
const axios = require('axios');
const pingames = require('../pingames'), pinprops = require('../pinprops'), freebooks = require('../freebooks'), ev = require('../ev');
const P = process.env.BASE || 'https://line-reaper-backend-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const t = Date.now(); try { const r = await fetch(P + p, { signal: AbortSignal.timeout(90000) }); const tx = await r.text(); let j = null; try { j = JSON.parse(tx); } catch {} return { st: r.status, ms: Date.now() - t, j, tx, len: tx.length }; } catch (e) { return { st: 'ERR ' + e.message, ms: Date.now() - t, j: null, tx: '' }; } };
const EP = ['/api/status', '/api/ev?limit=1000&minEv=-100', '/api/props/board?sport=SPORTS&sort=ev&limit=500&priced=1', '/api/best?limit=500', '/api/props/record', '/api/ev/record', '/api/ev/record/bets?limit=300'];
const canon = ev.canonName;
async function udIndex() {
  try {
    const d = (await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000 })).data;
    const pl = Object.fromEntries((d.players || []).map(p => [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name]));
    const ap = Object.fromEntries((d.appearances || []).map(a => [a.id, a.player_id]));
    const idx = new Map();
    for (const l of d.over_under_lines || []) {
      const as = l.over_under?.appearance_stat || {};
      const name = pl[ap[as.appearance_id]];
      if (!name) continue;
      const k = canon(name);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ stat: as.display_stat, line: +l.stat_value, status: l.status, opts: (l.options || []).map(o => [o.choice, o.payout_multiplier, o.status]) });
    }
    return idx;
  } catch (e) { return { err: e.message }; }
}
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const N = +(process.env.N || 15);
  for (let i = 0; i < 30 && process.env.WAITVER; i++) { const s = await get('/api/status'); if (s.j?.version === process.env.WAITVER) break; await wait(60e3); }
  await wait(+(process.env.SETTLE || 0) * 60e3);
  for (let i = 0; i < N; i++) {
    const at = new Date().toISOString();
    const [R, fresh] = await Promise.all([Promise.all(EP.slice(0, 4).map(get)), (async () => {
      const t0 = Date.now();
      try {
        const pin = await pingames.fetchPinnacleGames(axios, { sports: { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball } });
        const pp = await pinprops.fetchPinnacleProps(axios);
        const fb = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps: pp.props, fdProps: true });
        const feeds = Object.entries(fb.games).map(([s, games]) => ({ sport: s, label: 'free-odds', games, updated: new Date().toISOString() }));
        const rows = ev.screen({ feeds, minEv: -100 });
        return { rows, ms: Date.now() - t0, errors: [...pin.errors, ...pp.errors, ...fb.errors], counts: fb.counts, pinProps: pp.props.length, ud: await udIndex() };
      } catch (e) { return { err: e.message }; }
    })()]);
    const [st, evr, board, best] = R;
    const freshBy = new Map((fresh.rows || []).map(r => [ev.rowKey(r), r]));
    // freshest sharp side: same group and side, any book
    const fairBy = new Map((fresh.rows || []).map(r => [`${r.group}|${r.side}`, r.fairProb]));
    const evRows = (evr.j?.rows || []).filter(r => !r.dfs && r.ev >= 0);
    const evCheck = evRows.map(r => { const f = freshBy.get(ev.rowKey(r)); return { key: ev.rowKey(r), sport: r.sport, ev: r.ev, price: r.price, fair: r.fairProb, start: r.start, upd: r.updated, sharp: r.sharpBooks, src: r.source,
      freshPrice: f ? f.price : null, freshFair: fairBy.get(`${r.group}|${r.side}`) ?? null, freshEv: f ? f.ev : null }; });
    const flagged = (board.j?.rows || []).filter(r => r.best && r.best.ev >= 0);
    const ud = fresh.ud instanceof Map ? fresh.ud : null;
    const boardCheck = flagged.map(r => { const b = r.best, c = r.books[b.book] || {};
      const udHit = b.book === 'underdog' && ud ? (ud.get(canon(r.player)) || []).filter(x => x.line === c.line) : null;
      return { sport: r.sport, player: r.player, market: r.market, start: r.startTime, book: b.book, line: c.line, side: b.side, ev: b.ev, kind: b.kind, src: b.source, pin: r.pinnacle || null,
        books: Object.fromEntries(Object.entries(r.books).map(([k, x]) => [k, [x.line, x.over, x.under, x.overOpen, x.underOpen]])), udNow: udHit }; });
    const row = { at, st: R.map(r => r.st), ms: R.map(r => r.ms), ver: st.j?.version, freeBooks: st.j?.freeBooks ? { updated: st.j.freeBooks.updated, ms: st.j.freeBooks.ms, errors: st.j.freeBooks.errors } : null,
      pinProps: st.j?.pinnacleProps || st.j?.pinProps || null, evUpdated: evr.j?.updated, evCount: evr.j?.count, evFeeds: evr.j?.feeds, boardUpdated: board.j?.updated, boardTotal: board.j?.total, boardCounts: board.j?.counts,
      bestCounts: best.j?.counts, bestRows: (best.j?.rows || []).map(x => [x.type || x.kind, x.title || x.what || x.label, x.book || x.venue, x.ev ?? x.edge, x.price, x.start]).slice(0, 60),
      fresh: { ms: fresh.ms, err: fresh.err, errors: fresh.errors, counts: fresh.counts, pinProps: fresh.pinProps, rows: (fresh.rows || []).filter(r => r.ev >= 0).length, ud: ud ? ud.size : fresh.ud?.err },
      evCheck, boardCheck };
    fs.appendFileSync('out/poll.jsonl', JSON.stringify(row) + '\n');
    if (i < N - 1) await wait(60e3);
  }
  fs.mkdirSync('out/snap', { recursive: true }); const index = {};
  for (const p of EP) { const r = await get(p); const f = p.replace(/[^a-z0-9]+/gi, '_') + '.json'; fs.writeFileSync('out/snap/' + f, r.tx); index[p] = { st: r.st, f, bytes: r.len, ms: r.ms }; }
  fs.writeFileSync('out/snap/index.json', JSON.stringify(index, null, 1));
})();
