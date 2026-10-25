// LoL head-to-head matchup engine: series math, ratings, names, the data
// layer (schedule, Kalshi pairing, forward record) and the API.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../esmatchup');
const D = require('../esmatchupdata');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const DAY = 86400e3;

test('series scores sum to one for every best-of, independent maps match the binomial', () => {
  for (const bo of [1, 2, 3, 5]) for (const k of [4, 10, Infinity]) {
    const sc = bo === 1 ? [{ prob: 0.6 }, { prob: 0.4 }] : M.seriesScores(0.6, bo, k);
    close(sc.reduce((s, x) => s + x.prob, 0), 1, 1e-9);
  }
  // Bo3 independent at p: p^2 + 2 p^2 (1-p)
  close(M.seriesProb(0.6, 3, Infinity), 0.36 + 2 * 0.36 * 0.4, 1e-9);
  // Bo2 can draw
  const bo2 = M.seriesMarkets(0.5, 2, 10);
  assert.ok(bo2.draw > 0.4 && bo2.draw < 0.5);
});

test('series shape: a favourite sweeps more and wins the series less often than independent maps say', () => {
  const ind = M.seriesScores(0.75, 3, Infinity), cor = M.seriesScores(0.75, 3, 10);
  const sweep = sc => sc.find(s => s.a === 2 && s.b === 0).prob;
  assert.ok(sweep(cor) > sweep(ind) - 0.08);
  assert.ok(M.seriesProb(0.75, 3, 10) < M.seriesProb(0.75, 3, Infinity));
  // decider less often with correlation
  assert.ok(M.seriesMarkets(0.75, 3, 10).allMaps < M.seriesMarkets(0.75, 3, Infinity).allMaps);
  // mapFromSeries inverts seriesProb
  for (const bo of [3, 5]) close(M.seriesProb(M.mapFromSeries(0.7, bo, 10), bo, 10), 0.7, 1e-6);
});

test('lgamma matches known values', () => {
  close(M.lgamma(1), 0, 1e-10);
  close(M.lgamma(5), Math.log(24), 1e-10);
  close(M.lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10);
});

const t0 = Date.parse('2026-01-10T10:00:00Z');
function league(lg, teams, rounds, start = t0, strongest = 0) {
  // a round robin where team i beats team j when i < j (strongest first), Bo3 2-0 / 2-1
  const out = [];
  let t = start, id = 0;
  for (let r = 0; r < rounds; r++) for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    t += 3600e3;
    out.push({ id: `${lg}${id++}`, t: new Date(t).toISOString(), lg, bo: 3, a: teams[i], ac: teams[i].slice(0, 3).toUpperCase(), b: teams[j], bc: teams[j].slice(0, 3).toUpperCase(), s1: 2, s2: (i + j + r) % 2 });
  }
  return out;
}

test('ratings: winners rise, RD shrinks with play and grows idle, new teams start at their league prior', () => {
  const R = M.buildRatings(league('LCK', ['Alpha', 'Bravo', 'Charlie', 'Delta'], 3));
  const tab = R.table({ t: t0 + 30 * DAY });
  assert.deepEqual(tab.map(x => x.name), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  const a = R.find('Alpha');
  assert.ok(a.rd < M.DEFAULTS.rdNew);
  const now = R.teamView(a, a.lastT).rd, later = R.teamView(a, a.lastT + 60 * DAY).rd;
  assert.ok(later > now);
  // a new LEC team starts near the LEC prior, an LCK team near the LCK prior
  const R2 = M.createRatings();
  R2.update({ t: t0, lg: 'LEC', bo: 1, a: 'Echo', b: 'Foxtrot', s1: 1, s2: 0 });
  R2.update({ t: t0, lg: 'LCK', bo: 1, a: 'Golf', b: 'Hotel', s1: 1, s2: 0 });
  assert.ok(R2.find('Golf').r > R2.find('Echo').r + 80);
  assert.equal(R2.find('Echo').startedAt, 'LEC prior');
});

test('cross-league results move the whole league', () => {
  const A = league('LCK', ['Alpha', 'Bravo', 'Charlie'], 2), B = league('LEC', ['Echo', 'Foxtrot', 'Golf'], 2);
  const end = Date.parse(A[A.length - 1].t) + DAY;
  // the LEC's weakest team beats the LCK's best at Worlds, three times
  const intl = [0, 1, 2].map(i => ({ id: `w${i}`, t: new Date(end + i * DAY).toISOString(), lg: 'Worlds', bo: 3, a: 'Golf', b: 'Alpha', s1: 2, s2: 0 }));
  const before = M.buildRatings([...A, ...B]), after = M.buildRatings([...A, ...B, ...intl]);
  const t = end + 5 * DAY;
  const echoGap = R => R.teamView(R.find('Echo'), t).rating - R.teamView(R.find('Bravo'), t).rating;
  // Echo never played Bravo, yet moves up against it
  assert.ok(echoGap(after) > echoGap(before) + 10);
  const lec = after.leagues(t).find(x => x.league === 'LEC');
  assert.ok(lec.learned > 0);
});

test('predict: priced with explanation; insufficient data when a team barely played', () => {
  const R = M.buildRatings(league('LCK', ['Alpha', 'Bravo', 'Charlie', 'Delta'], 3));
  const p = R.predict('Alpha', 'Delta', { bestOf: 5, t: t0 + 20 * DAY });
  assert.equal(p.priced, true);
  assert.ok(p.series.win > 0.5 && p.series.win < 1);
  assert.ok(p.band[0] <= p.series.win && p.band[1] >= p.series.win);
  assert.equal(p.series.scores.length, 6);
  const ex = M.explain(p, { market: { venue: 'Kalshi', prob: 0.6 } });
  assert.ok(ex[0].startsWith('Alpha rate'));
  assert.ok(ex.some(x => /Kalshi prices Alpha at 60%/.test(x)));
  assert.ok(ex.some(x => /Model view only/.test(x)));
  // one series only
  const R2 = M.buildRatings([{ t: t0, lg: 'LCK', bo: 1, a: 'New One', b: 'Alpha', s1: 1, s2: 0 }]);
  const q = R2.predict('New One', 'Alpha', { bestOf: 3, t: t0 + DAY });
  assert.equal(q.priced, false);
  assert.equal(q.confidence, 'insufficient');
  assert.ok(M.explain(q).some(x => /No model price/.test(x)));
  // unknown team
  const u = R2.predict('Nobody', 'Alpha');
  assert.equal(u.ok, false);
  assert.ok(u.reasons[0].includes('Nobody'));
});

test('head-to-head is counted only before the moment priced', () => {
  const R = M.buildRatings(league('LCK', ['Alpha', 'Bravo', 'Charlie', 'Delta'], 2));
  const first = Date.parse(league('LCK', ['Alpha', 'Bravo', 'Charlie', 'Delta'], 2)[0].t);
  assert.equal(R.h2h(R.find('Alpha'), R.find('Bravo'), first).series, 0);
  assert.equal(R.h2h(R.find('Alpha'), R.find('Bravo'), first + 30 * DAY).series, 2);
});

test('team names across venues', () => {
  assert.ok(M.nameScore('OKSavingsBank BRION', 'HANJIN BRION') >= 0.6);
  assert.ok(M.nameScore('JD Gaming', 'Beijing JDG Esports') >= 0.6);
  assert.ok(M.nameScore('DRX', 'KIWOOM DRX') >= 0.6);
  assert.ok(M.nameScore('GEN', 'Gen.G Esports', 'GEN') >= 0.9);
  assert.equal(M.nameScore('T1 Academy', 'T1'), 0);
  assert.equal(M.nameScore('Fnatic', 'G2 Esports'), 0);
});

const sched = [
  { type: 'match', state: 'completed', startTime: '2026-10-20T10:00:00Z', league: { name: 'Worlds' }, match: { id: '1', strategy: { count: 3 }, teams: [{ name: 'Alpha', code: 'ALP', result: { gameWins: 2 } }, { name: 'Bravo', code: 'BRV', result: { gameWins: 1 } }] } },
  { type: 'match', state: 'unstarted', startTime: '2026-10-26T10:00:00Z', blockName: 'Quarterfinals', league: { name: 'Worlds' }, match: { id: '2', strategy: { count: 5 }, teams: [{ name: 'Alpha', code: 'ALP' }, { name: 'Charlie', code: 'CHA' }] } },
  { type: 'match', state: 'unstarted', startTime: '2026-10-27T10:00:00Z', league: { name: 'Worlds' }, match: { id: '3', strategy: { count: 5 }, teams: [{ name: 'TBD' }, { name: 'Charlie' }] } },
  { type: 'show', state: 'unstarted', startTime: '2026-10-27T10:00:00Z' },
];

test('schedule parsing: finished series with scores, upcoming with best-of, TBD dropped', () => {
  const { done, upcoming } = D.parseSchedule(sched);
  assert.deepEqual(done.map(d => [d.id, d.s1, d.s2, d.bo]), [['1', 2, 1, 3]]);
  assert.deepEqual(upcoming.map(u => [u.id, u.bo, u.block]), [['2', 5, 'Quarterfinals']]);
});

const boardMatch = (start, aName, bName, qa, qb) => ({
  game: 'LOL', teams: [aName, bName], start, links: { kalshi: 'https://kalshi.com/x' },
  markets: [{ kind: 'match', outcomes: [{ name: aName, quotes: { kalshi: qa, polymarket: { bid: 0.6, ask: 0.62 } } }, { name: bName, quotes: { kalshi: qb } }] }],
});

test('Kalshi price: no-vig mid of both books, cost with the fee, orientation follows the names', () => {
  const mk = boardMatch('x', 'A', 'B', { bid: 0.6, ask: 0.62 }, { bid: 0.38, ask: 0.4 }).markets[0];
  const k = D.kalshiPrice(mk, false);
  close(k.prob, 0.61 / (0.61 + 0.39), 1e-4);
  close(k.sides[0].cost, 0.62 + 0.07 * 0.62 * 0.38, 1e-4);
  const f = D.kalshiPrice(mk, true);
  close(f.prob, 1 - k.prob, 1e-4);
  assert.equal(f.sides[0].ask, 0.4);
  // a wide book says nothing
  assert.equal(D.kalshiPrice(boardMatch('x', 'A', 'B', { bid: 0.4, ask: 0.62 }, { bid: 0.2, ask: 0.6 }).markets[0], false).prob, null);
  // pairing flips when the venue lists the teams the other way round
  const pair = D.pairBoard({ t: '2026-10-26T10:00:00Z', a: 'Alpha', ac: 'ALP', b: 'Charlie', bc: 'CHA' }, [boardMatch('2026-10-26T11:00:00Z', 'Charlie', 'Alpha', {}, {})]);
  assert.equal(pair.flipped, true);
  assert.equal(D.pairBoard({ t: '2026-10-26T10:00:00Z', a: 'Alpha', b: 'Charlie' }, [boardMatch('2026-10-27T10:00:00Z', 'Charlie', 'Alpha', {}, {})]), null);
});

test('record summary: early under 50, model-side bets at the ask with the fee', () => {
  const rows = [
    { status: 'graded', y: 1, model: 0.7, kalshi: 0.6, costA: 0.62, costB: 0.41, close: 0.65 },
    { status: 'graded', y: 0, model: 0.7, kalshi: 0.6, costA: 0.62, costB: 0.41, close: 0.55 },
    { status: 'graded', y: 1, model: 0.6, kalshi: 0.62, costA: 0.64, costB: 0.4, close: 0.6 },
    { status: 'open', model: 0.5, kalshi: 0.5 },
  ];
  const s = D.summarize(rows);
  assert.equal(s.graded, 3);
  assert.equal(s.open, 1);
  assert.equal(s.verdict, 'early');
  assert.equal(s.sides.bets, 2);
  assert.equal(s.sides.won, 1);
  assert.ok(s.logLoss.model > 0 && s.logLoss.kalshi > 0);
});

// a Polymarket US event shaped like /v2/leagues/lol/events (2026-10-25 read)
function pmEvent(slug, start, long, short, bid, ask, extra = {}) {
  const side = (t, isLong) => ({ long: isLong, description: t[0], team: { name: t[0], abbreviation: t[1].toLowerCase(), displayAbbreviation: t[1] }, tradable: true });
  return { slug, title: `${long[0]} vs. ${short[0]}`, startTime: start, active: true, closed: false, ...extra,
    markets: [{ slug: `aec-${slug}`, sportsMarketType: 'esports_match_winner', status: 'MARKET_STATUS_OPEN', active: true, closed: false, feeCoefficient: 0.0695,
      bestBidQuote: { value: String(bid), currency: 'USD' }, bestAskQuote: { value: String(ask), currency: 'USD' }, marketSides: [side(long, true), side(short, false)] }] };
}

test('Polymarket US: esports match winners parse, price both sides with the fee, and pair by name or code', () => {
  const evs = [
    pmEvent('lol-blg-tlaw-2026-10-24', '2026-10-25T00:00:00Z', ['BILIBILI GAMING', 'BLG'], ['Team Liquid Alienware', 'TLAW'], 0.75, 0.76),
    pmEvent('lol-old', '2026-10-20T00:00:00Z', ['A', 'A'], ['B', 'B'], 0.5, 0.52, { closed: true }),
    { slug: 'lol-x', startTime: '2026-10-25T00:00:00Z', markets: [{ slug: 'm', sportsMarketType: 'esports_total_maps' }] },
  ];
  const list = D.parsePmusEvents(evs);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].teams, ['BILIBILI GAMING', 'Team Liquid Alienware']);
  assert.equal(list[0].url, 'https://polymarket.us/sports/lol/lol-blg-tlaw-2026-10-24');
  assert.ok(!list[0].url.includes('polymarket.com'));
  const p = D.pmusPrice(list[0], false);
  assert.equal(p.prob, 0.755);
  assert.equal(p.sides[0].ask, 0.76);
  assert.equal(p.sides[1].ask, 0.25);
  close(p.sides[1].cost, 0.25 + 0.0695 * 0.25 * 0.75, 1e-4);
  const f = D.pmusPrice(list[0], true);
  assert.equal(f.prob, 0.245);
  assert.equal(f.sides[0].ask, 0.25);
  // lolesports lists them the other way round, with Liquid's sponsor name
  const series = { t: '2026-10-25T00:00:00Z', a: 'Team Liquid Alienware', ac: 'TLAW', b: 'Bilibili Gaming', bc: 'BLG' };
  const pr = D.pairList(series, list);
  assert.ok(pr && pr.flipped);
  // a different day does not pair
  assert.equal(D.pairList({ ...series, t: '2026-10-27T00:00:00Z' }, list), null);
  // a wide book gives costs but no price
  const wide = D.pmusPrice({ ...list[0], bid: 0.5, ask: 0.7 }, false);
  assert.equal(wide.prob, null);
  assert.equal(wide.sides[0].ask, 0.7);
});

function memStore() {
  const rows = new Map();
  return { rows, async all() { return [...rows.values()]; }, async putMany(l) { for (const r of l) rows.set(r.id, { ...r }); } };
}

test('engine: refresh reads the schedule, prices upcoming series next to Kalshi, freezes and grades the record', async () => {
  const seed = league('Worlds', ['Alpha', 'Bravo', 'Charlie', 'Delta'], 3, Date.parse('2026-09-01T00:00:00Z'));
  let now = Date.parse('2026-10-26T09:30:00Z');
  let events = sched.slice(0, 2);
  const http = { async get(url, { params }) {
    if (url.includes('polymarket.us')) return { data: { events: [pmEvent('lol-alp-cha-2026-10-26', '2026-10-26T10:00:00Z', ['Alpha', 'ALP'], ['Charlie', 'CHA'], 0.3, 0.33)] } };
    assert.ok(url.includes('lolesports')); return { data: { data: { schedule: { events: params.pageToken ? [] : events, pages: {} } } } };
  } };
  const board = [boardMatch('2026-10-26T10:00:00Z', 'Charlie', 'Alpha', { bid: 0.3, ask: 0.32 }, { bid: 0.68, ask: 0.7 })];
  const store = memStore();
  const E = D.createMatchupEngine({ http, seed, board: () => board, store, now: () => now, log: {} });
  await E.refresh();
  assert.equal(E.status().upcoming, 1);
  assert.equal(E.status().fetched, 1);
  const [mu] = E.list();
  assert.equal(mu.label, 'model');
  assert.equal(mu.bestOf, 5);
  assert.equal(mu.model.priced, true);
  close(mu.compare.kalshi, 0.69 / (0.69 + 0.31), 1e-3);
  assert.equal(mu.markets.kalshi.sides[0].ask, 0.7);
  assert.equal(mu.markets.polymarketRef, 0.39);
  // Polymarket US: Alpha is its long side, the series' team a is Alpha too
  assert.equal(mu.markets.pmus.prob, 0.315);
  assert.equal(mu.markets.pmus.sides[0].ask, 0.33);
  assert.equal(mu.markets.pmus.sides[1].ask, 0.7);
  assert.equal(mu.markets.pmus.url, 'https://polymarket.us/sports/lol/lol-alp-cha-2026-10-26');
  assert.equal(mu.compare.pmus, 0.315);
  assert.equal(mu.compare.vs, 'Kalshi');
  assert.equal(mu.compare.best.length, 2);
  assert.equal(E.status().pmus.markets, 1);
  assert.ok(mu.explain.length >= 3);
  // 30 minutes out: frozen
  assert.equal(store.rows.size, 1);
  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'open');
  assert.equal(row.kalshi, mu.compare.kalshi);
  assert.equal(row.pmus, 0.315);
  // the result lands: graded
  now = Date.parse('2026-10-26T14:00:00Z');
  events = [{ ...sched[1], state: 'completed', match: { ...sched[1].match, teams: [{ name: 'Alpha', code: 'ALP', result: { gameWins: 3 } }, { name: 'Charlie', code: 'CHA', result: { gameWins: 1 } }] } }];
  await E.refresh();
  const g = store.rows.get('lol:2');
  assert.equal(g.status, 'graded');
  assert.equal(g.y, 1);
  assert.equal(g.result, '3-1');
  assert.equal(E.record().summary.graded, 1);
});

test('engine: a failed fetch keeps the seed ratings and reports the error', async () => {
  const E = D.createMatchupEngine({ http: { async get() { throw new Error('down'); } }, seed: league('LCK', ['Alpha', 'Bravo', 'Charlie'], 2), log: {} });
  await E.refresh();
  const st = E.status();
  assert.equal(st.error, 'down');
  assert.equal(st.ready, true);
  assert.ok(st.teams >= 3);
  assert.equal(st.providers.find(p => p.id === 'riot').state, process.env.RIOT_API_KEY ? 'key set, not used' : 'missing key');
});

test('seed and backtest ship with the repo', () => {
  const seed = D.loadSeed();
  assert.ok(seed.length > 10000);
  assert.ok(seed.every(s => s.id && s.a && s.b && s.s1 != null));
  const bt = D.loadBacktest();
  assert.ok(bt && bt.kalshi && bt.kalshi['T-60'].n > 1000);
  assert.ok(/Kalshi's price beats the model/.test(bt.verdict));
});

test('league strength on the shipped seed follows the international record: LCK, then LPL, then LEC', () => {
  const R = M.buildRatings(D.loadSeed());
  const avg = Object.fromEntries(R.leagues(Date.parse('2026-10-25T00:00:00Z')).map(l => [l.league, l.avg]));
  assert.ok(avg.LCK > avg.LPL, `LCK ${avg.LCK} vs LPL ${avg.LPL}`);
  assert.ok(avg.LPL > avg.LEC, `LPL ${avg.LPL} vs LEC ${avg.LEC}`);
  assert.ok(avg.LEC > avg.LCS, `LEC ${avg.LEC} vs LCS ${avg.LCS}`);
  // an academy event never moves a major-league team (WSCI's "Dplus KIA" was its second roster)
  const dk = R.find('Dplus KIA');
  assert.ok(dk.history.length > 10 && !dk.history.some(h => /wsci/i.test(h.lg || '')));
});

// ── CS2 and VALORANT ──
test('series from the ratings refresh: map games become series, CS2 keeps tier and id, VALORANT gets midday UTC', () => {
  const t = Date.parse('2026-10-24T14:10:00Z');
  const cs = D.seriesFromGames([
    { a: 'Spirit', b: 'MOUZ', aWon: true, t, id: 9, tier: 's', bo: 3 },
    { a: 'Spirit', b: 'MOUZ', aWon: false, t, id: 9, tier: 's', bo: 3 },
    { a: 'Spirit', b: 'MOUZ', aWon: true, t, id: 9, tier: 's', bo: 3 },
    { a: 'FaZe', b: 'NAVI', aWon: false, t: t + 1, tier: null },
  ], 'CS2');
  assert.equal(cs.length, 2);
  const sp = cs.find(s => s.a === 'Spirit');
  assert.deepEqual([sp.id, sp.lg, sp.bo, sp.s1, sp.s2], ['bo3:9', 'CS2 S-tier', 3, 2, 1]);
  assert.equal(cs.find(s => s.a === 'FaZe').lg, 'CS2 other');
  const val = D.seriesFromGames([{ a: 'Sentinels', b: 'G2', aWon: true, t: Date.parse('2026-10-09T00:00:00Z'), id: '555' }, { a: 'Sentinels', b: 'G2', aWon: true, t: Date.parse('2026-10-09T00:00:00Z'), id: '555' }], 'VAL');
  assert.deepEqual([val[0].id, val[0].t, val[0].s1, val[0].s2, val[0].bo], ['vlr:555', '2026-10-09T17:00:00.000Z', 2, 0, 3]);
});

test('venue schedule: Kalshi matches first, Polymarket US adds only matches Kalshi lacks; results found by names and time', () => {
  const now = Date.parse('2026-10-25T06:00:00Z');
  const cs = (start, a, b) => ({ ...boardMatch(start, a, b, { bid: 0.5, ask: 0.52 }, { bid: 0.47, ask: 0.5 }), game: 'CS2', tournament: 'BLAST' });
  const pmGlobalOnly = { ...cs('2026-10-25T10:00:00Z', 'Prestige', 'Revenge'), markets: [{ kind: 'match', outcomes: [{ name: 'Prestige', quotes: { polymarket: { bid: 0.5, ask: 0.52 } } }, { name: 'Revenge', quotes: {} }] }] };
  const board = [cs('2026-10-25T08:00:00Z', 'Team Spirit', 'TYLOO'), cs('2026-10-25T09:00:00Z', 'A', 'B'), { ...cs('2026-10-25T09:00:00Z', 'L1', 'L2'), game: 'LOL' }, cs('2026-11-20T09:00:00Z', 'Far', 'Away'), pmGlobalOnly];
  const pm = D.parsePmusEvents([
    pmEvent('cs2-ts-tyloo-2026-10-25', '2026-10-25T08:00:00Z', ['Spirit', 'TS'], ['TYLOO', 'TYL'], 0.8, 0.82),
    pmEvent('cs2-vit-mglz-2026-10-25', '2026-10-25T11:00:00Z', ['Vitality', 'VIT'], ['TheMongolz', 'MGLZ'], 0.6, 0.62),
  ], D.DEFAULTS, 'cs2');
  assert.equal(pm[0].url, 'https://polymarket.us/sports/cs2/cs2-ts-tyloo-2026-10-25');
  const up = D.venueUpcoming('CS2', board, pm, { now });
  assert.deepEqual(up.map(u => [u.a, u.source]), [['Team Spirit', 'kalshi'], ['A', 'kalshi'], ['Vitality', 'polymarketus']]);
  assert.equal(up[0].lg, 'BLAST');
  const seriesList = [{ id: 'bo3:1', t: '2026-10-25T08:05:00Z', a: 'TYLOO', b: 'Spirit', s1: 0, s2: 2 }];
  assert.deepEqual(D.findResult(seriesList, { start: '2026-10-25T08:00:00Z', teams: ['Team Spirit', 'TYLOO'] }), { s1: 2, s2: 0, id: 'bo3:1' });
  assert.equal(D.findResult(seriesList, { start: '2026-10-27T08:00:00Z', teams: ['Team Spirit', 'TYLOO'] }), null);
});

test('CS2 engine: venues give the schedule, the ratings refresh the results; record freezes, then grades from a later result', async () => {
  const seed = league('CS2 S-tier', ['Spirit', 'Vitality', 'MOUZ', 'FaZe'], 4, Date.parse('2026-09-01T00:00:00Z'));
  let now = Date.parse('2026-10-25T07:30:00Z');
  const board = [{ ...boardMatch('2026-10-25T08:00:00Z', 'Team Spirit', 'Vitality', { bid: 0.6, ask: 0.62 }, { bid: 0.37, ask: 0.4 }), game: 'CS2', bestOf: 3 }];
  let raw = { games: [{ a: 'MOUZ', b: 'FaZe', aWon: true, t: Date.parse('2026-10-24T10:00:00Z'), id: 77, tier: 's', bo: 1 }], at: 1 };
  const http = { async get(url) { assert.ok(url.includes('/v2/leagues/cs2/events')); return { data: { events: [pmEvent('cs2-ts-vit', '2026-10-25T08:00:00Z', ['Spirit', 'TS'], ['Vitality', 'VIT'], 0.58, 0.6)] } }; } };
  const store = memStore();
  const E = D.createMatchupEngine({ game: 'CS2', http, seed, board: () => board, results: () => raw, store, now: () => now, log: {} });
  await E.refresh();
  const st = E.status();
  assert.equal(st.game, 'CS2');
  assert.equal(st.fetched, 1);
  assert.equal(st.upcoming, 1);
  assert.deepEqual(st.providers.map(p => p.id), ['bo3gg', 'kalshi', 'polymarketus']);
  const [mu] = E.list();
  assert.equal(mu.game, 'CS2');
  assert.equal(mu.model.priced, true);
  assert.ok(mu.model.win > 0.5, 'Spirit beat everyone in the seed');
  assert.ok(mu.markets.kalshi && mu.markets.pmus);
  assert.equal(mu.markets.pmus.url, 'https://polymarket.us/sports/cs2/cs2-ts-vit');
  assert.equal(store.rows.size, 1);
  const id = [...store.rows.keys()][0];
  assert.ok(id.startsWith('cs2:'));
  // the same refresh's games again add nothing; a new read with the result grades it
  await E.refresh();
  assert.equal(E.status().fetched, 1);
  now = Date.parse('2026-10-25T12:00:00Z');
  raw = { games: [...raw.games, { a: 'Vitality', b: 'Spirit', aWon: false, t: Date.parse('2026-10-25T08:00:00Z'), id: 78, tier: 's', bo: 3 }, { a: 'Vitality', b: 'Spirit', aWon: false, t: Date.parse('2026-10-25T08:00:00Z'), id: 78, tier: 's', bo: 3 }], at: 2 };
  await E.refresh();
  const g = store.rows.get(id);
  assert.equal(g.status, 'graded');
  assert.equal(g.y, 1);
  assert.equal(g.result, '2-0');
  assert.equal(E.record().summary.graded, 1);
});

test('LoL and CS2 engines share a store without reading each other\'s rows', async () => {
  const store = memStore();
  store.rows.set('lol:1', { id: 'lol:1', status: 'open', start: '2026-10-01T00:00:00Z', matchId: '1' });
  const E = D.createMatchupEngine({ game: 'CS2', http: { async get() { throw new Error('down'); } }, seed: [], board: () => [], results: () => null, store, log: {} });
  await E.refresh();
  assert.equal(E.record().rows.length, 0);
  assert.match(E.status().error, /not read yet/);
});

test('CS2 and VALORANT seeds and backtests ship with the repo, each saying Kalshi is better', () => {
  const { GAMES } = require('../esgames');
  for (const g of ['CS2', 'VAL']) {
    const seed = D.loadSeed(GAMES[g].seed);
    assert.ok(seed.length > (g === 'CS2' ? 40000 : 8000), `${g} seed ${seed.length}`);
    assert.ok(seed.every(s => s.id && s.a && s.b && s.s1 != null && s.s2 != null));
    const bt = D.loadBacktest(GAMES[g].backtest);
    assert.equal(bt.game, g);
    assert.ok(bt.kalshi['T-60'].n > 500);
    assert.ok(bt.kalshi['T-60'].logLoss.kalshi < bt.kalshi['T-60'].logLoss.model);
    assert.match(bt.verdict, /Kalshi's price beats the model/);
  }
});
