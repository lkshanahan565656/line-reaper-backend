'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const K = require('../kalshiws');
const bigMoney = require('../bigmoney');

// a fake `ws` socket: records what we send, lets the test play Kalshi
class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.closed = false; FakeWs.last = this; FakeWs.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  reply(m) { this.emit('message', Buffer.from(JSON.stringify(m))); }
}
FakeWs.all = [];
// a manual clock and timers
function clock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: x => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const x = timers[0]; if (!x || x.at > end) break; timers.shift(); t = x.at; x.fn(); } t = end; },
    pending: () => timers.length,
  };
}
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const make = (c, extra = {}) => K.createKalshiStream({ keyId: 'key-1', pem: PEM, WebSocket: FakeWs, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, rand: () => 1, ...extra });

test('signs the handshake the way Kalshi checks it (RSA-PSS over timestamp + GET + path)', () => {
  const h = K.authHeaders({ keyId: 'key-1', pem: PEM, now: 1700000000000 });
  assert.equal(h['KALSHI-ACCESS-KEY'], 'key-1');
  assert.equal(h['KALSHI-ACCESS-TIMESTAMP'], '1700000000000');
  const ok = crypto.verify('sha256', Buffer.from('1700000000000GET/trade-api/ws/v2'), { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
  assert.ok(ok);
  const ed = crypto.generateKeyPairSync('ed25519');
  const he = K.authHeaders({ keyId: 'k', pem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }), now: 5 });
  assert.ok(crypto.verify(null, Buffer.from('5GET/trade-api/ws/v2'), ed.publicKey, Buffer.from(he['KALSHI-ACCESS-SIGNATURE'], 'base64')));
});

test('reads a PEM pasted on one env line, and refuses junk', () => {
  assert.ok(K.pemFromEnv(PEM.replace(/\n/g, '\\n')));
  const flat = PEM.replace(/\n/g, ' ');
  assert.ok(K.pemFromEnv(flat));
  assert.equal(K.pemFromEnv('not a key'), null);
  assert.equal(K.pemFromEnv(''), null);
});

test('parses a ticker message (dollar strings, cents fallback, empty side)', () => {
  assert.deepEqual(K.parseTicker({ type: 'ticker', msg: { market_ticker: 'KXNFLGAME-X-BUF', yes_bid_dollars: '0.4800', yes_ask_dollars: '0.5100' } }), { ticker: 'KXNFLGAME-X-BUF', yesBid: 0.48, yesAsk: 0.51 });
  assert.deepEqual(K.parseTicker({ type: 'ticker', msg: { market_ticker: 'T', yes_bid: 30, yes_ask: 0 } }), { ticker: 'T', yesBid: 0.3, yesAsk: null });
  assert.equal(K.parseTicker({ type: 'ok', msg: {} }), null);
});

test('backoff doubles to the cap, with jitter between half and all of it', () => {
  assert.equal(K.backoffMs(0, { rand: () => 1 }), 2000);
  assert.equal(K.backoffMs(3, { rand: () => 1 }), 16000);
  assert.equal(K.backoffMs(20, { rand: () => 1 }), 300000);
  assert.equal(K.backoffMs(0, { rand: () => 0 }), 1000);
});

test('subscribes only the tracked tickers, in chunks, never the whole exchange', () => {
  const c = clock();
  const s = make(c, { chunk: 2 });
  s.start();
  const ws = FakeWs.last;
  assert.equal(ws.opts.headers['KALSHI-ACCESS-KEY'], 'key-1');
  ws.emit('open');
  assert.equal(ws.sent.length, 0, 'nothing asked for: no subscribe (an empty list would be every market)');
  s.track(['A', 'B', 'C', 'A']);
  assert.deepEqual(ws.sent[0].params, { channels: ['ticker'], market_tickers: ['A', 'B'], send_initial_snapshot: true });
  assert.equal(ws.sent.length, 1, 'the rest wait for the subscription id');
  ws.reply({ id: ws.sent[0].id, type: 'subscribed', msg: { channel: 'ticker', sid: 7 } });
  assert.deepEqual(ws.sent[1].params, { sids: [7], market_tickers: ['C'], action: 'add_markets' });
  ws.reply({ id: ws.sent[1].id, type: 'ok', msg: { market_tickers: ['C'] } });
  assert.ok(s.covers());
  // a poll drops B and adds D
  s.track(['A', 'C', 'D']);
  c.advance(1000);
  const cmds = ws.sent.slice(2).map(x => [x.params.action, x.params.market_tickers]);
  assert.deepEqual(cmds, [['add_markets', ['D']], ['delete_markets', ['B']]]);
  assert.equal(s.covers(), false, 'D not confirmed yet');
  s.stop();
});

test('keeps quotes only for tracked markets, flags changes, and drops them on a disconnect', () => {
  const c = clock();
  const s = make(c);
  s.start();
  const ws = FakeWs.last;
  ws.emit('open');
  s.track(['A']);
  ws.reply({ id: 1, type: 'subscribed', msg: { channel: 'ticker', sid: 1 } });
  ws.reply({ type: 'ticker', msg: { market_ticker: 'A', yes_bid_dollars: '0.40', yes_ask_dollars: '0.42' } });
  ws.reply({ type: 'ticker', msg: { market_ticker: 'ZZZ', yes_bid_dollars: '0.10', yes_ask_dollars: '0.12' } });
  assert.deepEqual(s.quote('A'), { yesBid: 0.4, yesAsk: 0.42, at: c.now() });
  assert.equal(s.quote('ZZZ'), null);
  assert.deepEqual(s.takeDirty(), ['A']);
  ws.reply({ type: 'ticker', msg: { market_ticker: 'A', yes_bid_dollars: '0.40', yes_ask_dollars: '0.42' } });
  assert.deepEqual(s.takeDirty(), [], 'same price again: nothing to patch');
  ws.emit('close', 1006, '');
  assert.equal(s.quote('A'), null, 'a quote from before a gap never stands');
  assert.equal(s.status().state, 'waiting');
  s.stop();
});

test('reconnects with backoff, resubscribes, and resets the backoff after a stable minute', () => {
  FakeWs.all = [];
  const c = clock();
  const s = make(c);
  s.start();
  s.track(['A']);
  FakeWs.last.emit('close', 1006, '');
  assert.equal(FakeWs.all.length, 1);
  c.advance(1999);
  assert.equal(FakeWs.all.length, 1);
  c.advance(1);
  assert.equal(FakeWs.all.length, 2, 'second try after 2 s');
  FakeWs.last.emit('close', 1006, '');
  c.advance(4000);
  assert.equal(FakeWs.all.length, 3, 'third after 4 s more');
  const ws = FakeWs.last;
  ws.emit('open');
  assert.deepEqual(ws.sent[0].params.market_tickers, ['A'], 'resubscribes what is tracked');
  // live for 70 s with pings, then dropped: the next wait is back to 2 s
  for (let i = 0; i < 7; i++) { c.advance(10e3); ws.emit('ping'); }
  ws.emit('close', 1006, '');
  c.advance(2000);
  assert.equal(FakeWs.all.length, 4);
  s.stop();
});

test('drops a silent socket after 45 s and treats a 401 handshake as refused for 30 min', () => {
  FakeWs.all = [];
  const c = clock();
  const s = make(c);
  s.start();
  const ws = FakeWs.last;
  ws.emit('open');
  c.advance(44e3);
  assert.equal(ws.closed, false);
  c.advance(2e3);
  assert.equal(ws.closed, true, 'no ping for 45 s');
  c.advance(2e3);
  const ws2 = FakeWs.last;
  assert.notEqual(ws2, ws);
  ws2.emit('unexpected-response', {}, { statusCode: 401 });
  assert.equal(s.status().state, 'refused');
  c.advance(29 * 60e3);
  assert.equal(FakeWs.last, ws2, 'waits out the refusal');
  c.advance(60e3 + 1);
  assert.notEqual(FakeWs.last, ws2);
  s.stop();
});

test('a market-limit error halves the cap; a rate error widens the command gap', () => {
  const c = clock();
  const s = make(c, { maxMarkets: 400, chunk: 100 });
  s.start();
  const ws = FakeWs.last;
  ws.emit('open');
  s.track(Array.from({ length: 400 }, (_, i) => `T${i}`));
  ws.reply({ id: ws.sent[0].id, type: 'subscribed', msg: { channel: 'ticker', sid: 3 } });
  ws.reply({ id: ws.sent[1].id, type: 'error', msg: { code: 26, msg: 'Per-subscription market limit exceeded' } });
  assert.equal(s.status().cap, 200);
  assert.equal(s.status().tracked, 200);
  ws.reply({ id: 99, type: 'error', msg: { code: 27, msg: 'rate' } });
  assert.equal(s.status().commandGapMs, 500);
  s.stop();
});

test('streamed prices land on the polled rows and the odds-screen bets', () => {
  const row = { exchange: 'kalshi', id: 'KXNFLGAME-26OCT29BUFMIA-BUF', yesAsk: 0.55, noAsk: 0.47, tradable: true, url: 'u' };
  const other = { exchange: 'kalshi', id: 'KXNFLGAME-26OCT29BUFMIA-MIA', yesAsk: 0.47, noAsk: 0.55, tradable: true, url: 'u' };
  const book = { exchange: 'kalshi', id: row.id, yesAsk: 0.55, noAsk: 0.47, yesBid: 0.53, noBid: 0.45 };
  const games = { rows: new Map([['kalshi:a', { row, yes: 'g|ml|home', no: 'g|ml|away' }], ['kalshi:b', { row: other, yes: 'g|ml|away', no: 'g|ml|home' }]]),
    bets: new Map([['g|ml|home', { venues: [bigMoney.exchangeVenue(row, 'yes')] }], ['g|ml|away', { venues: [bigMoney.exchangeVenue(other, 'yes')] }]]) };
  const quotes = new Map([[row.id, { yesBid: 0.6, yesAsk: 0.62, at: 1700000000000 }]]);
  const stream = { quote: t => quotes.get(t) || null };
  const byT = K.rowsByTicker([row, other], [book]);
  assert.equal(K.patchRows(byT, [row.id], stream), 2);
  assert.equal(row.yesAsk, 0.62);
  assert.equal(row.noAsk, 0.4);
  assert.equal(book.yesBid, 0.6);
  assert.equal(book.noBid, 0.38);
  assert.equal(row.quoteAt, new Date(1700000000000).toISOString());
  K.patchBets(games, [row.id], bigMoney.exchangeVenue);
  const home = games.bets.get('g|ml|home').venues.find(v => v.venue === 'kalshi');
  // BUF YES now 62¢ vs MIA NO 55¢: the cheaper way to back Buffalo is NO on Miami
  assert.equal(home.marketId, other.id);
  assert.equal(home.side, 'no');
  const away = games.bets.get('g|ml|away').venues.find(v => v.venue === 'kalshi');
  assert.equal(away.marketId, row.id, 'NO on Buffalo at 40¢ beats YES on Miami at 47¢');
  assert.equal(away.price, 0.4);
  assert.equal(away.at, row.quoteAt);
  assert.equal(games.bets.get('g|ml|home').venues.length, 1);
});
