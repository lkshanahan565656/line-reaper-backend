const test = require('node:test');
const assert = require('node:assert/strict');
const { createSharpTracker, impliedProb, sideKey, moveDelta, reverseLineMoves, describeSharp } = require('../sharp');

const NOW = Date.parse('2026-10-08T18:00:00Z');
const START = new Date(NOW + 3 * 3600e3).toISOString();
const S = 1000, MIN = 60e3;

// books: { key: { ml: [home, away], sp: [homePoint, homePrice, awayPrice], tot: [point, over, under] } }
const snap = (books, over = {}) => [{
  id: 'g1', home_team: 'Celtics', away_team: 'Knicks', commence_time: START, ...over,
  bookmakers: Object.entries(books).map(([key, b]) => ({
    key, markets: [
      b.ml && { key: 'h2h', outcomes: [{ name: 'Celtics', price: b.ml[0] }, { name: 'Knicks', price: b.ml[1] }] },
      b.sp && { key: 'spreads', outcomes: [{ name: 'Celtics', price: b.sp[1], point: b.sp[0] }, { name: 'Knicks', price: b.sp[2], point: -b.sp[0] }] },
      b.tot && { key: 'totals', outcomes: [{ name: 'Over', price: b.tot[1], point: b.tot[0] }, { name: 'Under', price: b.tot[2], point: b.tot[0] }] },
    ].filter(Boolean),
  })),
}];
const BASE = { ml: [-150, 130] };
const MOVED = { ml: [-165, 145] };
const DOWN = { ml: [-135, 115] };
const board = (moved = {}, books = ['pinnacle', 'draftkings', 'fanduel', 'betmgm']) =>
  snap(Object.fromEntries(books.map(b => [b, moved[b] || BASE])));
const kinds = (evs, kind) => evs.filter(e => e.kind === kind);

test('implied probability from american odds', () => {
  assert.ok(Math.abs(impliedProb(-110) - 110 / 210) < 1e-12);
  assert.equal(impliedProb(150), 0.4);
  assert.equal(impliedProb(-100), 0.5);
  assert.equal(impliedProb(100), 0.5);
  assert.equal(impliedProb(50), null);
  assert.equal(impliedProb('x'), null);
  assert.equal(sideKey('totals', { name: 'over' }), 'Over');
  assert.equal(sideKey('spreads', { name: 'Knicks', point: 3.5 }), 'Knicks');
});

test('a small move is ignored, a big one recorded on both sides', () => {
  const t = createSharpTracker();
  assert.deepEqual(t.ingest('nba', snap({ pinnacle: BASE }), NOW), [], 'first sighting only primes');
  assert.deepEqual(t.ingest('nba', snap({ pinnacle: { ml: [-152, 132] } }), NOW + 30 * S), []);
  const evs = t.ingest('nba', snap({ pinnacle: MOVED }), NOW + 60 * S);
  const moves = kinds(evs, 'move');
  assert.equal(moves.length, 2);
  const c = moves.find(e => e.side === 'Celtics');
  assert.equal(c.book, 'pinnacle');
  assert.equal(c.isSharp, true);
  assert.equal(c.game, 'Knicks @ Celtics');
  assert.equal(c.gameId, 'g1');
  assert.equal(c.start, START);
  assert.equal(c.market, 'h2h');
  assert.deepEqual(c.from, { price: -150, point: null }, 'measured from the last reported level, not the -152 poll');
  assert.deepEqual(c.to, { price: -165, point: null });
  assert.ok(c.deltaProb > 0.02 && c.deltaProb < 0.025);
  assert.ok(moves.find(e => e.side === 'Knicks').deltaProb < 0);
});

test('a line creeping in small steps is reported once it adds up', () => {
  const t = createSharpTracker();
  t.ingest('nba', snap({ pinnacle: BASE }), NOW);
  assert.deepEqual(t.ingest('nba', snap({ pinnacle: { ml: [-158, 138] } }), NOW + 30 * S), []);
  const evs = t.ingest('nba', snap({ pinnacle: { ml: [-165, 145] } }), NOW + 60 * S);
  assert.equal(kinds(evs, 'move').find(e => e.side === 'Celtics').from.price, -150);
});

test('steam fires when 3 books move the same side inside the window, once', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  assert.equal(kinds(t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S), 'steam').length, 0);
  assert.equal(kinds(t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED }), NOW + 60 * S), 'steam').length, 0);
  const steam = kinds(t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: MOVED }), NOW + 90 * S), 'steam');
  assert.equal(steam.length, 1, 'Celtics only: the Knicks drop is the same money mirrored');
  const s = steam[0];
  assert.equal(s.side, 'Celtics');
  assert.equal(s.direction, 'up');
  assert.deepEqual(s.books, ['pinnacle', 'draftkings', 'fanduel']);
  assert.equal(s.leader, 'pinnacle');
  assert.equal(s.sharpCount, 1);
  assert.ok(Math.abs(s.deltaProb - (165 / 265 - 0.6)) < 1e-4);
  const more = t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: MOVED, betmgm: MOVED }), NOW + 120 * S);
  assert.equal(kinds(more, 'steam').length, 0, 'a 4th book in the same window does not refire');
  assert.equal(t.events({ kind: 'steam' }).length, 1);
});

test('no steam when moves are spread beyond the window', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED }), NOW + 2 * MIN);
  const evs = t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: MOVED }), NOW + 4 * MIN);
  assert.equal(kinds(evs, 'move').length, 2, 'fanduel still moved');
  assert.equal(kinds(evs, 'steam').length, 0);
});

test('no steam when books move in opposite directions', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED }), NOW + 60 * S);
  const evs = t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: DOWN }), NOW + 90 * S);
  assert.equal(kinds(evs, 'move').length, 2);
  assert.equal(kinds(evs, 'steam').length, 0);
});

test('a spread or total point move counts as a move', () => {
  assert.ok(Math.abs(moveDelta('spreads', 'Celtics', { price: -110, point: -3 }, { price: -110, point: -3.5 }) - 0.025) < 1e-12);
  assert.ok(Math.abs(moveDelta('totals', 'Over', { price: -110, point: 220.5 }, { price: -110, point: 221.5 }) - 0.05) < 1e-12);
  assert.ok(moveDelta('totals', 'Under', { price: -110, point: 220.5 }, { price: -110, point: 221.5 }) < 0);

  const t = createSharpTracker();
  t.ingest('nba', snap({ pinnacle: { sp: [-3, -110, -110], tot: [220.5, -110, -110] } }), NOW);
  const evs = t.ingest('nba', snap({ pinnacle: { sp: [-3.5, -110, -110], tot: [220.5, -110, -110] } }), NOW + 30 * S);
  const moves = kinds(evs, 'move');
  assert.equal(moves.length, 2, 'both spread sides; the total did not move');
  const c = moves.find(e => e.side === 'Celtics');
  assert.equal(c.market, 'spreads');
  assert.deepEqual(c.from, { price: -110, point: -3 });
  assert.deepEqual(c.to, { price: -110, point: -3.5 });
  assert.ok(Math.abs(c.deltaProb - 0.025) < 1e-9);
  const k = moves.find(e => e.side === 'Knicks');
  assert.deepEqual(k.to, { price: -110, point: 3.5 });
  assert.ok(k.deltaProb < 0);
});

test('sharp_lead lists stale soft books and resolves in stale() as they catch up', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  const evs = t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  const leads = kinds(evs, 'sharp_lead');
  assert.equal(leads.length, 1, 'only the side the sharp money hit');
  const L = leads[0];
  assert.equal(L.book, 'pinnacle');
  assert.equal(L.side, 'Celtics');
  assert.deepEqual(L.staleBooks, [
    { book: 'draftkings', price: -150, point: null },
    { book: 'fanduel', price: -150, point: null },
    { book: 'betmgm', price: -150, point: null },
  ]);
  assert.equal(t.stale(NOW + 40 * S).length, 1);

  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED }), NOW + 60 * S);
  assert.deepEqual(t.stale(NOW + 70 * S)[0].staleBooks.map(b => b.book), ['fanduel', 'betmgm']);

  // a partial catch-up (half the threshold) counts; a cent of vig noise does not
  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: { ml: [-157, 137] }, betmgm: { ml: [-151, 131] } }), NOW + 90 * S);
  assert.deepEqual(t.stale(NOW + 95 * S)[0].staleBooks, [{ book: 'betmgm', price: -151, point: null }]);

  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: MOVED, betmgm: MOVED }), NOW + 120 * S);
  assert.deepEqual(t.stale(NOW + 125 * S), []);
  assert.equal(t.state().openLeads, 0);
});

test('sharp_lead expires after the stale window and needs two stale books', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  assert.equal(t.stale(NOW + 4 * MIN).length, 1);
  assert.equal(t.stale(NOW + 30 * S + 5 * MIN).length, 0);

  // soft books that moved first are leading, not stale: only betmgm left → no lead
  const u = createSharpTracker();
  u.ingest('nba', board(), NOW);
  u.ingest('nba', board({ draftkings: MOVED, fanduel: MOVED }), NOW + 30 * S);
  const evs = u.ingest('nba', board({ draftkings: MOVED, fanduel: MOVED, pinnacle: MOVED }), NOW + 60 * S);
  assert.equal(kinds(evs, 'sharp_lead').length, 0);
  assert.equal(kinds(evs, 'steam').length, 1);
  assert.equal(kinds(evs, 'steam')[0].leader, 'draftkings');
});

test('sharp_lead closes when the sharp book walks its move back', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  t.ingest('nba', board(), NOW + 60 * S);
  const open = t.stale(NOW + 61 * S);
  assert.equal(open.filter(l => l.side === 'Celtics').length, 0);
  assert.equal(open.length, 1, 'the walk-back is itself a sharp move toward the Knicks');
  assert.equal(open[0].side, 'Knicks');
});

test('started games are ignored and pruned', () => {
  const t = createSharpTracker();
  const past = new Date(NOW - 1000).toISOString();
  assert.deepEqual(t.ingest('nba', snap({ pinnacle: BASE }, { commence_time: past }), NOW), []);
  assert.deepEqual(t.ingest('nba', snap({ pinnacle: MOVED }, { commence_time: past }), NOW + 30 * S), []);
  assert.equal(t.state().series, 0);

  const soon = new Date(NOW + 45 * S).toISOString();
  t.ingest('nba', board().map(g => ({ ...g, commence_time: soon })), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }).map(g => ({ ...g, commence_time: soon })), NOW + 30 * S);
  assert.equal(t.stale(NOW + 31 * S).length, 1);
  assert.deepEqual(t.ingest('nba', board({ pinnacle: DOWN }).map(g => ({ ...g, commence_time: soon })), NOW + 60 * S), []);
  assert.equal(t.state().games, 0);
  assert.equal(t.state().series, 0);
  assert.deepEqual(t.stale(NOW + 61 * S), []);
});

test('rlm and big_money from betting splits', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  const evs = t.ingest('nba', board({ pinnacle: DOWN }), NOW + 30 * S);   // Celtics got cheaper
  const out = reverseLineMoves(evs, {
    'Knicks @ Celtics': {
      moneyline: { Celtics: { bets: 72, handle: 40 }, Knicks: { betPct: 28, money: 60 } },
      total: { over: { tickets: 0.55, moneyPct: 0.62 } },
    },
  });
  const rlm = out.find(x => x.kind === 'rlm');
  assert.equal(rlm.side, 'Celtics');
  assert.equal(rlm.market, 'h2h');
  assert.equal(rlm.betsPct, 72);
  assert.equal(rlm.moneyPct, 40);
  assert.ok(rlm.deltaProb < -0.02);
  const big = out.filter(x => x.kind === 'big_money');
  assert.equal(big.length, 1, 'the 7-point Over gap is under 15');
  assert.equal(big[0].side, 'Knicks');
  assert.equal(big[0].moneyPct - big[0].betsPct, 32);
  assert.equal(out.length, 2);
  // the public side moving WITH the public is not RLM
  assert.deepEqual(reverseLineMoves(evs, { 'Knicks @ Celtics': { h2h: { Knicks: { betsPct: 70, moneyPct: 70 } } } }), []);
});

test('describeSharp writes one plain line per event', () => {
  const t = createSharpTracker();
  t.ingest('nba', board(), NOW);
  t.ingest('nba', board({ pinnacle: MOVED }), NOW + 30 * S);
  t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED }), NOW + 60 * S);
  const steam = kinds(t.ingest('nba', board({ pinnacle: MOVED, draftkings: MOVED, fanduel: MOVED }), NOW + 90 * S), 'steam')[0];
  assert.equal(describeSharp(steam), 'STEAM: Celtics ML moved 2.3 pts at 3 books (Pinnacle first)');

  const lead = {
    kind: 'sharp_lead', market: 'spreads', side: 'Knicks', book: 'pinnacle',
    from: { price: -110, point: 6 }, to: { price: -110, point: 5.5 }, deltaProb: 0.025,
    staleBooks: [{ book: 'draftkings', price: -110, point: 5.5 }, { book: 'fanduel', price: -110, point: 5.5 }],
  };
  assert.equal(describeSharp(lead), 'SHARP LEAD: Pinnacle moved Knicks +5.5; DraftKings, FanDuel still at -110');
  assert.equal(describeSharp({ ...lead, staleBooks: [{ book: 'draftkings', price: -110, point: 6 }, { book: 'fanduel', price: -105, point: 5.5 }] }),
    'SHARP LEAD: Pinnacle moved Knicks +5.5; still at DraftKings +6 -110, FanDuel -105');

  const move = t.events({ kind: 'move' }).find(e => e.book === 'pinnacle' && e.side === 'Celtics');
  assert.equal(describeSharp(move), 'MOVE: Pinnacle (sharp) Celtics ML -150 → -165 (+2.3 pts)');
  assert.equal(describeSharp({ kind: 'rlm', game: 'Knicks @ Celtics', market: 'h2h', side: 'Celtics', betsPct: 72, moneyPct: 40, deltaProb: -0.03 }),
    'RLM: 72% of bets on Celtics ML but the line moved 3.0 pts against it (Knicks @ Celtics)');
  assert.equal(describeSharp({ kind: 'big_money', game: 'Knicks @ Celtics', market: 'totals', side: 'Over', betsPct: 35, moneyPct: 58 }),
    'BIG MONEY: Over has 58% of the money on 35% of bets (Knicks @ Celtics)');
});

test('events() filters and the log is capped at maxEvents, newest first', () => {
  const t = createSharpTracker({ maxEvents: 5 });
  t.ingest('nba', snap({ pinnacle: BASE }), NOW);
  for (let i = 1; i <= 6; i++) t.ingest('nba', snap({ pinnacle: i % 2 ? MOVED : BASE }), NOW + i * 30 * S);
  const all = t.events({ limit: 100 });
  assert.equal(all.length, 5);
  assert.equal(all[0].ts, NOW + 180 * S);
  assert.ok(all.every((e, i) => i === 0 || all[i - 1].ts >= e.ts));
  assert.equal(t.state().events, 5);
  assert.equal(t.events({ sport: 'nhl' }).length, 0);
  assert.equal(t.events({ sinceMs: NOW + 180 * S }).length, 2);
  assert.equal(t.events({ limit: 1 }).length, 1);
  assert.equal(t.state().lastIngest.nba, new Date(NOW + 180 * S).toISOString());
});
