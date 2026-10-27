// Game-line bets on a public bettor record (pubrecord.js): a moneyline,
// spread or total from MY BETS, stamped when it reaches us, graded on
// Pinnacle's close at its own number (linebets.js) and the final, labelled one
// venue at a time on the same rule as slip legs. TEST DATA: every bet and
// grade below is made up here to exercise the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pubrecord');

const memStore = () => { const m = new Map(); return { m, async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, JSON.parse(JSON.stringify(d))); } }; };
const T0 = Date.parse('2026-10-20T12:00:00Z');
const START = '2026-10-20T23:00:00Z';
const bet = (id, o = {}) => ({ id, venue: 'kalshi', venueName: 'Kalshi', event: 'A @ B', pick: 'B ML', decimal: 2.0, stake: 100,
  track: { kind: 'line', game: `g${id}`, league: 'NBA', market: 'ml', side: 'B', point: null, start: START }, ...o });
const closed = (fair, outcome, o = {}) => ({ close: { status: 'closed', start: START, logFair: 0.5, fair, closeOk: true, outcome }, note: 'Pinnacle close', ...o });

test('a bet keeps the venue, pick, price and game reference, never the stake', () => {
  const b = P.cleanBet(bet('1'));
  assert.equal(b.decimal, 2); assert.equal(b.track.market, 'ml'); assert.equal(b.start, new Date(START).toISOString());
  assert.ok(!('stake' in b));
  assert.equal(P.cleanBet(bet('2', { decimal: 1 })), null, 'a price of 1.00 is not a bet');
  assert.equal(P.cleanBet(bet('3', { track: { kind: 'prop' } })), null, 'only game lines');
  assert.equal(P.cleanBet(bet('4', { track: { kind: 'line', game: 'g', market: 'spread', side: 'B' } })), null, 'a spread needs its number');
});

test('bets in: stamped on arrival, an id kept once, only with the key; unpublish removes them', async () => {
  let t = T0;
  const store = memStore();
  const rs = P.createRecordStore({ store, now: () => t, random: n => Buffer.alloc(n, 7) });
  const { token } = await rs.publish({ handle: 'liner', who: 'x' });
  await assert.rejects(rs.addBets('liner', 'lrr_wrongwrongwrongwrongwrong', [bet('1')]), e => e.status === 403);
  const out = await rs.addBets('liner', token, [bet('1'), bet('1'), { id: 'x' }]);
  assert.deepEqual([out.added, out.skipped, out.bad], [1, 1, 1]);
  assert.equal(rs.betsOf('liner')[0].receivedAt, new Date(T0).toISOString());
  assert.deepEqual(rs.pendingBets('liner').map(x => x.id), ['1']);
  assert.equal(await rs.applyBetGrades('liner', { 1: closed(0.55, 'win') }), 1);
  assert.equal(rs.pendingBets('liner').length, 0, 'a settled bet is not asked about again');
  assert.equal(rs.stats().bets, 1);
  await rs.unpublish('liner', token);
  assert.equal(rs.betsOf('liner').length, 0);
});

test('CLV on Pinnacle\'s close at the number; late bets shown, never counted; one venue at a time', () => {
  const doc = (id, grade, o = {}) => ({ id: `bet|h|${id}`, kind: 'bet', status: 'live', handle: 'h', bet: P.cleanBet(bet(id, o)), receivedAt: new Date(T0).toISOString(), grade: grade && P.slimBetGrade(grade) });
  const docs = [];
  // 50 on-time Kalshi bets at 2.0, Pinnacle closing the side at 55%: +10% CLV each, alternating results
  for (let i = 0; i < 50; i++) docs.push(doc(`k${i}`, closed(i % 5 ? 0.55 : 0.53, i % 2 ? 'win' : 'loss')));
  // a late one: its game started before it reached us
  docs.push({ ...doc('late', closed(0.7, 'win')), receivedAt: '2026-10-21T00:00:00Z' });
  // one where Pinnacle doesn't hang the number
  docs.push(doc('np', { close: { status: 'nopin' }, note: 'Pinnacle does not hang this number' }, { venue: 'pmus', venueName: 'Polymarket US' }));
  const v = P.betsView(docs);
  assert.deepEqual(v.counts, { bets: 52, onTime: 50, late: 1, checking: 1 });
  const k = v.venues.find(x => x.venue === 'kalshi');
  assert.equal(k.pinN, 50); assert.ok(k.clv > 9 && k.clv < 10.1);
  assert.equal(k.label, 'proven');
  assert.equal(k.record, '25-25'); assert.equal(k.units, 0);
  assert.equal(k.profitShown, false, 'no profit claimed on units that don\'t clear chance');
  assert.equal(v.pooled.label, 'pooled, never proven');
  assert.equal(v.late.bets, 1);
  assert.equal(v.rows.find(r => r.id === 'np').note, 'Pinnacle does not hang this number');
  // under 50 it is building, never proven
  assert.equal(P.betsView(docs.slice(0, 20)).venues[0].label, 'building');
  // the record view carries them, and the page shows the section
  const meta = { handle: 'h', status: 'live', createdAt: new Date(T0).toISOString(), publishedAt: new Date(T0).toISOString(), restarts: [] };
  const rv = P.recordView(meta, [], { bets: docs, now: T0 });
  assert.equal(rv.bets.counts.bets, 52);
  const html = P.pageHtml(rv);
  assert.match(html, /Game-line bets/);
  assert.match(html, /proven at Kalshi/);
  assert.match(html, /LATE · not counted/);
});
