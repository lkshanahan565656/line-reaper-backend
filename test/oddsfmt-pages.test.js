// The viewer's odds format and state on the pages the server draws (audit
// 10-26): league pages (?odds=, ?state=), share cards (odds=, a league card's
// state=) and the widgets (data-odds, data-state). Before, these always
// showed American odds and a league card counted every state's venues.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const oddsFmt = require('../oddsfmt');
const L = require('../leagues');
const sc = require('../sharecards');
const embeds = require('../embeds');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const share = vm.runInNewContext(`${html.match(/^\/\/ LR_SHARE_BEGIN\n([\s\S]*?)^\/\/ LR_SHARE_END$/m)[1]}\nLRShare`, { URLSearchParams });
const noTags = s => s.replace(/<[^>]+>/g, ' ');
const NOW = Date.parse('2026-10-26T12:00:00Z');
// TEST DATA, not a recording
const board = { readAt: new Date(NOW - 60e3).toISOString(), pro: true, games: 1, markets: 2, priced: 2, above: 1, locked: 1, venues: ['Kalshi'], anyExchange: true,
  opps: [{ event: 'Away @ Home', start: new Date(NOW + 3600e3).toISOString(), marketName: 'Moneyline', selection: 'Away', provider: 'kalshi', providerName: 'Kalshi',
    american: 150, fairAmerican: -110, fair: 0.524, ev: 0.03, exchange: true, label: 'lead', size: null }] };
const STATES = [['TX', 'Texas'], ['CA', 'California']];

test('oddsfmt reads the app\'s own block: same answers as the app, American for anything unknown', () => {
  assert.equal(oddsFmt.fromAm(150, 'decimal'), '2.50');
  assert.equal(oddsFmt.fromAm(-110, 'fractional'), '10/11');
  assert.equal(oddsFmt.fromAm(-110, 'probability'), '52.4%');
  assert.equal(oddsFmt.fromAm(150), '+150');
  assert.equal(oddsFmt.fromAm(null, 'decimal'), '—');
  assert.equal(oddsFmt.fmtOf('<script>'), 'american');
  assert.deepEqual(oddsFmt.OPTIONS.map(o => o[0]), ['american', 'decimal', 'fractional', 'probability']);
});

test('a league page shows prices in ?odds= and keeps the state and format on its links', () => {
  const h = L.render('nfl', { now: NOW, board, record: null, fmt: 'decimal', state: { code: 'CA', name: 'California', kalshi: 'unknown', states: STATES } });
  assert.match(h, /data-l="Price">2\.50<\/td><td data-l="Fair">1\.91/);
  assert.ok(!/data-l="Price">\+150/.test(h), 'no American price left');
  assert.match(h, /<select id="sto" name="odds">[\s\S]*<option value="decimal" selected>Decimal/);
  assert.match(h, /href="\/nba\?state=CA&amp;odds=decimal"/, 'the league list keeps the picks');
  assert.match(h, /href="\/leagues\?state=CA&amp;odds=decimal"/);
  // a link into the app opens it on the picked state, and the app reads it
  const link = h.match(/href="(\/app#lr&amp;t=odds&amp;m=opps[^"]*)"/)[1].replace(/&amp;/g, '&');
  assert.match(link, /&st=ca$/);
  assert.equal(share.decode(link.slice(link.indexOf('#')), ['odds', 'props', 'esports', 'results']).st, 'CA');
  // the defaults add nothing to the links
  const d = L.render('nfl', { now: NOW, board, record: null, state: { code: 'TX', name: 'Texas', kalshi: 'yes', states: STATES } });
  assert.match(d, /data-l="Price">\+150/);
  assert.match(d, /href="\/nba">/);
  assert.ok(!/&st=/.test(d));
});

test('the league index takes the state and format too', () => {
  const h = L.index({ record: null, fmt: 'fractional', state: { code: 'CA', name: 'California', states: STATES } });
  assert.match(h, /venues a California resident can use/);
  assert.match(h, /href="\/nfl\?state=CA&amp;odds=fractional"/);
  assert.match(h, /<option value="CA" selected>California/);
});

test('share cards draw prices in the sharer\'s format; a league card names the state\'s venues', () => {
  const row = { id: 'x', event: 'Away @ Home', selection: 'Away', venue: 'kalshi', venueName: 'Kalshi', price: { american: 150, decimalAfterFees: 2.45 }, fair: { prob: 0.4, american: 150 }, evPct: 2,
    secondBest: { venueName: 'FanDuel', american: -102 }, fill: null, label: 'lead' };
  const t = noTags(sc.priceCard(row, { at: '2026-10-26T14:00:00Z', fmt: 'decimal' }));
  assert.match(t, /2\.50/);
  assert.match(t, /1\.98 FanDuel/);
  assert.ok(!/\+150/.test(t));
  assert.match(noTags(sc.priceCard(row, { at: '2026-10-26T14:00:00Z' })), /\+150/, 'American when none is given');
  const lg = noTags(sc.leagueCard({ name: 'NFL', games: 2, markets: 4, withFair: 4, venues: 2, aboveFair: 1, rows: [row], at: '2026-10-26T14:00:00Z', stateName: 'Texas' }, { fmt: 'probability' }));
  assert.match(lg, /TEXAS VENUES/i);
  assert.match(lg, /BEST TEXAS PRICES/);
  assert.match(lg, /40\.0% Kalshi/);
});

test('widgets take data-odds and data-state', () => {
  const rows = [{ id: 'x', event: 'Away @ Home', selection: 'Away', venueName: 'Kalshi', price: { american: 150 }, fair: { american: -110 }, evPct: 2, fill: null, label: 'lead' }];
  const w = embeds.bestPriceWidget(rows, { league: 'nfl', fmt: 'decimal' });
  assert.match(w, /2\.50/);
  assert.match(w, /1\.91/);
  const js = embeds.embedScript('https://x.test');
  assert.match(js, /'state', 'odds'/);
});
