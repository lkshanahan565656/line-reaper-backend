// My state (venuestates.js + venues.js): who can use which venue, state by
// state, each entry with a source and a date; unknown is never "legal".
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../venuestates');
const V = require('../venues');

const CODES = Object.keys(D.JURISDICTIONS);

test('every state and DC, and every entry names a source with a date', () => {
  assert.equal(CODES.length, 51);
  for (const [v, row] of Object.entries(D.TABLE)) {
    assert.ok(['yes', 'no', 'unknown'].includes(row.default.s), v);
    if (row.default.s !== 'unknown') assert.ok(D.SOURCES[row.default.src], `${v} default has a source`);
    for (const [st, e] of Object.entries(row.states)) {
      assert.ok(D.JURISDICTIONS[st], `${v}: ${st} is a state`);
      assert.ok(['yes', 'no', 'unknown'].includes(e.s), `${v} ${st}`);
      assert.ok(D.SOURCES[e.src], `${v} ${st} has a source`);
    }
  }
  for (const [id, s] of Object.entries(D.SOURCES)) {
    assert.match(s.dated, /^\d{4}(-\d{2}){0,2}$/, `${id} dated`);
    assert.match(s.read, /^\d{4}-\d{2}-\d{2}$/, `${id} read`);
  }
});

test('the venues the brief names are all in the table', () => {
  for (const v of ['kalshi', 'polymarketus', 'gemini', 'prizepicks', 'underdog', 'sleeper', 'pick6', 'fanduel', 'betrivers']) assert.ok(D.TABLE[v], v);
});

test('Texas: the pick\'em apps and CFTC exchanges are legal, no sportsbook is', () => {
  const tx = V.stateInfo('TX');
  const keys = tx.venues.map(v => v.key);
  for (const k of ['prizepicks', 'underdog', 'sleeper', 'pick6', 'kalshi', 'polymarketus', 'gemini']) assert.ok(keys.includes(k), k);
  for (const k of ['fanduel', 'betrivers', 'draftkings', 'betmgm']) assert.equal(V.legalIn('TX')(k), false, k);
  assert.equal(V.statusIn('TX', 'draftkings').status, 'no');
  assert.ok(tx.noBooks);
  assert.match(tx.note, /No sportsbook is legal in Texas/);
  assert.ok(tx.venues.find(v => v.key === 'betr').why, 'a legal venue we cannot read says why');
});

test('unknown is never legal, and a pair is only as good as its worse half', () => {
  assert.equal(V.statusIn('MA', 'kalshi').status, 'unknown');
  assert.equal(V.legalIn('MA')('kalshi'), false);
  assert.equal(V.statusIn('NV', 'kalshi').status, 'no');
  assert.equal(V.statusOf('TX', 'PrizePicks + Kalshi'), 'yes');
  assert.equal(V.statusOf('NV', 'PrizePicks + Kalshi'), 'no');
  assert.equal(V.statusOf('MA', 'PrizePicks + Kalshi'), 'unknown');
  // a venue nobody looked up outside Texas is unknown, not legal, and stays off the "not sure" list
  assert.equal(V.statusIn('OH', 'betr').status, 'unknown');
  assert.ok(!V.stateInfo('OH').unknown.some(v => v.key === 'betr'));
  // no state: everything passes, as before
  assert.equal(V.legalIn('')('anything'), true);
  assert.equal(V.legalIn('ZZ')('fanduel'), true);
  assert.equal(V.stateInfo('ZZ'), null);
});

test('sportsbooks follow their own state lists', () => {
  assert.equal(V.legalIn('NJ')('fanduel'), true);
  assert.equal(V.legalIn('NJ')('betrivers'), true);
  assert.equal(V.legalIn('CA')('fanduel'), false);
  assert.equal(V.legalIn('DE')('betrivers'), true);
  assert.equal(V.legalIn('DE')('fanduel'), false);
  assert.match(V.stateInfo('NJ').note, /FanDuel, BetRivers/);
});

test('polymarket.com, Pinnacle and offshore books are never a US venue', () => {
  for (const st of CODES) for (const v of ['polymarket', 'pinnacle', 'matchbook', 'bovada']) assert.equal(V.statusIn(st, v).status, 'no', `${v} ${st}`);
});

test('the list and the table cover every state, with counts', () => {
  const list = V.statesList();
  assert.equal(list.length, 51);
  assert.ok(list.find(x => x.state === 'TX').legal >= 7);
  const t = V.table();
  assert.equal(Object.keys(t.status.kalshi).length, 51);
  assert.equal(t.status.kalshi.TX, 'yes');
  assert.ok(t.sources.cbs.url.startsWith('https://'));
  assert.match(t.check, /check with the venue/);
});
