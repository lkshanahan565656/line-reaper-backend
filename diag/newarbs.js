// The arb-clarity scan on live data: Kalshi (main list + tail sweep), Polymarket US, US mode.
// Prints an /api/xarbs-shaped body with arbs and the watchlist.
const axios = require('axios');
const xarb = require('../xarb');
const pmus = require('../pmus');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 250 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
async function main() {
  const kalshi = [];
  const k = await xarb.fetchKalshiEvents(http, { onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) });
  const sweep = xarb.createKalshiTailSweep({ http, perScan: 10 });
  const listed = new Set(kalshi.map(r => r.id));
  for (let i = 0; i < 12; i++) { let tail = []; try { tail = await sweep.step(k.cursor); } catch (e) { break; } for (const r of tail) if (!listed.has(r.id)) { kalshi.push(r); listed.add(r.id); } if (sweep.stats().cycles > 0) break; }
  const game = xarb.createKalshiGameSweep ? xarb.createKalshiGameSweep({ http }) : null;
  if (game) for (let i = 0; i < 30; i++) { let g = []; try { g = await game.step(); } catch { break; } for (const r of g) if (!listed.has(r.id)) { kalshi.push(r); listed.add(r.id); } if (game.stats?.().cycles > 0) break; }
  const us = pmus.createPolymarketUs({ http });
  let usRows = [];
  try { usRows = await us.arbRows({ leagues: pmus.ARB_LEAGUES }); } catch (e) { console.error('pmus', e.message); }
  const now = Date.now(), o = { ...xarb.DEFAULTS, now, region: 'us' };
  const usMatches = xarb.matchMarkets(kalshi, usRows, o);
  const arbs = [...xarb.findArbs({ kalshi, polymarket: [], games: [] }, o), ...xarb.findUsArbs(kalshi, usRows, { ...o, matches: usMatches })].sort((a, b) => b.profitPct - a.profitPct);
  const near = xarb.findNearArbs({ matches: usMatches, rows: [...kalshi, ...usRows] }, o);
  const body = { count: arbs.length, nearCount: near.length, updated: new Date(now).toISOString(), pro: true, region: 'us', arbs, near, minPct: o.minPct,
    counts: { kalshiMarkets: kalshi.length, polymarketUs: { rows: usRows.length, matches: usMatches.length } } };
  console.log(JSON.stringify(body));
}
main().catch(e => console.log(JSON.stringify({ fatal: e.message, stack: e.stack })));
