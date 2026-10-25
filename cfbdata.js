// ─── CFB MODEL: LIVE DATA AND THE MODEL SECTION ───────────────────────────────
// Feeds cfbmodel.js on the server, the same way nbadata.js feeds the NBA model:
// the shipped seed (ESPN FBS box scores from last season to the seed date,
// seeds/cfb-games.json.gz), every finished FBS game since (ESPN scoreboard +
// summary, read every 30 minutes), and the coming days' schedule with ESPN's
// pre-game spread and total. Then it prices the props board's CFB rows at each
// app's own number.
//
// A model view: "model, not an edge" until its own record (kind cfb-model,
// graded off the box scores like every sports leg) reaches 50 graded live legs
// with the hit rate z 2+ above the app's break-even. No alerts.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('./cfbmodel');
const { canonName } = require('./ev');
const { payoutFor } = require('./nbadata');
const F = require('./farlines');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const SEED = path.join(__dirname, 'seeds', 'cfb-games.json.gz');
const PARAMS_FILE = path.join(__dirname, 'seeds', 'cfb-model-params.json');
const BACKTEST = path.join(__dirname, 'seeds', 'cfb-model-backtest.json');
const ymd = t => new Date(t - 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');   // US Eastern date
const MODEL_STATS = new Set(M.STATS);
// the confident side the record logs (pre-registered 10-25): 58%+ on PrizePicks and Pick6 standard lines
const PICK_MIN = 0.58;
// Underdog pays its own multiplier per leg, so its legs are logged on value at
// that payout: the model's side worth UD_EV_MIN or more per unit at the real
// multiplier (as NBA v2; pre-registered 10-25, checks/cfb-model-v2-2026-10-25)
const UD_EV_MIN = 0.05;
// The model's version on every row and logged leg. The live record is never
// reset: legs logged before VERSION_AT were priced by v1.
const MODEL_VERSION = 'v2';
const VERSION_AT = '2026-10-25';
const VERSION_NOTE = 'v2 from 2026-10-25: same projections, plus a calibration fitted on ESPN BET\'s 2024-25 CFB main lines (v1 was overconfident: its 58%+ sides hit 54.9% held out). Legs logged before then were priced by v1; the record carries on, never reset.';

const readJson = (file, gz = false) => { try { const b = fs.readFileSync(file); return JSON.parse(gz ? zlib.gunzipSync(b) : b); } catch { return null; } };
const loadSeed = (file = SEED) => readJson(file, true) || [];
const loadParams = (file = PARAMS_FILE) => { const p = readJson(file); return p && p.dist ? { ...M.PARAMS, ...p } : null; };
const loadBacktest = (file = BACKTEST) => readJson(file);

// ESPN scoreboard event → { id, t, home, away (team ids), names, abbrs, done, total, spread (home's) }

// a section row's far summary: far = some app's line is 1+ of our sds from the
// projection (and Pinnacle's line does not sit toward it); farD = the largest |d|, signed
function farOfApps(apps) {
  const cells = Object.values(apps).filter(a => a.far && a.pinAgree !== 'toward');
  if (!cells.length) return { far: false, farD: null };
  const top = cells.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  return { far: true, farD: top.d };
}

function scheduleOf(ev) {
  const c = ev?.competitions?.[0];
  const cs = c?.competitors || [];
  const h = cs.find(x => x.homeAway === 'home'), a = cs.find(x => x.homeAway === 'away');
  if (!h || !a) return null;
  const { total, spread } = M.spreadOf(c.odds || null);
  return { id: String(ev.id), t: Date.parse(ev.date), home: String(h.team?.id || ''), away: String(a.team?.id || ''),
    homeName: h.team?.displayName || '', awayName: a.team?.displayName || '', homeAbbr: h.team?.abbreviation || '', awayAbbr: a.team?.abbreviation || '',
    done: !!c.status?.type?.completed, total, spread, season: ev.season?.year ?? null, week: ev.week?.number ?? null, stype: ev.season?.type ?? null };
}

// does a props row's team text ("Oregon Ducks", "ORE", "BAMA") name this side?
function teamMatches(abbr, name, s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!t) return false;
  if (t === String(abbr || '').toLowerCase()) return true;
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return !!n && (n === t || n.startsWith(`${t} `) || t.startsWith(n));
}

function createCfbModel({ http, now = () => Date.now(), seed = null, params = null, log = () => {} } = {}) {
  const games = new Map();
  for (const g of seed || loadSeed()) if (g && g.id) games.set(g.id, g);
  const P = params || loadParams() || M.PARAMS;
  let H = M.buildHistory([...games.values()]);
  const state = { schedule: [], refreshedAt: null, errors: [], seedGames: games.size, added: 0, backtest: loadBacktest(), fitted: P.fitted || null };
  let running = null;

  async function readDay(d) {
    const r = await http.get(`${ESPN}/scoreboard`, { params: { dates: d, groups: 80, limit: 300 }, timeout: 20000 });
    return (r?.data?.events || []).map(scheduleOf).filter(Boolean);
  }
  async function refresh() {
    if (running) return running;
    running = (async () => {
      const errs = [];
      const t0 = now();
      const newest = Math.max(0, ...[...games.values()].map(g => g.t || 0));
      const from = Math.max(newest - 2 * 86400e3, t0 - 21 * 86400e3);
      const days = [];
      for (let t = from; t <= t0 + 4 * 86400e3; t += 86400e3) days.push(ymd(t));
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
          const g = M.compactGame({ id: s.id, players: d.boxscore?.players, comp: d.header?.competitions?.[0], pickcenter: d.pickcenter },
            { season: s.season, week: s.week, stype: s.stype });
          if (g) {
            if (g.total == null && s.total != null) { g.total = s.total; g.spread = s.spread; }
            games.set(g.id, g); added++;
          }
        } catch (e) { errs.push(`summary ${s.id}: ${e.message}`); }
      }
      if (added) { H = M.buildHistory([...games.values()]); projCache.clear(); }
      state.added += added;
      state.schedule = [...new Map(sched.map(s => [s.id, s])).values()].filter(s => !s.done && s.t > t0 - 5 * 3600e3);
      state.refreshedAt = new Date(now()).toISOString();
      state.errors = errs.slice(0, 10);
      if (errs.length) log(`CFB model: ${errs.length} read errors (${errs[0]})`);
    })().finally(() => { running = null; });
    return running;
  }

  // the game a props row belongs to, and the player's ESPN id: a game within
  // 4 hours of the row's start whose rosters hold one player of that name
  // (the row's team text breaks a tie)
  function gameFor(row) {
    const t = Date.parse(row.startTime || row.start || '');
    if (!Number.isFinite(t)) return null;
    const ids = [...(H.names.get(canonName(row.player)) || [])];
    if (!ids.length) return null;
    const near = state.schedule.filter(s => Math.abs(s.t - t) < 4 * 3600e3);
    const hits = [];
    for (const s of near) for (const aid of ids) {
      const h = H.players.get(aid), last = h && h[h.length - 1];
      if (!last) continue;
      // a transfer's last team is last season's: the row's team text must then name the new one
      const team = [s.home, s.away].includes(last.team) ? last.team
        : [s.home, s.away].find(x => teamMatches(x === s.home ? s.homeAbbr : s.awayAbbr, x === s.home ? s.homeName : s.awayName, row.team));
      if (team) hits.push({ s, aid, team, onRoster: team === last.team });
    }
    const pick = hits.filter(x => x.onRoster).length === 1 ? hits.find(x => x.onRoster) : hits.length === 1 ? hits[0] : null;
    if (!pick) return null;
    const { s, aid, team } = pick;
    const isHome = team === s.home;
    return { ...s, aid, team, opp: isHome ? s.away : s.home, isHome, teamName: isHome ? s.homeName : s.awayName, oppName: isHome ? s.awayName : s.homeName };
  }
  const projCache = new Map();
  function projectionFor(row) {
    const g = gameFor(row);
    if (!g) return { reason: 'no FBS game on the schedule for this player' };
    const ck = `${g.aid}|${g.id}|${state.refreshedAt}`;
    if (projCache.has(ck)) return projCache.get(ck);
    const spread = Number.isFinite(g.spread) ? (g.isHome ? g.spread : -g.spread) : null;
    const proj = M.project(H, g.aid, { t: g.t, team: g.team, opp: g.opp, total: g.total, spread }, P);
    const r = proj ? { proj, game: g, spread } : { reason: 'not enough games on record', game: g };
    if (projCache.size > 5000) projCache.clear();
    projCache.set(ck, r);
    return r;
  }
  const priced = (proj, stat, line) => {
    if ((stat === 'fg_made' || stat === 'kicking_points') && !proj.kicker) return null;
    if (stat.startsWith('pass_') && !proj.passer) return null;
    return M.priceLine(proj, stat, line, P);
  };

  // props board rows → the CFB MODEL section (the NBA MODEL section's shape)
  function section(rows, { pinAt = () => null, bookAt = () => null } = {}) {
    const out = [];
    for (const row of rows || []) {
      if (row.sport !== 'CFB' || !MODEL_STATS.has(row.mkey)) continue;
      const p = projectionFor(row);
      if (!p.proj) continue;
      const apps = {};
      const pin = pinAt(row), fd = bookAt(row);
      for (const [book, cell] of Object.entries(row.books || {})) {
        if (!Number.isFinite(cell?.line)) continue;
        const pr = priced(p.proj, row.mkey, cell.line);
        if (!pr) continue;
        // each app's real payout for the model's side (PrizePicks 3-pick Power, Pick6 table x multiplier, Underdog's and Sleeper's multipliers)
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
      const bestPay = Object.entries(apps).filter(([, a]) => a.ev != null).sort((a, b) => b[1].ev - a[1].ev)[0] || null;
      out.push({ key: row.key, player: row.player, team: p.game.teamName, opp: p.game.oppName, home: p.game.isHome, start: new Date(p.game.t).toISOString(),
        mkey: row.mkey, market: row.market || row.mkey, mean: Math.round(M.expected(p.proj, row.mkey) * 10) / 10, median: M.median(p.proj, row.mkey, P),
        games: p.proj.games, total: p.game.total, spread: p.spread, apps,
        pinnacle: pin && Number.isFinite(pin.line) ? { line: pin.line, pOver: pin.pOver, model: priced(p.proj, row.mkey, pin.line)?.pOver ?? null } : null,
        book: fd && Number.isFinite(fd.line) ? { book: fd.book, line: fd.line, pOver: fd.pOver, model: priced(p.proj, row.mkey, fd.line)?.pOver ?? null } : null,
        bestBook: best[0], bestSide: best[1].side, bestP: best[1].pSide,
        bestPay: bestPay ? { book: bestPay[0], side: bestPay[1].side, line: bestPay[1].line, ev: bestPay[1].ev, breakEven: bestPay[1].breakEven } : null,
        ...farOfApps(apps),
        version: MODEL_VERSION });
    }
    return out.sort((a, b) => b.bestP - a.bestP);
  }

  // the record's legs: PrizePicks and Pick6 standard lines with the model's side at PICK_MIN+
  function plays(rows, { pinAt = () => null } = {}) {
    const flagged = [];
    for (const row of rows || []) {
      if (row.sport !== 'CFB' || !MODEL_STATS.has(row.mkey)) continue;
      const t = Date.parse(row.startTime || '');
      if (!(t > now())) continue;
      for (const book of ['prizepicks', 'pick6']) {
        const cell = row.books?.[book];
        if (!cell || !Number.isFinite(cell.line)) continue;
        const p = projectionFor(row);
        if (!p.proj) continue;
        const pr = priced(p.proj, row.mkey, cell.line);
        if (!pr || pr.pSide < PICK_MIN) continue;
        const mult = pr.side === 'Over' ? cell.over : cell.under;
        if (book === 'pick6' && mult != null && Number(mult) !== 1) continue;
        if (pr.side === 'Over' ? cell.overOpen === false : cell.underOpen === false) continue;
        flagged.push({ row, kind: book === 'pick6' ? 'p6-cfb-model' : 'cfb-model', research: true,
          play: { book, side: pr.side, line: cell.line, mult: 1, ev: +((pr.pSide / 0.5503 - 1) * 100).toFixed(2), fair: pr.pSide, modelMean: pr.mean, modelVersion: MODEL_VERSION } });
      }
      // Underdog: the model's side at UD's real multiplier, logged when it is worth UD_EV_MIN or more
      const ud = row.books?.underdog;
      if (ud && Number.isFinite(ud.line)) {
        const p = projectionFor(row);
        const pr = p.proj ? priced(p.proj, row.mkey, ud.line) : null;
        const mult = pr ? (pr.side === 'Over' ? ud.over : ud.under) : null;
        // a side with no multiplier read is not priced at 1x (it may not be offered)
        const pay = pr && mult != null ? payoutFor('underdog', pr.side, pr.pSide, ud) : null;
        if (pay && pay.ev >= UD_EV_MIN && !(pr.side === 'Over' ? ud.overOpen === false : ud.underOpen === false)) {
          flagged.push({ row, kind: 'ud-cfb-model', research: true,
            play: { book: 'underdog', side: pr.side, line: ud.line, mult, ev: +(pay.ev * 100).toFixed(2), fair: pr.pSide, modelMean: pr.mean, modelVersion: MODEL_VERSION } });
        }
      }
      // an app line far from our projection (farlines.js): kinds FAR_KINDS, research, own record
      const pf = projectionFor(row);
      if (pf.proj) {
        const pin = pinAt(row);
        flagged.push(...F.farPlays('CFB', row, line => priced(pf.proj, row.mkey, line), { pinLine: pin && Number.isFinite(pin.line) ? pin.line : null, payoutFor, version: MODEL_VERSION }));
      }
    }
    return flagged;
  }
  function fairAt(row, line) {
    const p = projectionFor(row);
    return p.proj ? priced(p.proj, row.mkey, line)?.pOver ?? null : null;
  }
  function status() {
    return { games: games.size, seedGames: state.seedGames, added: state.added, schedule: state.schedule.length,
      refreshedAt: state.refreshedAt, errors: state.errors, fitted: state.fitted ? { at: state.fitted.at, window: state.fitted.window } : null };
  }
  return { refresh, projectionFor, section, plays, fairAt, status, state, history: () => H, params: P };
}

module.exports = { createCfbModel, scheduleOf, teamMatches, loadSeed, loadParams, PICK_MIN, UD_EV_MIN, MODEL_VERSION, VERSION_AT, VERSION_NOTE, MODEL_STATS };
