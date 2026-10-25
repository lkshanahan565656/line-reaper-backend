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
      if (r.status === 204) return null;
      const body = await r.text();
      if (text) return body;
      if (!body) return null;
      try { return JSON.parse(body); } catch { return null; }
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
const KT = { CS2: 'CS2', LOL: 'LOL', VAL: 'VALORANT', DOTA: 'DOTA2' };
const BO3 = 'https://api.bo3.gg/api/v1', H3 = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
const LOLESPORTS = 'https://esports-api.lolesports.com/persisted/gw/getSchedule', LKEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const strip = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

// ════ in-play history ════
const fsx = require('fs');
const UNTIL = Date.parse(process.env.UNTIL || new Date().toISOString());
const convM = (cs) => (cs || []).map(k => [Math.round(k.end_period_ts / 60), num(k.yes_ask?.close_dollars ?? k.yes_ask?.close), num(k.yes_bid?.close_dollars ?? k.yes_bid?.close), Math.round(num(k.volume_fp ?? k.volume) || 0), num(k.price?.close_dollars ?? k.price?.close), num(k.yes_ask?.high_dollars ?? k.yes_ask?.high), num(k.yes_ask?.low_dollars ?? k.yes_ask?.low), num(k.yes_bid?.high_dollars ?? k.yes_bid?.high), num(k.yes_bid?.low_dollars ?? k.yes_bid?.low)]);
// Kalshi map + match markets, minute candles from the scheduled start - 30 min to close + 5 min
async function kInplay(title) {
  const p = KT[title], all = [];
  for (const suf of ['MAP', 'GAME']) {
    const series = `KX${p}${suf}`;
    const live = await listMarkets(series, false), hist = await listMarkets(series, true);
    const liveSet = new Set(live.map(m => m.ticker)), byEv = new Map();
    for (const m of [...hist, ...live]) {
      if (!(m.result === 'yes' || m.result === 'no')) continue;
      const a = byEv.get(m.event_ticker) || []; if (!a.some(x => x.ticker === m.ticker)) a.push({ ...m, _hist: !liveSet.has(m.ticker) }); byEv.set(m.event_ticker, a);
    }
    const evs = [...byEv].map(([ev, ms]) => ({ ev, ms, start: startFromTicker(ev) })).filter(e => e.start && e.start >= SINCE && e.start <= UNTIL).sort((a, b) => b.start - a.start);
    log(series, 'events', evs.length);
    let done = 0;
    await pool(evs, 8, async ({ ev, ms, start }) => {
      const rec = { s: series, ev, start, title: ms[0].title, ms: [] };
      for (const m of ms) {
        const path = m._hist ? `/historical/markets/${m.ticker}/candlesticks` : `/series/${series}/markets/${m.ticker}/candlesticks`;
        const s0 = Math.floor(start / 1000) - 1800, close = Math.floor(Date.parse(m.close_time || '') / 1000) || (s0 + 6 * 3600);
        const s1 = Math.min(close + 300, s0 + 12 * 3600);
        const c = await get(K + path, { start_ts: s0, end_ts: s1, period_interval: 1 });
        rec.ms.push({ t: m.ticker, sub: m.yes_sub_title, res: m.result, vol: num(m.volume_fp ?? m.volume), close: m.close_time, settled: m.settlement_ts || null, c: convM(c?.candlesticks) });
      }
      all.push(rec);
      if (++done % 500 === 0) { log(series, done, '/', evs.length, 'calls', calls, 'errs', errs); save(`kip-${title}`, all); }
    });
    save(`kip-${title}`, all);
  }
}
// LoL: every completed lolesports game since SINCE, its live-stats frames (every 10 s) walked from start to end
const LKH = { 'x-api-key': LKEY, 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
async function lolFrames() {
  const matches = []; let token = null;
  for (let p = 0; p < 900; p++) {
    const d = await get(LOLESPORTS, { hl: 'en-US', pageToken: token }, { 'x-api-key': LKEY });
    const sch = d?.data?.schedule, evs = sch?.events || [];
    for (const e of evs) if (e.type === 'match' && e.state === 'completed' && e.match && Date.parse(e.startTime) >= SINCE && Date.parse(e.startTime) <= UNTIL) matches.push(e);
    token = sch?.pages?.older; if (!token || !evs.length) break;
    if (Math.min(...evs.map(e => Date.parse(e.startTime) || Infinity)) < SINCE) break;
    await sleep(150);
  }
  // optional: only matches whose teams sit on a Kalshi LoL event within 12 h; shard by index
  if (process.env.KFILTER) {
    const kev = [];
    for (const sr of ['KXLOLGAME', 'KXLOLMAP']) for (const m of [...await listMarkets(sr, false), ...await listMarkets(sr, true)]) { const st = startFromTicker(m.event_ticker); if (st && st >= SINCE) kev.push({ st, sub: squash(m.yes_sub_title) }); }
    const hit = e => { const t = Date.parse(e.startTime); return (e.match.teams || []).some(tm => [tm.name, tm.code].some(n => { const q = squash(n); return q.length >= 2 && kev.some(k => Math.abs(k.st - t) < 12 * 3600e3 && (k.sub === q || (q.length >= 4 && (k.sub.includes(q) || q.includes(k.sub))))); })); };
    const before = matches.length; matches.splice(0, matches.length, ...matches.filter(hit));
    log('kalshi filter', before, '->', matches.length);
  }
  { const sh = +(process.env.SHARD || 0), nsh = +(process.env.NSHARD || 1); const mine = matches.filter((m, i) => i % nsh === sh); matches.splice(0, matches.length, ...mine); }
  log('lol matches', matches.length);
  const out = []; let done = 0;
  const side = x => [x.totalGold, x.totalKills, x.towers, x.inhibitors, x.barons, (x.dragons || []).length];
  await pool(matches, 4, async e => {
    const det = await get(`${LOLESPORTS.replace('getSchedule', 'getEventDetails')}`, { hl: 'en-US', id: e.match.id }, { 'x-api-key': LKEY });
    const m = det?.data?.event?.match; if (!m) return;
    const rec = { id: e.match.id, t: e.startTime, lg: e.league?.name, bo: e.match.strategy?.count, teams: (e.match.teams || []).map(t => [t.name, t.code, t.result?.gameWins]), tids: (m.teams || []).map(t => [t.id, t.name, t.code]), g: [] };
    let cursor = Date.parse(e.startTime) - 10 * 60e3;
    for (const g of m.games || []) {
      if (g.state !== 'completed') continue;
      const end = await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}`, {}, LKH);
      const lastF = end?.frames?.slice(-1)[0];
      if (!lastF) { rec.g.push({ id: g.id, n: g.number, none: 1 }); continue; }
      // the window with no start returns the game's FIRST frames: walk forward from there
      let t = Date.parse(end.frames[0].rfc460Timestamp), frames = [], guard = 0;
      const tEnd = t + 80 * 60e3;
      while (t < tEnd && guard++ < 60) {
        const st = new Date(Math.floor(t / 10e3) * 10e3).toISOString();
        const w = await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}`, { startingTime: st }, LKH);
        const fr = w?.frames || [];
        if (!fr.length) { if (frames.length) break; t += 60e3; continue; }
        for (const f of fr) { const ts = Date.parse(f.rfc460Timestamp); if (!frames.length || ts > frames[frames.length - 1][0]) frames.push([ts, f.gameState === 'finished' ? 1 : 0, ...side(f.blueTeam), ...side(f.redTeam)]); }
        const lt = frames[frames.length - 1][0];
        if (fr.slice(-1)[0].gameState === 'finished') break;
        t = lt + 10e3;
      }
      rec.g.push({ id: g.id, n: g.number, sides: (g.teams || []).map(x => [x.id, x.side]), bt: end.gameMetadata?.blueTeamMetadata?.esportsTeamId, rt: end.gameMetadata?.redTeamMetadata?.esportsTeamId, f: frames });
      cursor = frames.length ? frames[frames.length - 1][0] : cursor;
    }
    out.push(rec);
    if (++done % 25 === 0) { log('lol', done, '/', matches.length, 'calls', calls, 'errs', errs); save(`lolf-${process.env.SHARD || 0}`, out); }
  });
  save(`lolf-${process.env.SHARD || 0}`, out);
}
// Dota: OpenDota pro matches since SINCE; details (gold lead per minute, objectives) for those near a Kalshi esports event
async function dotaDetails() {
  const kev = [];
  for (const s of ['KXDOTA2GAME', 'KXDOTA2MAP']) for (const m of [...await listMarkets(s, false), ...await listMarkets(s, true)]) { const st = startFromTicker(m.event_ticker); if (st && st >= SINCE) kev.push({ st, sub: squash(m.yes_sub_title) }); }
  log('kalshi dota markets', kev.length);
  const rows = []; let before = null;
  for (let i = 0; i < 400; i++) {
    const b = await get('https://api.opendota.com/api/proMatches', before ? { less_than_match_id: before } : {}, {}, 8);
    if (!Array.isArray(b)) { await sleep(20000); continue; }
    if (!b.length) break;
    rows.push(...b);
    before = Math.min(...b.map(m => m.match_id));
    if (Math.min(...b.map(m => m.start_time * 1000)) < SINCE) break;
    await sleep(1100);
  }
  const near = m => { const t = m.start_time * 1000, a = squash(m.radiant_name), d = squash(m.dire_name); return kev.some(k => Math.abs(k.st - t) < 8 * 3600e3 && k.sub.length >= 3 && (a.includes(k.sub) || k.sub.includes(a) || d.includes(k.sub) || k.sub.includes(d))); };
  const want = rows.filter(m => m.start_time * 1000 >= SINCE && near(m));
  const sh = +(process.env.SHARD || 0), nsh = +(process.env.NSHARD || 1);
  const mine = want.filter((m, i) => i % nsh === sh);
  log('dota pro', rows.length, 'near kalshi', want.length, 'mine', mine.length);
  const out = []; let done = 0;
  for (const m of mine) {
    if (Date.now() - T0 > BUDGET) break;
    const d = await get(`https://api.opendota.com/api/matches/${m.match_id}`, {}, {}, 4);
    if (d && d.match_id) out.push({ id: d.match_id, st: d.start_time, dur: d.duration, pre: d.pre_game_duration, rw: d.radiant_win ? 1 : 0, rn: d.radiant_name || d.radiant_team?.name, dn: d.dire_name || d.dire_team?.name, rid: d.radiant_team_id, did: d.dire_team_id, sid: d.series_id, stype: d.series_type, lg: d.leagueid, ga: d.radiant_gold_adv, xa: d.radiant_xp_adv, obj: (d.objectives || []).filter(o => /TOWER|BARRACKS|ROSHAN|AEGIS|FIRSTBLOOD/.test(o.type) || o.type === 'building_kill').map(o => [o.time, o.type, o.team ?? o.player_slot ?? null, o.key || null]), tf: (d.teamfights || []).map(f => [f.start, f.end, f.deaths]) });
    if (++done % 100 === 0) { log('dota', done, '/', mine.length, 'calls', calls, 'errs', errs); save(`dota-${sh}`, out); }
    await sleep(1100);
  }
  save(`dota-${sh}`, out);
}
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// CS2: bo3 finished matches since SINCE, every map's round-by-round winners and durations
async function csRounds() {
  const ms = [];
  for (let p = 0; p < 600; p++) {
    const d = await get(`${BO3}/matches`, { 'page[offset]': p * 100, 'page[limit]': 100, sort: '-start_date', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 }, H3);
    const rows = d?.results || [];
    ms.push(...rows.filter(m => Date.parse(m.start_date) >= SINCE && Date.parse(m.start_date) <= UNTIL).map(m => ({ id: m.id, slug: m.slug, a: m.team1_id, b: m.team2_id, s1: m.team1_score, s2: m.team2_score, t: m.start_date, end: m.end_date, bo: m.bo_type, tier: m.tier, w: m.winner_team_id, bu: m.bet_updates ? [m.bet_updates.team_1?.coeff, m.bet_updates.team_2?.coeff] : null })));
    if (rows.length < 100 || Math.min(...rows.map(m => Date.parse(m.start_date) || Infinity)) < SINCE) break;
    await sleep(150);
  }
  const ids = [...new Set(ms.flatMap(m => [m.a, m.b]).filter(x => x != null))], names = {};
  for (let i = 0; i < ids.length; i += 100) { const d = await get(`${BO3}/teams`, { 'filter[teams.id][in]': ids.slice(i, i + 100).join(','), 'page[limit]': 100 }, H3); for (const t of d?.results || []) names[t.id] = t.name; await sleep(120); }
  log('cs matches', ms.length);
  const sh = +(process.env.SHARD || 0), nsh = +(process.env.NSHARD || 1);
  const mine = ms.filter((m, i) => i % nsh === sh);
  const out = []; let done = 0;
  await pool(mine, 4, async m => {
    const gs = await get(`${BO3}/games`, { 'filter[games.match_id][eq]': m.id, 'page[limit]': 10 }, H3);
    const rec = { ...m, an: names[m.a] || null, bn: names[m.b] || null, g: [] };
    for (const g of gs?.results || []) {
      if (g.status !== 'finished') continue;
      const r = await get(`${BO3}/games/${g.id}/rounds`, {}, H3);
      rec.g.push({ id: g.id, n: g.number, map: g.map_name, begin: g.begin_at, dur: g.duration ? Math.round(g.duration / 1e9) : null, w: g.winner_clan_name, l: g.loser_clan_name, ws: g.winner_clan_score, ls: g.loser_clan_score, r: (r?.game_rounds || []).sort((a, b) => a.round_number - b.round_number).map(x => [x.round_number, x.winner_clan_name, x.winner_clan_side, x.round_duration ? Math.round(x.round_duration / 1e9) : null, x.end_reason]) });
    }
    out.push(rec);
    if (++done % 500 === 0) { log('cs', done, '/', mine.length, 'calls', calls, 'errs', errs); save(`csr-${sh}`, out); }
  });
  save(`csr-${sh}`, out);
}
// Valorant: vlr.gg result pages since SINCE, each match page's round-by-round winners per map (scraped; research only)
async function valRounds() {
  const ids = [];
  for (let page = 1; page <= 400 && Date.now() - T0 < BUDGET / 3; page++) {
    const html = await get(`https://www.vlr.gg/matches/results${page > 1 ? `/?page=${page}` : ''}`, {}, { 'User-Agent': 'Mozilla/5.0 (LineReaper research)' }, 6, true);
    if (!html) continue;
    let oldest = Infinity, n = 0;
    for (const part of html.split(/<div class="wf-label mod-large">/).slice(1)) {
      const day = Date.parse(strip(part.slice(0, part.indexOf('</div>'))).replace(/Today|Yesterday/g, '').trim()) || 0;
      for (const mm of part.matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item/g)) { ids.push([mm[1], day]); oldest = Math.min(oldest, day); n++; }
    }
    if (!n || oldest < SINCE) break;
    await sleep(700);
  }
  log('val ids', ids.length);
  const out = []; let done = 0;
  for (const [id, day] of ids) {
    if (day && day < SINCE) continue;
    if (Date.now() - T0 > BUDGET) break;
    const html = await get(`https://www.vlr.gg/${id}`, {}, { 'User-Agent': 'Mozilla/5.0 (LineReaper research)' }, 4, true);
    if (!html) continue;
    const teams = [...html.matchAll(/<div class="wf-title-med[^"]*">([\s\S]*?)<\/div>/g)].map(x => strip(x[1])).slice(0, 2);
    const ts = (html.match(/data-utc-ts="([^"]+)"/) || [])[1] || null;
    const maps = [];
    for (const part of html.split(/<div class="vm-stats-game "/).slice(1)) {
      const name = strip((part.match(/<div class="map">[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '').split(' ')[0];
      const sc = [...part.slice(0, 4000).matchAll(/<div class="score[^"]*">\s*(\d+)\s*<\/div>/g)].map(x => +x[1]).slice(0, 2);
      const rounds = [...part.matchAll(/<div class="vlr-rounds-row-col"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g)].map(c => {
        const sq = [...c[1].matchAll(/<div class="rnd-sq([^"]*)"/g)].map(x => x[1]);
        const wi = sq.findIndex(s => /mod-win/.test(s)); if (wi < 0) return null;
        return [wi, /mod-ct/.test(sq[wi]) ? 'ct' : /mod-t/.test(sq[wi]) ? 't' : ''];
      }).filter(Boolean);
      if (sc.length === 2) maps.push({ name, sc, r: rounds });
    }
    out.push({ id, ts, day, teams, maps });
    if (++done % 300 === 0) { log('val', done, '/', ids.length); save('valr', out); }
    await sleep(700);
  }
  save('valr', out);
}
(async () => {
  const [kind, arg] = PART.split(':');
  try {
    if (kind === 'k') await kInplay(arg);
    else if (kind === 'lol') await lolFrames();
    else if (kind === 'dota') await dotaDetails();
    else if (kind === 'cs') await csRounds();
    else if (kind === 'val') await valRounds();
  } catch (e) { log('FAIL', e.stack); }
  log('done', PART, 'calls', calls, 'errs', errs, 'min', ((Date.now() - T0) / 60e3).toFixed(1));
})();
