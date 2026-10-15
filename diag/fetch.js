// fetch every app's raw esports lines once, and the live record rows
process.env.LR_DATA_DIR = '/tmp/lr-sd-fetch';
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
const fs = require('fs'); const axios = require('axios');
fs.mkdirSync('/tmp/lr-sd-fetch', { recursive: true }); fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, slimPlayers } = require('../pickem');
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const SITE = 'https://line-reaper-backend-production.up.railway.app';
(async () => {
  const out = { at: new Date().toISOString() };
  try { const r = await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000 });
    out.ud = S.parseUnderdogPayload(r.data || {}).filter(l => S.isEsports(l.sport)); } catch (e) { out.udErr = e.message; }
  try { const r = await axios.get('https://partner-api.prizepicks.com/projections', { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 120e6 });
    out.pp = parsePrizePicksPayload(r.data).lines.filter(l => S.isEsports(l.sport)); } catch (e) { out.ppErr = e.message; }
  try { const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000, maxContentLength: 40e6 });
    const rows = Array.isArray(r.data) ? r.data : []; const players = {};
    for (const sp of sleeperSportKeys(rows)) { if (!/^(cs|cs2|lol|val|valorant|dota|dota2|cod|r6)$/.test(sp)) continue; try { const pr = await axios.get(`https://api.sleeper.app/players/${sp}`, { timeout: 30000, maxContentLength: 40e6 }); players[sp] = slimPlayers(pr.data); } catch {} }
    out.sl = parseSleeperLines(rows, players, {}); } catch (e) { out.slErr = e.message; }
  fs.writeFileSync('out/raw.json', JSON.stringify(out));
  // the live record: the main esports tracker's rows and the model records' endpoints
  const live = {};
  for (const p of ['/api/status', '/api/tracker/picks?limit=1000', '/api/esports/share', '/api/esports/h2h', '/api/esports/rounds', '/api/esports/pin-gaps', '/api/ev/record']) {
    try { live[p] = (await axios.get(SITE + p, { timeout: 30000 })).data; } catch (e) { live[p] = { error: e.message }; }
  }
  fs.writeFileSync('out/live.json', JSON.stringify(live));
  console.log('fetched', (out.ud || []).length, (out.pp || []).length, (out.sl || []).length, out.udErr || '', out.ppErr || '', out.slErr || '');
  process.exit(0);
})();
