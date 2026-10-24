// Esports head-to-head research pull. One PART per job:
//   k:<TITLE>   Kalshi GAME / TOTALMAPS / SPREAD / MAP(1) settled events, candles
//   pm:<code>   Polymarket closed esports events (match, maps, totals, handicaps), price history
//   res:<cs|lol|val|dota>  results history
const fs = require('fs'), zlib = require('zlib');
const PART = process.env.PART || '';
const SINCE = Date.parse(process.env.SINCE || '2026-03-01');
const BUDGET = Number(process.env.BUDGET_MIN || 300) * 60e3, T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0;
async function get(url, params = {}, headers = {}, tries = 6, text = false) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 25) log('4xx', r.status, (u.pathname + u.search).slice(0, 220), (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      return text ? await r.text() : await r.json();
    } catch (e) { await sleep(1500 * (i + 1)); }
  }
  errs++; return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() - T0 < BUDGET) { const x = items[i++]; await fn(x); } })); }
const save = (name, v) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(`data/${name}.json.gz`, zlib.gzipSync(JSON.stringify(v))); log('saved', name, Array.isArray(v) ? v.length : ''); };
const num = v => (v == null || v === '' ? null : Number(v));

// ── Kalshi ──
const K = 'https://api.elections.kalshi.com/trade-api/v2';
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
const conv = (cs, ref) => (cs || []).map(k => [Math.round((k.end_period_ts * 1000 - ref) / 60e3), num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0), num(k.price?.close_dollars ?? k.price?.close)]);
async function kalshiSeries(series, kind) {
  const live = await listMarkets(series, false), hist = await listMarkets(series, true);
  const liveSet = new Set(live.map(m => m.ticker));
  const byEv = new Map();
  for (const m of [...hist, ...live]) {
    if (!(m.result === 'yes' || m.result === 'no')) continue;
    if (kind === 'map' && !/-1$/.test(m.event_ticker)) continue;   // map 1 only
    const a = byEv.get(m.event_ticker) || []; if (!a.some(x => x.ticker === m.ticker)) a.push({ ...m, _hist: !liveSet.has(m.ticker) }); byEv.set(m.event_ticker, a);
  }
  const evs = [...byEv].map(([ev, ms]) => ({ ev, ms, start: startFromTicker(ev) })).filter(e => e.start && e.start >= SINCE);
  log(series, 'live', live.length, 'hist', hist.length, 'events', evs.length, 'sample', JSON.stringify(live[0] || hist[0] || {}).slice(0, 900));
  const out = []; let done = 0;
  await pool(evs, 6, async ({ ev, ms, start }) => {
    const rec = { s: series, kind, ev, start, title: ms[0].title, ms: [] };
    for (const m of ms) {
      const path = m._hist ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${series}/markets/${m.ticker}/candlesticks`;
      const s0 = Math.floor(start / 1000);
      const h = await get(K + path, { start_ts: s0 - 48 * 3600, end_ts: s0 + 3600, period_interval: 60 });
      const mi = await get(K + path, { start_ts: s0 - 150 * 60, end_ts: s0 + 15 * 60, period_interval: 1 });
      rec.ms.push({ t: m.ticker, sub: m.yes_sub_title, title: m.title, strike: m.floor_strike ?? m.custom_strike ?? null, res: m.result, vol: num(m.volume_fp ?? m.volume), open: m.open_time, close: m.close_time, h: conv(h?.candlesticks, start), mi: conv(mi?.candlesticks, start) });
    }
    out.push(rec);
    if (++done % 300 === 0) { log(series, done, '/', evs.length, 'calls', calls, 'errs', errs); }
  });
  return out;
}
const KT = { CS2: 'CS2', LOL: 'LOL', VAL: 'VALORANT', DOTA: 'DOTA2' };
async function kalshi(title) {
  const p = KT[title]; const all = [];
  for (const [suf, kind] of [['GAME', 'match'], ['TOTALMAPS', 'total'], ['SPREAD', 'spread'], ['MAP', 'map']]) {
    if (Date.now() - T0 > BUDGET) break;
    all.push(...await kalshiSeries(`KX${p}${suf}`, kind));
    save(`k-${title}`, all);
  }
}

// ── Polymarket ──
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com', DATA = 'https://data-api.polymarket.com';
const PMS = { cs2: 10310, lol: 10311, dota2: 10309, val: 10369 };
const pj = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
async function history(token, startMs) {
  const s0 = Math.floor(startMs / 1000);
  // long window in 10 minute buckets (data API), short window in minutes (CLOB)
  const a = await get(`${DATA}/v2/prices-history`, { token_id: token, bucket_seconds: 600, start: s0 - 48 * 3600, end: s0 + 600, limit: 1000 });
  const b = await get(`${CLOB}/prices-history`, { market: token, startTs: s0 - 150 * 60, endTs: s0 + 15 * 60, fidelity: 1 });
  const ra = (a?.data || []).filter(r => Number(r.resolution_seconds) !== 0).map(r => [Math.round((r.timestamp * 1000 - startMs) / 60e3), r.price]);
  const rb = (b?.history || []).map(r => [Math.round((r.t * 1000 - startMs) / 60e3), r.p]);
  return { h: ra, mi: rb };
}
async function polymarket(code) {
  let series = PMS[code];
  const sp = await get(`${GAMMA}/sports`);
  const row = (sp || []).find(x => x.sport === code); if (row?.series) series = Number(String(row.series).split(',')[0]) || series;
  log('pm series', code, series);
  const evs = [], seen = new Set();
  // weekly windows (Gamma refuses deep offsets)
  for (let w0 = SINCE - 7 * 86400e3; w0 < Date.now(); w0 += 7 * 86400e3) {
    for (let off = 0; off < 2000; off += 100) {
      const d = await get(`${GAMMA}/events`, { series_id: series, closed: true, limit: 100, offset: off, start_date_min: new Date(w0).toISOString(), start_date_max: new Date(w0 + 7 * 86400e3).toISOString() });
      if (!d || !d.length) break;
      for (const e of d) if (!seen.has(e.id)) { seen.add(e.id); evs.push(e); }
      if (!evs.sampled) { evs.sampled = 1; log('pm sample', JSON.stringify(d[0]).slice(0, 1500)); }
      if (d.length < 100) break;
      await sleep(120);
    }
    log('pm week', new Date(w0).toISOString().slice(0, 10), evs.length);
  }
  log('pm events', code, evs.length);
  const out = []; let done = 0, tested = false;
  await pool(evs, 6, async ev => {
    const ms = (ev.markets || []).filter(m => ['moneyline', 'child_moneyline', 'totals', 'map_handicap'].includes(m.sportsMarketType));
    const start = Date.parse(ev.startTime || ms[0]?.gameStartTime || '') || null;
    if (!start || start < SINCE) return;
    const rec = { slug: ev.slug, title: ev.title, start, vol: num(ev.volume), ms: [] };
    for (const m of ms) {
      const toks = pj(m.clobTokenIds) || [];
      if (!toks[0]) continue;
      const hst = await history(toks[0], start);
      if (!tested) { tested = true; log('pm hist sample', m.question, hst.h.length, hst.mi.length, JSON.stringify(hst.mi.slice(-5))); }
      rec.ms.push({ type: m.sportsMarketType, q: m.question, git: m.groupItemTitle, outcomes: pj(m.outcomes), prices: pj(m.outcomePrices), vol: num(m.volumeNum ?? m.volume), gst: m.gameStartTime, ...hst });
    }
    out.push(rec);
    if (++done % 300 === 0) { log('pm', code, done, '/', evs.length, 'calls', calls, 'errs', errs); save(`pm-${code}`, out); }
  });
  save(`pm-${code}`, out);
}

// ── results ──
const BO3 = 'https://api.bo3.gg/api/v1', H3 = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
async function bo3cs() {
  const since = Date.parse(process.env.RES_SINCE || '2024-01-01');
  const ms = [];
  for (let p = 0; p < 1500; p++) {
    const d = await get(`${BO3}/matches`, { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 }, H3);
    const rows = d?.results || [];
    if (p === 0) log('bo3 sample', JSON.stringify(rows[0]).slice(0, 2000));
    ms.push(...rows.map(m => ({ id: m.id, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, t: m.start_date, bo: m.bo_type, tier: m.tier, tr: m.tier_rank, w: m.winner_team_id, tour: m.tournament_id, lan: m.is_lan ?? null, bu: m.bet_updates ? { a: m.bet_updates.team_1?.coeff, b: m.bet_updates.team_2?.coeff, an: m.bet_updates.team_1?.name, x: (m.bet_updates.additional_markets || []).map(x => [x.bet_type, x.coeff]) } : null })));
    const oldest = Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity));
    if (rows.length < 100 || oldest < since) break;
    if (p % 50 === 0) log('bo3 page', p, rows.slice(-1)[0]?.start_date);
    await sleep(200);
  }
  const ids = [...new Set(ms.flatMap(m => [m.a, m.b]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) {
    const d = await get(`${BO3}/teams`, { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }, H3);
    for (const t of d?.results || []) names[t.id] = t.name; await sleep(150);
  }
  const byId = new Map(ms.map(m => [m.id, { ...m, an: names[m.a] || null, bn: names[m.b] || null, g: [] }]));
  const mids = [...byId.keys()], chunks = [];
  for (let i = 0; i < mids.length; i += 60) chunks.push(mids.slice(i, i + 60));
  let done = 0;
  await pool(chunks, 3, async ch => {
    for (let off = 0; off < 1000; off += 100) {
      const d = await get(`${BO3}/games`, { 'filter[games.match_id][in]': ch.join(','), 'page[limit]': 100, 'page[offset]': off }, H3);
      const rows = d?.results || [];
      for (const g of rows) { const m = byId.get(g.match_id); if (m) m.g.push([g.number, g.map_name, g.begin_at, g.winner_clan_name, g.loser_clan_name, g.winner_clan_score, g.loser_clan_score, g.status]); }
      if (rows.length < 100) break;
    }
    if (++done % 100 === 0) log('bo3 games chunks', done, '/', chunks.length);
  });
  save('res-cs', [...byId.values()]);
}
const LOLESPORTS = 'https://esports-api.lolesports.com/persisted/gw/getSchedule', LKEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
async function lol() {
  const out = []; let token = null;
  for (let p = 0; p < 800; p++) {
    const d = await get(LOLESPORTS, { hl: 'en-US', pageToken: token }, { 'x-api-key': LKEY });
    const sch = d?.data?.schedule; const evs = sch?.events || [];
    for (const e of evs) {
      if (e.type !== 'match' || e.state !== 'completed' || !e.match) continue;
      const t = e.match.teams || []; if (t.length !== 2) continue;
      out.push({ id: e.match.id, t: e.startTime, lg: e.league?.name, bo: e.match.strategy?.count, a: t[0].name, ac: t[0].code, b: t[1].name, bc: t[1].code, s1: t[0].result?.gameWins, s2: t[1].result?.gameWins });
    }
    token = sch?.pages?.older; if (!token || !evs.length) break;
    if (Math.min(...evs.map(e => Date.parse(e.startTime) || Infinity)) < Date.parse('2024-01-01')) break;
    await sleep(250);
  }
  save('res-lol', out);
}
const strip = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
async function val() {
  const out = [], seen = new Set();
  for (let page = 1; page <= 700 && Date.now() - T0 < BUDGET; page++) {
    const html = await get(`https://www.vlr.gg/matches/results${page > 1 ? `/?page=${page}` : ''}`, {}, { 'User-Agent': 'Mozilla/5.0 (LineReaper research)' }, 6, true);
    if (!html) continue;
    let n = 0, oldest = Infinity;
    for (const part of html.split(/<div class="wf-label mod-large">/).slice(1)) {
      const day = Date.parse(strip(part.slice(0, part.indexOf('</div>'))).replace(/Today|Yesterday/g, '').trim()) || 0;
      for (const mm of part.matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item[\s\S]*?<\/a>/g)) {
        const item = mm[0], id = mm[1]; if (seen.has(id)) continue;
        const names = [...item.matchAll(/<div class="match-item-vs-team-name">([\s\S]*?)<\/div>\s*<\/div>/g)].map(m => strip(m[1]));
        const sc = [...item.matchAll(/<div class="match-item-vs-team-score[^"]*">([\s\S]*?)<\/div>/g)].map(m => parseInt(strip(m[1]), 10));
        const time = strip((item.match(/<div class="match-item-time">([\s\S]*?)<\/div>/) || [])[1] || '');
        const ev = strip((item.match(/<div class="match-item-event[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '');
        if (names.length < 2 || sc.length < 2) continue;
        seen.add(id); n++; oldest = Math.min(oldest, day);
        out.push({ id, day, time, a: names[0], b: names[1], s1: sc[0], s2: sc[1], ev });
      }
    }
    if (!n) break;
    if (oldest < Date.parse('2024-06-01')) break;
    if (page % 50 === 0) { log('vlr page', page, new Date(oldest).toISOString()); save('res-val', out); }
    await sleep(800);
  }
  save('res-val', out);
}
async function dota() {
  const rows = []; let before = null;
  for (let i = 0; i < 3000 && Date.now() - T0 < BUDGET; i++) {
    const b = await get('https://api.opendota.com/api/proMatches', before ? { less_than_match_id: before } : {}, {}, 8);
    if (!Array.isArray(b)) { await sleep(20000); continue; }
    if (!b.length) break;
    rows.push(...b.map(m => ({ id: m.match_id, a: m.radiant_name, b: m.dire_name, ra: m.radiant_team_id, da: m.dire_team_id, aw: m.radiant_win ? 1 : 0, t: m.start_time * 1000, sid: m.series_id, st: m.series_type, lg: m.league_name, lid: m.leagueid, rs: m.radiant_score, ds: m.dire_score, dur: m.duration })));
    before = Math.min(...b.map(m => m.match_id));
    if (Math.min(...b.map(m => m.start_time * 1000)) < Date.parse('2024-09-01')) break;
    if (i % 50 === 0) { save('res-dota', rows); log('dota page', i, new Date(b.slice(-1)[0].start_time * 1000).toISOString()); }
    await sleep(1200);
  }
  save('res-dota', rows);
}

(async () => {
  const [kind, arg] = PART.split(':');
  try {
    if (kind === 'k') await kalshi(arg);
    else if (kind === 'pm') await polymarket(arg);
    else if (kind === 'res') await ({ cs: bo3cs, lol, val, dota })[arg]();
  } catch (e) { log('FAIL', e.stack); }
  log('done', PART, 'calls', calls, 'errs', errs, 'min', ((Date.now() - T0) / 60e3).toFixed(1));
})();
