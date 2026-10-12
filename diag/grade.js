const axios = require('axios');
const kp = require('../kprops');
const { canonMarket, canonName } = require('../ev');
const log = (...a) => console.log(...a);
(async () => {
  const ud = (await axios.get('https://line-reaper-backend-production.up.railway.app/api/underdog')).data.data || [];
  const sports = ud.filter(l => !/^(cs|cs2|lol|val|valorant|dota|dota2|cod|r6|ow|rl)$/i.test(l.sport || ''));
  const mk = {};
  for (const l of sports) { const k = l.sport + '|' + l.market + '→' + canonMarket(l.market); mk[k] = (mk[k] || 0) + 1; }
  log('UD sports lines', sports.length);
  for (const [k, v] of Object.entries(mk).sort((a, b) => b[1] - a[1]).slice(0, 80)) log(' M', v, k);
  const { events, errors } = await kp.fetchEvents({ get: (u, o) => axios.get(u, o) });
  log('kalshi events', events.length, 'errors', errors.join(' '));
  const stats = {};
  for (const { ev, league } of events) for (const l of kp.laddersFromEvent(ev).values()) { const k = league + '|' + l.market; stats[k] = (stats[k] || 0) + 1; }
  log('ladders by market', JSON.stringify(stats));
  for (const { ev } of events.slice(0, 400)) { const t = (ev.markets || [])[0]?.title; if (t) { const k = t.replace(/^.+?:\s*\d+(\.\d+)?\+\s*/, ''); stats['T:' + k] = 1; } }
  log('rung stat words', Object.keys(stats).filter(k => k.startsWith('T:')).join(' | '));
  const { games, counts } = kp.buildGames(events, sports);
  log('counts', JSON.stringify(counts));
  const by = {};
  for (const g of games) for (const p of g.books[0].props) by[g.sport_key + '|' + p.market] = (by[g.sport_key + '|' + p.market] || 0) + 1;
  log('matched by market', JSON.stringify(by));
  // unmatched: UD lines whose player has a ladder but market doesn't line up
  const ladKeys = new Set(); const ladPlayers = new Set();
  for (const { ev } of events) for (const l of kp.laddersFromEvent(ev).values()) { ladKeys.add(canonName(l.player) + '|' + l.market); ladPlayers.add(canonName(l.player)); }
  const miss = {};
  for (const l of sports) if (ladPlayers.has(canonName(l.player)) && !ladKeys.has(canonName(l.player) + '|' + canonMarket(l.market))) miss[l.sport + '|' + l.market] = (miss[l.sport + '|' + l.market] || 0) + 1;
  log('UD markets for laddered players with no ladder', JSON.stringify(miss));
})().catch(e => log('FATAL', e.stack));
