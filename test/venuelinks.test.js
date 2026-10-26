// Tap-to-venue links: every priced row opens its venue (exact market where
// the id gives one, else the venue's board), never polymarket.com, never a
// stake; taps are counted per venue and day only.
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../venuelinks');

test('Kalshi: the event page from a market ticker', () => {
  assert.equal(v.kalshiEvent('KXNFLSPREAD-26OCT25NYGHOU-HOU18'), 'kxnflspread-26oct25nyghou');
  assert.equal(v.kalshiEvent('KXNFLGAME-26OCT25NYGHOU'), 'kxnflgame-26oct25nyghou');
  assert.equal(v.kalshiEvent('not a ticker'), null);
  const l = v.link('kalshi', { ticker: 'KXNFLSPREAD-26OCT25NYGHOU-HOU18' });
  assert.equal(l.href, 'https://kalshi.com/markets/kxnflspread-26oct25nyghou');
  assert.equal(l.exact, true);
  assert.equal(l.label, 'KALSHI ↗');
});

test('Polymarket US: the event page on polymarket.us, never polymarket.com', () => {
  assert.deepEqual(v.pmusEvent('aec-nfl-lar-lv-2026-10-25'), { league: 'nfl', event: 'nfl-lar-lv-2026-10-25' });
  assert.deepEqual(v.pmusEvent('tsc-nfl-pit-no-2026-10-25-total-42pt5'), { league: 'nfl', event: 'nfl-pit-no-2026-10-25' });
  assert.equal(v.pmusEvent('nope'), null);
  const l = v.link('polymarketus', { id: 'aec-nfl-lar-lv-2026-10-25' });
  assert.equal(l.href, 'https://polymarket.us/sports/nfl/nfl-lar-lv-2026-10-25');
  assert.equal(l.exact, true);
  // a polymarket.com URL from anywhere is never used
  const bad = v.link('polymarketus', { url: 'https://polymarket.com/event/x' });
  assert.ok(!/polymarket\.com/.test(bad.href));
  assert.equal(v.validFor('polymarketus', 'https://polymarket.com/event/x'), false);
  assert.equal(v.hostAllowed('https://polymarket.com/'), false);
  assert.ok(!v.allHosts().some(h => h === 'polymarket.com' || h.endsWith('.polymarket.com')));
});

test('pick\'em apps and books without an exact link get a labelled board link', () => {
  for (const k of ['prizepicks', 'underdog', 'sleeper', 'pick6', 'gemini', 'fanduel', 'betrivers']) {
    const l = v.link(k, { player: 'Player X', what: 'Player X Over 20.5' });
    assert.ok(l, k);
    assert.equal(l.exact, false, k);
    assert.match(l.label, /BOARD ↗$/, k);
    assert.ok(v.validFor(k, l.href), `${k} ${l.href}`);
    assert.ok(/^https:\/\//.test(l.href), k);
    assert.ok(!/stake|amount|wager|size=/i.test(l.href), `${k}: no prefilled stake`);
  }
});

test('a server URL is kept only on the venue\'s own host; a bare home page is a board', () => {
  assert.equal(v.link('fanduel', { url: 'https://sportsbook.fanduel.com/' }).exact, false);
  assert.equal(v.link('kalshi', { url: 'https://kalshi.com/markets/kxnbagame-26oct25' }).exact, true);
  const off = v.link('kalshi', { url: 'https://evil.example/kalshi', ticker: 'KXA-B' });
  assert.equal(off.href, 'https://kalshi.com/markets/kxa-b');
});

test('reference books and unknown venues get no link', () => {
  assert.equal(v.link('pinnacle', {}), null);
  assert.equal(v.link('matchbook', {}), null);
  assert.equal(v.link('nowhere', {}), null);
});

test('tap counter: per venue and day, exact vs board, nothing about who', () => {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const c = v.createTapCounter({ now: () => t, days: 2 });
  assert.equal(c.tap('kalshi', true), true);
  assert.equal(c.tap('prizepicks', false), true);
  assert.equal(c.tap('nowhere', true), false);
  assert.equal(c.tap('pinnacle', false), false);
  let s = c.state();
  assert.equal(s.total, 2);
  assert.deepEqual(s.byVenue.kalshi, { exact: 1, board: 0, total: 1 });
  assert.deepEqual(s.byVenue.prizepicks, { exact: 0, board: 1, total: 1 });
  assert.equal(s.byDay['2026-10-25'], 2);
  // the backup round-trips, and old days fall off
  const d = c.dump();
  const c2 = v.createTapCounter({ now: () => t });
  c2.load([...d, { id: 'junk', n: 9 }, { id: '2026-10-25|kalshi|exact', n: -4 }]);
  assert.equal(c2.state().total, 2);
  t += 5 * 864e5;
  assert.equal(c.state().total, 0);
});
