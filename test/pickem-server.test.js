// The esports board with a Sleeper line next to Underdog's: the Sleeper side
// gets its own EV at its own payout, a Sleeper-only line becomes a pick, and a
// Sleeper line with no known match is left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-pickem-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
test.after(() => { for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('Sleeper lines are priced on the esports board next to Underdog', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.cache.prizepicks = { data: [], updated: null };
  srv.cache.underdog = { data: [{ book: 'underdog', sport: 'CS', player: 'NAF', team: 'Team Liquid', market: 'Kills on Maps 1+2', line: 30.5, startTime: start, matchTitle: 'Team Liquid vs NAVI',
    overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true }] };
  srv.cache.sleeper = { data: [
    { book: 'sleeper', sport: 'CS', player: 'NAF', team: 'Liquid', market: 'Kills Maps 1-2', line: 29.5, overMultiplier: 1.8, underMultiplier: 1.9, overOpen: true, underOpen: true },
    { book: 'sleeper', sport: 'CS', player: 'Twistzz', team: 'Liquid', market: 'Headshots Maps 1-2', line: 14.5, overMultiplier: 1.85, underMultiplier: 1.85, overOpen: true, underOpen: true },
    { book: 'sleeper', sport: 'CS', player: 'ghost', team: 'Unknown Five', market: 'Kills Maps 1-2', line: 20.5, overMultiplier: 1.85, underMultiplier: 1.85, overOpen: true, underOpen: true },
  ] };
  srv.esportsCache.manualPredictions = { 'NAF|Kills on Maps 1+2': 31.5, 'Twistzz|Headshots Maps 1-2': 16 };
  const picks = await srv.generateEsportsPicks();
  const naf = picks.find(p => p.player === 'NAF');
  assert.equal(naf.lineSource, 'ud');
  assert.equal(naf.sleeperLine, 29.5);
  assert.equal(naf.sleeperMultiplier, 1.8);
  assert.ok(naf.sleeperEv != null && naf.udEv != null);
  // a line a point lower on the over is worth more than the same price at 30.5
  assert.ok(naf.side === 'OVER');
  const tw = picks.find(p => p.player === 'Twistzz');
  assert.equal(tw.lineSource, 'sl');
  assert.equal(tw.startTime, start);
  assert.equal(tw.bestBook, 'SL');
  assert.ok(!picks.some(p => p.player === 'ghost'));
});

test('an Underdog line that only takes Higher gets no Underdog price on a Lower pick', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'CS2', player: 'ropz', team: 'FaZe', market: 'MAPS 1-2 Kills', line: 30.5, startTime: start, matchTitle: 'FaZe vs NAVI', gameId: 'pp1' }], updated: null };
  srv.cache.underdog = { data: [{ book: 'underdog', sport: 'CS', player: 'ropz', team: 'FaZe', market: 'Kills on Maps 1+2', line: 30.5, startTime: start, matchTitle: 'FaZe vs NAVI',
    overMultiplier: 1.03, underMultiplier: null, overOpen: true, underOpen: false }] };
  srv.cache.sleeper = { data: [] };
  srv.esportsCache.manualPredictions = { 'ropz|MAPS 1-2 Kills': 26 };
  const picks = await srv.generateEsportsPicks();
  const p = picks.find(x => x.player === 'ropz');
  assert.equal(p.side, 'UNDER');
  assert.equal(p.udEv, null);
  assert.equal(p.udClosed, true);
  assert.equal(p.bestBook, 'PP');
  assert.ok(!p.pricing.books.UD);
});

test('PrizePicks lines past their age leave the board; the rest stay', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  const es = { book: 'prizepicks', sport: 'CS2', leagueId: '265', player: 'ropz', team: 'FaZe', market: 'MAPS 1-2 Kills', line: 30.5, startTime: start, matchTitle: 'FaZe vs NAVI', gameId: 'pp1' };
  const nba = { book: 'prizepicks', sport: 'NBA', player: 'Jokic', market: 'Points', line: 27.5, startTime: start };
  srv.cache.prizepicks = { data: [es, nba], updated: null };
  srv.cache.underdog = { data: [] };
  srv.cache.sleeper = { data: [] };
  const now = Date.now();
  Object.assign(srv.ppState, { fullOkAt: now - 20 * 60e3, leagueOkAt: {} });
  assert.deepEqual(srv.ppLinesNow(now).map(l => l.player), ['Jokic'], 'no esports pull for 20 min: stale; sports pull 20 min old: fine');
  assert.ok(!(await srv.generateEsportsPicks()).some(p => p.player === 'ropz'), 'a stale PrizePicks line makes no pick');
  Object.assign(srv.ppState, { fullOkAt: now - 60 * 60e3, leagueOkAt: { 265: now - 60e3 } });
  assert.deepEqual(srv.ppLinesNow(now).map(l => l.player), ['ropz'], 'its league just answered; the sports pull is an hour old');
  Object.assign(srv.ppState, { fullOkAt: 0, leagueOkAt: {} });
});

test('a player in two Bo1s on one day gets a pick per match, each priced on its own lines', async () => {
  const t = h => new Date(Date.now() + h * 3600e3).toISOString();
  const ud = (line, opp, h, gameId) => ({ book: 'underdog', sport: 'CS', player: 'DemQQ', team: 'WBT', market: 'Kills on Map 1', line, startTime: t(h), matchTitle: `WBT vs ${opp}`, gameId,
    overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true });
  srv.cache.prizepicks = { data: [
    { book: 'prizepicks', sport: 'CS2', player: 'DemQQ', team: 'WBT', market: 'MAP 1 Kills', line: 16, startTime: t(4), matchTitle: 'ENCE MAP 1', gameId: 'ENCEWBT' },
    { book: 'prizepicks', sport: 'CS2', player: 'DemQQ', team: 'WBT', market: 'MAP 1 Kills', line: 15.5, startTime: t(8), matchTitle: 'BOJONG MAP 1', gameId: 'BOJONGWBT' },
  ], updated: null };
  // Underdog lists the BOJONG match first: keyed by player and stat, the ENCE pick took its 14.5
  srv.cache.underdog = { data: [ud(15.5, 'ENCE', 6, 2), ud(14.5, 'BOJONG', 8, 3)].reverse() };
  srv.cache.sleeper = { data: [
    { book: 'sleeper', sport: 'CS', player: 'DemQQ', team: 'WBT', market: 'Kills Map 1', line: 16.5, gameId: 'm-17', overMultiplier: 1.8, underMultiplier: 1.9, overOpen: true, underOpen: true },
    { book: 'sleeper', sport: 'CS', player: 'gla1ve', team: 'ENCE', market: 'Kills Map 1', line: 17.5, gameId: 'm-17', overMultiplier: 1.8, underMultiplier: 1.9, overOpen: true, underOpen: true },
  ] };
  srv.esportsCache.manualPredictions = {};
  const picks = (await srv.generateEsportsPicks()).filter(p => p.player === 'DemQQ');
  assert.equal(picks.length, 2);
  const ence = picks.find(p => /ENCE/.test(p.matchTitle)), boj = picks.find(p => /BOJONG/.test(p.matchTitle));
  assert.equal(ence.ppLine, 16); assert.equal(ence.udLine, 15.5); assert.equal(ence.sleeperLine, 16.5);
  assert.equal(boj.ppLine, 15.5); assert.equal(boj.udLine, 14.5); assert.equal(boj.sleeperLine, null);
  assert.notEqual(ence.matchTag, boj.matchTag);
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(srv.ppRetryAfterMs({ 'retry-after': '120' }), 120000);
  const ms = srv.ppRetryAfterMs({ 'retry-after': new Date(Date.now() + 300e3).toUTCString() });
  assert.ok(ms > 290e3 && ms <= 300e3);
  assert.equal(srv.ppRetryAfterMs({}), 0);
  assert.equal(srv.ppRetryAfterMs(undefined), 0);
});

test('a PrizePicks 429 backs off from the first one, longer each time, never under Retry-After', async () => {
  const get = axios.get;
  let calls = 0;
  axios.get = async () => { calls++; throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '1800' } } }); };
  try {
    await srv.scrapePrizePicks();
    const f = srv.ppFailState();
    assert.equal(calls, 1);
    assert.ok(f.until - Date.now() > 29 * 60e3, 'Retry-After 30 min beats the 4 min first step');
    await srv.scrapePrizePicks();
    assert.equal(calls, 1, 'no request inside the back-off');
    f.until = 0;
    axios.get = async () => { calls++; throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } }); };
    await srv.scrapePrizePicks();
    const g = srv.ppFailState();
    assert.ok(g.until - Date.now() > 7 * 60e3 && g.until - Date.now() <= 8 * 60e3, 'second 429 in a row: 8 min');
  } finally { axios.get = get; srv.ppFailState().until = 0; }
});

test('PrizePicks: one esports league a cycle, in turn, keeping the others', async () => {
  const get = axios.get;
  const asked = [];
  const proj = (id, league, name) => ({ data: [{ id, type: 'projection', attributes: { line_score: 20.5, stat_type: 'MAPS 1-2 Kills', odds_type: 'standard', start_time: new Date(Date.now() + 3600e3).toISOString() },
    relationships: { new_player: { data: { id: 'p' + id } }, league: { data: { id: league } } } }],
    included: [{ id: 'p' + id, type: 'new_player', attributes: { name: 'P' + id, team: 'T', league: name } }, { id: league, type: 'league', attributes: { name } }] });
  axios.get = async (url, { params }) => {
    asked.push(params.league_id || 'full');
    if (!params.league_id) return { data: { data: [...proj('1', '265', 'CS2').data, ...proj('2', '121', 'LoL').data], included: [...proj('1', '265', 'CS2').included, ...proj('2', '121', 'LoL').included] } };
    return { data: proj(params.league_id === '265' ? '3' : '4', params.league_id, params.league_id === '265' ? 'CS2' : 'LoL') };
  };
  try {
    Object.assign(srv.ppState, { fullAt: 0, esportsLeagues: [], next: 0, fullOkAt: 0, leagueOkAt: {} });
    await srv.scrapePrizePicks();
    await srv.scrapePrizePicks();
    await srv.scrapePrizePicks();
    assert.deepEqual(asked, ['full', ...srv.ppState.esportsLeagues.slice(0, 2)], 'one request a cycle');
    assert.equal(srv.ppState.esportsLeagues.length, 2);
    assert.deepEqual(srv.cache.prizepicks.data.map(l => l.player).sort(), ['P3', 'P4'], 'each league replaced by its own pull, the other kept');
  } finally { axios.get = get; Object.assign(srv.ppState, { fullAt: 0, esportsLeagues: [], next: 0, fullOkAt: 0, leagueOkAt: {} }); srv.cache.prizepicks = { data: [], updated: null }; }
});
