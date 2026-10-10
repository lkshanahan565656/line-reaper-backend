// One-off: what the Kalshi scan misses (series by category, the open-events list order, UFC and politics) and Polymarket US's leagues.
const axios = require('axios');
const xarb = require('../xarb');
const http = { get: (url, opts = {}) => axios.get(url, { timeout: 30000, ...opts }) };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  try {
    const lg = await http.get('https://gateway.polymarket.us/v2/leagues', { params: { limit: 100 } });
    const list = lg.data?.leagues || lg.data || [];
    out('pmus-leagues', (Array.isArray(list) ? list : []).map(x => `${x.slug}:${x.name || ''}${x.isOperational === false ? '(off)' : ''}`));
  } catch (e) { out('pmus-leagues-error', e.message); }
  // all series (no category filter), counted by category
  const all = (await http.get(`${K}/series`)).data?.series || [];
  const byCat = {};
  for (const s of all) byCat[s.category || 'none'] = (byCat[s.category || 'none'] || 0) + 1;
  out('series-by-category', { total: all.length, byCat });
  const sports = all.filter(s => s.category === 'Sports').map(s => s.ticker);
  out('sports-series-not-game', { n: sports.filter(t => !/(GAME|MATCH|TOTAL|SPREAD)$/i.test(t)).length,
    fightish: sports.filter(t => /FIGHT|UFC|BOX|MMA|BOUT|PFL/i.test(t)), sample: sports.filter(t => !/(GAME|MATCH|TOTAL|SPREAD)$/i.test(t)).slice(0, 150) });
  const pol = all.filter(s => /politic|election|world|econom/i.test(s.category || ''));
  out('politics-series-sample', pol.slice(0, 60).map(s => `${s.ticker}|${s.category}|${(s.title || '').slice(0, 60)}`));
  out('texas', all.filter(s => /texas|tx/i.test(`${s.ticker} ${s.title}`) && /senat/i.test(`${s.ticker} ${s.title}`)).map(s => `${s.ticker}|${s.category}|${s.title}`));
  out('israel-iran', all.filter(s => /israel|iran|likud|knesset|ceasefire/i.test(`${s.ticker} ${s.title}`)).map(s => `${s.ticker}|${s.category}|${s.title}`));
  // the open-events list: how many pages, what order, which categories
  let cursor = null, pages = 0, cats = {}, firsts = [];
  const seenSeries = new Set();
  while (pages < 120) {
    const params = { status: 'open', limit: 200 };
    if (cursor) params.cursor = cursor;
    const r = await http.get(`${K}/events`, { params });
    const evs = r.data?.events || [];
    pages++;
    for (const e of evs) { cats[e.category || 'none'] = (cats[e.category || 'none'] || 0) + 1; seenSeries.add(e.series_ticker); }
    if (pages % 10 === 1) firsts.push(`${pages}:${evs[0]?.event_ticker}|${evs[0]?.category}`);
    cursor = r.data?.cursor;
    if (!cursor || !evs.length) break;
    await sleep(120);
  }
  out('open-events', { pages, total: Object.values(cats).reduce((a, b) => a + b, 0), cats, firsts, series: seenSeries.size });
  // per-series reads for the politics series: how many have open events
  let withOpen = 0, events = 0, reads = 0;
  const t0 = Date.now();
  for (const s of pol.slice(0, 400)) {
    try {
      const r = await http.get(`${K}/events`, { params: { status: 'open', series_ticker: s.ticker, limit: 200 } });
      reads++;
      const n = (r.data?.events || []).length;
      if (n) { withOpen++; events += n; }
    } catch (e) { /* skip */ }
    await sleep(60);
  }
  out('politics-series-open', { read: reads, withOpen, events, ms: Date.now() - t0, totalPoliticsSeries: pol.length });
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
