const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createBackup, keyFromEnv, keysFromEnv, keyIdOf, sourcesFromEnv } = require('../backup');
const { createMemoryStore } = require('../evtrack');

const key = crypto.randomBytes(32);
const quiet = { log() {}, warn() {} };

// a backup whose "GitHub" is one in-memory file
function setup({ file = null, k = key, fetchJson } = {}) {
  const remote = { file };
  const b = createBackup({ key: k, sources: ['mem://x'], fetchJson: fetchJson || (async () => remote.file), log: quiet, bootRetryMs: 5 });
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

test('no backup yet: start fresh and export', async () => {
  const none = setup();
  await none.b.wrap('tail', createMemoryStore()).init();
  assert.equal(none.b.status().note, 'no backup yet');
  assert.equal((await none.b.exportSnapshot()).v, 1);
});

// a snapshot sealed with `k` holding one tail record
async function snapshotWith(k, rows = [{ id: 'a', status: 'settled' }]) {
  const src = setup({ k });
  const st = src.b.wrap('tail', createMemoryStore());
  await st.init();
  for (const r of rows) await st.put(r);
  return src.b.exportSnapshot();
}

test('a snapshot sealed with a key this server cannot make pauses exports, never overwrites', async () => {
  const snap = await snapshotWith(crypto.randomBytes(32));
  const mine = setup({ file: snap });
  const s = mine.b.wrap('tail', createMemoryStore());
  await s.init();
  assert.equal(mine.b.status().state, 'retrying');
  assert.match(mine.b.status().note, /another key.*RESULTS_BACKUP_OLD_KEYS/);
  await assert.rejects(mine.b.exportSnapshot(), e => e.status === 503);
});

test('a damaged snapshot under the right key pauses exports too', async () => {
  const snap = await snapshotWith(key);
  const bad = { ...snap, tag: crypto.randomBytes(16).toString('base64') };
  const mine = setup({ file: bad });
  await mine.b.wrap('tail', createMemoryStore()).init();
  assert.equal(mine.b.status().state, 'retrying');
  assert.match(mine.b.status().note, /can't be opened/);
  await assert.rejects(mine.b.exportSnapshot(), e => e.status === 503);
});

test('RESULTS_BACKUP_KEY set later: read with the Railway-id key, seal the next with the new one', async () => {
  const ids = { RAILWAY_PROJECT_ID: 'p', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' };
  const before = keysFromEnv(ids);
  assert.equal(before.length, 1);
  const snap = await snapshotWith(before[0]);
  const after = keysFromEnv({ ...ids, RESULTS_BACKUP_KEY: 'new secret' });
  assert.equal(after.length, 2);
  assert.ok(after[1].equals(before[0]), 'the ids key is still made, second');
  const remote = { file: snap };
  const b = createBackup({ keys: after, sources: ['mem://x'], fetchJson: async () => remote.file, log: quiet, bootRetryMs: 5 });
  const s = b.wrap('tail', createMemoryStore());
  await s.init();
  assert.equal(b.status().state, 'ready');
  assert.equal(b.status().readWith, 'older');
  assert.equal((await s.all()).length, 1, 'the record came back');
  const next = await b.exportSnapshot();
  assert.equal(next.keyId, keyIdOf(after[0]), 'sealed with the new key');
  assert.deepEqual(next.counts, { tail: 1 });
});

test('new Railway ids: RESULTS_BACKUP_OLD_KEYS opens the old snapshot', async () => {
  const old = { RAILWAY_PROJECT_ID: 'p', RAILWAY_SERVICE_ID: 's', RAILWAY_ENVIRONMENT_ID: 'e' };
  const snap = await snapshotWith(keysFromEnv(old)[0]);
  const moved = { RAILWAY_PROJECT_ID: 'p2', RAILWAY_SERVICE_ID: 's2', RAILWAY_ENVIRONMENT_ID: 'e2' };
  const lost = createBackup({ keys: keysFromEnv(moved), sources: ['mem://x'], fetchJson: async () => snap, log: quiet, bootRetryMs: 5 });
  await lost.wrap('tail', createMemoryStore()).init();
  assert.equal(lost.status().state, 'retrying', 'without the old secret: paused, not empty');
  const found = createBackup({ keys: keysFromEnv({ ...moved, RESULTS_BACKUP_OLD_KEYS: ' other , p|s|e ' }), sources: ['mem://x'], fetchJson: async () => snap, log: quiet, bootRetryMs: 5 });
  const s = found.wrap('tail', createMemoryStore());
  await s.init();
  assert.equal(found.status().state, 'ready');
  assert.equal((await s.all()).length, 1);
});

test('an export with under half the records read at boot is refused', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}` }));
  const snap = await snapshotWith(key, rows);
  const mine = setup({ file: snap });
  const inner = createMemoryStore();
  const s = mine.b.wrap('tail', inner);
  await s.init();
  assert.equal((await s.all()).length, 300);
  assert.deepEqual((await mine.b.exportSnapshot()).counts, { tail: 300 });
  // the records vanish from under the backup (a store that failed to load)
  const two = setup({ file: snap });
  const empty = createMemoryStore();
  const w = two.b.wrap('tail', { ...empty, init: async () => {}, all: async () => [] });
  await w.init();
  await assert.rejects(two.b.exportSnapshot(), e => e.status === 503 && /300 read at boot/.test(e.message));
  assert.match(two.b.status().refused, /export refused/);
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
  const b = createBackup({ key: null, fetchJson: async () => { throw new Error('never'); }, log: quiet, bootRetryMs: 5 });
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
  await store.flush();   // writes are coalesced (jsonstore.js)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 3);
});

test('the async envelope matches the sync one both ways', async () => {
  const { sealAsync, openAsync, seal, open, payloadChunks } = require('../backup');
  const key = require('crypto').randomBytes(32);
  const payload = { stores: { a: [{ id: 1, s: 'x"y' }, { id: 2, n: null }], b: [], c: Array.from({ length: 1000 }, (_, i) => ({ id: i, v: i / 3 })) } };
  assert.equal([...payloadChunks(payload)].join(''), JSON.stringify(payload));
  assert.deepEqual(open(key, await sealAsync(key, payload)), payload);
  assert.deepEqual(await openAsync(key, seal(key, payload)), payload);
});
