// The alert history (alertlog.js): every alert kept as sent, each bet it named
// graded through its tracker row on RESULTS' rule, nothing back-filled.
const test = require('node:test');
const assert = require('node:assert/strict');
const al = require('../alertlog');
const { createMemoryStore, betId } = require('../evtrack');
const { withPush } = require('../push');

const T0 = Date.parse('2026-10-27T12:00:00Z');
const START = '2026-10-27T23:00:00Z';

test('the log starts the day it first boots and keeps that date across boots', async () => {
  const store = createMemoryStore();
  let t = T0;
  const a = al.createAlertLog({ store, now: () => t });
  await a.ready;
  assert.equal(a.startedAt(), new Date(T0).toISOString());
  t += 86400e3;
  const b = al.createAlertLog({ store, now: () => t });
  await b.ready;
  assert.equal(b.startedAt(), new Date(T0).toISOString(), 'a second boot does not move the start');
});

test('an alert is kept with its lines (no links), title, kind, reach and items', async () => {
  const a = al.createAlertLog({ store: createMemoryStore(), now: () => T0 });
  const doc = await a.record({ text: 'Line one <https://polymarket.com/x>\nLine two https://kalshi.com/y\n', title: 'EV alerts', kind: 'ev', reached: { webhooks: 1, phones: 3 }, items: [{ tracker: 'ev', ref: 'g|A|betrivers' }] });
  assert.deepEqual(doc.lines, ['Line one', 'Line two']);
  assert.equal(doc.title, 'EV alerts');
  assert.deepEqual(doc.reached, { webhooks: 1, phones: 3 });
  assert.equal(doc.items.length, 1);
  assert.equal(await a.record({ text: '   ', title: 'X' }), null, 'an empty alert is not kept');
  assert.equal((await a.all()).length, 1, 'the start marker is not an alert');
});

test('withPush hands every sent alert to the log with its delivery counts, never the Startup note', async () => {
  const seen = [];
  const hook = { enabled: true, send: async () => 2 };
  const push = { send: async () => 5 };
  const w = withPush(hook, push, { onSent: x => seen.push(x) });
  assert.equal(await w.send('a', 'EV alerts', { items: [1] }), 2);
  await w.send('b', 'Startup');
  assert.equal(seen.length, 1);
  assert.deepEqual({ ...seen[0] }, { text: 'a', what: 'EV alerts', kind: 'ev', meta: { items: [1] }, webhooks: 2, phones: 5 });
  // a log that throws never stops the alert
  const w2 = withPush(hook, push, { onSent: () => { throw new Error('disk'); } });
  assert.equal(await w2.send('c', 'Steam'), 2);
});

const evRow = { group: 'nba|1|h2h', side: 'Celtics', book: 'betrivers', decimal: 2.1, price: 110, ev: 6, sport: 'nba', event: 'Lakers @ Celtics', market: 'h2h', start: START };

test('an EV alert bet is graded on its tracker row at the alert\'s own price, with the RESULTS label', () => {
  const it = al.evItem(evRow);
  assert.equal(it.tracker, 'ev');
  assert.equal(it.ref, betId(evRow));
  assert.equal(it.priceDecimal, 2.1);
  const row = { id: it.ref, status: 'closed', book: 'betrivers', source: 'pinnacle', start: START, decimal: 2.05, closeFair: 50, closeOk: true, clv: 2.5, pinClose: 49, pinCloseOk: true, outcome: 'win' };
  const labelOf = (kind, book) => (kind === 'ev' && book === 'betrivers' ? { label: 'proven', why: null, profitShown: false } : null);
  const g = al.gradeItem(it, { rows: { ev: new Map([[it.ref, row]]) }, labelOf, now: Date.parse(START) + 3600e3 });
  assert.equal(g.state, 'ok');
  assert.equal(g.clvPct, 5, 'CLV at 2.10 against a 50% close, not at the tracker\'s 2.05');
  assert.equal(g.pinClvPct, 2.9);
  assert.equal(g.result, 'win');
  assert.equal(g.units, 1.1);
  assert.equal(g.label, 'proven');
  assert.equal(g.profitShown, false, 'a profit only where RESULTS shows one');
  assert.match(g.closeOn, /sharp fair/);
});

test('a stale close is not graded, and a missing tracker row says so', () => {
  const it = al.evItem(evRow);
  const row = { id: it.ref, status: 'closed', book: 'betrivers', start: START, closeFair: 50, closeOk: false, outcome: 'loss' };
  const g = al.gradeItem(it, { rows: { ev: new Map([[it.ref, row]]) }, labelOf: () => ({ label: 'building', why: '3 of 50 graded.' }), now: Date.parse(START) + 1 });
  assert.equal(g.state, 'stale');
  assert.equal(g.clvPct, null);
  assert.equal(g.units, null);
  const none = al.gradeItem(it, { rows: { ev: new Map() }, now: Date.parse(START) + 1 });
  assert.equal(none.state, 'not tracked');
  assert.equal(none.label, al.LABEL_NONE);
  const open = al.gradeItem(it, { rows: { ev: new Map() }, now: T0 });
  assert.equal(open.state, 'open');
  assert.equal(open.label, 'not graded yet');
});

test('a pick\'em leg and an exchange value edge: no grade, and research on its own fair', () => {
  const leg = al.evItem({ ...evRow, dfs: true, decimal: null });
  assert.equal(leg.tracker, null);
  assert.equal(al.gradeItem(leg, { now: T0 }).label, al.LABEL_NONE);
  const e = { group: 'kx|g1', pick: 'Celtics', venue: 'kalshi', cost: 0.5, ev: 0.06, title: 'Lakers at Celtics', league: 'nba', start: START };
  const it = al.xvalueItem(e);
  assert.equal(it.ref, 'kx|g1|Celtics|kalshi');
  const row = { id: it.ref, status: 'closed', book: 'kalshi', start: START, closeFair: 52, closeOk: true };
  const g = al.gradeItem(it, { rows: { xvalue: new Map([[it.ref, row]]) }, now: Date.parse(START) + 1 });
  assert.equal(g.label, 'research');
  assert.equal(g.clvPct, 4);
  assert.equal(g.pinState, 'none kept');
  assert.match(g.closeOn, /not Pinnacle/);
});

test('the view: summary by label, masking for the free view, paging and hidden wallets', () => {
  const it = al.evItem(evRow);
  const docs = [
    { id: 'a3', type: 'alert', sentAt: '2026-10-27T13:00:00Z', title: 'Exchange arbs', kind: 'exchange', lines: ['arb'], items: [] },
    { id: 'a2', type: 'alert', sentAt: '2026-10-27T12:30:00Z', title: 'EV alerts', kind: 'ev', lines: ['Celtics +110'], items: [it] },
    { id: 'a1', type: 'alert', sentAt: '2026-10-26T09:00:00Z', title: 'Tail alerts', kind: 'tail', lines: ['wallet 0xhiddenwallet1'], items: [] },
  ];
  const row = { id: it.ref, status: 'closed', book: 'betrivers', start: START, closeFair: 50, closeOk: true, outcome: 'loss' };
  const labelOf = () => ({ label: 'proven', why: null, profitShown: false });
  const after = Date.parse(START) + 3600e3;
  const v = al.view(docs, { rows: { ev: new Map([[it.ref, row]]) }, labelOf, now: after, startedAt: '2026-10-26T00:00:00Z', hide: d => JSON.stringify(d.lines).includes('0xhiddenwallet1') });
  assert.equal(v.summary.alerts, 2, 'the hidden wallet\'s alert is left out');
  assert.equal(v.summary.graded, 1);
  assert.equal(v.summary.avgClvPct, 5);
  assert.equal(v.summary.units, -1);
  assert.equal(v.summary.profitShown, false);
  assert.deepEqual(v.summary.byLabel.map(r => r.label), ['proven', al.LABEL_NONE]);
  assert.match(v.alerts.find(a => a.id === 'a3').why, /no close to beat/);
  assert.match(v.note, /2026-10-26 00:00 UTC/);
  // free view before the start: the EV alert is a time and a title
  const early = al.view(docs, { rows: { ev: new Map() }, labelOf, now: T0 + 3600e3, full: false });
  const a2 = early.alerts.find(a => a.id === 'a2');
  assert.equal(a2.masked, true);
  assert.deepEqual(a2.lines, []);
  assert.equal(a2.items[0].pick, undefined, 'no pick before the start');
  assert.equal(early.alerts.find(a => a.id === 'a3').masked, true, 'an alert with no bets waits a day');
  assert.equal(early.alerts.find(a => a.id === 'a1').masked, false);
  // paging
  const p1 = al.view(docs, { now: after, limit: 1 });
  assert.equal(p1.alerts.length, 1);
  assert.equal(p1.next, '2026-10-27T13:00:00Z');
  const p2 = al.view(docs, { now: after, limit: 5, before: p1.next });
  assert.deepEqual(p2.alerts.map(a => a.id), ['a2', 'a1']);
  assert.equal(al.view(docs, { now: after, kind: 'ev' }).alerts.length, 1);
});

test('the page says when storing began and never shows a profit RESULTS does not', () => {
  const html = al.renderPage(al.view([], { now: T0, startedAt: '2026-10-27T06:00:00Z' }), { origin: 'https://x.example' });
  assert.match(html, /Alerts are kept from 2026-10-27 06:00 UTC/);
  assert.match(html, /No alert has been sent since storing began/);
  assert.match(html, /og:image" content="https:\/\/x.example\/card\/alerts.png/);
  const it = al.evItem(evRow);
  const row = { id: it.ref, status: 'closed', book: 'betrivers', start: START, closeFair: 50, closeOk: true, outcome: 'win' };
  const v = al.view([{ id: 'a', type: 'alert', sentAt: '2026-10-27T12:30:00Z', title: 'EV alerts', lines: ['<b>x</b>'], items: [it] }],
    { rows: { ev: new Map([[it.ref, row]]) }, labelOf: () => ({ label: 'building', profitShown: false }), now: Date.parse(START) + 1 });
  const h = al.renderPage(v);
  assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/, 'alert text is escaped');
  assert.match(h, /\+1\.1u\*/, 'units on a kind that is not proven wear the star');
});
