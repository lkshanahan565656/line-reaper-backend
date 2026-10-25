const test = require('node:test');
const assert = require('node:assert/strict');
const { createCreditBudget, msUntilReset, oddsCost, pickPollSport } = require('../quota');

const DAY = 86400000;

test('cost is markets × regions', () => {
  assert.equal(oddsCost('h2h,spreads,totals', 'us'), 3);
  assert.equal(oddsCost('h2h,spreads,totals', 'us,us2,us_ex'), 9);
});

test('time until reset handles month ends and reset days', () => {
  assert.equal(msUntilReset(Date.UTC(2026, 9, 31, 0, 0)), DAY);                    // Oct 31 → Nov 1
  assert.equal(msUntilReset(Date.UTC(2026, 9, 10), 15), 5 * DAY);                  // before reset day
  assert.equal(msUntilReset(Date.UTC(2026, 9, 20), 15), 26 * DAY);                 // after: next month's 15th
  assert.equal(msUntilReset(Date.UTC(2027, 0, 31), 31), 28 * DAY);                 // Feb has no 31st
});

test('off by default on a big plan, on by itself for the free plan', () => {
  const b = createCreditBudget({ now: () => Date.UTC(2026, 9, 1) });
  assert.equal(b.active(), false);
  b.noteHeaders({ 'x-requests-remaining': '19000', 'x-requests-used': '1000' });
  assert.equal(b.active(), false);
  for (let i = 0; i < 50; i++) assert.ok(b.take(3).ok);
  b.noteHeaders({ 'x-requests-remaining': '480', 'x-requests-used': '20' });
  assert.equal(b.active(), true);
  assert.equal(b.state().reason, 'free plan detected');
  const off = createCreditBudget({ setting: 'off' });
  off.noteHeaders({ 'x-requests-remaining': '480', 'x-requests-used': '20' });
  assert.equal(off.active(), false);
});

test('spreads the remaining credits evenly over the month', () => {
  let t = Date.UTC(2026, 9, 1);
  const b = createCreditBudget({ setting: '500', now: () => t });
  // 500 credits minus a 5% reserve over 31 days ≈ 15.3 credits a day ≈ 5 calls of 3
  assert.ok(Math.abs(b.state().creditsPerDay - 475 / 31) < 0.2);
  let calls = 0;
  for (let m = 0; m < 31 * 24 * 60; m += 2) {          // someone asks every 2 minutes all month
    t = Date.UTC(2026, 9, 1) + m * 60000;
    if (b.take(3).ok) calls++;
  }
  assert.ok(calls * 3 <= 475, `spent ${calls * 3}`);
  assert.ok(calls * 3 >= 420, `only spent ${calls * 3}`);
  assert.ok(b.state().skippedCalls > 10000);
});

test('waits for the reset once credits run out', () => {
  const t = Date.UTC(2026, 9, 20);
  const b = createCreditBudget({ now: () => t });
  b.noteHeaders({ 'x-requests-remaining': '20', 'x-requests-used': '480' });
  const c = b.check(3);
  assert.equal(c.ok, false);                             // 20 left is inside the 25-credit reserve
  assert.equal(c.waitMs, 12 * DAY);
});

test('first call goes straight through, the next waits its turn', () => {
  let t = Date.UTC(2026, 9, 1);
  const b = createCreditBudget({ setting: '500', now: () => t });
  assert.ok(b.take(3).ok);
  const c = b.take(3);
  assert.equal(c.ok, false);
  assert.ok(c.waitMs > 4 * 3600000 && c.waitMs < 5 * 3600000, `${c.waitMs / 3600000}h`);
  t += c.waitMs;
  assert.ok(b.take(3).ok);
});

test('the call that reveals a free plan still paces the next one', () => {
  const t = Date.UTC(2026, 9, 1);
  const b = createCreditBudget({ now: () => t });
  assert.ok(b.take(3).ok);
  b.noteHeaders({ 'x-requests-remaining': '497', 'x-requests-used': '3' });
  assert.equal(b.take(3).ok, false);
});

test('sportsbook poller: the biggest slate soonest, weighted by time since its last pull', () => {
  const now = Date.parse('2026-10-12T12:00:00Z'), h = 3600e3;
  // nothing starting soon anywhere: no pull
  assert.equal(pickPollSport([{ sport: 'nfl', games: 0, lastAt: null }], now), null);
  // never pulled counts as 6 hours old: 14 NFL games beat 10 NHL games
  assert.equal(pickPollSport([{ sport: 'nhl', games: 10, lastAt: null }, { sport: 'nfl', games: 14, lastAt: null }], now), 'nfl');
  // NFL pulled an hour ago (1 × 14) loses to NHL untouched for 3 hours (3 × 10)
  assert.equal(pickPollSport([{ sport: 'nfl', games: 14, lastAt: now - h }, { sport: 'nhl', games: 10, lastAt: now - 3 * h }], now), 'nhl');
  // age caps at 6 hours, so a day-old 2-game slate can't starve a 14-game one pulled 2 hours ago
  assert.equal(pickPollSport([{ sport: 'mma', games: 2, lastAt: now - 24 * h }, { sport: 'nfl', games: 14, lastAt: now - 2 * h }], now), 'nfl');
});
