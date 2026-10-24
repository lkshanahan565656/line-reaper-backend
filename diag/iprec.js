// In-play esports recorder (diag only; runs in GitHub Actions because Kalshi answers only there).
// Logs, as JSON lines in out/rec.jsonl:
//   k    Kalshi map + match markets of every esports event that has started (or starts within 15 min):
//        bid/ask/sizes/last/volume per market, on change, every ~15 s; orderbook depth every 60 s
//   lol  lolesports live-stats frames of every live game (gold, kills, towers, dragons, barons, inhibs)
//   dota OpenDota /live pro games (radiant lead, scores, game time, delay)
//   cs   bo3.gg current CS2 matches: map scores and the live map's rounds
//   val  vlr.gg live Valorant matches: map scores (scraped HTML, research only)
// Every line carries t = when we received it (ms), so feed lag and Kalshi reaction lag can be measured.
const fs = require('fs');
const RUN_MS = +(process.env.RUN_MIN || 330) * 60e3, T0 = Date.now();
fs.mkdirSync('out', { recursive: true });
const out = fs.createWriteStream('out/rec.jsonl', { flags: 'a' });
const W = o => out.write(JSON.stringify(o) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { startedAt: new Date().toISOString(), ticks: {}, errors: {}, last: {} };
const num = v => (v == null || v === '' ? null : Number(v));
async function get(u, headers = {}, text = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) { stats.errors[new URL(u).host] = `${r.status} ${u.slice(0, 120)}`; return null; }
      const b = await r.text();
      if (text) return b;
      try { return JSON.parse(b); } catch { return null; }
    } catch (e) { stats.errors[new URL(u).host] = e.message; await sleep(800); }
  }
  return null;
}
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function etToUtc(y, mo, d, h, mi) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const off of [4, 5]) { const t = Date.UTC(y, mo, d, h + off, mi); const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value])); if (+p.hour % 24 === h && +p.minute === mi && +p.day === d) return t; }
  return Date.UTC(y, mo, d, h + 4, mi);
}
const startOf = ev => { const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ev); return m ? etToUtc(2000 + +m[1], MON[m[2]], +m[3], +m[4], +m[5]) : null; };
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = ['KXCS2MAP', 'KXCS2GAME', 'KXLOLMAP', 'KXLOLGAME', 'KXDOTA2MAP', 'KXDOTA2GAME', 'KXVALORANTMAP', 'KXVALORANTGAME'];
const kLast = new Map(), kMeta = new Set();
let kLive = [];
async function kalshi() {
  const now = Date.now(), live = [];
  await Promise.all(SERIES.map(async s => {
    let cursor = '';
    for (let p = 0; p < 5; p++) {
      const d = await get(`${K}/events?series_ticker=${s}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      for (const e of d?.events || []) {
        const st = startOf(e.event_ticker);
        if (!st || st > now + 15 * 60e3 || st < now - 8 * 3600e3) continue;
        for (const m of e.markets || []) {
          if (!kMeta.has(m.ticker)) { kMeta.add(m.ticker); W({ t: now, s: 'km', tk: m.ticker, ev: e.event_ticker, sub: m.yes_sub_title, title: e.title, st, sub2: e.sub_title }); }
          const v = [num(m.yes_bid_dollars), num(m.yes_ask_dollars), num(m.yes_bid_size_fp), num(m.yes_ask_size_fp), num(m.last_price_dollars), num(m.volume_fp), m.status, m.result || ''];
          const j = JSON.stringify(v);
          if (kLast.get(m.ticker) !== j) { kLast.set(m.ticker, j); W({ t: now, s: 'k', tk: m.ticker, v }); }
          if (m.status === 'active') live.push(m.ticker);
        }
      }
      cursor = d?.cursor; if (!cursor) break;
    }
  }));
  kLive = live;
}
async function kbooks() {
  const now = Date.now();
  for (const tk of kLive) {
    const d = await get(`${K}/markets/${tk}/orderbook?depth=8`);
    const ob = d?.orderbook_fp; if (!ob) continue;
    W({ t: now, s: 'kb', tk, y: (ob.yes_dollars || []).slice(-8).map(([p, q]) => [+p, +q]), n: (ob.no_dollars || []).slice(-8).map(([p, q]) => [+p, +q]) });
    await sleep(60);
  }
}
// LoL
const LK = { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z', 'User-Agent': 'Mozilla/5.0 (LineReaper research)' };
let lolGames = [], lolLastTs = new Map();
async function lolLive() {
  const d = await get('https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US', LK);
  const evs = (d?.data?.schedule?.events || []).filter(e => e.type === 'match' && e.state === 'inProgress' && e.match);
  const games = [];
  for (const e of evs) {
    const det = await get(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${e.match.id}`, LK);
    const m = det?.data?.event?.match;
    for (const g of m?.games || []) if (g.state === 'inProgress' || g.state === 'unstarted' && 0) games.push({ id: g.id, n: g.number, match: e.match.id, lg: e.league?.name, teams: (m.teams || []).map(t => [t.id, t.name, t.code, t.result?.gameWins]), sides: g.teams });
    W({ t: Date.now(), s: 'lolm', match: e.match.id, lg: e.league?.name, start: e.startTime, bo: e.match.strategy?.count, teams: (m?.teams || e.match.teams || []).map(t => [t.id, t.name, t.code, t.result?.gameWins]), games: (m?.games || []).map(g => [g.id, g.number, g.state, (g.teams || []).map(x => [x.id, x.side])]) });
  }
  lolGames = games;
}
async function lolFrames() {
  for (const g of lolGames) {
    const st = new Date(Math.floor((Date.now() - 50e3) / 10e3) * 10e3).toISOString();
    const d = await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}?startingTime=${st}`, LK);
    const fr = d?.frames || []; if (!fr.length) continue;
    const f = fr[fr.length - 1]; if (lolLastTs.get(g.id) === f.rfc460Timestamp) continue;
    lolLastTs.set(g.id, f.rfc460Timestamp);
    const side = x => [x.totalGold, x.totalKills, x.towers, x.inhibitors, x.barons, (x.dragons || []).length, (x.dragons || []).join('|')];
    W({ t: Date.now(), s: 'lol', g: g.id, match: g.match, ts: Date.parse(f.rfc460Timestamp), st: f.gameState, b: side(f.blueTeam), r: side(f.redTeam), bt: d.gameMetadata?.blueTeamMetadata?.esportsTeamId, rt: d.gameMetadata?.redTeamMetadata?.esportsTeamId });
  }
}
// Dota
const dLast = new Map();
async function dota() {
  const d = await get('https://api.opendota.com/api/live');
  for (const g of Array.isArray(d) ? d : []) {
    if (!g.league_id || !g.team_name_radiant || !g.team_name_dire) continue;
    const v = [g.game_time, g.radiant_lead, g.radiant_score, g.dire_score, g.last_update_time, g.delay, g.deactivate_time || 0];
    const j = JSON.stringify(v); if (dLast.get(g.match_id) === j) continue; dLast.set(g.match_id, j);
    W({ t: Date.now(), s: 'dota', id: g.match_id, sid: g.series_id, lg: g.league_id, rn: g.team_name_radiant, dn: g.team_name_dire, rid: g.team_id_radiant, did: g.team_id_dire, v, bi: g.building_state });
  }
}
// CS2 via bo3
const H3 = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const cLast = new Map(), teamNames = new Map();
async function cs() {
  const d = await get('https://api.bo3.gg/api/v1/matches?page[limit]=50&filter[matches.status][in]=current&filter[matches.discipline_id][eq]=1', H3);
  for (const m of d?.results || []) {
    const gs = await get(`https://api.bo3.gg/api/v1/games?filter[games.match_id][eq]=${m.id}&page[limit]=10`, H3);
    const games = (gs?.results || []).map(g => [g.id, g.number, g.map_name, g.status, g.state, g.winner_clan_name, g.loser_clan_name, g.winner_clan_score, g.loser_clan_score, g.rounds_count, g.begin_at]);
    const live = (gs?.results || []).find(g => g.status === 'current' || g.state === 'live' || g.state === 'in_progress');
    let rounds = null;
    if (live) { const r = await get(`https://api.bo3.gg/api/v1/games/${live.id}/rounds`, H3); rounds = (r?.game_rounds || []).map(x => [x.round_number, x.winner_clan_name, x.winner_clan_side, x.winner_clan_score, x.loser_clan_score, x.end_reason]); }
    const v = { s1: m.team1_score, s2: m.team2_score, l1: m.team1_last_game_score, l2: m.team2_last_game_score, lu: m.live_updates, games, rounds };
    const j = JSON.stringify(v); if (cLast.get(m.id) === j) continue; cLast.set(m.id, j);
    W({ t: Date.now(), s: 'cs', id: m.id, slug: m.slug, a: teamNames.get(m.team1_id), b: teamNames.get(m.team2_id), bo: m.bo_type, start: m.start_date, lc: m.live_coverage, ...v });
  }
}
// Valorant via vlr.gg (scraped page; research only)
const strip = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const vLast = new Map(), vSaved = new Set();
async function val() {
  const html = await get('https://www.vlr.gg/matches', { 'User-Agent': 'Mozilla/5.0 (LineReaper research)' }, true);
  if (!html) return;
  for (const mm of html.matchAll(/<a href="\/(\d+)\/[^"]*"[^>]*class="wf-module-item match-item[\s\S]*?<\/a>/g)) {
    if (!/mod-live/.test(mm[0])) continue;
    const id = mm[1];
    const page = await get(`https://www.vlr.gg/${id}`, { 'User-Agent': 'Mozilla/5.0 (LineReaper research)' }, true);
    if (!page) continue;
    if (!vSaved.has(id) && vSaved.size < 6) { vSaved.add(id); fs.writeFileSync(`out/vlr-${id}-${Date.now()}.html`, page); }
    const teams = [...page.matchAll(/<div class="wf-title-med[^"]*">([\s\S]*?)<\/div>/g)].map(x => strip(x[1])).slice(0, 2);
    const maps = [...page.matchAll(/<div class="vm-stats-game-header">([\s\S]*?)<div class="vm-stats-game-header-pick|<div class="vm-stats-game-header">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].length;
    const sc = [...page.matchAll(/<div class="score[^"]*">\s*(\d+)\s*<\/div>/g)].map(x => +x[1]);
    const mapNames = [...page.matchAll(/<div class="map">\s*<div[^>]*>\s*<span[^>]*>\s*([A-Za-z]+)/g)].map(x => x[1]);
    const series = strip((page.match(/<div class="js-spoiler[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '');
    const v = { teams, series, sc, mapNames, maps };
    const j = JSON.stringify(v); if (vLast.get(id) === j) continue; vLast.set(id, j);
    W({ t: Date.now(), s: 'val', id, ...v });
    await sleep(500);
  }
}
async function guard(name, fn) { try { await fn(); stats.ticks[name] = (stats.ticks[name] || 0) + 1; stats.last[name] = new Date().toISOString(); } catch (e) { stats.errors[name] = e.message; } }
(async () => {
  let i = 0;
  while (Date.now() - T0 < RUN_MS) {
    const t = Date.now();
    const jobs = [guard('kalshi', kalshi), guard('lolFrames', lolFrames)];
    if (i % 2 === 0) jobs.push(guard('dota', dota), guard('cs', cs));
    if (i % 4 === 0) jobs.push(guard('kbooks', kbooks), guard('lolLive', lolLive), guard('val', val));
    await Promise.all(jobs);
    if (i % 4 === 0) { stats.at = new Date().toISOString(); stats.kLive = kLive.length; stats.lolGames = lolGames.length; fs.writeFileSync('out/stats.json', JSON.stringify(stats, null, 1)); }
    i++;
    const w = 15e3 - (Date.now() - t); if (w > 0) await sleep(w);
  }
  out.end();
})();
