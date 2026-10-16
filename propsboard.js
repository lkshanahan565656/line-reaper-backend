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
// Every quarter, half and period ("NFL4Q" read as plain NFL priced a fourth
// quarter's 9.5 receiving yards off Kalshi's full-game ladder, 10-16).
const PP_LEAGUES = [
  [/^(.+?)([12]H|[1-4]Q|[1-3]P)$/, null],
  [/^(.+?)SZN$/, 'Season '], [/^(.+?)LIVE$/, ''], [/^(NBA|WNBA|NHL|NFL|MLB)P$/, ''],
];
const SPORT_ALIASES = { CS2: 'CS', CSGO: 'CS', LOL: 'LOL', 'LEAGUE OF LEGENDS': 'LOL', VALORANT: 'VAL', DOTA2: 'DOTA',
  FIFA: 'SOCCER', UFC: 'MMA', UCL: 'SOCCER', EPL: 'SOCCER', MLS: 'SOCCER', LALIGA: 'SOCCER', SERIEA: 'SOCCER', BUNDES: 'SOCCER', SOCCER: 'SOCCER', NCAAF: 'CFB', NCAAB: 'CBB' };
const ESPORTS = new Set(['CS', 'LOL', 'VAL', 'DOTA', 'COD', 'R6', 'HALO', 'RL', 'OW']);

function boardSport(sport) {
  let s = String(sport || '').toUpperCase().trim(), prefix = '';
  for (const [re, p] of PP_LEAGUES) {
    const m = re.exec(s);
    if (m && m[1].length >= 2) { s = m[1]; prefix = p ?? `${m[2]} `; break; }
  }
  return { sport: SPORT_ALIASES[s] || s, prefix };
}

// "1H Rec Yards" and a PP NFL1H "Receiving Yards" both key as 1h|rec_yds
// (Underdog's NBA season-long lines say "Regular Season Points Per Game", PrizePicks' NBASZN "Season ...")
const PERIOD = /^(1h|2h|1q|2q|3q|4q|1p|2p|3p|1st half|first half|1st quarter|1st period|regular season|season)\s+/i;
const PERIOD_KEY = { '1st half': '1h', 'first half': '1h', '1st quarter': '1q', '1st period': '1p', 'regular season': 'season' };
// The apps name the same tennis, fight and soccer stats differently
// (PrizePicks "Total Games Won" is Underdog's "Games Won", Sleeper's "Knockout
// Win" is Underdog's "Knockouts"): one key per stat, so the lines share a row
// and the sharp prices (pinextra.js, kxextra.js) find them.
// Basketball stats the apps post that canonMarket leaves in their own words
// (PrizePicks "FG Made" would read as football's fg_made without the sport)
const BASKETBALL_ALIASES = { 'double-double': 'double_double', 'double-doubles': 'double_double', double_doubles: 'double_double',
  'triple-double': 'triple_double', 'triple-doubles': 'triple_double', triple_doubles: 'triple_double', fg_made: 'fgm', fg_attempted: 'fga',
  fg_attempts: 'fga', '3-pt_attempted': 'threes_att', '3-pt_attempts': 'threes_att', '3-pointers_attempted': 'threes_att',
  free_throws_attempted: 'fta', ft_attempted: 'fta', offensive_rebounds: 'off_rebounds', defensive_rebounds: 'def_rebounds',
  personal_fouls: 'fouls', fantasy_points: 'fantasy_score' };
const SPORT_MARKET_ALIASES = {
  NBA: BASKETBALL_ALIASES, WNBA: BASKETBALL_ALIASES, CBB: BASKETBALL_ALIASES,
  TENNIS: { total_games: 'games_played', total_games_won: 'games_won', '1st_set_total_games': '1st_set_games_played',
    '1st_set_total_games_won': '1st_set_games_won', total_tie_breaks: 'tiebreakers_played' },
  MMA: { 'fight_time_(mins)': 'fight_time', knockout_win: 'knockouts', submission_win: 'submissions' },
  SOCCER: { shots: 'shots_attempted', goalie_saves: 'saves' },
};
function sportMarketKey(market, sport = '') {
  const s = String(market || '').trim();
  const m = PERIOD.exec(s);
  const alias = k => SPORT_MARKET_ALIASES[sport]?.[k] || k;
  if (!m) return alias(canonMarket(s));
  const p = m[1].toLowerCase();
  return `${PERIOD_KEY[p] || p}|${alias(canonMarket(s.slice(m[0].length)))}`;
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

const BOOKS = ['underdog', 'prizepicks', 'sleeper', 'pick6'];
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
    const mkey = l.esports && esKey ? esKey(l.sport, l.market) : sportMarketKey(l.market, l.sport);
    const a = anchor.get(`${l.sport}|${canonName(l.player)}`);
    const own = !l.esports && t && a && Math.abs(t - a) > DATE_SLACK ? `|${new Date(t).toISOString().slice(0, 10)}` : '';
    // esports: one row per match (esmatch.js tags; null = a line no match fits)
    if (l.esports && l.matchTag === null) continue;
    const tag = l.esports && l.matchTag ? `|${l.matchTag}` : '';
    const key = `${l.sport}|${canonName(l.player)}|${mkey}${own}${tag}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, sport: l.sport, esports: l.esports, player: l.player, team: l.team || '', market: l.market, mkey,
        ...(tag ? { matchTag: l.matchTag } : {}),
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
// fixedEv(book, fair 0-1, mult): a fixed-table app's leg EV (sportprops.fixedLeg).
// kalshiAt(row, line) → P(over) from Kalshi's fight, race and tennis markets
// (kxextra.js), where its ladders (kalshi) have nothing at that line.
function priceRows(rows, { kalshi = new Map(), kalshiAt = null, esPicks = new Map(), dfsEv = null, fixedEv = null } = {}) {
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
      // our head-to-head model (h2hmodel.js) takes the row when it prices it:
      // its fair at each app's own line, green only where a Pinnacle-based fair agrees
      const hp = p?.h2h?.priced;
      if (hp) {
        const SB = { PP: 'prizepicks', UD: 'underdog', SL: 'sleeper' };
        const pin = row.model?.share ? { proj: row.model.proj, pct: row.model.share.pct } : null;
        row.model = { proj: p.h2h.mean, side: hp.side, prob: hp.prob, stat: p.statLine || null,
          h2h: { share: r2(p.h2h.share * 100), teamKills: p.h2h.teamKills, vs: p.h2h.opp || null, own: p.h2h.own, maps: r2(p.h2h.scenarios.reduce((a, x) => a + x.maps * x.weight, 0)) }, pin };
        best = null;
        for (const [ab, cell] of Object.entries(hp.cells || {})) {
          const c = row.books[SB[ab]];
          if (!c) continue;
          const side = cell.side === 'OVER' ? 'Over' : 'Under';
          c.ev = { side, ev: cell.ev, fair: cell.prob, h2h: true, clears: !!cell.clears, sharp: cell.sharp ? cell.sharp.prob : null };
          offer(SB[ab], side, cell.ev, cell.prob / 100, 'h2h', c.line);
        }
        if (best) best.clears = !!row.books[best.book]?.ev?.clears;
      }
      // Pick6 posts esports lines too, but the models price the three apps
      // they read. A Pick6 line on the same number as a model-priced cell
      // takes that cell's fair at Pick6's own payout; it clears only where
      // that cell clears and Pick6 pays at least as much. Another number
      // stays unpriced.
      const p6 = row.books.pick6;
      if (p6 && fixedEv) {
        const twin = Object.entries(row.books).find(([b, c]) => b !== 'pick6' && c.line === p6.line && c.ev?.fair != null && (c.ev.share || c.ev.h2h));
        if (twin) {
          const [tb, tc] = twin;
          const side = tc.ev.side, fair = tc.ev.fair / 100;
          const ev = fixedEv('pick6', fair, (side === 'Over' ? p6.over : p6.under) ?? 1);
          if (ev != null && Number.isFinite(ev) && (side === 'Over' ? p6.overOpen : p6.underOpen)) {
            p6.ev = { side, ev: r2(ev), fair: tc.ev.fair, twin: tb, ...(tc.ev.share ? { share: true } : { h2h: true }), clears: !!tc.ev.clears && ev >= tc.ev.ev - 1e-9 };
            offer('pick6', side, ev, fair, tc.ev.share ? 'share' : 'h2h', p6.line);
            if (best?.book === 'pick6') best.clears = p6.ev.clears;
          }
        }
      }
    } else {
      const base = row.mkey.includes('|') ? null : row.mkey;   // period stats have no Kalshi ladder
      for (const book of BOOKS) {
        const c = row.books[book];
        if (!c || !base) continue;
        const pOver = kalshi.get(`${canonName(row.player)}|${base}|${c.line}`) ?? (kalshiAt ? kalshiAt(row, c.line) : null);
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
  const sports = {}, books = { underdog: 0, prizepicks: 0, sleeper: 0, pick6: 0 };
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
// a kill-share or head-to-head price counts only where it clears (a Pinnacle-based fair agrees)
const sharpBacked = (r, c) => !!(c.ev && (c.ev.share || c.ev.h2h ? c.ev.clears : (r.esports || c.ev.consensus)));
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

// ── COVERAGE: which legs carry a sharp price ─────────────────────────────────
// Each app leg on a sports row, by what prices it: Pinnacle (its prop, or a
// match market read as one: pinextra.js), Kalshi (a ladder or a fight, race or
// tennis market at that line), a sportsbook alone (FanDuel, BetRivers, … in
// row.sharpBooks, which needs a second source to make a price), the other apps
// only (a soft consensus, not a price), or nothing. Esports rows aren't counted
// (their model prices them).
// Stats no sharp market lists anywhere we read, so they stay unpriced on purpose.
const NO_SHARP = {
  ALL: [/fantasy/, /season|per_game|triple_doubles?|50\+/, /first_.*scorer|last_goal_scorer|first_td/, /^longest/, /^(1h|2h|1q|2q|3q|4q|1p)\|/,
    /kicking_points|fg_made|xp_made|pat_made/],
  MMA: [/significant_strikes|takedowns/],
  SOCCER: [/shots_attempted|passes|goals_against|tackles|clearances|crosses|^saves$/],
  TENNIS: [/aces|double_faults|break_points|points_won|tiebreakers|1st_set_games_won/],
  NHL: [/time_on_ice|faceoffs|^hits$|blocked_shots/],
};
const NO_SHARP_SPORTS = /^(GOLF|EUROGOLF|PGA|LPGA|LIVGOLF|TT|BAD|DARTS|CRICKET)$/;
function noSharpMarket(row) {
  const k = row.mkey || '';
  return NO_SHARP_SPORTS.test(row.sport || '') || [...NO_SHARP.ALL, ...(NO_SHARP[row.sport] || [])].some(re => re.test(k));
}
function legSource(row, c) {
  const src = new Set((row.consensus?.sources || []).map(s => s.book));
  if (row.pinnacle || src.has('pinnacle')) return 'pinnacle';
  if (c.fair != null || src.has('kalshi')) return 'kalshi';
  if (row.consensus || row.bookFair || row.bookConsensus || row.sharpBooks?.length) return 'books';
  if (row.nBooks > 1) return 'apps';
  return 'none';
}
const blank = () => ({ legs: 0, sharp: 0, pinnacle: 0, kalshi: 0, books: 0, apps: 0, none: 0, bookFair: 0, bookCons: 0 });
// → { total, leagues: { NFL: {...} }, byApp: { underdog: { NFL: {...} } },
//     markets: [{ sport, market, mkey, legs, sharp, ..., never }] }
function coverage(rows) {
  const total = blank(), leagues = {}, byApp = {}, markets = new Map();
  // bookFair: of the 'books' legs, those FanDuel or BetRivers price alone (grey on the board);
  // bookCons: those three or more books price at the app's own number (grey too)
  const add = (o, k, bf) => { o.legs++; o[k]++; if (k === 'pinnacle' || k === 'kalshi') o.sharp++; if (bf === 'consensus') o.bookCons++; else if (bf) o.bookFair++; };
  for (const r of rows || []) {
    if (r.esports) continue;
    for (const [book, c] of Object.entries(r.books || {})) {
      const k = legSource(r, c), bf = c.ev?.bookFair || null;
      add(total, k, bf);
      add(leagues[r.sport] ||= blank(), k, bf);
      add((byApp[book] ||= {})[r.sport] ||= blank(), k, bf);
      const mk = `${r.sport}|${r.mkey}`;
      if (!markets.has(mk)) markets.set(mk, { sport: r.sport, market: r.market, mkey: r.mkey, never: noSharpMarket(r), ...blank() });
      add(markets.get(mk), k, bf);
    }
  }
  return { total, leagues, byApp, markets: [...markets.values()].sort((a, b) => a.sport.localeCompare(b.sport) || b.legs - a.legs) };
}

// A free viewer sees every line; the fair price and EV are Pro
function redactRow(r) {
  const books = {};
  for (const [k, c] of Object.entries(r.books)) books[k] = { line: c.line, over: c.over, under: c.under, overOpen: c.overOpen, underOpen: c.underOpen };
  return { ...r, books, best: r.best ? { locked: true, ...(['gap', 'sharp'].includes(r.best.kind) ? { kind: r.best.kind } : {}) } : null, model: null, pinnacle: null, consensus: null, bookConsensus: null };
}

module.exports = { coverage, legSource, noSharpMarket, NO_SHARP, SPORT_MARKET_ALIASES, boardSport, sportMarketKey, normLine, borrowStarts, buildRows, kalshiFairIndex, priceRows, queryRows, lineFacets, counts, redactRow, BOOKS };
