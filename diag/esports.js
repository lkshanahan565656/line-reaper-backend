const axios = require('axios');
const { createEsportsBoard } = require('../esboard');
const R = require('../ratings');
const { buildElo } = require('../context');
const next = {};
const http = { get(url, cfg = {}) {
  const host = new URL(url).host; const gap = host.includes('kalshi') ? 300 : 150;
  const at = Math.max(Date.now(), next[host] || 0); next[host] = at + gap;
  return new Promise(r => setTimeout(r, at - Date.now())).then(() => axios.get(url, { ...cfg, headers: { 'User-Agent': 'Mozilla/5.0', ...(cfg.headers || {}) } }));
} };
(async () => {
  const state = { elo: {}, meta: {} };
  const t0 = Date.now();
  await R.refreshRatings(axios, state, console, {});
  console.log('ratings', JSON.stringify(state.meta), 'ms', Date.now() - t0);
  for (const [k, e] of Object.entries(state.elo)) console.log(k, 'size', e.size, 'sample', ['Spirit','MOUZ','G2 Esports','T1','LOS','FURIA Esports','Team Vitality','LOUD','Vitality','NRG','Cupid Esports','Disguised'].map(n => `${n}:${e.rating(n) && Math.round(e.rating(n))}/${e.games(n)}`).join(' '));
  const board = createEsportsBoard({ http, ratings: () => state.elo });
  const s = await board.scan();
  console.log(JSON.stringify(s.counts));
  for (const m of s.matches.filter(m => m.rating).slice(0, 25)) {
    const mk = m.markets.find(x => x.kind === 'match');
    console.log(`${m.label} | ${m.teams.join(' vs ')} | Bo${m.bestOf} | rating ${JSON.stringify(m.rating)} | match fair ${mk?.outcomes.map(o => o.fair)} model ${mk?.outcomes.map(o => o.model)}`);
  }
  // calibration-ish: model vs fair on match markets
  const pairs = s.matches.filter(m => m.rating).map(m => m.markets.find(x => x.kind === 'match')).filter(mk => mk && mk.outcomes[0].fair != null && mk.outcomes[0].model != null).map(mk => [mk.outcomes[0].fair, mk.outcomes[0].model]);
  const mae = pairs.reduce((x, [f, m]) => x + Math.abs(f - m), 0) / (pairs.length || 1);
  console.log('model vs fair: n', pairs.length, 'MAE', mae.toFixed(3));
})().catch(e => console.log('FATAL', e.stack));
