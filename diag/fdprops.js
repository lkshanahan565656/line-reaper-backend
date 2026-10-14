const axios = require('axios'); const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = u => axios.get(u, { timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: () => true });
const EP = (id, tab) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${id}${tab ? `&tab=${tab}` : ''}&useCombinedTouchdownsVirtualMarket=true&usePulse=true&useQuickBets=true`;
const FD = p => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
(async () => {
  for (const lg of ['nfl', 'nhl', 'mlb', 'nba']) {
    const p = (await get(FD(lg))).data;
    const ev = Object.values(p?.attachments?.events || {}).find(e => / @ /.test(e.name) && Date.parse(e.openDate) > Date.now());
    if (!ev) { console.log(lg, 'no event'); continue; }
    const r = await get(EP(ev.eventId));
    const d = r.data;
    const tabs = d?.layout?.tabs ? Object.values(d.layout.tabs).map(t => t.title + '=' + (t.tabKey || t.id)) : [];
    const mk = Object.values(d?.attachments?.markets || {});
    const types = {}; for (const m of mk) types[m.marketType] = (types[m.marketType] || 0) + 1;
    console.log('==', lg, ev.eventId, ev.name, r.status, JSON.stringify(d).length, '\ntabs', tabs.join(', '), '\ntypes', JSON.stringify(types).slice(0, 1500));
    fs.writeFileSync(`fdev-${lg}.json`, JSON.stringify(d));
    for (const t of ['passing-props', 'receiving-props', 'rushing-props', 'player-points', 'shots', 'player-props', 'batter-props', 'pitcher-props', 'points']) {
      const x = await get(EP(ev.eventId, t));
      const m2 = Object.values(x.data?.attachments?.markets || {});
      if (x.status === 200 && m2.length) { const t2 = {}; for (const m of m2) t2[m.marketType] = (t2[m.marketType] || 0) + 1; console.log('  tab', t, m2.length, JSON.stringify(t2).slice(0, 600)); fs.writeFileSync(`fdev-${lg}-${t}.json`, JSON.stringify(x.data)); }
      else console.log('  tab', t, x.status, m2.length);
    }
  }
})();
