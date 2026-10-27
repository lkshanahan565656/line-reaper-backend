// linehist.js: thinning keeps real reads (first, last, the close, the biggest
// moves), the 30-day archive stays inside its budget and says what it
// dropped, the live histories hand dropped markets over, and the pages and
// CSV say only what was read.
const test = require('node:test');
const assert = require('node:assert/strict');
const lh = require('../linehist');
const oddsScreen = require('../oddsscreen');
const shopper = require('../shopper');

const T0 = Date.parse('2026-10-20T12:00:00Z');
const MIN = 60e3;
// a game side read every 5 minutes; Kalshi drifts, one big jump at read 50
function gamePts(n, { jumpAt = 50 } = {}) {
  return Array.from({ length: n }, (_, i) => [T0 + i * 5 * MIN, -3.5, 0.5 + (i >= jumpAt ? 0.06 : 0) + (i % 2) * 0.001, { pinnacle: i >= jumpAt ? -135 : -110, kalshi: i >= jumpAt ? -130 : -108 + (i % 3) }]);
}

test('thin keeps the first, the last, the close and the biggest move, and only real reads', () => {
  const pts = gamePts(200);
  const start = new Date(T0 + 150 * 5 * MIN + 60e3).toISOString(); // close is read 150
  const out = lh.thin(pts, 30, { start });
  assert.ok(out.length <= 30);
  assert.equal(out[0], pts[0]);
  assert.equal(out[out.length - 1], pts[199]);
  assert.ok(out.includes(pts[150]), 'the last read before the start stays');
  assert.ok(out.includes(pts[50]), 'the big jump stays');
  for (const p of out) assert.ok(pts.includes(p), 'every kept point is a read we made');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'in time order');
  assert.deepEqual(lh.thin(pts.slice(0, 10), 30), pts.slice(0, 10));
});

test('thin keeps everything from protectFrom on', () => {
  const pts = gamePts(100);
  const out = lh.thin(pts, 40, { protectFrom: 80 });
  for (let i = 80; i < 100; i++) assert.ok(out.includes(pts[i]));
});

test('encode and decode round-trip game and prop reads', () => {
  const g = gamePts(5).map(p => [Math.round(p[0] / MIN) * MIN, p[1], p[2], p[3]]);
  assert.deepEqual(lh.decodeGame(lh.encodeGame({ pts: g })), g);
  const p = [[T0, 0.52, { pinnacle: [-115, -105], prizepicks: [-137, null] }], [T0 + 5 * MIN, null, { underdog: [-122, -122] }]];
  assert.deepEqual(lh.decodeProp(lh.encodeProp({ pts: p })), p);
});

test('the archive thins a dropped market, keeps it 30 days, then lets it go', () => {
  let now = T0 + 2 * 86400e3;
  const a = lh.createArchive({ now: () => now });
  const x = { id: 'pin-1|spread|Home', game: 'pin-1', market: 'spread', label: 'Home -3.5', league: 'nfl', leagueLabel: 'NFL', event: 'Away @ Home', start: new Date(T0 + 86400e3).toISOString(), pts: gamePts(300) };
  const e = a.add('game', x);
  assert.equal(e.pts.length, 60);
  assert.equal(e.reads, 300);
  assert.equal(e.thinned, true);
  const s = a.gameSeries('pin-1');
  assert.equal(s.length, 1);
  assert.equal(s[0].event, 'Away @ Home');
  assert.equal(s[0].pts[0][3].pinnacle, -110);
  assert.equal(a.index()[0].market, 'spread');
  assert.equal(a.status().markets.game, 1);
  now = T0 + 86400e3 + 29 * 86400e3; a.prune();
  assert.equal(a.size(), 1, 'still inside 30 days');
  now = T0 + 86400e3 + 31 * 86400e3; a.prune();
  assert.equal(a.size(), 0);
  assert.equal(a.status().dropped.expired, 1);
});

test('over budget, the oldest markets are thinned harder, then removed, and status says so', () => {
  const a = lh.createArchive({ budget: { game: 200, prop: 100 }, now: () => T0 + 5 * 86400e3 });
  for (let i = 0; i < 20; i++) a.add('game', { id: `g${i}|ml|A`, game: `g${i}`, market: 'ml', label: 'A', start: new Date(T0 + i * 3600e3).toISOString(), pts: gamePts(100) });
  const st = a.status();
  assert.ok(st.points.game <= 200, `points ${st.points.game}`);
  assert.ok(st.dropped.thinnedHarder > 0);
  assert.ok(st.dropped.removedForRoom > 0);
  // the newest survive
  assert.equal(a.gameSeries('g19').length, 1);
  assert.equal(a.gameSeries('g0').length, 0);
});

test('a restore never replaces a newer copy, and load keeps the budget', () => {
  const a = lh.createArchive();
  const x = { id: 'p|ml|A', game: 'p', market: 'ml', label: 'A', start: new Date(T0).toISOString(), pts: gamePts(20) };
  a.add('game', x);
  const doc = a.dump()[0];
  const older = { ...doc, lastAt: '2020-01-01T00:00:00.000Z', pts: doc.pts.slice(0, 2) };
  a.load([older]);
  assert.equal(a.dump()[0].pts.length, doc.pts.length);
  const b = lh.createArchive();
  b.load(a.dump());
  assert.deepEqual(b.gameSeries('p'), a.gameSeries('p'));
  b.load([{ id: 'junk' }, null, { id: 'game:x', kind: 'nope', pts: [], v: [] }]);
  assert.equal(b.size(), 1);
});

test('the odds screen history hands a game to onDrop and thins instead of cutting the opening read', () => {
  const dropped = [];
  const h = oddsScreen.createHistory({ maxPts: 40, minGapMs: 0, onDrop: x => dropped.push(x) });
  const start = new Date(T0 + 60 * 5 * MIN).toISOString();
  const screen = i => ({ games: [{ id: 'pin-9', start, league: 'nba', leagueLabel: 'NBA', home: 'Home', away: 'Away', markets: [{ key: 'ml', point: null, sides: [{ name: 'Home', label: 'Home', fair: 0.5 + i / 1000, venues: [{ venue: 'pinnacle', american: -110 - i }] }] }] }] });
  for (let i = 0; i < 100; i++) h.observe(screen(i), T0 + i * 5 * MIN);
  const [x] = h.dump();
  assert.ok(x.pts.length <= 40);
  assert.equal(x.pts[0][3].pinnacle, -110, 'the opening price stays');
  assert.equal(x.reads, 100);
  assert.equal(x.event, 'Away @ Home');
  assert.equal(x.league, 'nba');
  h.prune(Date.parse(start) + 7 * 3600e3);
  assert.equal(h.size(), 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'pin-9|ml|Home');
});

test('the prop history hands a market to onDrop too', () => {
  const dropped = [];
  const h = shopper.createLineHistory({ minGapMs: 0, onDrop: x => dropped.push(x) });
  const start = new Date(T0 + 3600e3).toISOString();
  const view = { marketType: 'player_prop', key: 'k1', event: 'A @ B', league: 'nba', start, player: 'P', marketName: 'Points', line: 20.5,
    sides: [{ side: 'over', fair: 0.5, prices: [{ provider: 'pinnacle', effective: 1.9 }, { provider: 'underdog', effective: 1.8 }] }, { side: 'under', fair: 0.5, prices: [{ provider: 'pinnacle', effective: 1.95 }] }] };
  h.observe([view], T0);
  h.prune(Date.parse(start) + 7 * 3600e3);
  assert.equal(dropped.length, 1);
  const a = lh.createArchive();
  a.add('prop', dropped[0]);
  const p = a.propSeries('k1');
  assert.equal(p.player, 'P');
  const sides = lh.propSides(p);
  assert.equal(sides[0].label, 'Over 20.5');
  assert.ok(sides[0].pts[0][3].pinnacle < 0);
  assert.equal(sides[1].pts[0][3].underdog, undefined, 'no Under at Underdog: not filled in');
});

test('cutGame hides the fair for free viewers and Kalshi without its licence; windowed cuts by days', () => {
  const s = [{ id: 'a', market: 'ml', label: 'A', pts: [[T0, null, 0.5, { kalshi: -110, pinnacle: -105 }], [T0 + 4 * 86400e3, null, 0.51, { pinnacle: -108 }]] }];
  const c = lh.cutGame(s, { pro: false, kalshi: false });
  assert.equal(c[0].pts[0][2], null);
  assert.deepEqual(Object.keys(c[0].pts[0][3]), ['pinnacle']);
  const w = lh.windowed(s, 3, T0 + 5 * 86400e3);
  assert.equal(w[0].pts.length, 1);
  assert.equal(lh.windowed(s, 3, T0 + 30 * 86400e3).length, 0);
});

test('the CSV has one row per read and venue, and neutralises formula text', () => {
  const csv = lh.toCsv({ event: '=HYPERLINK("x")', league: 'nfl' }, [{ id: 'a', market: 'spread', label: 'Home -3.5', pts: [[T0, -3.5, 0.5123, { pinnacle: -110, kalshi: 105 }]] }]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], lh.CSV_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-10-20T12:00:00.000Z,"'=HYPERLINK\(""x""\)",nfl,spread,Home -3.5,-3.5,pinnacle,-110,1.9091,0.5238,0.5123$/);
  assert.match(lines[2], /,kalshi,105,2.05,0.4878,/);
  const j = lh.toJson({ id: 'x' }, [{ id: 'a', market: 'ml', label: 'A', pts: [[T0, null, null, { pinnacle: -110 }]] }]);
  assert.equal(j.series[0].points[0].t, '2026-10-20T12:00:00.000Z');
});

const BAD = /undefined|NaN|\[object Object\]|Infinity|>null</;
test('the market page charts real reads, follows odds format and state, and says since when', () => {
  const now = T0 + 2 * 86400e3;
  const series = [{ id: 'g|spread|Home', market: 'spread', label: 'Home -3.5', archived: true, thinned: true, reads: 300, pts: gamePts(60) },
    { id: 'g|spread|Away', market: 'spread', label: 'Away +3.5', pts: gamePts(10) }, { id: 'g|ml|Home', market: 'ml', label: 'Home', pts: gamePts(10) }];
  const html = lh.marketPage({ kind: 'game', id: 'g', meta: { event: 'Away @ Home', league: 'nfl', leagueLabel: 'NFL', start: new Date(T0 + 86400e3).toISOString() }, series, market: 'spread', pro: true, now, keepDays: 30, windowDays: 30 },
    { st: 'TX', fmt: 'decimal', states: [['TX', 'Texas'], ['NJ', 'New Jersey']] });
  assert.doesNotMatch(html, BAD);
  assert.match(html, /<svg viewBox="0 0 720/);
  assert.match(html, /Saved since 2026-10-20 12:00 UTC \(2 days of history, shorter than 30 days/);
  assert.match(html, /thinned to 60 of 300/);
  assert.match(html, /1\.91</, 'prices in decimal odds');
  assert.match(html, /Pinnacle <em>reference<\/em>/);
  assert.match(html, /Kalshi <em>TX: yes<\/em>/);
  assert.match(html, /href="\/api\/lines\/game\/g\?market=spread&amp;format=csv"/);
  assert.match(html, /Moneyline/);
  assert.match(html, /Away \+3\.5/);
  assert.match(html, /not a proven edge/);
  assert.doesNotMatch(html, /guaranteed|risk-free/i);
  // a free viewer: no fair column or line
  const free = lh.marketPage({ kind: 'game', id: 'g', meta: {}, series, pro: false, now, keepDays: 30, windowDays: 3 }, { states: [] });
  assert.doesNotMatch(free, /Fair \(Pinnacle/);
  assert.match(free, /for subscribers/);
  // a state where Kalshi is not on our table: hidden, with the toggle
  const venues = require('../venues');
  const no = Object.keys(venues.table().states).find(s => venues.statusOf(s, 'kalshi') === 'no');
  if (no) {
    const h = lh.marketPage({ kind: 'game', id: 'g', meta: {}, series, pro: true, now, keepDays: 30 }, { st: no, states: [] });
    assert.match(h, /Show every venue/);
    assert.doesNotMatch(h, /Kalshi <em>/);
  }
});

test('an unknown market says so plainly, and the index lists and filters', () => {
  const empty = lh.marketPage({ kind: 'prop', id: 'nope', meta: {}, series: [], keepDays: 30, windowDays: 3 }, {});
  assert.match(empty, /No saved prices for this market/);
  assert.match(empty, /noindex/);
  assert.doesNotMatch(empty, BAD);
  const rows = [{ kind: 'game', key: 'g1', market: 'ml', event: 'Bills @ Chiefs', league: 'nfl', start: '2026-10-21T00:00:00Z', firstAt: '2026-10-19T00:00:00Z', lastAt: '2026-10-21T00:00:00Z', reads: 40, archived: true },
    { kind: 'prop', key: 'k', player: 'LeBron James', stat: 'Points', line: 24.5, event: 'Lakers @ Suns', league: 'nba', start: '2026-10-22T00:00:00Z', firstAt: '2026-10-21T00:00:00Z', lastAt: '2026-10-21T10:00:00Z', reads: 9, archived: false }];
  const f = lh.filterIndex(rows, { q: 'lebron' });
  assert.equal(f.total, 1);
  assert.equal(lh.filterIndex(rows, { kind: 'game' }).rows[0].key, 'g1');
  assert.equal(lh.filterIndex(rows, {}).rows[0].kind, 'prop', 'newest start first');
  const paged = lh.filterIndex(rows, { limit: 1 });
  assert.equal(paged.next, '2026-10-22T00:00:00Z');
  const html = lh.indexPage({ rows, total: 2, leagues: [['nfl', 'NFL', 1]], since: '2026-10-19T00:00:00Z', now: Date.parse('2026-10-23T00:00:00Z') }, { states: [['TX', 'Texas']] });
  assert.match(html, /Bills @ Chiefs · Moneyline/);
  assert.match(html, /href="\/lines\/prop\?key=k"/);
  assert.match(html, /4 days so far/);
  assert.doesNotMatch(html, BAD);
});

test('the chart function is self-contained (the page inlines its source)', () => {
  const draw = new Function(`return ${lh.chartSvg.toString()}`)();
  const svg = draw({ title: 't', start: T0 + 10 * MIN, lines: [{ name: 'x', color: '#fff', pts: [[T0, 0.5], [T0 + 20 * MIN, 0.55]] }] }, 340);
  assert.match(svg, /^<svg viewBox="0 0 340 200"/);
  assert.match(svg, />start</);
  assert.equal(draw({ title: 't', lines: [] }, 340), '');
});

test('a prop reads its stat in words, and a market no venue in the state priced says so instead of a table of dashes', () => {
  assert.equal(lh.statLabel('pass_att'), 'pass attempts');
  assert.equal(lh.statLabel('rec_yds'), 'receiving yards');
  assert.equal(lh.statLabel('longest_rush_yds'), 'longest rush yards', 'an unknown key still reads as words');
  assert.equal(lh.statLabel('Points'), 'Points');
  const t = Date.parse('2026-10-27T08:00:00Z');
  const pts = [0, 1, 2].map(i => [t + i * 1800e3, 30.5, null, { draftkings: -114, bet365: -115 }]);
  const data = { kind: 'prop', id: 'pin-1|prop|pass_att|kyler|30.5', meta: { event: 'Vikings @ Lions', league: 'nfl', player: 'Kyler Murray', stat: 'pass_att', line: 30.5, start: '2026-11-01T18:00:00Z' },
    series: [{ id: 'o', market: 'prop', label: 'Over 30.5', pts }], pro: true, now: t + 3 * 3600e3, keepDays: 30, windowDays: 30 };
  const tx = lh.marketPage(data, { st: 'TX', states: [['TX', 'Texas']] });
  assert.match(tx, /<h1>Kyler Murray pass attempts 30\.5: line<\/h1>/);
  assert.match(tx, /No venue a TX resident can use on our venue table priced this prop: (bet365|DraftKings), (bet365|DraftKings)\./);
  assert.match(tx, /Show every venue/);
  assert.doesNotMatch(tx, /Every read<\/h2>/, 'no table of dashes');
  assert.doesNotMatch(tx, /id="lhChart"/, 'no empty chart');
  assert.doesNotMatch(tx, BAD);
  const all = lh.marketPage(data, { st: 'TX', allVenues: true, states: [['TX', 'Texas']] });
  assert.match(all, /Every read<\/h2>/);
  assert.match(all, /id="lhChart"/);
  assert.match(all, /-114/);
  const idx = lh.indexPage({ rows: [{ kind: 'prop', key: 'k', player: 'Kyler Murray', stat: 'pass_att', line: 30.5, event: 'Vikings @ Lions', league: 'nfl', start: '2026-11-01T18:00:00Z', firstAt: '2026-10-27T08:00:00Z', lastAt: '2026-10-27T09:00:00Z', reads: 3 }],
    total: 1, leagues: [], since: '2026-10-26T00:00:00Z', now: Date.parse('2026-10-27T10:00:00Z') }, { states: [['TX', 'Texas']] });
  assert.match(idx, /Kyler Murray pass attempts 30\.5/);
  assert.match(idx, /1 day so far/);
});
