// Probe: which prop tabs / bet offers / leagues the free books and Pinnacle list
const fs = require('fs');
const axios = require('axios');
const fb = require('../freebooks');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const H = { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000 };
const get = async u => { try { return (await axios.get(u, H)).data; } catch (e) { return { __err: e.response?.status || e.message }; } };
const out = {};
const log = (k, v) => { out[k] = v; };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const TABS = {
    nhl: ['', 'shots', 'points-assists', 'goals', 'goalie-props', 'saves', 'player-props', 'popular', 'skater-props', 'points', 'assists'],
    nba: ['', 'player-points', 'player-rebounds', 'player-assists', 'player-threes', 'player-combos', 'player-props', 'pra', 'popular', 'player-defense'],
    ncaaf: ['', 'passing-props', 'receiving-props', 'rushing-props', 'player-props', 'td-scorer-props', 'popular'],
    mlb: ['', 'pitcher-props', 'batter-props', 'player-props', 'popular'],
    nfl: ['', 'passing-props', 'receiving-props', 'rushing-props', 'td-scorer-props', 'player-props', 'defensive-props', 'kicking-props'],
  };
  for (const [lg, tabs] of Object.entries(TABS)) {
    const page = await get(fb.FD_URL(fb.LEAGUES[lg].fd));
    const evs = Object.values(page?.attachments?.events || {}).filter(e => Date.parse(e.openDate) > Date.now()).sort((a, b) => Date.parse(a.openDate) - Date.parse(b.openDate));
    const res = { events: evs.length, err: page?.__err, sample: [] };
    for (const e of evs.slice(0, lg === 'nba' ? 3 : 2)) {
      const ev = { name: e.name, open: e.openDate, tabs: {} };
      for (const t of tabs) {
        const d = await get(fb.FD_EVENT_URL(e.eventId, t));
        if (d.__err) { ev.tabs[t] = { err: d.__err }; continue; }
        if (t === '') ev.layoutTabs = JSON.stringify(d.layout?.tabs || d.layout?.tabsOrder || Object.keys(d.layout || {})).slice(0, 3000);
        const mk = Object.values(d?.attachments?.markets || {});
        const byType = {};
        for (const m of mk) { const k = `${m.bettingType}|${m.marketType}`; (byType[k] = byType[k] || { n: 0, names: [], runners: [] }); byType[k].n++; if (byType[k].names.length < 2) { byType[k].names.push(m.marketName); byType[k].runners.push((m.runners || []).slice(0, 3).map(r => `${r.runnerName}|${r.result?.type}|${r.handicap}|${r.winRunnerOdds?.americanDisplayOdds?.americanOdds}`)); } }
        ev.tabs[t] = { markets: mk.length, parsed: fb.parseFanDuelProps(d).length, byType };
      }
      res.sample.push(ev);
    }
    log(`fd_${lg}`, res);
  }
  for (const lg of ['nhl', 'nba', 'ncaaf', 'mlb', 'nfl']) {
    const lv = await get(`${fb.KAMBI}/listView/${fb.LEAGUES[lg].kambi}/all/all/matches.json?lang=en_US&market=US`);
    const ids = fb.kambiEventIds(lv);
    const res = { events: ids.length, err: lv?.__err, sample: [] };
    for (const id of ids.slice(0, 2)) {
      const d = await get(`${fb.KAMBI}/betoffer/event/${id}.json?lang=en_US&market=US`);
      const crit = {};
      for (const b of d.betOffers || []) { const k = b.criterion?.englishLabel; crit[k] = crit[k] || { n: 0, ex: (b.outcomes || []).slice(0, 3).map(o => `${o.type}|${o.label}|${o.participant}|${o.line}|${o.oddsAmerican}`) }; crit[k].n++; }
      res.sample.push({ name: d.events?.[0]?.englishName, start: d.events?.[0]?.start, parsedProps: fb.kambiProps(d).length, crit });
    }
    log(`kambi_${lg}`, res);
  }
  const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
  const PH = { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 };
  for (const [sp, id] of Object.entries({ football: 15, basketball: 4, hockey: 19, baseball: 3 })) {
    try {
      const mu = (await axios.get(`${PIN}/sports/${id}/matchups`, PH)).data;
      const by = {};
      for (const m of mu) { const k = `${m.league?.name}|${m.league?.id}|${m.type}|${m.special?.category || ''}`; by[k] = (by[k] || 0) + 1; }
      log(`pin_${sp}`, by);
    } catch (e) { log(`pin_${sp}`, { err: e.response?.status || e.message }); }
  }
  const K = 'https://api.elections.kalshi.com/trade-api/v2/events';
  const guesses = ['KXNCAAFPASSYDS', 'KXNCAAFRSHYDS', 'KXNCAAFRECYDS', 'KXCFBPASSYDS', 'KXNCAAFTD', 'KXNHLSOG', 'KXNHLSHOTS', 'KXNHLGOAL', 'KXNHLPTS', 'KXNHLAST', 'KXNHLSAVES', 'KXNBAPTS', 'KXMLBKS', 'KXMLBTB'];
  const kr = {};
  for (const s of guesses) {
    try { const d = (await axios.get(K, { params: { series_ticker: s, status: 'open', with_nested_markets: true, limit: 50 }, timeout: 15000 })).data; kr[s] = { events: d.events?.length, markets: (d.events || []).reduce((a, e) => a + (e.markets || []).length, 0), ex: d.events?.[0]?.title }; }
    catch (e) { kr[s] = { err: e.response?.status || e.message }; }
  }
  log('kalshi', kr);
  fs.writeFileSync('out/cov.json', JSON.stringify(out, null, 1));
})();
