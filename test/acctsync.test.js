// Account sync merge rules (acctsync.js) and the server's per-user store
// (syncstore.js): two devices, one account, nothing lost and nothing doubled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../acctsync');
const { syncConfig, createSync, createMemorySyncStore, createFileSyncStore } = require('../syncstore');

const bet = (id, extra = {}) => ({ id, pick: `Pick ${id}`, odds: 1.91, stake: 10, result: 'open', ...extra });
const J = x => JSON.stringify(x);
const NOW = Date.parse('2026-10-25T06:00:00Z');

// a tiny device: its localStorage, its base, and a sync against a server doc
function device(local = {}) {
  return { local: { ...local }, base: {}, resolved: {} };
}
function syncOnce(dev, doc) {
  const r = S.merge({ local: dev.local, server: doc, base: dev.base, resolved: dev.resolved, now: NOW });
  const next = Object.keys(r.push).length || Object.keys(r.tomb).length ? S.applyUpload(doc, { keys: r.push, tomb: r.tomb }, NOW) : doc;
  for (const [k, v] of Object.entries(r.apply)) { if (v == null) delete dev.local[k]; else dev.local[k] = v; }
  dev.base = r.base;
  dev.resolved = {};
  return { doc: next, r };
}
const empty = () => ({ rev: 0, keys: {}, tomb: {} });
const ids = s => JSON.parse(s).map(b => b.id).sort();

test('first sign-in: the account gets everything this browser has', () => {
  const a = device({ lr_bets: J([bet('a1'), bet('a2')]), lr_layout: J({ order: ['odds'] }) });
  const { doc, r } = syncOnce(a, empty());
  assert.deepEqual(ids(doc.keys.lr_bets.v), ['a1', 'a2']);
  assert.equal(doc.keys.lr_layout.v, a.local.lr_layout);
  assert.deepEqual(r.apply, {}, 'nothing to write back to the browser');
  assert.deepEqual(r.conflicts, []);
  assert.equal(doc.rev, 1);
});

test('a second device signing in: bets are unioned, not replaced', () => {
  const a = device({ lr_bets: J([bet('a1')]) });
  let { doc } = syncOnce(a, empty());
  const b = device({ lr_bets: J([bet('b1')]) });
  ({ doc } = syncOnce(b, doc));
  assert.deepEqual(ids(b.local.lr_bets), ['a1', 'b1']);
  assert.deepEqual(ids(doc.keys.lr_bets.v), ['a1', 'b1']);
  // device A picks up B's bet on its next sync
  ({ doc } = syncOnce(a, doc));
  assert.deepEqual(ids(a.local.lr_bets), ['a1', 'b1']);
});

test('a bet deleted on one device goes from the other, and does not come back', () => {
  const a = device({ lr_bets: J([bet('x'), bet('y')]) });
  let { doc } = syncOnce(a, empty());
  const b = device({});
  ({ doc } = syncOnce(b, doc));
  // A deletes x
  a.local.lr_bets = J([bet('y')]);
  ({ doc } = syncOnce(a, doc));
  assert.deepEqual(ids(doc.keys.lr_bets.v), ['y']);
  assert.ok(doc.tomb.lr_bets.x, 'tombstone kept');
  // B still has x untouched: it drops it
  ({ doc } = syncOnce(b, doc));
  assert.deepEqual(ids(b.local.lr_bets), ['y']);
  // and syncing again changes nothing
  const again = syncOnce(b, doc);
  assert.deepEqual(again.r.push, {});
  assert.deepEqual(again.r.apply, {});
});

test('an edited bet: the side that changed wins; both changed, this device wins', () => {
  const a = device({ lr_bets: J([bet('z')]) });
  let { doc } = syncOnce(a, empty());
  const b = device({});
  ({ doc } = syncOnce(b, doc));
  // B settles it as a win
  b.local.lr_bets = J([bet('z', { result: 'win' })]);
  ({ doc } = syncOnce(b, doc));
  ({ doc } = syncOnce(a, doc));
  assert.equal(JSON.parse(a.local.lr_bets)[0].result, 'win', 'A took the settled copy');
  // both edit offline: each keeps its own when it syncs first
  a.local.lr_bets = J([bet('z', { result: 'loss' })]);
  b.local.lr_bets = J([bet('z', { result: 'push' })]);
  ({ doc } = syncOnce(a, doc));
  assert.equal(JSON.parse(doc.keys.lr_bets.v)[0].result, 'loss');
  ({ doc } = syncOnce(b, doc));
  assert.equal(JSON.parse(b.local.lr_bets)[0].result, 'push', 'B keeps its own edit');
});

test('settings: one side changed wins; both changed is a conflict that keeps the local copy until resolved', () => {
  const a = device({ lr_layout: J({ order: ['odds', 'props'] }) });
  let { doc } = syncOnce(a, empty());
  // B has its own layout already: a conflict, nothing sent, B keeps its own
  const b = device({ lr_layout: J({ order: ['props'] }) });
  let res = syncOnce(b, doc);
  assert.deepEqual(res.r.conflicts, ['lr_layout']);
  assert.equal(b.local.lr_layout, J({ order: ['props'] }));
  assert.equal(res.doc.keys.lr_layout.v, J({ order: ['odds', 'props'] }), 'account untouched');
  // still a conflict on the next sync
  res = syncOnce(b, res.doc);
  assert.deepEqual(res.r.conflicts, ['lr_layout']);
  // USE ACCOUNT
  b.resolved = { lr_layout: 'account' };
  res = syncOnce(b, res.doc);
  assert.equal(b.local.lr_layout, J({ order: ['odds', 'props'] }));
  assert.deepEqual(res.r.conflicts, []);
  doc = res.doc;
  // now B changes it: it goes up, and A (unchanged since) takes it
  b.local.lr_layout = J({ order: ['tools'] });
  ({ doc } = syncOnce(b, doc));
  ({ doc } = syncOnce(a, doc));
  assert.equal(a.local.lr_layout, J({ order: ['tools'] }));
  // KEEP THIS DEVICE
  const c = device({ lr_layout: J({ order: ['mine'] }) });
  res = syncOnce(c, doc);
  assert.deepEqual(res.r.conflicts, ['lr_layout']);
  c.resolved = { lr_layout: 'local' };
  res = syncOnce(c, res.doc);
  assert.equal(res.doc.keys.lr_layout.v, J({ order: ['mine'] }));
});

test('a setting removed on this device is removed from the account; slip grades are unioned', () => {
  const a = device({ lr_unit_usd: '25', lr_slip_grades: J({ l1: { status: 'final' } }) });
  let { doc } = syncOnce(a, empty());
  const b = device({ lr_slip_grades: J({ l2: { status: 'final' } }) });
  ({ doc } = syncOnce(b, doc));
  assert.deepEqual(Object.keys(JSON.parse(doc.keys.lr_slip_grades.v)).sort(), ['l1', 'l2']);
  delete a.local.lr_unit_usd;
  ({ doc } = syncOnce(a, doc));
  assert.equal(doc.keys.lr_unit_usd.v, null);
  ({ doc } = syncOnce(b, doc));
  assert.equal(b.local.lr_unit_usd, undefined);
});

test('keys outside the list never sync, and uploads are checked', () => {
  const r = S.merge({ local: { lr_token: 'secret', lr_tab: 'odds', lr_bets: J([bet('a')]) }, server: empty(), base: {}, now: NOW });
  assert.deepEqual(Object.keys(r.push), ['lr_bets']);
  assert.equal(S.validateUpload({ lr_token: 'x' }).ok, false);
  assert.equal(S.validateUpload({ lr_bets: 'not json' }).ok, false);
  assert.equal(S.validateUpload({ lr_bets: J({}) }).ok, false);
  assert.equal(S.validateUpload({ lr_unit_usd: 'x'.repeat(51) }).ok, false);
  assert.equal(S.validateUpload({ lr_bets: J([bet('a')]), lr_layout: null }).ok, true);
  assert.equal(S.validateUpload({}, { lr_layout: { a: 'x' } }).ok, false);
});

test('rows without an id stay on this device as they are', () => {
  const r = S.merge({ local: { lr_bets: J([{ pick: 'old' }, bet('a')]) }, server: { keys: { lr_bets: { v: J([bet('b')]) } } }, base: {}, now: NOW });
  const rows = JSON.parse(r.apply.lr_bets);
  assert.equal(rows.length, 3);
  assert.ok(rows.some(x => x.pick === 'old'));
});

test('sync config: off without AUTH_SECRET, off on Railway without Postgres, file locally', () => {
  assert.equal(syncConfig({}).enabled, false);
  assert.match(syncConfig({}).reason, /AUTH_SECRET/);
  assert.equal(syncConfig({ AUTH_SECRET: 'x', RAILWAY_ENVIRONMENT: 'production' }).enabled, false);
  assert.match(syncConfig({ AUTH_SECRET: 'x', RAILWAY_ENVIRONMENT: 'production' }).reason, /DATABASE_URL/);
  assert.deepEqual(syncConfig({ AUTH_SECRET: 'x', RAILWAY_ENVIRONMENT: 'production', DATABASE_URL: 'postgres://x' }), { enabled: true, reason: null, store: 'postgres' });
  assert.equal(syncConfig({ AUTH_SECRET: 'x' }).store, 'file');
  assert.equal(syncConfig({ AUTH_SECRET: 'x', LR_SYNC: 'off' }).enabled, false);
});

test('server store: revision check, per-user privacy, size cap, rate limit, delete', async () => {
  const sync = createSync({ store: createMemorySyncStore(), maxPuts: 5 });
  assert.deepEqual(await sync.get('u1'), { rev: 0, keys: {}, tomb: {}, updatedAt: null });
  const one = await sync.put('u1', { rev: 0, keys: { lr_unit_usd: '25' } });
  assert.equal(one.rev, 1);
  await assert.rejects(sync.put('u1', { rev: 0, keys: { lr_unit_usd: '30' } }), e => e.status === 409 && e.current.rev === 1);
  assert.deepEqual((await sync.get('u2')).keys, {}, 'another user sees nothing of u1');
  await assert.rejects(sync.put('u1', { rev: 1, keys: { lr_token: 'x' } }), e => e.status === 400);
  // two uploads at once on the same revision: one wins, one gets 409
  const both = await Promise.allSettled([sync.put('u1', { rev: 1, keys: { lr_unit_usd: '1' } }), sync.put('u1', { rev: 1, keys: { lr_unit_usd: '2' } })]);
  assert.equal(both.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(sync.put('u1', { rev: 2, keys: {} }), e => e.status === 429);
  await sync.remove('u1');
  assert.equal((await sync.get('u1')).rev, 0);

  const big = createSync({ store: createMemorySyncStore() });
  const huge = J(Array.from({ length: 3 }, (_, i) => bet(`h${i}`, { note: 'x'.repeat(999000) })));
  await big.put('u', { rev: 0, keys: { lr_bets: huge } });
  await big.put('u', { rev: 1, keys: { lr_slips: huge } });
  await big.put('u', { rev: 2, keys: { lr_pikkit: 'x'.repeat(1500000) } });
  await assert.rejects(big.put('u', { rev: 3, keys: { lr_slip_grades: J({ a: 'x'.repeat(1500000) }) } }), e => e.status === 413);
});

test('file store keeps documents across a restart and forgets a deleted one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sync-'));
  const file = path.join(dir, 'user-sync.json');
  try {
    const st = createFileSyncStore(file);
    const sync = createSync({ store: st });
    await sync.put('u1', { rev: 0, keys: { lr_bets: J([bet('a')]) } });
    await sync.put('u2', { rev: 0, keys: { lr_unit_usd: '5' } });
    await st.flush();
    const again = createSync({ store: createFileSyncStore(file) });
    assert.deepEqual(ids((await again.get('u1')).keys.lr_bets.v), ['a']);
    await sync.remove('u1');
    await st.flush();
    const third = createSync({ store: createFileSyncStore(file) });
    assert.equal((await third.get('u1')).rev, 0);
    assert.equal((await third.get('u2')).keys.lr_unit_usd.v, '5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
