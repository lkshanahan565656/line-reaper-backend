// Kalshi link: read-only key check, sealed storage, request signing, fills to
// record bets, polling and dedupe. TEST DATA: every key, fill and ticker here
// is made up in this file; nothing reaches Kalshi.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const K = require('../kalshilink');
const pubRecord = require('../pubrecord');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = crypto.generateKeyPairSync('ed25519');
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
const ED_PEM = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_ID = 'a1b2c3d4-0000-4000-8000-00000000abcd';

function memStore() { const rows = new Map(); return { rows, async init() {}, async all() { return [...rows.values()]; }, async put(d) { rows.set(d.id, JSON.parse(JSON.stringify(d))); } }; }
const noGap = K.createQueue({ gapMs: 0, sleep: async () => {} });

// a fake Kalshi: checks the signature on every call, answers /api_keys and /portfolio/fills
function fakeKalshi({ scopes = ['read'], fills = [], fail = null, pub = rsa.publicKey } = {}) {
  const calls = [];
  return {
    calls,
    async get(url, cfg) {
      const u = new URL(url);
      calls.push({ path: u.pathname, params: cfg.params, headers: cfg.headers });
      const h = cfg.headers;
      const msg = Buffer.from(`${h['KALSHI-ACCESS-TIMESTAMP']}GET${u.pathname}`);
      const sig = Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64');
      const ok = pub.asymmetricKeyType === 'ed25519' ? crypto.verify(null, msg, pub, sig)
        : crypto.verify('sha256', msg, { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
      if (!ok || h['KALSHI-ACCESS-KEY'] !== KEY_ID) throw Object.assign(new Error('bad sig'), { response: { status: 401 } });
      if (fail) throw Object.assign(new Error('fail'), { response: { status: fail } });
      if (u.pathname.endsWith('/api_keys')) return { data: { api_keys: [{ api_key_id: 'other', scopes: ['read', 'write'] }, { api_key_id: KEY_ID, name: 'lr', scopes }] } };
      if (u.pathname.endsWith('/portfolio/fills')) {
        const min = (cfg.params.min_ts || 0) * 1000;
        return { data: { fills: fills.filter(f => Date.parse(f.created_time) >= min), cursor: '' } };
      }
      throw Object.assign(new Error('404'), { response: { status: 404 } });
    },
  };
}

test('cleanKey reads RSA and Ed25519 keys and refuses junk in plain words', () => {
  assert.equal(K.cleanKey(KEY_ID, RSA_PEM).type, 'rsa');
  assert.equal(K.cleanKey(KEY_ID, ED_PEM).type, 'ed25519');
  assert.match(K.cleanKey('', RSA_PEM).error, /Key ID/);
  assert.match(K.cleanKey(KEY_ID, 'hello').error, /whole private key/);
  assert.match(K.cleanKey(KEY_ID, '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----').error, /could not be read/);
  const pubPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  assert.ok(K.cleanKey(KEY_ID, pubPem).error, 'a public key is not a private key');
});

test('readOnly takes read and read:: children only', () => {
  assert.equal(K.readOnly(['read']), true);
  assert.equal(K.readOnly(['read', 'read::portfolio_balance']), true);
  assert.equal(K.readOnly(['read', 'write']), false);
  assert.equal(K.readOnly(['write::trade']), false);
  assert.equal(K.readOnly(['read', 'write::transfer']), false);
  assert.equal(K.readOnly([]), false);
  assert.equal(K.readOnly(null), false);
});

test('seal and open round-trip; a different secret opens nothing', () => {
  const box = K.seal('s1', { keyId: KEY_ID, pem: RSA_PEM });
  assert.ok(!JSON.stringify(box).includes('PRIVATE KEY'));
  assert.equal(K.open('s1', box).pem, RSA_PEM);
  assert.equal(K.open('s2', box), null);
  assert.equal(K.open('s1', { ...box, data: Buffer.from('x').toString('base64') }), null);
});

test('signs the timestamp, method and path (no query) with RSA-PSS and Ed25519', async () => {
  for (const [pem, pub] of [[RSA_PEM, rsa.publicKey], [ED_PEM, ed.publicKey]]) {
    const http = fakeKalshi({ pub });
    const c = K.client({ http, queue: noGap, keyId: KEY_ID, pem, now: () => 1761660000000 });
    const d = await c.get('/api_keys');
    assert.equal(d.api_keys.length, 2);
    assert.equal(http.calls[0].path, '/trade-api/v2/api_keys');
    assert.equal(http.calls[0].headers['KALSHI-ACCESS-TIMESTAMP'], '1761660000000');
  }
});

test('the queue runs one request at a time', async () => {
  const q = K.createQueue({ gapMs: 0, sleep: async () => {} });
  let running = 0, most = 0;
  await Promise.all([1, 2, 3].map(() => q.run(async () => { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 5)); running--; })));
  assert.equal(most, 1);
});

// a made-up game: TEST DATA
const GAME = { track: { kind: 'line', game: 'pin-1', league: 'nba', market: 'ml', point: null, start: '2026-10-29T00:00:00Z' }, event: 'Made Up Away @ Made Up Home', start: '2026-10-29T00:00:00Z' };
const lookup = t => (t === 'KXNBAGAME-26OCT28AWYHOM-HOM'
  ? { yes: { ...GAME, track: { ...GAME.track, side: 'Made Up Home' }, pick: 'Made Up Home ML' }, no: { ...GAME, track: { ...GAME.track, side: 'Made Up Away' }, pick: 'Made Up Away ML' } }
  : null);
const fill = (o = {}) => ({ fill_id: 'f1', order_id: 'o1', ticker: 'KXNBAGAME-26OCT28AWYHOM-HOM', outcome_side: 'yes', book_side: 'bid', count_fp: '10.00', yes_price_dollars: '0.4000', no_price_dollars: '0.6000', fee_cost: '0.17', is_taker: true, created_time: '2026-10-28T20:00:00Z', ...o });

test('fillsToBets: one bet an order, its side and price, fee included, before-connect skipped', () => {
  const since = Date.parse('2026-10-28T19:00:00Z');
  const out = K.fillsToBets([
    fill(), fill({ fill_id: 'f2', count_fp: '10.00', yes_price_dollars: '0.4200', fee_cost: '0.18' }),
    fill({ fill_id: 'f3', order_id: 'o2', outcome_side: 'no', book_side: 'ask' }),
    fill({ fill_id: 'f4', order_id: 'o3', created_time: '2026-10-28T18:00:00Z' }),
    fill({ fill_id: 'f5', order_id: 'o4', ticker: 'KXSOMEPROP-XYZ' }),
    fill({ fill_id: 'f6', order_id: 'o5', yes_price_dollars: '1.2' }),
  ], lookup, { since });
  assert.deepEqual(out.skipped, { before: 1, unmatched: 1, noSide: 0, price: 1 });
  assert.deepEqual(out.unmatched, ['KXSOMEPROP-XYZ']);
  assert.equal(out.bets.length, 2);
  const a = out.bets.find(b => b.id === 'kalshi-o1');
  // (10 × 0.40 + 10 × 0.42 + 0.35 fees) / 20 = 0.4275 a contract
  assert.equal(a.decimal, Math.round(1e4 / 0.4275) / 1e4);
  assert.equal(a.track.side, 'Made Up Home');
  assert.equal(a.venue, 'kalshi_fill');
  assert.deepEqual([a.verified.by, a.verified.filledAt, a.verified.fills], ['kalshi', '2026-10-28T20:00:00.000Z', 2]);
  const b = out.bets.find(x => x.id === 'kalshi-o2');
  assert.equal(b.track.side, 'Made Up Away');
  assert.equal(b.decimal, Math.round(1e4 / (0.6 + 0.017)) / 1e4);
});

test('fillSide reads the deprecated side and action pair', () => {
  assert.equal(K.fillSide({ side: 'yes', action: 'buy' }), 'yes');
  assert.equal(K.fillSide({ side: 'yes', action: 'sell' }), 'no');
  assert.equal(K.fillSide({ book_side: 'ask' }), 'no');
  assert.equal(K.fillSide({}), null);
});

function setup({ scopes = ['read'], fills = [], fail = null, t0 = Date.parse('2026-10-28T19:00:00Z') } = {}) {
  let t = t0;
  const http = fakeKalshi({ scopes, fills, fail });
  const store = memStore();
  const links = K.createKalshiLinks({ store, secret: 'test-secret', http, queue: noGap, now: () => t, log: { warn() {} } });
  return { http, store, links, at: x => { t = x; } };
}

test('connect refuses a key that can write and saves nothing', async () => {
  const s = setup({ scopes: ['read', 'write'] });
  await assert.rejects(s.links.connect('bettor', KEY_ID, RSA_PEM), e => e.status === 400 && /read-only/.test(e.message) && /Nothing was saved/.test(e.message));
  assert.equal(s.store.rows.size, 0);
  const s2 = setup({ scopes: ['read', 'write::trade'] });
  await assert.rejects(s2.links.connect('bettor', KEY_ID, RSA_PEM), /write::trade/);
  assert.equal(s2.store.rows.size, 0);
});

test('connect refuses a key Kalshi rejects, and one whose scopes it does not list', async () => {
  const s = setup({ fail: 401 });
  await assert.rejects(s.links.connect('bettor', KEY_ID, RSA_PEM), e => e.status === 400 && /did not accept/.test(e.message));
  const s2 = setup();
  await assert.rejects(s2.links.connect('bettor', 'ffffffff-0000-4000-8000-000000000000', RSA_PEM), e => e.status === 400);
  assert.equal(s2.store.rows.size, 0);
});

test('connect with a read-only key: sealed at rest, never shown back', async () => {
  const s = setup();
  const v = await s.links.connect('bettor', KEY_ID, RSA_PEM);
  assert.deepEqual([v.connected, v.status, v.keyHint, v.scopes], [true, 'active', '…abcd', ['read']]);
  const saved = JSON.stringify([...s.store.rows.values()]);
  assert.ok(!saved.includes('PRIVATE KEY') && !saved.includes(KEY_ID), 'neither the key nor its id is stored in the clear');
  assert.ok(!JSON.stringify(await s.links.status('bettor')).includes('PRIVATE'));
  const off = await s.links.disconnect('bettor');
  assert.equal(off.connected, false);
  const doc = s.store.rows.get('kl|bettor');
  assert.equal(doc.box, null, 'the sealed key is overwritten');
  assert.equal((await s.links.status('bettor')).connected, false);
});

test('poll: new fills after the connect go to the record once; the record grades them as Kalshi (connected)', async () => {
  const fills = [fill({ created_time: '2026-10-28T18:30:00Z', fill_id: 'old', order_id: 'old' }), fill()];
  const s = setup({ fills });
  await s.links.connect('bettor', KEY_ID, RSA_PEM);
  // a real record store, its own memory store (TEST DATA)
  const recs = pubRecord.createRecordStore({ store: memStore(), now: () => Date.parse('2026-10-28T20:05:00Z') });
  const pub = await recs.publish({ handle: 'bettor' });
  const added = [];
  s.at(Date.parse('2026-10-28T20:05:00Z'));
  const st = await s.links.pollAll({ lookup, addBets: (h, list) => recs.addVerifiedBets(h, list), onAdded: h => added.push(h) });
  assert.deepEqual([st.polled, st.imported], [1, 1]);
  assert.deepEqual(added, ['bettor']);
  const fillsCall = s.http.calls.find(c => c.path.endsWith('/portfolio/fills'));
  assert.equal(fillsCall.params.min_ts, Math.floor(Date.parse('2026-10-28T19:00:00Z') / 1000), 'reads from the connect time, never earlier');
  // a second pass: the same fills are seen, nothing is added again
  s.at(Date.parse('2026-10-28T20:10:00Z'));
  await s.links.pollAll({ lookup, addBets: (h, list) => recs.addVerifiedBets(h, list) });
  const bets = recs.betsOf('bettor');
  assert.equal(bets.length, 1);
  assert.equal(bets[0].bet.verified.filledAt, '2026-10-28T20:00:00.000Z');
  const status = await s.links.status('bettor');
  assert.equal(status.counts.imported, 1);
  assert.equal(status.counts.fills, 1, 'the pre-connect fill is filtered by min_ts and never counted');
  // the record page's rows say where it came from; the bettor can't post to that venue
  const v = pubRecord.betsView(recs.betsOf('bettor'));
  assert.deepEqual([v.rows[0].verified, v.rows[0].venueName], ['kalshi', 'Kalshi (connected)']);
  const forged = await recs.addBets('bettor', pub.token, [{ id: 'kalshi-x', venue: 'kalshi_fill', venueName: 'Kalshi (connected)', decimal: 2, track: GAME.track && { ...GAME.track, side: 'Made Up Home' } },
    { id: 'x2', venue: 'kalshi_fill', decimal: 2, track: { ...GAME.track, side: 'Made Up Home' } }]);
  assert.deepEqual([forged.added, forged.bad], [0, 2]);
  const html = pubRecord.pageHtml(pubRecord.recordView(recs.get('bettor'), [], { bets: recs.betsOf('bettor') }));
  assert.match(html, /KALSHI FILL/);
  assert.match(html, /read-only key/);
});

test('poll: three refused reads in a row pause the link; a disconnect mid-poll is not undone', async () => {
  const s = setup();
  await s.links.connect('bettor', KEY_ID, RSA_PEM);
  // the key stops working (revoked at Kalshi)
  const doc = s.links.links.get('bettor');
  s.links.links.set('bettor', { ...doc, box: K.seal('test-secret', { keyId: KEY_ID, pem: ED_PEM }) });
  for (let i = 0; i < 3; i++) await s.links.pollAll({ lookup, addBets: async () => ({ added: 0 }) });
  const st = await s.links.status('bettor');
  assert.equal(st.status, 'paused');
  assert.match(st.lastError, /Paused after 3 tries/);
  assert.equal(s.links.stats().active, 0);

  const s2 = setup({ fills: [fill()] });
  await s2.links.connect('bettor', KEY_ID, RSA_PEM);
  s2.at(Date.parse('2026-10-28T20:05:00Z'));
  await s2.links.pollAll({ lookup, addBets: async () => { await s2.links.disconnect('bettor'); return { added: 1 }; } });
  assert.equal((await s2.links.status('bettor')).connected, false);
  assert.equal(s2.store.rows.get('kl|bettor').box, null);
});

test('a key sealed under another secret pauses with a plain reason', async () => {
  const s = setup();
  await s.links.connect('bettor', KEY_ID, RSA_PEM);
  const doc = s.links.links.get('bettor');
  s.links.links.set('bettor', { ...doc, box: K.seal('other-secret', { keyId: KEY_ID, pem: RSA_PEM }) });
  await s.links.pollAll({ lookup, addBets: async () => ({ added: 0 }) });
  assert.match((await s.links.status('bettor')).lastError, /server secret changed/);
});

test('betForKey: the track MY BETS logs, spreads kept at home\'s number', () => {
  const g = { id: 'pin-77', home_team: 'Made Up Home', away_team: 'Made Up Away', commence_time: '2026-10-29T00:00:00Z' };
  const ml = K.betForKey('77|ml|away', g, 'nba');
  assert.deepEqual(ml.track, { kind: 'line', game: 'pin-77', league: 'nba', market: 'ml', side: 'Made Up Away', point: null, start: g.commence_time });
  assert.equal(ml.pick, 'Made Up Away ML');
  const tot = K.betForKey('77|total|221.5|under', g, 'nba');
  assert.deepEqual([tot.track.side, tot.track.point, tot.pick], ['Under', 221.5, 'Under 221.5']);
  const sp = K.betForKey('77|spread|-3.5|away', g, 'nba');
  assert.deepEqual([sp.track.side, sp.track.point, sp.pick], ['Made Up Away', -3.5, 'Made Up Away +3.5']);
  assert.equal(K.betForKey('77|spread|-3.5|home', g, 'nba').pick, 'Made Up Home -3.5');
  assert.equal(K.betForKey('77|ml3|draw', g, 'epl'), null);
  assert.equal(K.betForKey('77|total|x|over', g, 'nba'), null);
});
