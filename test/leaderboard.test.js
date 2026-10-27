// The bettor leaderboard (leaderboard.js): ranked only at the bar, by the low
// end of the 95% interval, ties shared, late picks never counted, labels the
// record's own. TEST DATA: every record, slip and grade below is made up here.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../leaderboard');
const P = require('../pubrecord');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86400e3;
// n picks at one app, CLV values cycling through xs, logged daysAgo
const picks = (n, xs, { key = 'prizepicks', name = 'PrizePicks', league = 'NBA', daysAgo = 1, kind = 'app' } = {}) =>
  Array.from({ length: n }, (_, i) => ({ kind, key, name, unit: kind === 'app' ? 'legs' : 'bets', league, at: new Date(NOW - daysAgo * DAY).toISOString(), clv: xs[i % xs.length], fair: 0.55, outcome: i % 2 ? 'win' : 'loss' }));
const rec = (handle, entries, labels = {}) => ({ handle, publishedAt: '2026-10-01T00:00:00Z', labels, entries });

test('the 95% t value matches the table', () => {
  assert.ok(Math.abs(L.tCrit(9) - 2.262) < 0.01);
  assert.ok(Math.abs(L.tCrit(49) - 2.010) < 0.005);
  assert.ok(Math.abs(L.tCrit(1000) - 1.962) < 0.005);
});

test('leagues fold to one code', () => {
  assert.equal(L.leagueOf('basketball_nba'), 'NBA');
  assert.equal(L.leagueOf('ncaaf'), 'CFB');
  assert.equal(L.leagueOf('LOL'), 'LOL');
  assert.equal(L.leagueOf(''), 'OTHER');
});

test('ranked only at 50; under it building with no rank', () => {
  const v = L.build([rec('steady', picks(60, [1, 3])), rec('short', picks(20, [9, 11]))], { now: NOW });
  assert.deepEqual(v.ranked.map(x => x.handle), ['steady']);
  assert.equal(v.ranked[0].rank, 1);
  assert.equal(v.ranked[0].clv, 2);
  assert.ok(v.ranked[0].ciLo > 1.7 && v.ranked[0].ciLo < 2 && v.ranked[0].ciHi > 2);
  assert.deepEqual(v.building.map(x => [x.handle, x.rank, x.n]), [['short', null, 20]]);
});

test('ranked by the low end of the interval, not the average', () => {
  const noisy = picks(50, [-20, 30]); // mean +5, wide
  const steady = picks(50, [1.5, 2.5]); // mean +2, tight
  const v = L.build([rec('noisy', noisy), rec('steady', steady)], { now: NOW });
  assert.deepEqual(v.ranked.map(x => x.handle), ['steady', 'noisy']);
  assert.ok(v.ranked[1].clv > v.ranked[0].clv, 'the higher average ranks lower when its interval is wide');
});

test('rows whose low ends match share a rank', () => {
  const v = L.build([rec('aaa', picks(50, [1, 3])), rec('bbb', picks(50, [1, 3])), rec('ccc', picks(50, [0, 2]))], { now: NOW });
  assert.deepEqual(v.ranked.map(x => `${x.tied ? '=' : ''}${x.rank}`), ['=1', '=1', '3']);
});

test('one bettor, two apps: judged apart, never pooled', () => {
  const v = L.build([rec('two', [...picks(50, [1, 3]), ...picks(30, [5], { key: 'underdog', name: 'Underdog' })])], { now: NOW });
  assert.equal(v.ranked.length, 1);
  assert.equal(v.ranked[0].name, 'PrizePicks');
  assert.equal(v.building[0].name, 'Underdog');
});

test('league and window filters', () => {
  const r = rec('mix', [...picks(50, [1, 3], { league: 'NBA', daysAgo: 2 }), ...picks(50, [2, 4], { league: 'NFL', daysAgo: 20 })]);
  const all = L.build([r], { now: NOW });
  assert.equal(all.ranked[0].n, 100);
  assert.deepEqual(all.leagues.map(x => x.key).sort(), ['NBA', 'NFL']);
  const nfl = L.build([r], { now: NOW, league: 'nfl' });
  assert.deepEqual([nfl.ranked[0].n, nfl.filter.league], [50, 'NFL']);
  const week = L.build([r], { now: NOW, window: '7d' });
  assert.equal(week.ranked[0].n, 50);
  assert.deepEqual(week.leagues.map(x => x.key), ['NBA']);
  const none = L.build([r], { now: NOW, window: '7d', league: 'NFL' });
  assert.ok(none.empty);
  assert.match(L.sectionHtml(none), /Nothing graded in this slice/);
  assert.equal(L.build([r], { now: NOW, window: 'bogus' }).filter.window, 'all');
});

test('the label is the record\'s own, never the slice\'s', () => {
  const v = L.build([rec('lab', picks(60, [1, 3]), { 'app:prizepicks': { label: 'building', why: 'x' } })], { now: NOW });
  assert.equal(v.ranked[0].label, 'building');
  const v2 = L.build([rec('nolab', picks(60, [1, 3]))], { now: NOW });
  assert.equal(v2.ranked[0].label, 'not graded yet');
});

test('state: each row tagged, and "only ones I can use" drops the rest', () => {
  const r = rec('st', [...picks(50, [1, 3]), ...picks(50, [1, 3], { kind: 'venue', key: 'fanduel', name: 'FanDuel' })]);
  const v = L.build([r], { now: NOW, state: 'TX' });
  const fd = v.ranked.find(x => x.key === 'fanduel');
  assert.equal(fd.state.status, 'no', 'no sportsbook in Texas');
  const mine = L.build([r], { now: NOW, state: 'TX', mine: true });
  assert.ok(!mine.ranked.some(x => x.key === 'fanduel'));
  assert.equal(mine.hiddenByState, 1);
});

test('nobody yet: the page and the API say so plainly', () => {
  const v = L.build([], { now: NOW });
  assert.ok(v.empty);
  const b = L.publicBody(v);
  assert.deepEqual([b.ranked.length, b.building.length], [0, 0]);
  assert.match(b.note, /No published record/);
  const h = L.sectionHtml(v, { states: [['TX', 'Texas']] });
  assert.match(h, /Nothing graded in this slice/);
  assert.ok(!/undefined|NaN|profit:|guaranteed/i.test(h));
});

test('the API body carries no units or profit', () => {
  const b = L.publicBody(L.build([rec('api', picks(50, [1, 3]))], { now: NOW }));
  const s = JSON.stringify(b);
  assert.ok(!/"units"|"profit/.test(s));
  assert.deepEqual(b.ranked[0].ci95.length, 2);
  assert.equal(b.ranked[0].graded, 50);
});

// ── from real record docs: only on-time legs with Pinnacle's close count ──
const memStore = () => { const m = new Map(); return { m, async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, JSON.parse(JSON.stringify(d))); } }; };
test('boardEntries: LATE slips and legs without Pinnacle\'s close never count', async () => {
  const T0 = Date.parse('2026-10-20T12:00:00Z');
  let t = T0;
  const rs = P.createRecordStore({ store: memStore(), now: () => t, random: n => Buffer.alloc(n, 7) });
  const { token } = await rs.publish({ handle: 'board', who: 'a' });
  const leg = (player, sport = 'NBA') => ({ player, market: 'Points', side: 'Over', line: 20.5, sport });
  await rs.addSlips('board', token, [
    { id: 'on', app: 'prizepicks', legs: [leg('A A'), leg('B B')], placedAt: new Date(T0).toISOString(), source: 'paste' },
    { id: 'late', app: 'prizepicks', legs: [leg('C C'), leg('D D')], placedAt: new Date(T0 - DAY).toISOString(), source: 'pikkit' },
  ]);
  const view = (start, raw) => ({ status: 'graded', final: true, matched: { sport: 'NBA', player: 'X', market: 'Points', start: new Date(start).toISOString(), matchTitle: 'A @ B' }, raw, outcome: 'win', result: 25, gradeSource: 'ESPN box score' });
  const res = {};
  for (const l of rs.pendingLegs('board')) {
    const late = /C C|D D/.test(l.player);
    res[l.id] = view(late ? T0 - 3600e3 : T0 + 7200e3, /B B/.test(l.player) ? { source: 'kalshi', fair: 0.5, ev: 3, line: 20.5, exact: true, ok: true } : { source: 'pinnacle', fair: 0.6, ev: 4, line: 20.5, exact: true, ok: true });
  }
  await rs.applyGrades('board', res);
  const b = P.boardEntries(rs.get('board'), rs.slipsOf('board'), []);
  assert.deepEqual(b.entries.map(e => [e.key, e.league, e.clv]), [['prizepicks', 'NBA', 4]], 'only A A: B B has no Pinnacle close, C C and D D were late');
  assert.equal(b.labels['app:prizepicks'].label, 'building');
});
