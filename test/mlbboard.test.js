// mlbboard.js: every MLB app leg next to Pinnacle's own number (gap and even
// legs per app), the MLB Stats API box score, the record kinds, the stacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const MB = require('../mlbboard');
const ST = require('../sporttrack');
const SG = require('../sportgrade');
const SLIPS = require('../slips');

const box = { teams: {
  home: { team: { name: 'Milwaukee Brewers' }, players: {
    ID1: { person: { fullName: 'Christian Yelich' }, stats: { batting: { plateAppearances: 4, atBats: 3, hits: 2, doubles: 1, triples: 0, homeRuns: 1, runs: 1, rbi: 2, baseOnBalls: 1, strikeOuts: 1, totalBases: 7, stolenBases: 1 }, pitching: {} } },
    ID2: { person: { fullName: 'Freddy Peralta' }, stats: { batting: {}, pitching: { battersFaced: 24, outs: 17, strikeOuts: 8, hits: 4, earnedRuns: 2, baseOnBalls: 1, numberOfPitches: 98 } } },
    ID3: { person: { fullName: 'Bench Guy' }, stats: { batting: { plateAppearances: 0, atBats: 0, hits: 0 }, pitching: {} } },
  } },
  away: { team: { name: 'Tampa Bay Rays' }, players: {
    ID4: { person: { fullName: 'Yandy Díaz' }, stats: { batting: { plateAppearances: 4, atBats: 4, hits: 0, doubles: 0, triples: 0, homeRuns: 0, runs: 0, rbi: 0, baseOnBalls: 0, strikeOuts: 2, totalBases: 0 }, pitching: {} } },
  } },
} };

test('the MLB Stats API box reads total bases, singles and a starter\'s outs', () => {
  const p = MB.parseMlbBox(box);
  const y = p.get('christianyelich'), f = p.get('freddyperalta');
  assert.equal(MB.mlbStat('total_bases', y), 7);
  assert.equal(MB.mlbStat('singles', y), 0, 'two hits: a double and a homer');
  assert.equal(MB.mlbStat('hits_runs_rbis', y), 5);
  assert.equal(MB.mlbStat('walks', y), 1);
  assert.equal(MB.mlbStat('stolen_bases', y), 1);
  assert.equal(MB.mlbStat('strikeouts', f), 8);
  assert.equal(MB.mlbStat('pitcher_outs', f), 17);
  assert.equal(MB.mlbStat('earned_runs', f), 2);
  assert.equal(MB.mlbStat('strikeouts', y), null, 'a hitter has no pitching line');
  assert.equal(MB.mlbStat('hits', p.get('benchguy')), null, 'no plate appearance: void, not a zero');
  assert.equal(MB.mlbStat('hits', p.get('yandydiaz')), 0, 'accents fold');
  assert.ok(SG.canGrade({ sport: 'MLB', mkey: 'total_bases' }), 'total bases now grades');
});

test('a gap leg takes the side the app\'s number is good for; an even leg Pinnacle\'s side', () => {
  const pin = { line: 6.5, pOver: 0.52 };
  const gap = MB.classify('prizepicks', { line: 5.5 }, pin, 'strikeouts');
  assert.equal(gap.rel, 'gap'); assert.equal(gap.side, 'Over'); assert.equal(gap.gap, 1);
  assert.equal(gap.kind, 'mlb-pin'); assert.equal(gap.be, 0.5503);
  assert.equal(gap.exact, false, 'a different number is a curve price');
  assert.ok(gap.fair > 0.6, 'a strikeout lower than Pinnacle\'s is a big Over');
  const under = MB.classify('underdog', { line: 7.5, over: 1, under: 1 }, pin, 'strikeouts');
  assert.equal(under.side, 'Under'); assert.equal(under.kind, 'ud-mlb-pin');
  const even = MB.classify('sleeper', { line: 6.5, over: 1.7, under: 1.9 }, { line: 6.5, pOver: 0.45 }, 'strikeouts');
  assert.equal(even.rel, 'even'); assert.equal(even.side, 'Under'); assert.equal(even.kind, 'sl-mlb-even');
  assert.equal(even.exact, true); assert.equal(even.fair, 0.55); assert.equal(even.be, +(1 / 1.9).toFixed(4));
  assert.equal(MB.classify('pick6', { line: 6.5, over: 1, under: 1 }, pin, 'strikeouts').kind, 'p6-mlb-even');
  // a closed side is not a leg
  assert.equal(MB.classify('prizepicks', { line: 5.5, overOpen: false }, pin, 'strikeouts'), null);
});

test('Pinnacle\'s main line is the one nearest 50/50', () => {
  assert.equal(MB.pinMain([{ line: 4.5, pOver: 0.8 }, { line: 5.5, pOver: 0.55 }, { line: 6.5, pOver: 0.3 }]).line, 5.5);
  assert.equal(MB.pinMain([]), null);
});

test('board and plays: only MLB rows Pinnacle prices, every app leg under its own kind', () => {
  const rows = [
    { key: 'MLB|freddyperalta|strikeouts', sport: 'MLB', player: 'Freddy Peralta', team: 'Milwaukee Brewers', mkey: 'strikeouts', market: 'Pitcher Strikeouts', startTime: '2026-10-27T00:00:00Z',
      books: { prizepicks: { line: 5.5 }, underdog: { line: 6.5, over: 1, under: 1 }, sleeper: { line: 6.5, over: 1.75, under: 1.85 } } },
    { key: 'MLB|x|hits', sport: 'MLB', player: 'X', mkey: 'hits', market: 'Hits', startTime: '2026-10-27T00:00:00Z', books: { prizepicks: { line: 0.5 } } },
    { key: 'NBA|y|points', sport: 'NBA', player: 'Y', mkey: 'points', books: { prizepicks: { line: 20.5 } } },
  ];
  const pinFor = r => (r.key === 'MLB|freddyperalta|strikeouts' ? [{ line: 6.5, pOver: 0.5, over: -105, under: -115 }] : []);
  const b = MB.board(rows, { pinFor });
  assert.equal(b.length, 1);
  const ps = MB.plays(rows, { pinFor });
  assert.deepEqual(ps.map(p => p.kind).sort(), ['mlb-pin', 'sl-mlb-even', 'ud-mlb-even']);
  const pp = ps.find(p => p.kind === 'mlb-pin');
  assert.equal(pp.play.decimal, +(1 / 0.5503).toFixed(4), 'priced at the 3-pick Power break-even');
  assert.equal(pp.play.pinLine, 6.5);
  // every kind is one the record keeps apart from the headline
  assert.deepEqual([...MB.KINDS].sort(), [...ST.MLB].sort());
});

test('the record keeps Pinnacle\'s raw close on an MLB leg and its own id', async () => {
  const mem = new Map();
  const store = { init: async () => {}, all: async () => [...mem.values()], put: async b => { mem.set(b.id, { ...b }); } };
  let t = Date.parse('2026-10-26T20:00:00Z');
  const tr = ST.createSportTracker({ store, now: () => t });
  const row = { key: 'MLB|freddyperalta|strikeouts', sport: 'MLB', player: 'Freddy Peralta', team: 'Milwaukee Brewers', mkey: 'strikeouts', market: 'Pitcher Strikeouts', startTime: '2026-10-27T00:00:00Z',
    books: { prizepicks: { line: 5.5 } } };
  let pinNow = [{ line: 6.5, pOver: 0.5 }];
  const flagged = MB.plays([row], { pinFor: () => pinNow });
  const fairAt = (r, book, line) => MB.closeAt(r, line, pinNow)?.pOver ?? null;
  const pinAt = (r, kind) => { assert.ok(MB.KINDS.has(kind)); const m = MB.pinMain(pinNow); return { x: m.line, p: m.pOver }; };
  await tr.record({ rows: [row], flagged, fairAt, pinAt });
  const id = [...mem.keys()][0];
  assert.match(id, /\|mlb-pin$/, 'its own id: the same leg can sit in other kinds too');
  assert.equal(mem.get(id).signalPinLine, 6.5);
  // Pinnacle moves to 5.5 (toward the app's number) and prices it there before the start
  t = Date.parse('2026-10-26T23:40:00Z'); pinNow = [{ line: 5.5, pOver: 0.58 }];
  await tr.record({ rows: [row], flagged: [], fairAt, pinAt });
  t = Date.parse('2026-10-27T00:01:00Z');
  await tr.record({ rows: [row], flagged: [], fairAt, pinAt });
  const b = mem.get(id);
  assert.equal(b.status, 'locked');
  assert.equal(b.closePinLine, 5.5);
  assert.equal(b.pinExact, true);
  assert.equal(b.pinMove, 'toward');
  assert.equal(b.closePinEv, +((0.58 * (1 / 0.5503) - 1) * 100).toFixed(2));
  // out of the headline
  const sum = await tr.summary();
  assert.equal(sum.overall.signals, 0);
  assert.equal(sum.byKind['mlb-pin'].signals, 1);
});

test('tally: the pre-registered bar (50 graded, z 2)', () => {
  const legs = Array.from({ length: 60 }, (_, i) => ({ outcome: i < 42 ? 'win' : 'loss', signalDecimal: 1 / 0.5503 }));
  const t = MB.tally(legs, 0.5503);
  assert.equal(t.n, 60); assert.equal(t.w, 42); assert.ok(t.z >= 2); assert.equal(t.passes, true);
  assert.equal(MB.tally(legs.slice(0, 30), 0.5503).passes, false, 'under 50 never passes');
});

test('the MLB grader reads the MLB Stats API first, ESPN second', async () => {
  const calls = [];
  const http = { get: async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/schedule')) {
      assert.equal(opts.params.hydrate, 'team');
      return { data: { dates: [{ games: [{ gamePk: 776, gameDate: '2026-10-27T00:00:00Z', status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: { home: { team: { name: 'Tampa Bay Rays', abbreviation: 'TB', teamName: 'Rays', locationName: 'St. Petersburg', shortName: 'Tampa Bay' } }, away: { team: { name: 'Milwaukee Brewers', abbreviation: 'MIL', teamName: 'Brewers', locationName: 'Milwaukee', shortName: 'Milwaukee' } } } }] }] } };
    }
    if (url.endsWith('/game/776/boxscore')) return { data: box };
    throw new Error(`unexpected ${url}`);
  } };
  const g = SG.createSportsGrader({ http });
  const r = await g.grade({ sport: 'MLB', player: 'Christian Yelich', team: 'Milwaukee Brewers', matchTitle: 'MIL @ TB', mkey: 'total_bases', signalLine: 1.5, signalSide: 'Over', startTime: '2026-10-27T00:00:00Z' });
  assert.equal(r.outcome, 'win'); assert.equal(r.result, 7); assert.equal(r.source, 'mlb-statsapi');
  assert.ok(calls.every(u => u.includes('statsapi.mlb.com')), 'no ESPN call when the MLB API answers');
});

test('slips.js links a starter\'s strikeouts with the other team\'s hitters', () => {
  const k = { sport: 'MLB', market: 'Pitcher Strikeouts', side: 'Over', team: 'MIL' };
  assert.equal(SLIPS.pairLink(k, { sport: 'MLB', market: 'Hits+Runs+RBIs', side: 'Under', team: 'TB' }), 0.117);
  assert.equal(SLIPS.pairLink(k, { sport: 'MLB', market: 'Hitter Strikeouts', side: 'Over', team: 'TB' }), 0.231);
  assert.equal(SLIPS.pairLink(k, { sport: 'MLB', market: 'Hitter Strikeouts', side: 'Over', team: 'MIL' }), 0, 'teammates: not measured');
});

test('stacks: priced leg by leg, cleared only at the repriced payout', () => {
  const start = '2026-10-27T00:00:00Z';
  const rows = [
    { key: 'a', sport: 'MLB', player: 'Freddy Peralta', team: 'MIL', mkey: 'strikeouts', market: 'Pitcher Strikeouts', startTime: start, matchTitle: 'MIL @ TB', books: { prizepicks: { line: 5.5 } } },
    { key: 'b', sport: 'MLB', player: 'Yandy Diaz', team: 'TB', mkey: 'hits_runs_rbis', market: 'Hits+Runs+RBIs', startTime: start, matchTitle: 'MIL @ TB', books: { prizepicks: { line: 1.5 } } },
    { key: 'c', sport: 'MLB', player: 'Josh Lowe', team: 'TB', mkey: 'hitter_strikeouts', market: 'Hitter Strikeouts', startTime: start, matchTitle: 'MIL @ TB', books: { prizepicks: { line: 0.5 } } },
  ];
  const price = { a: 0.6, b: 0.55, c: 0.62 };
  const st = MB.stacks(rows, { priceOf: r => ({ pOver: r.key === 'b' ? 1 - price.b : price[r.key], source: 'pinnacle', exact: true }), slips: SLIPS });
  const three = st.find(x => x.players.length === 3 && x.app === 'prizepicks');
  assert.ok(three, 'a 3-pick stack');
  assert.equal(three.linked, 2);
  assert.ok(three.pLinked > three.pInd, 'the link raises the chance all hit');
  assert.ok(three.repriced < three.standard, 'and the app pays less for it');
  // at the repriced payout the link cancels: what independent legs are worth
  assert.ok(Math.abs(three.evRep - (three.pInd * 6 - 1) * 100) < 0.5);
  assert.equal(three.clears, three.pLinked * three.repriced > 1);
  // nothing priced: no stack
  assert.equal(MB.stacks(rows, { priceOf: () => null, slips: SLIPS }).length, 0);
});
