// One-off probe: Kalshi esports rules (draws, forfeits), map market timing/volume
// around match start, and whether bo3.gg exposes map picks before maps start.
const axios = require('axios');
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const BO3 = 'https://api.bo3.gg/api/v1', H = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
const http = axios.create({ timeout: 20000, headers: { 'user-agent': 'line-reaper-diag' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (...a) => console.log(...a);
const j = (x, n = 1500) => JSON.stringify(x).slice(0, n);
async function get(u, o) { try { return (await http.get(u, o)).data; } catch (e) { return { ERR: e.response?.status || e.message, body: j(e.response?.data, 300) }; } }
(async () => {
  const series = ['KXCS2GAME', 'KXLOLGAME', 'KXVALORANTGAME', 'KXDOTA2GAME', 'KXCODGAME', 'KXR6GAME', 'KXOWGAME', 'KXCS2MAP', 'KXVALORANTMAP', 'KXLOLMAP', 'KXDOTA2MAP'];
  out('=== SERIES + RULES ===');
  for (const s of series) {
    const si = await get(`${K}/series/${s}`);
    out(`\n## ${s} fee_type=${si?.series?.fee_type} mult=${si?.series?.fee_multiplier} settlement_sources=${j(si?.series?.settlement_sources, 300)}`);
    out('contract_terms', si?.series?.contract_terms_url);
    const ev = await get(`${K}/events`, { params: { series_ticker: s, status: 'open', limit: 200, with_nested_markets: true } });
    const evs = ev?.events || [];
    const counts = {}; for (const e of evs) { const n = (e.markets || []).length; counts[n] = (counts[n] || 0) + 1; }
    out('open events', evs.length, 'markets per event', j(counts));
    const e0 = evs[0]; if (e0) {
      const m = e0.markets[0];
      out('sample', e0.event_ticker, '|', e0.title, '| mutually_exclusive', e0.mutually_exclusive);
      out('RULES1:', m.rules_primary); out('RULES2:', m.rules_secondary);
      out('times open', m.open_time, 'close', m.close_time, 'exp', m.expected_expiration_time, 'can_close_early', m.can_close_early, 'early_close', j(m.early_close_condition, 300));
    }
    const three = evs.find(e => (e.markets || []).length >= 3);
    if (three) out('3+ market event', three.event_ticker, three.markets.map(m => m.yes_sub_title).join(' / '));
    await sleep(300);
  }
  out('\n=== SETTLED MAP MARKETS: volume by minute around ticker start ===');
  for (const s of ['KXCS2MAP', 'KXVALORANTMAP']) {
    const ev = await get(`${K}/events`, { params: { series_ticker: s, status: 'settled', limit: 60, with_nested_markets: true } });
    const evs = (ev?.events || []).filter(e => /-[23]$/.test(e.event_ticker)).slice(0, 6);
    for (const e of evs) {
      const m = e.markets[0];
      const tm = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(e.event_ticker);
      const mon = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }[tm[2]];
      // ET start → UTC (EDT, +4h)
      const start = Date.UTC(2000 + +tm[1], mon, +tm[3], +tm[4] + 4, +tm[5]) / 1000;
      const c = await get(`${K}/series/${s}/markets/${m.ticker}/candlesticks`, { params: { start_ts: start - 3 * 3600, end_ts: start + 5 * 3600, period_interval: 1 } });
      const cs = c?.candlesticks || [];
      const buckets = {};
      for (const k of cs) { const b = Math.floor((k.end_period_ts - start) / 1800) * 30; buckets[b] = (buckets[b] || 0) + Number(k.volume_fp ?? k.volume ?? 0); }
      const px = cs.filter(k => Number(k.volume_fp ?? k.volume) > 0).map(k => `${Math.round((k.end_period_ts - start) / 60)}:${k.price?.close_dollars ?? k.price?.close}`);
      out(`\n${m.ticker} result=${m.result} close=${m.close_time} settled vol=${m.volume_fp ?? m.volume} candles=${cs.length} ERR=${c?.ERR || ''}`);
      out(' vol by 30-min bucket (min from start):', j(buckets, 600));
      out(' trade prints min:price', px.slice(0, 60).join(' '));
      await sleep(300);
    }
  }
  out('\n=== bo3.gg: live / upcoming matches and map info ===');
  for (const st of ['current', 'upcoming']) {
    const r = await get(`${BO3}/matches`, { params: { 'page[limit]': 5, 'filter[matches.status][in]': st, 'filter[matches.discipline_id][eq]': 1, sort: 'start_date' }, headers: H });
    const rows = r?.results || []; out(`\n## ${st} matches`, rows.length, r?.ERR || '');
    if (rows[0]) out('keys', Object.keys(rows[0]).join(','), '\n', j(rows[0], 2500));
    for (const m of rows.slice(0, 3)) {
      for (const u of [`${BO3}/games?filter[games.match_id][eq]=${m.id}`, `${BO3}/matches/${m.slug}?scope=show-match&with=games,streams,teams,tournament_deep,stage,picks_bans`, `${BO3}/matches/${m.slug}/picks_bans`, `${BO3}/matches/${m.id}/maps`]) {
        const d = await get(u, { headers: H }); out('\n>', u, '\n', j(d, 2500)); await sleep(400);
      }
    }
  }
  out('\n## finished match games sample');
  const f = await get(`${BO3}/matches`, { params: { 'page[limit]': 2, 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1, sort: '-start_date' }, headers: H });
  for (const m of (f?.results || []).slice(0, 1)) {
    for (const u of [`${BO3}/games?filter[games.match_id][eq]=${m.id}`, `${BO3}/matches/${m.slug}?scope=show-match&with=games,picks_bans`]) { const d = await get(u, { headers: H }); out('\n>', u, '\n', j(d, 3000)); }
  }
})();
