// The matcher on a recorded live list (10-25 01:42Z: Kalshi's open events and
// game series, Gamma's events, Polymarket US's leagues; see
// fixtures/xarb-match-snapshot.json.gz). The expected pairs were found by the
// matcher as it stood before it ran in slices; the sliced runs must find
// exactly the same ones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const xarb = require('../xarb');

const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'xarb-match-snapshot.json.gz'))));
const opts = { ...xarb.optsFromEnv({}), now: fix.now, games: [] };
const fp = ms => ms.map(m => ({ k: m.kalshi.id, p: m.polymarket.id, same: m.same, by: m.by, ...(m.similarity != null ? { similarity: m.similarity } : {}) }));

test('snapshot: the fixture has every kind of pair', () => {
  const by = new Set([...fix.expect.intl, ...fix.expect.us].map(m => m.by));
  for (const k of ['teams', 'teams3', 'line', 'race', 'title']) assert.ok(by.has(k), k);
  assert.ok(fix.expect.intl.length > 1000 && fix.expect.us.length > 500);
});

test('snapshot: matchMarkets finds the recorded pairs', () => {
  assert.deepStrictEqual(fp(xarb.matchMarkets(fix.kalshi, fix.polymarket, opts)), fix.expect.intl);
  assert.deepStrictEqual(fp(xarb.matchMarkets(fix.kalshi, fix.us, opts)), fix.expect.us);
});

test('snapshot: matchMarketsAsync finds the same pairs in the same order, a slice at a time', async () => {
  const stats = {};
  // 1 ms slices: hundreds of hand-backs, each a chance for state to leak between them
  const [intl, us] = await Promise.all([
    xarb.matchMarketsAsync(fix.kalshi, fix.polymarket, { ...opts, sliceMs: 1, stats }),
    xarb.matchMarketsAsync(fix.kalshi, fix.us, { ...opts, sliceMs: 1 }),
  ]);
  assert.deepStrictEqual(fp(intl), fix.expect.intl);
  assert.deepStrictEqual(fp(us), fix.expect.us);
  assert.ok(stats.slices > 1, `ran in ${stats.slices} slice(s)`);
  assert.ok(stats.ms >= 0 && stats.maxSliceMs >= 0);
});

test('snapshot: a sliced match lets timers run in between', async () => {
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 1);
  await xarb.matchMarketsAsync(fix.kalshi, fix.polymarket, { ...opts, sliceMs: 5 });
  clearInterval(iv);
  assert.ok(ticks > 0);
});

test('snapshot: no Polymarket yes/no market means no Kalshi title is read', () => {
  // the Polymarket US list is games only: its pass skips the title match outright
  assert.deepStrictEqual(xarb.matchMarkets(fix.kalshi.filter(r => r.kind === 'yesno'), [], opts), []);
});
