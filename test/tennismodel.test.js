// Tennis match-winner model: surface rule, Elo math, names, ESPN parsing,
// venue parsing, and the engine's list, record and grading.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tennismodel');
const D = require('../tennisdata');

const DAY = 86400e3;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('surface rule: names first, then the calendar', () => {
  assert.equal(T.surfaceOf('Wimbledon', Date.parse('2026-07-01')), 'grass');
  assert.equal(T.surfaceOf('Terra Wortmann Open', Date.parse('2026-06-20')), 'grass');
  assert.equal(T.surfaceOf('Rio Open presented by Claro', Date.parse('2026-02-20')), 'clay');
  assert.equal(T.surfaceOf('Nordea Open', Date.parse('2026-07-15')), 'clay');
  assert.equal(T.surfaceOf('Some 250', Date.parse('2026-04-20')), 'clay');
  assert.equal(T.surfaceOf('Some 250', Date.parse('2026-06-25')), 'grass');
  assert.equal(T.surfaceOf('Rolex Paris Masters', Date.parse('2026-10-28')), 'hard');
  assert.equal(T.surfaceOf('Livesport Prague Open', Date.parse('2026-07-25')), 'hard');
});

test('Elo: equal players are 50%, a win moves both by the same K, ratings are symmetric', () => {
  const R = T.createRatings({ minMatches: 0, formW: 0 });
  R.add({ t: 0, a: 'x', b: 'y', w: 1, surf: 'hard', bo: 3 });
  R.add({ t: 0, a: 'u', b: 'v', w: 1, surf: 'hard', bo: 3 });
  close(R.predict('x', 'u', { t: DAY }).p, 0.5, 1e-9);
  const fresh = T.createRatings({ minMatches: 0, formW: 0, kc: 100, off: 0, shape: 0 });
  fresh.add({ t: 0, a: 'a', b: 'b', w: 1, surf: 'clay', bo: 3 });
  close(fresh.player('a').r, 1550); close(fresh.player('b').r, 1450);
  close(fresh.player('a').s.clay[0], 1550);
  const pa = fresh.predict('a', 'b', { surf: 'clay', t: DAY }).p, pb = fresh.predict('b', 'a', { surf: 'clay', t: DAY }).p;
  close(pa + pb, 1, 1e-4);
  // best of five stretches the favourite
  assert.ok(fresh.predict('a', 'b', { surf: 'clay', t: DAY, bestOf: 5 }).p >= pa);
});

test('no price under minMatches; explain names the gap', () => {
  const R = T.createRatings();
  R.add({ t: 0, a: 'a', b: 'b', w: 1, surf: 'hard', bo: 3, an: 'Ann A', bn: 'Bea B' });
  const pr = R.predict('a', 'b');
  assert.equal(pr.priced, false);
  assert.match(T.explain(pr, ['Ann', 'Bea'])[0], /No model price/);
});

test('names: accents, initials and order', () => {
  assert.equal(T.nameScore('Carlos Alcaraz', 'Carlos Alcaraz'), 1);
  assert.ok(T.nameScore('C. Alcaraz', 'Carlos Alcaraz') >= 0.8);
  assert.ok(T.nameScore('Iga Świątek', 'Iga Swiatek') >= 0.9);
  assert.equal(T.nameScore('Alexander Zverev', 'Mischa Zverev') < 0.8, true);
  assert.equal(T.nameScore('Jannik Sinner', 'Carlos Alcaraz'), 0);
  assert.deepEqual(D.samePair(['Sinner', 'Alcaraz'], ['Carlos Alcaraz', 'Jannik Sinner']), { flip: true });
});

test('ESPN rows: finished singles only, best of five from the sets, walkovers dropped', () => {
  const row = (st, ps, ev = 'Australian Open', tour = 'atp') => ({ tour, cid: '9', ev, round: 'Round 1', date: '2026-01-20T01:00Z', st, ps });
  const ps = [{ n: 'A One', id: '1', w: 1, s: [6, 6, 6] }, { n: 'B Two', id: '2', w: 0, s: [4, 4, 4] }];
  const m = D.matchFromEspn(row('STATUS_FINAL', ps));
  assert.equal(m.bo, 5); assert.equal(m.w, 1); assert.equal(m.surf, 'hard'); assert.equal(m.id, '9');
  assert.equal(D.matchFromEspn(row('STATUS_WALKOVER', ps)), null);
  assert.equal(D.matchFromEspn(row('STATUS_FINAL', [ps[0], { ...ps[1], n: 'TBD' }])), null);
  const bo3 = D.matchFromEspn(row('STATUS_RETIRED', [{ n: 'A', id: '1', w: 0, s: [3, 2] }, { n: 'B', id: '2', w: 1, s: [6, 1] }], 'Erste Bank Open'));
  assert.equal(bo3.bo, 3); assert.equal(bo3.ret, 1); assert.equal(bo3.w, 0);
  const seed = D.compactMatches([m, bo3]);
  assert.deepEqual(D.expandMatches(seed).map(x => [x.id, x.a, x.w, x.surf, x.bo]), [['9', '1', 1, 'hard', 5], ['9', '1', 0, 'hard', 3]]);
});

test('Kalshi events → pairs, no-vig mid and cost with the fee', () => {
  const ev = { event_ticker: 'KXATPMATCH-26OCT27SINALC', series_ticker: 'KXATPMATCH', title: 'Sinner vs Alcaraz', markets: [
    { ticker: 'KXATPMATCH-26OCT27SINALC-SIN', yes_sub_title: 'Jannik Sinner', yes_bid_dollars: '0.55', yes_ask_dollars: '0.57', status: 'active' },
    { ticker: 'KXATPMATCH-26OCT27SINALC-ALC', yes_sub_title: 'Carlos Alcaraz', yes_bid_dollars: '0.43', yes_ask_dollars: '0.45', status: 'active' }] };
  const [k] = D.parseKalshiEvents([ev]);
  assert.equal(k.players[0].name, 'Jannik Sinner');
  assert.equal(new Date(k.day).toISOString(), '2026-10-27T04:00:00.000Z');
  const q = D.kalshiQuote(k, false);
  close(q.prob, 0.56 / (0.56 + 0.44), 1e-4);
  close(q.sides[0].cost, 0.57 + 0.07 * 0.57 * 0.43, 1e-4);
  const f = D.kalshiQuote(k, true);
  close(f.prob, 1 - q.prob, 1e-4);
  assert.equal(f.sides[0].ask, 0.45);
});

// an engine with two rated players, a Kalshi and a Polymarket US book, and Pinnacle
function engine({ now, kalshiAsk = 0.4, store = null, espnFinal = false } = {}) {
  const seed = [];
  for (let i = 0; i < 30; i++) {
    seed.push({ id: `s${i}`, t: Date.parse('2026-06-01') + i * DAY, a: 'p1', an: 'Jannik Sinner', b: `o${i}`, bn: `Opp${i} Somebody`, w: 1, surf: 'hard', bo: 3, ev: 'Some Open', tour: 'atp' });
    seed.push({ id: `t${i}`, t: Date.parse('2026-06-01') + i * DAY + 3600e3, a: 'p2', an: 'Carlos Alcaraz', b: `q${i}`, bn: `Opq${i} Else`, w: i % 3 ? 1 : 0, surf: 'hard', bo: 3, ev: 'Some Open', tour: 'atp' });
  }
  const start = '2026-10-27T15:00:00Z';
  const http = { get: async (url, { params } = {}) => {
    if (/espn/.test(url)) {
      if (!espnFinal || !/atp/.test(url) || params.dates !== '20261027') return { data: { events: [] } };
      return { data: { events: [{ name: 'Rolex Paris Masters', groupings: [{ grouping: { slug: 'mens-singles' }, competitions: [{ id: 'live1', date: start, status: { type: { name: 'STATUS_FINAL', completed: true } }, round: { displayName: 'Round 2' },
        competitors: [{ id: 'p1', winner: true, athlete: { displayName: 'Jannik Sinner' }, linescores: [{ value: 6 }, { value: 6 }] }, { id: 'p2', winner: false, athlete: { displayName: 'Carlos Alcaraz' }, linescores: [{ value: 3 }, { value: 4 }] }] }] }] }] } };
    }
    if (/kalshi/.test(url)) return { data: { events: [{ event_ticker: 'KXATPMATCH-26OCT27SINALC', series_ticker: 'KXATPMATCH', title: 'Sinner vs Alcaraz', markets: [
      { ticker: 'A', yes_sub_title: 'Jannik Sinner', yes_bid_dollars: String(kalshiAsk - 0.02), yes_ask_dollars: String(kalshiAsk) },
      { ticker: 'B', yes_sub_title: 'Carlos Alcaraz', yes_bid_dollars: String(1 - kalshiAsk - 0.01), yes_ask_dollars: String(1 - kalshiAsk + 0.03) }] }] } };
    if (/polymarket/.test(url)) return { data: { events: /atp/.test(url) ? [{ slug: 'atp-alcara-sinner-2026-10-27', startTime: start, markets: [{ slug: 'm1', sportsMarketType: 'tennis_match_winner', bestBidQuote: { value: '0.46' }, bestAskQuote: { value: '0.48' },
      marketSides: [{ long: true, description: 'Carlos Alcaraz' }, { long: false, description: 'Jannik Sinner' }] }] }] : [] } };
    throw new Error(`unexpected ${url}`);
  } };
  const pinnacle = () => [{ sport: 'tennis', home: 'Alcaraz, Carlos'.split(', ').reverse().join(' '), away: 'Jannik Sinner', start, league: 'ATP Paris - R2', ml: { home: 0.45, away: 0.55 } }];
  return D.createTennisEngine({ http, store, pinnacle, seed, now: () => now, log: { warn() {}, log() {} } });
}
const memStore = () => { const m = new Map(); return { all: async () => [...m.values()], putMany: async rows => { for (const r of rows) m.set(r.id, { ...r }); }, m }; };

test('engine: one match from three sources, model priced, Pinnacle attached, flipped books lined up', async () => {
  const E = engine({ now: Date.parse('2026-10-27T10:00:00Z') });
  await E.refresh();
  const [mu, ...rest] = E.list();
  assert.equal(rest.length, 0);
  assert.equal(mu.tour, 'atp'); assert.equal(mu.surface, 'hard'); assert.equal(mu.startFrom, 'Pinnacle');
  assert.ok(mu.model.priced);
  const sinner = mu.players.findIndex(p => p.name === 'Jannik Sinner');
  const pinS = sinner === 0 ? mu.markets.pinnacle.prob : 1 - mu.markets.pinnacle.prob;
  close(pinS, 0.55, 1e-4);
  const kS = sinner === 0 ? mu.markets.kalshi.prob : 1 - mu.markets.kalshi.prob;
  assert.ok(kS < 0.45);
  const uS = sinner === 0 ? mu.markets.pmus.prob : 1 - mu.markets.pmus.prob;
  close(uS, 0.53, 1e-4);
  assert.ok(mu.players[sinner].model > 0.5, 'the 30-0 player is the favourite');
});

test('record: a flag 60+ minutes out at 3+ points, Pinnacle close followed, graded from ESPN', async () => {
  const store = memStore();
  const E = engine({ now: Date.parse('2026-10-27T10:00:00Z'), store, kalshiAsk: 0.4 });
  await E.refresh();
  const flags = [...store.m.values()];
  assert.ok(flags.length >= 1);
  const k = flags.find(r => r.venue === 'Kalshi' && r.pick === 'Jannik Sinner');
  assert.ok(k && k.edge >= 0.03 && k.kind === 'tennis-matchups');
  // a read 30 minutes out: no new flags, the close moves
  const E2 = engine({ now: Date.parse('2026-10-27T14:30:00Z'), store, kalshiAsk: 0.4 });
  await E2.refresh();
  assert.equal(store.m.get(k.id).pinClose, 0.55);
  // after the match ESPN has it final
  const E3 = engine({ now: Date.parse('2026-10-27T20:00:00Z'), store, espnFinal: true });
  await E3.refresh();
  const g = store.m.get(k.id);
  assert.equal(g.status, 'graded'); assert.equal(g.won, true);
  close(g.profit, 1 / g.cost - 1, 1e-3);
  close(g.clv, 0.55 / g.cost - 1, 1e-3);
  const rec = E3.record();
  assert.equal(rec.kind, 'tennis-matchups'); assert.equal(rec.alerts, false); assert.equal(rec.summary.proven, false);
  assert.ok(rec.summary.graded >= 1);
});

test('record: nothing flagged inside the hour', async () => {
  const store = memStore();
  const E = engine({ now: Date.parse('2026-10-27T14:30:00Z'), store });
  await E.refresh();
  assert.equal(store.m.size, 0);
});

test('a failed venue read is shown, not hidden, and keeps no stale book past 10 minutes', async () => {
  const E = engine({ now: Date.parse('2026-10-27T10:00:00Z') });
  await E.refresh();
  const bad = D.createTennisEngine({ http: { get: async () => { throw Object.assign(new Error('boom'), { response: { status: 503 } }); } }, seed: [], now: () => Date.now(), log: { warn() {}, log() {} } });
  await bad.refresh();
  const st = bad.status();
  assert.match(st.kalshi.error, /503/); assert.match(st.pmus.error, /503/); assert.match(st.error, /503/);
  assert.equal(bad.list().length, 0);
});
