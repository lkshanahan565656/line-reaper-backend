// ─── PROPS BOARD: EVERY BOOK'S PLAYER LINES SIDE BY SIDE ─────────────────────
// Underdog, PrizePicks and Sleeper post the same player props in their own
// words, sport labels and lines. This lines them up: one row per player and
// stat, each book's line and payout in its own cell, and a fair price per
// line where one exists (Kalshi player ladders for sports, our model for
// esports). Pure functions; the server feeds the caches in.

const { canonName, canonMarket } = require('./ev');

// PrizePicks splits halves, quarters, periods and specials into leagues of
// their own ("NFL1H", "NHL1P", "NBAP"). Each becomes its base sport, with the
// period carried on the stat so a first-half line never meets a full-game one.
const PP_LEAGUES = [
  [/^(.+?)1H$/, '1H '], [/^(.+?)2H$/, '2H '], [/^(.+?)1Q$/, '1Q '], [/^(.+?)1P$/, '1P '],
  [/^(.+?)SZN$/, 'Season '], [/^(.+?)LIVE$/, ''], [/^(NBA|WNBA|NHL|NFL|MLB)P$/, ''],
];
const SPORT_ALIASES = { CS2: 'CS', CSGO: 'CS', LOL: 'LOL', 'LEAGUE OF LEGENDS': 'LOL', VALORANT: 'VAL', DOTA2: 'DOTA',
  FIFA: 'SOCCER', UCL: 'SOCCER', EPL: 'SOCCER', MLS: 'SOCCER', LALIGA: 'SOCCER', SERIEA: 'SOCCER', BUNDES: 'SOCCER', SOCCER: 'SOCCER', NCAAF: 'CFB', NCAAB: 'CBB' };
const ESPORTS = new Set(['CS', 'LOL', 'VAL', 'DOTA', 'COD', 'R6', 'HALO', 'RL', 'OW']);

function boardSport(sport) {
  let s = String(sport || '').toUpperCase().trim(), prefix = '';
  for (const [re, p] of PP_LEAGUES) {
    const m = re.exec(s);
    if (m && m[1].length >= 2) { s = m[1]; prefix = p; break; }
  }
  return { sport: SPORT_ALIASES[s] || s, prefix };
}

// "1H Rec Yards" and a PP NFL1H "Receiving Yards" both key as 1h|rec_yds
const PERIOD = /^(1h|2h|1q|2q|3q|4q|1p|1st half|first half|1st quarter|1st period|season)\s+/i;
const PERIOD_KEY = { '1st half': '1h', 'first half': '1h', '1st quarter': '1q', '1st period': '1p' };
function sportMarketKey(market) {
  const s = String(market || '').trim();
  const m = PERIOD.exec(s);
  if (!m) return canonMarket(s);
  const p = m[1].toLowerCase();
  return `${PERIOD_KEY[p] || p}|${canonMarket(s.slice(m[0].length))}`;
}

// One book's line in the board's terms: base sport, period on the stat
function normLine(l) {
  const { sport, prefix } = boardSport(l.sport);
  return { ...l, sport, market: prefix ? `${prefix}${l.market}` : l.market, esports: ESPORTS.has(sport) };
}

// Sleeper's sports lines carry no start time. Borrow the player's next start
// from Underdog or PrizePicks; the stat doesn't matter, it's the same game.
function borrowStarts(slLines, refLines, now = Date.now()) {
  const next = new Map();
  for (const r of refLines) {
    const t = Date.parse(r.startTime || '');
    if (!(t > now)) continue;
    const k = `${boardSport(r.sport).sport}|${canonName(r.player)}`;
    const cur = next.get(k);
    if (!cur || t < cur.t) next.set(k, { t, startTime: r.startTime, matchTitle: r.matchTitle || '' });
  }
  return slLines.map(l => {
    if (l.startTime) return l;
    const hit = next.get(`${boardSport(l.sport).sport}|${canonName(l.player)}`);
    return hit ? { ...l, startTime: hit.startTime, matchTitle: l.matchTitle || hit.matchTitle } : l;
  });
}

const BOOKS = ['underdog', 'prizepicks', 'sleeper'];
const num = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// lines: raw lines from every book. esKey(sport, market) keys esports stats
// (the server's normalizeMarket reads "MAPS 1-2 Kills" and "Kills on Maps 1+2"
// alike); sports use sportMarketKey.
function buildRows(lines, { esKey = null, now = Date.now() } = {}) {
  const rows = new Map();
  for (const raw of lines) {
    if (!raw || !raw.player || num(raw.line) == null || !BOOKS.includes(raw.book)) continue;
    const l = normLine(raw);
    const t = Date.parse(l.startTime || '');
    if (t && t <= now) continue;   // started: the price is gone
    const mkey = l.esports && esKey ? esKey(l.sport, l.market) : sportMarketKey(l.market);
    const key = `${l.sport}|${canonName(l.player)}|${mkey}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, sport: l.sport, esports: l.esports, player: l.player, team: l.team || '', market: l.market, mkey,
        startTime: l.startTime || '', matchTitle: l.matchTitle || '', books: {} };
      rows.set(key, row);
    }
    // Underdog's wording reads best, so its stat name and match title win
    if (l.book === 'underdog') { row.market = l.market; if (l.matchTitle) row.matchTitle = l.matchTitle; if (l.team) row.team = l.team; }
    if (!row.startTime && l.startTime) row.startTime = l.startTime;
    if (!row.team && l.team) row.team = l.team;
    const cell = {
      line: num(l.line),
      over: l.book === 'prizepicks' ? null : num(l.overMultiplier),
      under: l.book === 'prizepicks' ? null : num(l.underMultiplier),
      overOpen: l.overOpen !== false, underOpen: l.underOpen !== false,
    };
    const old = row.books[l.book];
    // a book listing the stat twice: keep the line with both sides open
    if (!old || (!(old.overOpen && old.underOpen) && cell.overOpen && cell.underOpen)) row.books[l.book] = cell;
  }
  return [...rows.values()];
}

// Fair P(over) at a line, from Kalshi-priced props games (kprops.js shape):
// `${canonName(player)}|${market}|${line}` → p
function kalshiFairIndex(games) {
  const idx = new Map();
  for (const g of games || []) for (const b of g.books || []) for (const p of b.props || []) {
    const pOver = americanToProb(p.overPrice), pUnder = americanToProb(p.underPrice);
    if (pOver == null || pUnder == null) continue;
    idx.set(`${canonName(p.player)}|${p.market}|${Number(p.line)}`, pOver / (pOver + pUnder));
  }
  return idx;
}
function americanToProb(a) {
  const x = Number(a);
  if (!Number.isFinite(x) || x === 0) return null;
  return x > 0 ? 100 / (x + 100) : -x / (-x + 100);
}

const r2 = x => Math.round(x * 100) / 100;

// Prices every cell. dfsEv(prob 0-1, book, mult) is the server's calcBookEV.
// esPicks: index key → esports pick (side, prob, ppEv/udEv/sleeperEv).
function priceRows(rows, { kalshi = new Map(), esPicks = new Map(), dfsEv = null } = {}) {
  for (const row of rows) {
    let best = null;
    const offer = (book, side, ev, fair, source, line) => {
      if (ev == null || !Number.isFinite(ev)) return;
      if (!best || ev > best.ev) best = { book, side, ev: r2(ev), fair: fair != null ? r2(fair * 100) : null, source, line };
    };
    if (row.esports) {
      const p = esPicks.get(row.key);
      if (p) {
        row.model = { proj: p.modelPred ?? null, side: p.side || null, prob: p.prob ?? null, closed: p.sideClosed || null, stat: p.statLine || null };
        const evs = { prizepicks: p.ppEv, underdog: p.udEv, sleeper: p.sleeperEv };
        for (const book of BOOKS) {
          const c = row.books[book];
          if (!c || evs[book] == null || !p.side) continue;
          c.ev = { side: p.side === 'OVER' ? 'Over' : 'Under', ev: r2(evs[book]) };
          offer(book, c.ev.side, evs[book], p.prob != null ? p.prob / 100 : null, 'model', c.line);
        }
      }
    } else {
      const base = row.mkey.includes('|') ? null : row.mkey;   // period stats have no Kalshi ladder
      for (const book of BOOKS) {
        const c = row.books[book];
        if (!c || !base) continue;
        const pOver = kalshi.get(`${canonName(row.player)}|${base}|${c.line}`);
        if (pOver == null) continue;
        c.fair = r2(pOver * 100);
        if (!dfsEv) continue;
        let cellBest = null;
        for (const side of ['Over', 'Under']) {
          if (side === 'Over' ? !c.overOpen : !c.underOpen) continue;
          const mult = side === 'Over' ? c.over : c.under;
          const fp = side === 'Over' ? pOver : 1 - pOver;
          const ev = dfsEv(fp, book, mult ?? 1, { overMultiplier: c.over, underMultiplier: c.under }, side);
          if (ev == null || !Number.isFinite(ev)) continue;
          if (!cellBest || ev > cellBest.ev) cellBest = { side, ev: r2(ev) };
          offer(book, side, ev, fp, 'kalshi', c.line);
        }
        if (cellBest) c.ev = cellBest;
      }
    }
    const ls = Object.values(row.books).map(c => c.line);
    row.nBooks = ls.length;
    row.gap = ls.length > 1 ? r2(Math.max(...ls) - Math.min(...ls)) : 0;
    row.best = best;
  }
  return rows;
}

// Filters and sorts for the endpoint. book narrows to rows that book lists
// and ranks by that book's own EV.
const SORTS = {
  ev: (book) => (a, b) => evOf(b, book) - evOf(a, book),
  gap: () => (a, b) => b.gap - a.gap || b.nBooks - a.nBooks,
  books: () => (a, b) => b.nBooks - a.nBooks || b.gap - a.gap,
  start: () => (a, b) => (Date.parse(a.startTime) || 9e15) - (Date.parse(b.startTime) || 9e15),
  player: () => (a, b) => a.player.localeCompare(b.player),
};
function evOf(row, book) {
  const v = book ? row.books[book]?.ev?.ev : row.best?.ev;
  return v == null ? -1e9 : v;
}
function queryRows(rows, { sport = '', book = '', q = '', sort = 'ev', multi = false, priced = false } = {}) {
  const s = String(sport || '').toUpperCase();
  const needle = String(q || '').toLowerCase().trim();
  let out = rows;
  if (s === 'ESPORTS') out = out.filter(r => r.esports);
  else if (s === 'SPORTS') out = out.filter(r => !r.esports);
  else if (s && s !== 'ALL') out = out.filter(r => r.sport === s);
  if (book) out = out.filter(r => r.books[book]);
  if (multi) out = out.filter(r => r.nBooks > 1);
  if (priced) out = out.filter(r => (book ? r.books[book]?.ev : r.best));
  if (needle) out = out.filter(r => `${r.player} ${r.team} ${r.market} ${r.matchTitle}`.toLowerCase().includes(needle));
  return [...out].sort((SORTS[sort] || SORTS.ev)(book));
}

function counts(rows) {
  const sports = {}, books = { underdog: 0, prizepicks: 0, sleeper: 0 };
  let priced = 0, multi = 0;
  for (const r of rows) {
    sports[r.sport] = (sports[r.sport] || 0) + 1;
    for (const b of Object.keys(r.books)) books[b]++;
    if (r.best) priced++;
    if (r.nBooks > 1) multi++;
  }
  return { sports, books, priced, multi, rows: rows.length };
}

// A free viewer sees every line; the fair price and EV are Pro
function redactRow(r) {
  const books = {};
  for (const [k, c] of Object.entries(r.books)) books[k] = { line: c.line, over: c.over, under: c.under, overOpen: c.overOpen, underOpen: c.underOpen };
  return { ...r, books, best: r.best ? { locked: true } : null, model: null };
}

module.exports = { boardSport, sportMarketKey, normLine, borrowStarts, buildRows, kalshiFairIndex, priceRows, queryRows, counts, redactRow, BOOKS };
