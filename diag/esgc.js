// diag: why esports board legs stay "waiting for results"
const fs = require('fs'), zlib = require('zlib'), { execSync } = require('child_process');
const axios = require('axios');
const G = require('../graders');
const ER = require('../esrecord');
const out = [];
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); out.push(s); };
(async () => {
  execSync('git fetch -q origin esboard-20261025-report');
  const legs = JSON.parse(zlib.gunzipSync(execSync('git show origin/esboard-20261025-report:legs.json.gz', { maxBuffer: 1 << 30 })).toString());
  const want = legs.filter(l => l.graded?.pending && l.start < '2026-10-25T04:00');
  const seen = new Set(); const picks = [];
  for (const l of want) { const k = l.sport + l.matchTitle + l.app; if (seen.has(k)) continue; seen.add(k); picks.push(l); }
  // raw bo3 list near the CS starts
  try {
    const r = await axios.get('https://api.bo3.gg/api/v1/matches', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000, params: { 'page[offset]': 0, 'page[limit]': 100, sort: '-start_date', with: 'games', 'filter[matches.status][in]': 'finished', 'filter[matches.discipline_id][eq]': 1 } });
    const rs = r.data?.results || [];
    log('bo3 finished', rs.length, 'newest', rs[0]?.start_date, 'oldest', rs[rs.length - 1]?.start_date);
    for (const m of rs.filter(m => /bestia|imperial|gremio|yawara/i.test(m.slug || ''))) log('bo3 match', m.slug, m.start_date, m.status, (m.games || []).map(g => [g.id, g.number, g.status]));
  } catch (e) { log('bo3 list error', e.response?.status, e.message); }
  const graders = { CS: G.createCsGrader(axios), VAL: G.createValGrader(axios), LOL: G.createLoLGraderChain(G.createLoLesportsGrader(axios), G.createLoLGrader(axios)) };
  for (const l of picks.slice(0, 12)) {
    const pick = { sport: l.sport, player: l.player, team: l.team, matchTitle: l.matchTitle, startTime: l.start, stat: l.stat, market: l.market, book: l.app === 'sleeper' ? 'x' : l.app };
    try { const res = await graders[l.sport]?.(pick); log('PICK', pick, '=>', res, ER.resultFromMaps(res, l.market)); }
    catch (e) { log('PICK', pick, 'ERROR', e.response?.status, e.message, e.stack?.split('\n').slice(0, 3).join(' | ')); }
  }
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/esgc.txt', out.join('\n'));
})();
