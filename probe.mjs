import fs from 'fs';
const out = (f, d) => fs.writeFileSync('out/' + f, typeof d === 'string' ? d : JSON.stringify(d, null, 1));
const log = (...a) => { console.log(...a); fs.appendFileSync('out/summary.txt', a.join(' ') + '\n'); };
async function get(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t: j ? null : t.slice(0, 300) };
  } catch (e) { return { s: 0, e: String(e) }; }
}
const K = 'https://api.elections.kalshi.com/trade-api/v2', PM = 'https://gateway.polymarket.us', PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
fs.mkdirSync('out', { recursive: true });
const SER = 'KXF1RACE KXF1RACEPODIUM KXF1RACETOP5 KXF1RACETOP10 KXF1RACETOPX KXF1POLE KXF1POLEPOSITION KXF1QUALIFY KXF1H2H KXF1TOP5 KXF1TOP10 KXF1 KXF1CONSTRUCTORS KXF1FASTLAP KXPGATOUR KXGOLF KXGOLFTOURN KXPGAWIN KXPGATOP5 KXPGATOP10 KXPGATOP20 KXPGATOP40 KXPGAH2H KXGOLFH2H KXPGA3BALL KXPGAMAKECUT KXDPWORLDTOUR KXDPWTTOP5 KXDPWTTOP10 KXDPWTTOP20 KXDPWTH2H KXLIVTOUR KXSB KXNBA KXNHL KXMLB KXNBAMVP KXNFLMVP KXNBAEAST KXNBAWEST KXNFLAFCCHAMP KXNFLNFCCHAMP KXCHAMPTOUR'.split(' ');
const all = {};
for (const s of SER) {
  for (const st of ['open', 'settled']) {
    const r = await get(`${K}/events?series_ticker=${s}&status=${st}&with_nested_markets=true&limit=${st === 'open' ? 50 : 3}`);
    const ev = r.j?.events || [];
    all[`${s}|${st}`] = ev;
    for (const e of ev) {
      const ms = e.markets || [];
      const vol = ms.reduce((a, m) => a + Number(m.volume_fp ?? m.volume ?? 0), 0);
      const sumAsk = ms.reduce((a, m) => a + Number(m.yes_ask_dollars ?? (m.yes_ask / 100) ?? 0), 0);
      log(st, s, e.event_ticker, '|', e.title, '|', e.sub_title || '', '| mk', ms.length, 'vol', Math.round(vol), 'sumAsk', sumAsk.toFixed(2), 'close', ms[0]?.close_time, 'mutex', e.mutually_exclusive);
    }
    await new Promise(r => setTimeout(r, 150));
  }
}
out('kalshi-events2.json', all);
const sample = Object.values(all).flat().find(e => /KXF1RACE-|KXF1H2H/.test(e.event_ticker));
if (sample) out('kalshi-sample.json', sample);
// PM US listing variants
const pmv = ['/v2/leagues/f1/events?type=futures', '/v2/leagues/f1/events?type=all', '/v2/leagues/f1/events?section=futures', '/v2/leagues/f1/events?type=future',
  '/v1/events?seriesId=184&limit=20', '/v1/events?series_id=184&limit=20', '/v1/events?tagId=263&limit=20', '/v1/events?tag_id=263&limit=20', '/v1/events?active=true&closed=false&limit=20&tag_id=263',
  '/v2/series/184', '/v1/series/184', '/v2/leagues/f1', '/v2/leagues/f1/markets', '/v2/leagues/buttberm/events', '/v2/leagues/vidamexi/events', '/v2/leagues/vidamexi/events?type=futures',
  '/v1/events?seriesSlug=f1&limit=20', '/v1/events?league=f1&limit=20', '/v1/events?sport=f1&limit=20', '/v1/events?active=true&limit=20&offset=0&order=startDate&ascending=false'];
for (const p of pmv) {
  const r = await get(PM + p); out('pm' + p.replace(/[\/?=&]/g, '_') + '.json', r.j || r);
  const arr = r.j?.events || r.j?.markets || [];
  log('pmus', p, r.s, Array.isArray(arr) ? arr.length : '', (Array.isArray(arr) ? arr.slice(0, 6).map(e => `${e.slug}:${e.title || e.question}`).join(' || ') : '') || JSON.stringify(r.j)?.slice(0, 300) || r.e);
  await new Promise(r => setTimeout(r, 500));
}
// Pinnacle F1 + golf leagues full (sport 44 F1, 17 golf)
for (const sid of [44, 17]) {
  const lg = await get(`${PIN}/sports/${sid}/leagues?all=true`); log('pin all leagues', sid, (lg.j || []).filter(l => l.matchupCount).map(l => `${l.id}:${l.name}:${l.matchupCount}`).join(' | '));
}
