const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreboard, score, tStat } = require('../results');

const tail = (i, o = {}) => ({ id: `t${i}`, status: 'settled', recordedAt: new Date().toISOString(), grade: 'A', category: 'sports', units: 1, ...o });

test('t-stat needs spread and 3 values', () => {
  assert.equal(tStat([1, 2]), null);
  assert.equal(tStat([1, 1, 1]), null);
  assert.ok(tStat([0.1, 0.12, 0.08, 0.11]) > 2);
});

test('verdicts: proven on CLV, avoid when losing, early on small samples', () => {
  const good = Array.from({ length: 55 }, (_, i) => ({ profit: i % 2 ? 1 : -1, staked: 1, clv: 0.04 + (i % 3) * 0.01 }));
  assert.equal(score(good).verdict, 'proven');
  const bad = Array.from({ length: 10 }, (_, i) => ({ profit: -1, staked: 1, clv: -0.03 - (i % 2) * 0.01 }));
  assert.equal(score(bad).verdict, 'avoid');
  assert.equal(score(good.slice(0, 5)).verdict, 'early');
  const clvOnly = Array.from({ length: 9 }, (_, i) => ({ profit: null, staked: 0, clv: i % 3 ? 0.02 : -0.01 }));
  assert.equal(score(clvOnly).verdict, 'promising');
});

test('scoreboard cuts plays per source and ranks proven first', () => {
  const recs = [
    ...Array.from({ length: 52 }, (_, i) => tail(i, { grade: 'A', category: 'sports', profit: i % 2 ? 0.9 : -1, clv: 0.05 + (i % 4) * 0.01 })),
    ...Array.from({ length: 10 }, (_, i) => tail(100 + i, { grade: 'B', category: 'politics', profit: -1, clv: -0.04 - (i % 2) * 0.01 })),
    tail(200, { status: 'open' }),
  ];
  const edges = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, status: 'closed', flaggedAt: new Date().toISOString(), sport: 'cs2', book: 'kalshi', market: 'match', clv: 3 + i }));
  const b = scoreboard({ tail: recs, esportsEdges: edges });
  assert.equal(b.sources.tail.open, 1);
  assert.equal(b.sources.tail.overall.n, 62);
  assert.equal(b.sources.esportsEdges.overall.avgClv, 0.045);
  const first = b.plays[0];
  assert.equal(first.verdict, 'proven');
  assert.equal(first.source, 'tail');
  const avoid = b.plays.find(p => p.play === 'B grade · politics');
  assert.equal(avoid.verdict, 'avoid');
  assert.equal(b.plays.at(-1).verdict, 'avoid');
  assert.ok(b.plays.some(p => p.source === 'esportsEdges' && p.play === 'cs2 · kalshi'));
});

test('days filter drops old records', () => {
  const old = tail(1, { recordedAt: '2020-01-01T00:00:00Z', profit: 1, clv: 0.1 });
  const b = scoreboard({ tail: [old] }, { sinceMs: Date.now() - 86400e3 });
  assert.equal(b.sources.tail.overall.n, 0);
});

test('exchange value: the delayed grade is compared with the same bets at the alert, and $100 through the book decides once it has 8', () => {
  const b = i => ({ id: `x${i}`, status: 'closed', flaggedAt: new Date().toISOString(), source: 'xvalue', sport: 'nfl', book: 'kalshi', market: 'moneyline',
    clv: i < 10 ? 3 : -9, ...(i < 10 ? { execClv: 2.5, execSizedClv: -1 + (i % 3) * 0.1 } : {}) });
  const s = scoreboard({ exchangeValue: Array.from({ length: 14 }, (_, i) => b(i)) }).sources.exchangeValue.overall;
  assert.equal(s.execN, 10);
  assert.equal(s.execAlertClv, 0.03, 'only the 10 graded at +2 min');
  assert.equal(s.sizedN, 10);
  assert.ok(s.sizedClv < 0);
  assert.equal(s.verdict, 'avoid', 'the $100 grade decides, not the +2.5% at the best price');
});

// BetRivers-style main lines: one game each, results in line with the close
const mkMain = (n, book, o = {}) => Array.from({ length: n }, (_, i) => ({ id: `${book}${i}`, status: 'closed', flaggedAt: new Date().toISOString(), sport: 'nfl', book, market: 'spreads',
  event: `G${i}`, start: '2026-10-17T17:00:00Z', clv: 3 + (i % 3), outcome: i % 2 ? 'win' : 'loss', closeFair: 50, decimal: 1.95, ...o }));
const evPlay = (rec, by, play) => scoreboard({ ev: rec }).plays.find(p => p.source === 'ev' && p.by === by && p.play === play);

test('sportsbook plays: proven only as one kind on one book with 50 graded of its own; a pooled count never proves anything', () => {
  const rec = [...mkMain(30, 'draftkings'), ...mkMain(30, 'caesars'), ...mkMain(2, 'fanduel')];
  const b = scoreboard({ ev: rec });
  const all = b.plays.find(p => p.source === 'ev' && p.play === 'all');
  assert.equal(all.n, 62);
  assert.notEqual(all.verdict, 'proven', 'the pool is not proof');
  assert.match(all.provenNote, /^not proven yet: 62 graded, \+\d/);
  assert.notEqual(evPlay(rec, 'book+kind', 'draftkings · main line').verdict, 'proven', '30 of its own is under 50');
  assert.match(evPlay(rec, 'book+kind', 'draftkings · main line').provenNote, /not proven yet: 30 graded/);
  const full = mkMain(55, 'fanduel');
  assert.equal(evPlay(full, 'book+kind', 'fanduel · main line').verdict, 'proven');
  assert.equal(evPlay(full, 'book+kind', 'fanduel · main line').provenNote, undefined);
  for (const by of ['sport', 'book']) assert.notEqual(scoreboard({ ev: full }).plays.find(p => p.source === 'ev' && p.by === by).verdict, 'proven', `the pooled ${by} cut of the same 55`);
});

test('proven needs 50, counted in games, never a copied book, never with the close against it (10-16)', () => {
  const mk = (n, book, games = n) => Array.from({ length: n }, (_, i) => ({ id: `${book}${i}`, status: 'closed', flaggedAt: new Date().toISOString(), sport: 'nhl', book,
    market: 'shots_on_goal', event: `G${i % games}`, player: `P${i % games}`, start: '2026-10-17T00:00:00Z', clv: 3 + (i % 3) }));
  const book = (rec, b) => scoreboard({ ev: rec }).plays.find(p => p.source === 'ev' && p.by === 'book+kind' && p.play === b);
  // player props are not the proven kind, however many
  assert.equal(book(mk(55, 'betrivers'), 'betrivers · player prop').verdict, 'promising');
  assert.match(book(mk(55, 'betrivers'), 'betrivers · player prop').provenNote, /player prop lines are not the proven kind/);
  // 55 lines on 5 games: five bets of evidence
  const few = evPlay(mkMain(55, 'betrivers').map((r, i) => ({ ...r, event: `G${i % 5}` })), 'book+kind', 'betrivers · main line');
  assert.equal(few.verdict, 'promising');
  assert.match(few.provenNote, /^not proven yet: 5 graded/);
  // Action Network's copy of Hard Rock: the price was never checked at the book
  const hr = evPlay(mkMain(60, 'hardrock'), 'book+kind', 'hardrock · main line');
  assert.equal(hr.verdict, 'promising');
  assert.match(hr.provenNote, /60 graded, \+4\.0% CLV, price copied via Action Network/);
  // 21 gas locks, all won, the close against them: not proven
  const locks = Array.from({ length: 21 }, (_, i) => ({ status: 'graded', profit: 0.02 + (i % 3) * 0.005, clv: -0.06 - (i % 2) * 0.01, state: 'MD', price: 0.97 }));
  assert.notEqual(scoreboard({ gasLocks: locks }).plays.find(p => p.play === '96-98c').verdict, 'proven');
  const many = Array.from({ length: 60 }, (_, i) => ({ status: 'graded', profit: 0.02 + (i % 3) * 0.005, clv: -0.06 - (i % 2) * 0.01, state: 'MD', price: 0.97 }));
  assert.notEqual(scoreboard({ gasLocks: many }).plays.find(p => p.play === '96-98c').verdict, 'proven', 'winning while the close says otherwise');
});

test('the 7 plays that read proven on 10-24 are capped; BetRivers main lines still read proven', () => {
  // BetRivers main lines: the one that stays proven
  assert.equal(evPlay(mkMain(60, 'betrivers'), 'book+kind', 'betrivers · main line').verdict, 'proven');
  // pooled BetRivers (props and main lines together) with a good CLV: capped
  const pooled = [...mkMain(60, 'betrivers'), ...mkMain(60, 'betrivers', { player: 'X', id: undefined }).map((r, i) => ({ ...r, id: `p${i}`, event: `H${i}`, player: `P${i}` }))];
  const pb = scoreboard({ ev: pooled }).plays;
  assert.notEqual(pb.find(p => p.source === 'ev' && p.by === 'book' && p.play === 'betrivers').verdict, 'proven');
  assert.notEqual(pb.find(p => p.source === 'ev' && p.play === 'all').verdict, 'proven');
  // main lines whose results sit far under the close: capped with the shortfall note
  const losing = mkMain(60, 'betrivers', { outcome: 'loss' });
  const lp = evPlay(losing, 'book+kind', 'betrivers · main line');
  assert.equal(lp.verdict, 'promising');
  assert.match(lp.provenNote, /the close is in doubt/);
  // pick'em: PrizePicks pooled and the sharp-consensus kind with results under the close
  const sp = (n, kind, o = {}) => Array.from({ length: n }, (_, i) => ({ id: `s${kind}${i}`, kind, status: 'graded', outcome: i % 5 ? 'loss' : 'win', profit: i % 5 ? -1 : 0.9, closeEv: 4 + (i % 3), closeFair: 0.55, signalDecimal: 1.8,
    sport: 'NFL', player: `P${i}`, mkey: 'rec_yds', start: '2026-10-17T00:00:00Z', signalBook: 'PP', ...o }));
  const props = scoreboard({ sportsProps: [...sp(120, 'ev'), ...sp(120, 'sharp')] }).plays.filter(p => p.source === 'sportsProps');
  assert.equal(props.filter(p => p.verdict === 'proven').length, 0);
  assert.equal(props.find(p => p.by === 'book' && p.play === 'PrizePicks').verdict === 'proven', false);
  assert.equal(props.find(p => p.by === 'kind+book' && p.play === 'sharp consensus · PrizePicks').verdict, 'promising');
  // results only mildly under the close (not 1.5 sd): still not proven, pick'em legs have no proven kind
  const mild = scoreboard({ sportsProps: sp(166, 'sharp', { outcome: 'win', profit: 0.8, closeFair: 0.5 }).map((r, i) => i % 2 ? { ...r, outcome: 'loss', profit: -1 } : r) }).plays.filter(p => p.source === 'sportsProps');
  assert.equal(mild.filter(p => p.verdict === 'proven').length, 0);
  // fresh wallets: killed 10-24, capped even on ROI
  const fresh = Array.from({ length: 60 }, (_, i) => tail(i, { category: 'sports', venue: 'Kalshi', profit: 0.9, clv: 0.05 + (i % 4) * 0.01 }));
  const fp = scoreboard({ fresh }).plays.filter(p => p.source === 'fresh');
  assert.ok(fp.length >= 2);
  assert.equal(fp.filter(p => p.verdict === 'proven').length, 0);
  assert.match(fp[0].provenNote, /killed/);
  // gas locks 93-95c with a negative CLV and wins on ROI: not proven
  const gl = Array.from({ length: 95 }, (_, i) => ({ status: 'graded', profit: i % 3 ? 0.04 : -0.9, clv: -0.006 + (i % 2) * 0.001, state: 'MD', price: 0.94 }));
  assert.notEqual(scoreboard({ gasLocks: gl }).plays.find(p => p.play === '93-95c').verdict, 'proven');
});
