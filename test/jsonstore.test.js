const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createJsonFileStore, flushAll } = require('../jsonstore');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-js-')), 'rows.json');

test('many puts in a row become one write', async () => {
  const file = tmpFile();
  const s = createJsonFileStore(file, { delayMs: 20 });
  await s.init();
  for (let i = 0; i < 200; i++) await s.put({ id: i, v: i });
  assert.equal(fs.existsSync(file), false, 'nothing written while puts are still coming');
  assert.equal((await s.all()).length, 200, 'memory has every row at once');
  await s.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.length, 200);
  assert.deepEqual(saved[199], { id: 199, v: 199 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a put during a write lands in the next write; reload sees the latest copy', async () => {
  const file = tmpFile();
  const s = createJsonFileStore(file, { delayMs: 0, chunkRows: 2 });
  await s.putMany([{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 1 }]);
  await new Promise(r => setTimeout(r, 0));   // the write has started
  await s.put({ id: 'a', n: 2 });
  await s.flush();
  const t = createJsonFileStore(file);
  await t.init();
  assert.deepEqual((await t.all()).find(r => r.id === 'a'), { id: 'a', n: 2 });
  assert.equal((await t.all()).length, 3);
});

test('custom key; chunked output is the same JSON as one stringify', async () => {
  const file = tmpFile();
  const s = createJsonFileStore(file, { delayMs: 0, chunkRows: 3, key: r => r.wallet });
  const rows = Array.from({ length: 10 }, (_, i) => ({ wallet: `w${i}`, s: `q"${i}\n` }));
  await s.putMany(rows);
  await s.put({ wallet: 'w0', s: 'new' });
  await flushAll();
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify([{ wallet: 'w0', s: 'new' }, ...rows.slice(1)]));
});

test('a missing or broken file starts empty; flushSync writes what is pending', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const warn = console.warn; console.warn = () => {};
  const s = createJsonFileStore(file, { delayMs: 60e3 });
  await s.init();
  console.warn = warn;
  assert.equal((await s.all()).length, 0);
  await s.put({ id: 1 });
  assert.equal(s.pending(), true);
  s.flushSync();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 1 }]);
  assert.equal(s.pending(), false);
});

test('storeStats names the files that write most', async () => {
  const file = tmpFile();
  const s = createJsonFileStore(file, { delayMs: 5 });
  await s.init();
  for (let i = 0; i < 50; i++) await s.put({ id: i, v: 'x'.repeat(100) });
  await s.flush();
  const { storeStats } = require('../jsonstore');
  const st = storeStats();
  const row = st.files.find(f => f.file === 'rows.json');
  assert.ok(row && row.writes >= 1 && row.rows === 50, JSON.stringify(st.files));
  assert.ok(typeof st.delayMs === 'number');
});

test('stores people write to keep a short write delay; bulk stores take the default', () => {
  const { createStoreFromEnv } = require('../evtrack');
  const { DEFAULT_DELAY_MS, USER_DELAY_MS } = require('../jsonstore');
  const f = tmpFile();
  const user = createStoreFromEnv({ X_FILE: f }, { fileVar: 'X_FILE', user: true });
  const bulk = createStoreFromEnv({ X_FILE: f }, { fileVar: 'X_FILE' });
  assert.equal(user.delayMs, USER_DELAY_MS);
  assert.equal(bulk.delayMs, DEFAULT_DELAY_MS);
  assert.ok(USER_DELAY_MS <= 5000);
  // the records people publish and the bets they log are user stores
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const file of ['pub-records.json', 'line-bets.json', 'es-bets.json', 'slip-late.json', 'api-keys.json', 'push-subs.json', 'alert-log.json']) {
    assert.match(src, new RegExp(`file: '${file.replace('.', '\\.')}', user: true`), file);
  }
});
