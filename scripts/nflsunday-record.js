// NFL Sunday board recorder (nflsunday.js), run inside GitHub Actions by
// .github/workflows/nfl-sunday.yml: Pick6 answers only there.
// Every NFL player leg on PrizePicks, Underdog, Sleeper and DK Pick6, and
// Pinnacle's, FanDuel's and BetRivers' raw props for the same players, read
// over and over for RUN_MIN minutes. Each change goes to out/changes.jsonl;
// out/stats.json says when each source was read and what failed. The output
// is force-pushed to nflsun-<WEEK>-out-<RUN> every 15 minutes and at the end.
//
// Pace: Underdog 1 min, Sleeper 2 min, Pinnacle 2 min, PrizePicks NFL 4 min
// (one league, Retry-After honoured), Pick6 NFL 5 min, FanDuel and BetRivers
// 6 min. Nothing logs in and nothing gets past a bot check: a source that
// blocks us is left alone until its Retry-After (or 5 minutes) passes.
// env: RUN_N, WEEK (Sunday YYYYMMDD), RUN_MIN (default 335), STOP_AT (ISO: stop recording then)
const cron = require('node-cron'); cron.schedule = () => ({ stop() {} });
process.env.LR_DATA_DIR = process.env.LR_DATA_DIR || '/tmp/lr-nflsun';
const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
fs.mkdirSync(process.env.LR_DATA_DIR, { recursive: true });
fs.mkdirSync('out', { recursive: true });
const S = require('../server.js');
const { parsePrizePicksPayload, parseSleeperLines, slimPlayers } = require('../pickem');
const { borrowStarts } = require('../propsboard');
const { createPick6Reader } = require('../pick6');
const pinprops = require('../pinprops');
const pingames = require('../pingames');
const freebooks = require('../freebooks');
const NS = require('../nflsunday');

const RUN = process.env.RUN_N || '1';
const WEEK = process.env.WEEK || require('./nflsunday-week')();
const RUN_MS = +(process.env.RUN_MIN || 335) * 60e3;
const STOP_AT = Date.parse(process.env.STOP_AT || '') || Infinity;
const EVERY = { ud: 60e3, sl: 120e3, pin: 120e3, pp: 240e3, p6: 300e3, books: 360e3 };
const PP_URL = 'https://partner-api.prizepicks.com/projections';
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const wait = ms => new Promise(r => setTimeout(r, ms));

const log = fs.createWriteStream('out/changes.jsonl', { flags: 'a' });
const changes = NS.createChangeLog(o => log.write(JSON.stringify(o) + '\n'));
const stats = { run: RUN, week: WEEK, startedAt: new Date().toISOString(), ticks: 0, reads: {}, errors: {}, errorN: {}, holds: {}, counts: [] };
const lines = { underdog: [], prizepicks: [], sleeper: [] };
const holdUntil = {}, lastAt = {};
let ppLeague = process.env.PP_NFL_LEAGUE || null, slPlayers = null, slPlayersAt = 0;
const propCache = new Map(), ladderCache = new Map();
let pinProps = [];

const retryMs = e => { const ra = Number(e?.response?.headers?.['retry-after']); return Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0; };
async function step(name, fn) {
  const now = Date.now();
  if (now < (holdUntil[name] || 0) || now - (lastAt[name] || 0) < EVERY[name]) return;
  lastAt[name] = now;
  try { await fn(); stats.reads[name] = new Date().toISOString(); }
  catch (e) {
    const s = e.response?.status;
    stats.errors[name] = `${s || ''} ${e.message}`.slice(0, 200);
    stats.errorN[name] = (stats.errorN[name] || 0) + 1;
    if (s === 403 || s === 429) { holdUntil[name] = Date.now() + Math.max(retryMs(e), 5 * 60e3); stats.holds[name] = new Date(holdUntil[name]).toISOString(); }
  }
}

async function readUD() {
  const r = await axios.get('https://api.underdogfantasy.com/v1/over_under_lines', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 20000, maxContentLength: 80e6 });
  lines.underdog = S.parseUnderdogPayload(r.data || {}).filter(l => l.sport === 'NFL');
  changes.observe('underdog', NS.appEntries(lines.underdog));
}
async function readPP() {
  if (!ppLeague) {
    // the whole board once, for PrizePicks' NFL league id (its league list)
    const r = await axios.get(PP_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 150e6 });
    const { leagues } = parsePrizePicksPayload(r.data);
    const id = Object.keys(leagues).find(k => String(leagues[k]).toUpperCase() === 'NFL');
    if (!id) throw new Error('no NFL league on PrizePicks');
    ppLeague = id; stats.ppLeague = id;
    lastAt.pp = Date.now() - EVERY.pp + 60e3;   // the NFL read a minute later
    return;
  }
  const r = await axios.get(PP_URL, { params: { league_id: ppLeague, per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 30000, maxContentLength: 80e6 });
  const ls = parsePrizePicksPayload(r.data).lines.map(l => ({ ...l, sport: 'NFL' }));
  if (!ls.length && (r.data?.data || []).length) throw new Error('PrizePicks answered but no NFL lines parsed');
  lines.prizepicks = ls;
  changes.observe('prizepicks', NS.appEntries(ls));
}
async function readSL() {
  if (!slPlayers || Date.now() - slPlayersAt > 6 * 3600e3) {
    const pr = await axios.get('https://api.sleeper.app/players/nfl', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000, maxContentLength: 60e6 });
    slPlayers = { nfl: slimPlayers(pr.data) }; slPlayersAt = Date.now();
  }
  const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 30000, maxContentLength: 60e6 });
  const rows = (Array.isArray(r.data) ? r.data : []).filter(x => String(x.sport || '').toLowerCase() === 'nfl');
  // Sleeper's lines carry no start: the player's game on Underdog or PrizePicks
  const ls = borrowStarts(parseSleeperLines(rows, slPlayers, { sports: true }), [...lines.underdog, ...lines.prizepicks]);
  lines.sleeper = ls;
  // only lines with a start can be graded; without Underdog or PrizePicks read yet, wait
  if (!lines.underdog.length && !lines.prizepicks.length) return;
  changes.observe('sleeper', NS.appEntries(ls.filter(l => l.startTime)));
}
const p6 = createPick6Reader(axios, { enabled: true, log: { log() {}, warn() {} } });
async function readP6() {
  const st = p6.state;
  if (!st.sports.length) {
    await p6.tick();   // the sport list and payouts (and the first sport)
    st.sports = st.sports.filter(s => /^NFL$/i.test(s.label));
    st.sportsAt = Date.now() + 365 * 86400e3;   // no re-read of the list
    if (!st.sports.length) throw new Error('Pick6 lists no NFL');
    stats.p6Payouts = st.payouts;
  }
  await p6.tick();
  if (st.lastError) throw Object.assign(new Error(st.lastError.message), { response: { status: st.lastError.status } });
  const nfl = st.bySport.NFL;
  if (!nfl) return;
  changes.observe('pick6', NS.appEntries(nfl.lines.map(l => ({ ...l, sport: 'NFL' }))), nfl.at);
}
async function readPin() {
  const { props, errors } = await pinprops.fetchPinnacleProps(axios, process.env.PINNACLE_GUEST_KEY || '', { NFL: pinprops.LEAGUES.NFL });
  if (errors.length) throw new Error(errors.join('; '));
  pinProps = props;
  changes.observe('pinnacle', NS.bookEntries(props));
}
async function readBooks() {
  const pin = await pingames.fetchPinnacleGames(axios, { key: process.env.PINNACLE_GUEST_KEY || '', sports: { football: pingames.SPORTS.football } });
  if (!pin.games.length) throw new Error(`no Pinnacle games: ${pin.errors.join('; ')}`);
  const read = await freebooks.fetchFreeBooks(axios, pin.games, { sports: ['nfl'], fdProps: true, pinProps, propCache, ladderCache, maxFdEvents: 20 });
  if (read.errors.length) stats.errors.booksSoft = read.errors.slice(0, 4).join('; ');
  for (const b of ['fanduel', 'betrivers']) {
    const props = NS.gameProps(read.games.nfl, b);
    // a book that returned nothing this read (blocked, or between slates) keeps its last numbers
    if (props.length) changes.observe(b, NS.bookEntries(props));
  }
}

function pushOut(final) {
  try {
    fs.writeFileSync('out/stats.json', JSON.stringify(stats));
    const hdr = execSync('git config --get http.https://github.com/.extraheader').toString().trim();
    const d = `/tmp/nflsun-push-${RUN}`;
    execSync(`rm -rf ${d} && mkdir -p ${d} && cp -r out ${d}/`);
    const g = c => execSync(`git -C ${d} ${c}`, { stdio: 'pipe' });
    g('init -q'); g('config user.name nfl-sunday'); g('config user.email nfl-sunday@users.noreply.github.com');
    g('add -A'); g(`commit -qm "nfl sunday ${WEEK} run ${RUN} ${final ? 'final' : 'partial'} ${new Date().toISOString()}"`);
    execSync(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/nflsun-${WEEK}-out-${RUN}`, { stdio: 'pipe' });
    console.log('pushed', final ? 'final' : 'partial', JSON.stringify(changes.size()));
  } catch (e) { console.log('push failed', e.message); }
}

(async () => {
  const t0 = Date.now();
  let lastPush = Date.now();
  while (Date.now() - t0 < RUN_MS && Date.now() < STOP_AT) {
    const tick = Date.now();
    // the apps' reads first (Sleeper borrows their starts), the books beside them
    await Promise.all([step('ud', readUD), step('pp', readPP), step('pin', readPin)]);
    await Promise.all([step('sl', readSL), step('p6', readP6), step('books', readBooks)]);
    stats.ticks++;
    if (stats.ticks % 10 === 1) stats.counts.push({ t: Date.now(), keys: changes.size(), lines: changes.lines() });
    if (Date.now() - lastPush > 15 * 60e3) { lastPush = Date.now(); await new Promise(r => log.write('', r)); pushOut(false); }
    await wait(Math.max(1000, 30e3 - (Date.now() - tick)));
  }
  await new Promise(r => log.end(r));
  stats.endedAt = new Date().toISOString();
  pushOut(true);
  process.exit(0);
})();
