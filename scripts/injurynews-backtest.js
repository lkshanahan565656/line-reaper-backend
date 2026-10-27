// Injury news backtest (checks/injury-stale-2026-10-25): the official NBA
// injury report's 15-minute PDFs (as text) give the news times, the weekend
// board recorder's change logs give Pinnacle's and the apps' numbers minute by
// minute, ESPN's box scores the results. The legs come from injurynews.js, the
// same code the server runs.
//
//   node scripts/injurynews-backtest.js <reports dir> <changes.jsonl ...> --boxes <dir> --seed <nba-games.json.gz> [--date 2026-10-24]
//
// Reports are named <YYYY-MM-DD>_<HH>_<MM><AM|PM>.txt (US Eastern).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const I = require('../injurynews');
const NS = require('../nflsunday');
const M = require('../nbamodel');
const { canonName } = require('../ev');
const { devigPower } = require('../pinprops');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const boxDir = opt('--boxes'), seedFile = opt('--seed'), DATE = opt('--date', '2026-10-24'), outFile = opt('--out', null);
const [repDir, ...changeFiles] = args;

// ── the official report ──
const TEAMS = { AtlantaHawks: 'ATL', BostonCeltics: 'BOS', BrooklynNets: 'BKN', CharlotteHornets: 'CHA', ChicagoBulls: 'CHI', ClevelandCavaliers: 'CLE',
  DallasMavericks: 'DAL', DenverNuggets: 'DEN', DetroitPistons: 'DET', GoldenStateWarriors: 'GS', HoustonRockets: 'HOU', IndianaPacers: 'IND',
  LAClippers: 'LAC', LosAngelesClippers: 'LAC', LosAngelesLakers: 'LAL', MemphisGrizzlies: 'MEM', MiamiHeat: 'MIA', MilwaukeeBucks: 'MIL',
  MinnesotaTimberwolves: 'MIN', NewOrleansPelicans: 'NO', NewYorkKnicks: 'NY', OklahomaCityThunder: 'OKC', OrlandoMagic: 'ORL',
  Philadelphia76ers: 'PHI', PhoenixSuns: 'PHX', PortlandTrailBlazers: 'POR', SacramentoKings: 'SAC', SanAntonioSpurs: 'SA', TorontoRaptors: 'TOR',
  UtahJazz: 'UTAH', WashingtonWizards: 'WSH' };
const TEAM_RX = new RegExp(`(${Object.keys(TEAMS).join('|')})`);
const ROW_RX = /(\S+?),(\S+?)\s+(Out|Questionable|Doubtful|Probable|Available)\b/;
// "Udeh,Jr.,Ernest" / "LivelyII,Dereck" / "JohnsonJr.,Morez" → a canonical key
function keyOfReport(last, first) {
  const l = last.replace(/,?(Jr\.?|Sr\.?|III|II|IV)$/, '').replace(/,$/, '');
  return canonName(`${first} ${l}`);
}
function parseReport(txt) {
  const rows = [], teams = new Set();
  let team = null;
  for (const line of String(txt).split('\n')) {
    const tm = TEAM_RX.exec(line);
    if (tm) team = TEAMS[tm[1]];
    const m = ROW_RX.exec(line.replace(TEAM_RX, ' '));
    // a team counts as reported once it lists a player ("NOT YET SUBMITTED" lists none)
    if (m && team) { rows.push({ key: keyOfReport(m[1], m[2]), name: `${m[2]} ${m[1]}`, team, status: m[3] }); teams.add(team); }
  }
  return { rows, teams };
}
// "2026-10-24_06_15PM" → ms (US Eastern, daylight time in October)
function slotMs(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})_?(\d{2})?(AM|PM)$/.exec(name);
  if (!m) return null;
  let h = Number(m[2]) % 12; if (m[4] === 'PM') h += 12;
  return Date.parse(`${m[1]}T${String(h).padStart(2, '0')}:${m[3] || '00'}:00-04:00`);
}
function reportEvents(dir, date) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(date) && f.endsWith('.txt'));
  const reps = new Map();
  for (const f of files) { const t = slotMs(f.replace(/\.txt$/, '')); if (t != null && !reps.has(t)) reps.set(t, parseReport(fs.readFileSync(path.join(dir, f), 'utf8'))); }
  const times = [...reps.keys()].sort((a, b) => a - b);
  const events = [];
  let prev = null;
  for (const t of times) {
    const r = reps.get(t);
    if (prev) {
      const before = new Map(prev.rows.map(x => [x.key, x]));
      for (const x of r.rows) {
        if (!I.isOut(x.status)) continue;
        const p = before.get(x.key);
        if (p ? I.isOut(p.status) : !prev.teams.has(x.team)) continue;   // already out, or his team hadn't reported yet
        events.push({ key: x.key, name: x.name, team: x.team, status: x.status, from: p ? p.status : 'not listed', newsAt: t });
      }
    }
    prev = r;
  }
  return { events, reports: times.length };
}

// ── the recorded board ──
const records = [];
for (const f of changeFiles) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l.includes('"NBA|')) { try { records.push(JSON.parse(l)); } catch { /* a cut line */ } } }
records.sort((a, b) => a.t - b.t);
const { series, meta } = NS.replay(records);
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
// Pinnacle's ladder → its main line { line, pOver } (the rung nearest 50/50)
function pinMain(v) {
  if (!Array.isArray(v) || !v.length) return null;
  const qs = v.map(([line, o, u]) => { const po = toProb(o), pu = toProb(u); return po > 0 && pu > 0 && po + pu >= 1 ? { line, pOver: devigPower(po, pu) } : null; }).filter(Boolean);
  return qs.length ? qs.reduce((a, b) => (Math.abs(b.pOver - 0.5) < Math.abs(a.pOver - 0.5) ? b : a)) : null;
}
const appCell = v => (Array.isArray(v) && Number.isFinite(v[0]) ? { line: v[0], over: v[1], under: v[2], overOpen: v[3] !== 0, underOpen: v[4] !== 0 } : null);
const keyOfRow = row => `NBA|${canonName(row.player)}|${row.mkey}`;
const pinAt = (row, t) => pinMain(NS.at(series.pinnacle?.get(keyOfRow(row)), t));
const appAt = (row, app, t) => appCell(NS.at(series[app]?.get(keyOfRow(row)), t));
const rows = [];
for (const [k, m] of meta) {
  const [, , mkey] = k.split('|');
  if (!mkey || k.split('|').length !== 3 || !m.st) continue;
  rows.push({ key: k, sport: 'NBA', player: m.p, mkey, startTime: new Date(Date.parse(m.st)).toISOString() });
}

// ── history and results ──
const seed = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedFile)));
const H = M.buildHistory(seed.filter(g => g.stype !== 1));
const teamOf = (key, t) => I.rotationOf(H.players, key, t);
const results = new Map(), boxOuts = new Map();
for (const f of fs.readdirSync(boxDir).filter(f => /^NBA-.*\.json\.gz$/.test(f))) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(boxDir, f))));
  const comp = d.header?.competitions?.[0] || { competitors: (d.boxscore?.teams || []).map(x => ({ homeAway: x.homeAway, team: x.team })) };
  const g = M.compactGame({ id: f, players: d.boxscore?.players, comp });
  if (!g) continue;
  const fx = I.fixAbbr;
  for (const p of g.players) results.set(p.key, p);
  for (const [tm, list] of Object.entries(g.inj || {})) for (const k of list) boxOuts.set(k, fx(tm));
}
const statOf = (p, mkey) => {
  if (!p) return null;
  const parts = M.STATS.includes(mkey) ? ({ pra: ['points', 'rebounds', 'assists'], pts_rebs: ['points', 'rebounds'], pts_asts: ['points', 'assists'], rebs_asts: ['rebounds', 'assists'], stocks: ['steals', 'blocks'] }[mkey] || [mkey]) : null;
  return parts ? parts.reduce((a, s) => a + (p[s] ?? NaN), 0) : null;
};

// ── run: every Pinnacle or app change after each event, first flag per app/player/stat ──
const { events, reports } = reportEvents(repDir, DATE);
const changeTimes = [...new Set(records.map(r => r.t))].sort((a, b) => a - b);
const legs = [], seen = new Set();
const evOut = [];
for (const ev of events) {
  const me = teamOf(ev.key, ev.newsAt);
  evOut.push({ ...ev, newsAt: new Date(ev.newsAt).toISOString(), mpg: me?.mpg ?? null, rotation: !!me?.rotation, playedAnyway: results.has(ev.key) });
  if (!me?.rotation) continue;
  const mates = rows.filter(r => { const m = teamOf(canonName(r.player), ev.newsAt); return m && m.team === ev.team; });
  for (const t of changeTimes) {
    if (t < ev.newsAt) continue;
    if (t > ev.newsAt + I.WINDOW_MS) break;
    for (const f of I.legsFor(ev, mates, { teamOf, pinAt, appAt, t })) {
      const id = `${f.leg.app}|${f.row.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const start = Date.parse(f.row.startTime);
      // executable: the app on the same number 2 minutes on
      const later = appAt(f.row, f.leg.app, t + 2 * 60e3);
      const close = pinAt(f.row, start - 1);
      const cAt = close ? I.pinAtLine(f.row.mkey, close, f.leg.line) : null;
      const closeFair = cAt ? (f.leg.side === 'Over' ? cAt.p : 1 - cAt.p) : null;
      const res = statOf(results.get(canonName(f.row.player)), f.row.mkey);
      const outcome = res == null || Number.isNaN(res) ? null : res === f.leg.line ? 'push' : (res > f.leg.line) === (f.leg.side === 'Over') ? 'win' : 'loss';
      legs.push({ app: f.leg.app, kind: f.leg.kind, out: ev.name, team: ev.team, newsAt: new Date(ev.newsAt).toISOString(), flagAt: new Date(t).toISOString(), mins: f.mins,
        player: f.row.player, mkey: f.row.mkey, side: f.leg.side, line: f.leg.line, mult: f.leg.mult, be: f.leg.be, fair: f.leg.fair, ev: f.leg.ev, dPts: f.leg.dPts,
        pinPre: f.leg.pinPre, pinNow: f.leg.pinNow, exec: !!later && later.line === f.leg.line, closeFair: closeFair == null ? null : +closeFair.toFixed(4),
        closeEv: closeFair == null ? null : +((closeFair / f.leg.be - 1) * 100).toFixed(2), result: res, outcome, outPlayed: results.has(ev.key) });
    }
  }
}

// ── tally ──
const lines = [];
const pct = x => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
lines.push(`Injury news backtest, ${DATE} (US Eastern): ${reports} official reports, ${events.length} players newly Out/Doubtful, ${evOut.filter(e => e.rotation).length} in the rotation (${I.MIN_MPG}+ mpg last 5)`);
lines.push(`Board rows recorded: ${rows.length}; legs flagged: ${legs.length}`);
lines.push('');
for (const app of I.APPS) {
  const l = legs.filter(x => x.app === app);
  const g = l.filter(x => x.outcome === 'win' || x.outcome === 'loss');
  const w = g.filter(x => x.outcome === 'win').length;
  const be = g.length ? g.reduce((a, x) => a + x.be, 0) / g.length : null;
  const units = g.reduce((a, x) => a + (x.outcome === 'win' ? 1 / x.be - 1 : -1), 0);
  const c = l.filter(x => x.closeEv != null);
  const clv = c.length ? c.reduce((a, x) => a + x.closeEv, 0) / c.length : null;
  const sd = c.length > 1 ? Math.sqrt(c.reduce((a, x) => a + (x.closeEv - clv) ** 2, 0) / (c.length - 1)) : null;
  lines.push(`${I.KIND[app].padEnd(18)} legs ${String(l.length).padStart(3)}  exec ${l.filter(x => x.exec).length}/${l.length}  graded ${g.length}  ${w}-${g.length - w}  hit ${pct(g.length ? w / g.length : null)} vs ${pct(be)}  z ${I.zOf(w, g.length, be) ?? '-'}  units ${units.toFixed(2)}  close EV ${clv == null ? '-' : clv.toFixed(1)}% (n ${c.length}, t ${sd ? (clv / (sd / Math.sqrt(c.length))).toFixed(2) : '-'})`);
}
lines.push('');
lines.push('Events (rotation players):');
for (const e of evOut.filter(x => x.rotation)) lines.push(`  ${e.newsAt.slice(11, 16)}Z ${e.team} ${e.name} ${e.from} -> ${e.status} (${e.mpg} mpg)${e.playedAnyway ? ' PLAYED' : ''}`);
lines.push('');
lines.push('Legs:');
for (const x of legs) lines.push(`  ${x.flagAt.slice(11, 16)}Z +${x.mins}m ${x.app} ${x.player} ${x.side} ${x.line} ${x.mkey} | out ${x.out} | Pinnacle o${x.pinPre.line} ${pct(x.pinPre.pOver)} -> o${x.pinNow.line} ${pct(x.pinNow.pOver)} (${x.dPts} pts) fair ${pct(x.fair)} be ${pct(x.be)} | exec ${x.exec ? 'yes' : 'no'} close ${pct(x.closeFair)} | ${x.result ?? '-'} ${x.outcome ?? 'ungraded'}`);
const text = lines.join('\n');
console.log(text);
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ date: DATE, reports, events: evOut, legs, boxOuts: [...boxOuts] }, null, 1));
