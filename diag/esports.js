const axios = require('axios');
const { createEsportsBoard } = require('../esboard');
const next = {};
const http = { get(url, cfg = {}) {
  const host = new URL(url).host; const gap = host.includes('kalshi') ? 300 : 150;
  const at = Math.max(Date.now(), next[host] || 0); next[host] = at + gap;
  return new Promise(r => setTimeout(r, at - Date.now())).then(() => axios.get(url, { ...cfg, headers: { 'User-Agent': 'Mozilla/5.0', ...(cfg.headers || {}) } }));
} };
(async () => {
  const board = createEsportsBoard({ http });
  const s = await board.scan();
  console.log(JSON.stringify({ counts: s.counts, errors: s.errors, durationMs: s.durationMs }, null, 1));
  const both = s.matches.filter(m => m.links.kalshi && m.links.polymarket);
  const show = m => {
    console.log(`\n=== ${m.label} | ${m.teams.join(' vs ')} | ${m.start} | Bo${m.bestOf} | ${m.tournament} | live ${m.live} | vol K ${m.volume.kalshi} P ${m.volume.polymarket}`);
    for (const mk of m.markets) {
      console.log(`  [${mk.key}] src=${mk.sources} ${mk.arb ? 'ARB ' + JSON.stringify(mk.arb) : ''}`);
      for (const oc of mk.outcomes) console.log(`     ${oc.name}: fair ${oc.fair} model ${oc.model} | K ${oc.quotes.kalshi ? `${oc.quotes.kalshi.bid}/${oc.quotes.kalshi.ask} c${oc.quotes.kalshi.cost} ev${oc.quotes.kalshi.ev}${oc.quotes.kalshi.edge ? ' EDGE' : ''}` : '-'} | P ${oc.quotes.polymarket ? `${oc.quotes.polymarket.bid}/${oc.quotes.polymarket.ask} c${oc.quotes.polymarket.cost} ev${oc.quotes.polymarket.ev}${oc.quotes.polymarket.edge ? ' EDGE' : ''}` : '-'} | B ${oc.quotes.book ? oc.quotes.book.decimal + '=' + oc.quotes.book.prob : '-'}`);
    }
  };
  both.slice(0, 6).forEach(show); s.matches.filter(m => m.game === "CS2" && m.links.kalshi && m.links.polymarket).slice(0, 4).forEach(show);
  console.log('\n\n##### KALSHI ONLY');
  s.matches.filter(m => m.links.kalshi && !m.links.polymarket).slice(0, 15).forEach(m => console.log(`${m.label} | ${m.teams.join(' vs ')} | ${m.start} | ${m.links.kalshi}`));
  console.log('\n##### PM titles same day as kalshi-only (to spot pairing misses)');
  s.matches.filter(m => !m.links.kalshi && m.links.polymarket && ['CS2','LOL','VAL','DOTA'].includes(m.game)).slice(0, 40).forEach(m => console.log(`${m.label} | ${m.teams.join(' vs ')} | ${m.start}`));
  console.log('\n##### EDGES');
  for (const m of s.matches) for (const e of m.edges) console.log(`${m.label} ${m.teams.join(' vs ')} ${m.start} :: ${JSON.stringify(e)}`);
  console.log('\n##### ARBS');
  for (const m of s.matches) for (const a of m.arbs) console.log(`${m.label} ${m.teams.join(' vs ')} ${m.start} :: ${JSON.stringify(a)}`);
})().catch(e => console.log('FATAL', e.stack));
