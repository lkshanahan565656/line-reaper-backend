// Public bettor records (pubrecord.js): handles and keys, slips stamped when
// they reach us (LATE when a game started first), results from our graders
// only, and the RESULTS rule per app. TEST DATA: every slip and grade below is
// made up here to exercise the rules; none is anyone's record.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pubrecord');

const memStore = () => { const m = new Map(); return { m, async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, JSON.parse(JSON.stringify(d))); } }; };
const T0 = Date.parse('2026-10-20T12:00:00Z');
function setup() {
  let t = T0;
  const store = memStore();
  const rs = P.createRecordStore({ store, now: () => t, random: n => Buffer.alloc(n, 7) });
  return { rs, store, clock: { set: x => { t = x; }, get: () => t } };
}
const leg = (player, line = 20.5, side = 'Over') => ({ player, market: 'Points', side, line, sport: 'NBA' });
const slip = (id, legs, extra = {}) => ({ id, app: 'prizepicks', legs, placedAt: new Date(T0).toISOString(), source: 'paste', stake: 50, payout: 300, ...extra });
// a graded leg view, as the slip graders answer
const view = (start, { outcome = 'win', fair = 0.6, ev = 5, exact = true, ok = true, status = 'graded' } = {}) => ({
  status, final: status === 'graded', matched: { sport: 'NBA', player: 'X', market: 'Points', start: new Date(start).toISOString(), matchTitle: 'A @ B' },
  decimal: 1.7787, raw: { source: 'pinnacle', fair, ev, line: 20.5, exact, ok }, outcome: status === 'graded' ? outcome : null, result: 25, gradeSource: 'ESPN box score' });

test('handles: 3 to 20 letters, digits or _, lowercased, some reserved', () => {
  assert.equal(P.cleanHandle('@Logan_77').handle, 'logan_77');
  assert.ok(P.cleanHandle('ab').error);
  assert.ok(P.cleanHandle('bad handle').error);
  assert.ok(P.cleanHandle('admin').error);
  assert.ok(P.cleanHandle('linereaper_picks').error);
});

test('publish hands out a key once and keeps only its hash; a taken handle needs that key', async () => {
  const { rs, store } = setup();
  const a = await rs.publish({ handle: 'Sharp_one', who: 'x' });
  assert.equal(a.handle, 'sharp_one');
  assert.match(a.token, /^lrr_/);
  const doc = store.m.get('rec|sharp_one');
  assert.ok(doc.ownerHash && !JSON.stringify(doc).includes(a.token), 'the key itself is never stored');
  await assert.rejects(rs.publish({ handle: 'sharp_one', who: 'y' }), e => e.status === 409);
  const again = await rs.publish({ handle: 'sharp_one', token: a.token });
  assert.equal(again.already, true);
  // three new records an hour from one address
  await rs.publish({ handle: 'aaa', who: 'z' }); await rs.publish({ handle: 'bbb', who: 'z' }); await rs.publish({ handle: 'ccc', who: 'z' });
  await assert.rejects(rs.publish({ handle: 'ddd', who: 'z' }), e => e.status === 429);
});

test('slips are stamped when they reach us, keep no money, and can\'t be replaced', async () => {
  const { rs, store, clock } = setup();
  const { token } = await rs.publish({ handle: 'tester', who: 'a' });
  await assert.rejects(rs.addSlips('tester', 'lrr_wrongwrongwrongwrongwrong', [slip('s1', [leg('A B')])]), e => e.status === 403);
  const r = await rs.addSlips('tester', token, [slip('s1', [leg('A B'), leg('C D')]), { id: 'bad', legs: [] }]);
  assert.deepEqual([r.added, r.bad], [1, 1]);
  const d = store.m.get('slip|tester|s1');
  assert.equal(d.receivedAt, new Date(T0).toISOString());
  assert.ok(!('stake' in d.slip) && !('payout' in d.slip), 'no stake or payout is kept');
  clock.set(T0 + 3600e3);
  const r2 = await rs.addSlips('tester', token, [slip('s1', [leg('Other Guy')])]);
  assert.equal(r2.skipped, 1);
  assert.equal(store.m.get('slip|tester|s1').slip.legs[0].player, 'A B', 'a slip id already in is left alone');
  assert.equal(store.m.get('slip|tester|s1').receivedAt, new Date(T0).toISOString(), 'its arrival time never moves');
});

test('a slip whose first game started before it reached us is LATE and not counted', async () => {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'timing', who: 'a' });
  await rs.addSlips('timing', token, [slip('early', [leg('A B'), leg('C D')]), slip('late', [leg('E F'), leg('G H')], { placedAt: new Date(T0 - 86400e3).toISOString(), source: 'pikkit' })]);
  const legs = rs.pendingLegs('timing');
  assert.equal(legs.length, 4);
  const res = {};
  for (const l of legs) res[l.id] = view(/E F|G H/i.test(l.player) ? T0 - 3600e3 : T0 + 7200e3);
  await rs.applyGrades('timing', res);
  const v = P.recordView(rs.get('timing'), rs.slipsOf('timing'), { now: T0 + 86400e3 });
  assert.deepEqual([v.counts.onTime, v.counts.late], [1, 1]);
  assert.equal(v.slips.find(s => s.id === 'late').timing, 'late');
  assert.equal(v.slips.find(s => s.id === 'late').counted, false);
  assert.equal(v.pooled.slips, 1, 'only the on-time slip is in the record');
  assert.equal(v.late.slips, 1);
});

test('results come from the legs, never the bettor\'s mark; units at the app\'s table', async () => {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'units', who: 'a' });
  // the browser says it won 10x; the legs say one miss
  await rs.addSlips('units', token, [slip('s', [leg('A B'), leg('C D')], { result: 'win', mult: 10 })]);
  const res = {};
  rs.pendingLegs('units').forEach((l, i) => { res[l.id] = view(T0 + 7200e3, { outcome: i ? 'loss' : 'win' }); });
  await rs.applyGrades('units', res);
  const v = P.recordView(rs.get('units'), rs.slipsOf('units'));
  assert.equal(v.slips[0].result, 'loss');
  assert.equal(v.pooled.units, -1);
  // two hits: PrizePicks 2-pick power pays 3x
  const { rs: rs2 } = setup();
  const k2 = (await rs2.publish({ handle: 'units2', who: 'a' })).token;
  await rs2.addSlips('units2', k2, [slip('s', [leg('A B'), leg('C D')], { mult: 50 })]);
  const res2 = {};
  for (const l of rs2.pendingLegs('units2')) res2[l.id] = view(T0 + 7200e3);
  await rs2.applyGrades('units2', res2);
  assert.equal(P.recordView(rs2.get('units2'), rs2.slipsOf('units2')).pooled.units, 2, 'the typed 50x payout is ignored');
});

// n legs of one app graded vs Pinnacle, CLV per leg, outcome by fair
async function bigRecord(n, { ev = () => 4, win = () => true, app = 'prizepicks', exact = true } = {}) {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'big', who: 'a' });
  const slips = [];
  for (let i = 0; i < n; i++) slips.push(slip(`s${i}`, [leg(`Player ${i}`, 10.5 + i)], { app }));
  for (let i = 0; i < slips.length; i += 400) await rs.addSlips('big', token, slips.slice(i, i + 400));
  const res = {};
  rs.pendingLegs('big').forEach((l, i) => { res[l.id] = view(T0 + 7200e3, { ev: ev(i), outcome: win(i) ? 'win' : 'loss', exact }); });
  await rs.applyGrades('big', res);
  return P.recordView(rs.get('big'), rs.slipsOf('big'), { perPage: 10 });
}

test('the RESULTS rule: 50 legs at one app vs Pinnacle, CLV t of 2, never pooled', async () => {
  const short = await bigRecord(30, { ev: i => (i % 2 ? 6 : 2) });
  assert.equal(short.apps[0].label, 'building');
  assert.match(short.apps[0].why, /30 of 50/);

  const proven = await bigRecord(60, { ev: i => (i % 2 ? 6 : 2), win: i => i % 5 !== 0 });
  assert.equal(proven.apps[0].label, 'proven');
  assert.deepEqual(proven.proven, ['PrizePicks']);
  assert.equal(proven.pooled.label, 'pooled, never proven');
  assert.equal(proven.pooled.profitShown, false);
  assert.equal(proven.slips.length, 10, 'paged');

  const noisy = await bigRecord(60, { ev: i => (i % 2 ? 30 : -26) });
  assert.equal(noisy.apps[0].label, 'building');
  assert.match(noisy.apps[0].why, /CLV t/);

  const losing = await bigRecord(60, { ev: () => -3 });
  assert.equal(losing.apps[0].label, 'losing to the close');

  // beating the close but the results far under what the close expected (fair 0.6, 20% hit)
  const short2 = await bigRecord(60, { ev: i => (i % 2 ? 6 : 2), win: i => i % 5 === 0 });
  assert.equal(short2.apps[0].label, 'building');
  assert.match(short2.apps[0].why, /sd under/);

  // a Pinnacle close read along the curve from another line never counts
  const curve = await bigRecord(60, { exact: false });
  assert.equal(curve.apps[0].pinN, 0);
  assert.equal(curve.apps[0].label, 'not graded yet');
});

test('unpublish empties every slip and frees nothing to anyone else; republish says it restarted', async () => {
  const { rs, store } = setup();
  const { token } = await rs.publish({ handle: 'gone', who: 'a' });
  await rs.addSlips('gone', token, [slip('s1', [leg('A B')])]);
  await assert.rejects(rs.unpublish('gone', 'lrr_nopenopenopenopenopenope'), e => e.status === 403);
  await rs.unpublish('gone', token);
  assert.equal(store.m.get('slip|gone|s1').status, 'removed');
  assert.ok(!store.m.get('slip|gone|s1').slip.legs, 'the legs are wiped');
  assert.equal(rs.slipsOf('gone').length, 0);
  await assert.rejects(rs.publish({ handle: 'gone', who: 'b' }), e => e.status === 409);
  await rs.publish({ handle: 'gone', token });
  const v = P.recordView(rs.get('gone'), rs.slipsOf('gone'));
  assert.equal(v.restarts.length, 1);
  assert.match(P.pageHtml(v), /Restarted 1 time/);
});

test('the store reloads from its docs (a deploy with the results backup)', async () => {
  const { rs, store } = setup();
  const { token } = await rs.publish({ handle: 'again', who: 'a' });
  await rs.addSlips('again', token, [slip('s1', [leg('A B')])]);
  const rs2 = P.createRecordStore({ store });
  await rs2.init();
  assert.equal(rs2.slipsOf('again').length, 1);
  assert.ok(rs2.owns('again', token));
});

test('page, CSV and an empty record say only what is there', async () => {
  const { rs } = setup();
  await rs.publish({ handle: 'empty', who: 'a' });
  const v = P.recordView(rs.get('empty'), []);
  const h = P.pageHtml(v, { image: 'https://x.example/card/record-empty.png', url: 'https://x.example/r/empty' });
  assert.match(h, /No slips yet/);
  assert.match(h, /not placed through Line Reaper/);
  assert.match(h, /og:image" content="https:\/\/x\.example\/card\/record-empty\.png/);
  assert.match(h, /nothing proven yet/);
  assert.ok(!/undefined|NaN|guaranteed|risk[- ]free|polymarket\.com/i.test(h));
  assert.ok(!/follow|copy this|tail this/i.test(h.replace(/no follow, copy or alert buttons/, '')), 'no follow or copy buttons');

  const big = await bigRecord(60, { ev: i => (i % 2 ? 6 : 2) });
  const csv = P.csv({ ...big, slips: big.slips });
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^slip_id,received_at_utc/);
  assert.equal(lines.length, 11);
  assert.match(lines[1], /,on time,yes,void,0,1,NBA,Player 9,/, 'a one-pick slip is refunded at the app');
  const ph = P.pageHtml(big);
  assert.ok(!/undefined|NaN/.test(ph));
  assert.match(ph, /proven at PrizePicks/);
});
