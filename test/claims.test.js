// What a public page may claim (claims.js): only the close scoreboard's proven
// rows of the kinds that close on Pinnacle's own price, never a copied book,
// with whether Texans can bet it and whether profit is shown yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../claims');

const row = (o = {}) => ({ kind: 'ev', kindLabel: 'Main lines vs the sharp fair', book: 'betrivers', bookName: 'BetRivers', relayed: false, graded: 113, beatPct: 83, avgClv: 3.01, execN: 90, avgExecClv: 2.4, wins: 48, losses: 48, resultsUnits: -0.7, resultsExpUnits: 3.1, resultsZ: -0.38, mark: 'proven', ...o });

test('only proven main-line and pick\'em sharp-price rows at a book read direct become claims', () => {
  const board = { target: 50, overall: { graded: 1028, beatPct: 66.6, avgClv: 1.37 }, rows: [
    row(),
    row({ kind: 'bigmoney', kindLabel: 'Big money', graded: 169 }),           // proven on the board, not a claim kind
    row({ kind: 'alt', book: 'fanduel', bookName: 'FanDuel' }),              // alt lines never claim
    row({ book: 'hardrock', bookName: 'Hard Rock', relayed: true }),           // an Action Network copy
    row({ book: 'fanduel', bookName: 'FanDuel', mark: 'promising' }),
    row({ kind: 'props-sharp', book: 'prizepicks', bookName: 'PrizePicks', mark: 'early' }),
  ] };
  const out = C.publicClaims({ board, txBoard: { rows: [] }, alertBooks: new Set(['betrivers']) });
  assert.deepEqual(out.proven.map(p => `${p.kind}|${p.book}`), ['ev|betrivers']);
  const p = out.proven[0];
  assert.equal(p.texas, false, 'BetRivers is not a Texas venue');
  assert.equal(p.profitShown, false, 'a -0.7u record shows no profit');
  assert.equal(p.alerts, true);
  assert.equal(p.clv, 3.01);
  assert.equal(out.building, 2);
  assert.equal(out.overall.graded, 1028);
  assert.deepEqual(out.texas.proven, []);
});

test('Texas lists pick\'em apps and exchanges from venues.js, never Polymarket\'s international site', () => {
  const out = C.publicClaims({ board: { rows: [] }, txBoard: { rows: [] } });
  const pk = out.texas.pickem.map(v => v.key), ex = out.texas.exchanges.map(v => v.key);
  for (const k of ['prizepicks', 'underdog', 'sleeper', 'pick6']) assert.ok(pk.includes(k), k);
  for (const k of ['kalshi', 'polymarketus', 'gemini']) assert.ok(ex.includes(k), k);
  assert.ok(![...pk, ...ex].includes('polymarket'));
  assert.ok(out.texas.pickem.find(v => v.key === 'betr').why, 'an unread venue says why');
  assert.equal(out.proven.length, 0);
  assert.ok(out.labels.length >= 5 && out.labels.every(l => /model|research|not proven/.test(l.tag)));
});

test('a Texas venue proven on the TX board is a Texas claim, and the pick\'em label drops', () => {
  const pp = row({ kind: 'props-ev', kindLabel: "Pick'em sharp price", book: 'prizepicks', bookName: 'PrizePicks' });
  const out = C.publicClaims({ board: { rows: [pp] }, txBoard: { rows: [pp] } });
  assert.equal(out.proven[0].texas, true);
  assert.equal(out.texas.proven.length, 1);
  assert.ok(!out.labels.some(l => /Pick'em leg flags/.test(l.tool)));
});

test('profit is shown only when the units clear chance', () => {
  // sd = (u - e) / z: 20u with e 5 and z 1.5 → sd 10 → t 2
  assert.equal(C.profitOf({ resultsUnits: 20, resultsExpUnits: 5, resultsZ: 1.5 }).shown, true);
  assert.equal(C.profitOf({ resultsUnits: 8, resultsExpUnits: 5, resultsZ: 0.3 }).shown, false);
  assert.equal(C.profitOf({ resultsUnits: -0.7, resultsExpUnits: 3.1, resultsZ: -0.38 }).shown, false);
  assert.equal(C.profitOf({}).shown, false);
});

// The Results page (claims.publicRecord) labels each kind with the same test
// as the sales page, so the two cannot disagree.
test('publicRecord: proven only where the sales page claims it; everything else says why', () => {
  const board = { target: 50, overall: { graded: 1028, avgClv: 1.37 }, rows: [
    row(),
    row({ kind: 'bigmoney', kindLabel: 'Big money', graded: 169 }),
    row({ kind: 'alt', book: 'fanduel', bookName: 'FanDuel', mark: 'promising', note: 'Never proven: alt' }),
    row({ book: 'hardrock', bookName: 'Hard Rock', relayed: true, mark: 'promising' }),
    row({ book: 'fanduel', bookName: 'FanDuel', mark: 'promising', graded: 12 }),
    row({ kind: 'alt-model', mark: 'no sharp close' }),
    row({ kind: 'ev', book: 'gemini', bookName: 'Gemini', mark: 'proven', resultsUnits: 9, resultsExpUnits: 1, resultsZ: 2.5 }),
  ] };
  const rec = C.publicRecord({ board });
  const claims = C.publicClaims({ board, txBoard: { rows: [] } });
  const proven = rec.rows.filter(r => r.label === 'proven').map(r => `${r.kind}|${r.book}`);
  assert.deepEqual(proven.sort(), claims.proven.map(p => `${p.kind}|${p.book}`).sort(), 'the same proven kinds as the sales page');
  assert.equal(rec.proven, 2);
  const by = k => rec.rows.find(r => `${r.kind}|${r.book}` === k);
  assert.equal(by('bigmoney|betrivers').label, 'research', 'proven on the board, but not a kind the record may claim');
  assert.equal(by('alt|fanduel').why, 'Never proven: alt');
  assert.equal(by('ev|hardrock').label, 'copied book');
  assert.equal(by('ev|fanduel').label, 'building');
  assert.match(by('ev|fanduel').why, /12 of 50/);
  assert.equal(by('alt-model|betrivers').label, 'no sharp close');
  assert.equal(by('ev|betrivers').profitShown, false, 'proven, but -0.7u is no profit');
  assert.equal(by('ev|gemini').profitShown, true, 'proven and units clear chance');
  assert.equal(by('ev|gemini').texas, true);
  assert.equal(by('bigmoney|betrivers').profitShown, false);
  assert.match(rec.rule.text, /50 graded/);
  assert.ok(rec.labels.some(l => l.tag === 'model, not an edge'));
});
