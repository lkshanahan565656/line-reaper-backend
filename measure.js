// Retained heap of the exchange scan's rows and the tail CLV cache entries,
// measured with real Kalshi and Polymarket pages. Run with --expose-gc from the app checkout.
const axios = require('axios');
const xarb = require('./app/xarb');
const tail = require('./app/tail');
const MB = b => Math.round(b / 1048576 * 10) / 10;
const used = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const http = { get: async (u, c) => { await sleep(250); return axios.get(u, c); } };
(async () => {
  const base = used();
  const kalshi = [], polymarket = [], pmRaw = [];
  const [k, p] = await Promise.all([
    xarb.fetchKalshiEvents(http, { onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) }),
    xarb.fetchPolymarketEvents(http, { onPage: page => { polymarket.push(...xarb.parsePolymarketBinaries(page)); for (const e of page) for (const m of e.markets || []) if (pmRaw.length < 3000) pmRaw.push(m); } }),
  ]);
  const raw = used() - base;
  console.log(`kalshi rows ${kalshi.length} (${k.pages} pages, errors ${k.errors.length}), polymarket rows ${polymarket.length}`);
  const len = (rows, f) => rows.reduce((a, r) => a + (r[f] ? String(r[f]).length : 0), 0);
  for (const f of ['rules', 'title', 'eventTitle', 'url', 'outcomeLabel', 'description', 'question'])
    console.log(`field ${f}: kalshi ${MB(len(kalshi, f))} MB chars, polymarket ${MB(len(polymarket, f))} MB chars`);
  console.log(`retained kalshi+polymarket rows: ${MB(raw)} MB`);
  const kOnly = (() => { const b = used(); const copy = kalshi.map(r => ({ ...r })); const d = used() - b; copy.length = 0; return d; })();
  console.log(`a second copy of the kalshi rows (objects only, shared strings): ${MB(kOnly)} MB`);
  const b1 = used(); for (const r of kalshi) delete r.rules; for (const r of polymarket) delete r.rules; const afterRules = b1 - used();
  console.log(`freed by dropping rules: ${MB(afterRules)} MB`);
  const b2 = used();
  const titles = new Map(kalshi.map(r => [r.id, { title: r.outcomeLabel && !r.title.toLowerCase().includes(r.outcomeLabel.toLowerCase()) ? `${r.title} · ${r.outcomeLabel}` : r.title, eventTicker: r.eventKey.replace(/^kalshi:/, '') }]));
  console.log(`kalshiTitles map (${titles.size}): ${MB(used() - b2)} MB`);
  // the tail CLV cache: parsed Gamma market vs the slim entry
  const b3 = used(); const full = pmRaw.map(tail.parseGammaMarket); const fullB = used() - b3;
  const b4 = used(); const slim = full.map(m => tail.clvMarketOf ? tail.clvMarketOf(m) : null); const slimB = used() - b4;
  console.log(`gamma markets ${full.length}: parsed ${Math.round(fullB / full.length)} B each, slim ${Math.round(slimB / full.length)} B each; at 50,000 cached: ${MB(fullB / full.length * 50000)} MB vs ${MB(slimB / full.length * 50000)} MB`);
  console.log('heap now', MB(process.memoryUsage().heapUsed), 'MB; keep refs', titles.size + slim.length + full.length > 0);
})().catch(e => { console.error(e); process.exit(1); });
