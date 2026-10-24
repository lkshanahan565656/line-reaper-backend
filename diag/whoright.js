// Who is right when the apps and Pinnacle disagree: full sports board recorder (10-24).
// sports leagues one at a time (and its whole board every 20 min), and
// Pinnacle's player props every 2 min, and logs every change to a sports
// player line so we can see which pick'em app moves first, which follow, how
// fast, and whether the follower's old number beat the close.
// Output: out/changes.jsonl ({ t, k, b: { app: [line, over, under, overOpen, underOpen], pinnacle: [line, pOver] } })
// and out/stats.json (read times per tick). Pushed to diag-whoright-out-<run>.
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
process.env.LR_DATA_DIR = '/tmp/lr-whoright';
const fs = require('fs'); const { execSync } = require('child_process'); const axios = require('axios');
fs.mkdirSync('/tmp/lr-whoright', { recursive: true }); fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, sleeperSportKeys, slimPlayers } = require('../pickem');
const propsBoard = require('../propsboard');
const pinprops = require('../pinprops');

const RUN = process.env.RUN_N || '1';
const RUN_MS = +(process.env.RUN_MIN || 335) * 60e3, FAST_MS = 30e3, PP_LEAGUE_MS = 180e3, PP_FULL_MS = 20 * 60e3, PIN_MS = 120e3;
const PP_URL = 'https://partner-api.prizepicks.com/projections';
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const PP_WANT = /^(NFL|MLB|NBA|NHL|CFB|WNBA|NBA1Q|NFLP|NBAP)$/i;
const wait = ms => new Promise(r => setTimeout(r, ms));
const lines = { underdog: [], prizepicks: [], sleeper: [] };
const players = {}; const playersAt = {};
const log = fs.createWriteStream('out/changes.jsonl');
const stats = { run: RUN, ticks: 0, errors: {}, ppLeagues: {}, counts: [] };
const last = new Map();
const readAt = {}; const ppLeagueAt = {};
let pinIdx = new Map();

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
let ppFullAt = 0, ppLeagueTry = 0, ppNext = 0, ppHoldUntil = 0;
async function fetchPP() {
  if (Date.now() < ppHoldUntil) return false;
  try { return await fetchPP1(); }
  catch (e) { const ra = +(e.response?.headers?.['retry-after'] || 0); ppHoldUntil = Date.now() + Math.max(ra * 1000, 90e3); throw e; }
}
async function fetchPP1() {
  if (Date.now() - ppFullAt > PP_FULL_MS) {
    ppFullAt = Date.now();
    const r = await axios.get(PP_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 120e6 });
    const { lines: ls, leagues } = parsePrizePicksPayload(r.data);
    lines.prizepicks = ls.filter(l => !S.isEsports(l.sport));
    stats.ppLeagues = Object.fromEntries(Object.entries(leagues).filter(([, n]) => PP_WANT.test(n)));
    for (const id of Object.keys(stats.ppLeagues)) ppLeagueAt[id] = Date.now();
    readAt.ppFull = Date.now();
    return true;
  }
  const ids = Object.keys(stats.ppLeagues);
  if (Date.now() - ppLeagueTry < PP_LEAGUE_MS || !ids.length) return false;
  ppLeagueTry = Date.now();
  const id = ids[ppNext++ % ids.length];
  const r = await axios.get(PP_URL, { params: { league_id: id, per_page: 1000, single_stat: true }, headers: PP_HEADERS, timeout: 20000 });
  const fresh = parsePrizePicksPayload(r.data).lines;
  lines.prizepicks = [...lines.prizepicks.filter(l => String(l.leagueId) !== String(id)), ...fresh];
  ppLeagueAt[id] = Date.now();
  return true;
}
let pinAt = 0;
async function fetchPin() {
  if (Date.now() - pinAt < PIN_MS) return false;
  pinAt = Date.now();
  const { props, errors } = await pinprops.fetchPinnacleProps(axios, process.env.PINNACLE_GUEST_KEY);
  if (errors.length) stats.errors.pinLast = errors.slice(0, 3).join('; ');
  if (props.length) { pinIdx = pinprops.indexProps(props); readAt.pin = Date.now(); }
  return true;
}
const safe = async (name, fn) => { try { const did = await fn(); if (did !== false) readAt[name] = Date.now(); } catch (e) { stats.errors[name] = `${e.response?.status || ''} ${e.message}`.slice(0, 200); stats.errors[`${name}N`] = (stats.errors[`${name}N`] || 0) + 1; } };

function snapshot() {
  const all = [...lines.underdog, ...lines.prizepicks, ...lines.sleeper];
  const rows = propsBoard.buildRows(all, { esKey: (sport, market) => S.normalizeMarket(market), now: Date.now() });
  const t = Date.now(); let multi = 0;
  const seen = new Set();
  for (const r of rows) {
    if (r.esports || S.isEsports(r.sport)) continue;
    const b = {};
    for (const [bk, c] of Object.entries(r.books)) b[bk] = [c.line, c.over ?? null, c.under ?? null, c.overOpen ? 1 : 0, c.underOpen ? 1 : 0, c.leagueId ?? null];
    const q = pinprops.quoteFor(pinIdx, r);
    if (q) b.pinnacle = [q.line, q.pOver];
    const apps = Object.keys(r.books).length;
    if (apps < 2 && !q && !last.has(r.key)) continue;
    if (apps >= 2) multi++;
    seen.add(r.key);
    const j = JSON.stringify(b);
    if (last.get(r.key) === j) continue;
    const first = !last.has(r.key);
    last.set(r.key, j);
    log.write(JSON.stringify({ t, k: r.key, b, ...(first ? { s: r.sport, st: r.startTime, mt: r.matchTitle, m: r.market, mk: r.mkey, p: r.player } : {}) }) + '\n');
  }
  for (const k of [...last.keys()]) if (!seen.has(k)) { last.delete(k); log.write(JSON.stringify({ t, k, gone: 1 }) + '\n'); }
  stats.counts.push({ t, rd: { ...readAt }, ppl: { ...ppLeagueAt }, ud: lines.underdog.length, pp: lines.prizepicks.length, sl: lines.sleeper.length, pin: pinIdx.size, multi });
}

function pushOut(final) {
  try {
    fs.writeFileSync('out/stats.json', JSON.stringify(stats));
    const hdr = execSync('git config --get http.https://github.com/.extraheader').toString().trim();
    const d = '/tmp/whoright-push'; execSync(`rm -rf ${d} && mkdir -p ${d} && cp -r out ${d}/`);
    const g = c => execSync(`git -C ${d} ${c}`, { stdio: 'pipe' });
    g('init -q'); g('config user.name diag-bot'); g('config user.email diag-bot@users.noreply.github.com');
    g('add -A'); g(`commit -qm "whoright run ${RUN} ${final ? 'final' : 'partial'} ${new Date().toISOString()}"`);
    execSync(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/diag-whoright-out-${RUN}`, { stdio: 'pipe' });
    console.log('pushed', final ? 'final' : 'partial');
  } catch (e) { console.log('push failed', e.message); }
}

(async () => {
  const t0 = Date.now(); let lastPush = Date.now() - 17 * 60e3;
  while (Date.now() - t0 < RUN_MS) {
    const tick = Date.now();
    await Promise.all([safe('ud', fetchUD), safe('sl', fetchSL), safe('pp', fetchPP), safe('pin', fetchPin)]);
    snapshot(); stats.ticks++;
    if (Date.now() - lastPush > 20 * 60e3) { lastPush = Date.now(); await new Promise(r => log.write('', r)); pushOut(false); }
    await wait(Math.max(1000, FAST_MS - (Date.now() - tick)));
  }
  await new Promise(r => log.end(r));
  pushOut(true);
  process.exit(0);
})();
