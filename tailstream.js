'use strict';
// Polymarket's live activity feed: every trade on the exchange, wallet
// included, pushed a second or two after it fills. Sharp Tail reads it so an
// alert goes out seconds after a graded wallet buys, instead of on the next
// 30-second poll (the poll keeps running as the fallback and catches anything
// the socket missed; trades are deduped by transaction).
//
//   wss://ws-live-data.polymarket.com
//   → {"action":"subscribe","subscriptions":[{"topic":"activity","type":"trades"}]}
//   ← {"topic":"activity","type":"trades","timestamp":…,"payload":{proxyWallet, asset,
//      conditionId, side, size, price, timestamp, transactionHash, outcome, outcomeIndex,
//      title, slug, eventSlug, name, pseudonym, …}}
//
// The client pings with the text "ping" every 5 seconds. One order can fill
// against several makers in one transaction, so trades are held for flushMs
// and handed over together; parseTrades sums the fills of one transaction.

const { parseTrades } = require('./tail');

const LIVE_DATA_WS = 'wss://ws-live-data.polymarket.com';
const SUBSCRIBE = JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] });

function defaultWebSocket() {
  try { return require('ws'); } catch { return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null; }
}

// onTrades(parsedTrades) is called with each flushed batch (it may be async;
// errors are logged). Timers and the socket class are injectable for tests.
function createTradeStream({
  onTrades, url = LIVE_DATA_WS, WebSocketImpl = defaultWebSocket(), now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, log = console,
  flushMs = 1500, pingMs = 5000, silentMs = 15e3, minBackoffMs = 1000, maxBackoffMs = 60e3,
} = {}) {
  let ws = null, running = false, backoff = minBackoffMs;
  let pingTimer = null, flushTimer = null, retryTimer = null, watchTimer = null;
  let buffer = [];
  const stats = { connected: false, connects: 0, drops: 0, messages: 0, trades: 0, batches: 0, connectedAt: null, lastMessageAt: null, lastTradeAt: null, lastError: null };
  const iso = t => (t == null ? null : new Date(t).toISOString());
  const warn = m => { stats.lastError = m; log.warn?.(`Tail stream: ${m}`); };

  function clearTimers() {
    for (const t of [pingTimer, watchTimer]) if (t) clearTimer(t);
    pingTimer = watchTimer = null;
  }

  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    const trades = parseTrades(rows);
    if (!trades.length) return;
    stats.batches++;
    stats.trades += trades.length;
    stats.lastTradeAt = now();
    Promise.resolve().then(() => onTrades(trades)).catch(e => warn(`handler: ${e?.message || e}`));
  }

  function onMessage(ev) {
    const text = typeof ev?.data === 'string' ? ev.data : ev?.data == null ? '' : String(ev.data);
    if (!text || !text.includes('payload')) return;   // pongs and acks
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    stats.messages++;
    stats.lastMessageAt = now();
    backoff = minBackoffMs;   // a working feed resets the retry delay
    if (msg?.topic !== 'activity' || msg?.type !== 'trades') return;
    const rows = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
    for (const r of rows) if (r && typeof r === 'object') buffer.push(r);
    if (buffer.length && !flushTimer) flushTimer = setTimer(flush, flushMs);
  }

  // no message for silentMs on a feed that carries every trade on the
  // exchange (about 40 a second live) means the socket is dead even if it
  // never said so; the live socket went quiet like that 7 times in 70 minutes
  function watch() {
    watchTimer = setTimer(() => {
      watchTimer = null;
      const last = stats.lastMessageAt ?? stats.connectedAt ?? 0;
      if (now() - last >= silentMs) { warn(`no messages for ${Math.round(silentMs / 1000)}s, reconnecting`); drop(); }
      else watch();
    }, Math.max(1000, Math.round(silentMs / 4)));
  }

  function ping() {
    pingTimer = setTimer(() => {
      pingTimer = null;
      try { ws?.send('ping'); } catch { /* the close handler reconnects */ }
      if (ws) ping();
    }, pingMs);
  }

  function drop() {
    const old = ws;
    ws = null;
    clearTimers();
    if (stats.connected) stats.drops++;
    stats.connected = false;
    if (old) { try { old.onopen = old.onmessage = old.onclose = old.onerror = null; old.close(); } catch { /* already gone */ } }
    if (running) retry();
  }

  function retry() {
    if (retryTimer) return;
    const wait = backoff;
    backoff = Math.min(maxBackoffMs, backoff * 2);
    retryTimer = setTimer(() => { retryTimer = null; connect(); }, wait);
  }

  function connect() {
    if (!running || ws) return;
    let sock;
    try { sock = new WebSocketImpl(url); }
    catch (e) { warn(`connect: ${e?.message || e}`); retry(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      try { sock.send(SUBSCRIBE); } catch (e) { warn(`subscribe: ${e?.message || e}`); drop(); return; }
      stats.connected = true;
      stats.connects++;
      stats.connectedAt = now();
      ping();
      watch();
    };
    sock.onmessage = ev => { if (ws === sock) onMessage(ev); };
    sock.onerror = ev => { if (ws === sock) stats.lastError = ev?.message || ev?.error?.message || 'socket error'; };
    sock.onclose = ev => { if (ws !== sock) return; if (ev?.code && ev.code !== 1000) stats.lastError = `closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`; drop(); };
  }

  return {
    // → false when there's no WebSocket class to use (the poll still runs)
    start() {
      if (running) return true;
      if (typeof WebSocketImpl !== 'function') { warn('no WebSocket available: polling only'); return false; }
      running = true;
      connect();
      return true;
    },
    stop() {
      running = false;
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
      buffer = [];
      drop();
    },
    flush,
    stats: () => ({
      running, ...stats, connectedAt: iso(stats.connectedAt), lastMessageAt: iso(stats.lastMessageAt), lastTradeAt: iso(stats.lastTradeAt),
    }),
  };
}

module.exports = { createTradeStream, LIVE_DATA_WS, SUBSCRIBE };
