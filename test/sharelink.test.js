// Share links (public/index.html, LRShare): a screen packed after the # of the
// app's URL. The block is pure, so it runs here on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const block = html.match(/^\/\/ LR_SHARE_BEGIN\n([\s\S]*?)^\/\/ LR_SHARE_END$/m)[1];
const S = vm.runInNewContext(`${block}\nLRShare`, { URLSearchParams });
const TABS = ['best', 'odds', 'tail', 'results', 'esports', 'props', 'betlog', 'myslips'];
const ORIGIN = 'https://line-reaper-backend-production.up.railway.app/app#';
const plain = x => JSON.parse(JSON.stringify(x));
const round = st => plain(S.decode('#' + S.encode(st), TABS));

test('a shopper view comes back exactly, defaults filled in', () => {
  const shop = { ...S.SHOP_DEF, state: '', markets: 'player_prop', sort: 'start', league: 'nfl', q: 'Mahomes', minEv: '2', minEdge: '1.5', maxAge: '180', hours: '6', minSize: '200', method: 'shin', excluded: ['pinnacle', 'matchbook', 'somenewbook'] };
  const back = round({ tab: 'odds', mode: 'opps', shop });
  assert.equal(back.tab, 'odds');
  assert.equal(back.mode, 'opps');
  assert.deepEqual({ ...back.shop, excluded: back.shop.excluded.sort() }, { ...shop, excluded: ['matchbook', 'pinnacle', 'somenewbook'] });
  // a new device's defaults are left out of the link and filled back in
  assert.equal(S.encode({ tab: 'odds', mode: 'markets', shop: S.SHOP_DEF }), 'lr&t=odds&m=markets');
  assert.deepEqual(round({ tab: 'odds', mode: 'arb', shop: S.SHOP_DEF }).shop, plain(S.SHOP_DEF));
});

test('game lines filters come back, and other tabs carry only the tab', () => {
  const back = round({ tab: 'odds', mode: 'lines', os: { state: 'TX', league: 'nba', market: 'spread', sort: 'ev', q: 'celtics' } });
  assert.deepEqual(back, { tab: 'odds', mode: 'lines', os: { state: 'TX', league: 'nba', market: 'spread', sort: 'ev', q: 'celtics' } });
  assert.deepEqual(round({ tab: 'results', mode: 'opps', shop: { sort: 'hold' } }), { tab: 'results' });
  assert.deepEqual(round({ tab: 'odds', mode: 'maker' }), { tab: 'odds', mode: 'maker' });
});

test('links stay short: a busy view with every venue but one left out is under 200 characters', () => {
  const venues = [...S.VENUES];
  const shop = { ...S.SHOP_DEF, state: '', markets: 'player_prop', sort: 'start', league: 'nfl', q: 'Patrick Mahomes', minEv: '2', minEdge: '1.5', maxAge: '180', hours: '168', minSize: '1000', method: 'multiplicative', excluded: venues.slice(1) };
  const url = ORIGIN + S.encode({ tab: 'odds', mode: 'markets', shop, name: 'Texas props' });
  assert.ok(url.length < 200, `${url.length}: ${url}`);
  assert.ok((ORIGIN + S.encode({ tab: 'odds', mode: 'opps', shop: { ...S.SHOP_DEF, league: 'nfl' } })).length < 110);
});

test('a link never carries the stake, odds format, favorites, compact setting, slips or alerts', () => {
  const opts = { ...S.SHOP_DEF, stake: '2500', fmt: 'decimal', compact: true, favLeagues: ['nba'], favVenues: ['kalshi'], favOnly: false, slips: [{ id: 1 }], alerts: { on: true } };
  const enc = S.encode({ tab: 'odds', mode: 'opps', shop: S.resolveFavorites(opts, []), os: { hidden: { kalshi: true } } });
  assert.equal(enc, 'lr&t=odds&m=opps');
  for (const bad of ['2500', 'decimal', 'compact', 'kalshi', 'nba', 'slip', 'alert', 'stake', 'fmt']) assert.ok(!enc.includes(bad), bad);
});

test('a Favorites filter goes as the leagues and venues it stands for', () => {
  const opts = { ...S.SHOP_DEF, favOnly: true, favLeagues: ['nba', 'nfl'], favVenues: ['kalshi', 'fanduel'], excluded: ['gemini'] };
  const shop = plain(S.resolveFavorites(opts, ['pinnacle', 'kalshi', 'fanduel', 'gemini', 'betrivers']));
  assert.equal(shop.league, 'nba,nfl');
  assert.deepEqual(shop.excluded.sort(), ['betrivers', 'gemini', 'pinnacle']);
  assert.ok(!('favOnly' in shop) && !('favVenues' in shop));
  const back = round({ tab: 'odds', mode: 'opps', shop });
  assert.equal(back.shop.league, 'nba,nfl');
  assert.deepEqual(back.shop.excluded.sort(), ['betrivers', 'gemini', 'pinnacle']);
  // a league picked by hand wins over the starred list; no board yet: the known venues
  assert.equal(S.resolveFavorites({ ...opts, league: 'mlb' }, []).league, 'mlb');
  assert.ok(S.resolveFavorites(opts, []).excluded.includes('polymarketus'));
});

test('anything else after # is not a share link, and bad values fall back to defaults', () => {
  for (const h of ['', '#', '#top', '#lrx&t=odds', '#lr&t=nosuchtab', '#lr&t=../x', '#lr']) assert.equal(S.decode(h, TABS), null, h);
  const back = plain(S.decode('#lr&t=odds&m=evil&st=zz&lg=<script>&so=drop&ev=1e9&ag=5&dv=x&ex=1.../..&n=%3Cb%3Ehi', TABS));
  assert.equal(back.mode, 'lines');
  assert.deepEqual(back.os, { state: '', league: '', market: '', sort: 'start', q: '' });
  const shop = plain(S.decode('#lr&t=odds&m=opps&st=zz&lg=<script>&so=drop&ev=1e9&ag=5&dv=x&ex=1.../..', TABS)).shop;
  assert.deepEqual(shop, { ...plain(S.SHOP_DEF), excluded: ['pinnacle'] });
  assert.equal(back.name, '<b>hi', 'the name is shown as text, never as markup');
  assert.equal(S.decode('#lr&t=odds&m=opps&q=' + 'x'.repeat(500), TABS).shop.q.length, S.MAX_Q);
});

test('the app reads the link once, drops it from the address bar and skips the welcome screen', () => {
  assert.match(html, /const LR_SHARED = \(\(\) => \{[\s\S]*?history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
  assert.match(html, /function welcomeInit\(\) \{\n[^\n]*\n {2}if \(LR_SHARED\)/);
  for (const fn of ['lrShareScreen', 'lrCopyLink', 'shpPresetShare']) assert.ok(html.includes(`function ${fn}(`), fn);
  assert.ok(html.includes('id="linkBtn"') && html.includes('SHARE VIEW'));
});
