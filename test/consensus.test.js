const test = require('node:test');
const assert = require('node:assert');
const sp = require('../sportprops');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');

const ev = (p, b, m) => (b === 'underdog' ? (p * m / 0.5623 - 1) * 100 : (p * m - 1) * 100);
const cell = (line, over = null, under = null) => ({ line, over, under, overOpen: true, underOpen: true });
const row = (books, extra = {}) => ({ key: 'NFL|x|rec_yds', sport: 'NFL', player: 'X', mkey: 'rec_yds', market: 'Receiving Yards', startTime: new Date(Date.now() + 3600e3).toISOString(), books, ...extra });

test('entry break-evens come from the payout tables', () => {
  const be = Object.fromEntries(sp.PP_ENTRIES.map(e => [e.name, e.be]));
  assert.ok(Math.abs(be['2-pick power'] - Math.sqrt(1 / 3)) < 1e-3);
  assert.ok(Math.abs(be['3-pick power'] - Math.cbrt(1 / 6)) < 1e-3);
  assert.ok(Math.abs(be['6-pick power'] - (1 / 37.5) ** (1 / 6)) < 1e-3);
  assert.ok(be['6-pick flex'] > 0.53 && be['6-pick flex'] < 0.55);
  assert.strictEqual(sp.PP_GRADE.name, '3-pick power');
});

test('one sharp source is not a consensus; two agreeing ones are', () => {
  const r = row({ prizepicks: cell(50.5) });
  assert.strictEqual(sp.consensusFor(r, 50.5, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.6 }] }), null);
  const f = sp.consensusFor(r, 50.5, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.6 }, { book: 'fanduel', line: 50.5, pOver: 0.58 }] });
  assert.strictEqual(f.n, 2);
  assert.ok(f.p > 0.58 && f.p < 0.6, 'weighted toward Pinnacle');
  assert.ok(f.p > 0.59);
  // the same line reads back as each source's own price
  assert.deepStrictEqual(f.sources.map(s => s.at), [60, 58]);
});

test('sources far apart (two games) say nothing', () => {
  const r = row({ prizepicks: cell(50.5) });
  assert.strictEqual(sp.consensusFor(r, 50.5, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.5 }, { book: 'fanduel', line: 80.5, pOver: 0.5 }] }), null);
});

test('pick\'em apps never price themselves', () => {
  const r = row({ prizepicks: cell(50.5), underdog: cell(60.5, 1, 1) });
  const plays = sp.consensusPlays(r, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.5 }, { book: 'betrivers', line: 50.5, pOver: 0.5 }], dfsEv: ev });
  for (const p of plays) assert.ok(p.sources.every(s => sp.SHARP_BOOKS.includes(s.book)));
  // Underdog's 60.5 under is the soft side against books at 50.5
  assert.strictEqual(plays[0].book, 'underdog');
  assert.strictEqual(plays[0].side, 'Under');
});

test('a PrizePicks leg is priced at a 3-pick power and lists the entries it clears', () => {
  const r = row({ prizepicks: cell(50.5) });
  const plays = sp.consensusPlays(r, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.57 }, { book: 'fanduel', line: 50.5, pOver: 0.57 }], dfsEv: ev });
  const over = plays.find(p => p.side === 'Over');
  assert.ok(Math.abs(over.ev - (0.57 / sp.PP_GRADE.be - 1) * 100) < 0.05);
  assert.strictEqual(over.entry, '3-pick power');
  assert.ok(over.entries.includes('6-pick flex') && over.entries.includes('3-pick power') && !over.entries.includes('2-pick power'));
  assert.ok(Math.abs(over.decimal - 1 / sp.PP_GRADE.be) < 1e-3);
});

test('Kalshi joins at its nearest rung', () => {
  const r = row({ prizepicks: cell(50.5) });
  const f = sp.consensusFor(r, 50.5, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.55 }], kalshi: new Map([[40, 0.8], [50.5, 0.56]]) });
  assert.strictEqual(f.n, 2);
  assert.strictEqual(f.sources.find(s => s.book === 'kalshi').line, 50.5);
});

test('sportsbook props become no-vig quotes on the board\'s keys', () => {
  const games = { nfl: [{ commence_time: '2026-10-19T17:00:00Z', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'rec_yds', outcomes: [{ name: 'Over', description: 'A B', price: -110, point: 50.5 }, { name: 'Under', description: 'A B', price: -110, point: 50.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [] }, { key: 'rec_yds', outcomes: [{ name: 'Over', description: 'A B', price: -130, point: 50.5 }, { name: 'Under', description: 'A B', price: 100, point: 50.5 }] }] },
  ] }] };
  const q = sp.bookPropQuotes(games, s => ({ nfl: 'NFL' })[s], n => n.toLowerCase().replace(/\s+/g, ''));
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].key, 'NFL|ab|rec_yds');
  assert.strictEqual(q[0].book, 'fanduel');
  assert.ok(q[0].pOver > 0.53 && q[0].pOver < 0.57);
  const idx = new Map([[q[0].key, q]]);
  assert.strictEqual(sp.quotesFor(idx, { key: 'NFL|ab|rec_yds', startTime: '2026-10-19T18:00:00Z' }).length, 1);
  assert.strictEqual(sp.quotesFor(idx, { key: 'NFL|ab|rec_yds', startTime: '2026-10-20T18:00:00Z' }).length, 0);
});

test('weights parse over the defaults', () => {
  const w = sp.parseWeights('pinnacle:4, fanduel:0, nope:9');
  assert.strictEqual(w.pinnacle, 4);
  assert.strictEqual(w.fanduel, 0);
  assert.strictEqual(w.betrivers, 1);
  assert.ok(!('nope' in w));
});

test('a line that stood still while the books moved reads as stale', () => {
  let t = 0;
  const m = sp.createMoveTracker({ now: () => t });
  const r = row({ prizepicks: cell(50.5) });
  m.observe(r, 50);
  t = 10 * 60e3;
  m.observe(r, 56);   // the books' mean went up 6 yards; PP's 50.5 didn't move
  const st = m.stale(r, 'prizepicks', 50.5, 'Over');
  assert.ok(st.pts > 3, JSON.stringify(st));
  assert.ok(m.stale(r, 'prizepicks', 50.5, 'Under').pts < 0);
  // the app follows: nothing stale
  t = 12 * 60e3;
  const moved = row({ prizepicks: cell(55.5) });
  m.observe(moved, 56);
  assert.strictEqual(m.stale(moved, 'prizepicks', 55.5, 'Over'), null);
});

test('a sharp leg is graded at its entry and scores each source', async () => {
  let t = Date.parse('2026-10-19T12:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t, grader: { grade: async () => ({ outcome: 'win', result: 60 }) }, log: { warn() {} } });
  const r = row({ prizepicks: cell(50.5) }, { startTime: '2026-10-19T17:00:00Z' });
  const play = sp.consensusPlays(r, { sharp: [{ book: 'pinnacle', line: 50.5, pOver: 0.58 }, { book: 'fanduel', line: 50.5, pOver: 0.57 }], dfsEv: ev }).find(p => p.side === 'Over');
  let asked = null;
  await tr.record({ rows: [r], flagged: [{ row: r, play, kind: 'sharp' }], fairAt: (row, b, l, k) => { asked = k; return 0.6; } });
  await tr.record({ rows: [r], flagged: [], fairAt: (row, b, l, k) => { asked = k; return 0.6; } });
  assert.strictEqual(asked, 'sharp');
  t = Date.parse('2026-10-19T17:01:00Z');
  await tr.record({ rows: [r], flagged: [] });
  t = Date.parse('2026-10-19T22:00:00Z');
  await tr.grade();
  const [b] = await tr.list();
  assert.strictEqual(b.entry, '3-pick power');
  assert.ok(Math.abs(b.signalDecimal - 1 / sp.PP_GRADE.be) < 1e-3);
  assert.ok(Math.abs(b.profit - (1 / sp.PP_GRADE.be - 1)) < 1e-3);
  const s = await tr.summary();
  assert.strictEqual(s.byKind.sharp.graded, 1);
  assert.strictEqual(s.bySource.pinnacle.n, 1);
  assert.ok(Math.abs(s.bySource.pinnacle.brier - 0.42 ** 2) < 1e-3);
  assert.ok(s.bySource.consensus);
});

test('a stale-line leg is logged as of the read it first showed on, and only legs still up count toward its executable close EV', async () => {
  let t = Date.parse('2026-10-19T12:00:00Z');
  const tr = createSportTracker({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  const r = row({ underdog: cell(48.5, 1, 1) }, { startTime: '2026-10-19T17:00:00Z' });
  const first = t - 100e3;   // shown 100 s before the record took it
  const play = { book: 'underdog', side: 'Under', line: 48.5, mult: 1, fair: 0.58, ev: 3.1, decimal: 1.7784, signalAt: first, sources: [] };
  await tr.record({ rows: [r], flagged: [{ row: r, play, kind: 'stale' }], fairAt: () => 0.42, updated: { underdog: new Date(t).toISOString() } });
  let [b] = await tr.list();
  assert.strictEqual(b.signalAt, new Date(first).toISOString());
  // Underdog's next read, 2 min after it first showed: the app has moved the line
  t += 30e3;
  const moved = row({ underdog: cell(46.5, 1, 1) }, { startTime: '2026-10-19T17:00:00Z' });
  await tr.record({ rows: [moved], flagged: [], fairAt: () => 0.42, updated: { underdog: new Date(t).toISOString() } });
  [b] = await tr.list();
  assert.strictEqual(b.execOk, false);
  t = Date.parse('2026-10-19T17:01:00Z');
  await tr.record({ rows: [moved], flagged: [] });
  const s = (await tr.summary()).byKind.stale;
  assert.strictEqual(s.closed, 1);
  assert.ok(s.closeEvAvg > 0);          // the market agreed...
  assert.strictEqual(s.execClosed, 0);  // ...but nobody could take it
  assert.strictEqual(s.execCloseEvAvg, null);
});
