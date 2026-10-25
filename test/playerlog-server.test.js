// /api/props/player and the board's hit-rate columns on a booted server
// (axios offline): a board row opens its player page with the game log and
// hit rates at each app's line; the Lines view carries L10 and season hit %
// and sorts by them; nothing on the page reads as a play.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-playerlog-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

const DAY = 86400e3;
// test-only history: two players' last 12 games (never served as live data)
function seed() {
  for (let i = 0; i < 12; i++) {
    const t = Date.now() - (12 - i) * DAY;
    srv.playerLog.addGame({ id: `t${i}`, t, sport: 'NBA', teams: [{ abbr: 'ORL', name: 'Orlando Magic', home: i % 2 === 0, score: 100 }, { abbr: i % 3 ? 'CLE' : 'MIA', name: i % 3 ? 'Cleveland Cavaliers' : 'Miami Heat', home: i % 2 === 1, score: 95 }],
      players: [{ id: 'pb', k: 'paolobanchero', n: 'Paolo Banchero', tm: 'ORL', s: { points: 15 + i, rebounds: 8 }, u: 34, ul: 'min' },
        { id: 'fw', k: 'franzwagner', n: 'Franz Wagner', tm: 'ORL', s: { points: 30 - i }, u: 33, ul: 'min' }] });
  }
}

test('a board row opens a player page: log, hit rates at each app line, the other stats, no play wording', async () => {
  seed();
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  const ud = (player, market, line) => ({ book: 'underdog', sport: 'NBA', player, team: 'ORL', market, line, startTime: start, matchTitle: 'CLE @ ORL', overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true });
  srv.cache.underdog = { data: [ud('Paolo Banchero', 'Points', 20.5), ud('Paolo Banchero', 'Rebounds', 7.5), ud('Franz Wagner', 'Points', 25.5)] };
  srv.cache.prizepicks = { data: [], updated: null };
  srv.cache.sleeper = { data: [] };
  const board = await get('/api/props/board?sport=NBA&book=underdog&facets=1&sort=hit10&limit=50');
  assert.equal(board.status, 200);
  const rows = board.body.rows;
  assert.ok(rows.length >= 3);
  const pb = rows.find(r => r.player === 'Paolo Banchero' && r.mkey === 'points');
  // last 10: 17..26 against 20.5 → 21..26 over (6 of 10); season 12 games, 6 over
  assert.deepEqual(pb.hit, { l10: 60, l10n: 10, szn: 50, sznN: 12, games: 12 });
  // highest L10 first: Banchero's rebounds (8 every game, 100%) lead
  assert.equal(rows[0].mkey, 'rebounds');
  assert.ok(board.body.hitLabel.includes('not an edge'));
  const asc = await get('/api/props/board?sport=NBA&book=underdog&facets=1&sort=hit10a&limit=50');
  assert.equal(asc.body.rows[0].player, 'Franz Wagner');

  const { status, body } = await get(`/api/props/player?key=${encodeURIComponent(pb.key)}`);
  assert.equal(status, 200);
  assert.equal(body.player, 'Paolo Banchero');
  assert.equal(body.games, 12);
  assert.deepEqual(body.lines, [20.5]);
  assert.equal(body.hits[0].l5.over, 5);
  assert.equal(body.opponent, 'CLE');
  assert.equal(body.homeTonight, true);
  assert.ok(body.hits[0].vs.n > 0);
  assert.equal(body.log[0].v, 26);
  assert.equal(body.usage.kind, 'min');
  assert.ok(body.others.some(o => o.mkey === 'rebounds'));
  assert.ok(body.ms < 1000);
  assert.ok(!/proven|lock/i.test(JSON.stringify({ label: body.label })), 'no proven or lock wording');
  // switch stat on the same player
  const reb = await get(`/api/props/player?key=${encodeURIComponent(pb.key)}&stat=rebounds`);
  assert.equal(reb.body.mkey, 'rebounds');
  assert.equal(reb.body.hits[0].season.pct, 100);
  // the paywall is off here, so the sharp numbers section is present (empty: no books read offline)
  assert.ok(Array.isArray(body.books));
  assert.deepEqual(body.models, []);
  const gone = await get('/api/props/player?key=NBA%7Cnobody%7Cpoints');
  assert.equal(gone.status, 404);
});

test('status reports the player log', async () => {
  const { body } = await get('/api/status');
  assert.ok(body.playerLog && body.playerLog.games >= 12);
});
