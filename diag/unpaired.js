// One-off: why some Polymarket US games don't pair with Kalshi's.
const axios = require('axios');
const xarb = require('../xarb');
const pmus = require('../pmus');
const http = { get: (url, opts = {}) => axios.get(url, { timeout: 20000, ...opts }) };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
async function main() {
  const us = pmus.createPolymarketUs({ http, log: null });
  const rows = (await us.arbRows({ leagues: ['cfb', 'nfl', 'nba', 'nhl'] })).filter(r => r.kind === 'teams');
  const kalshi = [];
  for (const s of ['KXNCAAFGAME', 'KXNFLGAME', 'KXNBAGAME', 'KXNHLGAME']) {
    const r = await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 10, onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) });
    out(`kalshi-${s}`, { count: r.count, pages: r.pages, truncated: r.truncated, errors: r.errors });
  }
  const now = Date.now();
  const matches = xarb.matchMarkets(kalshi, rows, { now });
  const paired = new Set(matches.map(m => m.polymarket.id));
  const unpaired = rows.filter(r => !paired.has(r.id));
  out('counts', { usTeams: rows.length, kalshiTeams: kalshi.filter(r => r.kind === 'teams').length, paired: paired.size, unpaired: unpaired.length });
  const kt = kalshi.filter(r => r.kind === 'teams');
  const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  const show = [];
  for (const r of unpaired.slice(0, 40)) {
    const ws = new Set([...words(r.outcomeLabel), ...words(r.noLabel)]);
    const cands = kt.filter(k => [...words(k.outcomeLabel), ...words(k.noLabel)].some(w => ws.has(w)))
      .slice(0, 4).map(k => `${k.id} [${k.outcomeLabel}|${k.noLabel}] lg=${k.league} start=${k.startTime} exp=${k.expectedExpiration} close=${k.closeTime} day=${k.gameDay != null ? new Date(k.gameDay).toISOString() : null}`);
    show.push({ us: `${r.gameSlug} [${r.outcomeLabel}|${r.noLabel}] lg=${r.league} start=${r.startTime}`, cands });
  }
  out('unpaired', show);
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
