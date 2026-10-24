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
// env: RUN_N, WEEK (Sunday YYYYMMDD), RUN_MIN (default 335), STOP_AT (ISO: stop recording then),
// LEAGUES (default NFL; "NBA,CFB,NHL" records the weekend board: keys then
// start with the sport, PrizePicks reads one league per read in turn),
// PREFIX (output branch prefix, default nflsun).
// LEAGUES=CS,LOL,VAL,DOTA,R6,COD records the esports board (esrecord.js):
// the same four apps, keyed per match, next to Pinnacle's esports lines,
// BetRivers' esports lines and player kill ladders, and Kalshi's and
// Polymarket US's match-winner books (FanDuel lists no real esports).
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
const ER = require('../esrecord');
const esbooks = require('../esbooks');
const esmatch = require('../esmatch');
const { SLEEPER_ESPORTS } = require('../pickem');

const RUN = process.env.RUN_N || '1';
const WEEK = process.env.WEEK || require('./nflsunday-week')();
const RUN_MS = +(process.env.RUN_MIN || 335) * 60e3;
const STOP_AT = Date.parse(process.env.STOP_AT || '') || Infinity;
const LEAGUES = String(process.env.LEAGUES || 'NFL').toUpperCase().split(/[\s,]+/).filter(Boolean);
const ESB = ER.isEsBoard(LEAGUES);   // the esports board
const TAG = ESB || !(LEAGUES.length === 1 && LEAGUES[0] === 'NFL');   // NFL alone keeps PR 198's keys
// a line's board sport: the esports key on the esports board ("CS2" → CS)
const spOf = l => (ESB ? ER.esKey(l.sport) : String(l.sport || '').toUpperCase());
// Kalshi's match-winner series and Polymarket US's league slugs per esports key
const KS_GAME = { CS: 'KXCS2GAME', LOL: 'KXLOLGAME', VAL: 'KXVALORANTGAME', DOTA: 'KXDOTA2GAME', COD: 'KXCODGAME', R6: 'KXR6GAME' };
const PMUS_LEAGUE = { CS: 'cs2', LOL: 'lol', VAL: 'valorant', DOTA: 'dota2', COD: 'cod', R6: 'r6' };
const PREFIX = process.env.PREFIX || 'nflsun';
const IN = new Set(LEAGUES);
// board sport → Sleeper's sport key, freebooks' key, Pinnacle's game sport
const SL_KEY = { NFL: 'nfl', NBA: 'nba', CFB: 'cfb', NHL: 'nhl', WNBA: 'wnba', CBB: 'cbb', MLB: 'mlb' };
const FB_KEY = { NFL: 'nfl', CFB: 'ncaaf', NBA: 'nba', NHL: 'nhl', WNBA: 'wnba', MLB: 'mlb' };
const PIN_SPORT = { NFL: 'football', CFB: 'football', NBA: 'basketball', WNBA: 'basketball', CBB: 'basketball', NHL: 'hockey', MLB: 'baseball' };
const FB_SPORT = Object.fromEntries(Object.entries(FB_KEY).map(([a, b]) => [b, a]));
// one observe per sport, so a sport's keys are dropped only by its own read
const scope = sp => ({ scope: TAG ? `${sp}|` : '' });
const observeApp = (src, lines, sports = LEAGUES, t = Date.now()) => {
  for (const sp of sports) {
    const mine = lines.filter(l => spOf(l) === sp);
    const entries = ESB ? ER.esAppEntries(mine.map(l => ({ ...l, sport: sp })), sp) : NS.appEntries(mine, sp, { tag: TAG });
    changes.observe(src, entries, t, scope(sp));
  }
};
// mkt: Kalshi and Polymarket US match books (esports board only)
const EVERY = { ud: 60e3, sl: 120e3, pin: ESB ? 240e3 : 120e3, pp: 240e3, p6: 300e3, books: 360e3, mkt: 180e3 };
const PP_URL = 'https://partner-api.prizepicks.com/projections';
const PP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json', Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' };
const wait = ms => new Promise(r => setTimeout(r, ms));

const log = fs.createWriteStream('out/changes.jsonl', { flags: 'a' });
const changes = NS.createChangeLog(o => log.write(JSON.stringify(o) + '\n'));
const stats = { run: RUN, week: WEEK, leagues: LEAGUES, prefix: PREFIX, startedAt: new Date().toISOString(), ticks: 0, reads: {}, errors: {}, errorN: {}, holds: {}, counts: [] };
const lines = { underdog: [], prizepicks: [], sleeper: [] };
const holdUntil = {}, lastAt = {};
// PrizePicks league ids by board sport (from its league list), read in turn
let ppLeagues = process.env.PP_NFL_LEAGUE && !TAG ? { NFL: process.env.PP_NFL_LEAGUE } : null, ppNext = 0, slPlayers = null, slPlayersAt = 0;
const ppLines = {};   // sport → its last PrizePicks read
const caches = {};   // freebooks key → its FanDuel prop and ladder caches
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
  lines.underdog = S.parseUnderdogPayload(r.data || {}).filter(l => IN.has(spOf(l)));
  observeApp('underdog', lines.underdog);
}
async function readPP() {
  if (!ppLeagues) {
    // the whole board once, for PrizePicks' league ids (its league list)
    const r = await axios.get(PP_URL, { params: { per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 60000, maxContentLength: 150e6 });
    const { leagues } = parsePrizePicksPayload(r.data);
    const found = {};
    for (const sp of LEAGUES) {
      // esports: the league whose name reads as this key, the plainest name first ("CS2" before a live or 1H board)
      const ids = Object.keys(leagues).filter(k => (ESB ? ER.esKey(leagues[k]) === sp && !/live|1h|szn/i.test(leagues[k]) : String(leagues[k]).toUpperCase() === sp));
      const id = ids.sort((a, b) => String(leagues[a]).length - String(leagues[b]).length)[0];
      if (id) found[sp] = id;
    }
    if (!Object.keys(found).length) throw new Error(`no ${LEAGUES.join('/')} league on PrizePicks`);
    ppLeagues = found; stats.ppLeagues = found;
    lastAt.pp = Date.now() - EVERY.pp + 60e3;   // the first league read a minute later
    return;
  }
  const sports = Object.keys(ppLeagues);
  const sp = sports[ppNext++ % sports.length];
  const r = await axios.get(PP_URL, { params: { league_id: ppLeagues[sp], per_page: 10000, single_stat: true }, headers: PP_HEADERS, timeout: 30000, maxContentLength: 80e6 });
  const ls = parsePrizePicksPayload(r.data).lines.map(l => ({ ...l, sport: sp }));
  if (!ls.length && (r.data?.data || []).length) throw new Error(`PrizePicks answered but no ${sp} lines parsed`);
  ppLines[sp] = ls;
  lines.prizepicks = Object.values(ppLines).flat();
  observeApp('prizepicks', ls, [sp]);
}
async function readSLEsports() {
  const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 30000, maxContentLength: 60e6 });
  const keys = Object.keys(SLEEPER_ESPORTS).filter(k => IN.has(SLEEPER_ESPORTS[k]));
  const rows = (Array.isArray(r.data) ? r.data : []).filter(x => keys.includes(String(x.sport || '').toLowerCase()));
  // a player table per esports key that has lines, every 6 hours
  if (!slPlayers || Date.now() - slPlayersAt > 6 * 3600e3) {
    const next = {};
    for (const k of new Set(rows.map(x => String(x.sport).toLowerCase()))) {
      try { next[k] = slimPlayers((await axios.get(`https://api.sleeper.app/players/${k}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000, maxContentLength: 60e6 })).data); }
      catch (e) { stats.errors.slPlayers = `${k} ${e.response?.status || ''} ${e.message}`.slice(0, 200); if (slPlayers?.[k]) next[k] = slPlayers[k]; }
    }
    slPlayers = next; slPlayersAt = Date.now();
  }
  if (!lines.underdog.length && !lines.prizepicks.length) return;
  // Sleeper lists no start or match: borrowed from Underdog or PrizePicks
  // against the same opponent (both teams' Sleeper lines share a game id)
  const parsed = parseSleeperLines(rows, slPlayers);
  const slOpp = esmatch.sleeperTeams(parsed);
  const refs = [...lines.underdog, ...lines.prizepicks];
  const ls = [];
  for (const l of parsed) { const b = esmatch.borrowMatch(l, refs, { slOpp, sportOf: spOf }); if (b) ls.push(b); }
  lines.sleeper = ls;
  stats.sleeperPlaced = { lines: parsed.length, placed: ls.length };
  observeApp('sleeper', ls);
}
async function readSL() {
  if (ESB) return readSLEsports();
  if (!slPlayers || Date.now() - slPlayersAt > 6 * 3600e3) {
    const next = {};
    for (const sp of LEAGUES) {
      const k = SL_KEY[sp];
      if (!k) continue;
      try { next[k] = slimPlayers((await axios.get(`https://api.sleeper.app/players/${k}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000, maxContentLength: 60e6 })).data); }
      catch (e) { stats.errors.slPlayers = `${k} ${e.response?.status || ''} ${e.message}`.slice(0, 200); if (slPlayers?.[k]) next[k] = slPlayers[k]; }
    }
    slPlayers = next; slPlayersAt = Date.now();
  }
  const r = await axios.get('https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 30000, maxContentLength: 60e6 });
  const keys = new Set(LEAGUES.map(sp => SL_KEY[sp]).filter(Boolean));
  const rows = (Array.isArray(r.data) ? r.data : []).filter(x => keys.has(String(x.sport || '').toLowerCase()));
  // Sleeper's lines carry no start: the player's game on Underdog or PrizePicks
  const ls = borrowStarts(parseSleeperLines(rows, slPlayers, { sports: true }), [...lines.underdog, ...lines.prizepicks]);
  lines.sleeper = ls;
  // only lines with a start can be graded; without Underdog or PrizePicks read yet, wait
  if (!lines.underdog.length && !lines.prizepicks.length) return;
  observeApp('sleeper', ls.filter(l => l.startTime));
}
const p6 = createPick6Reader(axios, { enabled: true, log: { log() {}, warn() {} } });
const p6Seen = {};
async function readP6() {
  const st = p6.state;
  if (!st.sports.length) {
    await p6.tick();   // the sport list and payouts (and the first sport)
    st.sports = st.sports.filter(s => IN.has(spOf({ sport: s.label })));
    st.sportsAt = Date.now() + 365 * 86400e3;   // no re-read of the list
    if (!st.sports.length) throw new Error(`Pick6 lists no ${LEAGUES.join('/')}`);
    stats.p6Payouts = st.payouts;
    stats.p6Sports = st.sports.map(s => s.label);
  }
  await p6.tick();   // one sport a tick, in turn
  if (st.lastError) throw Object.assign(new Error(st.lastError.message), { response: { status: st.lastError.status } });
  for (const sp of LEAGUES) {
    const b = Object.entries(st.bySport).find(([label]) => spOf({ sport: label }) === sp)?.[1];
    if (!b || p6Seen[sp] === b.at) continue;
    p6Seen[sp] = b.at;
    observeApp('pick6', b.lines.map(l => ({ ...l, sport: sp })), [sp], b.at);
  }
}
// esports: Pinnacle's whole esports feed (series, maps, map totals) in one read
async function readPinEsports() {
  const matches = await esbooks.fetchPinnacle(axios, process.env.PINNACLE_GUEST_KEY || '');
  const entries = new Map([...ER.pinEntries(matches)].filter(([, e]) => IN.has(e.m.sp)));
  if (!entries.size) throw new Error('Pinnacle listed no esports match');
  changes.observe('pinnacle-es', entries, Date.now(), { scope: 'M|' });
  stats.pinMatches = entries.size;
}
async function readPin() {
  if (ESB) return readPinEsports();
  const want = Object.fromEntries(LEAGUES.filter(sp => pinprops.LEAGUES[sp]).map(sp => [sp, pinprops.LEAGUES[sp]]));
  const { props, errors } = await pinprops.fetchPinnacleProps(axios, process.env.PINNACLE_GUEST_KEY || '', want);
  if (errors.length) stats.errors.pinSoft = errors.slice(0, 4).join('; ');
  if (errors.length && !props.length) throw new Error(errors.join('; '));
  pinProps = props;
  for (const sp of Object.keys(want)) {
    const mine = props.filter(p => String(p.sport || sp).toUpperCase() === sp);
    // a league that failed this read keeps its last numbers
    if (!mine.length && errors.some(e => e.includes(sp))) continue;
    changes.observe('pinnacle', NS.bookEntries(mine, { sport: sp, tag: TAG }), Date.now(), scope(sp));
  }
}
// esports: BetRivers' esports events (team lines and player kill ladders)
async function readBooksEsports() {
  const { events, listed, errors } = await esbooks.fetchKambi(axios, { max: 40 });
  if (errors.length) stats.errors.booksSoft = errors.slice(0, 4).join('; ');
  stats.kambi = { listed, read: events.length };
  if (listed && !events.length && errors.length) throw new Error(errors[0]);
  const { teams, players } = ER.kambiEntries(events);
  changes.observe('betrivers-es', new Map([...teams].filter(([, e]) => IN.has(e.m.sp))), Date.now(), { scope: 'M|' });
  changes.observe('betrivers', new Map([...players].filter(([, e]) => IN.has(e.m.sp))), Date.now());
}
// esports: Kalshi's and Polymarket US's match-winner books, each game in turn
async function readMarkets() {
  const soft = [];
  for (const sp of LEAGUES) {
    if (KS_GAME[sp]) {
      try {
        const r = await axios.get('https://api.elections.kalshi.com/trade-api/v2/events', { params: { series_ticker: KS_GAME[sp], status: 'open', with_nested_markets: true, limit: 200 }, headers: { Accept: 'application/json' }, timeout: 20000 });
        changes.observe('kalshi-es', ER.kalshiEntries(r.data?.events || [], sp), Date.now(), { scope: `K|${sp}|` });
      } catch (e) { soft.push(`kalshi ${sp}: ${e.response?.status || ''} ${e.message}`); }
    }
    if (PMUS_LEAGUE[sp]) {
      try {
        const evs = [];
        for (let off = 0; off < 300; off += 50) {
          const r = await axios.get(`https://gateway.polymarket.us/v2/leagues/${PMUS_LEAGUE[sp]}/events`, { params: { limit: 50, offset: off }, timeout: 15000 });
          const list = Array.isArray(r.data?.events) ? r.data.events : [];
          evs.push(...list);
          if (list.length < 50) break;
          await wait(200);
        }
        changes.observe('pmus-es', ER.pmusEntries(evs, sp), Date.now(), { scope: `U|${sp}|` });
      } catch (e) { if (e.response?.status !== 404) soft.push(`pmus ${sp}: ${e.response?.status || ''} ${e.message}`); }
    }
  }
  if (soft.length) stats.errors.mktSoft = soft.slice(0, 6).join('; ');
}
async function readBooks() {
  if (ESB) return readBooksEsports();
  const fbs = LEAGUES.map(sp => FB_KEY[sp]).filter(Boolean);
  const pinSports = Object.fromEntries([...new Set(LEAGUES.map(sp => PIN_SPORT[sp]).filter(Boolean))].map(k => [k, pingames.SPORTS[k]]));
  const pin = await pingames.fetchPinnacleGames(axios, { key: process.env.PINNACLE_GUEST_KEY || '', sports: pinSports });
  if (!pin.games.length) throw new Error(`no Pinnacle games: ${pin.errors.join('; ')}`);
  // one read per league, each with its own FanDuel and BetRivers budget: in one
  // read the day's 60 college games used every slot before the NBA's (10-24)
  const soft = [];
  for (const fb of fbs) {
    const sp = FB_SPORT[fb];
    const c = caches[fb] ||= { propCache: new Map(), ladderCache: new Map() };
    let read;
    try { read = await freebooks.fetchFreeBooks(axios, pin.games, { sports: [fb], fdProps: true, pinProps, ...c, maxFdEvents: TAG ? 25 : 20 }); }
    catch (e) { soft.push(`${fb}: ${e.message}`); continue; }
    soft.push(...read.errors.slice(0, 2));
    for (const b of ['fanduel', 'betrivers']) {
      const props = NS.gameProps(read.games[fb], b);
      // a book that returned nothing this read (blocked, or between slates) keeps its last numbers
      if (props.length) changes.observe(b, NS.bookEntries(props, { sport: sp, tag: TAG }), Date.now(), scope(sp));
    }
    // FanDuel's one-sided rungs (combo ladders), raw, for the combo pricing
    if (TAG) { const rungs = NS.rungEntries(read.games[fb], 'fanduel', { sport: sp, tag: TAG }); if (rungs.size) changes.observe('fanduel-rungs', rungs, Date.now(), scope(sp)); }
    stats.bookGames = { ...(stats.bookGames || {}), [sp]: (read.games[fb] || []).length };
  }
  if (soft.length) stats.errors.booksSoft = soft.slice(0, 6).join('; ');
}

function pushOut(final) {
  try {
    fs.writeFileSync('out/stats.json', JSON.stringify(stats));
    const hdr = execSync('git config --get http.https://github.com/.extraheader').toString().trim();
    const d = `/tmp/${PREFIX}-push-${RUN}`;
    execSync(`rm -rf ${d} && mkdir -p ${d} && cp -r out ${d}/`);
    const g = c => execSync(`git -C ${d} ${c}`, { stdio: 'pipe' });
    g('init -q'); g('config user.name nfl-sunday'); g('config user.email nfl-sunday@users.noreply.github.com');
    g('add -A'); g(`commit -qm "${PREFIX} ${WEEK} run ${RUN} ${final ? 'final' : 'partial'} ${new Date().toISOString()}"`);
    execSync(`git -C ${d} -c http.extraheader="${hdr}" push -fq https://github.com/${process.env.GITHUB_REPOSITORY}.git HEAD:refs/heads/${PREFIX}-${WEEK}-out-${RUN}`, { stdio: 'pipe' });
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
    await Promise.all([step('sl', readSL), step('p6', readP6), step('books', readBooks), ...(ESB ? [step('mkt', readMarkets)] : [])]);
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
