const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { createLicences } = require('../licences');
const legal = require('../legal');

// an axios instance whose requests never leave the process
function fakeAxios() {
  const sent = [];
  const http = axios.create({ adapter: async cfg => { sent.push(cfg.url); return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config: cfg }; } });
  return { http, sent };
}

test('paywall off: every feed runs, nothing is paused', async () => {
  const L = createLicences({ paywall: () => false, env: {} });
  const { http, sent } = fakeAxios();
  L.install(http, { warn() {} });
  await http.get('https://api.prizepicks.com/projections');
  await http.get('https://api.owlsinsight.com/api/v1/nba/odds');
  assert.equal(sent.length, 2);
  assert.deepEqual(L.state().paused, []);
});

test('paywall on: scraped and single-user feeds are refused before any request; licensed ones still run', async () => {
  const L = createLicences({ paywall: () => true, env: {} });
  const { http, sent } = fakeAxios();
  const warns = [];
  L.install(http, { warn: m => warns.push(m) });
  for (const url of ['https://api.prizepicks.com/projections', 'https://api.underdogfantasy.com/v1/over_under_lines', 'https://www.vlr.gg/search/?q=x',
    'https://vlrggapi.vercel.app/stats', 'https://api.bo3.gg/api/v1/matches', 'https://gol.gg/players/list/', 'https://guest.api.arcadia.pinnacle.com/0.1/sports',
    'https://api.owlsinsight.com/api/v1/nba/odds', 'https://www.hltv.org/matches']) {
    await assert.rejects(http.get(url), e => e.code === 'LICENCE_PAUSED' && /waiting on data permission/.test(e.message), url);
  }
  assert.equal(sent.length, 0, 'nothing went out');
  // logged once per source, not once per request
  await assert.rejects(http.get('https://api.prizepicks.com/projections'));
  assert.equal(warns.filter(w => /PrizePicks/.test(w)).length, 1);
  for (const url of ['https://api.elections.kalshi.com/trade-api/v2/markets', 'https://gamma-api.polymarket.com/markets', 'https://api.opendota.com/api/proMatches',
    'https://lol.fandom.com/api.php', 'https://api.the-odds-api.com/v4/sports', 'https://notbo3.gg.example.com/x']) await http.get(url);
  assert.equal(sent.length, 6);
});

test('each feed comes back with its own setting, and a baseURL request is matched too', async () => {
  const env = { PRIZEPICKS_DATA_OK: 'on', BO3_DATA_OK: 'yes' };
  const L = createLicences({ paywall: () => true, env });
  const { http, sent } = fakeAxios();
  L.install(http, { warn() {} });
  await http.get('https://api.prizepicks.com/projections');
  await http.get('/api/v1/matches', { baseURL: 'https://api.bo3.gg' });
  await assert.rejects(http.get('/v1/lines', { baseURL: 'https://api.underdogfantasy.com' }));
  assert.equal(sent.length, 2);
  assert.ok(L.isOn('prizepicks') && L.isOn('bo3') && !L.isOn('underdog') && L.isOn('not-a-source'));
  const st = L.state();
  assert.equal(st.sources.find(s => s.key === 'prizepicks').state, 'on');
  assert.equal(st.sources.find(s => s.key === 'underdog').state, 'paused');
  assert.ok(st.review.length >= 3, 'feeds still to check are listed');
  assert.deepEqual(L.publicState().paused.map(p => p.key).sort(), st.paused.slice().sort());
});

test('a custom Underdog URL is covered', async () => {
  const L = createLicences({ paywall: () => true, env: {}, extraHosts: { underdog: ['ud-proxy.example.net'] } });
  assert.equal(L.blocked('https://ud-proxy.example.net/lines').key, 'underdog');
  assert.equal(L.blocked('not a url'), null);
});

test('legal pages: config is escaped, contact falls back, refund window and age show', () => {
  const html = legal.render('terms', legal.configFromEnv({ LEGAL_ENTITY: 'Reaper <b>LLC</b>', LEGAL_EMAIL: 'help@example.com', LEGAL_STATE: 'Ohio' }));
  assert.match(html, /Reaper &lt;b&gt;LLC&lt;\/b&gt;/);
  assert.match(html, /mailto:help@example\.com/);
  assert.match(html, /laws of the State of Ohio/);
  assert.match(html, /renews automatically/);
  assert.match(html, /<nav class="toc"/);
  const bare = legal.render('refunds', legal.configFromEnv({}));
  assert.match(bare, new RegExp(`${legal.REFUND_HOURS} hours`));
  assert.match(bare, /href="\/legal#contact"/, 'no email set: points at the contact section');
  assert.match(legal.render('legal', legal.configFromEnv({})), /not published yet/);
  assert.match(legal.render('privacy'), /do not sell your personal information/i);
  assert.equal(legal.render('nope'), null);
  assert.match(legal.render('tos'), /Terms of Service/, 'aliases render');
});

test('hidden wallets: rows that mention one are dropped, a bare match is nulled, nothing changes with none set', () => {
  const { hideWallets, hiddenWallets, mentions } = require('../licences');
  const W = '0xAbCdEf0000000000000000000000000000000001', other = '0x2222222222222222222222222222222222222222';
  const body = { traders: [{ wallet: W, grade: 'A' }, { wallet: other, grade: 'B' }], signals: [{ lead: { list: [{ wallet: W.toLowerCase() }] } }, { wallet: other }], wallet: W, n: 2 };
  const list = hiddenWallets({ HIDDEN_WALLETS: ` ${W} , short ` });
  assert.deepEqual(list, [W.toLowerCase()], 'trimmed, lowercased, junk dropped');
  const out = hideWallets(body, list);
  assert.deepEqual(out.traders, [{ wallet: other, grade: 'B' }]);
  assert.deepEqual(out.signals, [{ wallet: other }]);
  assert.equal(out.wallet, null);
  assert.equal(out.n, 2);
  assert.equal(hideWallets(body, []), body, 'untouched when none are hidden');
  assert.ok(mentions({ deep: [{ x: W }] }, list) && !mentions({ x: other }, list));
});
