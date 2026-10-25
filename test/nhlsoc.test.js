const test = require('node:test');
const assert = require('node:assert');
const N = require('../nhlsoc');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');
const G = require('../sportgrade');
const { combineGraders } = require('../extragrade');
const freebooks = require('../freebooks');
const kambi = require('./fixtures/nhlsoc/kambi-liverpool-brighton.json');
const espn = require('./fixtures/nhlsoc/espn-astonvilla-mancity.json');

const soon = () => new Date(Date.now() + 3 * 3600e3).toISOString();
const cell = (line, over = null, under = null, o = {}) => ({ line, over, under, overOpen: true, underOpen: true, ...o });
const row = (sport, mkey, books, o = {}) => ({ key: `${sport}|x|${mkey}|d`, sport, player: 'X', mkey, market: mkey, startTime: soon(), books, ...o });

test('BetRivers soccer: player shots, shots on target, scorer and assist rungs, one-sided, first half and headers skipped', () => {
  const ev = N.kambiSoccerProps(kambi, Date.parse('2026-10-25T00:00:00Z'));
  assert.deepStrictEqual(ev.event, { id: 1028072739, home: 'Liverpool', away: 'Brighton', start: '2026-10-25T14:00:00.000Z' });
  const at = (who, mkey, line) => ev.props.find(p => p.player === who && p.mkey === mkey && p.line === line);
  assert.strictEqual(at('Cody Gakpo', 'shots_on_target', 0.5).over, -162);
  assert.strictEqual(at('Cody Gakpo', 'shots_on_target', 1.5).over, 260);
  assert.strictEqual(at('Virgil van Dijk', 'shots_attempted', 0.5).over, -115);
  assert.strictEqual(at('Cody Gakpo', 'goals', 0.5).over, 230);
  assert.strictEqual(at('Cody Gakpo', 'goals', 1.5).over, 1400);
  assert.strictEqual(at('Cody Gakpo', 'assists', 0.5).over, 270);
  assert.strictEqual(at('Cody Gakpo', 'goals_+_assists', 0.5).over, 120);
  // Gakpo's "Shots on Target - 1st Half" at +150 is another stat
  assert.ok(!ev.props.some(p => p.over === 150 && p.player === 'Cody Gakpo'));
  // a started match reads nothing
  assert.strictEqual(N.kambiSoccerProps(kambi, Date.parse('2026-10-25T15:00:00Z')), null);
  const idx = N.indexSoccer([ev]);
  const q = idx.get('SOCCER|codygakpo|shots_on_target');
  assert.strictEqual(q.length, 2);
  assert.ok(Math.abs(q[0].pOverMax - 162 / 262) < 1e-4);
});

test('NHL: priced only where Pinnacle hangs the app\'s number; 2 points past break-even flags nhs-pin', () => {
  // PrizePicks 3-pick power break-even 55.03%: Pinnacle Under 2.5 shots at 58% clears by 2.97 pts
  const r = row('NHL', 'shots_on_goal', { prizepicks: cell(2.5), underdog: cell(3.5, 1, 1) });
  const src = { pin: [{ line: 2.5, pOver: 0.42 }], books: [{ book: 'fanduel', line: 2.5, pOver: 0.44 }] };
  const { legs, plays } = N.rowPlays(r, src);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs.find(l => l.book === 'underdog').q.pinnacle, null);   // 3.5 isn't Pinnacle's number: no price
  assert.strictEqual(plays.length, 1);
  const p = plays[0];
  assert.strictEqual(p.kind, 'nhs-pin');
  assert.strictEqual(p.play.side, 'Under');
  assert.strictEqual(p.play.book, 'prizepicks');
  assert.strictEqual(p.play.be, 0.5503);
  assert.strictEqual(p.play.fair, 0.58);
  assert.ok(Math.abs(p.play.decimal - 1 / 0.5503) < 1e-3);
  assert.deepStrictEqual(p.play.sources, { pinnacle: 0.58, fanduel: 0.56 });
  // 1.9 points past break-even: not a flag
  assert.strictEqual(N.rowPlays(r, { pin: [{ line: 2.5, pOver: 0.431 }] }).plays.length, 0);
  // FanDuel alone never flags
  assert.strictEqual(N.rowPlays(r, { books: [{ book: 'fanduel', line: 2.5, pOver: 0.3 }] }).plays.length, 0);
});

test('NHL: Kalshi at the number flags nhs-kalshi when Pinnacle has nothing there; Pinnacle decides when both do', () => {
  const r = row('NHL', 'assists', { sleeper: cell(0.5, 2.2, 0.65) });
  // Sleeper Over 2.2x: break-even 45.5%; Kalshi 49%
  const k = N.rowPlays(r, { kalshi: new Map([[0.5, 0.49]]) }).plays;
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].kind, 'nhs-kalshi');
  assert.strictEqual(k[0].play.side, 'Over');
  // Pinnacle says 44% at the same number: no flag, Kalshi is not asked
  assert.strictEqual(N.rowPlays(r, { kalshi: new Map([[0.5, 0.49]]), pin: [{ line: 0.5, pOver: 0.44 }] }).plays.length, 0);
});

test('soccer: BetRivers\' one-sided Over backs only an Under, margin left in', () => {
  // Underdog Lower 0.5 goals at 0.8x: break-even 0.5623 / 0.8 = 70.3%; "To Score" +320 → P(no goal) >= 76.2%
  const r = row('SOCCER', 'goals', { underdog: cell(0.5, 2.5, 0.8) });
  const bound = [{ line: 0.5, pOverMax: 100 / 420 }];
  const { plays } = N.rowPlays(r, { bound });
  assert.strictEqual(plays.length, 1);
  assert.strictEqual(plays[0].kind, 'nhs-bound');
  assert.strictEqual(plays[0].play.side, 'Under');
  assert.ok(Math.abs(plays[0].play.fair - (1 - 100 / 420)) < 1e-4);
  // the Over is never backed by an upper bound, however long the price
  assert.ok(!plays.some(p => p.play.side === 'Over'));
  const over = N.rowPlays(row('SOCCER', 'goals', { underdog: cell(0.5, 9, 0.2) }), { bound: [{ line: 0.5, pOverMax: 0.9 }] }).plays;
  assert.strictEqual(over.length, 0);
  // a bound in another sport means nothing
  assert.strictEqual(N.rowPlays(row('NHL', 'goals', { underdog: cell(0.5, 2.5, 0.8) }), { bound }).plays.length, 0);
  // Kalshi's two-sided price beats the bound when it hangs the number: its
  // 69% Under is short of 72.3%, so the bound isn't asked; its 31% Over clears
  // the Higher at 2.5x (break-even 0.5623 / 2.5 = 22.5%)
  const kal = N.rowPlays(r, { bound, kalshi: new Map([[0.5, 0.31]]) }).plays;
  assert.deepStrictEqual(kal.map(p => [p.kind, p.play.side]), [['nhs-kalshi', 'Over']]);
});

test('close: each kind on its own source at its own number', () => {
  const src = { pin: [{ line: 2.5, pOver: 0.4 }], kalshi: new Map([[2.5, 0.45]]), bound: [{ line: 2.5, pOverMax: 0.5 }] };
  assert.strictEqual(N.closeAt('nhs-pin', 2.5, src), 0.4);
  assert.strictEqual(N.closeAt('nhs-pin', 3.5, src), null);
  assert.strictEqual(N.closeAt('nhs-kalshi', 2.5, src), 0.45);
  assert.strictEqual(N.closeAt('nhs-bound', 2.5, src), 0.5);
  assert.deepStrictEqual(N.sourcesAt(2.5, src), { pinnacle: 0.4, kalshi: 0.45, betriversOverMax: 0.5 });
});

test('the record: own id, own kind, every source\'s close kept, out of the headline', async () => {
  const store = createMemoryStore();
  let t = Date.now();
  const tr = createSportTracker({ store, now: () => t });
  const r = row('NHL', 'shots_on_goal', { prizepicks: cell(2.5) });
  const { plays } = N.rowPlays(r, { pin: [{ line: 2.5, pOver: 0.42 }] });
  const flagged = plays.map(p => ({ row: r, ...p }));
  // the same leg flagged on the consensus too keeps its own row
  flagged.push({ row: r, kind: 'sharp', play: { ...plays[0].play } });
  let pin = 0.42;
  const src = () => ({ pin: [{ line: 2.5, pOver: pin }] });
  const fairAt = (row, book, line, kind) => (kind.startsWith('nhs-') ? N.closeAt(kind, line, src()) : 0.42);
  const sourcesAt = (row, line, kind) => N.sourcesAt(line, src());
  await tr.record({ rows: [r], flagged, fairAt, sourcesAt });
  const all = await tr.list({ limit: 10 });
  assert.strictEqual(all.length, 2);
  const nhs = all.find(b => b.kind === 'nhs-pin');
  assert.ok(nhs.id.endsWith('|nhs-pin'));
  assert.strictEqual(nhs.be, 0.5503);
  pin = 0.38; t += 60e3;
  await tr.record({ rows: [r], flagged: [], fairAt, sourcesAt });
  t = Date.parse(r.startTime) + 1000;
  await tr.record({ rows: [r], flagged: [], fairAt, sourcesAt });
  const done = (await tr.list({ kind: 'nhs-pin' }))[0];
  assert.strictEqual(done.status, 'locked');
  assert.strictEqual(done.closeFair, 0.62);
  assert.deepStrictEqual(done.closeSources, { pinnacle: 0.62 });
  const sum = await tr.summary();
  assert.strictEqual(sum.byKind['nhs-pin'].signals, 1);
  assert.strictEqual(sum.overall.signals, 1);   // only the consensus row
  assert.strictEqual(sum.byNhs['nhs-pin|NHL|PP'].signals, 1);
});

test('coverage: each leg counted once, by source; flags by kind, sport and app', () => {
  const c = N.createCoverage();
  const r = row('NHL', 'shots_on_goal', { prizepicks: cell(2.5), underdog: cell(3.5, 1, 1) });
  const out = N.rowPlays(r, { pin: [{ line: 2.5, pOver: 0.42 }] });
  c.observe(r, out.legs, out.plays);
  c.observe(r, out.legs, out.plays);
  const s = c.summary();
  assert.deepStrictEqual(s.legs['NHL|prizepicks'], { legs: 1, priced: 1, pinnacle: 1, kalshi: 0, fanduel: 0, betrivers: 0, betriversOverMax: 0 });
  assert.strictEqual(s.legs['NHL|underdog'].priced, 0);
  assert.strictEqual(s.flags['nhs-pin|NHL|prizepicks'], 1);
});

test('soccer grading: ESPN match rosters, shots, shots on target, goals, assists, saves; an unused sub voids', () => {
  const players = G.parseSoccerRosters(espn);
  const pick = (player, mkey, line, side = 'Over') => ({ sport: 'SOCCER', player, mkey, signalLine: line, signalSide: side });
  assert.deepStrictEqual(G.gradeLeg(pick('Nicolas Jackson', 'goals', 1.5), players), { result: 2, outcome: 'win' });
  assert.deepStrictEqual(G.gradeLeg(pick('Erling Haaland', 'shots_on_target', 1.5), players), { result: 2, outcome: 'win' });
  assert.deepStrictEqual(G.gradeLeg(pick('Erling Haaland', 'shots_attempted', 3.5), players), { result: 3, outcome: 'loss' });
  assert.deepStrictEqual(G.gradeLeg(pick('John McGinn', 'goals_+_assists', 0.5), players), { result: 1, outcome: 'win' });
  assert.deepStrictEqual(G.gradeLeg(pick('Zion Suzuki', 'saves', 4.5), players), { result: 6, outcome: 'win' });
  assert.deepStrictEqual(G.gradeLeg(pick('Gianluigi Donnarumma', 'goals_against', 1.5, 'Under'), players), { result: 2, outcome: 'loss' });
  // an outfielder has no saves line
  assert.strictEqual(G.gradeLeg(pick('Erling Haaland', 'saves', 0.5), players), null);
  assert.deepStrictEqual(G.gradeLeg(pick('Marco Bizot', 'saves', 0.5), players), { void: 'did not play' });
  assert.ok(G.canGrade({ sport: 'SOCCER', mkey: 'shots_on_target' }));
  assert.ok(!G.canGrade({ sport: 'SOCCER', mkey: 'passes_attempted' }));
});

test('soccer grading: the leg\'s league is found by its match; SOCCER_RESULTS off grades nothing', async () => {
  const sb = { events: [{ id: '401879256', date: '2026-10-24T11:30Z', status: { type: { completed: true } },
    competitions: [{ competitors: [{ team: { displayName: 'Aston Villa', abbreviation: 'AVL' } }, { team: { displayName: 'Manchester City', abbreviation: 'MNC' } }] }] }] };
  const calls = [];
  const http = { get: async (url, { params }) => { calls.push(url); if (url.includes('/eng.1/scoreboard')) return { data: sb }; if (url.includes('/eng.1/summary')) return { data: espn }; return { data: { events: [] } }; } };
  const g = G.createSportsGrader({ http });
  const leg = { sport: 'SOCCER', player: 'Erling Haaland', team: 'Man City', matchTitle: 'Aston Villa', mkey: 'shots_on_target', signalLine: 1.5, signalSide: 'Over', startTime: '2026-10-24T11:30:00Z' };
  assert.deepStrictEqual(await g.grade(leg), { result: 2, outcome: 'win', eventId: '401879256' });
  assert.ok(calls[0].includes('soccer/eng.1'));
  const off = G.createSportsGrader({ http, soccer: false });
  assert.strictEqual(off.canGrade(leg), false);
  assert.strictEqual(await off.grade(leg), null);
  // goals: ESPN's box first, Kalshi only when the box has nothing
  let kalshiAsked = 0;
  const both = combineGraders(g, { canGrade: p => p.sport === 'SOCCER' && p.mkey === 'goals', grade: async () => { kalshiAsked++; return { result: 0, outcome: 'loss' }; } });
  assert.deepStrictEqual(await both.grade({ ...leg, mkey: 'goals', signalLine: 0.5 }), { result: 1, outcome: 'win', eventId: '401879256' });
  assert.strictEqual(kalshiAsked, 0);
  assert.deepStrictEqual(await both.grade({ ...leg, player: 'Nobody', mkey: 'goals', signalLine: 0.5 }), { result: 0, outcome: 'loss' });
  assert.strictEqual(kalshiAsked, 1);
});

test('FanDuel NHL "Total Goals" and "Total Saves" key as goals and saves', () => {
  const runner = (name, type, odds) => ({ runnerName: name, runnerStatus: 'ACTIVE', handicap: 0.5, result: { type }, winRunnerOdds: { americanDisplayOdds: { americanOddsInt: odds } } });
  const payload = { attachments: { markets: {
    1: { bettingType: 'MOVING_HANDICAP', marketStatus: 'OPEN', marketName: 'Timo Meier - Total Goals', runners: [runner('Timo Meier Over', 'OVER', 240), runner('Timo Meier Under', 'UNDER', -350)] },
    2: { bettingType: 'MOVING_HANDICAP', marketStatus: 'OPEN', marketName: 'Jeremy Swayman - Total Saves', runners: [{ ...runner('Jeremy Swayman Over', 'OVER', -110), handicap: 27.5 }, { ...runner('Jeremy Swayman Under', 'UNDER', -120), handicap: 27.5 }] },
  } } };
  const props = freebooks.parseFanDuelProps(payload);
  assert.deepStrictEqual(props.map(p => [p.player, p.mkey, p.line]), [['Timo Meier', 'goals', 0.5], ['Jeremy Swayman', 'saves', 27.5]]);
});

test('the soccer reader: league lists, then match pages; a 429 holds it', async () => {
  let t = Date.parse('2026-10-25T00:00:00Z');
  const lv = { events: [{ event: { id: 1028072739, state: 'NOT_STARTED', start: '2026-10-25T14:00:00Z' } }, { event: { id: 9, state: 'NOT_STARTED', start: '2026-10-29T14:00:00Z' } }] };
  const got = [];
  const http = { get: async url => { got.push(url); if (url.includes('/listView/football/england')) return { data: lv }; if (url.includes('/listView/')) { const e = new Error('nf'); e.response = { status: 404 }; throw e; } return { data: kambi }; } };
  const rd = N.createSoccerBooks({ http, now: () => t, wait: async () => {} });
  await rd.tick();
  assert.strictEqual(rd.state.counts.events, 1);   // the match four days out isn't read
  assert.ok(got.some(u => u.includes('/betoffer/event/1028072739.json')));
  assert.ok(!got.some(u => u.includes('/betoffer/event/9.json')));
  const q = rd.quotesFor({ sport: 'SOCCER', player: 'Cody Gakpo', mkey: 'goals', startTime: '2026-10-25T14:00:00Z' });
  assert.deepStrictEqual(q.map(x => x.line).sort(), [0.5, 1.5]);
  assert.deepStrictEqual(rd.quotesFor({ sport: 'SOCCER', player: 'Cody Gakpo', mkey: 'goals', startTime: '2026-10-26T14:00:00Z' }), []);
  // a 429 holds the reader and keeps the board it has
  t += 11 * 60e3;
  const blocked = { get: async () => { const e = new Error('slow down'); e.response = { status: 429, headers: { 'retry-after': '600' } }; throw e; } };
  const rd2 = N.createSoccerBooks({ http: blocked, now: () => t, wait: async () => {} });
  await rd2.tick();
  assert.ok(rd2.state.holdUntil >= t + 600e3);
});
