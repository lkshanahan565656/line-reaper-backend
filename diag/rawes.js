// dump every app's raw esports lines once (for the same-day multi-match players)
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
process.env.LR_DATA_DIR = '/tmp/lr-raw';
const fs = require('fs'); const axios = require('axios');
fs.mkdirSync('/tmp/lr-raw', { recursive: true }); fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, slimPlayers } = require('../pickem');
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
(async () => {
  const out = {};
  try { const r = await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000 });
    out.ud = S.parseUnderdogPayload(r.data || {}).filter(l => S.isEsports(l.sport)); } catch (e) { out.udErr = e.message; }
  try { const r = await axios.get('https://partner-api.prizepicks.com/projections', { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 120e6 });
    out.pp = parsePrizePicksPayload(r.data).lines.filter(l => S.isEsports(l.sport)); } catch (e) { out.ppErr = e.message; }
  try { const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000, maxContentLength: 40e6 });
    const rows = Array.isArray(r.data) ? r.data : []; const players = {};
    for (const sp of sleeperSportKeys(rows)) { try { const pr = await axios.get(`https://api.sleeper.app/players/${sp}`, { timeout: 30000, maxContentLength: 40e6 }); players[sp] = slimPlayers(pr.data); } catch {} }
    out.sl = parseSleeperLines(rows, players, {}); out.slRaw = rows.filter(x => /cs|lol|val|dota/i.test(String(x.sport || ''))).slice(0, 400); } catch (e) { out.slErr = e.message; }
  fs.writeFileSync('out/raw.json', JSON.stringify(out));
  process.exit(0);
})();
