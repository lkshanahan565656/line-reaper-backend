// The outbound feed (outfeed.js): owner channels from env, the posts it builds
// (digest, record changes, biggest moves), the Discord and Telegram requests,
// the sender's retries and retirements, and the key store's feed fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const feed = require('../outfeed');
const api = require('../publicapi');

const HOOK = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`;
const TOKEN = `1234567:${'B'.repeat(35)}`;
const O = 'https://lr.example';

test('Discord webhook URLs are recognised and normalised; anything else is refused', () => {
  assert.deepEqual(feed.parseDiscord(HOOK), { id: '123456789012345678', url: HOOK });
  assert.equal(feed.parseDiscord(HOOK.replace('discord.com', 'discordapp.com')).url, HOOK);
  assert.equal(feed.parseDiscord(HOOK.replace('/api/', '/api/v10/')).url, HOOK);
  assert.equal(feed.parseDiscord(HOOK.replace('discord.com', 'canary.discord.com')).url, HOOK);
  for (const bad of ['', null, 'http://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(68), 'https://evil.com/api/webhooks/123456789012345678/' + 'a'.repeat(68),
    'https://discord.com.evil.com/api/webhooks/123456789012345678/' + 'a'.repeat(68), HOOK + '?x=1', 'https://discord.com/api/webhooks/1/abc', 'https://169.254.169.254/latest'])
    assert.equal(feed.parseDiscord(bad), null, String(bad));
});

test('owner channels come from env and say what is wrong; nothing set means nothing', () => {
  assert.deepEqual(feed.ownerDestinations({}), { dests: [], problems: [] });
  const ok = feed.ownerDestinations({ DISCORD_WEBHOOK_URLS: `${HOOK}, nope`, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_IDS: '-1001234567890,@lineReaper, bad id' });
  assert.deepEqual(ok.dests.map(d => d.kind), ['discord', 'telegram', 'telegram']);
  assert.equal(ok.dests[1].chat, '-1001234567890');
  assert.equal(ok.dests[2].chat, '@lineReaper');
  assert.equal(ok.problems.length, 2);
  assert.deepEqual(feed.ownerDestinations({ TELEGRAM_BOT_TOKEN: TOKEN }), { dests: [], problems: [] }, 'a token alone is the command bot: no feed, no problem');
  assert.match(feed.ownerDestinations({ TELEGRAM_CHAT_IDS: '-100123' }).problems[0], /TOKEN is empty/);
  assert.match(feed.ownerDestinations({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_IDS: '-100123' }).problems[0], /not look like a bot token/);
});

const rec = rows => ({ at: '2026-10-26T00:00:00Z', rows });
const row = (kind, book, label, graded, extra = {}) => ({ kind, kindLabel: kind === 'ev' ? 'Main lines' : kind, book, bookName: book === 'betrivers' ? 'BetRivers' : book, label, graded, target: 50, clv: 2.8, clvT: 2.4, ...extra });

test('record changes: the first read is a baseline, a change posts once it holds two reads, and only once', () => {
  let r = feed.recordChanges(null, rec([row('ev', 'betrivers', 'building', 49), row('maker', 'kalshi', 'building', 20)]));
  assert.equal(r.changes.length, 0);
  assert.equal(r.baseline, true);
  // BetRivers turns proven: the first read only notes it
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 50), row('maker', 'kalshi', 'building', 21)]));
  assert.equal(r.changes.length, 0);
  // a flap back clears the pending change
  const flap = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'building', 50), row('maker', 'kalshi', 'building', 21)]));
  assert.equal(flap.changes.length, 0);
  // the second agreeing read posts it
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 51), row('maker', 'kalshi', 'building', 22)]));
  assert.deepEqual(r.changes.map(c => c.change), ['newly proven']);
  // and never again
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 52), row('maker', 'kalshi', 'building', 22)]));
  assert.equal(r.changes.length, 0);
  // a new kind showing up is a baseline for it, not a change
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 52), row('maker', 'kalshi', 'building', 22), row('promo', 'fanduel', 'losing to the close', 60)]));
  assert.equal(r.changes.length, 0);
  // losing to the close, twice in a row
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 52), row('maker', 'kalshi', 'losing to the close', 23)]));
  r = feed.recordChanges(r.state, rec([row('ev', 'betrivers', 'proven', 52), row('maker', 'kalshi', 'losing to the close', 24)]));
  assert.deepEqual(r.changes.map(c => c.change), ['newly losing to the close']);
});

test('the record post says proven only of a proven row and a profit only where RESULTS shows one', () => {
  const p = feed.recordPost([
    { change: 'newly losing to the close', kindLabel: 'Maker', bookName: 'Kalshi', label: 'losing to the close', graded: 60, clv: -1.2, clvT: -2.1 },
    { change: 'newly proven', kindLabel: 'Main lines', bookName: 'BetRivers', label: 'proven', graded: 373, clv: 2.8, clvT: 2.4, profitShown: false, units: null },
  ], { origin: O, now: 0 });
  assert.equal(p.kind, 'record');
  assert.match(p.title, /newly proven/);
  const lines = p.text.split('\n');
  assert.match(lines[0], /BetRivers: NEWLY PROVEN\. 373 graded, CLV \+2\.8% \(t 2\.4\).*profit not shown/);
  assert.match(lines[1], /Kalshi: NEWLY LOSING TO THE CLOSE.*now losing to the close/);
  assert.ok(!/Kalshi.*proven\b(?! )/.test(lines[1].replace('LOSING TO THE CLOSE', '')));
  assert.equal(p.link, `${O}/results`);
  assert.match(p.image, /^https:\/\/lr\.example\/card\/record\.png\?v=/);
  const shown = feed.recordPost([{ change: 'newly proven', kindLabel: 'Main lines', bookName: 'BetRivers', label: 'proven', graded: 400, clv: 3, clvT: 3, profitShown: true, units: 12.5 }], { origin: O });
  assert.match(shown.text, /\+12\.5u/);
});

test('the digest post carries the week, the proven list, the changes and the week card', () => {
  const d = { week: '2026-10-19', name: 'Oct 19 to 25', summary: { graded: 120, kinds: 4, proven: [{ kindLabel: 'Main lines', bookName: 'BetRivers', graded: 373, clv: 2.8 }] },
    rows: [{ kindLabel: 'Main lines', bookName: 'BetRivers', change: 'reached 50 graded' }, { kindLabel: 'x', bookName: 'y', change: null }] };
  const p = feed.digestPost(d, { origin: O, now: 0 });
  assert.equal(p.title, 'Weekly record: week of Oct 19 to 25');
  assert.match(p.text, /120 games graded/);
  assert.match(p.text, /Proven at the week's end: Main lines · BetRivers \(373 graded, CLV \+2\.8%\)/);
  assert.match(p.text, /• Main lines · BetRivers: reached 50 graded/);
  assert.equal(p.link, `${O}/digest/2026-10-19`);
  assert.equal(p.image, `${O}/card/digest.png?week=2026-10-19&v=0`);
  assert.match(feed.digestPost({ ...d, summary: { graded: 0, kinds: 0, proven: [] }, rows: [] }, { origin: O }).text, /nothing yet/);
});

test('the moves post lists the top game price moves as information and charts the first', () => {
  const mv = (i, extra = {}) => ({ kind: 'game', type: 'price', league: 'nfl', leagueLabel: 'NFL', gameId: `g${i}`, event: `A${i} @ H${i}`, market: 'ml', side: `H${i}`, venueName: 'FanDuel',
    from: -150, to: -180, move: 5.1, followers: [{ status: 'moved' }, { status: 'old' }, { status: 'old' }], ...extra });
  const p = feed.movesPost([mv(1), { ...mv(2), type: 'line' }, mv(3), { ...mv(4), kind: 'prop' }, mv(5), mv(6), mv(7), mv(8)], { origin: O, now: 0 });
  const lines = p.text.split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^• NFL · A1 @ H1 · H1: FanDuel -150 → -180 \(5\.1 pts of win chance\)\. 1 venue followed, 2 still at the old price\.$/);
  assert.match(lines[5], /information, not an edge/);
  assert.equal(p.image, `${O}/card/move.png?game=g1&market=ml&side=H1&v=0`);
  assert.equal(feed.movesPost([], { origin: O }), null);
});

test('posts never carry a polymarket.com link or a mass mention', () => {
  const t = feed.clean('see https://polymarket.com/event/x and https://www.polymarket.com @everyone @here');
  assert.ok(!/polymarket\.com/.test(t));
  assert.ok(!/@everyone|@here/.test(t));
  const [r] = feed.discordRequest({ url: HOOK }, { kind: 'moves', title: '@everyone', text: 'https://polymarket.com/x', link: null, image: null });
  assert.ok(!JSON.stringify(r.data).includes('polymarket.com'));
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });
});

test('Discord gets one embed with the card; Telegram gets a photo, split when the text is long', () => {
  const p = { kind: 'digest', title: 'Weekly record', text: 'short', link: `${O}/digest/w`, image: `${O}/card/digest.png` };
  const [d] = feed.discordRequest({ url: HOOK }, p);
  assert.equal(d.url, `${HOOK}?wait=true`);
  assert.equal(d.data.embeds[0].image.url, p.image);
  assert.equal(d.data.embeds[0].url, p.link);
  assert.match(d.data.embeds[0].footer.text, /not a sportsbook/);
  const tg = feed.telegramRequests({ token: TOKEN, chat: '@c' }, p);
  assert.equal(tg.length, 1);
  assert.equal(tg[0].url, `https://api.telegram.org/bot${TOKEN}/sendPhoto`);
  assert.equal(tg[0].data.photo, p.image);
  assert.match(tg[0].data.caption, /WEEKLY RECORD[\s\S]*short[\s\S]*\/digest\/w/);
  const long = feed.telegramRequests({ token: TOKEN, chat: '@c' }, { ...p, text: 'x'.repeat(2000) });
  assert.deepEqual(long.map(r => r.url.split('/').pop()), ['sendPhoto', 'sendMessage']);
  assert.ok(long[1].data.text.length <= 4000);
  assert.equal(feed.telegramRequests({ token: TOKEN, chat: '@c' }, { ...p, image: null })[0].url.split('/').pop(), 'sendMessage');
});

test('the sender: same post to every channel, retries 429 and 5xx, retires dead webhooks, logs no secrets', async () => {
  const calls = [];
  let flaky = 0;
  const post = async (url, data) => {
    calls.push(url);
    if (url.includes('/dead/')) throw Object.assign(new Error('nope'), { response: { status: 404, data: { message: 'Unknown Webhook' } } });
    if (url.includes('/slow/') && flaky++ === 0) throw Object.assign(new Error('rl'), { response: { status: 429, data: { retry_after: 0.01 } } });
    if (url.includes('/down/')) throw Object.assign(new Error('boom'), { response: { status: 502 } });
    return { data };
  };
  const results = [];
  const waits = [];
  const f = feed.createFeed({ owner: [{ kind: 'discord', id: 'o', url: HOOK }], subscribers: () => [
    { kind: 'discord', id: 'a', keyId: 'k1', url: 'https://discord.com/api/webhooks/1/slow/x' },
    { kind: 'discord', id: 'b', keyId: 'k2', url: 'https://discord.com/api/webhooks/2/dead/x' },
    { kind: 'discord', id: 'c', keyId: 'k3', url: 'https://discord.com/api/webhooks/3/down/x' },
  ], post, onResult: (d, r) => results.push([d.id, r.ok, !!r.dead]), wait: async ms => { waits.push(ms); }, log: { warn() {} } });
  const r = await f.send({ kind: 'record', title: 't', text: 'x' });
  assert.deepEqual(r, { sent: 2, failed: 2, to: 4 });
  assert.deepEqual(results.sort(), [['a', true, false], ['b', false, true], ['c', false, false], ['o', true, false]]);
  assert.equal(calls.filter(u => u.includes('/down/')).length, 2, 'a 5xx is tried twice');
  assert.equal(calls.filter(u => u.includes('/dead/')).length, 1, 'a 404 is not retried');
  assert.ok(waits.includes(500), '429 waits the retry_after (at least half a second)');
  assert.ok(!JSON.stringify(f.stats()).includes('webhooks/1'), 'no webhook URL in the stats');
  assert.equal(feed.scrub(`https://api.telegram.org/bot${TOKEN}/sendPhoto`), 'https://api.telegram.org/bot…/sendPhoto');
  // nothing configured: nothing sent
  const none = feed.createFeed({ post: async () => { throw new Error('should not post'); } });
  assert.deepEqual(await none.send({ kind: 'x', title: 't', text: 'x' }), { sent: 0, failed: 0, to: 0 });
});

test('a customer webhook is sealed at rest and opens only with the same key', () => {
  const k = crypto.randomBytes(32);
  const s = feed.sealer(k);
  const box = s.seal(HOOK);
  assert.ok(!JSON.stringify(box).includes('webhooks'));
  assert.equal(s.open(box), HOOK);
  assert.equal(feed.sealer(crypto.randomBytes(32)).open(box), null);
  // a new key still opens what the old one sealed, and seals with the new one
  const oldKey = crypto.randomBytes(32), newKey = crypto.randomBytes(32);
  const sealedOld = feed.sealer(oldKey).seal(HOOK);
  const moved = feed.sealer(newKey, [oldKey, newKey]);
  assert.equal(moved.open(sealedOld), HOOK);
  assert.equal(feed.sealer(oldKey).open(moved.seal(HOOK)), null, 'new seals use the new key');
  assert.equal(feed.sealer(null).open(feed.sealer(null).seal(HOOK)), HOOK);
});

const memStore = () => { const rows = new Map(); return { rows, init: async () => {}, all: async () => [...rows.values()], put: async d => { rows.set(d.id, d); } }; };
test('the key store keeps one feed per key, retires it after 5 fails or a dead answer, and drops it with the key', async () => {
  const store = memStore();
  const keys = api.createKeyStore({ store });
  const a = await keys.create({ who: 'x' }), b = await keys.create({ who: 'y' });
  assert.deepEqual(keys.feeds(), []);
  await keys.setFeed(a.key, { hookId: '1', sealed: { plain: 'u1' }, addedAt: 't' });
  await keys.setFeed(b.key, { hookId: '2', sealed: { plain: 'u2' }, addedAt: 't' });
  assert.equal(keys.feeds().length, 2);
  assert.equal(keys.stats().feeds, 2);
  for (let i = 0; i < 4; i++) await keys.markFeed(a.id, { ok: false, why: 'x' });
  assert.equal(keys.feeds().length, 2);
  await keys.markFeed(a.id, { ok: true });
  for (let i = 0; i < 4; i++) await keys.markFeed(a.id, { ok: false, why: 'x' });
  assert.equal(keys.feeds().length, 2, 'a success resets the count');
  await keys.markFeed(a.id, { ok: false, why: 'x' });
  assert.equal(keys.feeds().length, 1);
  await keys.markFeed(b.id, { ok: false, dead: true, why: '404' });
  assert.equal(keys.feeds().length, 0);
  // reconnect, then revoke drops the sealed URL from the store
  await keys.setFeed(b.key, { hookId: '2', sealed: { plain: 'u2' }, addedAt: 't' });
  assert.equal(keys.feeds().length, 1);
  await keys.revoke(b.key);
  assert.equal(keys.feeds().length, 0);
  assert.equal(store.rows.get(b.id).feed, null);
  assert.equal(await keys.setFeed(b.key, { hookId: '3' }), null, 'a revoked key cannot connect');
});
