// One-off: the Kalshi vs Polymarket US arb finder (pmus-arbs) on live data.
const axios = require('axios');
const xarb = require('../xarb');
const pmus = require('../pmus');

const gaps = { 'api.elections.kalshi.com': 70, 'gateway.polymarket.us': 60 };
const last = {};
const http = {
  async get(url, opts = {}) {
    const host = new URL(url).host;
    const wait = (last[host] || 0) + (gaps[host] ?? 100) - Date.now();
    last[host] = Math.max(Date.now(), (last[host] || 0) + (gaps[host] ?? 100));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (let i = 0; ; i++) {
      try { return await axios.get(url, { timeout: 20000, ...opts }); }
      catch (e) {
        if (e?.response?.status === 429 && i < 4) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        throw e;
      }
    }
  },
};
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const countBy = (xs, f) => { const o = {}; for (const x of xs) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };

async function main() {
  const t0 = Date.now();
  const us = pmus.createPolymarketUs({ http, log: { warn: m => console.log('warn', m) } });
  const rows = await us.arbRows();
  out('pmus-rows', { ms: Date.now() - t0, rows: rows.length, state: us.state().arbs, kinds: countBy(rows, r => `${r.league || 'other'}|${r.kind}`) });

  const t1 = Date.now();
  const series = await xarb.fetchKalshiGameSeries(http).catch(e => { out('kalshi-series-error', e.message); return xarb.SEED_GAME_SERIES; });
  const kalshi = [];
  for (const s of series) {
    try { await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 5, onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) }); }
    catch (e) { console.log('kalshi', s, e.message); }
  }
  out('kalshi', { ms: Date.now() - t1, series: series.length, rows: kalshi.length });

  const now = Date.now();
  const matches = xarb.matchMarkets(kalshi, rows, { now });
  out('matches', { total: matches.length, by: countBy(matches, m => m.by), byLeague: countBy(matches, m => `${m.kalshi.league || m.kalshi.seriesTicker || 'other'}|${m.by}`) });
  const usGames = new Set(rows.map(r => r.eventKey)), paired = new Set(matches.map(m => m.polymarket.eventKey));
  out('games-paired', { listed: usGames.size, paired: paired.size, unpairedSample: [...usGames].filter(g => !paired.has(g)).slice(0, 40) });

  for (const minPct of [0.5, -3]) {
    const found = xarb.findUsArbs(kalshi, rows, { now, minPct, matches });
    out(`arbs-listed-min${minPct}`, { n: found.length, byType: countBy(found, a => a.type), top: found.slice(0, 25).map(a => ({ pct: a.profitPct, type: a.type, title: a.title, by: a.match?.by, legs: a.legs.map(l => `${l.venue}:${l.side}:${l.pick}@${l.price}`) })) });
  }
  const screened = xarb.findUsArbs(kalshi, rows, { now, matches });
  const ids = new Set(screened.flatMap(a => a.legs.filter(l => l.venue === 'polymarketus').map(l => l.marketId)));
  const live = await us.reprice(rows.filter(r => ids.has(r.id)), { maxBooks: 40 });
  const liveRows = [...live.values()].filter(Boolean);
  const byId = new Map(liveRows.map(r => [r.id, r]));
  const liveMatches = matches.filter(m => byId.has(m.polymarket.id)).map(m => ({ ...m, polymarket: byId.get(m.polymarket.id) }));
  const confirmed = xarb.findUsArbs(kalshi, liveRows, { now, matches: liveMatches });
  out('arbs-confirmed', { screened: screened.length, books: live.size, open: liveRows.length, n: confirmed.length,
    arbs: confirmed.map(a => ({ pct: a.profitPct, max: a.maxContracts, title: a.title, legs: a.legs.map(l => `${l.venue}:${l.side}:${l.pick}@${l.price}${l.depth != null ? ` x${l.depth}` : ''}`) })) });
  // how close the matched pairs come: best all-in cost per pair (fees in), to see the spread of near misses
  const near = [];
  for (const m of matches) for (const a of xarb.findCrossArbs([], [], { now, minPct: -100, matches: [m] })) near.push({ pct: a.profitPct, title: a.title, by: m.by, legs: a.legs.map(l => `${l.venue}:${l.side}@${l.price}`) });
  near.sort((a, b) => b.pct - a.pct);
  out('closest-pairs', near.slice(0, 20));
  out('done', { ms: Date.now() - t0 });
}
main().catch(e => { out('fatal', { m: e.message, stack: e.stack }); });
