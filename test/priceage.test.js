'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../priceage');

test('each venue gets its age and a stale flag from its own stale mark', () => {
  const now = Date.parse('2026-10-28T15:00:00Z');
  const out = P.build([
    { key: 'kalshi', name: 'Kalshi', at: now - 8000, staleMs: 30e3, via: 'stream' },
    { key: 'fanduel', name: 'FanDuel', at: new Date(now - 6 * 60e3).toISOString(), staleMs: 5 * 60e3 },
    { key: 'gemini', name: 'Gemini', at: null, staleMs: 6 * 60e3 },
    { key: 'pinnacle', name: 'Pinnacle', at: 0 },
  ], now);
  assert.equal(out.now, '2026-10-28T15:00:00.000Z');
  assert.deepEqual(out.venues.kalshi, { name: 'Kalshi', at: '2026-10-28T14:59:52.000Z', ageSec: 8, staleSec: 30, stale: false, via: 'stream' });
  assert.equal(out.venues.fanduel.ageSec, 360);
  assert.equal(out.venues.fanduel.stale, true);
  assert.equal(out.venues.gemini.ageSec, null);
  assert.equal(out.venues.gemini.stale, true, 'never read is stale, not fresh');
  assert.equal(out.venues.pinnacle.at, null, 'a zero time is no read');
});

test('ages read short: seconds, minutes, hours, days', () => {
  assert.deepEqual([8, 59, 60, 200, 3599, 3600, 7300, 200000, null].map(P.fmtAge), ['8s', '59s', '1m', '3m', '59m', '1h', '2h', '2d', '—']);
});

test('the title says what the age means and when it is stale', () => {
  assert.equal(P.describe({ name: 'Kalshi', ageSec: 8, staleSec: 30, via: 'stream' }), 'Kalshi last answered 8 s ago (live stream)');
  assert.equal(P.describe({ name: 'FanDuel', ageSec: 400, staleSec: 300 }), 'FanDuel last answered 6 min ago: stale, older than 5 min');
  assert.equal(P.describe(null), 'No read of this venue yet');
});
