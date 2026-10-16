'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradeStream, SUBSCRIBE } = require('../tailstream');

// a socket the test drives by hand, and timers that only fire when told
function harness(opts = {}) {
  let t = 1_790_000_000_000;
  const timers = new Map();
  let nextId = 1;
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(m) { if (this.closed) throw new Error('closed'); this.sent.push(m); }
    close() { this.closed = true; }
  }
  const batches = [];
  const h = {
    sockets, batches, timers,
    get now() { return t; },
    stream: createTradeStream({
      onTrades: trades => { batches.push(trades); }, WebSocketImpl: FakeSocket, now: () => t,
      setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
      clearTimer: id => timers.delete(id), log: {}, ...opts,
    }),
    // move the clock, firing timers in order as they come due
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
      await new Promise(r => setImmediate(r));
    },
    msg(sock, payload, o = {}) { sock.onmessage?.({ data: JSON.stringify({ topic: 'activity', type: 'trades', timestamp: t, payload, ...o }) }); },
  };
  return h;
}
const trade = (o = {}) => ({
  proxyWallet: '0xAbC', side: 'BUY', asset: 'tok-yes', conditionId: '0xm1', size: 1000, price: 0.4, timestamp: 1_789_999_999,
  transactionHash: '0xt1', title: 'Will X win?', slug: 'x', eventSlug: 'x', outcome: 'Yes', outcomeIndex: 0, ...o,
});

test('stream: subscribes on open, batches the fills of one order, pings, and reports what it saw', async () => {
  const h = harness();
  assert.equal(h.stream.start(), true);
  const [s] = h.sockets;
  assert.equal(s.url, 'wss://ws-live-data.polymarket.com');
  s.onopen();
  assert.deepEqual(s.sent, [SUBSCRIBE]);
  assert.deepEqual(JSON.parse(SUBSCRIBE), { action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] });

  h.msg(s, trade({ size: 600 }));
  h.msg(s, trade({ size: 400 }));                                  // same transaction: one trade
  h.msg(s, [trade({ transactionHash: '0xt2', proxyWallet: '0xdef' })]);   // arrays are fine too
  h.msg(s, { proxyWallet: '0x1' }, { topic: 'comments', type: 'comment_created' });
  s.onmessage({ data: 'pong' });
  s.onmessage({ data: '{"payload": not json' });
  assert.equal(h.batches.length, 0, 'held for the flush window');
  await h.advance(1500);
  assert.equal(h.batches.length, 1);
  const [batch] = h.batches;
  assert.deepEqual(batch.map(tr => [tr.wallet, tr.size, tr.at]), [['0xabc', 1000, 1_789_999_999_000], ['0xdef', 1000, 1_789_999_999_000]]);

  await h.advance(5000);
  assert.ok(s.sent.includes('ping'), 'text ping every 5 s');
  const st = h.stream.stats();
  assert.deepEqual([st.running, st.connected, st.connects, st.messages, st.trades, st.batches], [true, true, 1, 4, 2, 1]);
  assert.equal(st.lastTradeAt, new Date(h.now - 5000).toISOString());
  h.stream.stop();
  assert.equal(s.closed, true);
  assert.equal(h.stream.stats().running, false);
  assert.equal(h.timers.size, 0, 'nothing left scheduled');
});

test('stream: reconnects with backoff after a close, and after a silent minute', async () => {
  const h = harness();
  h.stream.start();
  h.sockets[0].onopen();
  h.sockets[0].onclose({ code: 1006 });
  assert.equal(h.stream.stats().lastError, 'closed 1006');
  assert.equal(h.stream.stats().drops, 1);
  await h.advance(999);
  assert.equal(h.sockets.length, 1, 'waits 1 s');
  await h.advance(1);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onclose({ code: 1006 });   // failed before it opened: backoff doubles
  await h.advance(1999);
  assert.equal(h.sockets.length, 2);
  await h.advance(1);
  assert.equal(h.sockets.length, 3);

  // open, a message resets the backoff, then silence
  const s = h.sockets[2];
  s.onopen();
  h.msg(s, trade());
  await h.advance(14e3);
  assert.equal(s.closed, false, 'quiet for 14 s: still up');
  await h.advance(4e3);
  assert.equal(s.closed, true, 'no messages for 15 s: dropped');
  assert.match(h.stream.stats().lastError, /no messages/);
  await h.advance(1000);
  assert.equal(h.sockets.length, 4, 'and back after 1 s: the working feed reset the backoff');
  // events from a replaced socket are ignored
  s.onmessage?.({ data: JSON.stringify({ topic: 'activity', type: 'trades', payload: trade({ transactionHash: '0xold' }) }) });
  await h.advance(2000);
  assert.equal(h.batches.flat().some(tr => tr.txHash === '0xold'), false);
  h.stream.stop();
});

test('stream: no WebSocket class means polling only; a throwing handler is logged, not fatal', async () => {
  const warned = [];
  const none = createTradeStream({ onTrades: () => {}, WebSocketImpl: null, log: { warn: m => warned.push(m) } });
  assert.equal(none.start(), false);
  assert.match(warned[0], /polling only/);

  const h = harness();
  const errs = [];
  const s2 = createTradeStream({
    onTrades: () => { throw new Error('boom'); }, WebSocketImpl: class { constructor() { h.sockets.push(this); } send() {} close() {} },
    setTimer: (fn, ms) => (ms === 1500 ? (fn(), 0) : 0), clearTimer: () => {}, log: { warn: m => errs.push(m) },
  });
  s2.start();
  h.sockets[0].onopen();
  h.sockets[0].onmessage({ data: JSON.stringify({ topic: 'activity', type: 'trades', payload: trade() }) });
  await new Promise(r => setImmediate(r));
  assert.match(errs.join(), /handler: boom/);
});
