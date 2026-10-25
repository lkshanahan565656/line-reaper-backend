#!/usr/bin/env node
// CFB model fit and backtest (pre-registered: checks/cfb-model-2026-10-25/PREREGISTERED.md).
//   SEASONS=2024 node scripts/cfbmodel-backtest.js fit <dataDir...> → fitted params JSON on stdout
//   node scripts/cfbmodel-backtest.js seed <dataDir...> <out.gz>   → compact games for the server seed
// A data dir holds events.json and box/<id>.json.gz (the diag-cfbmodel output).
// The fit reads only the SEASONS named and the season before them (last
// season's history): 2024 for the held-out book test, 2024,2025 for live.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('../cfbmodel');

// game lines for past seasons (the box's pick center is empty before 2026):
// lines.json from diag-cfblines, { eventId: [{ spread, overUnder, homeFav, awayFav }] }
function linesFor(dirs) {
  const out = {};
  for (const dir of dirs) {
    const f = path.join(dir, 'lines.json');
    if (fs.existsSync(f)) Object.assign(out, JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  return out;
}
function loadGames(dirs, { seasons = null } = {}) {
  const games = [];
  const lines = linesFor(dirs);
  for (const dir of dirs) {
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    for (const e of ev) {
      if (seasons && !seasons.includes(e.season)) continue;
      const f = path.join(dir, 'box', `${e.id}.json.gz`);
      if (!fs.existsSync(f)) continue;
      const g = M.compactGame(JSON.parse(zlib.gunzipSync(fs.readFileSync(f))), { season: e.season, week: e.week, stype: e.stype });
      if (g && g.spread == null && lines[e.id]?.length) {
        // pre-game lines only: an in-play feed ("ESPN Bet - Live Odds") keeps the line at the end of the game
        const pc = lines[e.id].filter(x => !/live/i.test(x.provider || '')).map(x => ({ spread: x.spread, overUnder: x.overUnder, homeTeamOdds: { favorite: x.homeFav }, awayTeamOdds: { favorite: x.awayFav } }));
        Object.assign(g, M.spreadOf(pc));
      }
      if (g) games.push(g);
    }
  }
  const seen = new Set();
  return games.filter(g => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.t - b.t);
}

// who a row is: passers, rushers, receivers and kickers with a real role (the
// players the apps post), judged on the projection itself
const FLOOR = { pass_att: 15, pass_comp: 9, pass_yds: 100, pass_tds: 0.6, pass_ints: 0.3, rush_att: 5, rush_yds: 20, rush_tds: 0.15,
  receptions: 1.5, rec_yds: 18, rec_tds: 0.1, rush_rec_yds: 25, pass_rush_yds: 120, anytime_td: 0.2, longest_rec: 10, longest_rush: 8,
  fg_made: 0.5, kicking_points: 4 };
const rowsFor = (proj, p) => {
  const out = [];
  for (const s of Object.keys(FLOOR)) {
    const m = proj.mean[s];
    if (!(m >= FLOOR[s])) continue;
    if ((s === 'fg_made' || s === 'kicking_points') && !proj.kicker) continue;
    if (s.startsWith('pass_') && !proj.passer) continue;
    out.push({ stat: s, mean: m, actual: M.statOf(p, s) });
  }
  return out;
};

// every player-game in `games` (those with enough history) projected with params o
function projectAll(H, games, o, filter = () => true) {
  const rows = [];
  for (const g of games) {
    if (!filter(g)) continue;
    for (const p of g.players) {
      const home = p.team === g.home;
      const spread = Number.isFinite(g.spread) ? (home ? g.spread : -g.spread) : null;
      const proj = M.project(H, p.aid, { t: g.t, team: p.team, opp: home ? g.away : g.home, total: g.total, spread }, o);
      if (!proj) continue;
      for (const r of rowsFor(proj, p)) rows.push({ ...r, gid: g.id, aid: p.aid, week: g.week, season: g.season });
    }
  }
  return rows;
}
const sse = rows => { const by = {}; for (const r of rows) { const b = (by[r.stat] ||= { s: 0, n: 0, v: [] }); b.s += (r.actual - r.mean) ** 2; b.n++; b.v.push(r.actual); } return by; };

function fit(dirs, seasons = [2024]) {
  const games = loadGames(dirs, { seasons: [Math.min(...seasons) - 1, ...seasons] });
  const H = M.buildHistory(games);
  const fitGames = g => seasons.includes(g.season);
  const log = (...a) => console.error(...a);
  log(`games ${games.length} (fit: ${games.filter(fitGames).length})`);
  // 1) recency and shrinkage, with the script switched off
  const zero = { pass: { alpha: 0, beta: 0, delta: 0 }, rush: { alpha: 0, beta: 0, delta: 0 }, ptd: { alpha: 0, beta: 0, delta: 0 }, rtd: { alpha: 0, beta: 0, delta: 0 }, kick: { alpha: 0, beta: 0, delta: 0 } };
  // scored on a fixed set of rows (the defaults' floors) so every candidate is judged on the same players
  const base = { ...M.PARAMS, script: zero };
  const key = r => `${r.gid}|${r.aid}|${r.stat}`;
  const ref = new Set(projectAll(H, games, base, fitGames).map(key));
  const score = o => {
    const by = sse(projectAll(H, games, o, fitGames).filter(r => ref.has(key(r))));
    // normalised: each stat's mean squared error over its variance, summed
    return Object.values(by).reduce((a, b) => { const mu = b.v.reduce((x, y) => x + y, 0) / b.n; const vr = b.v.reduce((x, y) => x + (y - mu) ** 2, 0) / b.n; return a + (b.s / b.n) / (vr || 1); }, 0);
  };
  let best = null;
  for (const halfLife of [2, 3, 5, 8]) for (const priorSeasonWeight of [0.2, 0.4, 0.7, 1]) for (const oppK of [4, 8, 16]) {
    const o = { ...base, halfLife, priorSeasonWeight, oppK };
    const s = score(o);
    if (!best || s < best.s) best = { s, o };
  }
  log('recency', best.s.toFixed(4), JSON.stringify({ halfLife: best.o.halfLife, priorSeasonWeight: best.o.priorSeasonWeight, oppK: best.o.oppK }));
  for (const teamHalfLife of [3, 6, 12]) for (const teamK of [1, 3, 6]) {
    const o = { ...best.o, teamHalfLife, teamK };
    const s = score(o);
    if (s < best.s) best = { s, o };
  }
  log('team', best.s.toFixed(4), JSON.stringify({ teamHalfLife: best.o.teamHalfLife, teamK: best.o.teamK }));
  // 2) the script per group, one group at a time (coordinate search, two passes)
  const script = JSON.parse(JSON.stringify(zero));
  const grid = { alpha: [0, 0.25, 0.5, 0.75, 1, 1.25], beta: [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3], delta: [0, 0.1, 0.2, 0.35, 0.5] };
  for (let pass = 0; pass < 2; pass++) {
    for (const grp of Object.keys(script)) for (const par of ['alpha', 'beta', 'delta']) {
      let bv = script[grp][par], bs = score({ ...best.o, script });
      for (const v of grid[par]) {
        const sc = JSON.parse(JSON.stringify(script)); sc[grp][par] = v;
        const s = score({ ...best.o, script: sc });
        if (s < bs - 1e-6) { bs = s; bv = v; }
      }
      script[grp][par] = bv;
    }
    log('script pass', pass, score({ ...best.o, script }).toFixed(4), JSON.stringify(script));
  }
  let o = { ...best.o, script };
  for (const longExp of [0, 0.25, 0.5, 0.75, 1]) {
    const by = sse(projectAll(H, games, { ...o, longExp }, fitGames).filter(r => ref.has(key(r)) && r.stat.startsWith('longest')));
    const s = Object.values(by).reduce((a, b) => a + b.s / b.n, 0);
    if (!o._ls || s < o._ls) o = { ...o, longExp, _ls: s };
  }
  delete o._ls;
  // 3) the spread around the projection: the fit window's ratios per stat band
  const rows = projectAll(H, games, o, fitGames);
  o.dist = M.fitDist(rows);
  o.fitted = { at: new Date().toISOString(), window: `FBS seasons ${seasons.join(', ')} (box scores only)`, rows: rows.length,
    byStat: Object.fromEntries(Object.entries(sse(rows)).map(([s, b]) => [s, { n: b.n, rmse: Math.round(Math.sqrt(b.s / b.n) * 100) / 100 }])) };
  return o;
}

// ── scoring ─────────────────────────────────────────────────────────────────
const BE = { pp: 0.5503, p6: 0.567, book110: 0.5238 };
const zOf = (w, n, p) => (n ? (w / n - p) / Math.sqrt(p * (1 - p) / n) : null);
const r4 = x => Math.round(x * 1e4) / 1e4;
// rows [{ stat, pOver, over (1 if the result went over, 0 under) }] → the pre-registered numbers
function score(rows, { pickMin = 0.58 } = {}) {
  const n = rows.length;
  const brier = rows.reduce((a, r) => a + (r.pOver - r.over) ** 2, 0) / n;
  const clip = p => Math.min(0.999, Math.max(0.001, p));
  const ll = rows.reduce((a, r) => a - Math.log(r.over ? clip(r.pOver) : 1 - clip(r.pOver)), 0) / n;
  const overRate = rows.reduce((a, r) => a + r.over, 0) / n;
  const side = r => (r.pOver >= 0.5 ? { p: r.pOver, win: r.over === 1 } : { p: 1 - r.pOver, win: r.over === 0 });
  const picks = rows.map(r => ({ ...r, ...side(r) })).filter(r => r.p >= pickMin);
  const w = picks.filter(r => r.win).length;
  const bands = [];
  for (let lo = 0.5; lo < 0.8; lo += 0.02) {
    const b = rows.map(r => ({ ...r, ...side(r) })).filter(r => r.p >= lo && r.p < lo + 0.02);
    if (b.length) bands.push({ band: `${Math.round(lo * 100)}-${Math.round(lo * 100) + 2}%`, n: b.length, hit: r4(b.filter(r => r.win).length / b.length), meanP: r4(b.reduce((a, r) => a + r.p, 0) / b.length) });
  }
  const hi = rows.map(r => ({ ...r, ...side(r) })).filter(r => r.p >= 0.8);
  if (hi.length) bands.push({ band: '80%+', n: hi.length, hit: r4(hi.filter(r => r.win).length / hi.length), meanP: r4(hi.reduce((a, r) => a + r.p, 0) / hi.length) });
  const overPicks = picks.filter(r => r.pOver >= 0.5), underPicks = picks.filter(r => r.pOver < 0.5);
  return { n, overRate: r4(overRate), brier: r4(brier), brierFlat: 0.25, logLoss: r4(ll), logLossFlat: r4(Math.log(2)),
    picks: { n: picks.length, wins: w, hit: picks.length ? r4(w / picks.length) : null,
      zPP: picks.length ? r4(zOf(w, picks.length, BE.pp)) : null, zP6: picks.length ? r4(zOf(w, picks.length, BE.p6)) : null, zBook110: picks.length ? r4(zOf(w, picks.length, BE.book110)) : null,
      over: { n: overPicks.length, hit: overPicks.length ? r4(overPicks.filter(r => r.win).length / overPicks.length) : null },
      under: { n: underPicks.length, hit: underPicks.length ? r4(underPicks.filter(r => r.win).length / underPicks.length) : null } },
    bands };
}
function scoreBy(rows, f) {
  const by = {};
  for (const r of rows) (by[f(r)] ||= []).push(r);
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([k, rs]) => [k, score(rs)]));
}

// ── test 1: the book's main lines ESPN kept (props/<event>.json.gz) ─────────
const BOOK_TYPES = { 'Total Receiving Yards': 'rec_yds', 'Total Rushing Yards': 'rush_yds', 'Total Passing Yards': 'pass_yds', 'Total Receptions': 'receptions',
  'Total Passing Touchdowns': 'pass_tds', 'Longest Reception': 'longest_rec', 'Total Carries': 'rush_att', 'Total Kicking Points': 'kicking_points',
  'Total Field Goals Made': 'fg_made', 'Total Passing Attempts': 'pass_att', 'Total Pass Completions': 'pass_comp', 'Longest Rush': 'longest_rush',
  'Total Rushing Plus Receiving Yards': 'rush_rec_yds', 'Total Passing Plus Rushing Yards': 'pass_rush_yds' };
const bookStat = name => BOOK_TYPES[String(name || '').replace(/\s*\(incl\. overtime\)\s*$/, '')] || null;
// one event's props → Map(aid|stat → main line): the half line listed as an over/under pair
function bookLines(props) {
  const out = new Map();
  for (const pid of ['58', '59']) {
    const its = props?.[pid];
    if (!its) continue;
    const m = new Map();
    for (const [aid, type, , , , , target] of its) {
      const stat = bookStat(type);
      if (!stat || !Number.isFinite(target) || Math.abs((target * 2) % 2) !== 1) continue;
      const k = `${aid}|${stat}`;
      const c = (m.get(k) || m.set(k, new Map()).get(k));
      c.set(target, (c.get(target) || 0) + 1);
    }
    for (const [k, c] of m) {
      if (out.has(k)) continue;
      const pairs = [...c].filter(([, n]) => n >= 2);
      if (pairs.length === 1) out.set(k, pairs[0][0]);
    }
  }
  return out;
}
function bookTest(dirs, params, seasons) {
  const games = loadGames(dirs);
  const H = M.buildHistory(games);
  const rows = [];
  let lines = 0, noProj = 0, notInBox = 0;
  for (const g of games) {
    if (!seasons.includes(g.season)) continue;
    let props = null;
    for (const dir of dirs) { const f = path.join(dir, 'props', `${g.id}.json.gz`); if (fs.existsSync(f)) { props = JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); break; } }
    if (!props) continue;
    const byAid = new Map(g.players.map(p => [p.aid, p]));
    for (const [k, line] of bookLines(props)) {
      lines++;
      const [aid, stat] = k.split('|');
      const p = byAid.get(aid);
      if (!p) { notInBox++; continue; }   // not in the box: void, as the books settle a player who doesn't play
      const home = p.team === g.home;
      const spread = Number.isFinite(g.spread) ? (home ? g.spread : -g.spread) : null;
      const proj = M.project(H, aid, { t: g.t, team: p.team, opp: home ? g.away : g.home, total: g.total, spread }, params);
      const pOver = proj ? M.probOver(proj, stat, line, params) : null;
      if (pOver == null) { noProj++; continue; }
      const actual = M.statOf(p, stat);
      rows.push({ gid: g.id, season: g.season, week: g.week, aid, name: p.name, stat, line, mean: r4(proj.mean[stat]), pOver: r4(pOver), actual, over: actual > line ? 1 : 0 });
    }
  }
  return { lines, notInBox, noProj, rows };
}

// ── test 2: the apps' 2026 lines we recorded before kickoff ─────────────────
// legs: weekend board legs.json.gz rows ({ app, player, team, mkey, start, open, bet: { v: [line, overMult,
// underMult, ...], books } }) and live record rows ({ book, player, team, mkey, start, signalLine, signalMult }).
// The line is the board's bet read (about an hour before the start), else its open read.
function appLegs(boardFiles, recordDirs) {
  const legs = new Map();
  const { canonName } = require('../ev');
  const add = L => {
    const k = [canonName(L.player), L.mkey, L.app, L.line, String(L.start).slice(0, 10)].join('|');
    if (!legs.has(k)) legs.set(k, L);
  };
  for (const f of boardFiles) {
    for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(f)))) {
      if (r.sport !== 'CFB') continue;
      const read = r.bet || null;
      const line = read ? read.v?.[0] : r.open?.line;
      if (!Number.isFinite(line)) continue;
      if (read && Number(read.t) >= Date.parse(r.start)) continue;   // never a read at or after the start
      const v = read?.v || [];
      add({ src: 'board', app: r.app, player: r.player, team: r.team, mkey: r.mkey, start: r.start, line, overMult: v[1] ?? null, underMult: v[2] ?? null,
        fd: read?.books?.fanduel?.exact && Number.isFinite(read.books.fanduel.pOver) ? read.books.fanduel.pOver : null,
        pin: read?.books?.pinnacle?.exact && Number.isFinite(read.books.pinnacle.pOver) ? read.books.pinnacle.pOver : null });
    }
  }
  for (const dir of recordDirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      for (const p of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        if (p.sport !== 'CFB' || !Number.isFinite(Number(p.signalLine))) continue;
        if (Date.parse(p.signalAt) >= Date.parse(p.start)) continue;
        const std = Number(p.signalMult) === 1;
        add({ src: 'record', app: p.book, player: p.player, team: p.team, mkey: p.mkey, start: p.start, line: Number(p.signalLine),
          overMult: std ? 1 : (p.signalSide === 'Over' ? Number(p.signalMult) : null), underMult: std ? 1 : (p.signalSide === 'Under' ? Number(p.signalMult) : null), fd: null, pin: null });
      }
    }
  }
  return [...legs.values()];
}
// the leg's game and player: a 2026 game within 4 hours of the start whose box holds one player of that name
function appTest(dirs, params, legs) {
  const { canonName } = require('../ev');
  const games = loadGames(dirs);
  const H = M.buildHistory(games);
  const g26 = games.filter(g => g.season === 2026);
  const rows = [];
  const miss = { stat: 0, game: 0, proj: 0 };
  for (const L of legs) {
    if (!M.STATS.includes(L.mkey)) { miss.stat++; continue; }
    const t = Date.parse(L.start), key = canonName(L.player);
    const hits = [];
    for (const g of g26) if (Math.abs(g.t - t) < 4 * 3600e3) for (const p of g.players) if (p.key === key) hits.push({ g, p });
    if (hits.length !== 1) { miss.game++; continue; }
    const { g, p } = hits[0];
    const home = p.team === g.home;
    const spread = Number.isFinite(g.spread) ? (home ? g.spread : -g.spread) : null;
    const proj = M.project(H, p.aid, { t: g.t, team: p.team, opp: home ? g.away : g.home, total: g.total, spread }, params);
    const ok = proj && !((L.mkey === 'fg_made' || L.mkey === 'kicking_points') && !proj.kicker) && !(L.mkey.startsWith('pass_') && !proj.passer);
    const pOver = ok ? M.probOver(proj, L.mkey, L.line, params) : null;
    if (pOver == null) { miss.proj++; continue; }
    const actual = M.statOf(p, L.mkey);
    if (actual === L.line) continue;   // a push on a whole line
    rows.push({ ...L, gid: g.id, aid: p.aid, stat: L.mkey, mean: r4(proj.mean[L.mkey]), pOver: r4(pOver), actual, over: actual > L.line ? 1 : 0 });
  }
  return { rows, miss };
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'fit') { const seasons = (process.env.SEASONS || '2024').split(',').map(Number); process.stdout.write(JSON.stringify(fit(rest, seasons))); }
  else if (cmd === 'seed') {
    const out = rest.pop();
    const games = loadGames(rest);
    fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(games)));
    console.error('seed games', games.length);
  } else if (cmd === 'book') {
    // node scripts/cfbmodel-backtest.js book <params.json> <season> <dirs...> → report JSON; rows to $ROWS
    const [pf, season, ...dirs] = rest;
    const params = { ...M.PARAMS, ...JSON.parse(fs.readFileSync(pf, 'utf8')) };
    const t = bookTest(dirs, params, [Number(season)]);
    if (process.env.ROWS) fs.writeFileSync(process.env.ROWS, JSON.stringify(t.rows));
    process.stdout.write(JSON.stringify({ season: Number(season), lines: t.lines, notInBox: t.notInBox, noProjection: t.noProj, all: score(t.rows), byStat: scoreBy(t.rows, r => r.stat) }, null, 1));
  } else if (cmd === 'apps') {
    // node scripts/cfbmodel-backtest.js apps <params.json> <legs.json.gz,...> <recordDir,...> <dirs...>
    const [pf, boards, recs, ...dirs] = rest;
    const params = { ...M.PARAMS, ...JSON.parse(fs.readFileSync(pf, 'utf8')) };
    const legs = appLegs(boards.split(',').filter(Boolean), recs.split(',').filter(Boolean));
    const { rows, miss } = appTest(dirs, params, legs);
    if (process.env.ROWS) fs.writeFileSync(process.env.ROWS, JSON.stringify(rows));
    const std = rows.filter(r => r.app === 'prizepicks' || (r.app === 'pick6' && r.overMult === 1 && r.underMult === 1));
    process.stdout.write(JSON.stringify({ legs: legs.length, miss, scored: rows.length,
      byApp: scoreBy(rows, r => r.app), ppStandard: score(std.filter(r => r.app === 'prizepicks')), byStatPP: scoreBy(std.filter(r => r.app === 'prizepicks'), r => r.stat),
      withFanDuel: (() => { const f = rows.filter(r => r.fd != null); return { n: f.length, model: f.length ? score(f).brier : null, fanduel: f.length ? r4(f.reduce((a, r) => a + (r.fd - r.over) ** 2, 0) / f.length) : null }; })(),
      withPinnacle: (() => { const f = rows.filter(r => r.pin != null); return { n: f.length, model: f.length ? score(f).brier : null, pinnacle: f.length ? r4(f.reduce((a, r) => a + (r.pin - r.over) ** 2, 0) / f.length) : null }; })() }, null, 1));
  } else { console.error('usage: fit <dirs...> | seed <dirs...> <out.gz>'); process.exit(1); }
}

module.exports = { loadGames, projectAll, rowsFor, FLOOR, fit, score, scoreBy, bookLines, bookStat, bookTest, appLegs, appTest, BE };
