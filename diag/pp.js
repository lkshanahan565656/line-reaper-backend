// PrizePicks partner-api: response headers (rate limit, Retry-After) and whether several league ids fit one request.
const fs = require('fs');
const U = 'https://partner-api.prizepicks.com/projections';
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('out', { recursive: true }); const log = [];
  const hit = async (tag, qs) => { const t = Date.now(); try { const r = await fetch(U + '?' + qs, { headers: H }); const tx = await r.text(); let n = null, leagues = null; try { const j = JSON.parse(tx); n = j.data?.length; leagues = [...new Set((j.data || []).map(d => d.relationships?.league?.data?.id))]; } catch {} log.push({ tag, qs, at: new Date().toISOString(), st: r.status, ms: Date.now() - t, bytes: tx.length, n, leagues, headers: Object.fromEntries(r.headers), body: r.status !== 200 ? tx.slice(0, 300) : undefined }); } catch (e) { log.push({ tag, qs, err: e.message }); } };
  await hit('one', 'league_id=121&per_page=1000&single_stat=true');
  await wait(5000);
  await hit('list', 'league_id=121,159,265,274&per_page=1000&single_stat=true');
  await wait(5000);
  await hit('arr', 'league_id[]=121&league_id[]=159&per_page=1000&single_stat=true');
  for (let i = 0; i < 6; i++) { await wait(20000); await hit('again' + i, 'league_id=159&per_page=1000&single_stat=true'); }
  fs.writeFileSync('out/pp.json', JSON.stringify(log, null, 1));
})();
