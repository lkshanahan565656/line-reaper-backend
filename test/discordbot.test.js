// discordbot.js: Discord's Ed25519 signature check, the owner's env, the
// command list, the message builders (same public words as the API, link
// buttons only, no mentions) and the handler's ping, limits and deferral.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const B = require('../discordbot');

function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
const sign = (k, ts, body) => crypto.sign(null, Buffer.concat([Buffer.from(String(ts)), Buffer.from(body)]), k.privateKey).toString('hex');
const nowS = () => Math.floor(Date.now() / 1000);

test('a signature checks out only on the same bytes, key and a recent timestamp', () => {
  const k = pair(), other = pair();
  const key = B.publicKeyOf(k.hex);
  const body = '{"type":1}', ts = nowS();
  assert.ok(B.verify(key, { signature: sign(k, ts, body), timestamp: ts, body: Buffer.from(body) }));
  assert.ok(!B.verify(key, { signature: sign(k, ts, body), timestamp: ts, body: Buffer.from('{"type":2}') }), 'other bytes');
  assert.ok(!B.verify(key, { signature: sign(other, ts, body), timestamp: ts, body: Buffer.from(body) }), 'other key');
  assert.ok(!B.verify(key, { signature: sign(k, ts - 3600, body), timestamp: ts - 3600, body: Buffer.from(body) }), 'an hour old');
  assert.ok(!B.verify(key, { signature: 'zz', timestamp: ts, body: Buffer.from(body) }));
  assert.ok(!B.verify(null, { signature: sign(k, ts, body), timestamp: ts, body: Buffer.from(body) }));
  assert.equal(B.publicKeyOf('abc'), null);
});

test('the owner\'s bot is off until all three variables are set, and says what is wrong', () => {
  assert.deepEqual(B.ownerConfig({}), { on: false, appId: null, key: null, token: null, problems: [] });
  const k = pair();
  const part = B.ownerConfig({ DISCORD_APP_ID: '123456789012345678', DISCORD_PUBLIC_KEY: k.hex });
  assert.equal(part.on, false);
  assert.match(part.problems.join(' '), /DISCORD_BOT_TOKEN is empty/);
  const bad = B.ownerConfig({ DISCORD_APP_ID: 'abc', DISCORD_PUBLIC_KEY: 'xyz', DISCORD_BOT_TOKEN: 'short' });
  assert.equal(bad.problems.length, 3);
  const ok = B.ownerConfig({ DISCORD_APP_ID: '123456789012345678', DISCORD_PUBLIC_KEY: k.hex, DISCORD_BOT_TOKEN: `MTIzNDU2Nzg5MDEyMzQ1Njc4.Gab12C.${'x'.repeat(38)}` });
  assert.equal(ok.on, true);
  assert.ok(ok.key);
});

test('the commands: the five lookups and a Manage Server settings command, valid for Discord', () => {
  assert.deepEqual(B.COMMANDS.map(c => c.name), ['odds', 'props', 'moves', 'record', 'lines', 'settings']);
  for (const c of B.COMMANDS) {
    assert.match(c.name, /^[a-z]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 100, `${c.name} description ${c.description.length}`);
    for (const o of c.options || []) { assert.ok(o.description.length <= 100, `${c.name}.${o.name}`); assert.match(o.name, /^[a-z]{1,32}$/); }
  }
  assert.equal(B.COMMANDS.find(c => c.name === 'settings').default_member_permissions, '32');
  const r = B.registerRequest('123', 'tok');
  assert.equal(r.method, 'put');
  assert.equal(r.url, 'https://discord.com/api/v10/applications/123/commands');
  assert.equal(r.headers.Authorization, 'Bot tok');
  assert.match(B.installUrl('123'), /client_id=123&scope=applications\.commands$/);
  assert.match(B.commandsHash(), /^[0-9a-f]{16}$/);
});

const game = (over = {}) => ({ id: 'g1', league: 'nfl', leagueLabel: 'NFL', start: new Date(Date.now() + 3600e3).toISOString(), home: 'Home Hawks', away: 'Away Owls', markets: [
  { key: 'ml', label: 'Moneyline', point: null, sides: [
    { name: 'Home Hawks', label: 'Home Hawks', fair: 0.58, fairAmerican: -138, venues: [
      { venue: 'pinnacle', name: 'Pinnacle', american: -150, decimal: 1.667, ref: true },
      { venue: 'gemini', name: 'Gemini', american: -138, decimal: 1.725, best: true },
      { venue: 'draftkings', name: 'DraftKings', american: -145, decimal: 1.69, secondHand: true }] },
    { name: 'Away Owls', label: 'Away Owls', fair: 0.42, fairAmerican: 138, venues: [
      { venue: 'pinnacle', name: 'Pinnacle', american: 135, decimal: 2.35, ref: true },
      { venue: 'gemini', name: 'Gemini', american: 140, decimal: 2.4, best: true }] }] }], ...over });

test('/odds: best price, Pinnacle fair or price, copies marked, link buttons only and no mentions', () => {
  const m = B.oddsMessage({ q: 'hawks', games: [game()], withFair: true, state: 'TX', stateName: 'Texas', origin: 'https://lr.example', hasHistory: () => true });
  const e = m.embeds[0];
  assert.equal(e.title, 'Away Owls @ Home Hawks');
  assert.match(e.fields[0].value, /Home Hawks: best \*\*Gemini -138\*\* · Pinnacle fair -138 · also DraftKings -145 \(copy\)/);
  assert.match(e.description, /Texas resident/);
  assert.match(e.description, /not a proven edge/);
  assert.deepEqual(m.allowed_mentions, { parse: [] });
  assert.ok(m.components[0].components.every(b => b.style === 5 && /^https:\/\/lr\.example\//.test(b.url)), 'link buttons only');
  assert.match(e.image.url, /^https:\/\/lr\.example\/card\/move\.png\?game=g1&market=ml/);
  assert.match(e.footer.text, /takes no bets/);
  // no fair (paywall on): Pinnacle's own price, and says why
  const f = B.oddsMessage({ q: 'hawks', games: [game()], withFair: false, origin: 'https://lr.example' });
  assert.match(f.embeds[0].fields[0].value, /Pinnacle -150/);
  assert.doesNotMatch(f.embeds[0].fields[0].value, /fair/);
  assert.match(f.embeds[0].description, /server manager can set the state with \/settings/);
  // nothing found, or stale: an ephemeral note, not an old price
  assert.equal(B.oddsMessage({ q: 'zz', games: [] }).flags, B.EPHEMERAL);
  assert.match(B.oddsMessage({ q: 'hawks', games: [game()], stale: true }).embeds[0].description, /nothing is shown rather than an old price/);
});

test('/props, /moves, /lines and /record say only what the API says', () => {
  const p = B.propsMessage({ q: 'mahomes', player: { title: 'Patrick Mahomes', sub: 'NFL · KC' }, rows: [{ market: 'Pass Yards', books: { prizepicks: { line: 274.5 }, underdog: { line: 275.5 } }, pinnacle: { line: 274.5, pOver: 51.2 } }], withFair: true, origin: 'https://lr.example' });
  assert.match(p.embeds[0].fields[0].value, /PrizePicks 274\.5 · Underdog 275\.5\nPinnacle 274\.5: 51\.2% over, no-vig/);
  const pf = B.propsMessage({ q: 'mahomes', player: { title: 'P' }, rows: [{ market: 'Pass Yards', books: { prizepicks: { line: 274.5 } }, pinnacle: { line: 274.5, pOver: 51.2 } }], withFair: false });
  assert.doesNotMatch(pf.embeds[0].fields[0].value, /Pinnacle/);
  const mv = B.movesMessage({ rows: [{ kind: 'game', type: 'price', league: 'nfl', leagueLabel: 'NFL', gameId: 'g1', event: 'A @ B', market: 'ml', side: 'B', venueName: 'FanDuel', from: -110, to: -130, move: 4.1, unit: 'percentage points of win chance', followers: [{ status: 'moved' }, { status: 'old' }] }], origin: 'https://lr.example' });
  assert.match(mv.embeds[0].description, /FanDuel -110 → -130 \(4\.1 pts of win chance\)\. 1 followed, 1 still at the old price/);
  assert.match(mv.embeds[0].description, /information, not an edge/);
  const ln = B.linesMessage({ q: 'hawks', body: { rows: [{ kind: 'game', key: 'g1', market: 'ml', event: 'A @ B', league: 'nfl', reads: 12, start: null }], total: 1, windowDays: 30 }, origin: 'https://lr.example' });
  assert.match(ln.embeds[0].description, /\[A @ B · Moneyline \(NFL\)\]\(https:\/\/lr\.example\/lines\/game\/g1\?market=ml\): 12 reads/);
  // the record: proven only as RESULTS has it, profit only where shown
  const none = B.recordMessage({ card: { proven: [], notProven: 7, building: 5, losing: 2 }, origin: 'https://lr.example' });
  assert.match(none.embeds[0].description, /Nothing is proven yet/);
  const one = B.recordMessage({ card: { proven: [{ venueName: 'BetRivers', kindLabel: 'main lines', graded: 373, clvPct: 2.8, profitShown: false, units: null, texas: false }], notProven: 3, building: 2, losing: 1 } });
  assert.match(one.embeds[0].description, /BetRivers main lines: 373 graded, CLV \+2\.8% vs Pinnacle's close, profit not shown \(not a Texas venue\)/);
  assert.doesNotMatch(one.embeds[0].description, /\du\b/);
  const br = B.bettorMessage({ handle: 'logan', row: { handle: 'logan', onTime: 3, late: 40, proven: [], kinds: [{ name: 'PrizePicks', n: 3, label: 'too early' }] }, origin: 'https://lr.example' });
  assert.match(br.embeds[0].description, /3 picks logged before the start; 40 logged late \(shown on the record, never counted\)/);
  assert.match(br.embeds[0].image.url, /\/card\/record-logan\.png/);
  assert.equal(B.bettorMessage({ handle: 'nobody' }).flags, B.EPHEMERAL);
});

test('text is cleaned: no polymarket.com, no @everyone, markdown in names escaped', () => {
  const m = B.message({ title: 'x', description: 'see https://polymarket.com/event/a and @everyone' }, { links: [{ label: 'PM', url: 'https://polymarket.com/x' }, { label: 'OK', url: 'https://lr.example/a' }] });
  assert.doesNotMatch(m.embeds[0].description, /polymarket\.com|@everyone(?!\u200b)/);
  assert.equal(m.components[0].components.length, 1);
  const o = B.oddsMessage({ q: 'x', games: [game({ home: 'Home *Hawks*' })] });
  assert.match(o.embeds[0].description || '', /NFL/);
});

function signed(k, obj) {
  const body = JSON.stringify(obj), ts = nowS();
  return { signature: sign(k, ts, body), timestamp: String(ts), body: Buffer.from(body) };
}
const memSettings = () => { const m = new Map(); return { get: async (a, g) => m.get(`${a}|${g}`) || {}, set: async (a, g, p) => { const v = { ...(m.get(`${a}|${g}`) || {}), ...p }; m.set(`${a}|${g}`, v); return v; } }; };

test('the handler: PONG, signature refused, settings need Manage Server, limits, and a slow answer is deferred then edited in', async () => {
  const k = pair(), key = B.publicKeyOf(k.hex);
  const patched = [];
  let slow = false;
  const bot = B.createBot({ settings: memSettings(), deferAfterMs: 30, stateOf: s => (/^[A-Z]{2}$/.test(s) ? s : null), stateName: () => 'Texas',
    http: { patch: async (url, data) => { patched.push({ url, data }); return {}; } },
    handlers: { odds: async (o, ctx) => { if (slow) await new Promise(r => setTimeout(r, 80)); return B.message({ title: `odds ${o.game} ${ctx.settings.state || 'none'}` }); } } });
  assert.equal((await bot.handle({ key, appId: 'a1', signature: '00', timestamp: '1', body: Buffer.from('{}') })).status, 401);
  assert.deepEqual((await bot.handle({ key, appId: 'a1', ...signed(k, { type: 1 }) })).body, { type: 1 });
  const cmd = (name, options, extra = {}) => ({ type: 2, application_id: 'a1', token: 'tok', guild_id: 'g1', member: { user: { id: 'u1' }, permissions: '0' }, data: { name, options }, ...extra });
  let r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('odds', [{ name: 'game', value: 'hawks' }])) });
  assert.equal(r.body.type, 4);
  assert.equal(r.body.data.embeds[0].title, 'odds hawks none');
  r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('settings', [{ name: 'state', value: 'tx' }])) });
  assert.match(r.body.data.embeds[0].description, /Only someone with Manage Server/);
  r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('settings', [{ name: 'state', value: 'tx' }], { member: { user: { id: 'u1' }, permissions: '32' } })) });
  assert.match(r.body.data.embeds[0].description, /State: Texas \(TX\)/);
  assert.equal(r.body.data.flags, B.EPHEMERAL);
  r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('odds', [{ name: 'game', value: 'hawks' }])) });
  assert.equal(r.body.data.embeds[0].title, 'odds hawks TX', 'the server\'s state reaches the command');
  r = await bot.handle({ key, appId: 'a1', limit: async () => B.message({ title: 'Over the limit' }, { ephemeral: true }), ...signed(k, cmd('odds', [{ name: 'game', value: 'x' }])) });
  assert.equal(r.body.data.embeds[0].title, 'Over the limit');
  slow = true;
  r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('odds', [{ name: 'game', value: 'slow' }])) });
  assert.equal(r.body.type, 5, 'deferred');
  await r.followup;
  assert.equal(patched.length, 1);
  assert.equal(patched[0].url, 'https://discord.com/api/v10/webhooks/a1/tok/messages/@original');
  assert.equal(patched[0].data.embeds[0].title, 'odds slow TX');
  r = await bot.handle({ key, appId: 'a1', ...signed(k, cmd('nope', [])) });
  assert.match(r.body.data.embeds[0].description, /answers \/odds/);
  const s = bot.stats();
  assert.equal(s.pings, 1);
  assert.equal(s.badSignature, 1);
  assert.equal(s.deferred, 1);
});

test('register: Discord\'s answer becomes a plain reason, never the token', async () => {
  const ok = B.createBot({ http: { put: async () => ({ data: B.COMMANDS }) } });
  assert.deepEqual(await ok.register('1', 'secret-token'), { ok: true, count: B.COMMANDS.length });
  const no = B.createBot({ http: { put: async () => { throw Object.assign(new Error('x'), { response: { status: 401 } }); } } });
  const r = await no.register('1', 'secret-token');
  assert.equal(r.ok, false);
  assert.match(r.why, /turned the bot token away/);
  assert.doesNotMatch(JSON.stringify(r), /secret-token/);
});
