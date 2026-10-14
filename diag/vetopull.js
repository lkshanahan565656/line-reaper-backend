// Map-veto backtest data: bo3.gg CS2 matches with per-map names, winners and
// start times; Kalshi KXCS2MAP settled markets with minute candles from the
// ticker start to +7h (covers maps 1-3 of a Bo3).
const fs = require('fs'), zlib = require('zlib');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SINCE = Date.parse(process.env.SINCE || '2024-01-01');
let calls = 0, errs = 0;
async function get(url, params = {}, headers = {}, tries = 6) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 20) log('4xx', r.status, u.pathname + u.search.slice(0, 200), (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
const save = (name, v) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/${name}.json.gz`, zlib.gzipSync(JSON.stringify(v))); log('saved', name, v.length); };
const num = v => (v == null || v === '' ? null : Number(v));

async function bo3(disc, name) {
  const ms = [];
  for (let p = 0; p < 1000; p++) {
    const d = await get(`${BO3}/matches`, { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': disc }, H);
    const rows = d?.results || [];
    ms.push(...rows.map(m => ({ id: m.id, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, t: m.start_date, bo: m.bo_type, tier: m.tier, w: m.winner_team_id, tour: m.tournament_id })));
    const oldest = Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity));
    if (rows.length < 100 || oldest < SINCE) break;
    if (p % 50 === 0) log(name, 'match page', p, rows.slice(-1)[0]?.start_date);
    await sleep(250);
  }
  const ids = [...new Set(ms.flatMap(m => [m.a, m.b]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const d = await get(`${BO3}/teams`, { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }, H);
    for (const t of d?.results || []) names[t.id] = t.name; await sleep(200);
  }
  const byId = new Map(ms.map(m => [m.id, { ...m, an: names[m.a] || null, bn: names[m.b] || null, g: [] }]));
  const mids = [...byId.keys()];
  const chunks = []; for (let i = 0; i < mids.length; i += 60) chunks.push(mids.slice(i, i + 60));
  let done = 0;
  await pool(chunks, 3, async ch => {
    for (let off = 0; off < 1000; off += 100) {
      const d = await get(`${BO3}/games`, { 'filter[games.match_id][in]': ch.join(','), 'page[limit]': 100, 'page[offset]': off }, H);
      const rows = d?.results || [];
      for (const g of rows) { const m = byId.get(g.match_id); if (m) m.g.push([g.number, g.map_name, g.begin_at, g.winner_clan_name, g.loser_clan_name, g.winner_clan_score, g.loser_clan_score, g.status]); }
      if (rows.length < 100) break;
    }
    if (++done % 50 === 0) log(name, 'games chunks', done, '/', chunks.length);
  });
  save(`bo3-${name}`, [...byId.values()]);
}

const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function etToUtc(y, mo, d, h, mi) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const off of [4, 5]) { const t = Date.UTC(y, mo, d, h + off, mi); const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value])); if (+p.hour % 24 === h && +p.minute === mi && +p.day === d) return t; }
  return Date.UTC(y, mo, d, h + 4, mi);
}
function startFromTicker(ev) { const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ev); return m ? etToUtc(2000 + +m[1], MON[m[2]], +m[3], +m[4], +m[5]) : null; }
async function listMarkets(series, hist) {
  const out = []; let cursor = null;
  for (let p = 0; p < 300; p++) {
    const d = await get(K + (hist ? '/historical/markets' : '/markets'), { series_ticker: series, status: hist ? undefined : 'settled', limit: 1000, cursor });
    if (!d) break; out.push(...(d.markets || [])); cursor = d.cursor; if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}
async function kalshi(series) {
  const live = await listMarkets(series, false), hist = await listMarkets(series, true);
  const liveSet = new Set(live.map(m => m.ticker));
  const byEv = new Map();
  for (const m of [...hist, ...live]) { if (!(m.result === 'yes' || m.result === 'no')) continue; const a = byEv.get(m.event_ticker) || []; if (!a.some(x => x.ticker === m.ticker)) a.push({ ...m, _hist: !liveSet.has(m.ticker) }); byEv.set(m.event_ticker, a); }
  log(series, 'live', live.length, 'hist', hist.length, 'events', byEv.size);
  const out = []; let done = 0;
  await pool([...byEv], 8, async ([ev, ms]) => {
    const start = startFromTicker(ev);
    if (!start) return;
    const rec = { ev, start, title: ms[0].title, ms: [] };
    for (const m of ms) {
      const path = m._hist ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${series}/markets/${m.ticker}/candlesticks`;
      const d = await get(K + path, { start_ts: Math.floor(start / 1000) - 60 * 60, end_ts: Math.min(Math.floor(start / 1000) + 7 * 3600, Math.floor(Date.parse(m.close_time) / 1000) + 60), period_interval: 1 });
      const c = (d?.candlesticks || []).map(k => [Math.round((k.end_period_ts * 1000 - start) / 60e3), num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0)]);
      rec.ms.push({ t: m.ticker, sub: m.yes_sub_title, res: m.result, vol: num(m.volume_fp ?? m.volume), close: m.close_time, c });
    }
    out.push(rec);
    if (++done % 500 === 0) log(series, 'events', done, '/', byEv.size, 'calls', calls, 'errs', errs);
  });
  save(`k-${series}`, out);
}
(async () => {
  const which = (process.env.PARTS || 'bo3cs,kcs').split(',');
  const jobs = [];
  if (which.includes('bo3cs')) jobs.push(bo3(1, 'cs'));
  if (which.includes('kcs')) jobs.push(kalshi('KXCS2MAP'));
  if (which.includes('kval')) jobs.push(kalshi('KXVALORANTMAP'));
  await Promise.all(jobs.map(p => p.catch(e => log('FAIL', e.message))));
  log('done calls', calls, 'errs', errs);
})();
