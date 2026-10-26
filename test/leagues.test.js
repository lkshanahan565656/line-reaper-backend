// League pages (leagues.js): one public page per league, server-rendered from
// the live board and the strict public record. The pure renderer here; the
// routes, sitemap and robots on a booted server in leagues-server.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../leagues');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const block = html.match(/^\/\/ LR_SHARE_BEGIN\n([\s\S]*?)^\/\/ LR_SHARE_END$/m)[1];
const S = vm.runInNewContext(`${block}\nLRShare`, { URLSearchParams });
const TABS = ['odds', 'props', 'esports', 'results'];
const NOW = Date.parse('2026-10-26T12:00:00Z');

const PROVEN = { kind: 'ev', kindLabel: 'Main lines', book: 'betrivers', bookName: 'BetRivers', graded: 373, texas: false, profitShown: false, units: -7.1, inLeague: 41 };
const LABELS = [{ tool: 'Exchange Shopper: best prices above fair', where: 'ODDS SCREEN', tag: 'research', why: 'Exchange flags have not beaten the close yet.' },
  { tool: 'NFL model', where: 'ODDS SCREEN > NFL MODEL', tag: 'model, not an edge', why: 'Kalshi beat it.' },
  { tool: 'Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', where: 'ESPORTS > MATCHUPS', tag: 'model, not an edge', why: 'The exchanges beat it.' }];
const REC = { ruleText: 'A kind is marked proven only with 50 graded games.', labels: LABELS, proven: [PROVEN] };

test('the twelve leagues each have a path, and every app link opens that league in the app', () => {
  assert.deepEqual(L.ORDER.map(k => L.LEAGUES[k].path), ['/nfl', '/nba', '/nhl', '/cfb', '/cbb', '/mlb', '/soccer', '/tennis', '/esports/lol', '/esports/cs2', '/esports/valorant', '/esports/dota2']);
  for (const k of L.ORDER) {
    const cfg = L.LEAGUES[k];
    assert.equal(L.byPath(cfg.path), k);
    const links = L.appLinks(cfg);
    assert.ok(links.length >= 2, `${k} links into the app`);
    for (const l of links) {
      assert.match(l.href, /^\/app#lr&/);
      const s = S.decode(l.href.slice(l.href.indexOf('#')), TABS);
      assert.ok(s, `${k}: ${l.href} decodes`);
      if (s.tab === 'odds' && s.mode === 'opps') assert.equal(s.shop.league, cfg.keys.join(','), `${k}: the shopper opens on the league`);
      if (s.tab === 'odds' && s.mode === 'lines') assert.equal(s.os.league, cfg.lines, `${k}: game lines open on the league`);
      if (s.tab === 'props' && l.href.includes('sp=')) assert.equal(s.props.sport, cfg.props, `${k}: props open on the sport`);
      if (s.tab === 'esports' && s.es.mode === 'matches') assert.equal(s.es.game, cfg.es.game, `${k}: the match board opens on the game`);
      if (s.tab === 'esports' && s.es.mode === 'matchups') assert.equal(s.es.emuGame, cfg.es.emu, `${k}: matchups open on the game`);
    }
  }
  assert.equal(L.bySlug('__proto__'), null);
  assert.equal(L.render('nope', {}), null);
});

test('a sports page shows the best Texas prices above fair, labelled research, with fill size and the record', () => {
  const board = { readAt: new Date(NOW - 120e3).toISOString(), pro: true, games: 3, markets: 9, priced: 8, above: 1, locked: 1, venues: ['Kalshi', 'Polymarket US'], anyExchange: true,
    opps: [{ event: 'Away Owls @ Home Hawks', start: new Date(NOW + 3 * 3600e3).toISOString(), marketName: 'Moneyline', selection: 'Away Owls', provider: 'kalshi', providerName: 'Kalshi',
      american: 145, fairAmerican: 135, fair: 0.4255, ev: 0.0412, exchange: true, label: 'lead',
      size: { tiers: { 50: { full: true }, 200: { full: true }, 1000: { full: false } }, topUsd: 380 } }] };
  const h = L.render('nfl', { now: NOW, board, record: REC }, { origin: 'https://x.test' });
  assert.ok(h.startsWith('<!doctype html>'));
  assert.ok(!/NaN|undefined|Infinity|>null</.test(h), 'a number did not compute');
  assert.match(h, /<link rel="canonical" href="https:\/\/x\.test\/nfl">/);
  assert.match(h, /<meta name="description" content="[^"]{60,}">/);
  assert.match(h, /<title>NFL odds comparison/);
  assert.match(h, /og:image" content="https:\/\/x\.test\/og\.png"/);
  assert.match(h, /Away Owls[\s\S]*Kalshi[\s\S]*\+145[\s\S]*\+135[\s\S]*\+4\.1%[\s\S]*fills \$200[\s\S]*research/);
  assert.match(h, /Texas venues on this board: Kalshi, Polymarket US/);
  // the record: the proven kind's whole count, this league's share, Texas and profit honestly
  assert.match(h, /BetRivers main lines <span class="tag pv">proven<\/span>/);
  assert.match(h, /373 graded across every league; 41 of its graded flags in the public file were NFL games/);
  assert.match(h, /Not a Texas venue/);
  assert.match(h, /Profit not shown yet/);
  assert.doesNotMatch(h, /-7\.1u/, 'units are not shown while profit is not shown');
  assert.match(h, /Nothing is proven yet at a venue a Texas resident can use/);
  // only this league's labels
  assert.match(h, /NFL model[\s\S]*model, not an edge/);
  assert.doesNotMatch(h, /Esports matchups/);
  assert.doesNotMatch(h, /polymarket\.com/i);
  assert.doesNotMatch(h, /guaranteed|risk[- ]free|sure thing|lock of/i);
  // every league is linked from every page
  for (const k of L.ORDER) assert.ok(h.includes(`href="${L.LEAGUES[k].path}"`), `links ${k}`);
});

test('no data, the paywall view and nothing proven each say so plainly', () => {
  const empty = L.render('cbb', { now: NOW, board: { readAt: null, markets: 0 }, record: { ...REC, proven: [] } });
  assert.match(empty, /No college basketball games on the board in the next 48 hours/);
  assert.match(empty, /Nothing is proven yet/);
  assert.match(empty, /not read yet/);
  assert.doesNotMatch(empty, /class="tag pv"/);
  const locked = L.render('nba', { now: NOW, board: { readAt: new Date(NOW).toISOString(), pro: false, games: 2, markets: 4, priced: 4, above: 3, locked: 3, venues: ['Kalshi'], opps: [] }, record: REC });
  assert.match(locked, /3 Texas prices sit above the fair right now\. The fair and the EV are in the app with Pro\./);
  assert.doesNotMatch(locked, /<th>EV<\/th>/);
  const none = L.render('nhl', { now: NOW, board: { readAt: new Date(NOW).toISOString(), pro: true, games: 2, markets: 4, priced: 4, above: 0, locked: 0, venues: [], opps: [] }, record: REC });
  assert.match(none, /No Texas price sits above Pinnacle's fair right now/);
  assert.match(none, /No Texas venue prices these games right now/);
  const noRec = L.render('mlb', { now: NOW, board: null, record: null });
  assert.match(noRec, /The record could not be read just now/);
  const shown = L.render('nfl', { now: NOW, board: null, record: { ...REC, proven: [{ ...PROVEN, texas: true, profitShown: true, units: 12.4 }] } });
  assert.match(shown, /profit \+12\.4u/);
  assert.match(shown, /Texas: yes/);
  assert.doesNotMatch(shown, /Nothing is proven yet at a venue a Texas resident/);
});

test('an esports page shows Kalshi beside the sharp price where there is one, and the model label', () => {
  const board = { readAt: new Date(NOW - 60e3).toISOString(), pro: true, kalshi: 1, sharp: 1, above: 1, matches: [
    { teams: ['T1', 'Gen.G'], tournament: 'Worlds', bestOf: 5, live: false, start: new Date(NOW + 5 * 3600e3).toISOString(),
      sides: [{ name: 'T1', cost: 0.4432, ref: 0.47, ev: 0.06 }, { name: 'Gen.G', cost: 0.5731, ref: 0.53, ev: -0.075 }] },
    { teams: ['A', 'B'], tournament: null, bestOf: 3, live: true, start: new Date(NOW - 600e3).toISOString(), sides: [{ name: 'A', cost: null, ref: null, ev: null }, { name: 'B', cost: null, ref: null, ev: null }] }] };
  const h = L.render('lol', { now: NOW, board, record: REC }, { origin: 'https://x.test' });
  assert.ok(!/NaN|undefined|Infinity|>null</.test(h));
  assert.match(h, /League of Legends odds/);
  assert.match(h, /T1 vs Gen\.G[\s\S]*Worlds · Bo5[\s\S]*Kalshi 44\.3¢ fee in · sharp 47¢ · EV \+6\.0%/);
  assert.match(h, /no Kalshi price/);
  assert.match(h, /live/);
  assert.match(h, /Esports matchups[\s\S]*model, not an edge/);
  assert.match(h, /href="\/app#lr&amp;t=esports&amp;g=LOL"/);
  const off = L.render('dota2', { now: NOW, board: { ...board, matches: [] }, record: REC });
  assert.match(off, /No Dota 2 matches on the board right now/);
});

test('fill size reads the exchange book in plain words', () => {
  assert.equal(L.sizeText(null), 'no size posted');
  assert.equal(L.sizeText(null, { exchange: true }), 'size not read');
  assert.equal(L.sizeText({ unread: true }), 'book not read yet');
  assert.equal(L.sizeText({ tiers: { 50: { full: true }, 200: { full: true }, 1000: { full: true } } }), 'fills $1,000+');
  assert.equal(L.sizeText({ tiers: { 50: { full: false } }, topUsd: 31 }), 'only $31 at this price');
  assert.equal(L.sizeText({ tiers: {}, topUsd: 0 }), 'nothing at this price');
});

test('the index lists every league', () => {
  const h = L.index({ record: REC }, { origin: 'https://x.test' });
  assert.match(h, /<link rel="canonical" href="https:\/\/x\.test\/leagues">/);
  for (const k of L.ORDER) assert.ok(h.includes(`href="${L.LEAGUES[k].path}"`));
  assert.match(h, /373 graded across every league<\/td>/);
});
