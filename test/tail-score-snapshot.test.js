// Sharp Tail scores on recorded wallets (10-25, Polymarket data API v2: three
// wallets' settled and open positions and trades, cut per status to keep the
// file small; see fixtures/tail-score-snapshot.json.gz). `expect` holds what
// scoreWallet gave before a wallet's rows were classified ahead of time in
// slices: the scores must be the same with and without that step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tail = require('../tail');

const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'tail-score-snapshot.json.gz'))));
const o = tail.resolveOptions({});
const plain = x => JSON.parse(JSON.stringify(x));   // as recorded (JSON)
const fresh = w => structuredClone(w);              // new row objects, as a fetch gives

test('snapshot: the recorded wallets are big and cover several categories', () => {
  assert.equal(fix.wallets.length, 3);
  assert.ok(fix.wallets.every(w => w.closed.length > 500 && w.trades.length > 100));
  assert.ok(Object.keys(fix.expect[2].score.categories).length >= 4);
});

test('snapshot: scoreWallet gives the recorded scores, with and without the rows classified in slices', async () => {
  for (const [i, rec] of fix.wallets.entries()) {
    for (const mode of ['inline', 'sliced']) {
      const w = fresh(rec);
      const cats = mode === 'sliced' ? await tail.classifyRows([...w.closed, ...w.open], { sliceMs: 1 }) : null;
      const score = tail.scoreWallet({ ...w, selectedAt: null, cats }, { ...o, now: fix.now });
      assert.deepStrictEqual(plain(score), fix.expect[i].score, `${mode} wallet ${i}`);
      const clv = [{ clv: 0.05, category: 'sports' }, { clv: -0.02, category: 'politics' }];
      const withClv = tail.scoreWallet({ ...w, selectedAt: fix.now - 30 * 86400e3, clv, play: { games: 3, inPlay: 1 }, cats }, { ...o, now: fix.now });
      assert.deepStrictEqual(plain(withClv), fix.expect[i].withClv, `${mode} wallet ${i} with clv`);
      const rp = tail.resolvedPositions(w.closed, w.open, fix.now, cats);
      assert.deepStrictEqual(plain(rp.resolved), fix.expect[i].resolved, `${mode} wallet ${i} resolved`);
      assert.equal(rp.stillOpen.length, fix.expect[i].stillOpen);
    }
  }
});

test('classifyRows: the same category as classify, and it hands the event loop back', async () => {
  const rows = fresh(fix.wallets[0]).closed;
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 0);
  const cats = await tail.classifyRows(rows, { sliceMs: 1 });
  clearInterval(iv);
  assert.ok(rows.every(r => cats.get(r) === tail.classify(r)));
  assert.ok(ticks > 0, 'timers ran in between');
});

test('classify: rows without tags read the same as before (no tags is "", not a thrown parse)', () => {
  const r = { title: 'Will the Lakers win on 2026-10-25?', slug: 'nba-lal-gsw-2026-10-25' };
  assert.equal(tail.classify(r), tail.classify({ ...r, tags: '[]' }));
  assert.equal(tail.classify({ ...r, tags: null }), tail.classify(r));
  assert.equal(tail.classify({ title: 'x', tags: '[{"label":"Crypto"}]' }), 'crypto');
});
