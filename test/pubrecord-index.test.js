// The public list of bettor records (pubrecord.indexRow/indexView/indexHtml).
// TEST DATA: every record below is made up here to exercise the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pubrecord');

const view = (handle, { apps = [], venues = [], onTime = 1, late = 0, proven = [], bProven = [] } = {}) => ({
  handle, status: 'live', publishedAt: '2026-10-27T00:00:00Z', counts: { slips: onTime + late, onTime, late, checking: 0 }, apps, proven,
  bets: { counts: { bets: 0, onTime: 0, late: 0, checking: 0 }, venues, proven: bProven },
});
const app = (appName, pinN, label, clv = 2, clvT = 1) => ({ appName, pinN, label, clv, clvT, graded: pinN });

test('proven only where the record itself is proven; best single kind shown, never pooled', () => {
  const a = P.indexRow(view('alpha', { apps: [app('PrizePicks', 30, 'building'), app('Underdog', 25, 'building')] }));
  assert.deepEqual(a.proven, []);
  assert.equal(a.top.name, 'PrizePicks'); assert.equal(a.top.n, 30);
  assert.equal(a.pinGraded, 55, 'the total is shown as a count, never as a label');
  const b = P.indexRow(view('bravo', { apps: [app('Underdog', 60, 'proven', 3.1, 2.4)], proven: ['Underdog'] }));
  assert.deepEqual(b.proven, ['Underdog']);
  const c = P.indexRow(view('charlie', { onTime: 0, late: 40 }));
  const idx = P.indexView([a, b, c]);
  assert.deepEqual(idx.rows.map(r => r.handle), ['bravo', 'alpha'], 'proven first; a record with only late picks is not listed');
  assert.equal(idx.hidden, 1);
  assert.equal(idx.proven, 1);
  const h = P.indexHtml(idx, { origin: 'https://x.example' });
  assert.match(h, /proven at Underdog/);
  assert.match(h, /30 of 50 legs at PrizePicks/);
  assert.ok(!/units|profit \$|undefined|NaN/i.test(h.replace(/no profit figures|for its units/g, '')));
});

test('a record can be taken off the list and put back by its owner only', async () => {
  const m = new Map();
  const store = { async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, JSON.parse(JSON.stringify(d))); } };
  const rs = P.createRecordStore({ store, random: n => Buffer.alloc(n, 9) });
  const { token } = await rs.publish({ handle: 'lister', who: 'a' });
  assert.deepEqual(rs.listedHandles(), ['lister']);
  await assert.rejects(rs.setListed('lister', 'lrr_nopenopenopenopenopenope', false), e => e.status === 403);
  await rs.setListed('lister', token, false);
  assert.deepEqual(rs.listedHandles(), []);
  assert.deepEqual(rs.liveHandles(), ['lister'], 'the record itself stays live');
  await rs.setListed('lister', token, true);
  assert.deepEqual(rs.listedHandles(), ['lister']);
});
