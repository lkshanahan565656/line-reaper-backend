// Line-gap study: polls Underdog, Sleeper and PrizePicks directly and logs
// every change to any player line two or more books carry, so we can see how
// long a gap between books lasts and which book moves to close it.
// Output: out/changes.jsonl ({ t, k, b: { underdog|prizepicks|sleeper: cell|null }, st })
// plus the live record from production. Pushed to diag-gaps-out as it runs.
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
process.env.LR_DATA_DIR = '/tmp/lr-gaps';
const fs = require('fs'); const { execSync } = require('child_process'); const axios = require('axios');
fs.mkdirSync('/tmp/lr-gaps', { recursive: true }); fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, slimPlayers } = require('../pickem');
const propsBoard = require('../propsboard');

const RUN_MS = +(process.env.GAP_RUN_MIN || 150) * 60e3, FAST_MS = 30e3, PP_ES_MS = 2 * 60e3, PP_FULL_MS = 15 * 60e3;
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const PP_URL = 'https://partner-api.prizepicks.com/projections';
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const lines = { underdog: [], prizepicks: [], sleeper: [] };
const players = {}; const playersAt = {};
const log = fs.createWriteStream('out/changes.jsonl');
const stats = { ticks: 0, errors: {}, ppEsLeagues: [], counts: [] };
const last = new Map();   // key -> JSON of books

async function fetchUD() {
  const r = await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'x-api-key': 'undefined' }, timeout: 15000 });
  lines.underdog = S.parseUnderdogPayload(r.data || {});
}
async function fetchSL() {
  const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000, maxContentLength: 40e6 });
  const rows = Array.isArray(r.data) ? r.data : [];
  for (const sport of sleeperSportKeys(rows)) {
    if (Date.now() - (playersAt[sport] || 0) < 6 * 3600e3) continue;
    try { const pr = await axios.get(`https://api.sleeper.app/players/${sport}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000, maxContentLength: 40e6 }); players[sport] = slimPlayers(pr.data); playersAt[sport] = Date.now(); }
    catch (e) { stats.errors[`slp-${sport}`] = e.message; }
  }
  lines.sleeper = parseSleeperLines(rows, players, { sports: true });
}
let ppFullAt = 0, ppEsAt = 0;
async function fetchPP() {
  if (Date.now() - ppFullAt > PP_FULL_MS) {
    const r = await axios.get(PP_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 120e6 });
    const { lines: ls, leagues } = parsePrizePicksPayload(r.data);
    lines.prizepicks = ls; ppFullAt = ppEsAt = Date.now();
    stats.ppEsLeagues = Object.entries(leagues).filter(([, n]) => S.isEsports(n)).map(([id]) => id);
    return;
  }
  if (Date.now() - ppEsAt < PP_ES_MS || !stats.ppEsLeagues.length) return;
  ppEsAt = Date.now();
  const fresh = [];
  for (const [i, id] of stats.ppEsLeagues.entries()) {
    if (i) await wait(3000);
    const r = await axios.get(PP_URL, { params: { league_id: id, per_page: 1000, single_stat: true }, headers: PP_HEADERS, timeout: 20000 });
    fresh.push(...parsePrizePicksPayload(r.data).lines);
  }
  lines.prizepicks = [...lines.prizepicks.filter(l => !S.isEsports(l.sport)), ...fresh];
}
const safe = async (name, fn) => { try { await fn(); } catch (e) { stats.errors[name] = `${e.response?.status || ''} ${e.message}`.slice(0, 200); stats.errors[`${name}N`] = (stats.errors[`${name}N`] || 0) + 1; } };

function snapshot() {
  const all = [...lines.underdog, ...lines.prizepicks, ...lines.sleeper];
  const rows = propsBoard.buildRows(all, { esKey: (sport, market) => S.normalizeMarket(market), now: Date.now() - 6 * 3600e3 });
  const t = Date.now(); let multi = 0, gaps = 0;
  const seen = new Set();
  for (const r of rows) {
    const n = Object.keys(r.books).length;
    if (n < 2 && !last.has(r.key)) continue;
    if (n >= 2) multi++;
    const ls = Object.values(r.books).map(c => c.line);
    if (Math.max(...ls) > Math.min(...ls)) gaps++;
    seen.add(r.key);
    const b = {};
    for (const [bk, c] of Object.entries(r.books)) b[bk] = [c.line, c.over, c.under, c.overOpen ? 1 : 0, c.underOpen ? 1 : 0];
    const j = JSON.stringify(b);
    if (last.get(r.key) === j) continue;
    const first = !last.has(r.key);
    last.set(r.key, j);
    log.write(JSON.stringify({ t, k: r.key, b, ...(first ? { st: r.startTime, mt: r.matchTitle, m: r.market, p: r.player, es: r.esports ? 1 : 0 } : {}) }) + '\n');
  }
  for (const k of [...last.keys()]) if (!seen.has(k)) { last.delete(k); log.write(JSON.stringify({ t, k, gone: 1 }) + '\n'); }
  stats.counts.push({ t, ud: lines.underdog.length, pp: lines.prizepicks.length, sl: lines.sleeper.length, multi, gaps });
}

function pushOut(final) {
  try {
    fs.writeFileSync('out/stats.json', JSON.stringify(stats));
    const hdr = execSync('git config --get http.https://github.com/.extraheader').toString().trim();
    const d = '/tmp/gaps-push'; execSync(`rm -rf ${d} && mkdir -p ${d} && cp -r out ${d}/`);
    const g = c => execSync(`git -C ${d} ${c}`, { stdio: 'pipe' });
    g('init -q'); g('config user.name diag-bot'); g('config user.email diag-bot@users.noreply.github.com');
    g('add -A'); g(`commit -qm "gaps ${final ? 'final' : 'partial'} ${new Date().toISOString()}"`);
    execSync(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/diag-gaps-out`, { stdio: 'pipe' });
    console.log('pushed', final ? 'final' : 'partial');
  } catch (e) { console.log('push failed', e.message); }
}

(async () => {
  for (const p of ['/api/tracker/picks?status=graded&limit=5000', '/api/tracker/picks?status=open&limit=5000', '/api/tracker/picks?status=locked&limit=5000', '/api/tracker/summary', '/api/status']) {
    try { const r = await axios.get(PROD + p, { timeout: 60000, responseType: 'text', transformResponse: x => x }); fs.writeFileSync(`out/prod_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, r.data); }
    catch (e) { stats.errors[`prod${p}`] = e.message; }
  }
  const t0 = Date.now(); let lastPush = Date.now();
  while (Date.now() - t0 < RUN_MS) {
    const tick = Date.now();
    await Promise.all([safe('ud', fetchUD), safe('sl', fetchSL), safe('pp', fetchPP)]);
    snapshot(); stats.ticks++;
    if (Date.now() - lastPush > 30 * 60e3) { lastPush = Date.now(); await new Promise(r => log.write('', r)); pushOut(false); }
    await wait(Math.max(1000, FAST_MS - (Date.now() - tick)));
  }
  await new Promise(r => log.end(r));
  pushOut(true);
  process.exit(0);
})();
