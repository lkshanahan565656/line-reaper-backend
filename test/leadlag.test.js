const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeadLag, groupOf } = require('../leadlag');

const T0 = Date.parse('2026-10-26T12:00:00Z');
const START = '2026-10-26T20:00:00Z';
const am = p => (p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
const cell = (venue, p) => ({ venue, american: am(p), decimal: 1 / p, lineDiffers: false });
// one moneyline: Kalshi's and Polymarket US's cost to take each side
function screen({ kh, ka, ph, pa, fair = 0.55, start = START }) {
  return { games: [{ id: 'pin-1', league: 'nba', start, home: 'Boston Celtics', away: 'New York Knicks', markets: [{ key: 'ml', point: null, sides: [
    { name: 'Boston Celtics', fair, venues: [cell('pinnacle', fair), ...(kh ? [cell('kalshi', kh)] : []), ...(ph ? [cell('polymarketus', ph)] : [])] },
    { name: 'New York Knicks', fair: 1 - fair, venues: [cell('pinnacle', 1 - fair), ...(ka ? [cell('kalshi', ka)] : []), ...(pa ? [cell('polymarketus', pa)] : [])] },
  ] }] }] };
}
const min = n => T0 + n * 60e3;

test('Kalshi moves, Polymarket US has not: flags the Polymarket US side Kalshi moved toward, after the hold', () => {
  const ll = createLeadLag();
  assert.deepEqual(ll.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49 }), min(0)), []);
  // Kalshi: Boston 52c → 57c, Knicks 50c → 45c; Polymarket US unchanged
  assert.deepEqual(ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.53, pa: 0.49 }), min(2)), []);
  assert.equal(ll.stats().moves, 1);
  assert.deepEqual(ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.53, pa: 0.49 }), min(4)), []);   // inside the hold
  const out = ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.535, pa: 0.49 }), min(5));
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.book, 'polymarketus');
  assert.equal(r.side, 'Boston Celtics');
  assert.equal(r.group, 'newyorkknicks@bostonceltics|2026-10-26|h2h');
  assert.equal(r.market, 'h2h');
  assert.equal(r.event, 'New York Knicks @ Boston Celtics');
  assert.equal(r.source, 'kalshi-lead');
  assert.equal(r.sport, 'nba');
  assert.ok(Math.abs(r.decimal - 1 / 0.535) < 1e-9);
  assert.equal(r.fairProb, 55);
  assert.equal(r.lead.from, 0.52);
  assert.equal(r.lead.to, 0.57);
  // one flag a side an hour
  assert.deepEqual(ll.observe(screen({ kh: 0.62, ka: 0.40, ph: 0.535, pa: 0.49 }), min(8)), []);
});

test('no flag when Polymarket US followed, when Kalshi gave the move back, or when only one side of Kalshi moved', () => {
  let ll = createLeadLag();
  ll.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49 }), min(0));
  ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.53, pa: 0.49 }), min(2));
  assert.deepEqual(ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.56, pa: 0.46 }), min(5)), []);   // followed 3c of 5c
  assert.equal(ll.stats().dropped.followed, 1);

  ll = createLeadLag();
  ll.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49 }), min(0));
  ll.observe(screen({ kh: 0.57, ka: 0.45, ph: 0.53, pa: 0.49 }), min(2));
  assert.deepEqual(ll.observe(screen({ kh: 0.53, ka: 0.49, ph: 0.53, pa: 0.49 }), min(5)), []);   // back to 53c
  assert.equal(ll.stats().dropped.gaveBack, 1);

  ll = createLeadLag();
  ll.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49 }), min(0));
  ll.observe(screen({ kh: 0.57, ka: 0.50, ph: 0.53, pa: 0.49 }), min(2));   // Boston's ask only: a thin book, not a move
  assert.equal(ll.stats().moves, 0);
});

test('a move slower than the window, a small move, and a started game are not flagged', () => {
  const ll = createLeadLag();
  ll.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49 }), min(0));
  ll.observe(screen({ kh: 0.54, ka: 0.48, ph: 0.53, pa: 0.49 }), min(6));
  ll.observe(screen({ kh: 0.555, ka: 0.465, ph: 0.53, pa: 0.49 }), min(12));   // 1.5c in the last 10 minutes
  assert.equal(ll.stats().moves, 0);
  const started = createLeadLag();
  const past = '2026-10-26T11:00:00Z';
  started.observe(screen({ kh: 0.52, ka: 0.50, ph: 0.53, pa: 0.49, start: past }), min(0));
  started.observe(screen({ kh: 0.60, ka: 0.42, ph: 0.53, pa: 0.49, start: past }), min(2));
  assert.equal(started.stats().moves, 0);
});

test('groupOf: the +EV screen names for spreads and totals', () => {
  const g = { home: 'Boston Celtics', away: 'New York Knicks', start: START };
  assert.deepEqual(groupOf(g, { key: 'spread', point: -4.5 }, { name: 'Boston Celtics' }),
    { group: 'newyorkknicks@bostonceltics|2026-10-26|spreads|-4.5', side: 'Boston Celtics -4.5', market: 'spreads', point: -4.5 });
  assert.deepEqual(groupOf(g, { key: 'spread', point: -4.5 }, { name: 'New York Knicks' }),
    { group: 'newyorkknicks@bostonceltics|2026-10-26|spreads|-4.5', side: 'New York Knicks +4.5', market: 'spreads', point: 4.5 });
  assert.deepEqual(groupOf(g, { key: 'total', point: 221.5 }, { name: 'Over' }),
    { group: 'newyorkknicks@bostonceltics|2026-10-26|totals|221.5', side: 'Over', market: 'totals', point: 221.5 });
});
