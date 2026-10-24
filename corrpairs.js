// ─── CORRELATED STACKS: same-game legs that hit together ─────────────────────
// A quarterback's passing yards and his top receivers' receiving yards come
// out of the same throws; three hitters' hits + runs + RBIs and the other
// team's starter's earned runs come out of the same innings. Their Overs land
// together far more often than independent coin flips would. Measured on ESPN
// box scores (check in checks/corr-pairs-2026-10-24): each leg at the player's
// trailing-median line, the shapes below swept at the rates in HISTORY.
//
// That only pays if the app pays its standard table on the entry. PrizePicks
// says it lowers payouts for correlated lineups and Underdog shows a lower
// multiplier while the entry is built, so every stack carries two prices:
//   standard  the app's published sweep payout
//   repriced  standard x P(all hit, independent) / P(all hit, together), the
//             payout an app that priced the link would show (the esports stack
//             cards' rule, esmodels.js / esRepriced)
// The truth sits between them. A stack is a play only at the repriced price,
// and none clears it, so this is a record of its own: alerts off, never in
// Best Plays, judged at 50 graded at the apps' real lines.
//
// The legs go in a sports-props tracker of their own (kind 'corr', one leg row
// per stack, stackId linking them) so each is checked two minutes on, followed
// to the close and graded off the box score like every other leg; summarize()
// turns graded legs back into stacks.

const { canonName } = require('./ev');
const { sportMarketKey } = require('./propsboard');

// Measured sweep rate (j50: legs rescaled to 50/50; raw: at the trailing-median
// lines, whose legs sat at 41-53%), the stacks and games behind it, and the
// train / test halves (train = the seasons before the last full one).
const HISTORY = {
  'qb-2wr-oppqb': {
    NFL: { stacks: 560, games: 362, j50: 0.116, raw: 0.1071, se: 0.0102, train: 0.1048, test: 0.1406, seasons: '2023-2026' },
    CFB: { stacks: 1139, games: 769, j50: 0.1148, raw: 0.086, se: 0.007, train: 0.1283, test: 0.105, seasons: '2024-2026' },
  },
  'hrr3-oppsp': {
    MLB: { stacks: 10756, games: 6347, j50: 0.1342, raw: 0.1304, se: 0.0019, train: 0.1352, test: 0.1338, seasons: '2024-2026' },
  },
};
// Each shape: its legs by role, all More. 'opp' legs are on the other team, so
// every entry has the two teams PrizePicks and Underdog require.
const SHAPES = {
  'qb-2wr-oppqb': {
    sports: ['NFL', 'CFB'],
    label: "QB passing yards + his top two receivers' receiving yards + the other QB's passing yards, all More",
    roles: [{ role: 'QB', mkey: 'pass_yds' }, { role: 'WR1', mkey: 'rec_yds' }, { role: 'WR2', mkey: 'rec_yds' }, { role: 'Opp QB', mkey: 'pass_yds', opp: true }],
  },
  'hrr3-oppsp': {
    sports: ['MLB'],
    label: "Three hitters' hits + runs + RBIs + the other team's starter's earned runs, all More",
    roles: [{ role: 'Hitter 1', mkey: 'hits_runs_rbis' }, { role: 'Hitter 2', mkey: 'hits_runs_rbis' }, { role: 'Hitter 3', mkey: 'hits_runs_rbis' }, { role: 'Opp SP', mkey: 'earned_runs', opp: true }],
  },
};
const APPS = ['prizepicks', 'pick6', 'underdog'];
const APP_NAME = { prizepicks: 'PrizePicks', pick6: 'DK Pick6', underdog: 'Underdog' };
const ENTRY = { prizepicks: 'Power Play', pick6: 'entry', underdog: 'Standard entry' };
const r2 = x => Math.round(x * 100) / 100, r4 = x => Math.round(x * 1e4) / 1e4;

// The More side on the app's standard line: PrizePicks lists only standard
// lines; a Pick6 or Underdog pick that pays 1x on More.
function standardOver(l) {
  if (!l || !Number.isFinite(Number(l.line)) || l.overOpen === false) return false;
  if (l.book === 'prizepicks') return true;
  return Math.abs(Number(l.overMultiplier) - 1) < 1e-9;
}

// Sweep payout of an n-pick entry on an app's table ({ n: { n: pay } }).
function sweepPays(app, n, tables = {}) {
  const t = tables[app]?.[n];
  return t && Number.isFinite(t[n]) ? t[n] : null;
}

const teamKey = t => canonName(String(t || ''));
const dateOf = s => String(s || '').slice(0, 10);

// lines: the apps' raw sports lines (normLine'd: book, sport, player, team,
// market, line, startTime, matchTitle, gameId, overMultiplier, overOpen).
// rows: the props board rows built from them (for the leg's rowKey).
// → one stack per shape, app, team and game the app lists every leg of on a
// standard line. Roles come off the app's own board: the QB is the team's
// passing-yards line (the higher if two), the receivers its two highest
// receiving-yards lines, the hitters its three highest H+R+RBI lines.
function buildStacks(lines, rows = [], { tables = {}, apps = APPS, shapes = SHAPES, now = Date.now() } = {}) {
  const rowIdx = new Map();
  for (const r of rows || []) {
    const k = `${r.sport}|${canonName(r.player)}|${r.mkey}`;
    if (!rowIdx.has(k)) rowIdx.set(k, []);
    rowIdx.get(k).push(r);
  }
  const rowFor = (l, mkey) => (rowIdx.get(`${l.sport}|${canonName(l.player)}|${mkey}`) || []).find(r => r.books?.[l.book]?.line === Number(l.line)) || null;
  // app → game → team → lines
  const games = new Map();
  for (const l of lines || []) {
    if (!l || l.esports || !apps.includes(l.book) || !l.team || !standardOver(l)) continue;
    if (!(Date.parse(l.startTime || '') > now)) continue;
    const g = `${l.book}|${l.sport}|${l.gameId != null ? `id:${l.gameId}` : `${l.startTime}|${l.matchTitle || ''}`}`;
    if (!games.has(g)) games.set(g, new Map());
    const t = games.get(g), tk = teamKey(l.team);
    if (!t.has(tk)) t.set(tk, []);
    t.get(tk).push({ ...l, mkey: sportMarketKey(l.market, l.sport) });
  }
  const out = [];
  for (const teams of games.values()) {
    if (teams.size !== 2) continue;
    const [ta, tb] = [...teams.keys()];
    for (const [shape, def] of Object.entries(shapes)) {
      for (const [mine, theirs] of [[ta, tb], [tb, ta]]) {
        const own = teams.get(mine), opp = teams.get(theirs);
        const l0 = own[0];
        if (!def.sports.includes(l0.sport)) continue;
        const picked = [], used = new Set();
        for (const { role, mkey, opp: isOpp } of def.roles) {
          const pool = (isOpp ? opp : own).filter(l => l.mkey === mkey && !used.has(canonName(l.player))).sort((a, b) => b.line - a.line || canonName(a.player).localeCompare(canonName(b.player)));
          if (!pool.length) break;
          used.add(canonName(pool[0].player));
          picked.push({ role, l: pool[0] });
        }
        if (picked.length !== def.roles.length) continue;
        const n = picked.length, app = l0.book;
        const h = HISTORY[shape]?.[l0.sport];
        const std = sweepPays(app, n, tables);
        if (!std || !h) continue;
        const repriced = r2(std * 0.5 ** n / h.j50);
        const legs = picked.map(({ role, l }) => {
          const row = rowFor(l, l.mkey);
          return { role, player: l.player, team: l.team, mkey: l.mkey, market: l.market, line: Number(l.line), side: 'Over', mult: Number(l.overMultiplier) || 1, rowKey: row?.key || null };
        });
        out.push({
          id: `${l0.sport}|${shape}|${app}|${teamKey(l0.team)}|${dateOf(l0.startTime)}`,
          shape, label: def.label, sport: l0.sport, app, appName: APP_NAME[app] || app, entry: `${n}-pick ${ENTRY[app] || 'entry'}`,
          team: l0.team, opponent: opp[0].team, matchTitle: l0.matchTitle || '', startTime: l0.startTime, legs,
          standard: { pays: std, needSweep: r4(1 / std), history: h.j50, ev: r2((h.j50 * std - 1) * 100) },
          repriced: { pays: repriced, needSweep: r4(1 / repriced), ev: r2((h.j50 * repriced - 1) * 100) },
          history: h,
        });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id));
}

// The legs to log in the stack record: one per stack leg, carrying the stack.
// A leg the board has no row for (rowKey null) can't be followed, so its stack waits.
function flaggedLegs(stacks, rowsByKey) {
  const out = [];
  for (const s of stacks) {
    const rows = s.legs.map(l => rowsByKey.get(l.rowKey));
    if (rows.some(r => !r)) continue;
    s.legs.forEach((l, i) => out.push({ row: rows[i], kind: 'corr', play: { book: s.app, side: 'Over', line: l.line, mult: l.mult, ev: null, fair: null,
      stackId: s.id, stackShape: s.shape, stackRole: l.role, stackLegs: s.legs.length, stackPays: s.standard.pays, stackRepriced: s.repriced.pays } }));
  }
  return out;
}

// Leg rows (sporttrack shape, kind 'corr') → stacks and their record. A stack
// counts once every leg is graded; a void or push leg voids it (the app drops
// the pick and pays a smaller table, which this record doesn't follow).
function summarize(legs) {
  const by = new Map();
  for (const b of legs || []) {
    if (b.kind !== 'corr' || !b.stackId) continue;
    if (!by.has(b.stackId)) by.set(b.stackId, []);
    by.get(b.stackId).push(b);
  }
  const stacks = [];
  for (const [id, list] of by) {
    const b0 = list[0], n = b0.stackLegs || list.length;
    const done = list.length >= n && list.every(b => b.status === 'graded' || b.status === 'void');
    const voided = list.some(b => b.status === 'void' || b.outcome === 'push');
    const status = !done ? 'open' : voided ? 'void' : 'graded';
    stacks.push({ id, shape: b0.stackShape, sport: b0.sport, app: b0.book, team: b0.team, start: b0.start, status,
      swept: status === 'graded' && list.every(b => b.outcome === 'win'), hits: list.filter(b => b.outcome === 'win').length, legs: n,
      pays: b0.stackPays, repriced: b0.stackRepriced, exec: list.every(b => b.execOk === true),
      players: list.map(b => `${b.player} ${b.signalLine}`) });
  }
  const tally = l => {
    const sw = l.filter(s => s.swept).length;
    const units = key => r2(l.reduce((a, s) => a + (s.swept ? s[key] || 0 : 0), 0) - l.length);
    const need = key => (l.length ? r4(l.reduce((a, s) => a + 1 / s[key], 0) / l.length) : null);
    return { graded: l.length, swept: sw, sweepRate: l.length ? r4(sw / l.length) : null, needStd: need('pays'), needRep: need('repriced'),
      unitsStd: units('pays'), unitsRep: units('repriced'), exec: l.filter(s => s.exec).length };
  };
  const g = stacks.filter(s => s.status === 'graded');
  const groups = {};
  for (const s of g) (groups[`${s.sport} ${s.shape} ${s.app}`] ||= []).push(s);
  return { stacks: stacks.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)), overall: tally(g),
    open: stacks.filter(s => s.status === 'open').length, void: stacks.filter(s => s.status === 'void').length,
    byGroup: Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, tally(l)])), provenAt: 50 };
}

module.exports = { HISTORY, SHAPES, APPS, standardOver, sweepPays, buildStacks, flaggedLegs, summarize };
