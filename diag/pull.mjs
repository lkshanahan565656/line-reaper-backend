// Pulls everything the big-money re-check needs: the live record, ESPN finals
// and box scores, Action Network closes, and the money's own exchange trades.
import fs from 'node:fs'; import zlib from 'node:zlib';
const U = 'https://line-reaper-backend-production.up.railway.app';
const out = 'out'; fs.mkdirSync(`${out}/espn`, { recursive: true }); fs.mkdirSync(`${out}/an`, { recursive: true }); fs.mkdirSync(`${out}/ex`, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, opt = {}) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', ...(opt.h || {}) }, signal: AbortSignal.timeout(90e3) }); if (r.status === 429) { await sleep(3000 * (i + 1)); continue; } return { status: r.status, text: await r.text() }; }
    catch (e) { await sleep(1500); }
  }
  return { status: 0, text: '' };
}
const save = (f, t) => fs.writeFileSync(f, zlib.gzipSync(t));
const rec = await get(`${U}/api/big-money/record`);
fs.writeFileSync(`${out}/record.json`, rec.text);
const rows = JSON.parse(rec.text).rows || [];
console.log('rows', rows.length);
for (const p of ['/api/results', '/api/ev/scoreboard', '/']) { const r = await get(U + p); fs.writeFileSync(`${out}/${p === '/' ? 'root' : p.split('/').pop()}.json`, r.text); }
const ESPN = { NFL: 'football/nfl', CFB: 'football/college-football', NBA: 'basketball/nba', NHL: 'hockey/nhl', MLB: 'baseball/mlb', WNBA: 'basketball/wnba', NCAAF: 'football/college-football' };
const AN = { NFL: 'nfl', CFB: 'ncaaf', NBA: 'nba', NHL: 'nhl', MLB: 'mlb', WNBA: 'wnba' };
const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const need = new Set();
for (const r of rows) { if (!ESPN[r.sport] || !r.start) continue; const t = Date.parse(r.start); need.add(`${r.sport}|${ymd(t)}`); need.add(`${r.sport}|${ymd(t - 8 * 3600e3)}`); }
const propDates = new Set(rows.filter(r => r.kind === 'prop').map(r => `${r.sport}|${ymd(Date.parse(r.start) - 8 * 3600e3)}`));
for (const k of need) {
  const [sp, d] = k.split('|');
  const sb = await get(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[sp]}/scoreboard?dates=${d}&limit=400${sp === 'CFB' ? '&groups=80' : ''}`);
  fs.writeFileSync(`${out}/espn/${sp}-${d}.json`, sb.text);
  if (propDates.has(k)) { try { for (const e of JSON.parse(sb.text).events || []) { const s = await get(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[sp]}/summary?event=${e.id}`); save(`${out}/espn/sum-${sp}-${e.id}.json.gz`, s.text); } } catch {} }
  if (AN[sp]) { const a = await get(`https://api.actionnetwork.com/web/v2/scoreboard/${AN[sp]}?bookIds=15,30,68,69,71,75,79,123,972,2988,2724,4620&periods=event&date=${d}${sp === 'CFB' ? '&division=FBS' : ''}`); save(`${out}/an/${sp}-${d}.json.gz`, a.text); }
}
console.log('espn+an done');
// the money's own trades in the 13 h up to each flag (Kalshi by ticker, Polymarket by condition)
const seen = new Set();
for (const r of rows) {
  if (r.venue !== 'betrivers' || !r.moneyMarket) continue;
  const k = `${r.moneyExchange}|${r.moneyMarket}`; if (seen.has(k)) continue; seen.add(k);
  const f = `${out}/ex/${r.moneyExchange}-${r.moneyMarket.replace(/[^A-Za-z0-9-]/g, '_')}.json.gz`;
  if (r.moneyExchange === 'kalshi') {
    const all = []; let cursor = '';
    const minTs = Math.floor((Date.parse(r.flaggedAt) - 14 * 3600e3) / 1000), maxTs = Math.floor(Date.parse(r.start) / 1000) + 600;
    for (let i = 0; i < 30; i++) {
      const x = await get(`https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${r.moneyMarket}&limit=1000&min_ts=${minTs}&max_ts=${maxTs}${cursor ? `&cursor=${cursor}` : ''}`);
      let j; try { j = JSON.parse(x.text); } catch { break; }
      all.push(...(j.trades || [])); cursor = j.cursor; if (!cursor) break; await sleep(150);
    }
    const m = await get(`https://api.elections.kalshi.com/trade-api/v2/markets/${r.moneyMarket}`);
    save(f, JSON.stringify({ trades: all, market: (() => { try { return JSON.parse(m.text).market; } catch { return null; } })() }));
  } else if (r.moneyExchange === 'polymarket') {
    const all = [];
    for (let off = 0; off < 4000; off += 500) {
      const x = await get(`https://data-api.polymarket.com/trades?market=${r.moneyMarket}&limit=500&offset=${off}&takerOnly=true&filterType=CASH&filterAmount=100`);
      let j; try { j = JSON.parse(x.text); } catch { break; }
      if (!Array.isArray(j) || !j.length) break; all.push(...j); if (j.length < 500) break; await sleep(150);
    }
    const m = await get(`https://gamma-api.polymarket.com/markets?condition_ids=${r.moneyMarket}`);
    save(f, JSON.stringify({ trades: all, market: (() => { try { return JSON.parse(m.text)[0]; } catch { return null; } })() }));
  }
}
console.log('exchanges done', seen.size);
