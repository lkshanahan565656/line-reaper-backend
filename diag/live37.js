// One-off: the race stage and the Kalshi tail sweep on live data (PR 37 check).
const axios = require('axios');
const xarb = require('../xarb');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 350 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v, null, 1)}\n====`);
const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
async function main() {
  const kalshi = [], polymarket = [];
  const t0 = Date.now();
  const [k, p] = await Promise.all([
    xarb.fetchKalshiEvents(http, { onPage: page => kalshi.push(...xarb.parseKalshiBinaries(page)) }),
    xarb.fetchPolymarketEvents(http, { onPage: page => polymarket.push(...xarb.parsePolymarketBinaries(page)) }),
  ]);
  out('main', { ms: Date.now() - t0, kEvents: k.count, kPages: k.pages, kTrunc: k.truncated, kRows: kalshi.length, cursor: !!k.cursor, pEvents: p.count, pRows: polymarket.length, errors: [...k.errors, ...p.errors].slice(0, 5) });
  const before = xarb.matchMarkets(kalshi, polymarket, { ...xarb.DEFAULTS, now: Date.now(), games: [] });
  out('matches-main-only', { n: before.length, by: countBy(before, m => m.by) });
  // the tail sweep: enough steps to walk the rest of the list once
  const sweep = xarb.createKalshiTailSweep({ http, perScan: 10 });
  const listed = new Set(kalshi.map(r => r.id));
  const tailIds = new Set();
  let tail = [];
  for (let i = 0; i < 12; i++) {
    const t1 = Date.now();
    try { tail = await sweep.step(k.cursor); } catch (e) { out(`tail-error-${i}`, e.message); break; }
    out(`tail-step-${i}`, { ms: Date.now() - t1, rows: tail.length, stats: sweep.stats() });
    if (sweep.stats().cycles > 0) break;
  }
  for (const r of tail) if (!listed.has(r.id)) { kalshi.push(r); listed.add(r.id); tailIds.add(r.id); }
  out('tail-categories', countBy(tail, r => r.category || '?'));
  const now = Date.now();
  const matches = xarb.matchMarkets(kalshi, polymarket, { ...xarb.DEFAULTS, now, games: [] });
  out('matches-with-tail', { n: matches.length, by: countBy(matches, m => m.by), fromTail: matches.filter(m => tailIds.has(m.kalshi.id)).length });
  const races = matches.filter(m => m.by === 'race');
  out('race-pairs', races.map(m => `${m.kalshi.id} <> ${m.polymarket.title} · ${m.polymarket.outcomeLabel || ''} | k=${m.kalshi.yes ?? m.kalshi.yesAsk ?? ''} p=${m.polymarket.yes ?? m.polymarket.yesAsk ?? ''}`));
  out('tail-matches', matches.filter(m => tailIds.has(m.kalshi.id)).slice(0, 40).map(m => `${m.by} | ${m.kalshi.title} · ${m.kalshi.outcomeLabel || ''} <> ${m.polymarket.title} · ${m.polymarket.outcomeLabel || ''}`));
  // race keys seen on each side that found no partner
  const keyed = side => side.map(r => ({ r, k: xarb.raceKey(r) })).filter(x => x.k);
  const kk = keyed(kalshi), pk = keyed(polymarket);
  const pairedK = new Set(races.map(m => m.kalshi.id)), pairedP = new Set(races.map(m => m.polymarket.id));
  out('race-keys', { kalshi: kk.length, polymarket: pk.length, pairedK: pairedK.size, pairedP: pairedP.size });
  out('k-kansas', kalshi.filter(r => /KS-|KANSAS/i.test(r.id) && /GOV|SENATE/.test(r.id)).map(r => r.id));
  out('pm-race-unpaired', pk.filter(x => !pairedP.has(x.r.id)).slice(0, 40).map(x => `${x.k.key}|${x.k.year} :: ${x.r.title} · ${x.r.outcomeLabel || ''}`));
  out('k-race-unpaired', kk.filter(x => !pairedK.has(x.r.id)).slice(0, 40).map(x => `${x.k.key}|${x.k.year} :: ${x.r.id} ${x.r.title} · ${x.r.outcomeLabel || ''}`));
  // Polymarket titles that look like races but get no key (missed shapes)
  const looks = polymarket.filter(r => /senate|governor|house seat|congressional district/i.test(r.title) && !xarb.raceKey(r));
  out('pm-race-looking-no-key', looks.slice(0, 40).map(r => `${r.title} · ${r.outcomeLabel || ''}`));
  const fights = kalshi.filter(r => /UFC|FIGHT|BOX/i.test(r.id));
  out('kalshi-fight-rows', { n: fights.length, sample: fights.slice(0, 10).map(r => `${r.id} | ${r.title}`) });
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
