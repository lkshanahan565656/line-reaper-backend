const test = require('node:test');
const assert = require('node:assert/strict');
const { diffBoards, describe, webhookBody, createAlerter } = require('../alerts');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const later = new Date(NOW + 3 * 3600000).toISOString();
const pick = (over = {}) => ({
  sport: 'CS2', player: 'ZywOo', market: 'Kills on Maps 1+2', ppLine: 38.5, side: 'OVER',
  bestEv: 6.2, prob: 59, bestBook: 'PP', startTime: later, ...over,
});
const opts = (extra = {}) => ({ minEv: 5, moveMinEv: 2, cooldownMs: 30 * 60000, now: NOW, seen: new Map(), ...extra });

test('a new +EV pick is an edge; a weak one is not', () => {
  const ev = diffBoards([], [pick(), pick({ player: 'weak', bestEv: 2 })], opts());
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'edge');
  assert.equal(ev[0].player, 'ZywOo');
});

test('crossing the threshold fires; staying above does not', () => {
  const o = opts();
  assert.equal(diffBoards([pick({ bestEv: 3 })], [pick({ bestEv: 6 })], o)[0].kind, 'edge');
  assert.deepEqual(diffBoards([pick({ bestEv: 6 })], [pick({ bestEv: 7 })], opts()), []);
});

test('line moves report direction relative to our side', () => {
  const up = diffBoards([pick()], [pick({ ppLine: 40.5, bestEv: 3 })], opts());
  assert.equal(up.length, 2, 'a move, and the edge dropped below 5%');
  const move = up.find(e => e.kind === 'move');
  assert.equal(move.direction, 'with', 'line rose on an OVER: market agrees with us');
  assert.equal(move.from, 38.5);
  assert.equal(move.to, 40.5);
  assert.ok(up.find(e => e.kind === 'gone'));

  const down = diffBoards([pick({ side: 'UNDER' })], [pick({ side: 'UNDER', ppLine: 37.5 })], opts());
  assert.equal(down[0].direction, 'with', 'line fell on an UNDER');
  const away = diffBoards([pick({ side: 'UNDER' })], [pick({ side: 'UNDER', ppLine: 39.5 })], opts());
  assert.equal(away[0].direction, 'against');
  // moves on picks nobody cares about stay quiet
  assert.deepEqual(diffBoards([pick({ bestEv: 0 })], [pick({ bestEv: 1, ppLine: 40.5 })], opts()), []);
});

test('underdog-best picks track the underdog line', () => {
  const ev = diffBoards([pick({ bestBook: 'UD', udLine: 39.5 })], [pick({ bestBook: 'UD', udLine: 40.5 })], opts());
  assert.equal(ev[0].kind, 'move');
  assert.equal(ev[0].from, 39.5);
});

test('pulled picks and started matches', () => {
  const pulled = diffBoards([pick()], [], opts());
  assert.equal(pulled[0].kind, 'gone');
  assert.equal(pulled[0].removed, true);
  const started = new Date(NOW - 60000).toISOString();
  assert.deepEqual(diffBoards([], [pick({ startTime: started })], opts()), [], 'no alerts for live matches');
  assert.deepEqual(diffBoards([pick({ startTime: started })], [], opts()), []);
});

test('cooldown suppresses repeats of the same alert', () => {
  const seen = new Map();
  assert.equal(diffBoards([pick({ bestEv: 1 })], [pick()], opts({ seen })).length, 1);
  assert.equal(diffBoards([pick({ bestEv: 1 })], [pick()], opts({ seen, now: NOW + 60000 })).length, 0);
  assert.equal(diffBoards([pick({ bestEv: 1 })], [pick()], opts({ seen, now: NOW + 31 * 60000 })).length, 1);
});

test('messages read cleanly and the webhook body is capped', () => {
  const [e] = diffBoards([], [pick()], opts());
  assert.match(describe(e), /New edge \+6\.2%: ZywOo OVER 38\.5/);
  const many = Array.from({ length: 14 }, (_, i) => ({ ...e, player: `P${i}` }));
  const body = webhookBody(many);
  assert.equal(body.content.split('\n').length, 11);
  assert.match(body.content, /4 more/);
});

test('alerter primes on the first board, then notifies listeners and the webhook', async () => {
  let t = NOW;
  const sent = [];
  const a = createAlerter({ minEv: 5, now: () => t, send: async b => { sent.push(b); } });
  const got = [];
  const off = a.subscribe(e => got.push(e));
  assert.deepEqual(await a.onBoard([pick()]), [], 'a restart does not re-announce the slate');
  await a.onBoard([pick(), pick({ player: 'donk', bestEv: 8 })]);
  assert.equal(got.length, 1);
  assert.equal(got[0].player, 'donk');
  assert.equal(sent.length, 1);
  assert.equal(a.recent().length, 1);
  off();
  await a.onBoard([pick(), pick({ player: 'donk', bestEv: 8 }), pick({ player: 'm0NESY', bestEv: 9 })]);
  assert.equal(got.length, 1, 'unsubscribed');
  assert.equal(a.recent().length, 2);

  // a failing webhook never breaks the board refresh
  const b = createAlerter({ minEv: 5, now: () => t, send: async () => { throw new Error('down'); }, log: { warn() {} } });
  await b.onBoard([]);
  const ev = await b.onBoard([pick()]);
  assert.equal(ev.length, 1);
});
