// Closed lanes (coldstore.js): the disk store's contract, the results backup
// through it, and a booted server whose closed tabs read their record from
// disk and say they are closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cold = require('../coldstore');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cold-'));

test('disk store: puts land on disk in one rewrite, all() is a fresh copy', async () => {
  const dir = tmp(), file = path.join(dir, 'x.json');
  const s = cold.createDiskStore(file, { delayMs: 20 });
  await s.init();
  assert.deepEqual(await s.all(), []);
  const row = { id: 'a', status: 'open' };
  await Promise.all([s.put(row), s.put({ id: 'b', status: 'graded' }), s.putMany([{ id: 'c' }])]);
  assert.equal(s.stats().writes, 1, 'three puts, one rewrite');
  row.status = 'mutated after the put';
  const rows = await s.all();
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'b', 'c']);
  assert.equal(rows.find(r => r.id === 'a').status, 'open', 'the put copied the row');
  rows[0].status = 'changed in a read';
  assert.notEqual((await s.all())[0].status, 'changed in a read', 'nothing is kept between calls');
  // an update replaces by id; another instance reads the same file
  await s.put({ id: 'a', status: 'graded' });
  const again = cold.createDiskStore(file);
  assert.equal((await again.all()).find(r => r.id === 'a').status, 'graded');
  assert.equal((await again.all()).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disk store reads a file jsonstore wrote, and the reverse', async () => {
  const dir = tmp(), file = path.join(dir, 'y.json');
  const { createJsonFileStore } = require('../jsonstore');
  const js = createJsonFileStore(file, { delayMs: 10 });
  await js.init();
  await js.putMany([{ id: 'p' }, { id: 'q' }]);
  await js.flush();
  const s = cold.createDiskStore(file, { delayMs: 10 });
  assert.deepEqual((await s.all()).map(r => r.id), ['p', 'q']);
  await s.put({ id: 'r' });
  const back = createJsonFileStore(file);
  await back.init();
  assert.deepEqual((await back.all()).map(r => r.id), ['p', 'q', 'r']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the results backup restores into a disk store and exports from it', async () => {
  const { createBackup } = require('../backup');
  const { createMemoryStore } = require('../evtrack');
  const key = crypto.randomBytes(32), quiet = { log() {}, warn() {} };
  const src = createBackup({ key, sources: ['mem://x'], fetchJson: async () => null, log: quiet });
  const m = src.wrap('promoLegs', createMemoryStore());
  await m.init();
  for (let i = 0; i < 250; i++) await m.put({ id: `leg${i}`, status: i % 5 ? 'graded' : 'open' });
  const snap = await src.exportSnapshot();
  const dir = tmp();
  const b = createBackup({ key, sources: ['mem://x'], fetchJson: async () => snap, log: quiet });
  const d = b.wrap('promoLegs', cold.createDiskStore(path.join(dir, 'promo-legs.json'), { delayMs: 5 }));
  await d.init();
  assert.equal((await d.all()).length, 250, 'restored to disk');
  assert.deepEqual((await b.exportSnapshot()).counts, { promoLegs: 250 }, 'and exported from it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the closed list: each lane has a date and a reason; others are open', () => {
  for (const name of ['promoLegs', 'bidArbs', 'kalshiMaker', 'xsize', 'esportsInplay', 'exchangeProps']) {
    assert.ok(cold.closed(name), name);
    const c = cold.closedInfo(name);
    assert.equal(c.final, true);
    assert.match(c.at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(c.note, /^Closed \d{4}-\d{2}-\d{2}, final: .+Nothing new is recorded/);
  }
  for (const name of ['shopLegs', 'appCard', 'ev', 'sportProps', 'esportsMapUnders', 'offshoreRef', 'evStale', 'tailTraders']) {
    assert.equal(cold.closed(name), false, name);
    assert.equal(cold.closedInfo(name), null);
  }
});

test('a booted server: closed tabs read the record from disk and say closed', async () => {
  const DIR = tmp();
  for (const k of ['DATABASE_URL', 'ODDS_API_KEY', 'OWLS_API_KEY', 'ALERT_WEBHOOK_URL', 'PAYWALL', 'TELEGRAM_BOT_TOKEN', 'STRIPE_SECRET_KEY']) delete process.env[k];
  Object.assign(process.env, { LR_DATA_DIR: DIR, TRACKER_FILE: path.join(DIR, 'picks.json'), USERS_FILE: path.join(DIR, 'users.json'), EV_TRACK_FILE: path.join(DIR, 'ev.json'),
    API_KEYS_FILE: path.join(DIR, 'api-keys.json'), OUT_FEED_FILE: path.join(DIR, 'out-feed.json'), ESPORTS_CALIBRATION: 'off' });
  // a Kalshi maker record left from before the close
  const t = Date.now() - 86400e3;
  fs.writeFileSync(path.join(DIR, 'kalshi-maker-bids.json'), JSON.stringify([
    { id: 'km1', kind: 'kalshi-maker', status: 'graded', sport: 'nba', postedAt: new Date(t).toISOString(), start: new Date(t + 3600e3).toISOString(), result: 'yes', side: 'A', event: 'A at B', market: 'ml', bid: 0.45 },
    { id: 'km2', kind: 'kalshi-maker', status: 'unfilled', sport: 'nba', postedAt: new Date(t).toISOString(), start: new Date(t + 3600e3).toISOString(), side: 'B', event: 'A at B', market: 'ml', bid: 0.5 },
  ]));
  const axios = require('axios');
  const offline = async () => { throw Object.assign(new Error('offline'), { response: { status: 503 } }); };
  axios.get = offline; axios.post = offline;
  const srv = require('../server');
  const cron = require('node-cron');
  const server = srv.app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(base + p, { signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json() }; };
  try {
    const km = await get('/api/kalshi-maker');
    assert.equal(km.status, 200);
    assert.equal(km.body.closed?.final, true);
    assert.deepEqual(km.body.recent.map(r => r.id ?? r.side).length, 2, 'the record came from disk');
    for (const [p, f] of [['/api/exchange-props', 'closed'], ['/api/exchange-size', 'closed'], ['/api/esports/inplay', 'closed'], ['/api/props/promos/record', 'closed'], ['/api/xarbs', 'bidClosed']]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.body[f]?.final, true, `${p} says closed`);
    }
    const promo = await get('/api/props/promos/record');
    assert.equal(promo.body.recording, false, 'the promo recorder is off');
    const st = await get('/api/status');
    for (const k of ['exchangeSize', 'kalshiMaker', 'exchangeProps']) {
      assert.equal(st.body[k].on, false, `${k} reads as off`);
      assert.equal(st.body[k].closed?.final, true);
    }
    // a still-open lane carries no closed line
    const shop = await get('/api/exchange-value').catch(() => null);
    if (shop?.status === 200) assert.equal(shop.body.closed, undefined);
  } finally {
    server.close();
    for (const task of cron.getTasks().values()) task.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 50).unref();
  }
});
