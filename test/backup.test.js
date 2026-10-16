const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createBackup, keyFromEnv, sourcesFromEnv } = require('../backup');
const { createMemoryStore } = require('../evtrack');

const key = crypto.randomBytes(32);
const quiet = { log() {}, warn() {} };

// a backup whose "GitHub" is one in-memory file
function setup({ file = null, k = key, fetchJson } = {}) {
  const remote = { file };
  const b = createBackup({ key: k, sources: ['mem://x'], fetchJson: fetchJson || (async () => remote.file), log: quiet });
  return { b, remote };
}

test('export → restore round trip adds only missing records', async () => {
  const one = setup();
  const tail = one.b.wrap('tail', createMemoryStore());
  const traders = one.b.wrap('tailTraders', createMemoryStore(), { appendOnly: false });
  await tail.init(); await traders.init();
  await tail.put({ id: 'a', status: 'open' });
  await tail.put({ id: 'b', status: 'settled', profit: 1.2 });
  await traders.put({ id: '0xw', wallet: '0xw', grade: 'A' });
  const snap = await one.b.exportSnapshot();
  assert.deepEqual(snap.counts, { tail: 2 });
  assert.deepEqual(snap.other, { tailTraders: 1 });
  assert.ok(!JSON.stringify(snap).includes('settled'), 'records are encrypted');

  const two = setup({ file: JSON.parse(JSON.stringify(snap)) });
  const inner = createMemoryStore();
  await inner.put({ id: 'a', status: 'settled', profit: -1 });   // newer local copy wins
  const tail2 = two.b.wrap('tail', inner);
  await tail2.init();
  const rows = Object.fromEntries((await tail2.all()).map(r => [r.id, r]));
  assert.equal(rows.a.status, 'settled');
  assert.equal(rows.b.profit, 1.2);
  assert.deepEqual(two.b.status().restored, { tail: 1 });
  assert.equal(two.b.status().state, 'ready');
});

test('no backup yet, or another key: start fresh and export', async () => {
  const none = setup();
  await none.b.wrap('tail', createMemoryStore()).init();
  assert.equal(none.b.status().note, 'no backup yet');
  assert.equal((await none.b.exportSnapshot()).v, 1);

  const other = setup({ k: crypto.randomBytes(32) });
  await other.b.wrap('tail', createMemoryStore()).init();
  const snap = await other.b.exportSnapshot();
  const mine = setup({ file: snap });
  const s = mine.b.wrap('tail', createMemoryStore());
  await s.init();
  assert.match(mine.b.status().note, /another key/);
  assert.equal((await mine.b.exportSnapshot()).v, 1);
});

test('an unreadable backup source pauses exports instead of overwriting', async () => {
  const { b } = setup({ fetchJson: async () => { throw new Error('rate limited'); } });
  const s = b.wrap('tail', createMemoryStore());
  await s.init();
  assert.equal(b.status().state, 'retrying');
  await assert.rejects(b.exportSnapshot(), e => e.status === 503);
});

test('off without a key; Railway ids make one; repo from Railway vars', async () => {
  assert.equal(keyFromEnv({}), null);
  assert.equal(keyFromEnv({ RAILWAY_PROJECT_ID: 'p', RAILWAY_SERVICE_ID: 's' }).length, 32);
  const b = createBackup({ key: null, fetchJson: async () => { throw new Error('never'); }, log: quiet });
  const s = b.wrap('tail', createMemoryStore());
  await s.init();
  await s.put({ id: 'x' });
  assert.equal((await s.all()).length, 1);
  await assert.rejects(b.exportSnapshot(), e => e.status === 404);
  assert.match(sourcesFromEnv({ RAILWAY_GIT_REPO_OWNER: 'o', RAILWAY_GIT_REPO_NAME: 'r' })[0], /repos\/o\/r\/contents\/results\.json\?ref=results-data/);
});

test('file stores restore in one write', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { createFileStore } = require('../evtrack');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')), 'x.json');
  const store = createFileStore(file);
  await store.init();
  await store.putMany([{ id: 1 }, { id: 2 }]);
  await store.put({ id: 3 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 3);
});
