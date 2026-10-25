// UFC vs Pinnacle: the UFCStats CSVs, careers, name matching, the fight-length
// curve, the strike and takedown model, the board's legs and kinds, the record.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../ufcdata');
const M = require('../ufcmodel');
const B = require('../ufcboard');
const PX = require('../pinextra');
const ST = require('../sporttrack');
const { canonName } = require('../ev');

const EVENTS = 'EVENT,URL,DATE,LOCATION\nUFC 1,u,"October 17, 2026","Edmonton, Alberta, Canada"\nUFC 0,u,"January 05, 2026",x\n';
const RESULTS = 'EVENT,BOUT,OUTCOME,WEIGHTCLASS,METHOD,ROUND,TIME,TIME FORMAT,REFEREE,DETAILS,URL\n'
  + 'UFC 1 ,Ann Lee vs. Bea Ray,W/L,Women\'s Flyweight Bout,KO/TKO ,2,2:30,3 Rnd (5-5-5),R,d,http://f/1\n'
  + 'UFC 0,Ann Lee vs. Cid Moe,L/W,Women\'s Flyweight Bout,Decision - Unanimous ,3,5:00,3 Rnd (5-5-5),R,"a 29 - 28. b",http://f/0\n'
  + 'UFC 0,Bea Ray vs. Dee Fox,D,Women\'s Flyweight Bout,Overturned ,1,1:00,3 Rnd (5-5-5),R,d,http://f/2\n';
const STATS = 'EVENT,BOUT,ROUND,FIGHTER,KD,SIG.STR.,SIG.STR. %,TOTAL STR.,TD,TD %\n'
  + 'UFC 1,Ann Lee vs. Bea Ray,Round 1,Ann Lee,0,10 of 20,50%,x,1 of 2,50%\nUFC 1,Ann Lee vs. Bea Ray,Round 2,Ann Lee,1,7 of 9,70%,x,0 of 0,---\n'
  + 'UFC 1,Ann Lee vs. Bea Ray,Round 1,Bea Ray,0,5 of 30,17%,x,0 of 1,0%\nUFC 1,Ann Lee vs. Bea Ray,Round 2,Bea Ray,0,2 of 8,25%,x,0 of 0,---\n'
  + 'UFC 0,Ann Lee vs. Cid Moe,Round 1,Ann Lee,0,30 of 60,50%,x,2 of 3,66%\nUFC 0,Ann Lee vs. Cid Moe,Round 1,Cid Moe,0,40 of 70,57%,x,0 of 0,---\n';
const fights = () => D.buildFights({ events: D.parseCsv(EVENTS), results: D.parseCsv(RESULTS), stats: D.parseCsv(STATS) });

test('CSV: quoted cells, commas and doubled quotes', () => {
  const r = D.parseCsv('A,B\n"x, y","say ""hi"""\n1,\n');
  assert.deepEqual(r, [{ A: 'x, y', B: 'say "hi"' }, { A: '1', B: '' }]);
  assert.equal(D.isoDate('October 17, 2026'), '2026-10-17');
});

test('fights: minutes fought, winner, stats summed over rounds, oldest first', () => {
  const f = fights();
  assert.equal(f.length, 3);
  assert.equal(f[0].date, '2026-01-05');
  const last = f[2];
  assert.equal(last.T, 7.5);
  assert.equal(last.win, 0);
  assert.deepEqual(last.f.map(x => [x.sig, x.td]), [[17, 1], [7, 0]]);
  assert.equal(last.div, "Women's Flyweight");
});

test('careers count only fights before the date and skip overturned ones', () => {
  const f = fights();
  const before = D.careers(f, '2026-10-17');
  const ann = before.get(canonName('Ann Lee'));
  assert.deepEqual([ann.n, ann.mins, ann.sigL, ann.sigA, ann.tdL], [1, 15, 30, 40, 2]);
  assert.equal(before.get(canonName('Bea Ray')), undefined);   // her only earlier fight was overturned
  assert.equal(D.careers(f).get(canonName('Ann Lee')).n, 2);
});

test('names: the app spelling finds the UFCStats one', () => {
  const m = new Map([['SuYoung You', '2026'], ['Abusupiyan Magomedov', '2026'], ['Loneer Kavanagh', '2026']].map(([n, l]) => [canonName(n), { name: n, last: l }]));
  assert.equal(D.findCareer(m, 'Soyoung You').name, 'SuYoung You');
  assert.equal(D.findCareer(m, 'Abus Magomedov').name, 'Abusupiyan Magomedov');
  assert.equal(D.findCareer(m, 'Lone\'er Kavanagh').name, 'Loneer Kavanagh');
  assert.equal(D.findCareer(m, 'Zed Magomedov'), null);
});

test('grading off UFCStats: strikes, takedowns, fight time, finishes; overturned voids', () => {
  const f = fights();
  const leg = (mkey, line, side, player = 'Ann Lee') => D.gradeLeg(f, { player, mkey, signalLine: line, signalSide: side, startTime: '2026-10-17T23:00:00Z' });
  assert.equal(leg('significant_strikes', 16.5, 'Over').outcome, 'win');
  assert.equal(leg('significant_strikes', 7.5, 'Under', 'Bea Ray').outcome, 'win');
  assert.equal(leg('takedowns', 0.5, 'Over').outcome, 'win');
  assert.equal(leg('fight_time', 9.5, 'Under').outcome, 'win');
  assert.equal(leg('finishes', 0.5, 'Over').outcome, 'win');
  assert.equal(leg('2nd_round_finish', 0.5, 'Over').outcome, 'win');
  assert.equal(leg('1st_round_finish', 0.5, 'Over').outcome, 'loss');
  assert.equal(leg('finishes', 0.5, 'Over', 'Bea Ray').outcome, 'loss');
  assert.equal(D.gradeLeg(f, { player: 'Dee Fox', mkey: 'takedowns', signalLine: 0.5, signalSide: 'Over', startTime: '2026-01-05T23:00:00Z' }).void, 'no contest');
  assert.equal(leg('significant_strikes', 16.5, 'Over', 'Nobody Here'), null);
});

test('fight length: c reproduces Pinnacle\'s total, survival falls, distribution sums to 1', () => {
  const c = M.curveC(3, 2.5, 0.6);
  assert.ok(c > 0);
  assert.ok(Math.abs(M.survive(12.5, 3, c) - 0.6) < 1e-9);
  assert.ok(M.survive(5, 3, c) > M.survive(10, 3, c));
  const d = M.timeDist(3, c);
  assert.ok(Math.abs(d.reduce((a, b) => a + b.p, 0) - 1) < 1e-9);
  assert.ok(Math.abs(d[d.length - 1].p - M.survive(15 - 1e-9, 3, c)) < 1e-6);
  // a likelier Over means a longer fight
  assert.ok(M.curveC(3, 2.5, 0.7) < c);
  assert.equal(M.schedOf({ rounds: 3.5 }), 5);
  assert.equal(M.schedOf({ rounds: 2.5 }), 3);
  assert.equal(M.schedOf({ rounds: 2.5, mainEvent: true }), 5);
});

test('counts: the negative binomial tail is right at the edges and moves with the mean', () => {
  assert.equal(M.nbOver(-0.5, 3, 2), 1);
  assert.ok(Math.abs(M.nbOver(0.5, 2, 1e6) - (1 - Math.exp(-2))) < 1e-4);   // near Poisson: P(1+)
  assert.ok(Math.abs(M.nbOver(1.5, 2, 1e6) - (1 - 3 * Math.exp(-2))) < 1e-4);
  assert.ok(M.nbOver(20.5, 30, 3.5) > M.nbOver(20.5, 20, 3.5));
});

const pinFights = [{ id: 1, league: 'UFC', start: '2026-10-31T22:00:00.000Z', home: 'Ann Lee', away: 'Bea Ray', pHome: 0.7, rounds: 2.5, pOver: 0.55, over: -125, under: 105, mainEvent: false }];
const career = { n: 6, mins: 70, sigL: 350, sigA: 250, tdL: 6, tdA: 2, div: "Women's Flyweight" };
const opCareer = { n: 4, mins: 50, sigL: 180, sigA: 240, tdL: 1, tdA: 4, div: "Women's Flyweight" };
const careerOf = n => (canonName(n) === canonName('Ann Lee') ? career : canonName(n) === canonName('Bea Ray') ? opCareer : null);
const row = (mkey, books, player = 'Ann Lee') => ({ key: `MMA|${canonName(player)}|${mkey}`, sport: 'MMA', player, mkey, market: mkey, startTime: '2026-10-31T22:00:00Z', matchTitle: 'Lee vs Ray', books });

test('board: fight time exact at Pinnacle\'s own number, curve off it, the favoured side and kinds per app', () => {
  const rows = [row('fight_time', { prizepicks: { line: 12.5, over: null, under: null }, underdog: { line: 9.5, over: 1, under: 1 }, sleeper: { line: 12.5, over: 1.9, under: 1.8 } })];
  const [b] = B.board(rows, { fights: pinFights, careerOf });
  const pp = b.legs.find(l => l.app === 'prizepicks'), ud = b.legs.find(l => l.app === 'underdog');
  assert.equal(pp.kind, 'ufc-time'); assert.equal(ud.kind, 'ud-ufc-time');
  assert.equal(pp.side, 'Over'); assert.equal(pp.fair, 0.55); assert.equal(pp.exact, true); assert.equal(pp.clears, false);
  assert.ok(ud.fair > 0.55 && ud.side === 'Over' && ud.exact === false);
  const sl = b.legs.find(l => l.app === 'sleeper');
  assert.equal(sl.kind, 'sl-ufc-time'); assert.equal(sl.side, 'Over'); assert.equal(sl.clears, 0.55 > 1 / 1.9);
});

test('board: finishes off the moneyline; strikes off the rates; a debutant fighter is unpriced', () => {
  const rows = [row('finishes', { prizepicks: { line: 0.5 } }), row('significant_strikes', { prizepicks: { line: 30.5 }, underdog: { line: 40.5, over: 1, under: 1 } }),
    row('significant_strikes', { prizepicks: { line: 20.5 } }, 'Cy New')];
  const fs = [...pinFights, { ...pinFights[0], id: 2, home: 'Cy New', away: 'Dee Old' }];
  const out = B.board(rows, { fights: fs, careerOf });
  const fin = out.find(b => b.row.mkey === 'finishes').legs[0];
  const window = 1 - M.survive(15 - 1e-9, 3, M.curveC(3, 2.5, 0.55));
  assert.ok(Math.abs(fin.fair - (1 - 0.7 * window)) < 1e-3 || Math.abs(fin.fair - 0.7 * window) < 1e-3);
  assert.equal(fin.kind, 'ufc-fin');
  const st = out.find(b => b.row.mkey === 'significant_strikes');
  assert.equal(st.legs.length, 2);
  const lo = st.legs.find(l => l.app === 'prizepicks'), hi = st.legs.find(l => l.app === 'underdog');
  assert.equal(lo.kind, 'ufc-stat'); assert.equal(hi.kind, 'ud-ufc-stat');
  // the same price at a higher number: the Over is less likely
  const pLo = lo.side === 'Over' ? lo.fair : 1 - lo.fair, pHi = hi.side === 'Over' ? hi.fair : 1 - hi.fair;
  assert.ok(pLo > pHi);
  assert.ok(st.rates.me.sigPm === 5);
  assert.equal(out.filter(b => b.row.player === 'Cy New').length, 0);
});

test('board: no Pinnacle total, no price; another league is not matched; a spelling apart still finds the fight', () => {
  const noTotal = [{ ...pinFights[0], rounds: null, pOver: null }];
  assert.equal(B.board([row('fight_time', { prizepicks: { line: 12.5 } })], { fights: noTotal, careerOf }).length, 0);
  const spelled = row('fight_time', { prizepicks: { line: 12.5 } }, 'Anne Lee');
  spelled.matchTitle = 'Lee vs Ray';
  const [b] = B.board([spelled], { fights: pinFights, careerOf });
  assert.equal(b.fight.me, 'Ann Lee');
  assert.equal(b.fight.pWin, 0.7);
});

test('plays and the close: research kinds with Pinnacle\'s numbers kept; the close re-prices off the fight now', () => {
  const rows = [row('fight_time', { prizepicks: { line: 12.5 } })];
  const [p] = B.plays(rows, { fights: pinFights, careerOf });
  assert.equal(p.kind, 'ufc-time'); assert.equal(p.research, true);
  assert.equal(p.play.pinRounds, 2.5); assert.equal(p.play.pinOver, 0.55); assert.equal(p.play.sched, 3);
  const later = [{ ...pinFights[0], pOver: 0.6 }];
  assert.equal(B.closeAt(rows[0], 12.5, { fights: later, careerOf }).pOver, 0.6);
  assert.ok(B.KINDS.has('sl-ufc-stat') && B.KINDS.size === 12);
  assert.equal(B.appOfKind('ufc-stat'), 'prizepicks'); assert.equal(B.appOfKind('p6-ufc-fin'), 'pick6');
});

test('tally: per-leg break-evens, z and the 50 bar', () => {
  const legs = [...Array(60)].map((_, i) => ({ outcome: i < 45 ? 'win' : 'loss', signalDecimal: 1 / 0.5503 }));
  const t = B.tally(legs);
  assert.equal(t.n, 60); assert.equal(t.w, 45); assert.ok(t.z > 2); assert.equal(t.passes, true);
  assert.equal(B.tally(legs.slice(0, 30)).passes, false);
});

test('Pinnacle MMA fights: no-vig moneyline, main total nearest 50/50, the card\'s main event', () => {
  const start = (h) => new Date(Date.parse('2026-10-31T20:00:00Z') + h * 3600e3).toISOString();
  const mus = [...Array(6)].map((_, i) => ({ id: i + 1, type: 'matchup', league: { name: 'UFC' }, startTime: start(i * 0.5), participants: [{ alignment: 'home', name: `H${i}` }, { alignment: 'away', name: `A${i}` }] }));
  const mks = [{ matchupId: 1, type: 'moneyline', period: 0, prices: [{ designation: 'home', price: -150 }, { designation: 'away', price: 130 }] },
    { matchupId: 1, type: 'total', period: 0, prices: [{ designation: 'over', points: 2.5, price: -110 }, { designation: 'under', points: 2.5, price: -110 }] },
    { matchupId: 1, type: 'total', period: 0, isAlternate: true, prices: [{ designation: 'over', points: 1.5, price: -400 }, { designation: 'under', points: 1.5, price: 300 }] }];
  const out = PX.parseMmaFights(mus, mks, Date.parse('2026-10-30T00:00:00Z'));
  const f1 = out.find(f => f.id === 1);
  assert.equal(f1.rounds, 2.5); assert.ok(Math.abs(f1.pOver - 0.5) < 1e-9); assert.ok(f1.pHome > 0.55 && f1.pHome < 0.6);
  assert.equal(out.find(f => f.mainEvent).id, 6);
});

test('the record: UFC kinds keep their own ids, Pinnacle\'s raw close and stay out of the headline', () => {
  assert.ok(ST.UFC.has('ufc-time') && ST.UFC.has('sl-ufc-stat'));
  const t0 = Date.parse('2026-10-31T20:00:00Z');
  const lock = ST.ufcPinClose({ closePinAt: new Date(t0 - 20 * 60e3).toISOString(), signalPinRounds: 2.5, closePinRounds: 2.5, signalPinOver: 0.55, closePinOver: 0.6 }, t0);
  assert.equal(lock.closePinOk, true); assert.equal(lock.pinRoundsMove, 0); assert.equal(lock.pinOverMove, 0.05);
  const r = row('fight_time', { prizepicks: { line: 12.5 } });
  assert.ok(ST.idOf(r, { book: 'prizepicks', side: 'Over', line: 12.5 }, 'ufc-time').endsWith('|ufc-time'));
});

test('the fitted parameters are on file and sane', () => {
  const P = M.PARAMS;
  assert.ok(P && P.hazard.h3.length === 30 && P.hazard.h5.length === 50);
  assert.ok(P.sig.w > 0 && P.sig.w <= 1 && P.sig.k > 0 && P.sig.prior.all > 2);
  assert.ok(P.holdout.sig.brier < P.holdout.sig.brierDivisionOnly);
});
