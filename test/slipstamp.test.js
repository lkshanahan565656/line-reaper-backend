// A slip checked at the moment it is logged (slipstamp.js): a started leg is
// refused in plain words, never kept to show LATE later; a leg on the board
// carries the server's time, the app's line and multiplier and Pinnacle's fair.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../slipstamp');

const NOW = Date.parse('2026-10-27T23:00:00Z');
const leg = (o = {}) => ({ player: 'Paolo Banchero', market: 'Points', side: 'Over', line: 22.5, sport: 'NBA', ...o });
const g = (start, o = {}) => ({ status: 'open', matched: { sport: 'NBA', player: 'Paolo Banchero', market: 'Points', start, matchTitle: 'MIA @ ORL' }, signalFair: 0.55, decimal: 1.78, trackedAt: new Date(NOW).toISOString(), ...o });

test('a leg whose game starts later is ok, with the app line, multiplier and Pinnacle fair', () => {
  const v = S.verdict(leg(), g('2026-10-27T23:30:00Z'), { now: NOW, extra: { appLine: 22.5, mult: null, pin: 0.541 } });
  assert.equal(v.status, 'ok');
  assert.equal(v.start, '2026-10-27T23:30:00Z');
  assert.equal(v.fair, 0.55); assert.equal(v.pin, 0.541); assert.equal(v.appLine, 22.5);
  assert.equal(v.moved, undefined);
  const m = S.verdict(leg(), g('2026-10-27T23:30:00Z'), { now: NOW, extra: { appLine: 23.5 } });
  assert.match(m.moved, /23\.5 now, not 22\.5/);
});

test('a leg whose game started is refused with the time in Eastern', () => {
  const v = S.verdict(leg(), g('2026-10-27T22:50:00Z'), { now: NOW });
  assert.equal(v.status, 'started');
  assert.match(v.why, /^Paolo Banchero Over 22\.5 Points: MIA @ ORL started at 6:50 PM ET\. A leg goes on your record only before its game starts\.$/);
  // the slip log's own 'before' and the browser's own start count too
  assert.equal(S.verdict(leg(), { status: 'nohistory', reason: 'before' }, { now: NOW }).status, 'started');
  assert.equal(S.verdict(leg({ start: '2026-10-27T22:00:00Z' }), { status: 'nohistory', reason: 'player' }, { now: NOW }).status, 'started');
  // a start exactly now has started
  assert.equal(S.verdict(leg(), g(new Date(NOW).toISOString()), { now: NOW }).status, 'started');
});

test('a leg no board lists can be logged, and says how its timing is checked', () => {
  const v = S.verdict(leg(), { status: 'nohistory', reason: 'player' }, { now: NOW });
  assert.equal(v.status, 'unmatched');
  assert.match(v.why, /isn't on any app's board right now/);
  assert.match(v.why, /shows LATE and isn't counted/);
  assert.equal(S.verdict(leg(), null, { now: NOW }).status, 'unmatched');
  assert.equal(S.verdict(leg(), { status: 'nohistory', reason: 'unread' }, { now: NOW }).status, 'unread');
});

test('the slip is refused when any leg started, and names each one', () => {
  const legs = [leg(), leg({ player: 'Bo Nix', market: 'Pass Yards', line: 220.5, sport: 'NFL' }), leg({ player: 'Nobody' })];
  const vs = [S.verdict(legs[0], g('2026-10-27T23:30:00Z'), { now: NOW }), S.verdict(legs[1], g('2026-10-27T22:00:00Z', { matched: { start: '2026-10-27T22:00:00Z', matchTitle: '' } }), { now: NOW }), S.verdict(legs[2], null, { now: NOW })];
  const out = S.stamp(legs, vs, { now: NOW });
  assert.equal(out.ok, false); assert.equal(out.started, 1); assert.equal(out.unmatched, 1);
  assert.equal(out.at, '2026-10-27T23:00:00.000Z');
  assert.match(out.why, /^Bo Nix Over 220\.5 Pass Yards: its game started at 6:00 PM ET/);
  assert.deepEqual(out.legs.map(l => l.status), ['ok', 'started', 'unmatched']);
  assert.equal(S.stamp([legs[0]], [vs[0]], { now: NOW }).ok, true);
});

test('times on another day carry the date', () => {
  assert.equal(S.etTime('2026-10-29T00:00:00Z', NOW), 'Oct 28, 8:00 PM ET');
  assert.equal(S.etTime('2026-10-27T23:30:00Z', NOW), '7:30 PM ET');
});

test('a request body is cleaned: sides in the apps\' words, at most 12 legs', () => {
  const c = S.cleanLegs({ app: 'PrizePicks', legs: [{ player: 'A', market: 'Points', side: 'More', line: '22.5', start: '2026-10-27T23:30:00Z' }, { player: 'B', market: 'Points', side: 'Lower', line: 3 }] });
  assert.equal(c.app, 'prizepicks');
  assert.deepEqual(c.legs.map(l => l.side), ['Over', 'Under']);
  assert.equal(c.legs[0].line, 22.5); assert.equal(c.legs[0].start, '2026-10-27T23:30:00.000Z');
  assert.ok(S.cleanLegs({ legs: [] }).error);
  assert.ok(S.cleanLegs({ legs: Array(13).fill({}) }).error);
});
