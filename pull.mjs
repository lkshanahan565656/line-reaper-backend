// Gemini maker backtest pull (checks/gemini-maker-2026-10-26/PREREGISTERED.md).
// Settled Gemini NFL/CFB/NBA/NHL game events that started since FROM, and every
// contract's trade prints (GET /v1/trades/{symbol}, newest 500 after creation).
// Output out/gmaker.json.gz. Public API, no key; ~2 requests a second.
import fs from 'fs';
import zlib from 'zlib';
const A = 'https://api.gemini.com';
const FROM = Date.parse(process.env.FROM || '2026-10-24T20:00:00Z');
const wait = ms => new Promise(r => setTimeout(r, ms));
const stats = { req: 0, r429: 0, err: 0, events: 0, contracts: 0, prints: 0, capped: 0 };
async function get(p) {
  for (let i = 0; ; i++) {
    stats.req++;
    try {
      const r = await fetch(A + p, { headers: { accept: 'application/json' } });
      if (r.status === 429) { stats.r429++; await wait(3000 * (i + 1)); if (i < 6) continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${p}`);
      await wait(450);
      return await r.json();
    } catch (e) { if (i >= 3) { stats.err++; console.log('ERR', e.message); return null; } await wait(2000 * (i + 1)); }
  }
}
const OK = /^(NFL|NCAAF|NBA|NHL)-/;
const evs = new Map();
const add = e => { if (e && e.id != null && !evs.has(String(e.id))) evs.set(String(e.id), e); for (const x of e?.events || []) add(x); };
for (const sport of (process.env.SPORTS || 'american_football,basketball,hockey').split(',')) {
  for (let off = 0; off < 20000; off += 500) {
    const r = await get(`/v1/prediction-markets/events?status=settled&sport=${sport}&sports_market_type=moneyline&sports_market_type=spread&sports_market_type=total&sports_market_scope=full_contest&limit=500&offset=${off}`);
    const d = r?.data || [];
    d.forEach(add);
    const starts = d.map(e => Date.parse(e.startTime)).filter(Number.isFinite);
    console.log(sport, off, d.length, starts.length ? new Date(Math.min(...starts)).toISOString() : '-', JSON.stringify(r?.pagination || null));
    if (d.length < 500 || (starts.length && Math.max(...starts) < FROM)) break;
  }
}
const keep = [...evs.values()].filter(e => OK.test(String(e.ticker || '')) && Date.parse(e.startTime) >= FROM && Date.parse(e.startTime) < Date.now());
console.log('events', evs.size, 'kept', keep.length);
const out = { at: new Date().toISOString(), from: new Date(FROM).toISOString(), events: [], stats };
for (const e of keep) {
  stats.events++;
  const contracts = [];
  for (const c of e.contracts || []) {
    if (!c.instrumentSymbol) continue;
    stats.contracts++;
    const since = Math.floor(Date.parse(c.createdAt || e.createdAt || 0) / 1000) || Math.floor(FROM / 1000) - 86400 * 3;
    const t = await get(`/v1/trades/${encodeURIComponent(c.instrumentSymbol)}?limit_trades=500&timestamp=${since}`);
    const prints = (Array.isArray(t) ? t : []).map(x => [x.timestampms, +x.price, x.type, +x.amount]).sort((a, b) => a[0] - b[0]);
    stats.prints += prints.length;
    if (prints.length >= 500) stats.capped++;
    const { description, prices, ...rest } = c;
    contracts.push({ ...rest, prints, capped: prints.length >= 500 });
  }
  const { contracts: _c, events: _e, description, ...ev } = e;
  out.events.push({ ...ev, contracts });
  if (out.events.length % 25 === 0) console.log(out.events.length, '/', keep.length, JSON.stringify(stats));
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/gmaker.json.gz', zlib.gzipSync(JSON.stringify(out)));
console.log('done', JSON.stringify(stats));
