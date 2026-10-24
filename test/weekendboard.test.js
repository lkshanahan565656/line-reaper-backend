// The weekend board: the NFL Sunday recorder with several leagues in one log
const test = require('node:test');
const assert = require('node:assert');
const NS = require('../nflsunday');

const START = Date.parse('2026-10-25T23:00:00Z');
const H = 3600e3;

test('tagged keys carry the sport, so the same name in two leagues stays apart', () => {
  const lines = [
    { book: 'underdog', sport: 'NBA', player: 'Jalen Williams', market: 'Points', line: 20.5, overMultiplier: 1, underMultiplier: 1, startTime: '2026-10-25T23:00:00Z' },
  ];
  const nba = NS.appEntries(lines, 'NBA', { tag: true });
  assert.deepStrictEqual([...nba.keys()], ['NBA|jalenwilliams|points']);
  assert.strictEqual(nba.get('NBA|jalenwilliams|points').m.sp, 'NBA');
  const untagged = NS.appEntries([{ ...lines[0], sport: 'NFL', market: 'Receiving Yards' }]);
  assert.deepStrictEqual([...untagged.keys()], ['jalenwilliams|rec_yds']);   // NFL alone keeps PR 198's keys
  const pin = NS.bookEntries([{ player: 'Jalen Williams', mkey: 'points', line: 20.5, over: -110, under: -110, start: '2026-10-25T23:00:00Z' }], { sport: 'NBA', tag: true });
  assert.deepStrictEqual([...pin.keys()], ['NBA|jalenwilliams|points']);
});

test('one league read drops only its own keys from the log', () => {
  const out = [];
  const log = NS.createChangeLog(o => out.push(o));
  log.observe('prizepicks', new Map([['NBA|a|points', { v: [20.5], m: {} }]]), 1, { scope: 'NBA|' });
  log.observe('prizepicks', new Map([['CFB|b|pass_yds', { v: [250.5], m: {} }]]), 2, { scope: 'CFB|' });
  assert.ok(!out.some(o => o.gone));
  log.observe('prizepicks', new Map(), 3, { scope: 'NBA|' });
  assert.deepStrictEqual(out.filter(o => o.gone).map(o => o.k), ['NBA|a|points']);
});

test('FanDuel rungs are kept raw by player and stat', () => {
  const games = [{ commence_time: '2026-10-25T23:00:00Z', bookmakers: [{ key: 'fanduel', markets: [], ladders: [
    { player: 'Jalen Williams', mkey: 'pts_rebs', line: 24.5, price: 120 }, { player: 'Jalen Williams', mkey: 'pts_rebs', line: 29.5, price: 260 }] }] }];
  const r = NS.rungEntries(games, 'fanduel', { sport: 'NBA', tag: true });
  assert.deepStrictEqual(r.get('NBA|jalenwilliams|pts_rebs').v, [[24.5, 120], [29.5, 260]]);
});

function board() {
  const st = '2026-10-25T23:00:00.000Z';
  const recs = [];
  // NBA: Sleeper combo leg 30.5 at 1.8x/1.9x, FanDuel and BetRivers hang 30.5 too
  recs.push({ t: START - 5 * H, s: 'sleeper', k: 'NBA|jw|pts_rebs', v: [30.5, 1.8, 1.9, 1, 1], m: { p: 'JW', tm: 'OKC', st, mt: 'OKC @ DEN', mkey: 'pts_rebs', sp: 'NBA' } });
  recs.push({ t: START - 4 * H, s: 'fanduel', k: 'NBA|jw|pts_rebs', v: [[30.5, -150, 120]], m: { p: 'JW', st, mkey: 'pts_rebs', sp: 'NBA' } });
  recs.push({ t: START - 4 * H, s: 'betrivers', k: 'NBA|jw|pts_rebs', v: [[30.5, -140, 110]], m: { p: 'JW', st, mkey: 'pts_rebs', sp: 'NBA' } });
  // NBA: PrizePicks points 20.5 with Pinnacle at 20.5
  recs.push({ t: START - 5 * H, s: 'prizepicks', k: 'NBA|jw|points', v: [20.5, null, null, 1, 1], m: { p: 'JW', tm: 'OKC', st, mt: 'DEN', mkey: 'points', sp: 'NBA' } });
  recs.push({ t: START - 3 * H, s: 'pinnacle', k: 'NBA|jw|points', v: [[20.5, -105, -115]], m: { p: 'JW', st, mkey: 'points', sp: 'NBA' } });
  // CFB: QB and his receiver on PrizePicks
  const cst = '2026-10-25T19:30:00.000Z', cs = Date.parse(cst);
  recs.push({ t: cs - 5 * H, s: 'prizepicks', k: 'CFB|qb|pass_yds', v: [240.5, null, null, 1, 1], m: { p: 'QB', tm: 'TEX', st: cst, mt: 'UGA', mkey: 'pass_yds', sp: 'CFB' } });
  recs.push({ t: cs - 5 * H, s: 'prizepicks', k: 'CFB|wr|rec_yds', v: [70.5, null, null, 1, 1], m: { p: 'WR', tm: 'TEX', st: cst, mt: 'UGA', mkey: 'rec_yds', sp: 'CFB' } });
  return recs;
}

test('the weekend summary groups by sport and fills the pre-registered slices', () => {
  const { series, meta } = NS.replay(board());
  const legs = NS.buildLegs(series, meta);
  assert.deepStrictEqual([...new Set(legs.map(l => l.sport))].sort(), ['CFB', 'NBA']);
  const results = new Map([['sleeper|NBA|jw|pts_rebs', { result: 33 }], ['prizepicks|NBA|jw|points', { result: 18 }],
    ['prizepicks|CFB|qb|pass_yds', { result: 260 }], ['prizepicks|CFB|wr|rec_yds', { result: 90 }]]);
  const rep = NS.summarize(legs, results, { bySport: true });
  // (a) Pinnacle at the app's number, Overs and Unders apart
  assert.deepStrictEqual([rep.byKind['NBA|prizepicks|pin-same-over'].n, rep.byKind['NBA|prizepicks|pin-same-over'].w], [1, 0]);
  assert.deepStrictEqual([rep.byKind['NBA|prizepicks|pin-same-under'].n, rep.byKind['NBA|prizepicks|pin-same-under'].w], [1, 1]);
  // (b) Sleeper combos the books price: both sides; backed = the Over only (books ~58% vs 1/1.8 = 55.6%)
  assert.strictEqual(rep.byKind['NBA|sleeper|sl-combo-books'].n, 2);
  const backed = rep.byKind['NBA|sleeper|sl-combo-books-backed'];
  assert.deepStrictEqual([backed.n, backed.w], [1, 1]);
  // (c) CFB QB Over + own receiver Over
  assert.deepStrictEqual([rep.stacks.CFB.pairs, rep.stacks.CFB.both], [1, 1]);
  assert.strictEqual(rep.stacks.NBA.pairs, 0);
  const txt = NS.reportText(rep, { title: 'Weekend board' });
  assert.match(txt, /CFB PP QB pass Over \+ own receiver Over: 1 of 1 pairs/);
  assert.match(txt, /NBA\|sleeper\|sl-combo-books-backed/);
});
