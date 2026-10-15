const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../slips');
const E = require('../esslips');
const { createTracker, createMemoryStore } = require('../tracker');

const NOW = Date.parse('2026-10-15T06:00:00Z');
const normalizeName = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// the server's parseMapSpan, for the spans these tests use
function parseMapSpan(t) {
  const m = String(t || '').toUpperCase().replace(/(\d)\s+(\d)/g, '$1+$2').match(/(?:MAPS?|GAMES?)\s*([\d\s+\-–]+)/);
  if (!m) return { count: 1, label: '1' };
  const nums = m[1].replace(/\s+/g, '').split(/[+\-–]/).map(n => parseInt(n)).filter(Number.isFinite);
  return nums.length > 1 ? { count: Math.max(...nums) - Math.min(...nums) + 1, label: `${Math.min(...nums)}-${Math.max(...nums)}` } : { count: 1, label: String(nums[0] || 1) };
}

// WBT's DemQQ in two Bo1s on one day, one board pick per match (esmatch.js)
const pick = (o = {}) => ({ sport: 'CS', player: 'DemQQ', team: 'WBT', market: 'MAP 1 Kills', displayMarket: 'MAP 1 Kills', lineSource: 'pp', ppLine: 15.5, udLine: 14.5, sleeperLine: null,
  startTime: '2026-10-15T12:00:00Z', matchTitle: 'WBT vs ENCE', gameId: 'g1', matchTag: '2026-10-15T12:00:00.000Z', marketPred: 15.2,
  context: { opponent: 'ENCE' }, udSides: { over: 1, under: 1, overOpen: true, underOpen: true }, ...o });
const ence = pick();
const bojong = pick({ ppLine: 16, udLine: 16.5, startTime: '2026-10-15T16:00:00Z', matchTitle: 'WBT vs BOJONG', gameId: 'g2', matchTag: '2026-10-15T16:00:00.000Z', context: { opponent: 'BOJONG' } });
const leg = (o = {}) => ({ id: 'l1', app: 'prizepicks', sport: 'CS', player: 'DemQQ', market: 'Kills on Map 1', side: 'Over', line: 15.5, betAt: '2026-10-15T05:30:00Z', ...o });
const m = (l, picks) => E.matchEsLeg({ ...l, side: l.side.toUpperCase() }, picks, { now: NOW, normalizeName, parseMapSpan });

test('a slip line names its opponent and keeps a map span with a dash', () => {
  const { slips } = S.parseSlips('Underdog 2-pick\nDemQQ Over 14.5 MAPS 1-2 Kills (CS) vs ENCE\nNiKo u24.5 Headshots CS @ Vitality', { now: NOW });
  assert.deepEqual(slips[0].legs.map(l => [l.player, l.side, l.line, l.market, l.sport, l.opp]), [
    ['DemQQ', 'Over', 14.5, 'MAPS 1-2 Kills', 'CS', 'ENCE'], ['NiKo', 'Under', 24.5, 'Headshots', 'CS', 'Vitality']]);
  const reqs = S.gradeRequest(slips, undefined, {});
  assert.equal(reqs[0].opp, 'ENCE');
  assert.notEqual(S.legKey(slips[0], { ...slips[0].legs[0], opp: 'BOJONG' }), S.legKey(slips[0], slips[0].legs[0]));
});

test('two same-day matches: the opponent decides, else the posted line, marked uncertain', () => {
  const picks = [ence, bojong];
  assert.equal(m(leg({ opp: 'BOJONG', line: 16 }), picks).pick, bojong);
  assert.equal(m(leg({ opp: 'ENCE', line: 16 }), picks).pick, ence, 'the opponent beats the line');
  assert.equal(m(leg({ opp: 'ENCE' }), picks).uncertain, false);
  const byLine = m(leg({ line: 16 }), picks);
  assert.equal(byLine.pick, bojong);
  assert.equal(byLine.uncertain, true);
  assert.equal(m(leg({ line: 16.5, app: 'underdog' }), picks).pick, bojong, 'Underdog\'s own line');
  // no opponent and a line neither match posts: no guess
  assert.deepEqual([m(leg({ line: 20.5 }), picks).reason, m(leg({ line: 20.5 }), picks).near], ['match', ['ENCE', 'BOJONG']]);
  // an opponent that fits neither
  assert.equal(m(leg({ opp: 'Vitality' }), picks).reason, 'match');
  // the same line in both matches: still no guess
  assert.equal(m(leg(), [ence, { ...bojong, ppLine: 15.5 }]).reason, 'match');
});

test('one match needs no opponent; stat and map span must fit; a player not listed is no history', () => {
  assert.equal(m(leg(), [ence]).pick, ence);
  assert.equal(!!m(leg(), [ence]).uncertain, false);
  assert.equal(m(leg({ market: 'Headshots on Map 1' }), [ence]).reason, 'market');
  assert.equal(m(leg({ market: 'Maps 1-2 Kills' }), [ence]).reason, 'market');
  assert.equal(m(leg({ market: 'Deaths' }), [ence]).reason, 'market');
  assert.equal(m(leg({ market: 'Fantasy Score' }), [ence]).reason, 'market');
  assert.equal(m(leg({ player: 'NiKo' }), [ence]).reason, 'player');
  assert.equal(m(leg({ sport: 'LOL' }), [ence]).reason, 'player');
  assert.equal(m(leg({ betAt: '2026-10-01T00:00:00Z' }), [ence]).reason, 'player', 'a bet from long before the match');
  // maps 1-2 and map 1 on the same player: the text names the span
  const two = pick({ market: 'MAPS 1-2 Kills', displayMarket: 'MAPS 1-2 Kills', ppLine: 31.5, udLine: 31 });
  assert.equal(m(leg({ market: 'MAPS 1-2 Kills', line: 31.5 }), [ence, two]).pick, two);
  assert.equal(m(leg({ market: 'Kills', line: 31.5 }), [ence, two]).pick, two, 'no span named: the line picks it');
  assert.equal(m(leg({ market: 'Kills', line: 20 }), [ence, two]).reason, 'market');
});

test('a leg is priced at its own line and the app\'s payout, followed to the close and graded', async () => {
  let t = NOW;
  const tracker = createTracker({ store: createMemoryStore(), normalizeName, parseMapSpan, minEv: -1000, idSuffix: p => p.slipKey, now: () => t,
    // a mean of 15.2 kills: the chance of over at a line, 0.5 at 15.2, falling a point a kill
    fairProb: (p, line, side) => { const over = Math.max(0.02, Math.min(0.98, 0.5 - (line - p.marketPred) * 0.06)); return side === 'OVER' ? over : 1 - over; },
    graders: { CS: async () => ({ maps: { 1: 18 }, complete: true }) }, gradeAfterMs: 0 });
  const log = E.createEsSlipLog({ tracker, normalizeName, parseMapSpan, now: () => t });
  const picks = [ence, bojong];
  const legs = [leg({ id: 'a', opp: 'ENCE' }), leg({ id: 'b', opp: 'ENCE', app: 'underdog', line: 14.5, side: 'Under' }), leg({ id: 'c', line: 16 }), leg({ id: 'd', player: 'Nobody' })];
  const first = await log.grade(legs, { picks });
  assert.equal(first.results.a.status, 'open');
  assert.equal(first.results.a.matched.matchTitle, 'WBT vs ENCE');
  assert.equal(first.results.a.decimal, S.legDecimal('prizepicks'));
  assert.equal(first.results.a.signalFair, 0.482, 'over 15.5 at a 15.2 mean');
  assert.equal(first.results.b.signalFair, 0.458, 'the under at 14.5');
  assert.equal(first.results.b.decimal, S.legDecimal('underdog'), 'Underdog at 1.0x pays its break-even');
  assert.equal(first.results.c.matched.matchTitle, 'WBT vs BOJONG');
  assert.equal(first.results.c.matchUncertain, true, 'no opponent named');
  assert.equal(first.results.d.reason, 'player');
  // the same legs again are the same rows, never new ones
  assert.equal((await tracker.list({ limit: 99 })).length, 3);
  assert.equal((await log.grade(legs, { picks })).results.a.trackedAt, first.results.a.trackedAt);
  // two users on the same ticket share one row; another line is another row
  await log.grade([leg({ id: 'e', opp: 'ENCE', line: 16.5 })], { picks });
  assert.equal((await tracker.list({ limit: 99 })).length, 4);

  // the board moves: ENCE's mean falls to 14.2, PrizePicks moves its line to 15
  t += 60 * 60e3;
  await log.follow([{ ...ence, marketPred: 14.2, ppLine: 15, lineLeg: 1 }, bojong]);
  const mid = await log.grade([leg({ id: 'a', opp: 'ENCE' })], { picks });
  assert.equal(mid.results.a.closeFair, 0.422, 'the same ticket at the new mean');
  assert.equal(mid.results.a.appClose, 15);
  assert.equal(mid.results.a.lineMove, -0.5, 'the over lost half a kill');
  assert.ok(mid.results.a.evNow < 0);

  // the match starts and the stats come in
  t = Date.parse('2026-10-15T12:00:00Z') + 60e3;
  await tracker.lockStarted();
  const locked = await log.grade([leg({ id: 'a', opp: 'ENCE' })], { picks });
  assert.equal(locked.results.a.status, 'locked');
  assert.equal(locked.results.a.closeEv, Math.round((0.422 * S.legDecimal('prizepicks') - 1) * 1e4) / 100);
  assert.equal(locked.results.a.closeOk, false, 'the last read was an hour before the match began');
  t += 3 * 3600e3;
  await tracker.gradeDue();
  const done = await log.grade([leg({ id: 'a', opp: 'ENCE' }), leg({ id: 'b', opp: 'ENCE', app: 'underdog', line: 14.5, side: 'Under' })], { picks });
  assert.equal(done.results.a.status, 'graded');
  assert.equal(done.results.a.outcome, 'win', '18 kills over 15.5');
  assert.equal(done.results.a.result, 18);
  assert.equal(done.results.b.outcome, 'loss', '18 kills against an under 14.5');
  assert.equal(done.results.a.final, true);
  // a leg that arrives after the match began has no line history
  const late = await log.grade([leg({ id: 'z', opp: 'ENCE', line: 17.5, betAt: '2026-10-15T11:00:00Z' })], { picks: [{ ...ence }] });
  assert.equal(late.results.z.reason, 'before');
});
