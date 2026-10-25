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
const F = require('./farlines');

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
// Underdog pays its own multiplier per leg, so its legs are logged on value at
// that payout instead: the model's side worth UD_EV_MIN or more per unit at the
// real multiplier (pre-registered 10-25, checks/nba-model-v2-2026-10-25)
const UD_EV_MIN = 0.05;
// The model's version on every row and logged leg. The live record is never
// reset: legs logged before VERSION_AT were priced by v1.
const MODEL_VERSION = 'v2';
const VERSION_AT = '2026-10-25';
const VERSION_NOTE = 'v2 from 2026-10-25: adds teammates out for injury (refitted), defence by position, last season fading as this season\'s games pile up, and a calibration fitted on 2024-25 sportsbook lines (v1 was overconfident). Legs logged before then were priced by v1; the record carries on, never reset.';
const { legDecimal } = require('./sporttrack');
const PP_BE = 0.5503;
// the model's value at an app's real payout for the side it leans: the leg's
// decimal (PrizePicks 3-pick Power, Pick6 3-pick table times its multiplier,
// Underdog's multiplier, Sleeper's) and P(side) x decimal - 1

// a section row's far summary: far = some app's line is 1+ of our sds from the
// projection (and Pinnacle's line does not sit toward it); farD = the largest |d|, signed
function farOfApps(apps) {
  const cells = Object.values(apps).filter(a => a.far && a.pinAgree !== 'toward');
  if (!cells.length) return { far: false, farD: null };
  const top = cells.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  return { far: true, farD: top.d };
}

function payoutFor(book, side, pSide, cell) {
  const mult = side === 'Over' ? cell?.over : cell?.under;
  const other = side === 'Over' ? cell?.under : cell?.over;
  if (mult === 0 || mult === false) return null;   // that side isn't offered
  // PrizePicks: the 3-pick Power break-even the record is judged on (55.03%)
  const dec = book === 'prizepicks' ? 1 / PP_BE : legDecimal(book, mult == null ? 1 : mult, other == null ? null : other);
  if (!(dec > 1)) return null;
  return { decimal: Math.round(dec * 1000) / 1000, breakEven: Math.round(1e4 / dec) / 1e4, ev: Math.round((pSide * dec - 1) * 1e4) / 1e4 };
}

function loadSeed(file = SEED) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); } catch { return []; }
}
function loadBacktest(file = BACKTEST) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ESPN scoreboard event → { id, t, home, away, done, total, spread, homeName, awayName }
// teamKey: the team's key (the NBA's fixed abbreviation; the college model's
// ESPN team id); minTotal: the lowest believable pre-game total
function scheduleOf(ev, { teamKey = t => fixAbbr(t?.abbreviation), minTotal = 150 } = {}) {
  const c = ev?.competitions?.[0];
  const cs = c?.competitors || [];
  const h = cs.find(x => x.homeAway === 'home'), a = cs.find(x => x.homeAway === 'away');
  if (!h || !a) return null;
  const home = teamKey(h.team), away = teamKey(a.team);
  const o = (c.odds || [])[0] || null;
  const { total, spread } = M.spreadOf(o ? [o] : null, home, away, minTotal);
  return { id: String(ev.id), t: Date.parse(ev.date), home, away, done: !!c.status?.type?.completed, total, spread,
    homeName: h.team?.displayName || '', awayName: a.team?.displayName || '', stype: ev.season?.type ?? null,
    homeAbbr: h.team?.abbreviation || home, awayAbbr: a.team?.abbreviation || away };
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

// The NBA's settings. The college basketball model (cbbdata.js) runs the same
// layer with its own: ESPN path, team and player keys, kinds, seed, version.
const NBA = {
  sport: 'NBA', label: 'NBA', espn: ESPN, scoreParams: { limit: 100 }, seed: SEED, backtest: BACKTEST, injuries: true,
  kinds: { prizepicks: 'nba-model', pick6: 'p6-nba-model', underdog: 'ud-nba-model' }, version: MODEL_VERSION,
  // players keyed by canonical name (indexNames false) or by id with a name index
  indexNames: false, schedOpts: {}, compactOpts: {}, fixTeam: fixAbbr,
  // a schedule team that matches the props row's team text
  teamMatch: (abbr, name, s) => teamMatches(abbr, name, s),
};

function createNbaModel({ http, now = () => Date.now(), seed = null, params = M.PARAMS, log = () => {}, sport = {} } = {}) {
  const C = { ...NBA, ...sport };
  const games = new Map();
  for (const g of seed || loadSeed(C.seed)) if (g && g.id) games.set(g.id, g);
  // sports keyed by player id: canonical name → [keys]
  let H, names = new Map();
  const projCache = new Map();
  const rebuild = () => {
    H = M.buildHistory([...games.values()].filter(g => g.stype !== 1), params);
    if (C.indexNames) {
      names = new Map();
      for (const [k, list] of H.players) { const n = canonName(list[list.length - 1]?.name || ''); if (n) (names.get(n) || names.set(n, []).get(n)).push(k); }
    }
    projCache.clear();
  };
  rebuild();
  const keysFor = name => C.indexNames ? (names.get(canonName(name)) || []) : [canonName(name)];
  const state = { schedule: [], outs: new Map(), refreshedAt: null, injuriesAt: null, errors: [], seedGames: games.size, added: 0,
    backtest: loadBacktest(C.backtest) };
  let running = null;

  async function readDay(d) {
    const r = await http.get(`${C.espn}/scoreboard`, { params: { dates: d, ...C.scoreParams }, timeout: 20000 });
    return (r?.data?.events || []).map(ev => scheduleOf(ev, C.schedOpts)).filter(Boolean);
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
          const r = await http.get(`${C.espn}/summary`, { params: { event: s.id }, timeout: 20000 });
          const d = r?.data || {};
          const g = M.compactGame({ id: s.id, players: d.boxscore?.players, comp: d.header?.competitions?.[0], pickcenter: d.pickcenter }, C.compactOpts);
          if (g) {
            const fx = C.fixTeam;
            g.stype = s.stype; g.home = fx(g.home); g.away = fx(g.away);
            for (const p of g.players) p.team = fx(p.team);
            const dnp = {}; for (const [k, v] of Object.entries(g.dnp || {})) dnp[fx(k)] = v; g.dnp = dnp;
            if (g.total == null && s.total != null) { g.total = s.total; g.spread = s.spread; }
            games.set(g.id, g); added++;
          }
        } catch (e) { errs.push(`summary ${s.id}: ${e.message}`); }
      }
      if (added) rebuild();
      state.added += added;
      const byId = new Map(sched.map(s => [s.id, s]));
      state.schedule = [...byId.values()].filter(s => !s.done && s.t > t0 - 4 * 3600e3);
      if (C.injuries) {
        try {
          const r = await http.get(`${C.espn}/injuries`, { timeout: 20000 });
          state.outs = outsOf(r?.data);
          state.injuriesAt = new Date(now()).toISOString();
        } catch (e) { errs.push(`injuries: ${e.message}`); }
      }
      state.refreshedAt = new Date(now()).toISOString();
      state.errors = errs.slice(0, 10);
      if (errs.length) log(`${C.label} model: ${errs.length} read errors (${errs[0]})`);
    })().finally(() => { running = null; });
    return running;
  }

  // the game a props row belongs to: the player's team (row, else his last
  // team on record) playing within 4 hours of the row's start
  // strict: only his own last team counts, never the row's team text (a name
  // shared by several players must not borrow another one's game)
  function gameFor(row, key, strict = false) {
    const t = Date.parse(row.startTime || row.start || '');
    if (!Number.isFinite(t)) return null;
    const hist = H.players.get(key);
    const last = hist && hist.length ? hist[hist.length - 1] : null;
    const near = state.schedule.filter(s => Math.abs(s.t - t) < 4 * 3600e3);
    for (const s of near) {
      const team = [s.home, s.away].find(a => (last && last.team === a) || (!strict && C.teamMatch(a, a === s.home ? s.homeName : s.awayName, row.team, a === s.home ? s.homeAbbr : s.awayAbbr)));
      if (team) return { ...s, team, opp: team === s.home ? s.away : s.home, isHome: team === s.home };
    }
    return null;
  }
  // a name can belong to several players (college): the one whose team plays
  // in this row's window, the most games on record first
  function projectionFor(row) {
    const keys = keysFor(row.player);
    let key = keys[0] ?? canonName(row.player), g = null;
    if (keys.length > 1) {
      const ranked = [...keys].sort((a, b) => (H.players.get(b)?.length || 0) - (H.players.get(a)?.length || 0));
      for (const k of ranked) { const x = gameFor(row, k, true); if (x) { key = k; g = x; break; } }
    } else g = gameFor(row, key);
    if (!g) return { reason: `no game on the ${C.label} schedule for this player` };
    const ck = `${key}|${g.id}|${state.refreshedAt}`;
    if (projCache.has(ck)) return projCache.get(ck);
    const out = [...(state.outs.get(g.team) || [])];
    if (out.includes(key)) { const r = { reason: 'listed Out on the injury report', game: g }; projCache.set(ck, r); return r; }
    const proj = M.project(H, key, { t: g.t, team: g.team, opp: g.opp, home: g.isHome, total: g.total, spread: g.spread, out }, params);
    const r = proj ? { proj, game: g, outs: out.filter(k => k !== key) } : { reason: `no ${C.label} minutes on record`, game: g };
    if (projCache.size > 5000) projCache.clear();
    projCache.set(ck, r);
    return r;
  }

  // props board rows → the NBA MODEL section: one entry per player and stat
  // with each app's line priced, Pinnacle's no-vig P(over) at its own line
  function section(rows, { pinAt = () => null } = {}) {
    const out = [];
    for (const row of rows || []) {
      if (row.sport !== C.sport || !MODEL_STATS.has(row.mkey)) continue;
      const p = projectionFor(row);
      if (!p.proj) continue;
      const apps = {};
      const pin = pinAt(row);
      for (const [book, cell] of Object.entries(row.books || {})) {
        if (!Number.isFinite(cell?.line)) continue;
        const pr = M.priceLine(p.proj, row.mkey, cell.line, params);
        if (!pr) continue;
        const pay = payoutFor(book, pr.side, pr.pSide, cell);
        apps[book] = { line: cell.line, pOver: pr.pOver, side: pr.side, pSide: pr.pSide, over: cell.over ?? null, under: cell.under ?? null,
          decimal: pay?.decimal ?? null, breakEven: pay?.breakEven ?? null, ev: pay?.ev ?? null };
        // the line's distance from our projection (farlines.js): d in the model's own sds, far at |d| >= 1;
        // pinAgree 'toward' = Pinnacle's line sits toward our projection (the stale play, not in the far record)
        const d = F.distance(pr.raw);
        if (d != null) {
          const fs = d > 0 ? 'Over' : 'Under';
          Object.assign(apps[book], { d, far: F.isFar(d), farSide: fs, pinAgree: F.agreeOf(fs, cell.line, pin && Number.isFinite(pin.line) ? pin.line : null) });
        }
      }
      if (!Object.keys(apps).length) continue;
      const best = Object.entries(apps).sort((a, b) => b[1].pSide - a[1].pSide)[0];
      // the best payout for the model's view: highest value per unit across the apps
      const bestPay = Object.entries(apps).filter(([, a]) => a.ev != null).sort((a, b) => b[1].ev - a[1].ev)[0] || null;
      const lab = k => k === p.game.home ? p.game.homeAbbr || k : k === p.game.away ? p.game.awayAbbr || k : k;
      out.push({ key: row.key, player: row.player, team: lab(p.game.team), opp: lab(p.game.opp), home: p.game.isHome, start: new Date(p.game.t).toISOString(),
        mkey: row.mkey, market: row.market || row.mkey, mean: Math.round(M.expected(p.proj, row.mkey, params) * 10) / 10,
        median: M.median(p.proj, row.mkey, params), minutes: Math.round(p.proj.minutes.mean * 10) / 10, minutesSd: Math.round(p.proj.minutes.sd * 10) / 10,
        b2b: p.proj.b2b, teammatesOut: p.outs.length, total: p.game.total, spread: p.game.spread,
        apps, pinnacle: pin && Number.isFinite(pin.line) ? { line: pin.line, pOver: pin.pOver, model: M.priceLine(p.proj, row.mkey, pin.line, params)?.pOver ?? null } : null,
        bestBook: best[0], bestSide: best[1].side, bestP: best[1].pSide,
        bestPay: bestPay ? { book: bestPay[0], side: bestPay[1].side, line: bestPay[1].line, ev: bestPay[1].ev, breakEven: bestPay[1].breakEven } : null,
        ...farOfApps(apps),
        version: C.version });
    }
    return out.sort((a, b) => b.bestP - a.bestP);
  }

  // the record's legs: PrizePicks and Pick6 lines where the model's side is
  // PICK_MIN or more (one leg per player, stat, app and side; the tracker's id dedupes)
  function plays(rows, { pinAt = () => null } = {}) {
    const flagged = [];
    for (const row of rows || []) {
      if (row.sport !== C.sport || !MODEL_STATS.has(row.mkey)) continue;
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
        flagged.push({ row, kind: C.kinds[book], research: true,
          play: { book, side: pr.side, line: cell.line, mult: 1, ev: +((pr.pSide / 0.5503 - 1) * 100).toFixed(2), fair: pr.pSide, modelMean: pr.mean, modelVersion: C.version } });
      }
      // Underdog: the model's side at UD's real multiplier, logged when it is worth UD_EV_MIN or more
      const ud = row.books?.underdog;
      if (ud && Number.isFinite(ud.line)) {
        const p = projectionFor(row);
        const pr = p.proj ? M.priceLine(p.proj, row.mkey, ud.line, params) : null;
        const pay = pr ? payoutFor('underdog', pr.side, pr.pSide, ud) : null;
        if (pr && pay && pay.ev >= UD_EV_MIN && !(pr.side === 'Over' ? ud.overOpen === false : ud.underOpen === false)) {
          const mult = pr.side === 'Over' ? ud.over : ud.under;
          flagged.push({ row, kind: C.kinds.underdog, research: true,
            play: { book: 'underdog', side: pr.side, line: ud.line, mult: mult == null ? 1 : mult, ev: +(pay.ev * 100).toFixed(2), fair: pr.pSide, modelMean: pr.mean, modelVersion: C.version } });
        }
      }
      // an app line far from our projection (farlines.js): kinds FAR_KINDS, research, own record (NBA only: the college model has no far-line kinds)
      const pf = C.sport === 'NBA' ? projectionFor(row) : {};
      if (pf.proj) {
        const pin = pinAt(row);
        flagged.push(...F.farPlays('NBA', row, line => M.priceLine(pf.proj, row.mkey, line, params), { pinLine: pin && Number.isFinite(pin.line) ? pin.line : null, payoutFor, version: MODEL_VERSION }));
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

module.exports = { createNbaModel, NBA, scheduleOf, outsOf, fixAbbr, teamMatches, loadSeed, payoutFor, PICK_MIN, UD_EV_MIN, MODEL_VERSION, VERSION_AT, VERSION_NOTE, MODEL_STATS };
