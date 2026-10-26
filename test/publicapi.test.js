// The public API's pure parts: keys (only a hash kept, revoke, the per-hour
// cap), rate limits, ETags, the shapes it serves and the labels they carry.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../publicapi');
const embeds = require('../embeds');

const memStore = () => { const rows = new Map(); return { rows, init: async () => {}, all: async () => [...rows.values()], put: async d => { rows.set(d.id, d); } }; };

test('a key is shown once and only its hash is stored; revoked keys stop working', async () => {
  const store = memStore();
  const keys = api.createKeyStore({ store });
  const k = await keys.create({ name: '  my <site>  ', who: 'a' });
  assert.match(k.key, /^lr_[\w-]{32}$/);
  assert.equal(k.name, 'my site');
  const saved = [...store.rows.values()][0];
  assert.equal(saved.hash, api.sha256(k.key));
  assert.ok(!JSON.stringify(saved).includes(k.key), 'the key itself is never stored');
  assert.equal(saved.status, 'active');
  assert.equal(keys.check(k.key).id, k.id);
  assert.equal(keys.check('lr_nope_nope_nope_nope_nope_nope'), null);
  assert.equal(keys.check(42), null);
  const r = await keys.revoke(k.key);
  assert.ok(r.revokedAt);
  assert.equal(keys.check(k.key), null);
  assert.equal(store.rows.get(k.id).status, 'revoked');
  // a restart reads the store back
  const again = api.createKeyStore({ store });
  await again.init();
  assert.equal(again.check(k.key), null);
  const k2 = await keys.create({ who: 'a' });
  const back = api.createKeyStore({ store });
  await back.init();
  assert.equal(back.check(k2.key).id, k2.id);
  assert.equal(k2.name, 'unnamed key');
});

test('one address makes at most 5 keys an hour', async () => {
  let t = Date.parse('2026-10-26T12:00:00Z');
  const keys = api.createKeyStore({ store: memStore(), now: () => t });
  for (let i = 0; i < 5; i++) await keys.create({ who: 'x' });
  await assert.rejects(keys.create({ who: 'x' }), e => e.status === 429 && e.retryAfter > 0);
  await keys.create({ who: 'y' });
  t += 3600e3 + 1;
  await keys.create({ who: 'x' });
});

test('the limiter counts a minute and a UTC day, and says when to retry', () => {
  let t = Date.parse('2026-10-26T12:00:10Z');
  const lim = api.createLimiter({ perMinute: 3, perDay: 5, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal(lim.take('k').ok, true);
  const over = lim.take('k');
  assert.equal(over.ok, false);
  assert.equal(over.over, 'minute');
  assert.equal(over.retryAfter, 50);
  t += 60e3;
  assert.equal(lim.take('k').ok, true);
  assert.equal(lim.take('k').ok, true);
  const day = lim.take('k');
  assert.equal(day.over, 'day');
  assert.ok(day.retryAfter > 3600);
  assert.deepEqual(lim.usage('k'), { minute: 2, today: 5 });
  assert.equal(lim.take('other').ok, true, 'each key has its own count');
  const nodaily = api.createLimiter({ perMinute: 2, perDay: 0, now: () => t });
  for (let i = 0; i < 2; i++) assert.equal(nodaily.take('w').ok, true);
  assert.equal(nodaily.take('w').ok, false);
});

test('ETag: the same body gives the same tag, and If-None-Match answers 304', () => {
  const mk = inm => {
    const res = { headers: {}, code: null, body: null, set(h) { Object.assign(this.headers, h); return this; }, status(c) { this.code = c; return this; }, end() { return this; }, type() { return this; }, send(b) { this.body = b; return this; } };
    return [{ get: h => (h === 'if-none-match' ? inm : '') }, res];
  };
  const [req, res] = mk('');
  api.sendCached(req, res, { a: 1 });
  assert.equal(res.code, 200);
  assert.equal(res.headers.ETag, api.etagOf('{"a":1}'));
  const [rq, rs] = mk('');
  api.sendCached(rq, rs, { a: 1, at: 'later' });
  assert.equal(rs.headers.ETag, res.headers.ETag, 'when the answer was made does not change the tag');
  assert.match(res.headers['Cache-Control'], /max-age=15/);
  const [req2, res2] = mk(res.headers.ETag);
  api.sendCached(req2, res2, { a: 1 });
  assert.equal(res2.code, 304);
  assert.equal(res2.body, null);
  const [req3, res3] = mk(res.headers.ETag);
  api.sendCached(req3, res3, { a: 2 });
  assert.equal(res3.code, 200, 'a changed body is sent');
});

const opp = (over = {}) => ({ key: 'm1|home', market: 'm1', event: 'A @ B', sport: 'football', league: 'nfl', start: '2026-10-27T00:15:00Z', marketType: 'moneyline', marketName: 'Moneyline',
  line: null, player: null, selection: 'B', provider: 'kalshi', providerName: 'Kalshi', american: 120, effective: 2.18, fair: 0.48, fairAmerican: 108, ev: 0.0464, evAmount: 4.64,
  edgePts: 2.1, kelly: 0.04, second: { provider: 'fanduel', name: 'FanDuel', american: 110, effective: 2.1 }, fairSource: 'pinnacle', freshness: 'fresh', access: 'direct', oneWay: false,
  size: { tiers: { 50: { full: true }, 200: { full: true }, 1000: { full: false } }, topUsd: 300, depthUsd: 900, atFairUsd: 400, ageSec: 30 }, rank: { label: 'lead', confidence: 0.8 }, ...over });

test('best prices: fill size from the book read, no Kelly or stake sizing, and the app\'s labels', () => {
  const [r] = api.bestPrices({ opportunities: [opp()] });
  assert.equal(r.evPct, 4.64);
  assert.equal(r.price.decimalAfterFees, 2.18);
  assert.deepEqual(r.fill, { status: 'read', fillsUsd: 200, topUsd: 300, depthUsd: 900, atFairUsd: 400, ageSec: 30 });
  assert.equal(r.label, 'lead');
  assert.match(r.labelText, /not a proven edge/);
  assert.ok(!('kelly' in r) && !('evAmount' in r), 'nothing is sized for a person');
  assert.equal(r.secondBest.venue, 'fanduel');
  // a sportsbook publishes no limit; an unread book is said so, never guessed
  assert.equal(api.bestPrices({ opportunities: [opp({ provider: 'betrivers', size: null })] })[0].fill.status, 'not published');
  assert.equal(api.bestPrices({ opportunities: [opp({ size: { unread: true } })] })[0].fill.status, 'unread');
  assert.equal(api.bestPrices({ opportunities: [opp({ size: null })] })[0].fill.status, 'unknown');
  // PROVEN only for a proven venue's main line, never a prop or an alt line
  assert.equal(api.bestPrices({ opportunities: [opp({ provider: 'betrivers', rank: { label: 'proven' } })] })[0].label, 'proven');
  assert.equal(api.bestPrices({ opportunities: [opp({ provider: 'betrivers', marketType: 'player_prop', rank: { label: 'proven' } })] })[0].label, 'lead');
  assert.equal(api.bestPrices({ opportunities: [opp({ provider: 'betrivers', oneWay: true, rank: { label: 'proven' } })] })[0].label, 'lead');
});

const RECORD = { at: '2026-10-26T12:00:00Z', rule: { text: 'rule' }, rows: [
  { kind: 'ev', kindLabel: 'main lines', book: 'betrivers', bookName: 'BetRivers', graded: 373, clv: 2.8, clvT: 3.1, beatPct: 58, wins: 538, losses: 527, units: -7.1, profitShown: false, texas: false, label: 'proven' },
  { kind: 'ev', kindLabel: 'main lines', book: 'fanduel', bookName: 'FanDuel', graded: 20, label: 'building', units: 3 },
  { kind: 'stale', kindLabel: 'stale', book: 'x', bookName: 'X', graded: 80, label: 'losing to the close', units: -9 },
] };

test('the record card says only what RESULTS proves, and no profit unless RESULTS shows it', () => {
  const c = api.recordCard(RECORD);
  assert.equal(c.proven.length, 1);
  assert.equal(c.proven[0].units, null, 'units hidden when profit is not shown');
  assert.equal(c.notProven, 2);
  assert.equal(c.building, 1);
  assert.equal(c.losing, 1);
  const html = embeds.recordWidget(c, { origin: 'https://x.test' });
  assert.match(html, /Profit not shown/);
  assert.ok(!/-7\.1u|\+3/.test(html));
  assert.match(html, /NOT IN TEXAS/);
  assert.match(html, /https:\/\/x\.test\/app\?start=results/);
  const shown = api.recordCard({ ...RECORD, rows: [{ ...RECORD.rows[0], units: 12.4, profitShown: true }] });
  assert.equal(shown.proven[0].units, 12.4);
  assert.match(embeds.recordWidget(shown), /\+12\.4u/);
  assert.match(embeds.recordWidget(api.recordCard({ rows: [] })), /Nothing is proven yet/);
});

test('widgets: labels, honest empty states, a link home, no script from the caller', () => {
  const rows = api.bestPrices({ opportunities: [opp()] });
  const html = embeds.bestPriceWidget(rows, { league: 'nfl', at: '2026-10-26T12:00:00Z', origin: 'https://x.test', id: 'ab"><script>' });
  assert.match(html, /LEAD/);
  assert.match(html, /fills \$200/);
  assert.match(html, /after the venue's fee/);
  assert.ok(!/ab"><script>/.test(html), 'the widget id is cleaned');
  assert.match(embeds.bestPriceWidget([], { league: 'nfl' }), /No price sits above the fair in NFL/);
  assert.match(embeds.bestPriceWidget([], { locked: true }), /subscribers/);
  assert.match(embeds.bestPriceWidget([], { stale: true }), /nothing is shown rather than an old price/);
  assert.match(embeds.lineMoveWidget({ game: null }), /No game to chart/);
  const t0 = Date.parse('2026-10-26T10:00:00Z');
  const series = [{ id: 'g|ml|B', market: 'ml', side: 'B', start: '2026-10-27T00:00:00Z', points: [
    { t: new Date(t0).toISOString(), point: null, fair: 0.5, prices: { pinnacle: -105, kalshi: 100 } },
    { t: new Date(t0 + 3600e3).toISOString(), point: null, fair: 0.55, prices: { pinnacle: -125, kalshi: -110 } }] }];
  const chart = embeds.lineMoveWidget({ game: { event: 'A @ B', leagueLabel: 'NFL', start: '2026-10-27T00:00:00Z' }, series, venueName: v => v.toUpperCase() });
  assert.match(chart, /<svg/);
  assert.match(chart, /information, not a proven edge/);
  assert.match(chart, /KALSHI -110/);
  assert.equal(embeds.chartSvg(series[0].points.slice(0, 1)), null, 'one point is not a chart');
  assert.match(embeds.impliedOf(-110).toFixed(4), /^0\.5238$/);
});

test('embed.js only talks to its own origin and only sizes its own frames', () => {
  const js = embeds.embedScript('https://x.test');
  assert.match(js, /e\.origin !== base/);
  assert.match(js, /best-price/);
  assert.doesNotThrow(() => new Function(js));
});

test('the developers page lists every endpoint and has no claim the record does not back', () => {
  const html = embeds.developersPage({ origin: 'https://x.test', endpoints: api.ENDPOINTS, examples: { '/api/v1/leagues': { url: '/api/v1/leagues', at: '2026-10-26T12:00:00Z', body: { leagues: [] } } },
    limits: api.LIMITS, widgetLimit: api.WIDGET_PER_MINUTE, keyCreate: api.KEY_CREATE, licences: { kalshi: false } });
  for (const e of api.ENDPOINTS) assert.ok(html.includes(`GET ${e.path.replace(/[{}]/g, m => m)}`), e.path);
  assert.match(html, /TRY IT WITH YOUR KEY/);
  assert.match(html, /Kalshi prices are left out/);
  assert.ok(!/guaranteed|risk[- ]free|sure thing|lock of/i.test(html));
});
