// GET /api/moves (ODDS SCREEN > BIGGEST MOVES): answers from what the server
// keeps, says honestly when there is no history yet, and refuses odd filters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-moves-'));
for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PUBLIC_URL']) delete process.env[k];
Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
  SPORT_PROPS_FILE: path.join(DIR, 'sport-props.json'), ESPORTS_CALIBRATION: 'off' });
const axios = require('axios');
axios.get = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
axios.post = axios.get;
const srv = require('../server');
const cron = require('node-cron');
let server, base;
test.before(async () => { server = srv.app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server?.close(); for (const t of cron.getTasks().values()) t.stop(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });

test('/api/moves with no history yet: no rows, the history depth, and the not-an-edge note', async () => {
  const r = await fetch(`${base}/api/moves`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.rows, []);
  assert.equal(d.window, 'open');
  assert.equal(d.type, 'price');
  assert.equal(d.history.gameSince, null);
  assert.equal(d.history.gameMarkets, 0);
  assert.match(d.note, /not a proven edge/);
  assert.deepEqual(d.facets, { venues: [], leagues: [] });
});

test('/api/moves keeps only the filters it knows', async () => {
  const d = await (await fetch(`${base}/api/moves?window=1h&type=line&venue=nope&league=NFL;drop&kind=x&sort=evil`)).json();
  assert.equal(d.window, '1h');
  assert.equal(d.type, 'line');
  assert.equal(d.venue, null);
  assert.equal(d.league, null);
  assert.equal(d.kind, null);
  assert.equal(d.sort, 'move');
  const k = await (await fetch(`${base}/api/moves?window=3h&venue=prizepicks&kind=prop&league=nfl&sort=old`)).json();
  assert.equal(k.venue, 'prizepicks');
  assert.equal(k.kind, 'prop');
  assert.equal(k.league, 'nfl');
  assert.equal(k.sort, 'old');
});
