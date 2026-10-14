const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../stalelines');

const T0 = Date.parse('2026-10-14T20:00:00Z');
const START = '2026-10-15T00:20:00Z';
const min = m => T0 + m * 60e3;
// one NFL game in freebooks' shape: Pinnacle with a ladder, FanDuel, BetRivers, Kalshi's mids
const book = (key, spreads, totals, h2h) => ({ key, markets: [
  ...(h2h ? [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: h2h[0] }, { name: 'Buffalo Bills', price: h2h[1] }] }] : []),
  { key: 'spreads', outcomes: spreads.flatMap(([pt, h, a]) => [{ name: 'Kansas City Chiefs', price: h, point: pt }, { name: 'Buffalo Bills', price: a, point: -pt }]) },
  ...(totals ? [{ key: 'totals', outcomes: totals.flatMap(([l, o, u]) => [{ name: 'Over', price: o, point: l }, { name: 'Under', price: u, point: l }]) }] : []),
] });
const game = bms => ({ id: 'pin-1', commence_time: START, home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', bookmakers: bms });
const pinBefore = book('pinnacle', [[-3, -105, -105], [-2.5, -125, 115], [-3.5, 110, -120]], [[47.5, -105, -105]], [-150, 140]);
// Pinnacle moves KC from -3 to -3.5 at even money: KC -3 is now about 54%
const pinAfter = book('pinnacle', [[-3.5, -105, -105], [-3, -128, 118], [-4, 112, -122]], [[47.5, -105, -105]], [-150, 140]);

test('gameQuotes: one quote per source and market, spreads in the home side\'s points', () => {
  const q = S.gameQuotes([game([pinBefore, book('fanduel', [[-3, -110, -110]])])], 'nfl');
  const spread = q.find(x => x.source === 'pinnacle' && x.key === 'pin-1|spread');
  assert.equal(spread.q.pts.length, 3);
  assert.equal(S.mainOf(spread.q).x, -3);
  assert.ok(Math.abs(S.pAt(spread.q, -3) - 0.5) < 1e-6);
  // between its numbers: in z; past them at the sport's slope
  assert.ok(S.pAt(spread.q, -2.75) > 0.5 && S.pAt(spread.q, -2.75) < S.pAt(spread.q, -2.5));
  assert.equal(q.find(x => x.source === 'pinnacle' && x.key === 'pin-1|total').q.pts[0].x, -47.5);
  assert.ok(q.find(x => x.source === 'pinnacle' && x.key === 'pin-1|ml').q.p > 0.5);
  assert.equal(q.filter(x => x.source === 'fanduel').length, 1);
});

test('a Pinnacle move leaves FanDuel stale: priced at the post-move fair, single-source until another sharp source moves', () => {
  const eng = S.createStaleLines();
  const fdOld = book('fanduel', [[-3, -110, -110]]), brOld = book('betrivers', [[-3, -112, -108]]);
  eng.observe(S.gameQuotes([game([pinBefore, fdOld, brOld])], 'nfl'), min(0), 'books');
  eng.step(min(0));
  assert.equal(eng.rows(min(0)).length, 0);
  // Pinnacle moves; the books haven't
  eng.observe(S.gameQuotes([game([pinAfter, fdOld, brOld])], 'nfl'), min(1), 'books');
  eng.step(min(1));
  let rows = eng.rows(min(1));
  const fd = rows.find(r => r.venue === 'fanduel');
  assert.ok(fd, 'FanDuel is stale');
  assert.equal(fd.side, 'Kansas City Chiefs');
  assert.equal(fd.line, '-3');
  assert.ok(fd.fairProb > 53 && fd.fairProb < 56);
  assert.ok(fd.ev > 2, `ev ${fd.ev}`);
  assert.equal(fd.single, true);
  assert.equal(fd.clears, false);
  assert.equal(fd.source, 'stale-single');
  assert.match(fd.pinPre, /Kansas City Chiefs -3 50%/);
  assert.match(fd.pinPost, /-3\.5/);
  // BetRivers follows a minute later: it confirms FanDuel's row, and its lag is 1 minute
  const brNew = book('betrivers', [[-3.5, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinAfter, fdOld, brNew])], 'nfl'), min(2), 'books');
  eng.step(min(2));
  rows = eng.rows(min(2));
  assert.equal(rows.filter(r => r.venue === 'betrivers').length, 0);
  const fd2 = rows.find(r => r.venue === 'fanduel');
  assert.deepEqual(fd2.confirmedBy, ['betrivers']);
  assert.equal(fd2.clears, true);
  assert.equal(fd2.source, 'stale');
  assert.equal(fd2.mins, 1);
  const lag = eng.lagSummary(min(2));
  const br = lag.lag.find(c => c.venue === 'betrivers' && c.kind === 'spread');
  assert.equal(br.followed, 1);
  assert.equal(br.medianMin, 1);
  assert.equal(lag.moves24h, 1);
  // the tracker's marks: the close fair on both sides, FanDuel's price now
  // single-source and cleared rows are separate bets
  assert.notEqual(fd2.group, fd.group);
  const { fairs, costs } = eng.marks(new Map([['a', { group: fd2.group, key: fd2.key, x: -3, venue: 'fanduel' }], ['b', { group: fd2.group, key: fd2.key, x: -3, venue: 'betrivers' }]]), min(2));
  assert.ok(Math.abs(fairs.get(`${fd2.group}|Kansas City Chiefs`) - fd2.fairProb) < 0.01);
  assert.ok(Math.abs(costs.get(`${fd2.group}|Kansas City Chiefs|fanduel`) - 110 / 210) < 1e-6);
  // a second book on the same group gets its own price (BetRivers has moved off -3, so none)
  assert.equal(costs.has(`${fd2.group}|Kansas City Chiefs|betrivers`), false);
  assert.equal(eng.fairAt(fd2.key, -3, min(2)) * 100 > 53, true);
  assert.equal(eng.fairAt(fd2.key, -3, min(30)), null);   // Pinnacle unread for half an hour: no fair
  // FanDuel moves: the row is gone
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3.5, -110, -110]]), brNew])], 'nfl'), min(4), 'books');
  eng.step(min(4));
  assert.equal(eng.rows(min(4)).length, 0);
  assert.equal(eng.lagSummary(min(4)).lag.find(c => c.venue === 'fanduel').medianMin, 3);
});

test('a venue that moved before Pinnacle led it, so it is never stale; a book moving in the same pass is a lag of 0', () => {
  const eng = S.createStaleLines();
  eng.observe(S.gameQuotes([game([pinBefore, book('fanduel', [[-3, -110, -110]]), book('betrivers', [[-3, -110, -110]])])], 'nfl'), min(0));
  // FanDuel moves first
  eng.observe(S.gameQuotes([game([pinBefore, book('fanduel', [[-3.5, -110, -110]]), book('betrivers', [[-3, -110, -110]])])], 'nfl'), min(1));
  // then Pinnacle, with BetRivers in the same pass
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3.5, -110, -110]]), book('betrivers', [[-3.5, -110, -110]])])], 'nfl'), min(2));
  eng.step(min(2));
  assert.equal(eng.rows(min(2)).length, 0);
  const lag = eng.lagSummary(min(2)).lag;
  assert.equal(lag.find(c => c.venue === 'fanduel').led, 1);
  assert.equal(lag.find(c => c.venue === 'betrivers').followed, 1);
  assert.equal(lag.find(c => c.venue === 'betrivers').medianMin, 0);
});

test('small wiggles are not moves; a move closes after the hour as never followed', () => {
  const eng = S.createStaleLines();
  const fd = book('fanduel', [[-3, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(0));
  // -105/-105 to -108/-102 at -3: under a point
  eng.observe(S.gameQuotes([game([book('pinnacle', [[-3, -108, -102]], [[47.5, -105, -105]], [-150, 140]), fd])], 'nfl'), min(1));
  eng.step(min(1));
  assert.equal(eng.lagSummary(min(1)).moves24h, 0);
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(2));
  eng.step(min(2));
  assert.equal(eng.lagSummary(min(2)).moves24h, 1);
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(70));
  eng.step(min(70));
  const c = eng.lagSummary(min(70)).lag.find(x => x.venue === 'fanduel');
  assert.equal(c.never, 1);
  assert.equal(c.neverPct, 100);
  assert.equal(eng.rows(min(70)).length, 0);
});

test('props: a pick\'em line left behind by Pinnacle\'s prop is priced through the app\'s own payout', () => {
  const eng = S.createStaleLines();
  const pin = (line, over, under) => [{ sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', key: 'NFL|josh allen|pass_yds', line, pOver: 0.5, over, under, start: START }];
  const row = { key: 'NFL|josh allen|pass_yds', sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', market: 'Pass Yards', matchTitle: 'BUF @ KC', startTime: START,
    books: { prizepicks: { line: 245.5, over: null, under: null, overOpen: true, underOpen: true } } };
  const apps = () => S.appQuotes([row], { pOverOf: () => 0.5 });
  eng.observe(S.pinPropQuotes(pin(245.5, -110, -110)), min(0));
  eng.observe(apps(), min(0));
  eng.observe(S.pinPropQuotes(pin(256.5, -110, -110)), min(2));
  eng.step(min(3));
  const priceApp = (book, fair) => ({ ev: (fair / 0.5503 - 1) * 100, decimal: 1 / 0.5503, entry: '3-pick power' });
  const rows = eng.rows(min(3), { priceApp });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.venue, 'prizepicks');
  assert.equal(r.app, true);
  assert.equal(r.side, 'Over');
  assert.equal(r.point, 245.5);
  assert.ok(r.fairProb > 56 && r.fairProb < 60, `fair ${r.fairProb}`);
  assert.ok(r.ev > 3);
  assert.equal(r.single, true);
  assert.equal(r.rowKey, row.key);
  // the app moves: it followed
  row.books.prizepicks.line = 254.5;
  eng.observe(apps(), min(20));
  eng.step(min(20));
  assert.equal(eng.rows(min(20), { priceApp }).length, 0);
  assert.equal(eng.lagSummary(min(20)).lag.find(c => c.venue === 'prizepicks').medianMin, 18);
});

test('dayOf keeps one player\'s two games apart and one game on one day', () => {
  assert.equal(S.dayOf('2026-10-15T00:20:00Z'), '2026-10-14');
  assert.equal(S.dayOf('2026-10-14T17:00:00Z'), '2026-10-14');
  assert.notEqual(S.dayOf('2026-10-16T00:20:00Z'), S.dayOf('2026-10-15T00:20:00Z'));
});

test('a juice change that isn\'t a follow keeps the row, priced at the venue\'s quote now; a stale Pinnacle read drops it', () => {
  const eng = S.createStaleLines();
  eng.observe(S.gameQuotes([game([pinBefore, book('fanduel', [[-3, -110, -110]])])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3, -110, -110]])])], 'nfl'), min(1));
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3, -108, -112]])])], 'nfl'), min(2));
  eng.step(min(2));
  const r = eng.rows(min(2)).find(x => x.venue === 'fanduel');
  assert.equal(r.price, -108);
  // FanDuel keeps being read, Pinnacle doesn't: past five minutes it isn't the fair
  eng.observe(S.gameQuotes([game([book('fanduel', [[-3, -108, -112]])])], 'nfl'), min(9));
  eng.step(min(9));
  assert.equal(eng.rows(min(9)).length, 0);
});

test('Pinnacle turning back marks the first move reverted, not never followed; a venue already at the new price is ahead', () => {
  const eng = S.createStaleLines();
  const fd = book('fanduel', [[-3, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(1));
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(3));
  eng.step(min(3));
  eng.step(min(70));
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(70));
  eng.step(min(70));
  const c = eng.lagSummary(min(70)).lag.find(x => x.venue === 'fanduel');
  assert.equal(c.reverted, 1);
  assert.equal(c.led, 1);      // back at -3 50%: FanDuel was already there
  assert.equal(c.never, 0);
});

test('an app read taken before Pinnacle\'s move but landing after it counts as ahead, not stale', () => {
  const eng = S.createStaleLines();
  const pin = line => [{ sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', line, pOver: 0.5, over: -110, under: -110, start: START }];
  const row = { key: 'NFL|joshallen|pass_yds', sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', startTime: START, books: { underdog: { line: 245.5, over: 1, under: 1, overOpen: true, underOpen: true } } };
  eng.observe(S.pinPropQuotes(pin(245.5)), min(0));
  eng.observe(S.appQuotes([row], { pOverOf: () => 0.5 }), min(0));
  eng.observe(S.pinPropQuotes(pin(256.5)), min(4));
  row.books.underdog.line = 255.5;
  eng.observe(S.appQuotes([row], { pOverOf: () => 0.5 }), min(3));   // read at 3, observed after Pinnacle's move at 4
  eng.step(min(5));
  assert.equal(eng.rows(min(5), { priceApp: () => ({ ev: 9, decimal: 1.8 }) }).length, 0);
  assert.equal(eng.lagSummary(min(5)).lag.find(c => c.venue === 'underdog').led, 1);
});

test('lag stats: a true median, and open moves past the mark count against "within"', () => {
  const eng = S.createStaleLines();
  eng.observe(S.gameQuotes([game([pinBefore, book('fanduel', [[-3, -110, -110]]), book('betrivers', [[-3, -110, -110]])])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3, -110, -110]]), book('betrivers', [[-3, -110, -110]])])], 'nfl'), min(1));
  eng.observe(S.gameQuotes([game([pinAfter, book('fanduel', [[-3.5, -110, -110]]), book('betrivers', [[-3, -110, -110]])])], 'nfl'), min(2));
  eng.step(min(20));
  const fd = eng.lagSummary(min(20)).lag.find(c => c.venue === 'fanduel'), br = eng.lagSummary(min(20)).lag.find(c => c.venue === 'betrivers');
  assert.equal(fd.medianMin, 1);
  assert.equal(fd.within2, 100);
  assert.equal(br.open, 1);
  assert.equal(br.within15, 0);   // 19 minutes open: it did not follow within 15
  assert.equal(br.within2, 0);
});

test('a prop quoted at two lines in one read is one quote, not a move every read', () => {
  const eng = S.createStaleLines();
  const two = [
    { sport: 'WNBA', player: 'Angel Reese', mkey: 'points', line: 14.5, pOver: 0.52, over: -112, under: -108, start: START },
    { sport: 'WNBA', player: 'Angel Reese', mkey: 'points', line: 16.5, pOver: 0.4, over: 135, under: -165, start: START },
  ];
  for (let m = 0; m < 10; m += 2) { eng.observe(S.pinPropQuotes(m % 4 ? two : [two[1], two[0]]), min(m)); eng.step(min(m)); }
  assert.equal(eng.lagSummary(min(10)).moves24h, 0);
});

test('the lag table counts moves under the rows\' sport keys, whatever name the feed gave', () => {
  const eng = S.createStaleLines({ sportKey: x => ({ NFL: 'nfl' })[x] || String(x).toLowerCase() });
  const fdOld = book('fanduel', [[-3, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinBefore, fdOld])], 'nfl', { league: 'NFL' }), min(0), 'books');
  eng.step(min(0));
  eng.observe(S.gameQuotes([game([pinAfter, fdOld])], 'nfl', { league: 'NFL' }), min(1), 'books');
  eng.step(min(1));
  const lag = eng.lagSummary(min(1));
  assert.deepEqual(Object.keys(lag.bySport), ['nfl']);
  assert.equal(eng.rows(min(1)).find(r => r.venue === 'fanduel').sport, 'nfl');
});
