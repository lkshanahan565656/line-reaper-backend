// One-off: can a politics signal find its Kalshi market through the series list?
const axios = require('axios');
const xarb = require('../xarb');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 350 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 4) { await sleep(3000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const SLUGS = ['texas-senate-election-winner', 'israel-election-likud-of-seats', 'israel-x-iran-ceasefire-continues-throughptptpt-20260716224448963',
  'us-announces-end-of-iranian-blockade-byptptpt-20260713152715080', 'maine-senate-election-winner', 'fed-decision-in-october'];
const STOP = new Set('a an the will be is are of in on at to for by and or with from as who what which when how win wins winner election race 2025 2026 2027 next us by-election than more less after before party yes no'.split(' '));
const words = s => [...new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
async function main() {
  const series = ((await http.get(`${K}/series`)).data?.series || []).filter(s => s.category !== 'Sports');
  const df = new Map();
  for (const s of series) { s.w = words(`${s.title} ${(s.tags || []).join(' ')}`); for (const w of s.w) df.set(w, (df.get(w) || 0) + 1); }
  out('series', { n: series.length, sampleKeys: Object.keys(series[0] || {}) });
  const idf = w => Math.log(series.length / (1 + (df.get(w) || 0)));
  for (const slug of SLUGS) {
    let ev;
    try { ev = (await axios.get('https://gamma-api.polymarket.com/events', { params: { slug }, timeout: 20000 })).data?.[0]; } catch (e) { out(`gamma-error-${slug}`, e.message); continue; }
    if (!ev) { out(`gamma-missing-${slug}`, null); continue; }
    const pm = xarb.parsePolymarketBinaries([ev]);
    const want = new Set(words(`${ev.title} ${(ev.markets || []).slice(0, 3).map(m => m.question).join(' ')}`));
    const scored = series.map(s => ({ s, score: s.w.filter(w => want.has(w)).reduce((a, w) => a + idf(w), 0), hits: s.w.filter(w => want.has(w)) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    out(`candidates-${slug}`, { pmTitle: ev.title, pmRows: pm.length, pmSample: pm.slice(0, 4).map(r => `${r.kind}|${r.title}|${r.outcomeLabel}|close=${r.closeTime}|yes=${r.yesAsk}`),
      want: [...want], top: scored.map(x => `${x.s.ticker}|${x.s.category}|${x.s.title}|${x.score.toFixed(1)}|${x.hits.join(',')}`) });
    const kalshi = [];
    for (const { s } of scored.slice(0, 5)) {
      try {
        const r = await http.get(`${K}/events`, { params: { status: 'open', series_ticker: s.ticker, with_nested_markets: true, limit: 200 } });
        const evs = r.data?.events || [];
        const rows = xarb.parseKalshiBinaries({ events: evs, cursor: '' });
        kalshi.push(...rows);
        out(`kalshi-${slug}-${s.ticker}`, { events: evs.length, rows: rows.length, sample: rows.slice(0, 8).map(k => `${k.id}|${k.kind}|${k.title}|${k.outcomeLabel}|close=${k.closeTime}|y=${k.yesAsk}/n=${k.noAsk}`) });
      } catch (e) { out(`kalshi-error-${s.ticker}`, e.message); }
    }
    const m = xarb.matchMarkets(kalshi, pm, { now: Date.now() });
    out(`matches-${slug}`, m.map(x => `${x.by}|${x.similarity}|PM ${x.polymarket.title} [${x.polymarket.outcomeLabel}] ⇄ K ${x.kalshi.id} ${x.kalshi.title} [${x.kalshi.outcomeLabel}] same=${x.same}`));
    // near misses: best similarity per PM row regardless of the other checks
    const near = [];
    for (const p of pm.filter(r => r.kind === 'yesno').slice(0, 6)) {
      let best = null;
      for (const k of kalshi.filter(r => r.kind === 'yesno')) {
        const pk = xarb.titleKey(`${p.title} ${p.outcomeLabel && !/^yes$/i.test(p.outcomeLabel) ? p.outcomeLabel : ''}`), kk = xarb.titleKey(`${k.title} ${k.outcomeLabel && !/^yes$/i.test(k.outcomeLabel) ? k.outcomeLabel : ''}`);
        const sim = xarb.titleSimilarity(pk, kk);
        let inter = 0; for (const w of pk.words) if (kk.words.has(w)) inter++;
        const j = inter / (pk.words.size + kk.words.size - inter || 1);
        if (!best || j > best.j) best = { j: +j.toFixed(2), sim, k: `${k.id}|${k.title}|${k.outcomeLabel}|close=${k.closeTime}`, sigs: `${pk.sig} vs ${kk.sig}`, closeP: p.closeTime };
      }
      near.push({ p: `${p.title}|${p.outcomeLabel}`, best });
    }
    out(`near-${slug}`, near);
  }
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
