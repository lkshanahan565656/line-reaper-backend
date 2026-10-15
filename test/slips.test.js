const test = require('node:test');
const assert = require('node:assert');
const S = require('../slips');
const { PAYOUTS, PICK6_PAYOUTS } = require('../slip');
const { createSlipLog, matchLeg, indexRows } = require('../sliplog');
const { createSportTracker } = require('../sporttrack');
const { createMemoryStore } = require('../evtrack');

const NOW = Date.parse('2026-10-15T04:00:00Z');

test('a pasted slip reads its app, stake, payout, time and every leg wording', () => {
  const { slips, skipped } = S.parseSlips(`PrizePicks 3-pick $10 to win $60 10/14 7:05pm
Josh Allen Over 245.5 Pass Yds
Stefon Diggs o64.5 rec yds (NFL)
NBA: LeBron James 25.5 Points More

Underdog $5 flex
1. Aaron Judge Under 1.5 Total Bases
not a leg at all`, { now: NOW });
  assert.strictEqual(slips.length, 2);
  const [a, b] = slips;
  assert.strictEqual(a.app, 'prizepicks');
  assert.strictEqual(a.stake, 10);
  assert.strictEqual(a.payout, 60);
  assert.deepStrictEqual(a.legs.map(l => [l.player, l.side, l.line, l.market, l.sport]), [
    ['Josh Allen', 'Over', 245.5, 'Pass Yds', null], ['Stefon Diggs', 'Over', 64.5, 'rec yds', 'NFL'], ['LeBron James', 'Over', 25.5, 'Points', 'NBA']]);
  assert.strictEqual(b.app, 'underdog');
  assert.strictEqual(b.flex, true);
  assert.deepStrictEqual(b.legs.map(l => [l.player, l.side, l.line]), [['Aaron Judge', 'Under', 1.5]]);
  assert.deepStrictEqual(skipped, ['not a leg at all']);
});

test('the payout tables match the slip pricer', () => {
  for (const [app, key] of [['prizepicks', 'prizepicks_power'], ['underdog', 'underdog_standard']])
    for (const [n, t] of Object.entries(PAYOUTS[key])) assert.strictEqual(S.POWER[app][n], t[n], `${app} ${n}`);
  for (const [n, t] of Object.entries(PICK6_PAYOUTS)) assert.strictEqual(S.POWER.pick6[n], t[n]);
  for (const [app, key] of [['prizepicks', 'prizepicks_flex'], ['underdog', 'underdog_flex']]) assert.deepStrictEqual(S.FLEX[app], PAYOUTS[key]);
  assert.deepStrictEqual(S.payTable({ app: 'prizepicks', legs: [1, 2, 3], stake: 10, payout: 50 }), { 3: 5 });
  assert.deepStrictEqual(S.payTable({ app: 'underdog', legs: [1, 2, 3], flex: true }), { 3: 3.25, 2: 1.09 });
});

test('a Pikkit CSV comes in by column name, one row per bet or per leg, with its own breakdown', () => {
  const csv = `Bet ID,Time Placed,Sportsbook,Bet Type,League,Description,Odds,Amount,Profit,Status
1,2026-10-01T18:00:00Z,PrizePicks,Parlay,NFL,"Josh Allen Over 245.5 Pass Yds | Stefon Diggs Under 64.5 Rec Yds",+260,10,26,Won
2,2026-10-02T18:00:00Z,DK Pick6,Parlay,MLB,Aaron Judge Over 1.5 Total Bases,+500,5,-5,Lost
3,2026-09-20T18:00:00Z,Chalkboard Fantasy,Parlay,NBA,"LeBron James Over 25.5 Points",+300,10,-10,Lost
3,2026-09-20T18:00:00Z,Chalkboard Fantasy,Parlay,NBA,"Anthony Davis Over 11.5 Rebounds",+300,10,-10,Lost`;
  const { bets, columns } = S.parsePikkitCsv(csv, { now: NOW });
  assert.strictEqual(bets.length, 3);
  assert.ok(columns.placed != null && columns.stake != null && columns.desc != null);
  assert.deepStrictEqual(bets.map(b => [b.app, b.status, b.legs.length]), [['prizepicks', 'win', 2], ['pick6', 'loss', 1], ['chalkboard', 'loss', 2]]);
  const byApp = S.pikkitBreakdown(bets, 'app');
  assert.deepStrictEqual(byApp[0], { key: 'PrizePicks', bets: 1, won: 1, lost: 0, push: 0, open: 0, staked: 10, profit: 26, roi: 2.6, winRate: 1 });
  assert.strictEqual(S.pikkitBreakdown(bets, 'month')[0].key, '2026-10');
  assert.strictEqual(S.parsePikkitCsv('a,b\n1,2').error.startsWith("Couldn't find"), true);
});

test('a slip scores its close from the legs, power or flex', () => {
  const slip = { id: 's1', app: 'prizepicks', stake: 10, payout: 60, placedAt: '2026-10-14T18:00:00.000Z',
    legs: [{ player: 'A', side: 'Over', line: 1.5, market: 'Hits' }, { player: 'B', side: 'Under', line: 2.5, market: 'Hits' }, { player: 'C', side: 'Over', line: 3.5, market: 'Hits' }] };
  const g = p => ({ status: 'locked', closeFair: p, closeEv: (p / 0.5622 - 1) * 100, closeOk: true });
  const grades = Object.fromEntries(slip.legs.map((l, i) => [S.legKey(slip, l), g([0.6, 0.6, 0.5][i])]));
  const v = S.slipView(slip, grades);
  assert.ok(Math.abs(v.closeEv - (0.6 * 0.6 * 0.5 * 6 - 1)) < 1e-4);
  assert.strictEqual(v.legsBeat, 2);
  const t = S.legTotals([v], 'app')[0];
  assert.strictEqual(t.priced, 3);
  assert.strictEqual(t.beatShare, 0.6667);
  // one leg's close too early to count: the slip has no close
  grades[S.legKey(slip, slip.legs[2])] = { ...grades[S.legKey(slip, slip.legs[2])], closeOk: false };
  assert.strictEqual(S.slipView(slip, grades).closeEv, null);
});

// a props-board row as propsBoardRows() makes it
const row = (player, mkey, market, start, books, sport = 'NFL') => ({ key: `${sport}|${player}|${mkey}|${start.slice(0, 10)}`, sport, player, mkey, market, startTime: start, matchTitle: 'BUF @ NYJ', books });

test('a leg finds its row by player, stat and the next game, or says why not', () => {
  const rows = [row('Josh Allen', 'pass_yds', 'Pass Yards', '2026-10-15T17:00:00Z', { prizepicks: { line: 245.5 } }),
    row('Josh Allen', 'rush_yds', 'Rush Yards', '2026-10-15T17:00:00Z', { prizepicks: { line: 30.5 } })];
  const idx = indexRows(rows);
  const leg = { app: 'prizepicks', player: 'Josh Allen', market: 'Pass Yds', side: 'Over', line: 245.5, betAt: '2026-10-15T03:00:00Z' };
  assert.strictEqual(matchLeg(leg, idx).row.mkey, 'pass_yds');
  assert.strictEqual(matchLeg({ ...leg, player: 'J. Allen' }, idx).row.mkey, 'pass_yds');
  assert.strictEqual(matchLeg({ ...leg, player: 'Jake Allen' }, idx).reason, 'player');
  assert.strictEqual(matchLeg({ ...leg, market: 'Receptions' }, idx).reason, 'market');
  // a bet days before the game is someone else's game
  assert.strictEqual(matchLeg({ ...leg, betAt: '2026-10-05T03:00:00Z' }, idx).reason, 'player');
  assert.strictEqual(matchLeg({ ...leg, sport: 'CS' }, idx).reason, 'esports');
});

test('a leg is followed from first sight to a fresh close and its box score; a late one says no line history', async () => {
  let t = NOW;
  const tracker = createSportTracker({ store: createMemoryStore(), now: () => t, log: { warn() {} },
    grader: { grade: async () => ({ outcome: 'win', result: 270 }) } });
  const log = createSlipLog({ tracker, now: () => t });
  const start = '2026-10-15T17:00:00Z';
  let fair = 0.55;
  const fairAt = () => fair;
  let rows = [row('Josh Allen', 'pass_yds', 'Pass Yards', start, { prizepicks: { line: 245.5, overOpen: true, underOpen: true } })];
  const legs = [{ id: 'k1', app: 'prizepicks', player: 'Josh Allen', market: 'Pass Yds', side: 'Over', line: 245.5, betAt: '2026-10-15T03:50:00Z' },
    { id: 'k2', app: 'prizepicks', player: 'Josh Allen', market: 'Pass Yds', side: 'Over', line: 245.5, betAt: '2026-10-01T03:50:00Z' },
    { id: 'k3', app: 'underdog', player: 'Nobody Here', market: 'Pass Yds', side: 'Over', line: 245.5, betAt: '2026-10-15T03:50:00Z' }];
  let r = (await log.grade(legs, { rows, fairAt })).results;
  assert.strictEqual(r.k1.status, 'open');
  assert.strictEqual(r.k1.signalFair, 0.55);
  assert.strictEqual(r.k2.status, 'nohistory');
  assert.strictEqual(r.k2.reason, 'before');
  assert.strictEqual(r.k2.final, true);
  assert.strictEqual(r.k3.reason, 'player');
  assert.strictEqual(r.k3.final, false);
  // the market moves our way and the app moves its line up; read 20 minutes before the start
  t = Date.parse(start) - 20 * 60e3; fair = 0.6;
  rows = [row('Josh Allen', 'pass_yds', 'Pass Yards', start, { prizepicks: { line: 250.5, overOpen: true, underOpen: true } })];
  await tracker.record({ rows, flagged: [], fairAt });
  t = Date.parse(start) + 60e3;
  await tracker.record({ rows, flagged: [], fairAt });
  r = (await log.grade([legs[0]], { rows, fairAt })).results;
  assert.strictEqual(r.k1.status, 'locked');
  assert.strictEqual(r.k1.closeOk, true);
  assert.strictEqual(r.k1.closeFair, 0.6);
  assert.ok(Math.abs(r.k1.closeEv - (0.6 / 0.5622 - 1) * 100) < 0.01);
  assert.strictEqual(r.k1.lineMove, 5);
  t = Date.parse(start) + 4 * 3600e3;
  await tracker.grade();
  r = (await log.grade([legs[0]], { rows, fairAt })).results;
  assert.strictEqual(r.k1.outcome, 'win');
  assert.strictEqual(r.k1.final, true);
});

test('a leg no sharp source prices is still followed, and closes without a fair', async () => {
  let t = NOW;
  const tracker = createSportTracker({ store: createMemoryStore(), now: () => t, log: { warn() {} } });
  const log = createSlipLog({ tracker, now: () => t });
  const start = '2026-10-15T17:00:00Z';
  const rows = [row('Bo Nix', 'pass_yds', 'Pass Yards', start, { prizepicks: { line: 220.5 } })];
  const r = (await log.grade([{ id: 'x', app: 'betr', player: 'Bo Nix', market: 'Passing Yards', side: 'Under', line: 220.5, betAt: '2026-10-15T03:00:00Z' }], { rows, fairAt: () => null })).results;
  assert.strictEqual(r.x.status, 'open');
  assert.strictEqual(r.x.signalFair, null);
  t = Date.parse(start) + 60e3;
  await tracker.record({ rows, flagged: [], fairAt: () => null });
  const b = (await tracker.list())[0];
  assert.strictEqual(b.closeEv, null);
  assert.strictEqual(b.fairMove, null);
});
