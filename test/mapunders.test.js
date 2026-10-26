// Map kill Unders (mapunders.js): Pinnacle's map anchor, the app sum and its
// flag, the model's play, and the record judged by match.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../mapunders');

const pts = (line, p) => [{ x: -line, p }];

test('ladderMean: a 50/50 line is its own mean; an over-favoured line sits above it', () => {
  assert.equal(M.ladderMean(pts(13.5, 0.5), 6), 13.5);
  assert.ok(M.ladderMean(pts(13.5, 0.6), 6) > 13.5);
  assert.ok(M.ladderMean(pts(13.5, 0.4), 6) < 13.5);
  assert.equal(M.ladderMean(pts(13.5, 0.95), 6), null, 'a lopsided point is not read');
  // mainOnly reads the point nearest 50/50
  assert.equal(M.ladderMean([{ x: -25.5, p: 0.7 }, { x: -27.5, p: 0.5 }], 8, { mainOnly: true }), 27.5);
});

test('pinAnchor: LoL team totals added, else the map total; CS rounds x kills a round', () => {
  const lol = new Map([['kills|1|tt|0', pts(14.5, 0.5)], ['kills|1|tt|1', pts(11.5, 0.5)], ['kills|2|total', pts(27.5, 0.5)]]);
  assert.deepEqual(M.pinAnchor(lol, 'LOL', 1), { kills: 26, teams: [14.5, 11.5], src: 'team totals' });
  assert.deepEqual(M.pinAnchor(lol, 'LOL', 2), { kills: 27.5, teams: null, src: 'map total' });
  assert.equal(M.pinAnchor(lol, 'LOL', 3), null);
  const cs = new Map([['rounds|1|total', pts(21.5, 0.5)]]);
  const a = M.pinAnchor(cs, 'CS', 1);
  assert.equal(a.rounds, 21.5);
  assert.equal(a.kills, Math.round(21.5 * 6.8 * 100) / 100);
  assert.equal(a.src, 'rounds');
});

const leg = (app, team, player, line, map = 1, matchId = 'm1') => ({ app, game: 'LOL', matchId, map, team, player, line });
const team = (app, t, lines, map) => lines.map((x, i) => leg(app, t, `${app}-${t}-${i}`, x, map));

test('flagGroups: both teams need 4+ players; the sum scales to five; under when Pinnacle sits below', () => {
  const anchor = () => ({ kills: 26, teams: [14, 12], src: 'team totals' });
  // PP: 5 + 4 players (the 4 scaled to five); UD: only 3 of one team, so no group
  const legs = [...team('PP', 0, [4.5, 3.5, 3, 2.5, 1], 1), ...team('PP', 1, [3.5, 3, 2.5, 2], 1),
    ...team('UD', 0, [4.5, 3.5, 3, 2.5], 1), ...team('UD', 1, [3.5, 3, 2.5], 1)];
  const g = M.flagGroups(legs, anchor);
  assert.equal(g.length, 1);
  assert.equal(g[0].app, 'PP');
  assert.deepEqual(g[0].teams.map(t => t.n), [5, 4]);
  assert.equal(g[0].teams[1].scaled, 13.75);
  assert.equal(g[0].appSum, 14.5 + 13.75);
  assert.equal(g[0].under, true);
  assert.equal(g[0].under5, true, '26 is 8% under 28.25');
  // a duplicate player (two picks of one player) counts once; Pinnacle above the sum is not flagged
  const g2 = M.flagGroups([...legs, leg('PP', 0, 'PP-0-0', 4.5)], () => ({ kills: 30, teams: null, src: 'map total' }));
  assert.deepEqual(g2[0].teams.map(t => t.n), [5, 4]);
  assert.equal(g2[0].under, false);
  // no anchor: no group; map 3 is never read
  assert.equal(M.flagGroups(legs, () => null).length, 0);
  assert.equal(M.flagGroups(team('PP', 0, [4, 4, 4, 4], 3).concat(team('PP', 1, [4, 4, 4, 4], 3)), anchor).length, 0);
});

test('priceGroup: a play needs our fair a point past the app break-even; a closed Under is skipped', () => {
  const g = { legs: [leg('PP', 0, 'a', 4.5), leg('PP', 0, 'b', 3.5), leg('PP', 1, 'c', 3), leg('PP', 1, 'd', 2.5)] };
  const fair = { a: 0.6, b: 0.555, c: null, d: 0.7 };
  const out = M.priceGroup(g, { model: l => fair[l.player], be: l => (l.player === 'd' ? null : 0.5503) });
  assert.equal(out.length, 3, 'd: the Under is closed');
  assert.deepEqual(out.map(x => x.model), [true, false, false]);
  assert.equal(out[2].fair, null);
  assert.equal(out[0].edge, 0.0497);
});

const row = (o) => ({ status: 'graded', game: 'LOL', appKey: 'PP', be: 0.5503, sport: 'LOL', matchTitle: 'T1 vs GEN', gameId: null, startTime: '2026-10-27T08:00:00Z', ...o });

test('mapRecord: units at break-even, matches counted, and 50 legs from 3 matches stay research', () => {
  const rows = [];
  for (let m = 0; m < 3; m++) for (let i = 0; i < 20; i++) rows.push(row({ matchTitle: `match ${m}`, outcome: i < 14 ? 'win' : 'loss' }));
  rows.push(row({ status: 'open', outcome: null }));
  const rec = M.mapRecord(rows);
  const c = rec.cells[0];
  assert.equal(c.graded, 60);
  assert.equal(c.wins, 42);
  assert.equal(c.matches, 3);
  assert.equal(c.open, 1);
  assert.equal(c.units, Math.round((42 * (1 / 0.5503 - 1) - 18) * 100) / 100);
  assert.equal(c.zMatch, null, 'z by match needs 5 matches');
  assert.equal(c.label, 'research, not an edge');
  assert.match(c.why, /3 matches \(needs 10\)/);
  assert.equal(c.profitShown, false);
});

test('mapRecord: a lead only at 50+ graded over 10+ matches with z by match at 2 and positive units', () => {
  const rows = [];
  // 12 matches, 5 legs each, 4 of 5 win in most, so the matches agree
  for (let m = 0; m < 12; m++) for (let i = 0; i < 5; i++) rows.push(row({ matchTitle: `m${m}`, outcome: i < (m % 4 === 0 ? 3 : 4) ? 'win' : 'loss' }));
  const c = M.mapRecord(rows).cells[0];
  assert.equal(c.graded, 60);
  assert.equal(c.matches, 12);
  assert.ok(c.zMatch >= 2, `z by match ${c.zMatch}`);
  assert.equal(c.label, 'lead: re-check before any bet');
  assert.equal(c.profitShown, true);
  // the same legs on one app each never pool across apps
  const two = M.mapRecord([...rows, ...rows.slice(0, 5).map(r => ({ ...r, appKey: 'UD' }))]);
  assert.equal(two.cells.length, 2);
  assert.equal(two.cells.find(x => x.app === 'UD').label, 'research, not an edge');
});
