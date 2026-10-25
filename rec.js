// Records a few Sharp Tail wallets' raw data API answers (settled, open, trades),
// exactly what scoreOne reads, for an identical-scores test.
const tail = require('./app/tail');
const fs = require('fs'), zlib = require('zlib');
const http = { async get(url, { params = {} } = {}) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  for (let i = 0; i < 4; i++) {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 3000 * (i + 1))); continue; }
    if (!r.ok) throw Object.assign(new Error(`status ${r.status}`), { response: { status: r.status } });
    return { data: await r.json() };
  }
  throw new Error('429s');
} };
(async () => {
  const o = tail.resolveOptions({});
  const lb = await tail.fetchLeaderboard(http, {});
  console.log('leaderboard', lb.rows.length, lb.errors.length);
  const picks = lb.rows.sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 14);
  const wallets = [];
  for (const c of picks) {
    try {
      const settled = await tail.fetchSettledPositions(http, c.wallet, { pageSize: o.closedPageSize, maxPages: o.closedMaxPages });
      const open = await tail.fetchOpenPositions(http, c.wallet, { maxPages: o.openMaxPages });
      const trades = await tail.fetchWalletTrades(http, c.wallet, { limit: o.walletTradeLimit });
      wallets.push({ wallet: c.wallet, name: c.name, sources: c.sources, closed: settled.rows, open: open.rows, trades });
      console.log(c.wallet.slice(0, 8), settled.rows.length, open.rows.length, trades.length);
    } catch (e) { console.log('fail', e.message); }
  }
  // the heaviest few plus a couple of small ones, so the fixture stays small
  wallets.sort((a, b) => b.closed.length + b.open.length - a.closed.length - a.open.length);
  const keep = [...wallets.slice(0, 4), ...wallets.slice(-3)];
  fs.writeFileSync('tailrec.json.gz', zlib.gzipSync(JSON.stringify({ at: new Date().toISOString(), now: Date.now(), wallets: keep })));
  console.log('kept', keep.map(w => w.closed.length + w.open.length));
})();
