// A bettor's record as a widget and as a Discord/Telegram feed (pubrecord.js
// bettorCard + feedItems, outfeed.js planBettorFeed + posts, embeds.js
// bettorWidget). TEST DATA: every slip, bet and grade below is made up here to
// exercise the rules; none is anyone's record.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pubrecord');
const F = require('../outfeed');
const E = require('../embeds');
const A = require('../publicapi');

const memStore = () => { const m = new Map(); return { m, async init() {}, async all() { return [...m.values()]; }, async put(d) { m.set(d.id, JSON.parse(JSON.stringify(d))); } }; };
const T0 = Date.parse('2026-10-27T12:00:00Z');
function setup() {
  let t = T0;
  const store = memStore();
  const rs = P.createRecordStore({ store, now: () => t, random: n => Buffer.alloc(n, 9) });
  return { rs, store, clock: { set: x => { t = x; } } };
}
const leg = (player, line = 20.5, side = 'Over') => ({ player, market: 'Points', side, line, sport: 'NBA' });
const slip = (id, legs) => ({ id, app: 'prizepicks', legs, placedAt: new Date(T0).toISOString(), source: 'paste' });
const grade = (start, { outcome = null, ev = 4, fair = 0.58 } = {}) => ({
  status: outcome ? 'graded' : 'open', final: !!outcome, matched: { sport: 'NBA', player: 'X', market: 'Points', start: new Date(start).toISOString(), matchTitle: 'Fake A @ Fake B' },
  decimal: 1.7787, raw: { source: 'pinnacle', fair, ev, line: 20.5, exact: true, ok: true }, outcome, result: outcome ? 24 : null, gradeSource: outcome ? 'ESPN box score' : null });
async function gradeAll(rs, h, start, opts) {
  const res = {};
  for (const l of rs.pendingLegs(h)) res[l.id] = grade(start, opts);
  await rs.applyGrades(h, res);
}
const viewOf = (rs, h, now) => P.recordView(rs.get(h), rs.slipsOf(h), { perPage: 1e6, bets: rs.betsOf(h), now });

test('the record card: each app on its own, no units or profit, proven only on the rule', async () => {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'card_test', who: 'a' });
  await rs.addSlips('card_test', token, [slip('s1', [leg('Fake One'), leg('Fake Two')])]);
  await gradeAll(rs, 'card_test', T0 + 3600e3, { outcome: 'win' });
  const c = P.bettorCard(viewOf(rs, 'card_test', T0 + 86400e3));
  assert.equal(c.handle, 'card_test');
  assert.equal(c.url, '/r/card_test');
  assert.equal(c.onTime, 1);
  assert.deepEqual(c.proven, []);
  assert.equal(c.kinds[0].name, 'PrizePicks');
  assert.equal(c.kinds[0].n, 2);
  assert.ok(['building', 'too early'].includes(c.kinds[0].label), c.kinds[0].label);
  assert.equal(c.kinds[0].record, '2-0');
  const json = JSON.stringify(c);
  assert.ok(!/units|profit"|"stake/.test(json.replace(/No profit is shown here/, '')), 'no units, profit or stake on the card');
  // unpublished and unknown
  assert.equal(P.bettorCard({ handle: 'x', status: 'unpublished' }).status, 'unpublished');
  assert.equal(P.bettorCard(null).status, 'missing');
});

test('the widget: a link to the record, PROVEN only when the record says so, no profit', async () => {
  const card = { handle: 'w_test', status: 'live', at: new Date(T0).toISOString(), onTime: 12, late: 3, proven: [],
    kinds: [{ kind: 'app', name: 'PrizePicks', unit: 'legs', n: 30, target: 50, clv: 1.2, clvT: 1.1, beat: 0.55, graded: 30, record: '17-13', label: 'building' }] };
  const h = E.bettorWidget(card, { origin: 'https://lr.example', id: 'x1' });
  assert.match(h, /@w_test · verified record/);
  assert.match(h, /href="https:\/\/lr\.example\/r\/w_test"/);
  assert.match(h, /Nothing proven yet/);
  assert.ok(!/class="tag pv">PROVEN/.test(h));
  assert.match(h, /3 logged late, shown on the record and never counted/);
  assert.ok(!/\bunits?\b|\$\d/.test(h.replace(/No profit is shown here/, '')), 'no units or money');
  const proven = E.bettorWidget({ ...card, proven: ['PrizePicks'], kinds: [{ ...card.kinds[0], n: 60, clvT: 2.4, label: 'proven' }] }, {});
  assert.match(proven, /class="tag pv">PROVEN<\/span> at PrizePicks/);
  assert.match(E.bettorWidget({ handle: 'gone', status: 'unpublished' }), /@gone unpublished this record/);
  assert.match(E.bettorWidget({ handle: null, status: 'missing' }), /No published bettor record/);
  // the loader passes data-handle through
  assert.match(E.embedScript('https://lr.example'), /'handle'/);
});

test('the feed plan: a baseline first, then each on-time pick once and its result once; late never', async () => {
  const { rs, clock } = setup();
  const { token } = await rs.publish({ handle: 'feed_test', who: 'a' });
  // history before any channel: an old slip, graded and final
  await rs.addSlips('feed_test', token, [slip('old', [leg('Fake Old')])]);
  await gradeAll(rs, 'feed_test', T0 + 3600e3, { outcome: 'win' });
  clock.set(T0 + 2 * 3600e3);
  let plan = F.planBettorFeed(null, P.feedItems(viewOf(rs, 'feed_test', T0 + 2 * 3600e3)), { now: T0 + 2 * 3600e3 });
  assert.equal(plan.baseline, true);
  assert.deepEqual([plan.picks.length, plan.results.length], [0, 0], 'connecting never floods the channel with history');
  let state = plan.state;
  // a new slip logged before its game: waits while it is matched, then posts once
  await rs.addSlips('feed_test', token, [slip('new', [leg('Fake New'), leg('Fake Newer')])]);
  plan = F.planBettorFeed(state, P.feedItems(viewOf(rs, 'feed_test', T0 + 2 * 3600e3)), { now: T0 + 2 * 3600e3 });
  assert.equal(plan.picks.length, 0, 'not matched to a game yet: not posted');
  state = plan.state;
  await gradeAll(rs, 'feed_test', T0 + 5 * 3600e3);
  plan = F.planBettorFeed(state, P.feedItems(viewOf(rs, 'feed_test', T0 + 2 * 3600e3 + 60e3)), { now: T0 + 2 * 3600e3 + 60e3 });
  assert.deepEqual(plan.picks.map(i => i.key), ['s:new']);
  state = plan.state;
  plan = F.planBettorFeed(state, P.feedItems(viewOf(rs, 'feed_test', T0 + 2 * 3600e3 + 120e3)), { now: T0 + 2 * 3600e3 + 120e3 });
  assert.equal(plan.picks.length, 0, 'a pick posts once');
  state = plan.state;
  // a slip logged after its game started: LATE, never posted, never resulted
  clock.set(T0 + 6 * 3600e3);
  await rs.addSlips('feed_test', token, [slip('late', [leg('Fake Late')])]);
  await gradeAll(rs, 'feed_test', T0 + 5 * 3600e3, { outcome: 'win' });
  plan = F.planBettorFeed(state, P.feedItems(viewOf(rs, 'feed_test', T0 + 9 * 3600e3)), { now: T0 + 9 * 3600e3 });
  assert.deepEqual(plan.picks.map(i => i.key), []);
  assert.deepEqual(plan.results.map(i => i.key), ['s:new'], 'the graded result of the posted pick, once; the late slip never');
  state = plan.state;
  plan = F.planBettorFeed(state, P.feedItems(viewOf(rs, 'feed_test', T0 + 10 * 3600e3)), { now: T0 + 10 * 3600e3 });
  assert.equal(plan.results.length, 0);
  // no channel for a while: the next channel starts from a fresh baseline
  const idle = F.idleBettorFeed(plan.state);
  assert.equal(idle.active, false);
  assert.equal(F.planBettorFeed(idle, P.feedItems(viewOf(rs, 'feed_test', T0 + 11 * 3600e3)), { now: T0 + 11 * 3600e3 }).baseline, true);
});

test('the feed plan: a pick matched only long after it was logged is marked, not posted as new', () => {
  const items = [{ key: 's:a', type: 'slip', timing: 'on time', receivedAt: new Date(T0).toISOString(), final: false }];
  const plan = F.planBettorFeed({ active: true, picks: {}, results: {} }, items, { now: T0 + 13 * 3600e3 });
  assert.equal(plan.picks.length, 0);
  assert.ok(plan.state.picks['s:a']);
});

test('the posts: the server stamp and the price, no units, profit or stake, the same words for everyone', async () => {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'post_test', who: 'a' });
  await rs.addSlips('post_test', token, [slip('p1', [leg('Fake @everyone'), leg('Fake Two', 7.5, 'Under')])]);
  await gradeAll(rs, 'post_test', T0 + 3 * 3600e3);
  let v = viewOf(rs, 'post_test', T0 + 60e3);
  const items = P.feedItems(v);
  const pick = F.bettorPickPost('post_test', items, { origin: 'https://lr.example', now: T0 });
  assert.equal(pick.title, '@post_test logged a pick');
  assert.match(pick.text, /PrizePicks 2-pick/);
  assert.match(pick.text, /Fake Two Under 7\.5 Points/);
  assert.match(pick.text, /logged 10\/27 12:00:00 UTC by the server, 3 h before the first game/);
  assert.equal(pick.link, 'https://lr.example/r/post_test');
  const d = F.discordRequest({ url: 'https://discord.com/api/webhooks/1/x' }, pick)[0].data;
  assert.ok(!/@everyone/.test(d.embeds[0].description), '@everyone is defused');
  assert.deepEqual(d.allowed_mentions, { parse: [] });
  await gradeAll(rs, 'post_test', T0 + 3 * 3600e3, { outcome: 'win' });
  v = viewOf(rs, 'post_test', T0 + 5 * 3600e3);
  const res = F.bettorResultPost('post_test', P.feedItems(v), P.bettorCard(v), { origin: 'https://lr.example', now: T0 + 5 * 3600e3 });
  assert.match(res.title, /@post_test: a pick graded/);
  assert.match(res.text, /PrizePicks 2-pick: WIN/);
  assert.match(res.text, /CLV \+4\.0% vs Pinnacle's close/);
  assert.match(res.text, /PrizePicks: 2 of 50 legs graded against Pinnacle's close/);
  assert.match(res.image, /\/card\/record-post_test\.png\?v=/);
  for (const t of [pick.text, res.text]) assert.ok(!/[+-]\d+(\.\d+)?u\b|\bunits\b|\$\d|stake [\d$]/.test(t), `no units or money: ${t}`);
  // a bet: venue, pick and price
  const bet = { key: 'b:1', type: 'bet', timing: 'on time', receivedAt: new Date(T0).toISOString(), start: new Date(T0 + 7200e3).toISOString(), final: false, group: 'BetRivers',
    bet: { venueName: 'BetRivers', pick: 'Fake Team -3.5', decimal: 1.91, event: 'Fake @ Team', start: new Date(T0 + 7200e3).toISOString(), receivedAt: new Date(T0).toISOString() } };
  assert.match(F.bettorPickPost('post_test', [bet]).text, /BetRivers: Fake Team -3\.5 @ 1\.91 \(-110\)/);
  // more than eight in one pass: written out up to eight
  const many = Array.from({ length: 11 }, (_, i) => ({ ...bet, key: `b:${i}` }));
  assert.match(F.bettorPickPost('post_test', many).text, /and 3 more picks on the record/);
  assert.equal(F.bettorPickPost('x', []), null);
  assert.match(F.bettorWelcomePost('post_test', { origin: 'https://lr.example' }).text, /logged after its start never posts/);
});

test('Telegram for a record: token and chat checked before anything is sent', () => {
  assert.ok(F.parseTelegram('nope', '@chan').error);
  assert.ok(F.parseTelegram(`12345678:${'a'.repeat(35)}`, 'chan').error);
  const d = F.parseTelegram(`12345678:${'a'.repeat(35)}`, '@my_channel');
  assert.deepEqual([d.kind, d.chat, d.botId], ['telegram', '@my_channel', '12345678']);
});

test('the owner\'s channels: set with the key, marked on failure, dropped on unpublish', async () => {
  const { rs } = setup();
  const { token } = await rs.publish({ handle: 'own_feed', who: 'a' });
  await assert.rejects(rs.setFeed('own_feed', 'lrr_wrongwrongwrongwrongwrong', 'discord', { hookId: '1' }), e => e.status === 403);
  await assert.rejects(rs.setFeed('own_feed', token, 'email', {}), e => e.status === 400);
  await rs.setFeed('own_feed', token, 'discord', { hookId: '123', sealed: { plain: 'x' } });
  assert.equal(rs.feedOf('own_feed').discord.hookId, '123');
  for (let i = 0; i < 5; i++) await rs.markFeed('own_feed', 'discord', { ok: false, why: 'boom' });
  assert.ok(rs.feedOf('own_feed').discord.deadAt, '5 fails in a row stop it');
  await rs.setFeed('own_feed', token, 'discord', { hookId: '124' });
  await rs.markFeed('own_feed', 'discord', { ok: false, dead: true, why: '404' });
  assert.ok(rs.feedOf('own_feed').discord.deadAt, 'a webhook Discord says is gone stops at once');
  // TAKE OFF THE LIST leaves the feed alone
  await rs.setFeed('own_feed', token, 'telegram', { chat: '@c', sealed: { plain: 't' } });
  await rs.setListed('own_feed', token, false);
  assert.equal(rs.feedOf('own_feed').telegram.chat, '@c');
  await rs.unpublish('own_feed', token);
  assert.equal(rs.feedOf('own_feed'), null);
  await rs.publish({ handle: 'own_feed', token });
  assert.equal(rs.feedOf('own_feed'), null, 'publishing again starts with no channel');
});

test('a key\'s feed can carry bettor records, up to the cap, kept on the feed', async () => {
  const store = memStore();
  const ks = A.createKeyStore({ store, random: n => Buffer.alloc(n, 3) });
  const { key } = await ks.create({ name: 'x', who: 'w' });
  assert.equal(await ks.setFeedRecords(key, { handles: ['a_b'] }), null, 'no Discord feed yet');
  await ks.setFeed(key, { hookId: '1', sealed: { plain: 'u' } });
  await ks.setFeedRecords(key, { handles: ['a_b', 'a_b', ...Array.from({ length: 20 }, (_, i) => `h_${i}`)], results: false });
  const f = ks.feeds()[0].feed;
  assert.equal(f.handles.length, A.FEED_HANDLES);
  assert.equal(f.results, false);
  assert.equal(ks.feedsFor('a_b').length, 1);
  assert.equal(ks.feedsFor('nobody').length, 0);
});
