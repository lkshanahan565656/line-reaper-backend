const axios = require('axios');
const { createEsportsBoard } = require('../esboard');
const R = require('../ratings');
const next = {};
const http = { get(url, cfg = {}) {
  const host = new URL(url).host; const gap = host.includes('kalshi') ? 300 : 150;
  const at = Math.max(Date.now(), next[host] || 0); next[host] = at + gap;
  return new Promise(r => setTimeout(r, at - Date.now())).then(() => axios.get(url, { ...cfg, headers: { 'User-Agent': 'Mozilla/5.0', ...(cfg.headers || {}) } }));
} };
(async () => {
  const state = { elo: {}, meta: {} };
  await R.refreshRatings(axios, state, { log() {}, warn: console.log }, {});
  const board = createEsportsBoard({ http, ratings: () => state.elo, log: {} });
  await board.scan();
  await new Promise(r => setTimeout(r, 60000));
  const s = await board.scan();
  console.log('BOARDJSON ' + JSON.stringify({ matches: s.matches, counts: s.counts, updated: s.updated }));
})().catch(e => console.log('FATAL', e.stack));
