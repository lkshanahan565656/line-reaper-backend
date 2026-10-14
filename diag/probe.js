const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = async u => { const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); const t = await r.text(); try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 500) }; } };
const save = (n, x) => fs.writeFileSync(`out/${n}.json`, JSON.stringify(x));
const FD = p => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
const FDE = (id, tab) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${id}${tab ? `&tab=${tab}` : ''}`;
const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
(async () => {
  const log = [];
  for (const lg of ['nfl', 'ncaaf', 'nhl', 'nba']) {
    const p = await get(FD(lg)); save(`fd-${lg}`, p);
    const evs = Object.values(p.data?.attachments?.events || {}).filter(e => Date.parse(e.openDate) > Date.now()).sort((a, b) => Date.parse(a.openDate) - Date.parse(b.openDate));
    const types = {}; for (const m of Object.values(p.data?.attachments?.markets || {})) types[m.marketType] = (types[m.marketType] || 0) + 1;
    log.push({ lg, status: p.status, events: evs.length, types });
    for (const e of evs.slice(0, lg === 'nfl' ? 2 : 1)) {
      const base = await get(FDE(e.eventId));
      const tabs = (base.data?.layout?.tabs ? Object.values(base.data.layout.tabs) : []).map(t => t.title);
      log.push({ lg, ev: e.name, tabs });
      save(`fde-${lg}-${e.eventId}-main`, base);
      for (const t of tabs) {
        const slug = String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const r = await get(FDE(e.eventId, slug)); save(`fde-${lg}-${e.eventId}-${slug}`, r);
      }
    }
    const kl = await get(`${KAMBI}/listView/${{ nfl: 'american_football/nfl', ncaaf: 'american_football/ncaaf', nhl: 'ice_hockey/nhl', nba: 'basketball/nba' }[lg]}/all/all/matches.json?lang=en_US&market=US`);
    const ids = (kl.data?.events || []).map(x => x.event).filter(e => e.state === 'NOT_STARTED').sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, lg === 'nfl' ? 2 : 1);
    for (const e of ids) { const r = await get(`${KAMBI}/betoffer/event/${e.id}.json?lang=en_US&market=US`); save(`kb-${lg}-${e.id}`, r); log.push({ lg, kambi: e.englishName, offers: (r.data?.betOffers || []).length }); }
  }
  for (const [n, id] of [['nfl', 889], ['ncaaf', 880]]) {
    const [mu, mk] = await Promise.all([get(`${PIN}/leagues/${id}/matchups`), get(`${PIN}/leagues/${id}/markets/straight`)]);
    save(`pin-${n}-matchups`, mu); save(`pin-${n}-markets`, mk);
  }
  save('log', log);
})();
