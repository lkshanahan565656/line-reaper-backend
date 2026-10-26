const test = require('node:test');
const assert = require('node:assert/strict');
const ref = require('../offshoreref');
const { createMemoryStore } = require('../tracker');

const T0 = Date.parse('2026-10-27T12:00:00Z');
const PAIR = { id: 'fed|26OCT|hold', fam: 'fed', cat: 'Economics', p: { tok: 'TOK', q: 'No change?', outcome: 'No change' }, k: { t: 'KXFEDDECISION-26OCT-H0', fm: 1 }, u: { slug: 'rdc-usfed-fomc-2026-10-28-nochng', fee: 0.0695 } };
const pt = (min, m, ask, bid) => ({ t: T0 + min * 60e3, m, ask, bid });

test('fees: Kalshi rounds up per order, Polymarket US uses the market coefficient', () => {
  assert.equal(ref.feeOf('kalshi', 0.5, PAIR), 0.0175);
  assert.ok(Math.abs(ref.feeOf('pmus', 0.5, PAIR) - 0.017375) < 1e-9);
  assert.equal(ref.feeOf('kalshi', 1.2, PAIR), null);
});

test('event clusters: one Fed meeting, one race', () => {
  assert.equal(ref.eventOf('fed|26OCT|hold'), 'fed|26OCT');
  assert.equal(ref.eventOf('race|senate|tx|D|'), 'race|senate|tx');
  assert.equal(ref.eventOf('control|house|D'), 'control|house|D');
});

test('detect: an offshore move the US venue has not followed flags the side it moved to', () => {
  const hist = [pt(0, 0.50, 0.50, 0.49), pt(15, 0.55, 0.51, 0.50)];
  const flags = ref.detect(hist, PAIR, 'kalshi', new Map());
  const move = flags.find(f => f.sig === 'move');
  assert.ok(move, 'a move flag');
  assert.equal(move.side, 'yes');
  assert.equal(move.price, 0.51);
  assert.ok(move.edge >= 0.01 && move.edge < 0.04);
  assert.equal(move.event, 'fed|26OCT');
  // no flag when the US venue already moved half or more
  assert.equal(ref.detect([pt(0, 0.50, 0.50, 0.49), pt(15, 0.55, 0.53, 0.52)], PAIR, 'kalshi', new Map()).filter(f => f.sig === 'move').length, 0);
  // no flag when the offshore point 15 minutes back is missing
  assert.equal(ref.detect([pt(5, 0.50, 0.50, 0.49), pt(15, 0.55, 0.51, 0.50)], PAIR, 'kalshi', new Map()).filter(f => f.sig === 'move').length, 0);
});

test('detect: a standing gap of 3c fee in flags once an hour, the NO side too', () => {
  const last = new Map();
  const h = [pt(0, 0.40, 0.47, 0.46)];   // NO costs 0.56 + fee against an offshore NO of 0.60
  const a = ref.detect(h, PAIR, 'kalshi', last);
  assert.deepEqual(a.map(f => `${f.sig}:${f.side}`), ['gap:no']);
  assert.equal(ref.detect([...h, pt(30, 0.40, 0.47, 0.46)], PAIR, 'kalshi', last).length, 0, 'cooldown');
  assert.equal(ref.detect([...h, pt(61, 0.40, 0.47, 0.46)], PAIR, 'kalshi', last).length, 1, 'after an hour');
  // prices outside 5-95c never flag
  assert.equal(ref.detect([pt(0, 0.99, 0.97, 0.96)], PAIR, 'kalshi', new Map()).length, 0);
});

test('mark: 30 and 60 minute marks from the side, a missed mark is null, the exit is the bid', () => {
  const bet = { flaggedAt: new Date(T0).toISOString(), side: 'no', cost: 0.57 };
  assert.equal(ref.mark(bet, pt(10, 0.4, 0.45, 0.44)), false);
  assert.equal(ref.mark(bet, pt(31, 0.38, 0.43, 0.41)), true);
  assert.equal(bet.u30, 0.58); assert.equal(bet.x30, 0.62);
  assert.equal(bet.u60, undefined);
  ref.mark(bet, pt(70, 0.4, 0.45, 0.44));   // more than 5 minutes late
  assert.equal(bet.u60, null);
  const b2 = { flaggedAt: new Date(T0).toISOString(), side: 'yes', cost: 0.5 };
  ref.mark(b2, pt(61, 0.55, 0.54, 0.52));
  assert.equal(b2.exit60, 0.52); assert.equal(b2.u60, 0.53);
});

test('summarize: clustered t, graded toward 50, never a profit', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ sig: 'gap', venue: 'kalshi', fam: i < 5 ? 'fed' : 'race', event: `e${i % 4}`, cost: 0.5, fee: 0.0175, u30: 0.49, u60: 0.48 + (i % 3) * 0.001, x60: 0.53, exit60: 0.47, result: i < 4 ? 1 : null, depth: { contracts: 100 + i } });
  const out = ref.summarize(rows);
  const all = out.find(r => r.sig === 'gap' && r.fam === 'all');
  assert.equal(all.flagged, 10); assert.equal(all.graded, 10); assert.equal(all.events, undefined);
  assert.equal(all.own60.events, 4);
  assert.ok(all.own60.mean < 0 && all.own60.t < 0);
  assert.equal(all.settled, 4); assert.equal(all.won, 4);
  assert.equal(all.profitShown, false);
  assert.equal(all.label, 'research, not an edge, 10 of 50');
  assert.equal(all.medianDepth, 105);
  assert.ok(out.some(r => r.fam === 'fed') && out.some(r => r.fam === 'race'));
});

test('parsers: Kalshi quotes and results, offshore mids from POST /books', () => {
  const k = ref.parseKalshiQuotes({ markets: [{ ticker: 'A', yes_ask_dollars: '0.9200', yes_bid_dollars: '0.9100', status: 'active', result: '' }, { ticker: 'B', yes_ask_dollars: '0.0000', yes_bid_dollars: '0.0000', status: 'finalized', result: 'no' }] });
  assert.deepEqual(k.get('A'), { ask: 0.92, bid: 0.91, status: 'active', result: null });
  assert.equal(k.get('B').result, 0); assert.equal(k.get('B').ask, null);
  const o = ref.parseOffshoreMids([{ asset_id: 'T1', bids: [{ price: '0.84', size: '10' }, { price: '0.86', size: '5' }], asks: [{ price: '0.89', size: '1' }, { price: '0.87', size: '2' }] },
    { asset_id: 'T2', bids: [{ price: '0.10', size: '1' }], asks: [{ price: '0.60', size: '1' }] }]);
  assert.equal(o.get('T1').mid, 0.865);
  assert.equal(o.has('T2'), false, 'a book wider than 10c is no reference');
});

test('createOffshoreRef: reads all three venues, flags with depth, marks and settles from Kalshi', async () => {
  let t = T0;
  let off = 0.50, kAsk = 0.50, kBid = 0.49, result = '';
  const calls = [];
  const http = { get: async (url, cfg) => {
    calls.push(url);
    if (url.endsWith('/markets')) return { data: { markets: [{ ticker: PAIR.k.t, yes_ask_dollars: String(kAsk), yes_bid_dollars: String(kBid), status: result ? 'finalized' : 'active', result }] } };
    if (url.endsWith('/orderbook')) return { data: { orderbook_fp: { no_dollars: [['0.5000', '300'], ['0.4000', '50']], yes_dollars: [] } } };
    if (url.includes('gateway.polymarket.us')) return { data: { marketData: { bids: [{ px: { value: String(kBid) }, qty: '20' }], offers: [{ px: { value: String(kAsk) }, qty: '40' }], state: 'MARKET_STATE_OPEN' } } };
    throw new Error('unexpected ' + url + JSON.stringify(cfg));
  } };
  const post = async (url, body) => { assert.equal(url, 'https://clob.polymarket.com/books'); assert.deepEqual(body, [{ token_id: 'TOK' }]); return { data: [{ asset_id: 'TOK', bids: [{ price: String(off - 0.005), size: '1000' }], asks: [{ price: String(off + 0.005), size: '1000' }] }] }; };
  const store = createMemoryStore();
  const r = ref.createOffshoreRef({ http, post, pairs: [PAIR], store, now: () => t, log: { warn() {} } });
  for (let m = 0; m <= 14; m++) { t = T0 + m * 60e3; await r.tick(); }
  off = 0.56;   // offshore jumps, Kalshi and PM US stay
  t = T0 + 15 * 60e3;
  const fresh = await r.tick();
  assert.ok(fresh.some(f => f.sig === 'move' && f.venue === 'kalshi' && f.side === 'yes'));
  assert.ok(fresh.some(f => f.venue === 'pmus'));
  let rows = await store.all();
  const kMove = rows.find(x => x.sig === 'move' && x.venue === 'kalshi');
  assert.deepEqual(kMove.depth, { contracts: 300, usd: 150 });
  const pMove = rows.find(x => x.venue === 'pmus' && x.side === 'yes');
  assert.equal(pMove.depth.contracts, 40);
  assert.ok(calls.some(u => u.endsWith('/orderbook')));
  kAsk = 0.56; kBid = 0.55;
  t = T0 + 46 * 60e3; await r.tick();
  t = T0 + 76 * 60e3; await r.tick();
  rows = await store.all();
  const k2 = rows.find(x => x.id === kMove.id);
  assert.equal(k2.u30, 0.555); assert.equal(k2.u60, 0.555); assert.equal(k2.exit60, 0.55);
  assert.equal(k2.status, 'open');
  result = 'yes'; kAsk = 0.99; kBid = 0.98;
  t = T0 + 100 * 60e3; await r.tick();
  rows = await store.all();
  assert.equal(rows.find(x => x.id === kMove.id).result, 1);
  assert.equal(rows.find(x => x.id === kMove.id).status, 'graded');
  assert.equal(rows.find(x => x.id === pMove.id).result, 1, 'Polymarket US settles from the identical Kalshi contract');
  const st = r.state();
  assert.equal(st.quotes.offshore, 1); assert.equal(st.errors.length, 0);
  const gaps = r.gaps();
  assert.ok(Array.isArray(gaps));
});

test('seeds: every pair has an offshore token and at least one US contract, ids unique', () => {
  const { pairs } = require('../seeds/offshore-pairs.json');
  assert.ok(pairs.length >= 50);
  assert.equal(new Set(pairs.map(p => p.id)).size, pairs.length);
  for (const p of pairs) {
    assert.ok(p.p.tok && p.p.q, p.id);
    assert.ok(p.k || p.u, p.id);
    if (p.u) assert.ok(p.k, `${p.id}: a Polymarket US pair settles from Kalshi's identical contract`);
    assert.ok(['race', 'control', 'fed'].includes(p.fam));
  }
  const bt = require('../seeds/offshore-backtest.json');
  assert.equal(bt.verdict, 'FAIL');
  assert.ok(bt.rows.every(r => r.profitShown === false));
});
