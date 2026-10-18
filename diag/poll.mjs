// polls prod open BetRivers flags and BetRivers' own (Kambi) offers side by side
import fs from 'fs'; import zlib from 'zlib';
const U = 'https://line-reaper-backend-production.up.railway.app';
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const LG = ['american_football/nfl', 'ice_hockey/nhl', 'baseball/mlb', 'american_football/ncaaf', 'basketball/nba'];
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' };
const get = async u => { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) }); return r.ok ? await r.json() : { _status: r.status }; } catch (e) { return { _err: String(e) }; } };
const MIN = +process.env.MINUTES || 14;
const out = zlib.createGzip(); out.pipe(fs.createWriteStream('out/poll.jsonl.gz'));
const w = o => out.write(JSON.stringify(o) + '\n');
const t0 = Date.now();
let ids = new Set();
for (let i = 0; Date.now() - t0 < MIN * 60e3; i++) {
  const at = new Date().toISOString();
  const open = await get(`${U}/api/ev/record/bets?limit=500&status=open`);
  const br = (open.bets || []).filter(b => b.book === 'betrivers');
  w({ at, type: 'prodOpen', bets: br });
  const ev = await get(`${U}/api/ev`);
  w({ at, type: 'prodEv', rows: (ev.rows || []).filter(r => /rivers/i.test(JSON.stringify(r).slice(0, 400))), updated: ev.updated });
  if (i % 5 === 0) for (const l of LG) {
    const lv = await get(`${KAMBI}/listView/${l}/all/all/matches.json?lang=en_US&market=US`);
    for (const e of lv.events || []) { const s = Date.parse(e.event?.start); if (s > Date.now() - 3600e3 && s < Date.now() + 36 * 3600e3) ids.add(e.event.id); }
  }
  for (const id of ids) w({ at: new Date().toISOString(), type: 'kambi', id, data: await get(`${KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`) });
  if (i % 2 === 0) for (const [s, id] of Object.entries({ football: 15, hockey: 19, baseball: 3 })) {
    w({ at: new Date().toISOString(), type: 'pin', sport: s, mu: await get(`${PIN}/sports/${id}/matchups`), mk: await get(`${PIN}/sports/${id}/markets/straight`) });
  }
  const wait = 60e3 - ((Date.now() - t0) % 60e3); await new Promise(r => setTimeout(r, wait));
}
out.end(); await new Promise(r => out.on('finish', r)); setTimeout(() => process.exit(0), 2000);
