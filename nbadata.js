// ─── NBA MODEL: LIVE DATA AND THE MODEL SECTION ───────────────────────────────
// Feeds nbamodel.js on the server: the shipped seed (every ESPN box score from
// last season to the seed date, seeds/nba-games.json.gz), every finished game
// since (ESPN scoreboard + summary, read every 30 minutes), tonight's schedule
// with ESPN's pre-game spread and total, and ESPN's injury list (Out players
// free minutes for their teammates). Then it prices the props board's NBA rows
// at each app's own number.
//
// A model view: "model, not an edge" until its own record (kind nba-model,
// graded nightly off the box scores like every sports leg) reaches 50 graded
// live legs with the hit rate z 2+ above the app's break-even. No alerts.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('./nbamodel');
const { canonName } = require('./ev');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const SEED = path.join(__dirname, 'seeds', 'nba-games.json.gz');
const BACKTEST = path.join(__dirname, 'seeds', 'nba-model-backtest.json');
// ESPN's abbreviations are the keys ("GS", "NY", "UTAH"); the apps' ("GSW", "NYK", "UTA") map onto them
const ABBR_FIX = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN' };
const fixAbbr = a => ABBR_FIX[String(a || '').toUpperCase()] || String(a || '').toUpperCase();
const ymd = t => new Date(t - 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');   // US Eastern date

// the stats the model prices, under the props board's keys
const MODEL_STATS = new Set(M.STATS);
// the confident side the record logs: the model's side at or above this, on
// PrizePicks and Pick6 standard lines (pre-registered 10-25, PREREGISTERED.md)
const PICK_MIN = 0.58;

function loadSeed(file = SEED) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); } catch { return []; }
}
function loadBacktest(file = BACKTEST) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ESPN scoreboard event → { id, t, home, away, done, total, spread, homeName, awayName }
function scheduleOf(ev) {
  const c = ev?.competitions?.[0];
  const cs = c?.competitors || [];
  const h = cs.find(x => x.homeAway === 'home'), a = cs.find(x => x.homeAway === 'away');
  if (!h || !a) return null;
  const home = fixAbbr(h.team?.abbreviation), away = fixAbbr(a.team?.abbreviation);
  const o = (c.odds || [])[0] || null;
  const { total, spread } = M.spreadOf(o ? [o] : null, home, away);
  return { id: String(ev.id), t: Date.parse(ev.date), home, away, done: !!c.status?.type?.completed, total, spread,
    homeName: h.team?.displayName || '', awayName: a.team?.displayName || '', stype: ev.season?.type ?? null };
}
// ESPN's injury list → Map(team abbr → Set(player key)) of players listed Out
// (Doubtful counts as out; Questionable and Day-To-Day do not)
function outsOf(data) {
  const out = new Map();
  for (const tm of data?.injuries || []) {
    const abbr = fixAbbr(tm.team?.abbreviation || tm.abbreviation || '');
    for (const i of tm.injuries || []) {
      const st = String(i.status || i.fantasyStatus?.description || '').toLowerCase();
      if (!/^(out|doubtful)/.test(st)) continue;
      const name = i.athlete?.displayName;
      if (!name || !abbr) continue;
      (out.get(abbr) || out.set(abbr, new Set()).get(abbr)).add(canonName(name));
    }
  }
  return out;
}

// team name or abbreviation on a props row → ESPN abbreviation, via the
// schedule's names ("Golden State Warriors", "GSW", "Warriors")
function teamMatches(abbr, name, s) {
  const t = String(s || '').toLowerCase().trim();
  if (!t) return false;
  if (fixAbbr(t) === abbr) return true;
  const n = String(name || '').toLowerCase();
  return !!n && (n === t || n.endsWith(` ${t}`) || t.endsWith(n.split(' ').pop()));
}

function createNbaModel({ http, now = () => Date.now(), seed = null, params = M.PARAMS, log = () => {} } = {}) {
  const games = new Map();
  for (const g of seed || loadSeed()) if (g && g.id) games.set(g.id, g);
  let H = M.buildHistory([...games.values()].filter(g => g.stype !== 1));
  const state = { schedule: [], outs: new Map(), refreshedAt: null, injuriesAt: null, errors: [], seedGames: games.size, added: 0,
    backtest: loadBacktest() };
  let running = null;

  async function readDay(d) {
    const r = await http.get(`${ESPN}/scoreboard`, { params: { dates: d, limit: 100 }, timeout: 20000 });
    return (r?.data?.events || []).map(scheduleOf).filter(Boolean);
  }
  async function refresh() {
    if (running) return running;
    running = (async () => {
      const errs = [];
      const t0 = now();
      // finished games since the newest one we hold (seed or read), and the next two days' schedule
      const newest = Math.max(0, ...[...games.values()].map(g => g.t || 0));
      const from = Math.max(newest - 2 * 86400e3, t0 - 21 * 86400e3);
      const days = [];
      for (let t = from; t <= t0 + 2 * 86400e3; t += 86400e3) days.push(ymd(t));
      const sched = [];
      for (const d of [...new Set(days)]) {
        try { sched.push(...await readDay(d)); } catch (e) { errs.push(`scoreboard ${d}: ${e.message}`); }
      }
      let added = 0;
      for (const s of new Map(sched.map(x => [x.id, x])).values()) {
        if (!s.done || games.has(s.id)) continue;
        try {
          const r = await http.get(`${ESPN}/summary`, { params: { event: s.id }, timeout: 20000 });
          const d = r?.data || {};
          const g = M.compactGame({ id: s.id, players: d.boxscore?.players, comp: d.header?.competitions?.[0], pickcenter: d.pickcenter });
          if (g) {
            g.stype = s.stype; g.home = fixAbbr(g.home); g.away = fixAbbr(g.away);
            for (const p of g.players) p.team = fixAbbr(p.team);
            const dnp = {}; for (const [k, v] of Object.entries(g.dnp || {})) dnp[fixAbbr(k)] = v; g.dnp = dnp;
            if (g.total == null && s.total != null) { g.total = s.total; g.spread = s.spread; }
            games.set(g.id, g); added++;
          }
        } catch (e) { errs.push(`summary ${s.id}: ${e.message}`); }
      }
      if (added) H = M.buildHistory([...games.values()].filter(g => g.stype !== 1));
      state.added += added;
      const byId = new Map(sched.map(s => [s.id, s]));
      state.schedule = [...byId.values()].filter(s => !s.done && s.t > t0 - 4 * 3600e3);
      try {
        const r = await http.get(`${ESPN}/injuries`, { timeout: 20000 });
        state.outs = outsOf(r?.data);
        state.injuriesAt = new Date(now()).toISOString();
      } catch (e) { errs.push(`injuries: ${e.message}`); }
      state.refreshedAt = new Date(now()).toISOString();
      state.errors = errs.slice(0, 10);
      if (errs.length) log(`NBA model: ${errs.length} read errors (${errs[0]})`);
    })().finally(() => { running = null; });
    return running;
  }

  // the game a props row belongs to: the player's team (row, else his last
  // team on record) playing within 4 hours of the row's start
  function gameFor(row, key) {
    const t = Date.parse(row.startTime || row.start || '');
    if (!Number.isFinite(t)) return null;
    const hist = H.players.get(key);
    const last = hist && hist.length ? hist[hist.length - 1] : null;
    const near = state.schedule.filter(s => Math.abs(s.t - t) < 4 * 3600e3);
    for (const s of near) {
      const team = [s.home, s.away].find(a => (last && last.team === a) || teamMatches(a, a === s.home ? s.homeName : s.awayName, row.team));
      if (team) return { ...s, team, opp: team === s.home ? s.away : s.home, isHome: team === s.home };
    }
    return null;
  }
  const projCache = new Map();
  function projectionFor(row) {
    const key = canonName(row.player);
    const g = gameFor(row, key);
    if (!g) return { reason: 'no game on the NBA schedule for this player' };
    const ck = `${key}|${g.id}|${state.refreshedAt}`;
    if (projCache.has(ck)) return projCache.get(ck);
    const out = [...(state.outs.get(g.team) || [])];
    if (out.includes(key)) { const r = { reason: 'listed Out on the injury report', game: g }; projCache.set(ck, r); return r; }
    const proj = M.project(H, key, { t: g.t, team: g.team, opp: g.opp, home: g.isHome, total: g.total, spread: g.spread, out }, params);
    const r = proj ? { proj, game: g, outs: out.filter(k => k !== key) } : { reason: 'no NBA minutes on record', game: g };
    if (projCache.size > 5000) projCache.clear();
    projCache.set(ck, r);
    return r;
  }

  // props board rows → the NBA MODEL section: one entry per player and stat
  // with each app's line priced, Pinnacle's no-vig P(over) at its own line
  function section(rows, { pinAt = () => null } = {}) {
    const out = [];
    for (const row of rows || []) {
      if (row.sport !== 'NBA' || !MODEL_STATS.has(row.mkey)) continue;
      const p = projectionFor(row);
      if (!p.proj) continue;
      const apps = {};
      for (const [book, cell] of Object.entries(row.books || {})) {
        if (!Number.isFinite(cell?.line)) continue;
        const pr = M.priceLine(p.proj, row.mkey, cell.line, params);
        if (pr) apps[book] = { line: cell.line, pOver: pr.pOver, side: pr.side, pSide: pr.pSide, over: cell.over ?? null, under: cell.under ?? null };
      }
      if (!Object.keys(apps).length) continue;
      const pin = pinAt(row);
      const best = Object.entries(apps).sort((a, b) => b[1].pSide - a[1].pSide)[0];
      out.push({ key: row.key, player: row.player, team: p.game.team, opp: p.game.opp, home: p.game.isHome, start: new Date(p.game.t).toISOString(),
        mkey: row.mkey, market: row.market || row.mkey, mean: Math.round(M.expected(p.proj, row.mkey) * 10) / 10,
        median: M.median(p.proj, row.mkey, params), minutes: Math.round(p.proj.minutes.mean * 10) / 10, minutesSd: Math.round(p.proj.minutes.sd * 10) / 10,
        b2b: p.proj.b2b, teammatesOut: p.outs.length, total: p.game.total, spread: p.game.spread,
        apps, pinnacle: pin && Number.isFinite(pin.line) ? { line: pin.line, pOver: pin.pOver, model: M.priceLine(p.proj, row.mkey, pin.line, params)?.pOver ?? null } : null,
        bestBook: best[0], bestSide: best[1].side, bestP: best[1].pSide });
    }
    return out.sort((a, b) => b.bestP - a.bestP);
  }

  // the record's legs: PrizePicks and Pick6 lines where the model's side is
  // PICK_MIN or more (one leg per player, stat, app and side; the tracker's id dedupes)
  function plays(rows) {
    const flagged = [];
    for (const row of rows || []) {
      if (row.sport !== 'NBA' || !MODEL_STATS.has(row.mkey)) continue;
      const t = Date.parse(row.startTime || '');
      if (!(t > now())) continue;
      for (const book of ['prizepicks', 'pick6']) {
        const cell = row.books?.[book];
        if (!cell || !Number.isFinite(cell.line)) continue;
        const p = projectionFor(row);
        if (!p.proj) continue;
        const pr = M.priceLine(p.proj, row.mkey, cell.line, params);
        if (!pr || pr.pSide < PICK_MIN) continue;
        // standard lines only (PrizePicks' board is standard already): a Pick6 side at a multiplier other than 1x pays on another table
        const mult = pr.side === 'Over' ? cell.over : cell.under;
        if (book === 'pick6' && mult != null && Number(mult) !== 1) continue;
        if (pr.side === 'Over' ? cell.overOpen === false : cell.underOpen === false) continue;
        flagged.push({ row, kind: book === 'pick6' ? 'p6-nba-model' : 'nba-model', research: true,
          play: { book, side: pr.side, line: cell.line, mult: 1, ev: +((pr.pSide / 0.5503 - 1) * 100).toFixed(2), fair: pr.pSide, modelMean: pr.mean } });
      }
    }
    return flagged;
  }
  // P(over) at a line for the record's close (the model's own number at the start)
  function fairAt(row, line) {
    const p = projectionFor(row);
    return p.proj ? M.priceLine(p.proj, row.mkey, line, params)?.pOver ?? null : null;
  }

  function status() {
    return { games: games.size, seedGames: state.seedGames, added: state.added, schedule: state.schedule.length,
      teamsWithOuts: state.outs.size, refreshedAt: state.refreshedAt, injuriesAt: state.injuriesAt, errors: state.errors };
  }
  return { refresh, projectionFor, section, plays, fairAt, status, state, history: () => H };
}

module.exports = { createNbaModel, scheduleOf, outsOf, fixAbbr, teamMatches, loadSeed, PICK_MIN, MODEL_STATS };
