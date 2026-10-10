// One-off: what Kalshi's open-events list is made of, and whether filters shrink it.
const axios = require('axios');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 400 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
async function walk(name, extra, maxPages) {
  let cursor = null, pages = 0, n = 0;
  const cats = {}, prefix = {}, series = new Set(), nonSportsSeries = new Set(), firsts = [];
  const t0 = Date.now();
  while (pages < maxPages) {
    const params = { status: 'open', limit: 200, ...extra };
    if (cursor) params.cursor = cursor;
    let r;
    try { r = await http.get(`${K}/events`, { params }); } catch (e) { out(`${name}-error`, { pages, m: e.message, s: e?.response?.status, body: JSON.stringify(e?.response?.data || '').slice(0, 300) }); break; }
    const evs = r.data?.events || [];
    pages++;
    for (const e of evs) {
      n++;
      cats[e.category || 'none'] = (cats[e.category || 'none'] || 0) + 1;
      const p = String(e.series_ticker || '').slice(0, 6); prefix[p] = (prefix[p] || 0) + 1;
      series.add(e.series_ticker);
      if (e.category !== 'Sports') nonSportsSeries.add(e.series_ticker);
    }
    if (pages <= 3 || pages % 25 === 0) firsts.push(`${pages}:${evs[0]?.event_ticker}|${evs[0]?.category}|${(evs[0]?.title || '').slice(0, 50)}`);
    cursor = r.data?.cursor;
    if (!cursor || !evs.length) break;
  }
  const topPrefix = Object.entries(prefix).sort((a, b) => b[1] - a[1]).slice(0, 25);
  out(name, { pages, events: n, ms: Date.now() - t0, cats, series: series.size, nonSportsSeries: nonSportsSeries.size, topPrefix, firsts, keys: null });
}
async function main() {
  const one = await http.get(`${K}/events`, { params: { status: 'open', limit: 5 } });
  out('event-keys', Object.keys(one.data?.events?.[0] || {}));
  out('event-sample', (one.data?.events || []).map(e => ({ t: e.event_ticker, s: e.series_ticker, c: e.category, title: e.title, sub: e.sub_title })));
  for (const [name, extra] of [['mve-exclude', { mve_filter: 'exclude' }], ['with-min-close', { min_close_ts: Math.floor(Date.now() / 1000) + 86400 * 30 }]]) {
    try { const r = await http.get(`${K}/events`, { params: { status: 'open', limit: 200, ...extra } }); out(`probe-${name}`, { n: r.data?.events?.length, first: r.data?.events?.[0]?.event_ticker }); }
    catch (e) { out(`probe-${name}-error`, { s: e?.response?.status, body: JSON.stringify(e?.response?.data || '').slice(0, 300) }); }
  }
  await walk('open-all', {}, 400);
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
