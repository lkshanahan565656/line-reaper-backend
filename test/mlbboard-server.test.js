// /api/props/mlb: the MLB VS PINNACLE view answers with its bar, record kinds
// and backtest, and says plainly when no MLB game has Pinnacle props up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-mlb-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'MLB_PIN']) delete process.env[k];
Object.assign(process.env, { TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('MLB VS PINNACLE: research, its own record kinds, the backtest, no Pinnacle no rows', async () => {
  const start = new Date(Date.now() + 5 * 3600e3).toISOString();
  srv.cache.prizepicks = { data: [{ book: 'prizepicks', sport: 'MLB', player: 'Freddy Peralta', team: 'MIL', market: 'Pitcher Strikeouts', line: 5.5, startTime: start, overOpen: true, underOpen: true }], updated: new Date().toISOString() };
  const r = await fetch(`${base}/api/props/mlb`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.on, true);
  assert.equal(d.label, 'research, not a bet');
  assert.match(d.bar, /50\+ graded live/);
  assert.deepEqual(Object.keys(d.record).sort(), ['mlb-even', 'mlb-pin', 'p6-mlb-even', 'p6-mlb-pin', 'sl-mlb-even', 'sl-mlb-pin', 'ud-mlb-even', 'ud-mlb-pin']);
  assert.ok(d.backtest && Array.isArray(d.backtest.lines) && d.backtest.lines.length > 0, 'the backtest ships with it');
  // Pinnacle is offline here: nothing priced, and nothing made up
  assert.equal(d.rows.length, 0);
  assert.equal(d.counts.gap, 0);
  assert.equal(d.stacks.length, 0);
});
