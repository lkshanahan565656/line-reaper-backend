// Tennis match-model research pull. One PART per job:
//   k:all      Kalshi tennis series list, then every settled match-winner market with hourly candles
//   pm:<code>  Polymarket closed tennis events (moneyline), price history around the start (proxy for PM US)
//   res:espn   ESPN ATP/WTA scoreboards per day (results, scheduled start times)
//   res:td     tennis-data.co.uk yearly files (Pinnacle closing odds), saved raw
//   res:sack   Jeff Sackmann tennis_atp / tennis_wta match files (cloned by the workflow), compacted
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const PART = process.env.PART || '';
const SINCE = Date.parse(process.env.SINCE || '2025-01-01');
const BUDGET = Number(process.env.BUDGET_MIN || 150) * 60e3, T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let calls = 0, errs = 0;
async function get(url, params = {}, headers = {}, tries = 6, text = false) {
  const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(45000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400 && r.status < 500) { errs++; if (errs < 40) log('4xx', r.status, (u.host + u.pathname + u.search).slice(0, 220), (await r.text()).slice(0, 200)); return null; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      if (text === 'buf') return Buffer.from(await r.arrayBuffer());
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
async function listMarkets(series, hist) {
  const out = []; let cursor = null;
  for (let p = 0; p < 400; p++) {
    const d = await get(K + (hist ? '/historical/markets' : '/markets'), { series_ticker: series, status: hist ? undefined : 'settled', limit: 1000, cursor });
    if (!d) break; out.push(...(d.markets || [])); cursor = d.cursor; if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}
const conv = cs => (cs || []).map(k => [k.end_period_ts, num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0), num(k.price?.close_dollars ?? k.price?.close)]);
async function kalshiAll() {
  const sl = await get(K + '/series', { category: 'Sports' }) || await get(K + '/series');
  const all = sl?.series || [];
  const ten = all.filter(s => /ATP|WTA|TENNIS|CHALL|ITF|USOPEN|WIMBLEDON|FRENCH|AUSOPEN|GRANDSLAM/i.test(s.ticker) || /tennis|atp|wta/i.test(`${s.title} ${(s.tags || []).join(' ')}`));
  log('kalshi series', all.length, 'tennis', ten.length);
  save('k-series', ten);
  const match = ten.filter(s => /MATCH$/i.test(s.ticker) || /match|winner|vs/i.test(s.title || ''));
  log('match series', match.map(s => `${s.ticker}:${s.title}`).join(' | '));
  const out = [];
  for (const s of match) {
    if (Date.now() - T0 > BUDGET) break;
    const live = await listMarkets(s.ticker, false), hist = await listMarkets(s.ticker, true);
    const liveSet = new Set(live.map(m => m.ticker));
    const ms = [...hist, ...live].filter(m => (m.result === 'yes' || m.result === 'no') && Date.parse(m.close_time || '') >= SINCE);
    log(s.ticker, 'live', live.length, 'hist', hist.length, 'settled since', ms.length, 'sample', JSON.stringify(live[0] || hist[0] || {}).slice(0, 1500));
    const seen = new Set(); let done = 0;
    await pool(ms, 8, async m => {
      if (seen.has(m.ticker)) return; seen.add(m.ticker);
      const p = !liveSet.has(m.ticker) ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${s.ticker}/markets/${m.ticker}/candlesticks`;
      const end = Math.floor(Date.parse(m.close_time) / 1000), open = Math.floor(Date.parse(m.open_time) / 1000);
      const st = Math.max(open, end - 10 * 86400);
      const h = await get(K + p, { start_ts: st, end_ts: end, period_interval: 60 });
      out.push({ s: s.ticker, ev: m.event_ticker, t: m.ticker, title: m.title, sub: m.yes_sub_title, res: m.result, vol: num(m.volume_fp ?? m.volume),
        open: m.open_time, close: m.close_time, exp: m.expected_expiration_time ?? null, occ: m.occurrence_datetime ?? null, settle: m.settlement_ts ?? null,
        rules: (m.rules_primary || '').slice(0, 300), h: conv(h?.candlesticks) });
      if (++done % 500 === 0) { log(s.ticker, done, '/', ms.length, 'calls', calls, 'errs', errs); save('k-tennis', out); }
    });
    save('k-tennis', out);
  }
  save('k-tennis', out);
}

// ── Polymarket (international book, a proxy for PM US prices; nobody is sent there) ──
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const pj = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
async function history(token, startMs) {
  const s0 = Math.floor(startMs / 1000);
  const a = await get(`${CLOB}/prices-history`, { market: token, startTs: s0 - 48 * 3600, endTs: s0 + 600, fidelity: 10 });
  const b = await get(`${CLOB}/prices-history`, { market: token, startTs: s0 - 150 * 60, endTs: s0 + 15 * 60, fidelity: 1 });
  const rows = x => (x?.history || []).map(r => [Math.round((r.t * 1000 - startMs) / 60e3), r.p]);
  return { h: rows(a), mi: rows(b) };
}
async function polymarket(code) {
  const sp = await get(`${GAMMA}/sports`);
  log('pm sports', JSON.stringify((sp || []).filter(x => /atp|wta|ten/i.test(x.sport))).slice(0, 1500));
  const row = (sp || []).find(x => x.sport === code);
  const seriesIds = String(row?.series || '').split(',').map(Number).filter(Boolean);
  log('pm series', code, seriesIds);
  const evs = [];
  for (const series of seriesIds) {
    for (let off = 0; off < 60000; off += 100) {
      const d = await get(`${GAMMA}/events`, { series_id: series, closed: true, limit: 100, offset: off, order: 'startDate', ascending: false });
      if (!d || !d.length) break;
      evs.push(...d);
      const oldest = Math.min(...d.map(e => Date.parse(e.startDate || e.startTime || '') || Infinity));
      if (off === 0) log('pm sample', JSON.stringify(d[0]).slice(0, 2500));
      if (oldest < SINCE - 30 * 86400e3) break;
      await sleep(120);
    }
  }
  log('pm events', code, evs.length);
  const out = []; let done = 0, tested = false;
  await pool(evs, 6, async ev => {
    const ms = (ev.markets || []).filter(m => m.sportsMarketType === 'moneyline' || (!m.sportsMarketType && (pj(m.outcomes) || []).length === 2 && !/set|game|total|handicap/i.test(m.question || '')));
    const start = Date.parse(ev.startTime || ms[0]?.gameStartTime || '') || null;
    if (!start || start < SINCE || !ms.length) return;
    const m = ms[0]; const toks = pj(m.clobTokenIds) || [];
    if (!toks[0]) return;
    const hst = await history(toks[0], start);
    if (!tested) { tested = true; log('pm hist sample', m.question, hst.h.length, hst.mi.length, JSON.stringify(hst.mi.slice(-5))); }
    out.push({ slug: ev.slug, title: ev.title, start, vol: num(ev.volume), type: m.sportsMarketType, q: m.question, outcomes: pj(m.outcomes), prices: pj(m.outcomePrices), mvol: num(m.volumeNum ?? m.volume), gst: m.gameStartTime, ...hst });
    if (++done % 500 === 0) { log('pm', code, done, '/', evs.length, 'calls', calls, 'errs', errs); save(`pm-${code}`, out); }
  });
  save(`pm-${code}`, out);
}

// ── results ──
async function espnAll() {
  const out = [];
  const days = []; const UNTIL = Date.parse(process.env.UNTIL || '2100-01-01'); for (let t = SINCE; t < Math.min(Date.now(), UNTIL); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  const jobs = []; for (const tour of ['atp', 'wta']) for (const d of days) jobs.push([tour, d]);
  let done = 0;
  await pool(jobs, 6, async ([tour, d]) => {
    const b = await get(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard`, { dates: d });
    for (const ev of b?.events || []) for (const g of ev.groupings || []) for (const c of g.competitions || []) {
      const slug = c.type?.slug || g.grouping?.slug || '';
      if (!/singles/i.test(slug + (c.type?.text || '') + (g.grouping?.displayName || ''))) continue;
      const ps = (c.competitors || []).map(x => ({ n: x.athlete?.displayName || '', id: x.id, w: x.winner ? 1 : 0, s: (x.linescores || []).map(s => num(s.value)) }));
      if (ps.length !== 2) continue;
      out.push({ tour, d, ev: ev.name, evId: ev.id, cid: c.id, date: c.date || c.startDate, tbd: !!c.timeValid === false ? 1 : 0, st: c.status?.type?.name, done: c.status?.type?.completed ? 1 : 0,
        round: c.round?.displayName || null, venue: c.venue?.fullName || null, surface: ev.surface || c.surface || null, ps });
    }
    if (++done % 400 === 0) { log('espn', done, '/', jobs.length, out.length); }
    if (done === 1 && b) log('espn sample', JSON.stringify(b).slice(0, 3000));
  });
  save('espn', out);
}
async function tdAll() {
  fs.mkdirSync('data/td', { recursive: true });
  const UA = { 'User-Agent': 'Mozilla/5.0 (LineReaper research; one download per file)' };
  for (let y = 2015; y <= 2026; y++) for (const [dir, tag] of [[`${y}`, 'atp'], [`${y}w`, 'wta']]) for (const ext of ['xlsx', 'xls']) {
    const b = await get(`http://www.tennis-data.co.uk/${dir}/${y}.${ext}`, {}, UA, 3, 'buf');
    log('td', dir, ext, b ? b.length : 'none');
    if (b && b.length > 5000) { fs.writeFileSync(`data/td/${tag}-${y}.${ext}`, b); break; }
    await sleep(800);
  }
}
function sackAll() {
  const out = [];
  for (const [tour, dir] of [['atp', 'tennis_atp'], ['wta', 'tennis_wta']]) {
    if (!fs.existsSync(dir)) { log('no clone', dir); continue; }
    const files = fs.readdirSync(dir).filter(f => /_matches_(qual_chall_|qual_itf_)?\d{4}\.csv$/.test(f) && +f.match(/(\d{4})\.csv$/)[1] >= 2010);
    log(dir, 'files', files.length, files.slice(-6).join(' '));
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
      const hd = lines[0].split(','); const ix = k => hd.indexOf(k);
      const I = { tid: ix('tourney_id'), tn: ix('tourney_name'), sf: ix('surface'), lv: ix('tourney_level'), d: ix('tourney_date'), mn: ix('match_num'), wid: ix('winner_id'), wn: ix('winner_name'), lid: ix('loser_id'), ln: ix('loser_name'), sc: ix('score'), bo: ix('best_of'), rd: ix('round'), wr: ix('winner_rank'), lr: ix('loser_rank') };
      for (const l of lines.slice(1)) {
        const c = l.split(',');
        out.push([tour, c[I.tid], c[I.tn], c[I.sf], c[I.lv], c[I.d], +c[I.mn] || 0, c[I.wid], c[I.wn], c[I.lid], c[I.ln], c[I.sc], +c[I.bo] || 3, c[I.rd], +c[I.wr] || null, +c[I.lr] || null]);
      }
    }
  }
  log('sack rows', out.length, 'last date', out.reduce((m, r) => (r[5] > m ? r[5] : m), ''));
  save('sack', out);
}

(async () => {
  const [kind, arg] = PART.split(':');
  if (kind === 'k') await kalshiAll();
  else if (kind === 'pm') await polymarket(arg);
  else if (kind === 'res' && arg === 'espn') await espnAll();
  else if (kind === 'res' && arg === 'td') await tdAll();
  else if (kind === 'res' && arg === 'sack') sackAll();
  log('done', PART, 'calls', calls, 'errs', errs, 'min', Math.round((Date.now() - T0) / 60e3));
})();
