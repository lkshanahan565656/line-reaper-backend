// ─── BIG MONEY: SIZE ON AN EXCHANGE, THE SAME BET SHOPPED ELSEWHERE ──────────
// When $2,000 hits a player's over at 55.6¢ (−125) on Kalshi, that price is
// what real money paid for the bet. If PrizePicks still prices the same over
// as a 55% leg, FanDuel hangs it at −115, or Polymarket US asks 52¢, the bet
// costs less somewhere else. This tab finds those: every big taker print on
// Kalshi and Polymarket, the bet it backed, and that bet's price at every
// venue we read, with the gap.
//
//   money   the taker prints of minUsd or more (Kalshi's grouped sweeps,
//           Polymarket's orders), summed per bet while the game is ahead;
//           the price the money paid (volume weighted) is the bet's fair
//   shop    the pick'em apps (PrizePicks at its 3-pick power break-even,
//           Underdog and Sleeper at their payouts), FanDuel and BetRivers
//           (their American price), Kalshi and Polymarket US (ask + fee);
//           Pinnacle's no-vig price is shown beside it as the sharp check
//   line    a venue at the money's line is the same bet; one at another
//           line is priced by moving the money's chance along the stat's
//           curve (sportprops) and shown as a different line, never as the
//           same play
//
// Who the money is matters. A market maker pays to rebalance, not because it
// knows something, so a print is labelled 'market maker' (and hidden by
// default) when, in the hour up to it:
//   two-way    money hit the other side of the same market too (30%+ of
//              this side's): someone working both sides, not a bettor
//   hedge      the same player's ladder took money the other way (over on
//              one rung, under on another), or a Polymarket wallet bought
//              both sides of the same bet
//   mm wallet  a Polymarket wallet Sharp Tail scores as a market maker
// Block trades are negotiated off the book and never count as money.
//
// Plays are logged once per bet and venue (big-money tracker below) when the
// venue beats the money's price by minEv, labelled by flow, and graded on
// the exchange close, the sharp close and the result (ESPN). No alerts: the
// record decides first. Pure functions plus the tracker; the server passes
// the indexes in.

const { canonName } = require('./ev');
const { meanFor, pOver, PP_GRADE, PP_ENTRIES } = require('./sportprops');
const { sameTeam } = require('./pingames');
const { kalshiFee } = require('./exchanges');
const { createMemoryStore } = require('./evtrack');

const HOUR = 3600e3;
const DEFAULTS = {
  minUsd: 1000,          // a print this big is big money (BIG_MONEY_MIN_USD)
  floorUsd: 250,         // smaller prints are kept only to read the other side's flow
  keepMs: 12 * HOUR,     // prints remembered this long
  flowWindowMs: HOUR,    // two-way and hedge flow read over this window before the money
  twoWayShare: 0.3,      // the other side's dollars over this share of this side's = market maker
  minEv: 2,              // % a venue must beat the money's price by to be a play (BIG_MONEY_MIN_EV)
  maxEv: 40,             // past this the two bets almost surely aren't the same
  maxLineSteps: 0.2,     // another line within 20% (or 1.5 units) of the money's line is priced on the curve
  lagMs: 2 * 60e3,       // the executable check: the venue's price this long after the flag
  maxPlays: 300,
};
const BOOK_NAMES = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', fanduel: 'FanDuel', betrivers: 'BetRivers', kalshi: 'Kalshi', polymarketus: 'Polymarket US', pinnacle: 'Pinnacle' };
const APPS = new Set(['prizepicks', 'underdog', 'sleeper']);
const BOOKS = new Set(['fanduel', 'betrivers']);
const EXCHANGES = new Set(['kalshi', 'polymarketus']);

const num = v => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const ms = t => { const x = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const iso = t => (t == null ? null : new Date(t).toISOString());
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const toDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
// a chance as American odds (0.556 → −125)
const american = p => (!(p > 0 && p < 1) ? null : p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));

function optsFromEnv(env = process.env) {
  const f = k => (env[k] == null || String(env[k]).trim() === '' || !Number.isFinite(Number(env[k])) ? undefined : Number(env[k]));
  const out = {};
  if (f('BIG_MONEY_MIN_USD') > 0) out.minUsd = f('BIG_MONEY_MIN_USD');
  if (f('BIG_MONEY_MIN_EV') != null) out.minEv = f('BIG_MONEY_MIN_EV');
  return out;
}

// ── prints ──
// A whale watcher print (whales.js: Kalshi grouped fills or a Polymarket
// order) → { key, exchange, market, yes (backs the market's YES / outcome 0),
// price (of the side backed), usd, at, fills, block, wallet, outcomeIndex }
function normPrint(p) {
  if (!p || !p.market || (p.dir !== 'yes' && p.dir !== 'no') || !(p.notional > 0) || p.at == null) return null;
  const yes = p.dir === 'yes';
  const yp = num(p.yesPrice);
  const price = yp != null ? (yes ? yp : 1 - yp) : num(p.price);
  if (!(price > 0 && price < 1)) return null;
  return { key: p.key, exchange: p.exchange, market: String(p.market), yes, price: r4(price), usd: r2(p.notional), at: ms(p.at),
    fills: p.nFills ?? p.fills ?? 1, block: !!p.block, wallet: p.wallet || null, outcomeIndex: p.outcomeIndex ?? null,
    conditionId: p.conditionId || null, title: p.title || null };
}

// ── game lines: one key per bet, whichever venue lists it ──
// Pinnacle's game (pingames.parseGames) is the anchor: `${id}|ml|home`,
// `${id}|spread|${home points}|away`, `${id}|total|${line}|over`.
const otherSide = s => ({ home: 'away', away: 'home', over: 'under', under: 'over' }[s]);
const flipKey = key => { const p = key.split('|'); const o = otherSide(p[p.length - 1]); return o ? [...p.slice(0, -1), o].join('|') : null; };
function isHome(label, game) {
  const h = sameTeam(label, game.home), a = sameTeam(label, game.away);
  return h === a ? null : h;
}
function betLabel(key, game) {
  const p = key.split('|'), side = p[p.length - 1], kind = p[1];
  const team = side === 'home' ? game.home : side === 'away' ? game.away : null;
  if (kind === 'ml' || kind === 'ml3') return side === 'draw' ? 'Draw' : `${team} to win`;
  if (kind === 'total') return `${side === 'over' ? 'Over' : 'Under'} ${p[2]}`;
  if (kind === 'spread') { const h = Number(p[2]), pts = side === 'home' ? h : -h; return `${team} ${pts > 0 ? '+' : ''}${pts}`; }
  return key;
}
// an exchange row matched to a Pinnacle game → { yes, no } bet keys (no: null
// when NO isn't one clean bet, as on a three-way result)
function rowBets(row, game) {
  const id = game.id;
  if (row.game3) {
    const pick = row.game3.pick;
    if (pick === 'draw') return { yes: `${id}|ml3|draw`, no: null };
    const h = isHome(row.game3.teams[pick], game);
    return h == null ? null : { yes: `${id}|ml3|${h ? 'home' : 'away'}`, no: null };
  }
  if (row.kind === 'teams') {
    const h = isHome(row.outcomeLabel, game);
    if (h == null) return null;
    const yes = `${id}|ml|${h ? 'home' : 'away'}`;
    return { yes, no: flipKey(yes) };
  }
  if (row.kind === 'total' && row.line != null) return { yes: `${id}|total|${row.line}|over`, no: `${id}|total|${row.line}|under` };
  if (row.kind === 'spread' && row.line != null && row.lineTeam) {
    const h = isHome(row.lineTeam, game);
    if (h == null) return null;
    const homePts = h ? -row.line : row.line;
    const yes = `${id}|spread|${homePts}|${h ? 'home' : 'away'}`;
    return { yes, no: flipKey(yes) };
  }
  return null;
}
// Pinnacle's no-vig chance of one bet key
function pinFair(game, key) {
  const p = key.split('|'), side = p[p.length - 1], kind = p[1];
  if (kind === 'ml' || kind === 'ml3') {
    const ml = game.ml;
    if (!ml || (kind === 'ml') !== (ml.draw == null)) return null;
    return num(ml[side]);
  }
  if (kind === 'total') { const t = (game.totals || []).filter(x => x.line === Number(p[2])).sort((a, b) => a.alt - b.alt)[0]; return t ? (side === 'over' ? t.pOver : r4(1 - t.pOver)) : null; }
  if (kind === 'spread') { const s = (game.spreads || []).filter(x => x.home === Number(p[2])).sort((a, b) => a.alt - b.alt)[0]; return s ? (side === 'home' ? s.pHome : r4(1 - s.pHome)) : null; }
  return null;
}
// an exchange's all-in cost of one contract at `ask`
function exchangeCost(row, ask) {
  if (!(ask > 0 && ask < 1)) return null;
  if (row.exchange === 'kalshi') return r4(ask + kalshiFee(ask, 100) / 100);
  if (row.exchange === 'polymarketus') return r4(ask + (row.feeSchedule?.rate ?? 0.0695) * ask * (1 - ask));
  return null;
}
const midOf = row => (row.yesAsk > 0 && row.yesAsk < 1 && row.noAsk > 0 && row.noAsk < 1 ? r4((row.yesAsk + 1 - row.noAsk) / 2) : null);

// Every exchange row Pinnacle prices, and the books' prices of the same bets.
// matches: pingames.matchRows(rows, pinGames); freeGames: freebooks' Odds API
// games by league ({ nfl: [...] }). → { rows: Map(row id → { game, league,
// yes, no, row }), bets: Map(bet key → { game, league, label, pin, venues:
// [{ venue, name, implied, decimal, american, url, line }] }) }
function gameIndex(matches = [], freeGames = {}) {
  const rows = new Map(), bets = new Map();
  const leagueOf = new Map();
  const odds = new Map();
  for (const [league, games] of Object.entries(freeGames || {})) for (const g of games || []) { odds.set(String(g.id).replace(/^pin-/, ''), g); leagueOf.set(String(g.id).replace(/^pin-/, ''), league); }
  const bet = (key, game) => {
    if (!bets.has(key)) bets.set(key, { key, game: { id: game.id, home: game.home, away: game.away, start: game.start, sport: game.sport, league: game.league },
      league: leagueOf.get(String(game.id)) || null, label: betLabel(key, game), pin: pinFair(game, key), venues: [] });
    return bets.get(key);
  };
  for (const m of matches || []) {
    const k = rowBets(m.row, m.game);
    if (!k) continue;
    const id = m.row.exchange === 'polymarket' ? String(m.row.conditionId || m.row.id) : String(m.row.id);
    rows.set(`${m.row.exchange}:${id}`, { row: m.row, game: m.game, league: leagueOf.get(String(m.game.id)) || null, yes: k.yes, no: k.no });
    bet(k.yes, m.game);
    if (k.no) bet(k.no, m.game);
    if (!EXCHANGES.has(m.row.exchange) || !m.row.tradable) continue;
    for (const [side, key] of [['yes', k.yes], ['no', k.no]]) {
      if (!key) continue;
      const ask = side === 'yes' ? m.row.yesAsk : m.row.noAsk;
      const cost = exchangeCost(m.row, ask);
      if (cost == null || cost >= 1) continue;
      const b = bet(key, m.game), had = b.venues.find(v => v.venue === m.row.exchange);
      if (had && had.implied <= cost) continue;
      if (had) b.venues.splice(b.venues.indexOf(had), 1);
      b.venues.push({ venue: m.row.exchange, name: BOOK_NAMES[m.row.exchange], implied: cost, decimal: r4(1 / cost), price: ask,
        american: american(cost), url: m.row.url || null, marketId: m.row.id, side, mid: side === 'yes' ? midOf(m.row) : midOf(m.row) == null ? null : r4(1 - midOf(m.row)) });
    }
  }
  // FanDuel and BetRivers at the same line
  const pinById = new Map();
  for (const b of bets.values()) pinById.set(String(b.game.id), b.game);
  for (const [gid, g] of odds) {
    const pg = pinById.get(gid);
    if (!pg) continue;
    for (const bm of g.bookmakers || []) {
      if (!BOOKS.has(bm.key)) continue;
      for (const mk of bm.markets || []) {
        for (const o of mk.outcomes || []) {
          const a = num(o.price);
          if (a == null || a === 0) continue;
          let key = null;
          if (mk.key === 'h2h') { const n = mk.outcomes.length; key = o.name === pg.home ? `${gid}|${n === 3 ? 'ml3' : 'ml'}|home` : o.name === pg.away ? `${gid}|${n === 3 ? 'ml3' : 'ml'}|away` : n === 3 ? `${gid}|ml3|draw` : null; }
          else if (mk.key === 'spreads' && o.point != null) key = o.name === pg.home ? `${gid}|spread|${Number(o.point)}|home` : o.name === pg.away ? `${gid}|spread|${-Number(o.point)}|away` : null;
          else if (mk.key === 'totals' && o.point != null) key = /^over$/i.test(o.name) ? `${gid}|total|${Number(o.point)}|over` : /^under$/i.test(o.name) ? `${gid}|total|${Number(o.point)}|under` : null;
          const b = key && bets.get(key);
          if (!b || b.venues.some(v => v.venue === bm.key)) continue;
          b.venues.push({ venue: bm.key, name: BOOK_NAMES[bm.key] || bm.title || bm.key, implied: r4(toProb(a)), decimal: r4(toDecimal(a)), american: a, url: o.link || bm.link || null });
        }
      }
    }
  }
  return { rows, bets };
}

// ── player props ──
// Kalshi ladder events (kprops.fetchEvents) → Map(ticker → rung): the player,
// stat, the line its YES is the over of ("K+" = over K − 0.5), the
// game's start (Kalshi settles about 3 hours after it) and the rung's quote
function rungIndex(events = [], { canonMarket, parseRung }) {
  const out = new Map();
  for (const { ev, league } of events || []) {
    for (const mk of ev.markets || []) {
      if (mk.strike_type !== 'greater' || !mk.ticker) continue;
      const strike = num(mk.floor_strike), settles = ms(mk.expected_expiration_time);
      const r = parseRung(mk.title || mk.yes_sub_title);
      if (strike == null || !r || settles == null) continue;
      // Kalshi lists "5+" with a floor of 4.5; a whole floor (5) is the same 4.5 line
      out.set(mk.ticker, { ticker: mk.ticker, league, player: r.player, mkey: canonMarket(r.stat), stat: r.stat, line: Number.isInteger(strike) ? strike - 0.5 : strike,
        start: iso(settles - 3 * HOUR), yesBid: num(mk.yes_bid_dollars), yesAsk: num(mk.yes_ask_dollars), eventTicker: ev.event_ticker,
        url: `https://kalshi.com/markets/${String(ev.event_ticker || '').toLowerCase()}` });
    }
  }
  return out;
}
// FanDuel's and BetRivers' player props (freebooks' Odds API games by league)
// → Map(`${sport}|${canonName(player)}|${mkey}` → [{ book, line, over, under, start }])
function bookPropIndex(gamesBySport = {}, sportOf = s => s) {
  const out = new Map();
  for (const [s, games] of Object.entries(gamesBySport || {})) {
    const sport = sportOf(s);
    if (!sport) continue;
    for (const g of games || []) for (const bm of g.bookmakers || []) {
      if (!BOOKS.has(bm.key)) continue;
      for (const m of bm.markets || []) {
        if (/^(h2h|spreads|totals)$/.test(m.key)) continue;
        const pairs = new Map();
        for (const x of m.outcomes || []) {
          if (!x.description || x.point == null) continue;
          const k = `${x.description}|${x.point}`;
          if (!pairs.has(k)) pairs.set(k, { player: x.description, line: Number(x.point) });
          pairs.get(k)[/^over$/i.test(x.name) ? 'over' : 'under'] = num(x.price);
        }
        for (const q of pairs.values()) {
          const key = `${sport}|${canonName(q.player)}|${m.key}`;
          if (!out.has(key)) out.set(key, []);
          out.get(key).push({ book: bm.key, line: q.line, over: q.over ?? null, under: q.under ?? null, start: g.commence_time });
        }
      }
    }
  }
  return out;
}

// the money's chance moved to another line along the stat's curve
function atLine(mkey, sport, line, pOverAtLine, target) {
  if (target === line) return pOverAtLine;
  const m = meanFor(mkey, sport, line, pOverAtLine);
  return m == null ? null : pOver(mkey, sport, m, target);
}
const nearLine = (a, b, o) => Math.abs(a - b) <= Math.max(1.5, o.maxLineSteps * Math.abs(a));

// Pick'em break-even of one side at a fair p (ev% from the app's pricing):
// PrizePicks at its 3-pick power, the others solved from dfsEv
function appPrice(book, cell, side, fair, dfsEv) {
  if (book === 'prizepicks') return { ev: (fair / PP_GRADE.be - 1) * 100, implied: PP_GRADE.be, decimal: r4(1 / PP_GRADE.be), entry: PP_GRADE.name, entries: PP_ENTRIES.filter(e => fair > e.be).map(e => e.name) };
  const mult = (side === 'Over' ? cell.over : cell.under) ?? 1;
  const line = { overMultiplier: cell.over, underMultiplier: cell.under };
  const ev = dfsEv(fair, book, mult, line, side);
  if (ev == null || !Number.isFinite(ev)) return null;
  // the chance at which this leg breaks even
  let lo = 0.2, hi = 0.95;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const e = dfsEv(m, book, mult, line, side); if (e == null || !Number.isFinite(e) || e < 0) lo = m; else hi = m; }
  const be = (lo + hi) / 2;
  return { ev, implied: r4(be), decimal: r4(1 / be), mult };
}

// A prop bet (player, stat, line, side, fair at that line) → every venue's
// price: { venue, name, line, sameLine, implied, decimal, american?, ev, entry?, entries? }
// board: the props board row for the player and stat (or null); books: book
// prop quotes [{ book, line, over, under }] (FanDuel, BetRivers); pin: Pinnacle's
// { line, pOver } (or null)
function propVenues({ sport, mkey, line, side, fair }, { board = null, books = [], dfsEv, o = DEFAULTS } = {}) {
  const out = [];
  const fairAt = l => { const pO = atLine(mkey, sport, line, side === 'Over' ? fair : 1 - fair, l); return pO == null ? null : side === 'Over' ? pO : 1 - pO; };
  for (const [book, c] of Object.entries(board?.books || {})) {
    if (c.line == null || !(side === 'Over' ? c.overOpen : c.underOpen)) continue;
    const same = c.line === line;
    if (!same && !nearLine(line, c.line, o)) continue;
    const f = fairAt(c.line);
    if (f == null) continue;
    const pr = typeof dfsEv === 'function' || book === 'prizepicks' ? appPrice(book, c, side, f, dfsEv) : null;
    if (!pr) continue;
    out.push({ venue: book, name: BOOK_NAMES[book], line: c.line, sameLine: same, fair: r4(f), implied: pr.implied, decimal: pr.decimal, ev: r2(pr.ev),
      ...(pr.mult != null && pr.mult !== 1 ? { mult: pr.mult } : {}), ...(pr.entry ? { entry: pr.entry, entries: pr.entries } : {}) });
  }
  for (const q of books || []) {
    const a = side === 'Over' ? q.over : q.under;
    if (a == null || q.line == null) continue;
    const same = q.line === line;
    if (!same && !nearLine(line, q.line, o)) continue;
    const f = fairAt(q.line);
    if (f == null) continue;
    const d = toDecimal(a);
    if (out.some(v => v.venue === q.book && v.line === q.line)) continue;
    out.push({ venue: q.book, name: BOOK_NAMES[q.book] || q.book, line: q.line, sameLine: same, fair: r4(f), implied: r4(1 / d), decimal: r4(d), american: a, ev: r2((f * d - 1) * 100) });
  }
  return out;
}

// ── flow: bettor or market maker ──
// A bet's money (its prints back `yes` on `market`) is a market maker's when,
// in flowWindowMs before its first big print up to the last one: the other
// side of the same market took twoWayShare+ of this side's dollars; the
// player's ladder took money the other way; or a wallet is a market maker or
// bought the other side too. market: every stored print on the money's
// market; ladder: the prints on the player's other rungs (Kalshi props).
// → { flow: 'bettor' | 'market maker', why: [text] }
const usdText = x => `$${Math.round(x).toLocaleString('en-US')}`;
function flowOf(money, { market = [], ladder = [], side = null, isMaker = null, o = DEFAULTS } = {}) {
  const why = [];
  const from = money.firstAt - o.flowWindowMs, to = money.lastAt;
  const inWin = p => p.at >= from && p.at <= to && !p.block;
  const usd = list => list.reduce((a, p) => a + p.usd, 0);
  const same = market.filter(inWin);
  const mine = usd(same.filter(p => p.yes === money.yes)), theirs = usd(same.filter(p => p.yes !== money.yes));
  if (theirs > 0 && theirs >= o.twoWayShare * mine) why.push(`two-way: ${usdText(theirs)} hit the other side of this market in the hour up to it, against ${usdText(mine)} on this side`);
  if (ladder.length && side) {
    let over = 0, under = 0;
    for (const p of ladder) if (inWin(p)) { if (p.yes) over += p.usd; else under += p.usd; }
    const against = side === 'Over' ? under : over, along = (side === 'Over' ? over : under) + mine;
    if (against > 0 && against >= o.twoWayShare * along) why.push(`hedge: ${usdText(against)} went the other way on this player's other lines in the same hour`);
  }
  const wallets = money.wallets || [];
  if (isMaker && wallets.some(w => { try { return isMaker(w); } catch { return false; } })) why.push('the wallet works both sides of most of its markets (Sharp Tail marks it a market maker)');
  if (wallets.length && same.some(p => p.yes !== money.yes && wallets.includes(p.wallet))) why.push('the same wallet bought the other side of this bet too');
  return { flow: why.length ? 'market maker' : 'bettor', why };
}

// ── the scan ──
// store: normalized prints (normPrint), oldest first. resolve(print) →
// { betKey, kind: 'prop'|'game', side ('Over'/'Under' for props, the key's
// side for games), ...info } | null. Plays group the big prints by bet.
// Returns plays (newest money first) before pricing: { betKey, money, ... }
function groupMoney(store, resolve, { now = Date.now(), o = DEFAULTS } = {}) {
  const groups = new Map();
  for (const p of store) {
    if (p.block || !(p.usd >= o.minUsd - 1e-6)) continue;
    const r = resolve(p);
    if (!r) continue;
    const start = ms(r.start);
    if (start == null || start <= now || p.at >= start) continue;   // pregame money on a game still ahead
    if (!groups.has(r.betKey)) groups.set(r.betKey, { ...r, prints: [] });
    groups.get(r.betKey).prints.push({ ...p });
  }
  const out = [];
  for (const g of groups.values()) {
    const ps = g.prints.sort((a, b) => a.at - b.at);
    const usd = ps.reduce((a, p) => a + p.usd, 0);
    const vwap = ps.reduce((a, p) => a + p.usd, 0) / ps.reduce((a, p) => a + p.usd / p.price, 0);
    const big = ps.reduce((a, b) => (b.usd > a.usd ? b : a));
    const exchanges = [...new Set(ps.map(p => p.exchange))];
    out.push({ ...g, prints: ps.length, money: {
      usd: r2(usd), price: r4(vwap), american: american(vwap), firstAt: ps[0].at, lastAt: ps[ps.length - 1].at, exchanges,
      exchange: big.exchange, market: big.market, yes: big.yes, biggest: { usd: big.usd, price: big.price, at: iso(big.at), exchange: big.exchange, fills: big.fills },
      wallets: [...new Set(ps.map(p => p.wallet).filter(Boolean))],
    } });
  }
  return out.sort((a, b) => b.money.lastAt - a.money.lastAt);
}

// one play's venues → the best same-line venue we'd bet (apps and books, not
// the exchanges: buying the exchange itself after the money is steam, which
// graded −4% to −8% two minutes on), plus the summary fields
function pickBest(venues, o = DEFAULTS) {
  const usable = venues.filter(v => v.sameLine !== false && (APPS.has(v.venue) || BOOKS.has(v.venue)) && v.ev != null && v.ev <= o.maxEv);
  usable.sort((a, b) => b.ev - a.ev);
  return usable[0] || null;
}

// ─── track record ───
// One row per bet and venue, logged the first time that venue beats the
// money's price by minEv. Graded three ways:
//   exec   the venue's own price for the bet at the first read lagMs on:
//          still there at the same line and payout or better?
//   close  the money's market at the last read before the start (its mid),
//          and the sharp price then (Pinnacle no-vig, the props' sharp
//          consensus): the EV our ticket had at the close, both ways
//   result ESPN (props from the box score, game lines from the final score)
function createBigMoneyTracker({ store = createMemoryStore(), propGrader = null, gameGrader = null, now = () => Date.now(), lagMs = DEFAULTS.lagMs, voidAfterMs = 3 * 86400e3, log = console } = {}) {
  const ready = store.init();
  const open = new Map();
  const loaded = ready.then(async () => { for (const r of await store.all()) if (r.status === 'open' || r.status === 'locked') open.set(r.id, r); });
  const put = r => store.put(r).catch(e => log.warn?.(`Big money: ${e.message}`));

  // plays (priced, with .best) → the rows logged now
  async function record(plays = []) {
    await loaded;
    const t = now(), fresh = [];
    const known = new Set((await store.all()).map(r => r.id));
    for (const p of plays) {
      const b = p.best;
      if (!b || !(b.ev >= p.minEv)) continue;
      const id = `${p.betKey}|${b.venue}|${b.line ?? ''}`;
      if (known.has(id)) continue;
      known.add(id);
      const r = {
        id, status: 'open', flaggedAt: iso(t), kind: p.kind, sport: p.sport, title: p.title, betKey: p.betKey, side: p.side, start: p.start,
        venue: b.venue, line: b.line ?? null, sameLine: b.sameLine !== false, decimal: b.decimal, implied: b.implied, american: b.american ?? null, entry: b.entry || null,
        moneyExchange: p.money.exchange, moneyMarket: p.money.market, moneyYes: p.money.yes, moneyUsd: p.money.usd, moneyPrice: p.money.price, moneyLine: p.line ?? null,
        fair: b.fair ?? p.money.price, pin: p.pinFair ?? null, ev: b.ev, evPin: b.evPin ?? null, flow: p.flow, why: p.why,
        prop: p.prop || null, game: p.game || null,
      };
      open.set(id, r);
      fresh.push(r);
    }
    await Promise.all(fresh.map(put));
    return fresh;
  }

  // every scan: lookup(row) → { venue: { line, decimal } | null, close: fair of
  // our side at our line from the money's market | null, sharp: the sharp
  // fair at our line | null }
  async function mark(lookup) {
    await loaded;
    const t = now(), writes = [];
    for (const r of open.values()) {
      if (r.status !== 'open') continue;
      if (ms(r.start) <= t) { r.status = 'locked'; writes.push(put(r)); continue; }
      let x = null;
      try { x = lookup(r); } catch (e) { log.warn?.(`Big money mark: ${e.message}`); }
      if (!x) continue;
      let dirty = false;
      if (r.execOk == null && t - ms(r.flaggedAt) >= lagMs) {
        const v = x.venue;
        r.execOk = !!(v && v.line === r.line && v.decimal >= r.decimal - 1e-6);
        r.execAt = iso(t);
        dirty = true;
      }
      if (x.close != null && x.close !== r.closeFair) { r.closeFair = r4(x.close); r.closeEv = r2((x.close * r.decimal - 1) * 100); r.closeAt = iso(t); dirty = true; }
      if (x.sharp != null && x.sharp !== r.sharpFair) { r.sharpFair = r4(x.sharp); r.sharpEv = r2((x.sharp * r.decimal - 1) * 100); dirty = true; }
      if (dirty) writes.push(put(r));
    }
    await Promise.all(writes);
  }

  // locked rows past their game → graded from ESPN
  async function grade() {
    await loaded;
    const t = now();
    let n = 0;
    for (const r of [...open.values()]) {
      if (r.status !== 'locked' || ms(r.start) + 3 * HOUR > t) continue;
      let g = null;
      try {
        if (r.kind === 'prop' && propGrader && r.prop) g = await propGrader.grade({ ...r.prop, signalLine: r.line, signalSide: r.side });
        else if (r.kind === 'game' && gameGrader && r.game) g = await gameGrader(r.game, r.betKey);
      } catch (e) { log.warn?.(`Big money grade: ${e.message}`); continue; }
      if (!g || g.pending) {
        if (ms(r.start) + voidAfterMs <= t) { r.status = 'void'; r.gradedAt = iso(t); open.delete(r.id); await put(r); }
        continue;
      }
      const outcome = g.outcome;
      r.result = g.result ?? null;
      r.outcome = outcome;
      r.profit = outcome === 'win' ? r4(r.decimal - 1) : outcome === 'loss' ? -1 : 0;
      r.status = 'graded';
      r.gradedAt = iso(t);
      open.delete(r.id);
      n++;
      await put(r);
    }
    return n;
  }

  async function summary() {
    await loaded;
    const all = await store.all();
    const graded = all.filter(r => r.status === 'graded' && r.outcome !== 'push');
    const mean = a => (a.length ? r4(a.reduce((x, v) => x + v, 0) / a.length) : null);
    const part = list => {
      const g = list.filter(r => r.status === 'graded' && r.outcome !== 'push');
      const units = g.reduce((a, r) => a + r.profit, 0);
      const clv = list.map(r => r.closeEv).filter(v => v != null), sharp = list.map(r => r.sharpEv).filter(v => v != null);
      const ex = list.filter(r => r.execOk != null);
      return { n: list.length, graded: g.length, wins: g.filter(r => r.outcome === 'win').length, losses: g.filter(r => r.outcome === 'loss').length,
        units: r2(units), roi: g.length ? r4(units / g.length) : null, avgCloseEv: mean(clv), closeN: clv.length, avgSharpEv: mean(sharp), sharpN: sharp.length,
        execN: ex.length, execOkPct: ex.length ? r4(ex.filter(r => r.execOk).length / ex.length) : null };
    };
    const by = (f) => { const m = {}; for (const r of all) { const k = f(r); if (k == null) continue; (m[k] ||= []).push(r); } return Object.fromEntries(Object.entries(m).map(([k, l]) => [k, part(l)])); };
    return { open: [...open.values()].filter(r => r.status === 'open').length, locked: [...open.values()].filter(r => r.status === 'locked').length,
      overall: part(all), graded: graded.length, byFlow: by(r => r.flow), byVenue: by(r => r.venue), byKind: by(r => r.kind), byLine: by(r => (r.sameLine ? 'same line' : 'other line')) };
  }
  async function list() { await loaded; return store.all(); }
  return { record, mark, grade, summary, list, ready: () => loaded, store };
}

// A final score → a game bet's outcome. key: `${id}|ml|home` and so on;
// score: { home, away } points.
function gameOutcome(key, score) {
  const p = key.split('|'), side = p[p.length - 1], kind = p[1];
  const h = num(score?.home), a = num(score?.away);
  if (h == null || a == null) return null;
  let margin;   // our side's points over the line, > 0 wins
  if (kind === 'ml' || kind === 'ml3') margin = side === 'draw' ? (h === a ? 1 : -1) : side === 'home' ? h - a : a - h;
  else if (kind === 'total') margin = side === 'over' ? h + a - Number(p[2]) : Number(p[2]) - (h + a);
  else if (kind === 'spread') { const hp = Number(p[2]); margin = side === 'home' ? h + hp - a : a - hp - h; }
  else return null;
  return { outcome: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push', result: `${a}-${h}` };
}

// Every pregame Kalshi taker print of $1,000+ (blocks out) on 42,874 settled sports
// game and prop markets, Sep 18 to Oct 14 2026 (diag-bigmoney). Win rate vs the price
// paid, errors clustered by game. Big money alone doesn't beat its price, so the edge
// has to come from the gap to the app or book; the two-way (market maker) money did
// no worse than one-way money.
const BACKTEST = {
  from: '2026-09-18', to: '2026-10-14', markets: 42874, prints: 61179, games: 2291,
  all: { winVsPrice: -0.9, se: 1.1, roiAfterFee: -2.9, roiAt2m: -3.0, clv: 0.4 },
  byFlow: { twoWay: { prints: 16862, winVsPrice: 2.1, se: 0.8 }, oneWay: { prints: 44317, winVsPrice: -2.1, se: 1.6 } },
  bySize: { over25k: { prints: 1091, winVsPrice: -4.2, se: 2.3 } },
  props: { prints: 11342, winVsPrice: 1.5, se: 0.9 },
  summary: 'Backtest, every $1,000+ Kalshi taker print before 2,291 games (Sep 18 to Oct 14): the money won 0.9 points less often than the price it paid (±1.1), -2.9% a bet after the fee, and $25K+ prints did worst. So the money only tells you a fair-ish price; the edge is the gap to the app or book. Money on a market where the other side also traded (the market-maker label) did no worse than one-way money, so it is shown by default.',
};

module.exports = {
  DEFAULTS, BACKTEST, BOOK_NAMES, optsFromEnv, american, normPrint, rowBets, flipKey, betLabel, pinFair, exchangeCost, gameIndex, rungIndex, bookPropIndex, atLine, appPrice,
  propVenues, flowOf, groupMoney, pickBest, createBigMoneyTracker, gameOutcome,
};
