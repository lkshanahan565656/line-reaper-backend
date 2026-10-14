const test = require('node:test');
const assert = require('node:assert');
const fb = require('../freebooks');
const alt = require('../altlines');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const START = '2026-10-15T00:00:00Z';
const runner = (type, name, odds) => ({ result: type ? { type } : {}, runnerName: name, runnerStatus: 'ACTIVE', handicap: 0, winRunnerOdds: { americanDisplayOdds: { americanOddsInt: odds } } });
const mk = (marketType, marketName, runners) => ({ marketType, marketName, bettingType: 'ODDS', marketStatus: 'OPEN', inPlay: false, runners });

test('FanDuel ladders: alt yards, player-to-record rungs, TD scorers and alternate lines; period markets skipped', () => {
  const page = { attachments: { markets: {
    a: mk('PLAYER_X_ALT_RECEIVING_YARDS_HIGH', 'Parker Washington - Alt Receiving Yds', [runner(null, 'Parker Washington 50+ Yards', 150), runner(null, 'Parker Washington 75+ Yards', 400)]),
    b: mk('PLAYER_ALT_SAVES', 'Jakub Dobes Alt Saves', [runner(null, '26+', 100)]),
    c: mk('PLAYER_TO_RECORD_3+_SHOTS_ON_GOAL', 'Player to Record 3+ Shots on Goal', [runner(null, 'Cole Caufield', -250)]),
    d: mk('ANY_TIME_TOUCHDOWN_SCORER', 'Any Time Touchdown Scorer', [runner(null, 'Woody Marks', 110), runner(null, 'No Touchdown', 900)]),
    e: mk('TO_SCORE_2+_TOUCHDOWNS', 'To Score 2+ Touchdowns', [runner(null, 'Woody Marks', 750)]),
    f: mk('ALTERNATE_HANDICAP', 'Alternate Spread', [runner('AWAY', 'Houston Texans (+7.5)', -300), runner('HOME', 'Jacksonville Jaguars (-7.5)', 230)]),
    g: mk('ALTERNATE_TOTAL', 'Alternate Total Points', [runner('OVER', 'Over (50.5)', 200), runner('UNDER', 'Under (50.5)', -260)]),
    h: mk('1ST_PERIOD_PLAYER_1+_POINTS', '1st Period 1+ Points', [runner(null, 'Nick Suzuki', 230)]),
    i: mk('ALTERNATE_PUCK_LINE', 'Alternate Puck Line', [runner('AWAY', 'Montreal Canadiens +2.5', -410)]),
  } } };
  const { ladders, alts } = fb.parseFanDuelLadders(page);
  const by = Object.fromEntries(ladders.map(l => [`${l.player}|${l.mkey}|${l.line}`, l.price]));
  assert.deepStrictEqual(by, {
    'Parker Washington|rec_yds|49.5': 150, 'Parker Washington|rec_yds|74.5': 400, 'Jakub Dobes|saves|25.5': 100,
    'Cole Caufield|shots_on_goal|2.5': -250, 'Woody Marks|anytime_td|0.5': 110, 'Woody Marks|anytime_td|1.5': 750,
  });
  assert.deepStrictEqual(alts.map(a => `${a.kind}|${a.type}|${a.point}|${a.price}`), [
    'spreads|AWAY|7.5|-300', 'spreads|HOME|-7.5|230', 'totals|OVER|50.5|200', 'totals|UNDER|50.5|-260', 'spreads|AWAY|2.5|-410']);
});

test('Kambi ladders: "N+ ... By The Player" and Touchdown Scorer Yes rungs, half-game ones skipped', () => {
  const offer = (label, participant, line, odds) => ({ criterion: { englishLabel: label }, outcomes: [{ type: 'OT_YES', status: 'OPEN', participant, line, oddsAmerican: String(odds) }] });
  const payload = { betOffers: [
    offer('25+ Receiving Yards By The Player - Including Overtime', 'Waddle, Jaylen', 25000, -400),
    offer('50+ Rushing Yards By The Player - First Half', 'Emanuel Wilson', 50000, 310),
    offer('2+ Touchdown To Be Scored By The Player - Including Overtime', 'Jaylen Waddle', 2000, 900),
    offer('Touchdown Scorer', 'Jaylen Waddle', 1000, 140),
    offer('12+ Passing & Rushing Yards By The Player - Including Overtime', 'Sam Darnold', 12000, -9000),
  ] };
  assert.deepStrictEqual(fb.kambiLadders(payload).map(l => `${l.player}|${l.mkey}|${l.line}|${l.price}`), [
    'Jaylen Waddle|rec_yds|24.5|-400', 'Jaylen Waddle|anytime_td|1.5|900', 'Jaylen Waddle|anytime_td|0.5|140', 'Sam Darnold|pass_rush_yds|11.5|-9000']);
});

test('ladderAt: exact at a posted line, z-interpolated between, stretched at 1/sd past the end and not beyond', () => {
  const pts = [{ x: -3.5, p: 0.4 }, { x: -2.5, p: 0.45 }, { x: 2.5, p: 0.6 }];
  assert.deepStrictEqual(alt.ladderAt(pts, -2.5, 13.5), { p: 0.45, exact: true });
  const mid = alt.ladderAt(pts, 0.5, 13.5);
  assert.ok(!mid.exact && mid.p > 0.45 && mid.p < 0.6);
  const out = alt.ladderAt(pts, 7.5, 13.5);
  assert.ok(!out.exact && out.p > 0.6 && out.p < 0.75, String(out.p));
  assert.strictEqual(alt.ladderAt(pts, 20.5, 13.5), null);
  assert.ok(Math.abs(alt.probit(0.975) - 1.96) < 1e-3);
});

// a merged game as freebooks.mergeGames builds it
function game({ fdLadders = [], fdAlts = [], brMarkets = [], pinProps = [] } = {}) {
  return { id: 'pin-1', sport_key: 'nfl', commence_time: START, home_team: 'Jacksonville Jaguars', away_team: 'Houston Texans', bookmakers: [
    { key: 'pinnacle', markets: [
      { key: 'spreads', outcomes: [-3.5, -3, -2.5].flatMap((h, i) => [{ name: 'Jacksonville Jaguars', price: [110, 100, -110][i], point: h }, { name: 'Houston Texans', price: [-120, -110, 100][i], point: -h }]) },
      { key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 44.5 }, { name: 'Under', price: -105, point: 44.5 }] },
      ...pinProps] },
    { key: 'fanduel', markets: [], ladders: fdLadders, altLines: fdAlts },
    { key: 'betrivers', markets: brMarkets },
  ] };
}

test('screen: an alt spread at Pinnacle\'s own number with Kalshi agreeing clears; the curve alone is model-only', () => {
  // Jaguars −2.5 at Pinnacle −110 / +100 → about 51% no-vig; FanDuel +120 on it
  const g = game({ fdAlts: [{ kind: 'spreads', name: 'Jacksonville Jaguars', point: -2.5, price: 120 }, { kind: 'spreads', name: 'Houston Texans', point: 9.5, price: -900 }] });
  const kalshi = new Map([['pin-1', { key: 'kalshi_mid', markets: [{ key: 'spreads', outcomes: [{ name: 'Jacksonville Jaguars', price: -104, point: -2.5 }, { name: 'Houston Texans', price: 104, point: 2.5 }] }] }]]);
  const fairs = new Map(), costs = new Map();
  const rows = alt.screen({ gamesBySport: { nfl: [g] }, kalshiGame: kalshi, now: NOW, fairs, costs });
  const r = rows.find(x => x.point === -2.5);
  assert.ok(r && r.clears && !r.model && r.source === 'alt', JSON.stringify(rows));
  assert.deepStrictEqual(r.sources.map(s => s.book), ['pinnacle', 'kalshi']);
  assert.deepStrictEqual(r.sharpBooks, ['pinnacle', 'kalshi_mid']);
  assert.ok(r.ev > 2 && r.agree);
  assert.ok(fairs.has(`${r.group}|${r.side}`) && costs.has(`${r.group}|${r.side}|fanduel`));
  // without Kalshi the same rung is one source: shown, not clearing
  const solo = alt.screen({ gamesBySport: { nfl: [g] }, now: NOW }).find(x => x.point === -2.5);
  assert.ok(solo && !solo.clears && solo.source === 'alt-model');
});

test('screen: BetRivers two-way lines at Pinnacle\'s numbers stay ev.screen\'s; off them they are priced here', () => {
  const brMarkets = [{ key: 'spreads', outcomes: [
    { name: 'Jacksonville Jaguars', price: 150, point: -2.5 }, { name: 'Houston Texans', price: -180, point: 2.5 },
    { name: 'Jacksonville Jaguars', price: 160, point: -4.5 }, { name: 'Houston Texans', price: -200, point: 4.5 }] }];
  const rows = alt.screen({ gamesBySport: { nfl: [game({ brMarkets })] }, now: NOW, o: { minEv: -100 } });
  assert.ok(rows.every(r => Math.abs(r.point) === 4.5), JSON.stringify(rows.map(r => r.side)));
  assert.ok(rows.some(r => r.side === 'Jacksonville Jaguars -4.5'));
});

test('screen: a ladder rung clears only when Kalshi prices that exact rung and agrees with Pinnacle\'s curve', () => {
  const pinProps = [{ key: 'rec_yds', outcomes: [{ name: 'Over', description: 'Parker Washington', price: -110, point: 61.5 }, { name: 'Under', description: 'Parker Washington', price: -110, point: 61.5 }] }];
  const fdLadders = [{ player: 'Parker Washington', mkey: 'rec_yds', line: 99.5, price: 700 }];
  const g = game({ pinProps, fdLadders });
  const base = alt.screen({ gamesBySport: { nfl: [g] }, now: NOW, leagueOf: () => 'NFL', o: { minEv: -100 } });
  assert.strictEqual(base.length, 1);
  const p = base[0].fairProb / 100;
  assert.ok(base[0].model && !base[0].clears && p > 0.05 && p < 0.25, String(p));
  const rungs = new Map([['T', { league: 'NFL', player: 'Parker Washington', mkey: 'rec_yds', line: 99.5, yesBid: p - 0.01, yesAsk: p + 0.01, start: START }]]);
  const withK = alt.screen({ gamesBySport: { nfl: [g] }, kalshiRungs: rungs, now: NOW, leagueOf: () => 'NFL', o: { minEv: -100 } });
  assert.ok(withK[0].clears && !withK[0].model && withK[0].sharpBooks.includes('kalshi_props'), JSON.stringify(withK[0]));
  // Kalshi far off Pinnacle's curve: no agreement, no clear
  const far = new Map([['T', { ...rungs.get('T'), yesBid: p + 0.15, yesAsk: p + 0.17 }]]);
  assert.ok(!alt.screen({ gamesBySport: { nfl: [g] }, kalshiRungs: far, now: NOW, leagueOf: () => 'NFL', o: { minEv: -100 } })[0].clears);
  // no Pinnacle and no Kalshi: a soft book's line alone prices nothing
  const fdOnly = game({ fdLadders, brMarkets: [{ key: 'rec_yds', outcomes: pinProps[0].outcomes }] });
  fdOnly.bookmakers[0].markets = fdOnly.bookmakers[0].markets.filter(m => m.key !== 'rec_yds');
  assert.strictEqual(alt.screen({ gamesBySport: { nfl: [fdOnly] }, now: NOW, leagueOf: () => 'NFL', o: { minEv: -100 } }).length, 0);
});

test('bookmakerFor carries the one-way rungs in Pinnacle\'s team names; ev.screen never reads them', () => {
  const b = { book: 'fanduel', home: 'JAX Jaguars', away: 'HOU Texans', start: START, h2h: [], spreads: [], totals: [], props: [],
    ladders: [{ player: 'X', mkey: 'rec_yds', line: 49.5, price: 150 }], alts: [{ kind: 'spreads', type: 'AWAY', point: 7.5, price: -300 }] };
  const bm = fb.bookmakerFor(b, { home: 'Jacksonville Jaguars', away: 'Houston Texans' });
  assert.deepStrictEqual(bm.altLines, [{ kind: 'spreads', point: 7.5, price: -300, name: 'Houston Texans' }]);
  assert.strictEqual(bm.ladders.length, 1);
  assert.deepStrictEqual(bm.markets, []);
});
