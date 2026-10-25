// The esports board: the weekend recorder with LEAGUES=CS,LOL,VAL,DOTA,R6,COD
const test = require('node:test');
const assert = require('node:assert');
const NS = require('../nflsunday');
const ER = require('../esrecord');

const H = 3600e3;
const ST = '2026-10-25T15:00:00.000Z', START = Date.parse(ST);

test('app and book labels read as one esports key', () => {
  assert.strictEqual(ER.esKey('CS2'), 'CS');
  assert.strictEqual(ER.esKey('CS'), 'CS');
  assert.strictEqual(ER.esKey('LoL'), 'LOL');
  assert.strictEqual(ER.esKey('Dota2'), 'DOTA');
  assert.strictEqual(ER.esKey('VAL'), 'VAL');
  assert.strictEqual(ER.esKey('R6'), 'R6');
  assert.strictEqual(ER.esKey('NBA'), null);
  assert.ok(ER.isEsBoard(['CS', 'LOL', 'VAL', 'DOTA', 'R6', 'COD']));
  assert.ok(!ER.isEsBoard(['NBA', 'CFB']));
});

test('Kalshi esports tickers carry the start in US Eastern', () => {
  assert.strictEqual(ER.kalshiStart('KXCS2GAME-26OCT251130NAVIFAZE'), '2026-10-25T15:30:00.000Z');   // EDT
  assert.strictEqual(ER.kalshiStart('KXLOLGAME-26NOV031200T1GEN'), '2026-11-03T17:00:00.000Z');     // EST after Nov 1
  assert.strictEqual(ER.kalshiStart('nonsense'), '');
});

test('an app line is keyed by its own match, so two Bo1s on one day stay apart', () => {
  const lines = [
    { book: 'underdog', sport: 'CS', player: 'Jimpphat', team: 'ENCE', market: 'Kills on Map 1', line: 15.5, overMultiplier: 1, underMultiplier: 1, startTime: '2026-10-25T12:00:00Z', matchTitle: 'ENCE vs WBT', gameId: 11 },
    { book: 'underdog', sport: 'CS', player: 'Jimpphat', team: 'ENCE', market: 'Kills on Map 1', line: 16.5, overMultiplier: 1, underMultiplier: 1, startTime: '2026-10-25T14:00:00Z', matchTitle: 'ENCE vs HAVU', gameId: 12 },
  ];
  const e = ER.esAppEntries(lines, 'CS');
  assert.deepStrictEqual([...e.keys()], ['CS|jimpphat|k|1|g:underdog:11', 'CS|jimpphat|k|1|g:underdog:12']);
  assert.strictEqual(e.get('CS|jimpphat|k|1|g:underdog:11').m.mt, 'ENCE vs WBT');
  // no game id: start and title
  const pp = ER.esAppEntries([{ book: 'prizepicks', sport: 'CS', player: 'Jimpphat', team: 'ENCE', market: 'MAP 1 Kills', line: 15, startTime: '2026-10-25T08:00:00.000-04:00', matchTitle: 'WBT MAP 1' }], 'CS');
  assert.deepStrictEqual([...pp.keys()], ['CS|jimpphat|k|1|t:2026-10-25T12:00|wbtmap1']);
  assert.deepStrictEqual(pp.values().next().value.v, [15, null, null, 1, 1]);
});

test('Polymarket US and Kalshi match books become entries', () => {
  const us = ER.pmusEntries([{ slug: 'cs2-navi-faze', startTime: ST, markets: [{ slug: 'm1', sportsMarketType: 'esports_match_winner', bestBidQuote: { value: '0.55' }, bestAskQuote: { value: '0.58' }, feeCoefficient: 0.0695,
    marketSides: [{ team: { name: 'Natus Vincere' }, long: true }, { team: { name: 'FaZe Clan' }, long: false }] }] }], 'CS');
  assert.deepStrictEqual(us.get('U|CS|m1').v, [0.55, 0.58, 0.0695]);
  assert.deepStrictEqual(us.get('U|CS|m1').m.sides, ['Natus Vincere', 'FaZe Clan']);
  const k = ER.kalshiEntries([{ event_ticker: 'KXCS2GAME-26OCT251100NAVIFAZE', title: 'NAVI vs FaZe', markets: [
    { yes_sub_title: 'Natus Vincere', yes_bid_dollars: '0.54', yes_ask_dollars: '0.57' }, { yes_sub_title: 'FaZe Clan', yes_bid_dollars: '0.43', yes_ask_dollars: '0.46' }] }], 'CS');
  const row = k.get('K|CS|KXCS2GAME-26OCT251100NAVIFAZE');
  assert.strictEqual(row.m.st, '2026-10-25T15:00:00.000Z');
  assert.deepStrictEqual(row.v[0], ['Natus Vincere', 0.54, 0.57]);
});

// one CS match on two apps: ten players on Underdog (Map 1 kills and Maps 1-2
// kills), the same ten on PrizePicks with one player a full line lower;
// Pinnacle prices the match and its Map 1 rounds; Kalshi and Polymarket US the match
function board() {
  const recs = [];
  const teams = { NAVI: ['a1', 'a2', 'a3', 'a4', 'a5'], FaZe: ['b1', 'b2', 'b3', 'b4', 'b5'] };
  for (const [team, ps] of Object.entries(teams)) {
    for (const [i, p] of ps.entries()) {
      const m1 = 16.5 + i, m12 = 32.5 + i;
      const ud = (mkey, line, mk) => ({ t: START - 6 * H, s: 'underdog', k: `CS|${p}|${mkey}|g:underdog:9`, v: [line, 1, 1, 1, 1], m: { p, tm: team === 'NAVI' ? 'Natus Vincere' : 'FaZe Clan', st: ST, mt: 'Natus Vincere vs FaZe Clan', mk, mkey, sp: 'CS', gid: 9, bk: 'underdog' } });
      recs.push(ud('k|1', m1, 'Kills on Map 1'), ud('k|1-2', m12, 'Kills on Maps 1+2'));
      const ppLine = p === 'a1' ? m12 - 1.5 : m12;
      recs.push({ t: START - 6 * H, s: 'prizepicks', k: `CS|${p}|k|1-2|g:prizepicks:x`, v: [ppLine, null, null, 1, 1], m: { p, tm: team, st: ST, mt: team === 'NAVI' ? 'FaZe MAPS 1-2' : 'NAVI MAPS 1-2', mk: 'MAPS 1-2 Kills', mkey: 'k|1-2', sp: 'CS', gid: 'x', bk: 'prizepicks' } });
    }
  }
  // Pinnacle: NAVI (home) 60%, Map 1 rounds main 21.5 (pOver 0.5)
  recs.push({ t: START - 5 * H, s: 'pinnacle-es', k: 'M|CS|pin:1', v: { 'series|0|ml': [[0, 0.6, 1500]], 'rounds|1|total': [[-20.5, 0.62, 500], [-21.5, 0.5, 500], [-22.5, 0.4, 500]] }, m: { sp: 'CS', teams: ['Natus Vincere', 'FaZe'], st: ST } });
  recs.push({ t: START - 30 * 60e3, s: 'pinnacle-es', k: 'M|CS|pin:1', v: { 'series|0|ml': [[0, 0.64, 1500]], 'rounds|1|total': [[-21.5, 0.5, 500]] } });
  recs.push({ t: START - 5 * H, s: 'kalshi-es', k: 'K|CS|KX1', v: [['Natus Vincere', 0.58, 0.61], ['FaZe', 0.39, 0.42]], m: { sp: 'CS', teams: ['Natus Vincere', 'FaZe'], st: ST } });
  recs.push({ t: START - 5 * H, s: 'pmus-es', k: 'U|CS|m1', v: [0.57, 0.6, 0.07], m: { sp: 'CS', sides: ['FaZe Clan', 'Natus Vincere'], st: ST } });
  // BetRivers' Map 1 kill ladder for a1 at 16.5 (Underdog's number)
  recs.push({ t: START - 5 * H, s: 'betrivers', k: 'CS|a1|k|1', v: [[16.5, -120, 100]], m: { p: 'a1', sp: 'CS', st: ST, mkey: 'k|1' } });
  recs.push({ t: START - 30 * 60e3, s: 'betrivers', k: 'CS|a1|k|1', v: [[16.5, -140, 115]] });
  return recs;
}

test('legs carry every sharp on their match, at bet time and at the close', () => {
  const { series, meta } = NS.replay(board());
  const legs = ER.buildEsLegs(series, meta);
  assert.strictEqual(legs.length, 30);
  const a1 = legs.find(l => l.app === 'underdog' && l.player === 'a1' && l.mkey === 'k|1');
  assert.strictEqual(a1.sharp.bet.pinnacle.pTeam, 0.6);
  assert.strictEqual(a1.sharp.close.pinnacle.pTeam, 0.64);
  assert.deepStrictEqual(a1.sharp.bet.pinnacle.map1, { unit: 'rounds', line: 21.5, pOver: 0.5 });
  assert.strictEqual(a1.sharp.bet.kalshi.pTeam, 0.595);
  assert.strictEqual(a1.sharp.bet.pmus.pTeam, 0.415);   // NAVI is Polymarket US's short side here
  assert.strictEqual(a1.sharp.bet.brPlayer.exact, true);
  const b1 = legs.find(l => l.app === 'underdog' && l.player === 'b1' && l.mkey === 'k|1');
  assert.strictEqual(b1.sharp.bet.pinnacle.pTeam, 0.4);
  assert.ok(!b1.sharp.bet.brPlayer);
  // PrizePicks names only the opponent; its legs still find the match
  const pa1 = legs.find(l => l.app === 'prizepicks' && l.player === 'a1');
  assert.strictEqual(pa1.sharp.bet.pinnacle.pTeam, 0.6);
  // the two apps' legs of one player in one match share a tag
  const ua1 = legs.find(l => l.app === 'underdog' && l.player === 'a1' && l.mkey === 'k|1-2');
  assert.strictEqual(pa1.tag, ua1.tag);
});

test('pre-registered (a) and (c) are marked from bet-time lines only', () => {
  const { series, meta } = NS.replay(board());
  const legs = ER.buildEsLegs(series, meta);
  const pa1 = legs.find(l => l.app === 'prizepicks' && l.player === 'a1');
  assert.deepStrictEqual(pa1.cons, { line: 32.5, apps: 1, diff: -1.5 });
  const sides = ER.esSides(pa1);
  assert.ok(ER.PREREG['a-consensus'](pa1, sides.find(s => s.side === 'Over')));
  assert.ok(!ER.PREREG['a-consensus'](pa1, sides.find(s => s.side === 'Under')));
  assert.ok(!ER.PREREG['a-consensus-2'](pa1, sides.find(s => s.side === 'Over')));
  // (c): Underdog's Map 1 lines add to 2 × (16.5+…+20.5) = 185 kills = 27.2 rounds at 6.8 a round; Pinnacle 21.5 sits under
  const u = legs.find(l => l.app === 'underdog' && l.mkey === 'k|1');
  assert.deepStrictEqual(u.map1, { pinLine: 21.5, implied: 27.21, under: true, under5: true });
  assert.ok(ER.PREREG['c-map1-under'](u, { side: 'Under' }));
  assert.ok(!ER.PREREG['c-map1-under'](u, { side: 'Over' }));
  // Maps 1-2 legs are not Map 1 legs
  assert.ok(!legs.find(l => l.mkey === 'k|1-2').map1);
});

test('a result is the sum over the span; a 2-0 on a Maps 1-3 line counts the maps played', () => {
  assert.deepStrictEqual(ER.resultFromMaps({ maps: { 1: 18, 2: 20 }, complete: true }, 'Kills on Maps 1+2'), { result: 38 });
  assert.deepStrictEqual(ER.resultFromMaps({ maps: { 1: 18, 2: 20 }, complete: true }, 'MAPS 1-3 Kills'), { result: 38, partial: true });
  assert.deepStrictEqual(ER.resultFromMaps({ maps: { 1: 18 }, complete: false }, 'MAPS 1-2 Kills'), { pending: true });
  assert.ok(ER.resultFromMaps({ maps: { 1: 18 }, complete: true }, 'MAPS 1-2 Kills').void);   // a Bo1
  assert.ok(ER.resultFromMaps({ unavailable: 'did not play' }, 'MAP 1 Kills').void);
  assert.deepStrictEqual(ER.resultFromMaps(null, 'MAP 1 Kills'), { pending: true });
});

test('a whole lineup graded 0 is voided, never counted (the round-robin trap)', () => {
  const { series, meta } = NS.replay(board());
  const legs = ER.buildEsLegs(series, meta);
  const results = new Map();
  for (const l of legs) results.set(`${l.app}|${l.key}`, { result: l.app === 'underdog' && l.mkey === 'k|1' ? 0 : 40 });
  const n = ER.lineupGuard(legs, results);
  assert.strictEqual(n, 20);   // every Underdog leg of that match, both stats
  const any = legs.find(l => l.app === 'underdog' && l.mkey === 'k|1-2');
  assert.ok(results.get(`underdog|${any.key}`).void);
  assert.strictEqual(results.get(`prizepicks|${legs.find(l => l.app === 'prizepicks').key}`).result, 40);
});

test('the summary grades per game, stat, app and side, stacks and the pre-registered kinds', () => {
  const { series, meta } = NS.replay(board());
  const legs = ER.buildEsLegs(series, meta);
  const results = new Map();
  // every NAVI player beats every line, every FaZe player falls short
  for (const l of legs) results.set(`${l.app}|${l.key}`, { result: l.team.startsWith('N') ? l.bet.v[0] + 3 : l.bet.v[0] - 3 });
  const rep = ER.summarize(legs, results);
  assert.strictEqual(rep.counts.graded, 30);
  const ppOver = rep.byGameStatAppSide['CS|kills|prizepicks|Over'];
  assert.strictEqual(ppOver.n, 10);
  assert.strictEqual(ppOver.w, 5);
  // a1: PrizePicks 1.5 under Underdog → Over there (won), Underdog 1.5 over PrizePicks → Under there (lost)
  assert.strictEqual(rep.preregAll['a-consensus'].n, 2);
  assert.strictEqual(rep.preregAll['a-consensus'].w, 1);
  assert.strictEqual(rep.prereg['a-consensus|prizepicks'].w, 1);
  assert.strictEqual(rep.preregAll['c-map1-under'].n, 10);
  assert.strictEqual(rep.preregAll['c-map1-under'].w, 5);
  // BetRivers prices a1's Map 1 line: CLV is its no-vig move to the close
  const br = rep.sharpKinds['br-player-priced|underdog'];
  assert.strictEqual(br.n, 2);
  assert.ok(br.clvN === 2);
  // stacks: per app, match, stat and side, top three a team; none swept (FaZe all under, NAVI all over)
  const st = rep.stacks.all;
  assert.strictEqual(st.stacks, 6);   // Underdog Map 1 and Maps 1-2, PrizePicks Maps 1-2, each side
  assert.strictEqual(st.swept, 0);
  const row = rep.stacks.rows.find(r => r.app === 'prizepicks' && r.side === 'Over');
  assert.strictEqual(row.std, 37.5);
  assert.ok(row.repriced < row.std);   // CS kills move together: the app would pay less
  assert.strictEqual(rep.coverage.CS.legs, 30);
  assert.strictEqual(rep.coverage.CS.playerSharp, 1);
  assert.strictEqual(rep.coverage.CS.noSharp, 0);
  const txt = ER.reportText(rep);
  assert.match(txt, /Pre-registered/);
  assert.match(txt, /same-match 6-pick stacks: 0 swept of 6/);
});

test('a stack that sweeps pays the standard payout and the repriced one', () => {
  const { series, meta } = NS.replay(board());
  const legs = ER.buildEsLegs(series, meta);
  const results = new Map();
  for (const l of legs) results.set(`${l.app}|${l.key}`, { result: l.bet.v[0] + 3 });
  const rep = ER.summarize(legs, results);
  const pp = rep.stacks.byApp['CS|prizepicks|Over'];
  assert.strictEqual(pp.swept, 1);
  assert.strictEqual(pp.unitsStd, 36.5);
  assert.ok(pp.unitsRepriced < 36.5 && pp.unitsRepriced > 0);
});

test('legs with no grader are counted apart (R6, fantasy)', () => {
  const recs = [{ t: START - 6 * H, s: 'underdog', k: 'R6|p|k|1-2|g:underdog:3', v: [12.5, 1, 1, 1, 1], m: { p: 'p', tm: 'A', st: ST, mt: 'A vs B', mk: 'Kills on Maps 1+2', mkey: 'k|1-2', sp: 'R6' } },
    { t: START - 6 * H, s: 'underdog', k: 'LOL|q|x:fantasypoints|1-3|g:underdog:4', v: [40.5, 1, 1, 1, 1], m: { p: 'q', tm: 'C', st: ST, mt: 'C vs D', mk: 'Fantasy Points on Maps 1+2+3', mkey: 'fp|1-3', sp: 'LOL' } }];
  const { series, meta } = NS.replay(recs);
  const legs = ER.buildEsLegs(series, meta);
  assert.strictEqual(legs.find(l => l.sport === 'LOL').stat, null);
  const results = new Map(legs.map(l => [`${l.app}|${l.key}`, { skip: true }]));
  assert.strictEqual(ER.summarize(legs, results).counts.noGrader, 2);
});

// DK Pick6 (pre-registered 10-25): one LoL match on Pick6 and PrizePicks, Kalshi
// pricing T1 at 80%; PrizePicks' Faker line a full kill above Pick6's
function p6board() {
  const recs = [];
  const teams = { T1: ['faker', 'oner', 'doran', 'peyz', 'keria'], DK: ['showmaker', 'lucid', 'siwoo', 'smash', 'career'] };
  for (const [team, ps] of Object.entries(teams)) {
    for (const [i, p] of ps.entries()) {
      const line = 2.5 + i;
      recs.push({ t: START - 6 * H, s: 'pick6', k: `LOL|${p}|k|1|g:pick6:77`, v: [line, p === 'doran' ? 0.9 : 1, 1, 1, 1], m: { p, tm: team, st: ST, mt: 'DK @ T1', mk: 'MAP 1 Kills', mkey: 'k|1', sp: 'LOL', gid: 77, bk: 'pick6' } });
      recs.push({ t: START - 6 * H, s: 'prizepicks', k: `LOL|${p}|k|1|g:prizepicks:y`, v: [p === 'faker' ? line + 1 : line, null, null, 1, 1], m: { p, tm: team, st: ST, mt: team === 'T1' ? 'DK MAP 1' : 'T1 MAP 1', mk: 'MAP 1 Kills', mkey: 'k|1', sp: 'LOL', gid: 'y', bk: 'prizepicks' } });
    }
  }
  recs.push({ t: START - 5 * H, s: 'kalshi-es', k: 'K|LOL|KX2', v: [['T1', 0.79, 0.81], ['Dplus KIA', 0.19, 0.21]], m: { sp: 'LOL', teams: ['T1', 'Dplus KIA'], st: ST } });
  return recs;
}

test('Pick6: a leg off the other apps, and kill legs by the match price', () => {
  const { series, meta } = NS.replay(p6board());
  const legs = ER.buildEsLegs(series, meta);
  const faker = legs.find(l => l.app === 'pick6' && l.player === 'faker');
  assert.deepStrictEqual(faker.cons, { line: 3.5, apps: 1, diff: -1 });
  assert.strictEqual(ER.teamPrice(faker), 0.8);
  const over = ER.esSides(faker).find(s => s.side === 'Over'), under = ER.esSides(faker).find(s => s.side === 'Under');
  assert.ok(ER.P6_PREREG['p6-consensus'](faker, over));
  assert.ok(!ER.P6_PREREG['p6-consensus'](faker, under));
  assert.ok(ER.P6_PREREG['p6-fav-over'](faker, over));
  const smash = legs.find(l => l.app === 'pick6' && l.player === 'smash');
  assert.strictEqual(ER.teamPrice(smash), 0.2);
  assert.ok(ER.P6_PREREG['p6-dog-under'](smash, ER.esSides(smash).find(s => s.side === 'Under')));
  // PrizePicks' own off line is not a Pick6 test
  const ppFaker = legs.find(l => l.app === 'prizepicks' && l.player === 'faker');
  assert.ok(!ER.P6_PREREG['p6-consensus'](ppFaker, ER.esSides(ppFaker).find(s => s.side === 'Under')));
  const cov = ER.p6Coverage(legs);
  assert.strictEqual(cov.legs, 10);
  assert.strictEqual(cov.paired, 10);
  assert.strictEqual(cov.offOne, 1);
  assert.deepStrictEqual(cov.withApp, { prizepicks: 10 });
  assert.strictEqual(cov.fav70, 5);
  assert.strictEqual(cov.dog30, 5);
});

test('Pick6 stacks pay its read 6-pick table, the 5-of-6 floor too, and repriced', () => {
  const { series, meta } = NS.replay(p6board());
  const legs = ER.buildEsLegs(series, meta);
  const results = new Map();
  // T1 all over; DK all over but one of its top three (smash, line 5.5) short: Over stack 5 of 6, Under stack 0 of 6
  for (const l of legs) results.set(`${l.app}|${l.key}`, { result: l.player === 'smash' ? l.bet.v[0] - 1 : l.bet.v[0] + 1 });
  const rep = ER.summarize(legs, results, { p6Payouts: { 6: { 5: 1.5, 6: 25 } } });
  const ps = rep.pick6.stacks;
  assert.strictEqual(ps.stacks, 2);
  assert.strictEqual(ps.swept, 0);
  assert.strictEqual(ps.fiveOfSix, 1);
  const o = ps.rows.find(r => r.side === 'Over');
  assert.strictEqual(o.hits, 5);
  assert.strictEqual(o.paid, 1.35);   // the 5-of-6 floor 1.5x times doran's 0.9 (T1's third-highest line)
  assert.ok(o.paidRepriced < o.paid);
  assert.ok(ps.expUnitsRepriced < 0);
  // Pick6's own tally and the report text
  assert.strictEqual(rep.pick6.kinds['p6-consensus'].n, 1);
  assert.strictEqual(rep.pick6.kinds['p6-consensus'].w, 1);
  assert.strictEqual(rep.pick6.kinds['p6-fav-over'].n, 5);
  assert.strictEqual(rep.pick6.kinds['p6-dog-under'].w, 1);
  const txt = ER.reportText(rep);
  assert.match(txt, /DK Pick6 \(pre-registered 10-25/);
  assert.match(txt, /p6-stack: 0 swept and 1 five-of-six of 2 graded/);
  // the existing stacks and kinds are untouched by Pick6's
  assert.ok(!rep.preregAll['p6-consensus']);
});
