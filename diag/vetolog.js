// Veto-lag study: do PrizePicks / Underdog / Sleeper esports prop lines move
// after a CS2 map veto? Logs every esports line change (all three books) and
// every bo3.gg upcoming/live CS2 match's map list, so line moves can be timed
// against the moment the maps appear. Pushed to diag-vetolog-out as it runs.
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
process.env.LR_DATA_DIR = '/tmp/lr-veto';
const fs = require('fs'); const { execSync } = require('child_process'); const axios = require('axios');
fs.mkdirSync('/tmp/lr-veto', { recursive: true }); fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, sleeperEsportsKeys, slimPlayers } = require('../pickem');

const RUN_MS = +(process.env.RUN_MIN || 330) * 60e3, FAST_MS = 45e3, PP_GAP_MS = 2 * 60e3, BO3_MS = 90e3;
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const PP_URL = 'https://partner-api.prizepicks.com/projections';
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const BO3 = 'https://api.bo3.gg/api/v1', BH = { origin: 'https://bo3.gg', referer: 'https://bo3.gg/', 'User-Agent': 'Mozilla/5.0 (LineReaper research)', Accept: 'application/json' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const lines = { underdog: [], prizepicks: [], sleeper: [] };
const players = {}, playersAt = {};
const log = fs.createWriteStream('out/lines.jsonl'), mlog = fs.createWriteStream('out/bo3.jsonl');
const stats = { ticks: 0, errors: {}, ppLeagues: {}, ppPulls: 0, pp429: 0, bo3Polls: 0 };
const last = new Map(), mlast = new Map();

async function fetchUD() {
  const r = await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'x-api-key': 'undefined' }, timeout: 20000 });
  lines.underdog = S.parseUnderdogPayload(r.data || {}).filter(l => S.isEsports(l.sport));
}
async function fetchSL() {
  const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000, maxContentLength: 40e6 });
  const rows = Array.isArray(r.data) ? r.data : [];
  for (const sport of sleeperEsportsKeys(rows)) {
    if (Date.now() - (playersAt[sport] || 0) < 6 * 3600e3) continue;
    try { const pr = await axios.get(`https://api.sleeper.app/players/${sport}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000, maxContentLength: 40e6 }); players[sport] = slimPlayers(pr.data); playersAt[sport] = Date.now(); }
    catch (e) { stats.errors[`slp-${sport}`] = e.message; }
  }
  lines.sleeper = parseSleeperLines(rows, players);
}
// PrizePicks: learn esports league ids from one full pull, then one league per
// pull at most every 2 minutes (CS twice as often), honouring Retry-After
let ppNext = 0, ppAt = 0, ppQueue = [], ppHold = 0; const ppByLeague = {};
async function fetchPP() {
  if (Date.now() < ppHold || Date.now() - ppAt < PP_GAP_MS) return;
  ppAt = Date.now();
  try {
    if (!Object.keys(stats.ppLeagues).length) {
      const r = await axios.get(PP_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 120e6 });
      const { lines: ls, leagues } = parsePrizePicksPayload(r.data);
      for (const [id, n] of Object.entries(leagues)) if (S.isEsports(n)) stats.ppLeagues[id] = n;
      for (const id of Object.keys(stats.ppLeagues)) ppByLeague[id] = ls.filter(l => String(l.leagueId) === id);
    } else {
      if (!ppQueue.length) { const ids = Object.keys(stats.ppLeagues); const cs = ids.filter(i => /CS/i.test(stats.ppLeagues[i])); ppQueue = [...cs, ...ids.filter(i => !cs.includes(i)), ...cs]; }
      const id = ppQueue.shift();
      const r = await axios.get(PP_URL, { params: { league_id: id, per_page: 1000, single_stat: true }, headers: PP_HEADERS, timeout: 20000 });
      ppByLeague[id] = parsePrizePicksPayload(r.data).lines;
    }
    stats.ppPulls++;
    lines.prizepicks = Object.values(ppByLeague).flat();
  } catch (e) {
    if (e.response?.status === 429) { stats.pp429++; const ra = +e.response.headers?.['retry-after']; ppHold = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60e3); }
    throw e;
  }
}
const safe = async (name, fn) => { try { await fn(); } catch (e) { stats.errors[name] = `${e.response?.status || ''} ${e.message}`.slice(0, 200); stats.errors[`${name}N`] = (stats.errors[`${name}N`] || 0) + 1; } };

const keyOf = l => [l.book, S.normalizeName ? S.normalizeName(l.player) : l.player.toLowerCase(), l.sport, l.market].join('|');
function snapshot() {
  const t = Date.now(), seen = new Set();
  for (const l of [...lines.underdog, ...lines.prizepicks, ...lines.sleeper]) {
    const k = keyOf(l); seen.add(k);
    const v = JSON.stringify([l.line, l.overMultiplier ?? l.overPayout ?? null, l.underMultiplier ?? l.underPayout ?? null, l.overOpen === false ? 0 : 1, l.underOpen === false ? 0 : 1]);
    if (last.get(k) === v) continue;
    const first = !last.has(k); last.set(k, v);
    log.write(JSON.stringify({ t, k, v: JSON.parse(v), ...(first ? { b: l.book, s: l.sport, p: l.player, tm: l.team || null, m: l.market, st: l.startTime || null, mt: l.matchTitle || null, raw: stats.ticks < 2 ? l : undefined } : {}) }) + '\n');
  }
  for (const k of [...last.keys()]) if (!seen.has(k)) { last.delete(k); log.write(JSON.stringify({ t, k, gone: 1 }) + '\n'); }
}

let bo3At = 0, bo3Raw = false;
async function pollBo3() {
  if (Date.now() - bo3At < BO3_MS) return; bo3At = Date.now();
  const d = (await axios.get(`${BO3}/matches`, { headers: BH, timeout: 20000, params: { 'page[offset]': 0, 'page[limit]': 100, sort: 'start_date', with: 'games,teams', 'filter[matches.status][in]': 'upcoming,current', 'filter[matches.discipline_id][eq]': 1 } })).data;
  if (!bo3Raw) { bo3Raw = true; fs.writeFileSync('out/bo3-first.json', JSON.stringify(d).slice(0, 400000)); }
  stats.bo3Polls++;
  const t = Date.now();
  for (const m of d?.results || []) {
    const st = Date.parse(m.start_date); if (!(st < t + 4 * 3600e3)) continue;
    const g = (m.games || []).map(x => [x.number, x.map_name || null, x.status || null, x.begin_at || null]).sort((a, b) => a[0] - b[0]);
    const v = JSON.stringify({ s: m.status, st: m.start_date, g, sc: [m.team1_score, m.team2_score] });
    if (mlast.get(m.id) === v) continue;
    const first = !mlast.has(m.id); mlast.set(m.id, v);
    mlog.write(JSON.stringify({ t, id: m.id, ...JSON.parse(v), ...(first ? { slug: m.slug, a: m.team1?.name || m.team1_id, b: m.team2?.name || m.team2_id, bo: m.bo_type, tier: m.tier } : {}) }) + '\n');
  }
}

function pushOut(final) {
  try {
    fs.writeFileSync('out/stats.json', JSON.stringify(stats));
    const hdr = execSync('git config --get http.https://github.com/.extraheader').toString().trim();
    const d = '/tmp/veto-push'; execSync(`rm -rf ${d} && mkdir -p ${d} && cp -r out ${d}/`);
    const g = c => execSync(`git -C ${d} ${c}`, { stdio: 'pipe' });
    g('init -q'); g('config user.name diag-bot'); g('config user.email diag-bot@users.noreply.github.com');
    g('add -A'); g(`commit -qm "vetolog ${final ? 'final' : 'partial'} ${new Date().toISOString()}"`);
    execSync(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/diag-vetolog-out`, { stdio: 'pipe' });
    console.log('pushed', final ? 'final' : 'partial');
  } catch (e) { console.log('push failed', e.message); }
}

(async () => {
  for (const p of ['/api/tracker/picks?status=graded&limit=5000', '/api/tracker/picks?status=locked&limit=5000', '/api/tracker/picks?status=open&limit=5000', '/api/status']) {
    try { const r = await axios.get(PROD + p, { timeout: 60000, responseType: 'text', transformResponse: x => x }); fs.writeFileSync(`out/prod_${p.replace(/[^a-z0-9]+/gi, '_')}.json`, r.data); }
    catch (e) { stats.errors[`prod${p}`] = e.message; }
  }
  const t0 = Date.now(); let lastPush = Date.now();
  while (Date.now() - t0 < RUN_MS) {
    const tick = Date.now();
    await Promise.all([safe('ud', fetchUD), safe('sl', fetchSL), safe('pp', fetchPP), safe('bo3', pollBo3)]);
    snapshot(); stats.ticks++;
    if (stats.ticks === 2 || Date.now() - lastPush > 20 * 60e3) { lastPush = Date.now(); await new Promise(r => log.write('', r)); await new Promise(r => mlog.write('', r)); pushOut(false); }
    await wait(Math.max(1000, FAST_MS - (Date.now() - tick)));
  }
  await new Promise(r => log.end(r)); await new Promise(r => mlog.end(r));
  pushOut(true);
  process.exit(0);
})();
