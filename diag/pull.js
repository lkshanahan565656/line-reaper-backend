// Pulls per-player, per-game kills with team kills for LoL (Leaguepedia) and
// Dota (OpenDota explorer), plus a live snapshot of Pinnacle's esports kills
// markets and the gol.gg season table. Output: out/*.json.gz
const fs = require('fs');
const zlib = require('zlib');
const UA = 'LineReaper/3.118 (research; contact via github lkshanahan565656)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('out', { recursive: true });
const save = (f, x) => fs.writeFileSync(`out/${f}`, zlib.gzipSync(JSON.stringify(x)));
const log = (...a) => { console.log(...a); fs.appendFileSync('out/log.txt', a.join(' ') + '\n'); };

async function get(url, opts = {}) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': opts.ua || UA, Accept: 'application/json,text/html' }, signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      if (r.status === 429 || r.status >= 500) { log('retry', r.status, url.slice(0, 120)); await sleep(5000 * (i + 1)); continue; }
      return { status: r.status, text: t };
    } catch (e) { log('err', e.message, url.slice(0, 120)); await sleep(5000 * (i + 1)); }
  }
  return { status: 0, text: '' };
}

async function lol() {
  const rows = []; let errs = 0;
  const since = process.env.LOL_SINCE || '2025-10-01';
  for (let page = 0; page < 800; page++) {
    const p = new URLSearchParams({
      action: 'cargoquery', format: 'json', limit: '500', offset: String(page * 500),
      tables: 'ScoreboardPlayers=SP', fields: 'SP.Link=Link,SP.Team=Team,SP.Kills=Kills,SP.Role=Role,SP.GameId=GameId,SP.DateTime_UTC=DT,SP.OverviewPage=OP,SP.Side=Side',
      where: `SP.DateTime_UTC >= '${since}'`, order_by: 'SP.DateTime_UTC ASC, SP.GameId ASC',
    });
    let r = await get(`https://lol.fandom.com/api.php?${p}`);
    let j = null;
    try { j = JSON.parse(r.text); } catch { /* */ }
    if (j?.error) { log('cargo error', JSON.stringify(j.error).slice(0, 200)); if (++errs > 12) break; await sleep(30000); page--; continue; }
    const batch = (j?.cargoquery || []).map(x => x.title);
    if (!j) { log('lol page', page, 'status', r.status, r.text.slice(0, 200)); if (page > 3 || rows.length === 0) break; }
    rows.push(...batch);
    if (page % 20 === 0) log('lol page', page, rows.length, batch[batch.length - 1]?.DT);
    if (batch.length < 500) break;
    await sleep(1500);
  }
  log('lol rows', rows.length);
  save('lol.json.gz', rows);
}

async function dota() {
  const out = [];
  const start = Date.parse(process.env.DOTA_SINCE || '2025-10-01') / 1000;
  const now = Date.now() / 1000;
  for (let t = start; t < now; t += 15 * 86400) {
    const sql = `SELECT m.match_id, m.start_time, m.radiant_score, m.dire_score, m.radiant_win, m.leagueid, l.tier, pm.player_slot, pm.account_id, pm.kills
      FROM matches m JOIN player_matches pm USING(match_id) JOIN leagues l USING(leagueid)
      WHERE m.start_time >= ${Math.floor(t)} AND m.start_time < ${Math.floor(t + 15 * 86400)} AND l.tier IN ('premium','professional')
      ORDER BY m.match_id`;
    const r = await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(sql)}`);
    let j = null;
    try { j = JSON.parse(r.text); } catch { /* */ }
    const rows = j?.rows || [];
    log('dota', new Date(t * 1000).toISOString().slice(0, 10), r.status, rows.length, j?.err || '');
    out.push(...rows);
    await sleep(2000);
  }
  const pros = await get('https://api.opendota.com/api/proPlayers');
  let pp = [];
  try { pp = JSON.parse(pros.text).map(p => ({ account_id: p.account_id, name: p.name, team: p.team_name, role: p.fantasy_role })); } catch { /* */ }
  log('dota rows', out.length, 'pros', pp.length);
  save('dota.json.gz', { rows: out, pros: pp });
}

async function pinnacle() {
  const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', Accept: 'application/json' };
  const mu = await fetch(`${PIN}/sports/12/matchups`, { headers: h }).then(r => r.json()).catch(() => null);
  const mk = await fetch(`${PIN}/sports/12/markets/straight`, { headers: h }).then(r => r.json()).catch(() => null);
  log('pinnacle', mu?.length, mk?.length);
  save('pin.json.gz', { at: new Date().toISOString(), matchups: mu, markets: mk });
}

async function kambi() {
  const KB = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', Accept: 'application/json' };
  const lv = await fetch(`${KB}/listView/esports/all/all/all/matches.json?lang=en_US&market=US&useCombined=true`, { headers: h }).then(r => r.json()).catch(() => null);
  const evs = (lv?.events || []).map(x => x.event).filter(e => e && e.state === 'NOT_STARTED');
  const out = [];
  for (const e of evs.slice(0, 12)) out.push(await fetch(`${KB}/betoffer/event/${e.id}.json?lang=en_US&market=US&includeParticipants=true`, { headers: h }).then(r => r.json()).catch(() => null));
  log('kambi', evs.length);
  save('kambi.json.gz', out);
}

async function gol() {
  const y = new Date().getFullYear() - 2010;
  const r = await get(`https://gol.gg/players/list/season-S${y}/split-ALL/tournament-ALL/`, { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36' });
  log('gol', r.status, r.text.length);
  fs.writeFileSync('out/gol.html', r.text);
}

(async () => {
  const which = (process.env.WHICH || 'pin,kambi,gol,dota,lol').split(',');
  for (const w of which) { try { await ({ lol, dota, pin: pinnacle, gol, kambi })[w](); } catch (e) { log(w, 'failed', e.message); } }
})();
