// Probe 2: FanDuel tab slugs from each event's own tab titles; Pinnacle props the parser drops
const fs = require('fs');
const axios = require('axios');
const fb = require('../freebooks'), pp = require('../pinprops');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const H = { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000 };
const get = async u => { try { return (await axios.get(u, H)).data; } catch (e) { return { __err: e.response?.status || e.message }; } };
const out = {};
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
(async () => {
  fs.mkdirSync('out', { recursive: true });
  for (const lg of ['nba', 'nhl', 'ncaaf', 'mlb', 'nfl']) {
    const page = await get(fb.FD_URL(fb.LEAGUES[lg].fd));
    const evs = Object.values(page?.attachments?.events || {}).filter(e => Date.parse(e.openDate) > Date.now() && !/\(/.test(e.name) || lg === 'mlb').sort((a, b) => Date.parse(a.openDate) - Date.parse(b.openDate));
    const res = [];
    for (const e of evs.slice(0, 2)) {
      const d0 = await get(fb.FD_EVENT_URL(e.eventId, ''));
      const titles = Object.values(d0?.layout?.tabs || {}).map(t => t.title);
      const tabs = {};
      for (const t of titles) {
        const s = slug(t);
        const d = await get(fb.FD_EVENT_URL(e.eventId, s));
        if (d.__err) { tabs[s] = { err: d.__err }; continue; }
        const mk = Object.values(d?.attachments?.markets || {});
        const types = {};
        for (const m of mk) if (m.bettingType === 'MOVING_HANDICAP' || /OVER|UNDER|TOTAL/.test(m.marketType)) types[m.marketType] = (types[m.marketType] || 0) + 1;
        tabs[s] = { title: t, markets: mk.length, parsed: fb.parseFanDuelProps(d).length, ouTypes: types,
          twoWayOdds: mk.filter(m => m.bettingType === 'ODDS' && (m.runners || []).length === 2 && (m.runners || []).every(r => / (over|under) \d/i.test(r.runnerName))).slice(0, 3).map(m => [m.marketType, m.marketName, m.runners.map(r => r.runnerName + ' ' + r.winRunnerOdds?.americanDisplayOdds?.americanOdds)]) };
      }
      res.push({ name: e.name, open: e.openDate, titles, tabs });
    }
    out[`fd_${lg}`] = res;
  }
  const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
  const PH = { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 };
  for (const [lg, id] of Object.entries({ NCAA: 880, MLB: 246, NHL: 1456, NBA: 487, NFL: 889 })) {
    const mu = (await axios.get(`${PIN}/leagues/${id}/matchups`, PH)).data;
    const mk = (await axios.get(`${PIN}/leagues/${id}/markets/straight`, PH)).data;
    const parsed = pp.parseLeague(lg, mu, mk);
    const props = mu.filter(m => m.type === 'special' && /player props/i.test(m.special?.category || ''));
    const priced = new Set(mk.filter(m => m.type === 'total' && m.period === 0).map(m => m.matchupId));
    const types = {}; for (const m of mk) { const k = `${m.type}|${m.period}`; types[k] = (types[k] || 0) + 1; }
    const bad = props.filter(m => !pp.parseDescription(m.special?.description)).map(m => m.special?.description);
    const stats = {}; for (const m of props) { const d = pp.parseDescription(m.special?.description); if (d) stats[d.mkey] = (stats[d.mkey] || 0) + 1; }
    const unpriced = props.filter(m => !priced.has(m.id)).slice(0, 5).map(m => [m.special?.description, m.participants?.map(p => p.name), mk.filter(x => x.matchupId === m.id).map(x => x.type + x.period)]);
    out[`pin_${lg}`] = { specials: props.length, parsed: parsed.length, marketTypes: types, unparsedDesc: bad.slice(0, 15), stats, unpriced, sample: parsed.slice(0, 3) };
  }
  fs.writeFileSync('out/cov.json', JSON.stringify(out, null, 1));
})();
