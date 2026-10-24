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
  assert.equal(r.readMins, 3);   // PrizePicks last read at the start: its line may have moved since
  assert.equal(r.pinX, 256.5, 'Pinnacle\'s own number: not the app\'s, so the fair is our curve');
  const pm = eng.pinMain(S.propKey('NFL', 'Josh Allen', 'pass_yds', START), min(3));
  assert.equal(pm.x, 256.5);
  assert.ok(pm.p > 0.45 && pm.p < 0.55);
  assert.equal(eng.pinMain(S.propKey('NFL', 'Josh Allen', 'pass_yds', START), min(30)), null, 'a Pinnacle read 28 min old is no close');
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

test('an app change read before Pinnacle\'s previous read led the move; one read between Pinnacle\'s two reads followed within a read', () => {
  const pin = line => [{ sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', line, pOver: 0.5, over: -110, under: -110, start: START }];
  const run = appReadAt => {
    const eng = S.createStaleLines();
    const row = { key: 'NFL|joshallen|pass_yds', sport: 'NFL', player: 'Josh Allen', mkey: 'pass_yds', startTime: START, books: { underdog: { line: 245.5, over: 1, under: 1, overOpen: true, underOpen: true } } };
    eng.observe(S.pinPropQuotes(pin(245.5)), min(0));
    eng.observe(S.appQuotes([row], { pOverOf: () => 0.5 }), min(0));
    eng.observe(S.pinPropQuotes(pin(245.5)), min(2));   // Pinnacle's previous read, still on 245.5
    eng.observe(S.pinPropQuotes(pin(256.5)), min(4));
    row.books.underdog.line = 255.5;
    eng.observe(S.appQuotes([row], { pOverOf: () => 0.5 }), min(appReadAt));   // observed after Pinnacle's move at 4
    eng.step(min(5));
    assert.equal(eng.rows(min(5), { priceApp: () => ({ ev: 9, decimal: 1.8 }) }).length, 0);
    return eng.lagSummary(min(5)).lag.find(c => c.venue === 'underdog');
  };
  const early = run(1.5), between = run(3);
  assert.equal(early.led, 1);
  assert.equal(between.led, 0);
  assert.equal(between.followed, 1);
  assert.equal(between.medianMin, 0);
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

test('a juice tick that only changes which of Pinnacle\'s posted lines is nearest even money is not a move', () => {
  // a player listed at two lines, each ticking a point
  const eng = S.createStaleLines();
  const p = (a, b) => [
    { sport: 'WNBA', player: 'Angel Reese', mkey: 'points', line: 14.5, pOver: a, over: -125, under: 105, start: START },
    { sport: 'WNBA', player: 'Angel Reese', mkey: 'points', line: 15.5, pOver: b, over: 102, under: -122, start: START },
  ];
  const fd = [{ key: 'WNBA|angelreese|points|2026-10-14', source: 'fanduel', q: { kind: 'prop', mkey: 'points', sport: 'WNBA', pts: [{ x: 15.5, p: 0.5, d0: 1.909, d1: 1.909 }] }, meta: { sport: 'WNBA', kind: 'prop', market: 'points', player: 'Angel Reese', start: START } }];
  for (let m = 0; m < 12; m += 2) { eng.observe([...S.pinPropQuotes(m % 4 ? p(0.52, 0.47) : p(0.53, 0.48)), ...fd], min(m)); eng.step(min(m)); }
  assert.equal(eng.lagSummary(min(12)).moves24h, 0);
  assert.equal(eng.rows(min(12)).length, 0);
  // a total with Pinnacle's alternate ladder: the main stays 47.5, the nearest-50% rung flips
  const e2 = S.createStaleLines();
  const A = book('pinnacle', [[-3, -105, -105]], [[47.5, -122, 102], [46.5, -150, 125], [48.5, -102, -118]]);
  const B = book('pinnacle', [[-3, -105, -105]], [[47.5, -115, -105], [46.5, -150, 125], [48.5, 104, -124]]);
  for (let m = 0; m < 10; m++) { e2.observe(S.gameQuotes([game([m % 2 ? B : A])], 'nfl'), min(m)); e2.step(min(m)); }
  assert.equal(e2.lagSummary(min(10)).moves24h, 0);
});

test('one of Pinnacle\'s listings missing from a read is not a move', () => {
  const eng = S.createStaleLines();
  const L = (line, pOver, over, under) => ({ sport: 'WNBA', player: 'Angel Reese', mkey: 'points', line, pOver, over, under, start: START });
  const both = [L(14.5, 0.52, -112, -108), L(16.5, 0.37, 160, -195)];
  eng.observe(S.pinPropQuotes(both), min(0));
  eng.observe(S.pinPropQuotes([both[1]]), min(2));
  eng.observe(S.pinPropQuotes(both), min(4));
  eng.step(min(4));
  assert.equal(eng.lagSummary(min(4)).moves24h, 0);
});

test('Pinnacle listing one player twice at one line at two prices: no fair we trust, so no moves and no rows, in any order', () => {
  const eng = S.createStaleLines();
  const A = { sport: 'WNBA', player: 'Angel Reese', mkey: 'threes', line: 0.5, pOver: 0.43, over: 128, under: -152, start: START };
  const B = { sport: 'WNBA', player: 'Angel Reese', mkey: 'threes', line: 0.5, pOver: 0.396, over: 142, under: -170, start: START };
  const fd = [{ key: 'WNBA|angelreese|threes|2026-10-14', source: 'fanduel', q: { kind: 'prop', mkey: 'threes', sport: 'WNBA', pts: [{ x: 0.5, p: 0.42, d0: 2.3, d1: 1.66 }] }, meta: { sport: 'WNBA', kind: 'prop', market: 'threes', player: 'Angel Reese', start: START } }];
  [[A, B], [B, A], [A, B], [B, A]].forEach((order, i) => { eng.observe([...S.pinPropQuotes(order), ...fd], min(2 * i)); eng.step(min(2 * i)); });
  assert.equal(eng.lagSummary(min(8)).moves24h, 0);
  assert.equal(eng.rows(min(8)).length, 0);
  assert.equal(eng.fairAt('WNBA|angelreese|threes|2026-10-14', 0.5, min(8)), null);
  // the pick between two prices at one line doesn't depend on the order
  const e1 = S.createStaleLines(), e2 = S.createStaleLines();
  const C = { ...A, pOver: 0.432, over: 125, under: -150 };
  e1.observe(S.pinPropQuotes([A, C]), min(0)); e2.observe(S.pinPropQuotes([C, A]), min(0));
  assert.deepEqual(e1.history('WNBA|angelreese|threes|2026-10-14').sources.pinnacle, e2.history('WNBA|angelreese|threes|2026-10-14').sources.pinnacle);
});

test('a partial pullback leaves a venue that never moved stale, priced at Pinnacle\'s fair now', () => {
  const eng = S.createStaleLines();
  const pin = (o, u) => book('pinnacle', [[-3, -105, -105]], [[47.5, o, u]]);
  const fd = book('fanduel', [[-3, -110, -110]], [[47.5, -110, -110]]);
  eng.observe(S.gameQuotes([game([pin(-105, -105), fd])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pin(-134, 120), fd])], 'nfl'), min(1));
  eng.step(min(1));
  assert.ok(eng.rows(min(1)).find(r => r.venue === 'fanduel' && r.kind === 'total').ev > 5);
  eng.observe(S.gameQuotes([game([pin(-119, 111), fd])], 'nfl'), min(3));   // back halfway
  eng.step(min(3));
  const r = eng.rows(min(3)).find(x => x.venue === 'fanduel' && x.kind === 'total');
  assert.ok(r, 'still stale after the pullback');
  assert.equal(r.side, 'Over');
  assert.ok(r.ev > 1.5 && r.ev < 3, `ev ${r.ev}`);
  assert.equal(r.mins, 2);   // since the first move
  assert.match(r.pinNow, /^o47\.5 53/);
  const c = eng.lagSummary(min(3)).lag.find(x => x.venue === 'fanduel' && x.kind === 'total');
  assert.equal(c.reverted, 0);
  assert.equal(c.led, 0);
});

test('a line the venue takes down drops off the board at once and gets no +2 min price; pulled if still down when the move closes, back on the board if it returns', () => {
  const run = comesBack => {
    const eng = S.createStaleLines();
    const done = ['pinnacle|game', 'fanduel|game', 'betrivers|game'];
    const fd = book('fanduel', [[-3, -110, -110]]), br = book('betrivers', [[-3, -110, -110]]);
    eng.observe(S.gameQuotes([game([pinBefore, fd, br])], 'nfl'), min(0), 'books', done);
    eng.observe(S.gameQuotes([game([pinAfter, fd, br])], 'nfl'), min(1), 'books', done);
    eng.step(min(1));
    const brRow = eng.rows(min(1)).find(r => r.venue === 'betrivers' && r.kind === 'spread');
    assert.ok(brRow);
    const bets = new Map([['br', { group: brRow.group, key: brRow.key, x: brRow.x, venue: 'betrivers', at: min(1) }]]);
    // BetRivers suspends the spread: gone from its next reads
    for (const m of [2, 3]) { eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(m), 'books', done); eng.step(min(m)); }
    assert.equal(eng.rows(min(3)).filter(r => r.venue === 'betrivers').length, 0);
    assert.ok(eng.rows(min(3)).find(r => r.venue === 'fanduel'));
    assert.equal(eng.marks(bets, min(3)).costs.size, 0);
    for (let m = 4; m <= 62; m += 2) {
      eng.observe(S.gameQuotes([game([pinAfter, fd, ...(comesBack ? [br] : [])])], 'nfl'), min(m), 'books', done);
      eng.step(min(m));
      if (m === 4 && comesBack) assert.ok(eng.rows(min(4)).find(r => r.venue === 'betrivers'), 'back on its old number: stale again');
    }
    return eng.lagSummary(min(62)).lag.find(x => x.venue === 'betrivers' && x.kind === 'spread');
  };
  const gone = run(false), back = run(true);
  assert.equal(gone.pulled, 1);
  assert.equal(gone.never, 0);
  assert.equal(back.pulled, 0);
  assert.equal(back.never, 1);
});

test('a venue that misses one read just before Pinnacle moves, and is back on its number in the same read as the move, is followed', () => {
  const eng = S.createStaleLines();
  const done = ['pinnacle|game', 'fanduel|game'];
  const fd = book('fanduel', [[-3, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(0), 'books', done);
  eng.observe(S.gameQuotes([game([pinBefore])], 'nfl'), min(1), 'books', done);
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(2), 'books', done);
  eng.step(min(2));
  assert.ok(eng.rows(min(2)).find(r => r.venue === 'fanduel' && r.kind === 'spread'));
});

test('a venue still behind after a pullback that catches up with Pinnacle\'s price now has followed', () => {
  const eng = S.createStaleLines();
  const pin = (o, u) => book('pinnacle', [[-3, -105, -105]], [[47.5, o, u]]);
  const fd = (o, u) => book('fanduel', [[-3, -110, -110]], [[47.5, o, u]]);
  eng.observe(S.gameQuotes([game([pin(-105, -105), fd(-110, -110)])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pin(-134, 120), fd(-110, -110)])], 'nfl'), min(1));
  eng.observe(S.gameQuotes([game([pin(-118, -102), fd(-110, -110)])], 'nfl'), min(3));
  eng.observe(S.gameQuotes([game([pin(-118, -102), fd(-120, -100)])], 'nfl'), min(5));   // 2.3 pts: short of half the first move, level with Pinnacle now
  eng.step(min(5));
  const c = eng.lagSummary(min(5)).lag.find(x => x.venue === 'fanduel' && x.kind === 'total');
  assert.equal(c.followed, 1);
  assert.equal(c.medianMin, 4);
});

test('the +2 min price comes from a venue read at least 105 s after the flag, never the read it was flagged on', () => {
  const eng = S.createStaleLines();
  const fd = book('fanduel', [[-3, -110, -110]]);
  eng.observe(S.gameQuotes([game([pinBefore, fd])], 'nfl'), min(0));
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(1));
  eng.step(min(1));
  const r = eng.rows(min(1)).find(x => x.venue === 'fanduel' && x.kind === 'spread');
  const bets = new Map([['fd', { group: r.group, key: r.key, x: r.x, venue: 'fanduel', at: min(1) }]]);
  // Pinnacle read again; FanDuel not yet
  eng.observe(S.gameQuotes([game([pinAfter])], 'nfl'), min(2.9));
  assert.equal(eng.marks(bets, min(2.9)).costs.size, 0);
  eng.observe(S.gameQuotes([game([pinAfter, fd])], 'nfl'), min(3));
  const { costs, fairs } = eng.marks(bets, min(3));
  assert.ok(Math.abs(costs.get(`${r.group}|Kansas City Chiefs|fanduel`) - 1 / 1.9091) < 1e-3);
  assert.ok(fairs.get(`${r.group}|Kansas City Chiefs`) > 53);
});

// 10-24: Pinnacle's tennis and UFC lines (pinextra: no American prices, alt
// lines too) feed the engine, and DK Pick6 is a venue like the other apps
test('a Pick6 tennis leg left on Pinnacle\'s old total games is stale at Pinnacle\'s own number', () => {
  const eng = S.createStaleLines();
  const start = '2026-10-25T12:00:00Z';
  const pin = p => [37.5, 38.5, 39.5].map((line, i) => ({ sport: 'TENNIS', player: 'Jannik Sinner', mkey: 'games_played', key: 'TENNIS|jannik sinner|games_played', line, pOver: +(p + 0.2 * (1 - i)).toFixed(4), start }));
  const row = { key: 'TENNIS|jannik sinner|games_played', sport: 'TENNIS', player: 'Jannik Sinner', mkey: 'games_played', market: 'Total Games', matchTitle: 'Sinner vs Alcaraz', startTime: start,
    books: { pick6: { line: 38.5, over: 1, under: 1, overOpen: true, underOpen: true } } };
  const apps = () => S.appQuotes([row], { pOverOf: () => 0.5 });
  eng.observe(S.pinPropQuotes(pin(0.52)), min(0));
  eng.observe(apps(), min(0));
  eng.observe(S.pinPropQuotes(pin(0.42)), min(6));
  eng.step(min(7));
  const priceApp = (book, fair, c, side) => (book === 'pick6' ? { ev: (fair / 0.5503 - 1) * 100, decimal: 1 / 0.5503, entry: '3-pick' } : null);
  const rows = eng.rows(min(7), { priceApp });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].venue, 'pick6');
  assert.equal(rows[0].side, 'Under');
  assert.equal(rows[0].pinX, 38.5, 'Pinnacle\'s main is the app\'s number');
  assert.equal(rows[0].fairProb, 58);
  assert.deepEqual(eng.pinMain(S.propKey('TENNIS', 'Jannik Sinner', 'games_played', start), min(7)), { x: 38.5, p: 0.42 });
  // Pick6 read half an hour ago still counts as quoting; past 35 minutes it doesn't
  assert.equal(eng.rows(min(30), { priceApp }).length, 0, 'Pinnacle\'s read is past 10 minutes');
  eng.observe(S.pinPropQuotes(pin(0.42)), min(34));
  assert.equal(eng.rows(min(34), { priceApp }).length, 1);
  eng.observe(S.pinPropQuotes(pin(0.42)), min(40));
  assert.equal(eng.rows(min(40), { priceApp }).length, 0);
});
