// Lead-lag recorder (diag only, runs in GitHub Actions: Kalshi answers only there).
// Every game line Pinnacle prices pregame, read once a minute beside FanDuel,
// BetRivers, Gemini, Polymarket US and Kalshi, every change logged to
// out/changes.jsonl as { t, s: source, k: key, v } (v = [home|over, away|under(, draw)]
// American; exchanges are the cost to take that side, fee included; Pinnacle
// raw with its limit). Keys: sport|pinGameId|market|point (spreads: home's point).
// Meta (first sight of a key): home, away, start, league.
// env RUN_MIN (default 330), STOP_AT (ISO)
const fs = require('fs');
const axios = require('axios');
const pingames = require('../pingames');
const freebooks = require('../freebooks');
const geminibooks = require('../geminibooks');
const pmusbooks = require('../pmusbooks');
const xarb = require('../xarb');
const lldepth = require('./lldepth');
const llinplay = require('./llinplay');

const RUN_MS = +(process.env.RUN_MIN || 330) * 60e3;
const STOP_AT = Date.parse(process.env.STOP_AT || '') || Infinity;
fs.mkdirSync('out', { recursive: true });
const log = fs.createWriteStream('out/changes.jsonl', { flags: 'a' });
const stats = { startedAt: new Date().toISOString(), ticks: 0, reads: {}, errors: {}, errorN: {}, counts: {}, keys: {} };
const wait = ms => new Promise(r => setTimeout(r, ms));
const KEY = process.env.PINNACLE_GUEST_KEY || '';
const MAIN = { football: pingames.SPORTS.football, basketball: pingames.SPORTS.basketball, hockey: pingames.SPORTS.hockey, baseball: pingames.SPORTS.baseball };
const BOOK_SPORTS = ['nfl', 'ncaaf', 'nba', 'nhl', 'mlb'];
const KROOT = { KXNFL: 'nfl', KXNCAAF: 'ncaaf', KXNBA: 'nba', KXNHL: 'nhl', KXMLB: 'mlb', KXNCAAMB: 'ncaab', KXEPL: 'epl', KXLALIGA: 'laliga',
  KXBUNDESLIGA: 'bundesliga', KXSERIEA: 'seriea', KXLIGUE1: 'ligue1', KXMLS: 'mls', KXUCL: 'ucl', KXUEL: 'uel', KXLIGAMX: 'ligamx',
  KXEREDIVISIE: 'eredivisie', KXATP: 'tennis', KXWTA: 'tennis', KXUFC: 'ufc', KXKHL: 'khl', KXBRASILEIRAO: 'brasileirao' };
const kroot = s => String(s || '').toUpperCase().replace(/(GAME|MATCH|FIGHT|TOTAL|SPREAD)$/, '');
const fee = p => p + 0.07 * p * (1 - p);
const american = c => (c > 0 && c < 1 ? +(c >= 0.5 ? -100 * c / (1 - c) : 100 * (1 - c) / c).toFixed(1) : null);

// change log
const last = {};
let lines = 0;
function observe(src, entries, t) {
  const seen = last[src] || (last[src] = new Map());
  for (const [k, { v, m }] of entries) {
    const j = JSON.stringify(v);
    if (seen.get(k) === j) continue;
    const first = !seen.has(k);
    seen.set(k, j);
    log.write(JSON.stringify({ t, s: src, k, v, ...(first ? { m } : {}) }) + '\n'); lines++;
  }
  // a key not quoted this read: logged gone (a full read only)
  for (const k of [...seen.keys()]) if (!entries.has(k)) { seen.delete(k); log.write(JSON.stringify({ t, s: src, k, gone: 1 }) + '\n'); lines++; }
  stats.keys[src] = seen.size;
}

const depth = process.env.DEPTH === 'on' ? lldepth.createDepth({ http: axios, kget: (u, o) => kget(u, o), stats }) : null;
// in-play add-on (diag/llinplay.js): its own ~20 s loop, started once kget exists
let inplay = null;
let pinMain = { games: [], at: 0 }, pinExtra = { games: [], at: 0 }, gem = { books: {}, at: 0 }, pm = { books: {}, at: 0 };
let kseries = [], kseriesAt = 0, krows = [], krowsAt = 0;
const pmReader = pmusbooks.createPolymarketUsBooks({ http: axios });
const holdUntil = {};
async function guard(name, fn) {
  if (Date.now() < (holdUntil[name] || 0)) return;
  try { await fn(); stats.reads[name] = new Date().toISOString(); }
  catch (e) {
    const s = e.response?.status;
    stats.errors[name] = `${s || ''} ${e.message}`.slice(0, 200); stats.errorN[name] = (stats.errorN[name] || 0) + 1;
    if (s === 403 || s === 429) holdUntil[name] = Date.now() + 10 * 60e3;
  }
}

async function readPinMain() {
  const r = await pingames.fetchPinnacleGames(axios, { key: KEY, sports: MAIN });
  if (r.errors.length) stats.errors.pinMainSoft = r.errors.slice(0, 4).join('; ');
  if (r.games.length) pinMain = { games: r.games, at: Date.now() };
}
async function readPinExtra() {
  if (Date.now() - pinExtra.at < 110e3) return;
  const r = await pingames.fetchPinnacleGames(axios, { key: KEY, sports: { tennis: pingames.SPORTS.tennis, mma: pingames.SPORTS.mma }, leagues: { soccer: freebooks.PIN_SOCCER_LEAGUES } });
  if (r.errors.length) stats.errors.pinExtraSoft = r.errors.slice(0, 4).join('; ');
  if (r.games.length) pinExtra = { games: r.games, at: Date.now() };
}
async function readGemini() {
  const r = await geminibooks.fetchGemini(axios);
  if (r.errors.length) stats.errors.geminiSoft = r.errors.slice(0, 3).join('; ');
  if (r.events > 0) gem = { books: r.books, at: Date.now() };
}
async function readPm() {
  if (Date.now() - pm.at < 110e3) return;
  const r = await pmReader.read();
  if (r.errors.length) { stats.errors.pmSoft = r.errors.slice(0, 3).join('; '); if (r.errors.some(e => / 403/.test(e))) holdUntil.pm = Date.now() + 10 * 60e3; }
  if (r.games > 0) pm = { books: r.books, at: Date.now() };
  stats.counts.pm = { games: r.games, withLines: r.withLines, slugReads: r.slugReads };
}
// Kalshi's rate limit: retry a 429 with backoff, three series at a time
const kget = async (url, opts) => {
  for (let i = 0; ; i++) {
    try { return await axios.get(url, opts); }
    catch (e) { if (e.response?.status !== 429 || i >= 5) throw e; stats.counts.k429 = (stats.counts.k429 || 0) + 1; await wait(800 * (i + 1)); }
  }
};
const khttp = { get: kget };
async function readKalshi() {
  if (!kseries.length || Date.now() - kseriesAt > 6 * 3600e3) {
    const all = await xarb.fetchKalshiGameSeries(khttp);
    kseries = all.filter(x => KROOT[kroot(x)]); kseriesAt = Date.now();
    stats.counts.kseries = kseries.length;
  }
  const rows = [];
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < kseries.length) {
      const x = kseries[i++];
      const r = await xarb.fetchKalshiEvents(khttp, { seriesTicker: x, maxPages: 5, onPage: page => rows.push(...xarb.parseKalshiBinaries(page).map(r => ({ ...r, series: x }))) });
      if (r.errors.length) { failed++; stats.errors.kalshiSoft = `${x}: ${r.errors[0].message}`.slice(0, 200); }
    }
  }));
  stats.counts.kalshi = { rows: rows.length, failed };
  if (rows.length) { krows = rows; krowsAt = Date.now(); }
}

const kref = (id, buy) => (id ? { venue: 'kalshi', id, buy } : null);
// Kalshi rows → per merged game: entries keyed like the books'
function kalshiEntries(games, rows, t) {
  const out = new Map();
  const groups = pingames.groupRows(rows.filter(r => r.exchange === 'kalshi'));
  for (const g of groups) {
    const sport = KROOT[kroot(g.rows[0].series)];
    const [lo, hi] = g.window, mid = (lo + hi) / 2;
    const cands = [];
    for (const game of games) {
      if (game.sport_key !== sport) continue;
      const st = Date.parse(game.commence_time);
      if (!(st >= lo && st <= hi)) continue;
      const pol = pingames.sidesOf(g.teams, { home: game.home_team, away: game.away_team });
      if (pol) cands.push({ game, pol, d: Math.abs(st - mid) });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.d - b.d);
    if (cands.length > 1 && cands[0].d === cands[1].d) continue;
    const { game, pol } = cands[0];
    const isHome = label => { const i = g.teams.findIndex(x => pingames.sameTeam(label, x) || x === label); return i < 0 ? null : (i === 0) === (pol === 'same'); };
    const buyYes = r => (r.yesAsk != null ? american(fee(r.yesAsk)) : null), buyNo = r => (r.noAsk != null ? american(fee(r.noAsk)) : null);
    const m = { home: game.home_team, away: game.away_team, st: game.commence_time, tk: g.key };
    const base = `${game.sport_key}|${game.id}`;
    const ml = {};
    for (const r of g.rows) {
      if (r.tradable === false) continue;
      if (r.kind === 'teams' || r.game3) {
        if (r.game3?.pick === 'draw') ml.draw = buyYes(r);
        else { const h = isHome(r.outcomeLabel); if (h != null) ml[h ? 'home' : 'away'] = [buyYes(r), buyNo(r), r.yesAsk, r.noAsk, r.id]; }
        if (r.game3?.pick === 'draw') ml.drawId = r.id;
      } else if (r.kind === 'total' && Number.isFinite(r.line)) out.set(`${base}|totals|${r.line}`, { v: [buyYes(r), buyNo(r), r.yesAsk, r.noAsk], m, r: [kref(r.id, 'yes'), kref(r.id, 'no')] });
      else if (r.kind === 'spread' && Number.isFinite(r.line) && r.lineTeam) {
        const h = isHome(r.lineTeam);
        if (h == null) continue;
        const homePt = h ? -r.line : r.line;
        // YES = lineTeam covers; v in home/away order
        out.set(`${base}|spreads|${homePt}`, { v: h ? [buyYes(r), buyNo(r), r.yesAsk, r.noAsk] : [buyNo(r), buyYes(r), r.noAsk, r.yesAsk], m,
          r: h ? [kref(r.id, 'yes'), kref(r.id, 'no')] : [kref(r.id, 'no'), kref(r.id, 'yes')] });
      }
    }
    if (ml.home || ml.away) out.set(`${base}|h2h|`, { v: [ml.home?.[0] ?? null, ml.away?.[0] ?? null, ml.draw ?? null, ml.home?.[2] ?? null, ml.away?.[2] ?? null], m,
      r: [ml.home ? kref(ml.home[4], 'yes') : null, ml.away ? kref(ml.away[4], 'yes') : null, ml.drawId ? kref(ml.drawId, 'yes') : null] });
  }
  return out;
}

function bookEntries(games) {
  const by = {};
  for (const game of games) {
    const base = `${game.sport_key}|${game.id}`;
    const m = { home: game.home_team, away: game.away_team, st: game.commence_time };
    for (const bm of game.bookmakers || []) {
      const e = (by[bm.key] ||= new Map());
      for (const mk of bm.markets || []) {
        if (mk.key === 'h2h') {
          const h = mk.outcomes.find(o => o.name === game.home_team), a = mk.outcomes.find(o => o.name === game.away_team), d = mk.outcomes.find(o => o.name === 'Draw');
          if (h && a) e.set(`${base}|h2h|`, { v: [h.price, a.price, d?.price ?? null], m, r: [h.ref || null, a.ref || null, d?.ref || null] });
        } else if (mk.key === 'spreads') {
          for (const o of mk.outcomes) if (o.name === game.home_team) {
            const a = mk.outcomes.find(x => x.name === game.away_team && x.point === -o.point);
            if (a) e.set(`${base}|spreads|${o.point}`, { v: [o.price, a.price], m, r: [o.ref || null, a.ref || null] });
          }
        } else if (mk.key === 'totals') {
          for (const o of mk.outcomes) if (o.name === 'Over') {
            const u = mk.outcomes.find(x => x.name === 'Under' && x.point === o.point);
            if (u) e.set(`${base}|totals|${o.point}`, { v: [o.price, u.price], m, r: [o.ref || null, u.ref || null] });
          }
        }
      }
    }
  }
  return by;
}
// Pinnacle straight from its parsed games: raw prices, alt flag and limit
function pinEntries(pin, idOf) {
  const e = new Map();
  for (const g of pin) {
    const id = idOf(g);
    if (!id) continue;
    const base = `${id.sport}|pin-${g.id}`, m = { home: g.home, away: g.away, st: g.start, lg: g.league };
    if (g.ml) e.set(`${base}|h2h|`, { v: [...g.ml.raw.slice(0, 2), g.ml.raw[2] ?? null, g.ml.limit ?? null], m });
    for (const s of g.spreads) e.set(`${base}|spreads|${s.home}`, { v: [...s.raw, s.alt ? 1 : 0, s.limit ?? null], m });
    for (const x of g.totals) e.set(`${base}|totals|${x.line}`, { v: [...x.raw, x.alt ? 1 : 0, x.limit ?? null], m });
  }
  return e;
}

async function tick() {
  await Promise.all([guard('pinMain', readPinMain), guard('pinExtra', readPinExtra), guard('gemini', readGemini), guard('pm', readPm), guard('kalshi', readKalshi)]);
  const now = Date.now();
  const pinAll = [...(now - pinMain.at < 5 * 60e3 ? pinMain.games : []), ...(now - pinExtra.at < 6 * 60e3 ? pinExtra.games : [])];
  if (!pinAll.length) return;
  const extra = {};
  for (const src of [now - gem.at < 5 * 60e3 ? gem.books : {}, now - pm.at < 6 * 60e3 ? pm.books : {}]) for (const [s, gs] of Object.entries(src)) extra[s] = [...(extra[s] || []), ...gs];
  let read;
  try { read = await freebooks.fetchFreeBooks(axios, pinAll, { sports: BOOK_SPORTS, extra, maxKambiEvents: 150 }); stats.reads.books = new Date().toISOString(); }
  catch (e) { stats.errors.books = e.message.slice(0, 200); return; }
  if (read.errors.length) stats.errors.booksSoft = read.errors.slice(0, 5).join('; ');
  const games = Object.entries(read.games).flatMap(([s, gs]) => gs.map(g => ({ ...g, sport_key: s })));
  stats.counts.games = Object.fromEntries(Object.entries(read.games).map(([s, gs]) => [s, gs.length]));
  // every Pinnacle game read (not only the ones another venue lists), in the sport it was merged under
  const sportOf = new Map(games.map(g => [g.id, g.sport_key]));
  const t = Date.now();
  const books = bookEntries(games);
  delete books.pinnacle;   // Pinnacle from its own parse (limit, alt)
  const pinE = pinEntries(pinAll, g => (sportOf.has(`pin-${g.id}`) ? { sport: sportOf.get(`pin-${g.id}`) } : null));
  observe('pinnacle', pinE, t);
  for (const b of ['fanduel', 'betrivers']) observe(b, books[b] || new Map(), t);
  const venues = {};
  if (now - gem.at < 5 * 60e3) observe('gemini', venues.gemini = books.gemini || new Map(), t);
  if (now - pm.at < 6 * 60e3) observe('polymarketus', venues.polymarketus = books.polymarketus || new Map(), t);
  if (now - krowsAt < 3 * 60e3) observe('kalshi', venues.kalshi = kalshiEntries(games, krows, t), t);
  if (depth) { try { await depth.scan(t, pinE, venues); stats.reads.depth = new Date().toISOString(); } catch (e) { stats.errors.depth = String(e.stack || e).slice(0, 300); } }
}

function pushOut() {
  fs.writeFileSync('out/stats.json', JSON.stringify({ ...stats, lines, at: new Date().toISOString() }));
}
(async () => {
  if (process.env.INPLAY === 'on') { try { inplay = llinplay.createInplay({ http: axios, kget: (u, o) => kget(u, o), stats }); } catch (e) { stats.errors.inplay = String(e.stack || e).slice(0, 300); } }
  const t0 = Date.now();
  let lastPush = 0;
  while (Date.now() - t0 < RUN_MS && Date.now() < STOP_AT) {
    const s = Date.now();
    try { await tick(); } catch (e) { stats.errors.tick = String(e.stack || e).slice(0, 300); }
    stats.ticks++;
    if (Date.now() - lastPush > 60e3) { lastPush = Date.now(); pushOut(); }
    if (stats.ticks % 10 === 1) console.log(new Date().toISOString(), JSON.stringify(stats.keys), lines);
    await wait(Math.max(2000, 60e3 - (Date.now() - s)));
  }
  await new Promise(r => log.end(r));
  if (depth) await depth.end();
  if (inplay) { try { await inplay.end(); } catch (e) { stats.errors.inplayEnd = String(e).slice(0, 200); } }
  stats.endedAt = new Date().toISOString();
  pushOut();
  process.exit(0);
})();
