const test = require('node:test');
const assert = require('node:assert');
const { decodeTurboStream, pick6Home, pick6Sports, pick6Payouts, parsePick6Board } = require('../pickem');
const { createPick6Reader } = require('../pick6');
const sportProps = require('../sportprops');
const B = require('../propsboard');
const { legDecimal } = require('../sporttrack');
const { PICK6_PAYOUTS } = require('../slip');

// a turbo-stream encoder for fixtures: objects as { _keyIndex: valueIndex }
function encode(root) {
  const arr = [];
  const put = v => {
    if (v === null || v === undefined) return -7;
    if (typeof v !== 'object') { const i = arr.indexOf(v); if (i >= 0) return i; arr.push(v); return arr.length - 1; }
    const i = arr.length; arr.push(null);
    if (Array.isArray(v)) arr[i] = v.map(put);
    else { const o = {}; for (const [k, x] of Object.entries(v)) { const ki = put(k); o[`_${ki}`] = put(x); } arr[i] = o; }
    return i;
  };
  put(root);
  return JSON.stringify(arr) + '\nP1:[]\n';
}

// the shape pick6.draftkings.com answered with on 2026-10-15 (NFL and CS cards trimmed)
const home = (cards, extra = {}) => ({
  carouselPills: [
    { label: 'NFL', sportLeagueKey: '1-1', sportLeaguePillData: { hasPicksAvailable: true } },
    { label: 'NFL SUN', sportLeagueKey: '1-1x', sportLeaguePillData: { hasPicksAvailable: true } },
    { label: 'NBA SZN', sportLeagueKey: '21-128', sportLeaguePillData: { hasPicksAvailable: true } },
    { label: 'CS', sportLeagueKey: '19-81', sportLeaguePillData: { hasPicksAvailable: true } },
    { label: 'NHL', sportLeagueKey: '3-3', sportLeaguePillData: { hasPicksAvailable: false } },
  ],
  entryDetails: { payoutPackages: [
    { pickSetSize: 3, payoutTiers: [{ numberOfPicksCorrect: 3, guaranteedMultiplier: 6 }] },
    { pickSetSize: 5, payoutTiers: [{ numberOfPicksCorrect: 5, guaranteedMultiplier: 12 }, { numberOfPicksCorrect: 4, guaranteedMultiplier: 1 }] },
  ] },
  pickGroups: [{ pickGroupId: 1 }, { pickGroupId: 2 }], selectedPickGroup: { pickGroupId: 1 },
  pickCardsResponse: {
    pickSixMarketById: {
      18: { name: 'Receiving Yards', propositionNameById: { 1: 'More', 2: 'Less' } },
      95: { name: 'Receiving Yards', propositionNameById: { 1: 'More', 2: 'Less' } },
      461: { name: 'Kills', propositionNameById: { 1: 'More', 2: 'Less' } },
    },
    entityInfoByDkId: { 10: { fullName: 'Courtland Sutton' }, 11: { fullName: 'Bo Nix' }, 20: { name: 'xKacpersky' } },
    displayTeamById: { 332: { name: 'DEN' }, 900: { name: 'NiP' } },
    competitionById: {
      6176816: { compId: 6176816, startTime: '2026-10-16T00:15:00.0000000+00:00', name: 'SEA @ DEN', entityCompByDkId: { 10: { teamId: 332 }, 11: { teamId: 332 } } },
      6240720: { compId: 6240720, startTime: '2026-10-15T08:25:00.0000000+00:00', name: 'AUR @ NiP', totalCompTime: 'Maps 1-2', entityCompByDkId: { 20: { teamId: 900 } } },
    },
    pickCardByPickableId: cards,
  },
  ...extra,
});
const sel = (prop, mult) => ({ statLinePropositionId: prop, standingsMultiplier: mult });
const nflCards = {
  1: { entities: [{ dkId: 10, compIds: [6176816] }], activePickableMarkets: [
    { pickSixMarketId: 95, promoPickTypeId: 1, targetValue: 59.5, activeSelections: [sel(1, 1.2)] },          // one-sided alt ladder: out
    { pickSixMarketId: 18, promoPickTypeId: 1, targetValue: 47.5, activeSelections: [sel(1, 1), sel(2, 0.9)] },
  ] },
  2: { entities: [{ dkId: 11, compIds: [6176816] }], activePickableMarkets: [
    { pickSixMarketId: 18, promoPickTypeId: 1, isPaused: true, targetValue: 10.5, activeSelections: [sel(1, 1), sel(2, 1)] },   // paused: out
  ] },
  3: { entities: [{ dkId: 10, compIds: [6176816] }, { dkId: 11, compIds: [6176816] }], activePickableMarkets: [
    { pickSixMarketId: 18, promoPickTypeId: 1, targetValue: 99.5, activeSelections: [sel(1, 1), sel(2, 1)] },   // two players: out
  ] },
};

test('Pick6: the turbo-stream loader data decodes, from the route data answer', () => {
  const h = home(nflCards);
  const text = encode({ 'routes/_homeShared': { data: h } });
  const back = pick6Home(decodeTurboStream(text));
  assert.deepStrictEqual(back.pickGroups, h.pickGroups);
  assert.strictEqual(back.pickCardsResponse.entityInfoByDkId['10'].fullName, 'Courtland Sutton');
  assert.strictEqual(decodeTurboStream('<html>'), null);
});

test('Pick6: single-player, two-sided, unpaused lines with each side’s multiplier', () => {
  const lines = parsePick6Board(home(nflCards), 'NFL');
  assert.deepStrictEqual(lines, [{ book: 'pick6', sport: 'NFL', player: 'Courtland Sutton', team: 'DEN', market: 'Receiving Yards', line: 47.5,
    startTime: '2026-10-16T00:15:00.000Z', matchTitle: 'SEA @ DEN', gameId: 6176816, overMultiplier: 1, underMultiplier: 0.9, overOpen: true, underOpen: true, p6Market: null }]);
});

test('Pick6: esports stats carry the map span the way PrizePicks writes it', () => {
  const cards = { 9: { entities: [{ dkId: 20, compIds: [6240720] }], activePickableMarkets: [{ pickSixMarketId: 461, promoPickTypeId: 1, targetValue: 27.5, activeSelections: [sel(1, 1), sel(2, 1)] }] } };
  const [l] = parsePick6Board(home(cards), 'CS');
  assert.strictEqual(l.market, 'MAPS 1-2 Kills');
  assert.strictEqual(l.sport, 'CS');
  assert.strictEqual(l.team, 'NiP');
  assert.strictEqual(B.normLine(l).esports, true);
});

test('Pick6: sports list skips season-long boards, repeats and closed sports; payouts come off the entry screen', () => {
  assert.deepStrictEqual(pick6Sports(home({})).map(s => [s.label, s.open]), [['NFL', true], ['CS', true], ['NHL', false]]);
  assert.deepStrictEqual(pick6Payouts(home({})), { 3: { 3: 6 }, 5: { 5: 12, 4: 1 } });
});

test('Pick6 pricing: graded at its 3-pick 6x, each pick’s multiplier scales the payout', () => {
  const p6 = sportProps.setPick6Payouts(PICK6_PAYOUTS);
  assert.strictEqual(p6.grade.legs, 3);
  assert.ok(Math.abs(p6.grade.be - 0.5503) < 1e-4);
  const even = sportProps.fixedLeg('pick6', 0.58, 1), cut = sportProps.fixedLeg('pick6', 0.58, 0.9);
  assert.ok(Math.abs(even.ev - (0.58 / p6.grade.be - 1) * 100) < 1e-9);
  assert.ok(cut.ev < 0 && even.ev > 5);
  assert.ok(Math.abs(legDecimal('pick6', 1) - 1 / 0.5503) < 1e-9);
  // the side Pick6 trims to 0.9x is the side it thinks likelier
  const pOver = sportProps.bookPOver('pick6', { line: 1.5, over: 1, under: 0.9, overOpen: true, underOpen: true });
  assert.ok(pOver < 0.5 && pOver > 0.45);
  assert.strictEqual(sportProps.bookPOver('pick6', { line: 1.5, over: 1, under: null, overOpen: true, underOpen: false }), 0.5);
});

test('Pick6 weighs nothing in another app’s fair until its record earns it', () => {
  const row = { sport: 'NFL', mkey: 'rec_yds', books: {
    underdog: { line: 47.5, over: 1, under: 1, overOpen: true, underOpen: true },
    pick6: { line: 60.5, over: 1, under: 1, overOpen: true, underOpen: true } } };
  assert.strictEqual(sportProps.fairFor(row, 'underdog', 47.5, { o: { ...sportProps.DEFAULTS, minOthers: 1 } }), null);
});

test('Pick6 sharp-consensus legs price at its own table', () => {
  const row = { sport: 'NFL', mkey: 'rec_yds', esports: false, books: { pick6: { line: 47.5, over: 1, under: 0.9, overOpen: true, underOpen: true } } };
  const sharp = [{ book: 'pinnacle', line: 47.5, pOver: 0.6 }, { book: 'fanduel', line: 47.5, pOver: 0.6 }];
  const plays = sportProps.consensusPlays(row, { sharp, dfsEv: () => { throw new Error('fixed-table apps never reach dfsEv'); } });
  const over = plays.find(p => p.side === 'Over');
  assert.strictEqual(over.entry, '3-pick');
  assert.ok(Math.abs(over.ev - (over.fair / 0.5503 - 1) * 100) < 0.05);
  assert.ok(plays.find(p => p.side === 'Under').ev < over.ev);
});

test('an esports Pick6 line on a model-priced number takes that fair at Pick6’s payout', () => {
  const soon = new Date(Date.now() + 3600e3).toISOString();
  const es = { book: 'prizepicks', sport: 'CS2', player: 'donk', market: 'MAPS 1-2 Kills', line: 38.5, startTime: soon };
  const esKey = () => 'k|1-2';
  const rows = B.buildRows([es, { ...es, book: 'pick6', sport: 'CS', overMultiplier: 1, underMultiplier: 1, overOpen: true, underOpen: true }], { esKey });
  const pick = { side: 'OVER', prob: 60, share: { mean: 41, share: 0.25, pinPerMap: 80, pinMean: 160, priced: { side: 'OVER', prob: 60,
    cells: { PP: { side: 'OVER', ev: 9.03, prob: 60, clears: true } } } } };
  B.priceRows(rows, { esPicks: new Map([[rows[0].key, pick]]), fixedEv: (b, f, m) => sportProps.fixedLeg(b, f, m).ev });
  const c = rows[0].books.pick6;
  assert.strictEqual(c.ev.twin, 'prizepicks');
  assert.strictEqual(c.ev.clears, true);
  assert.ok(Math.abs(c.ev.ev - (0.6 / 0.5503 - 1) * 100) < 0.01);
  // another number stays unpriced
  const rows2 = B.buildRows([es, { ...es, book: 'pick6', sport: 'CS', line: 40.5, overMultiplier: 1, underMultiplier: 1 }], { esKey });
  B.priceRows(rows2, { esPicks: new Map([[rows2[0].key, pick]]), fixedEv: (b, f, m) => sportProps.fixedLeg(b, f, m).ev });
  assert.strictEqual(rows2[0].books.pick6.ev, undefined);
});

test('Pick6 reader: one sport a tick, every pick group, backs off on a 429 for its Retry-After', async () => {
  let t = 1e12;
  const calls = [];
  const h = home(nflCards);
  let fail = null;
  const axios = { get: async (url, { params }) => {
    calls.push(params);
    if (fail) { const e = new Error('limited'); e.response = { status: 429, headers: { 'retry-after': String(fail) } }; throw e; }
    return { data: encode({ 'routes/_homeShared': { data: h } }) };
  } };
  const r = createPick6Reader(axios, { enabled: true, now: () => t, sleep: async () => {}, log: {} });
  await r.tick();
  // the home read, then NFL's first group and its second
  assert.deepStrictEqual(calls, [{}, { sport: 'NFL' }, { sport: 'NFL', pickGroup: 2 }]);
  assert.strictEqual(r.lines().length, 1);   // the same line in both groups, once
  assert.ok(r.readTimes()['pick6|NFL']);
  fail = 1800;
  await r.tick();
  assert.strictEqual(r.status().blockedUntil, new Date(t + 1800e3).toISOString());
  const n = calls.length;
  await r.tick();
  assert.strictEqual(calls.length, n);   // blocked: no request
  t += 46 * 60e3;
  assert.strictEqual(r.lines().length, 0);   // unread 45 minutes: off the board
});

test('Pick6 reader: blocked, it takes the relayed board, newer sports only', async () => {
  const { createPick6Reader } = require('../pick6');
  let t = Date.parse('2026-10-15T16:30:00Z');
  const relay = { at: '2026-10-15T16:25:00Z', payouts: { 3: { 3: 6 } }, sports: [{ label: 'NFL', open: true }],
    bySport: { NFL: { at: '2026-10-15T16:24:00Z', groups: 2, lines: [{ player: 'A', sport: 'NFL', market: 'Pass Yards', line: 250.5 }] } } };
  const axios = { get: async (url) => {
    if (url.includes('pick6-data')) return { data: JSON.stringify(relay) };
    const e = new Error('403'); e.response = { status: 403, headers: {} }; throw e;
  } };
  const r = createPick6Reader(axios, { enabled: true, relayUrl: 'https://raw.githubusercontent.com/x/y/pick6-data/pick6.json', now: () => t, sleep: async () => {}, log: {} });
  await r.tick();
  assert.strictEqual(r.lines().length, 1);
  assert.deepStrictEqual(r.state.payouts, { 3: { 3: 6 } });
  assert.strictEqual(r.readTimes()['pick6|NFL'], '2026-10-15T16:24:00.000Z');
  assert.ok(r.status().relay.sports.includes('NFL'));
  // still blocked on the next tick: no DraftKings call, the relay again
  t += 120e3;
  relay.bySport.NFL.at = '2026-10-15T16:20:00Z';
  await r.tick();
  assert.strictEqual(r.state.bySport.NFL.at, Date.parse('2026-10-15T16:24:00Z'));
  // 45 minutes after GitHub's read the lines drop
  t = Date.parse('2026-10-15T17:10:00Z');
  assert.strictEqual(r.lines().length, 0);
});

test('Pick6 reader: the first group\'s other stat tabs from the site\'s resource route, quick hits skipped', async () => {
  const { extraCategories } = require('../pick6');
  const cats = { 121: { pickCategoryId: 121, categoryName: 'Points' }, 17: { pickCategoryId: 17, categoryName: 'Rebounds' }, 20: { pickCategoryId: 20, categoryName: 'Quick Hits' }, 28: { pickCategoryId: 28, categoryName: '1st 3 Min' }, 123: { pickCategoryId: 123, categoryName: 'Combos' } };
  const pcBase = home(nflCards).pickCardsResponse;
  assert.deepStrictEqual(extraCategories({ pickCategoryId: 121, pickCategoryById: cats, orderedPickCategoryIds: [121, -100, 17, 20, 123, 28] }), [17, 123]);
  assert.deepStrictEqual(extraCategories({}), []);
  const h = home(nflCards, {});
  h.pickCardsResponse = { ...pcBase, pickCategoryId: 121, pickCategoryById: cats, orderedPickCategoryIds: [121, 17, 20, 123] };
  const tab = { ...pcBase, pickCategoryId: 17, pickCardByPickableId: { 9: { entities: [{ dkId: 11, compIds: [6176816] }], activePickableMarkets: [
    { pickSixMarketId: 18, promoPickTypeId: 1, targetValue: 230.5, activeSelections: [sel(1, 1), sel(2, 1)] }] } } };
  const urls = [];
  const axios = { get: async (url, { params } = {}) => {
    urls.push(url.replace('https://pick6.draftkings.com', '') + (params?.pickGroup ? `?g=${params.pickGroup}` : ''));
    if (url.includes('/resources/pickCardsByCategory/')) return { data: url.endsWith('/17') ? tab : { ...tab, pickCategoryId: 123, pickCardByPickableId: {} } };
    return { data: encode({ 'routes/_homeShared': { data: h } }) };
  } };
  const r = createPick6Reader(axios, { enabled: true, sleep: async () => {}, log: {} });
  await r.tick();
  assert.deepStrictEqual(urls.filter(u => u.includes('resources')), ['/resources/pickCardsByCategory/1/17', '/resources/pickCardsByCategory/1/123']);
  assert.strictEqual(r.lines().length, 2, 'the board\'s line and the Rebounds tab\'s');
  assert.strictEqual(r.state.bySport.NFL.tabs, 2);
});
