// The props board on a recorded board (fixtures/propsboard-snapshot.json.gz:
// Underdog's, PrizePicks' and Sleeper's lines, Kalshi's prop ladders and the
// esports picks as the server held them on the 10-15 06:17Z raw feeds
// replayed). `expect` holds what /api/props/board, /api/props/coverage and
// /api/status said with the board built in one go, before it ran in slices;
// the first build and every sliced rebuild must give exactly the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'propsboard-snapshot.json.gz'))));
// the clock at the recording, running on from there
const RealDate = Date, realNow = RealDate.now.bind(RealDate), OFF = fix.at - realNow();
global.Date = class extends RealDate {
  constructor(...a) { if (!a.length) super(realNow() + OFF); else super(...a); }
  static now() { return realNow() + OFF; }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-propsnap-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PICK6', 'PINNACLE']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off', NBA_MODEL: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => {
  for (const t of cron.getTasks().values()) t.stop();
  srv.cache.underdog = { data: fix.underdog, updated: new Date().toISOString() };
  srv.cache.prizepicks = { data: fix.prizepicks, updated: new Date().toISOString() };
  srv.cache.sleeper = { data: fix.sleeper, updated: new Date().toISOString() };
  srv.cache.sleeperSports = { data: fix.sleeperSports, updated: new Date().toISOString() };
  srv.kpropsState.games = fix.kprops;
  srv.esportsCache.picks = fix.picks;
  server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

const get = async p => (await fetch(base + p)).json();
async function views() {
  const rows = [];
  for (let off = 0; ; off += 500) {
    const d = await get(`/api/props/board?sport=ALL&sort=start&limit=500&offset=${off}`);
    // the anchor tag (anchor.js) came after the recording: checked on its own below
    rows.push(...d.rows.map(({ anchor, ...r }) => r));
    if (d.rows.length < 500) { const { counts, total } = d; const cov = await get('/api/props/coverage'); delete cov.updated; return { rows, counts, total, coverage: cov }; }
  }
}

test('snapshot: the recorded board fills every kind of row', () => {
  const e = fix.expect;
  assert.ok(e.total > 3000, `${e.total} rows`);
  assert.ok(e.rows.some(r => r.esports) && e.rows.some(r => !r.esports));
  assert.ok(e.rows.some(r => Object.keys(r.books).length >= 2));
});

test('snapshot: the first build gives the board built in one go before', async () => {
  assert.deepStrictEqual(await views(), fix.expect);
});

test('snapshot: a rebuild a slice at a time gives the same board, and every view reads it', async () => {
  const stats = {};
  const before = srv.propsBoardRows();
  const built = await srv.propsBoardRebuild({ fresh: true, sliceMs: 1, stats });
  assert.notEqual(built, before, 'a new build');
  assert.ok(stats.slices > 20, `${stats.slices} slices`);
  assert.equal(srv.propsBoardRows(), built, 'views read the new build');
  assert.deepStrictEqual(await views(), fix.expect);
});

test('a view asked for while a build runs gets the last board and one build runs', async () => {
  const last = srv.propsBoardRows();
  const a = srv.propsBoardRebuild({ sliceMs: 1 });
  const b = srv.propsBoardRebuild();
  assert.equal(a, b, 'one build in flight');
  assert.equal(srv.propsBoardRows(), last);
  await a;
  assert.notEqual(srv.propsBoardRows(), last);
});

test('every row carries its anchor tag, and with no sharp source in the recording every leg is unanchored', async () => {
  const d = await get('/api/props/board?sport=ALL&sort=start&limit=500');
  assert.ok(d.rows.every(r => r.anchor && Array.isArray(r.anchor.books)), 'every row tagged');
  // coverage: 0 sharp-priced legs in this recording (no Pinnacle, books or priced Kalshi rung)
  assert.equal(fix.expect.coverage.total.sharp, 0);
  assert.ok(srv.propsBoardRows().rows.every(r => r.anchor.books.length === 0));
  assert.equal(d.anchor.now.total.unanchored, d.anchor.now.total.legs);
  assert.equal(d.anchor.now.total.legs, fix.expect.coverage.total.legs + srv.propsBoardRows().rows.filter(r => r.esports).reduce((a, r) => a + Object.keys(r.books).length, 0));
  assert.ok(d.anchor.label === 'research, not an edge' && /No side cleared/.test(d.anchor.backtest?.verdict || ''));
  const none = await get('/api/props/board?sport=ALL&anchor=none&limit=1');
  const sharp = await get('/api/props/board?sport=ALL&anchor=sharp&limit=1');
  assert.equal(none.total, d.total);
  assert.equal(sharp.total, 0);
});
