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
  FIFA: 'SOCCER', UFC: 'MMA', UCL: 'SOCCER', EPL: 'SOCCER', MLS: 'SOCCER', LALIGA: 'SOCCER', SERIEA: 'SOCCER', BUNDES: 'SOCCER', SOCCER: 'SOCCER', NCAAF: 'CFB', NCAAB: 'CBB' };
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

// Sleeper's sports lines carry no start time of their own. Sleeper's schedule
// gives most of them one (sleepersched.js); the rest borrow the player's start
// from Underdog or PrizePicks, the stat doesn't matter, it's the same game.
// A line whose game date is known only borrows a start on that date (within
// 20 hours of its midday), so preseason and opening night don't merge; with
// no date it takes the player's next start, as before.
const DATE_SLACK = 20 * 3600e3;
function borrowStarts(slLines, refLines, now = Date.now()) {
  const starts = new Map();
  for (const r of refLines) {
    const t = Date.parse(r.startTime || '');
    if (!(t > now)) continue;
    const k = `${boardSport(r.sport).sport}|${canonName(r.player)}`;
    if (!starts.has(k)) starts.set(k, []);
    starts.get(k).push({ t, startTime: r.startTime, matchTitle: r.matchTitle || '' });
  }
  return slLines.map(l => {
    if (l.startTime) return l;
    const list = starts.get(`${boardSport(l.sport).sport}|${canonName(l.player)}`) || [];
    let hit = null;
    if (l.gameDate) {
      const mid = Date.parse(`${l.gameDate}T16:00:00Z`);
      for (const c of list) if (Math.abs(c.t - mid) <= DATE_SLACK && (!hit || Math.abs(c.t - mid) < Math.abs(hit.t - mid))) hit = c;
    } else {
      for (const c of list) if (!hit || c.t < hit.t) hit = c;
    }
    return hit ? { ...l, startTime: hit.startTime, matchTitle: l.matchTitle || hit.matchTitle, startSource: 'borrowed' } : l;
  });
}

const BOOKS = ['underdog', 'prizepicks', 'sleeper'];
const num = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// lines: raw lines from every book. esKey(sport, market) keys esports stats
// (the server's normalizeMarket reads "MAPS 1-2 Kills" and "Kills on Maps 1+2"
// alike); sports use sportMarketKey.
function buildRows(lines, { esKey = null, now = Date.now() } = {}) {
  const rows = new Map();
  // A sports line from a different game than the others (Sleeper on opening
  // night while Underdog lists preseason) gets a row of its own: the anchor is
  // the player's earliest start on the other books, and a line more than
  // DATE_SLACK away from it is keyed by its own date.
  const anchor = new Map();
  for (const raw of lines) {
    if (!raw || raw.book === 'sleeper' || !raw.player) continue;
    const l = normLine(raw);
    const t = Date.parse(l.startTime || '');
    if (l.esports || !(t > now)) continue;
    const k = `${l.sport}|${canonName(l.player)}`;
    if (!anchor.has(k) || t < anchor.get(k)) anchor.set(k, t);
  }
  for (const raw of lines) {
    if (!raw || !raw.player || num(raw.line) == null || !BOOKS.includes(raw.book)) continue;
    const l = normLine(raw);
    const t = Date.parse(l.startTime || '');
    if (t && t <= now) continue;   // started: the price is gone
    const mkey = l.esports && esKey ? esKey(l.sport, l.market) : sportMarketKey(l.market);
    const a = anchor.get(`${l.sport}|${canonName(l.player)}`);
    const own = !l.esports && t && a && Math.abs(t - a) > DATE_SLACK ? `|${new Date(t).toISOString().slice(0, 10)}` : '';
    const key = `${l.sport}|${canonName(l.player)}|${mkey}${own}`;
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
      // the kill-share model (LoL, Dota) or the round model (CS2, Valorant), both on Pinnacle
      const sp = p?.share?.priced || p?.rounds?.priced;
      if (sp) {
        // Pinnacle's team kills × the player's share (sharemodel.js): its own
        // fair at each app's own line, green only where it clears
        const SB = { PP: 'prizepicks', UD: 'underdog', SL: 'sleeper' };
        row.model = p.share?.priced
          ? { proj: p.share.mean, side: sp.side, prob: sp.prob, share: { pct: r2(p.share.share * 100), pinPerMap: p.share.pinPerMap, pinMean: p.share.pinMean }, stat: p.statLine || null }
          : { proj: p.rounds.mean, side: sp.side, prob: sp.prob, share: { rounds: p.rounds.roundsPerMap, kpr: p.rounds.kpr, pinMean: p.rounds.pinMean, lineup: p.rounds.lineup }, stat: p.statLine || null };
        for (const [ab, cell] of Object.entries(sp.cells || {})) {
          const c = row.books[SB[ab]];
          if (!c) continue;
          const side = cell.side === 'OVER' ? 'Over' : 'Under';
          c.ev = { side, ev: cell.ev, fair: cell.prob, share: true, clears: !!cell.clears };
          offer(SB[ab], side, cell.ev, cell.prob / 100, 'share', c.line);
        }
      } else if (p) {
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
function queryRows(rows, { sport = '', book = '', q = '', sort = 'ev', multi = false, priced = false, gaps = false, sharp = false, market = '' } = {}) {
  const s = String(sport || '').toUpperCase();
  const needle = String(q || '').toLowerCase().trim();
  let out = rows;
  if (s === 'ESPORTS') out = out.filter(r => r.esports);
  else if (s === 'SPORTS') out = out.filter(r => !r.esports);
  else if (s && s !== 'ALL') out = out.filter(r => r.sport === s);
  if (book) out = out.filter(r => r.books[book]);
  if (multi) out = out.filter(r => r.nBooks > 1);
  if (priced) out = out.filter(r => (book ? r.books[book]?.ev : r.best));
  if (gaps) out = out.filter(r => r.best?.kind === 'gap' && (!book || r.best.book === book));
  if (sharp) out = out.filter(r => r.best?.kind === 'sharp' && (!book || r.best.book === book));
  if (needle) out = out.filter(r => `${r.player} ${r.team} ${r.market} ${r.matchTitle}`.toLowerCase().includes(needle));
  if (market) out = out.filter(r => r.market === market);
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

// The Lines view: how many of a book's lines clear minEv at that book on a
// sharp price (the sharp books' consensus, or the esports model) with that
// side still open (the header's "bettable"), and the stat names for the prop filter
// a kill-share price counts only where it clears (Pinnacle split the books' way agrees)
const sharpBacked = (r, c) => !!(c.ev && (c.ev.share ? c.ev.clears : (r.esports || c.ev.consensus)));
function lineFacets(rows, book, minEv) {
  const markets = new Map();
  let bettable = 0;
  for (const r of rows) {
    const c = r.books[book];
    if (!c) continue;
    markets.set(r.market, (markets.get(r.market) || 0) + 1);
    if (sharpBacked(r, c) && c.ev.ev >= minEv && (c.ev.side === 'Over' ? c.overOpen : c.underOpen)) bettable++;
  }
  return { bettable, markets: [...markets].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([m, n]) => ({ market: m, n })) };
}

// A free viewer sees every line; the fair price and EV are Pro
function redactRow(r) {
  const books = {};
  for (const [k, c] of Object.entries(r.books)) books[k] = { line: c.line, over: c.over, under: c.under, overOpen: c.overOpen, underOpen: c.underOpen };
  return { ...r, books, best: r.best ? { locked: true, ...(['gap', 'sharp'].includes(r.best.kind) ? { kind: r.best.kind } : {}) } : null, model: null, pinnacle: null, consensus: null };
}

module.exports = { boardSport, sportMarketKey, normLine, borrowStarts, buildRows, kalshiFairIndex, priceRows, queryRows, lineFacets, counts, redactRow, BOOKS };
