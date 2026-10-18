// polls prod's open FanDuel alt flags next to FanDuel's own event pages and Pinnacle
import fs from 'fs'; import zlib from 'zlib';
const U = 'https://line-reaper-backend-production.up.railway.app';
const AK = 'FhMFpcPWXMeyZxOx';
const FDL = p => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`;
const FDE = (id, tab) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${AK}&eventId=${id}${tab ? `&tab=${tab}` : ''}`;
const TABS = { nfl: ['popular', 'passing-props', 'receiving-props', 'rushing-props', 'td-scorer-props'], ncaaf: ['popular', 'passing-props', 'receiving-props', 'rushing-props', 'td-scorer-props'],
  nhl: ['popular', 'shots', 'goals', 'points-assists'], mlb: ['popular', 'pitcher-props', 'hits-runs'], wnba: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes'] };
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' };
const get = async u => { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) }); return r.ok ? await r.json() : { _status: r.status }; } catch (e) { return { _err: String(e) }; } };
const MIN = +process.env.MINUTES || 14;
const out = zlib.createGzip(); out.pipe(fs.createWriteStream('out/poll.jsonl.gz'));
const w = o => out.write(JSON.stringify(o) + '\n');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const t0 = Date.now();
let leagues = {};
for (let i = 0; Date.now() - t0 < MIN * 60e3; i++) {
  const at = new Date().toISOString();
  const open = await get(`${U}/api/ev/record/bets?alt=1&limit=500&status=open`);
  const fd = (open.bets || []).filter(b => b.book === 'fanduel');
  w({ at, type: 'prodOpen', n: (open.bets || []).length, bets: fd });
  const ev = await get(`${U}/api/ev`);
  w({ at, type: 'prodEvAlt', alt: ev.alt || null, updated: ev.updated, counts: ev.counts });
  if (i % 4 === 0) for (const lg of Object.keys(TABS)) leagues[lg] = await get(FDL(lg));
  // FanDuel events with an open FanDuel alt flag starting within 12 h (at most 10)
  const want = new Map();
  for (const [lg, page] of Object.entries(leagues)) for (const e of Object.values(page?.attachments?.events || {})) {
    const s = Date.parse(e.openDate); if (!(s > Date.now() && s < Date.now() + 12 * 3600e3)) continue;
    const n = norm(e.name);
    if (fd.some(b => { const [a, h] = String(b.event || '').split(' @ '); return n.includes(norm(a).slice(0, 6)) && n.includes(norm(h).slice(0, 6)); })) want.set(e.eventId, { lg, name: e.name, start: e.openDate });
  }
  let k = 0;
  for (const [id, m] of want) { if (k++ >= 10) break; for (const tab of TABS[m.lg]) w({ at: new Date().toISOString(), type: 'fd', id, ...m, tab, data: await get(FDE(id, tab)) }); }
  if (i % 2 === 0) for (const [s, id] of Object.entries({ football: 15, hockey: 19, baseball: 3, basketball: 4 })) {
    w({ at: new Date().toISOString(), type: 'pin', sport: s, mu: await get(`${PIN}/sports/${id}/matchups`), mk: await get(`${PIN}/sports/${id}/markets/straight`) });
  }
  const wait = 120e3 - ((Date.now() - t0) % 120e3); await new Promise(r => setTimeout(r, wait));
}
out.end(); await new Promise(r => out.on('finish', r)); setTimeout(() => process.exit(0), 2000);
