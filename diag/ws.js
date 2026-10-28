// Kalshi WebSocket probe (short, one run): what the socket says with no key and
// with a key Kalshi has never seen, and what kalshiws.js does with that answer.
// No real key exists yet, so a live price stream can't be checked here.
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const [app, out] = process.argv.slice(2).map(p => path.resolve(p));
const WS = require(path.join(app, 'node_modules/ws'));
const K = require(path.join(app, 'kalshiws.js'));
const axios = require(path.join(app, 'node_modules/axios'));
const res = { at: new Date().toISOString(), probes: [] };
const URLS = ['wss://external-api-ws.kalshi.com/trade-api/ws/v2', 'wss://api.elections.kalshi.com/trade-api/ws/v2'];
const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
function probe(url, headers, label) {
  return new Promise(resolve => {
    const t0 = Date.now(), r = { label, url };
    const w = new WS(url, { headers, handshakeTimeout: 15000 });
    const done = x => { Object.assign(r, x, { ms: Date.now() - t0 }); try { w.terminate(); } catch {} resolve(r); };
    w.on('unexpected-response', (req, resp) => { let b = ''; resp.on('data', d => { b += d; }); resp.on('end', () => done({ result: 'refused', status: resp.statusCode, body: b.slice(0, 300) })); });
    w.on('open', () => { r.opened = true; w.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['ticker'], market_tickers: ['KXNFLGAME-X'] } })); setTimeout(() => done({ result: 'open, no reply in 5 s' }), 5000); });
    w.on('message', m => done({ result: 'open', reply: String(m).slice(0, 300) }));
    w.on('error', e => { if (!r.result) done({ result: 'error', error: e.message }); });
  });
}
(async () => {
  for (const url of URLS) {
    res.probes.push(await probe(url, {}, 'no key'));
    res.probes.push(await probe(url, K.authHeaders({ keyId: crypto.randomUUID(), pem }), 'a key Kalshi never issued'));
  }
  // the module itself against the real host with that unknown key: it should stop and wait 30 min, not hammer
  const s = K.createKalshiStream({ keyId: crypto.randomUUID(), pem, WebSocket: WS, log: m => (res.log = res.log || []).push(m) });
  s.start(); s.track(['KXNFLGAME-X']);
  await new Promise(r => setTimeout(r, 20000));
  res.module = s.status(); s.stop();
  // the markets a real key would stream: a few open NFL game contracts, read once
  try {
    const r = await axios.get('https://api.elections.kalshi.com/trade-api/v2/markets', { params: { series_ticker: 'KXNFLGAME', status: 'open', limit: 4 }, timeout: 20000 });
    res.sampleMarkets = (r.data.markets || []).map(m => ({ ticker: m.ticker, yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars }));
  } catch (e) { res.sampleMarkets = { error: e.message }; }
  fs.writeFileSync(path.join(out, 'ws.json'), JSON.stringify(res, null, 2));
  process.exit(0);
})();
