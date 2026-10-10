// One-off: do UFC fights pair between Kalshi's FIGHT series and Polymarket?
const axios = require('axios');
const xarb = require('../xarb');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 350 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v, null, 1)}\n====`);
const row = r => ({ id: r.id, title: r.title, o: r.outcomeLabel, no: r.noLabel, kind: r.kind, league: r.league, gameDay: r.gameDay && new Date(r.gameDay).toISOString(), close: r.closeTime, cat: r.category, yes: r.yes ?? r.yesAsk, eventKey: r.eventKey });
async function main() {
  const series = await xarb.fetchKalshiGameSeries(http);
  const fights = series.filter(s => /FIGHT$/.test(s));
  out('fight-series', fights);
  const kalshi = [];
  for (const s of fights) {
    try {
      const r = await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 3, onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) });
      out(`k-${s}`, { events: r.count, errors: r.errors.slice(0, 2) });
    } catch (e) { out(`k-err-${s}`, e.message); }
  }
  out('k-rows', { n: kalshi.length, sample: kalshi.slice(0, 12).map(row) });
  const polymarket = [];
  const p = await xarb.fetchPolymarketEvents(http, { onPage: page => polymarket.push(...xarb.parsePolymarketBinaries(page)) });
  const pUfc = polymarket.filter(r => /ufc|herbert|camilo|fight night|boxing|vs\./i.test(`${r.title} ${r.eventKey}`) && /ufc|fight|boxing|mma/i.test(`${r.title} ${r.eventKey} ${r.league || ''}`));
  out('p-ufc', { pEvents: p.count, n: pUfc.length, sample: pUfc.slice(0, 15).map(row) });
  // straight from Gamma: the event the sharp bet on
  try {
    const ev = (await http.get('https://gamma-api.polymarket.com/events', { params: { slug: 'ufc-jai2-mat36-2026-10-10' } })).data?.[0];
    const rows = xarb.parsePolymarketBinaries([ev]);
    out('p-herbert', { title: ev?.title, tags: (ev?.tags || []).map(t => t.slug), rows: rows.map(row) });
    polymarket.push(...rows.filter(r => !polymarket.some(x => x.id === r.id)));
  } catch (e) { out('p-herbert-err', e.message); }
  const matches = xarb.matchMarkets(kalshi, polymarket, { ...xarb.DEFAULTS, now: Date.now(), games: [] });
  out('matches', { n: matches.length, by: matches.reduce((m, x) => (m[x.by] = (m[x.by] || 0) + 1, m), {}),
    list: matches.slice(0, 40).map(m => `${m.by} ${m.same ? 'same' : 'flip'} | ${m.kalshi.id} ${m.kalshi.title} · ${m.kalshi.outcomeLabel} <> ${m.polymarket.title} · ${m.polymarket.outcomeLabel}`) });
  const herbK = kalshi.filter(r => /herbert|camilo/i.test(`${r.title} ${r.outcomeLabel} ${r.noLabel}`));
  out('k-herbert', herbK.map(row));
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
