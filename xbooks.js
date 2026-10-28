// ─── MORE BOOKS: THE CROSS-COMPARISON PAST PINNACLE ─────────────────────────
// Pinnacle alone set almost every fair on the board, and FanDuel and BetRivers
// were the only US books to bet at. Two more free feeds widen both sides
// (probed from GitHub's runners 2026-10-14; DraftKings, Caesars, Fanatics and
// bet365 still block a direct read):
//
//   Action Network  the JSON its odds pages read (api.actionnetwork.com
//                   web/v2/scoreboard): each US book's main moneyline, spread
//                   and total, and player props by type (customPickTypes),
//                   for DraftKings, BetMGM, Caesars, bet365, Fanatics, Hard
//                   Rock and theScore Bet (ESPN Bet's successor). Soft books:
//                   venues to bet at and comparison columns, never the fair.
//   Matchbook       the exchange's public REST (api.matchbook.com edge/rest
//                   events with prices): moneylines, full spread and total
//                   ladders and some player props, with the money waiting at
//                   each price. A sharp source (ev.SHARP_WEIGHTS matchbook).
//                   Its best back on each side reads as a two-way price; a
//                   side with under minDepth dollars waiting doesn't count.
//
// Both come out in freebooks' book-game shape ({ book, home, away, start,
// h2h, spreads, totals, props }), so fetchFreeBooks merges them onto
// Pinnacle's games beside FanDuel and BetRivers and every screen downstream
// (+EV, alt lines, book arbs, the sharp consensus) sees them.
// Pure parsing plus the fetchers; the server decides how often.

const { canonMarket } = require('./ev');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const AN = 'https://api.actionnetwork.com/web/v2/scoreboard';
const MB = 'https://api.matchbook.com/edge/rest/events';

// Action Network book ids (its /web/v1/books list; NJ where a book is per state)
const AN_BOOKS = {
  68: { key: 'draftkings', title: 'DraftKings' },
  75: { key: 'betmgm', title: 'BetMGM' },
  123: { key: 'caesars', title: 'Caesars' },
  79: { key: 'bet365', title: 'bet365' },
  2988: { key: 'fanatics', title: 'Fanatics' },
  2724: { key: 'hardrock', title: 'Hard Rock' },
  4620: { key: 'thescore', title: 'theScore Bet' },
};
const TITLES = { ...Object.fromEntries(Object.values(AN_BOOKS).map(b => [b.key, b.title])), matchbook: 'Matchbook' };
const SOFT_BOOKS = Object.values(AN_BOOKS).map(b => b.key);

// board sport → Action league, days of slate to read, Matchbook sport id
const LEAGUES = {
  nfl: { an: 'nfl', days: 7, mb: 1 },
  ncaaf: { an: 'ncaaf', days: 4, mb: 1, extra: '&division=FBS' },
  nba: { an: 'nba', days: 2, mb: 4 },
  wnba: { an: 'wnba', days: 2, mb: 4 },
  nhl: { an: 'nhl', days: 2, mb: 6 },
  mlb: { an: 'mlb', days: 2, mb: 3 },
};
// Action's prop types (customPickTypes; the name must match exactly, found by
// reading market_rules back) → our stat keys
// (read off market_rules 2026-10-14)
const FB = { core_bet_type_9_passing_yards: 'pass_yds', core_bet_type_11_passing_tds: 'pass_tds', core_bet_type_12_rushing_yards: 'rush_yds',
  core_bet_type_15_receptions: 'receptions', core_bet_type_16_receiving_yards: 'rec_yds', core_bet_type_18_rushing_attempts: 'rush_att',
  core_bet_type_30_passing_attempts: 'pass_att', core_bet_type_65_interceptions: 'pass_ints', core_bet_type_66_rushing_receiving_yards: 'rush_rec_yds',
  core_bet_type_71_passing_rushing_yards: 'pass_rush_yds', core_bet_type_59_longest_reception: 'longest_rec', core_bet_type_58_longest_rush: 'longest_rush',
  core_bet_type_60_longest_completion: 'longest_comp' };
const BB = { core_bet_type_27_points: 'points', core_bet_type_23_rebounds: 'rebounds', core_bet_type_26_assists: 'assists', core_bet_type_21_3fgm: 'threes',
  core_bet_type_24_steals: 'steals', core_bet_type_25_blocks: 'blocks', core_bet_type_85_points_rebounds_assists: 'pra', core_bet_type_86_points_rebounds: 'pts_rebs',
  core_bet_type_87_points_assists: 'pts_asts', core_bet_type_88_rebounds_assists: 'rebs_asts', core_bet_type_89_steals_blocks: 'stocks' };
const AN_PROPS = {
  nfl: FB, ncaaf: FB, nba: BB, wnba: BB,
  nhl: { core_bet_type_31_shots_on_goal: 'shots_on_goal', core_bet_type_27_points: 'points', core_bet_type_26_assists: 'assists', core_bet_type_55_goals: 'goals' },
  mlb: { core_bet_type_37_strikeouts: 'strikeouts', core_bet_type_36_hits: 'hits', core_bet_type_77_total_bases: 'total_bases', core_bet_type_42_pitching_outs: 'pitcher_outs',
    core_bet_type_72_hits_allowed: 'hits_allowed', core_bet_type_74_earned_runs: 'earned_runs', core_bet_type_76_walks: 'walks', core_bet_type_78_runs_scored: 'runs',
    core_bet_type_34_rbi: 'rbis', core_bet_type_32_singles: 'singles' },
};

const { num } = require('./mathutil');
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const american = v => { const a = num(v); return a != null && Math.abs(a) >= 100 ? Math.round(a) : null; };
const decToAm = d => (d >= 2 ? Math.round((d - 1) * 100) : d > 1 ? Math.round(-100 / (d - 1)) : null);

// ── Action Network ──
// v2 scoreboard: games[] with teams, players and markets[bookId].event[type]
// = outcomes { side home|away|over|under, team_id, player_id, value, odds,
// is_alt_market, line_status }. → book games, one per game and book.
function parseAction(payload, { now = Date.now(), props = {} } = {}) {
  const out = [];
  for (const g of payload?.games || []) {
    const start = ms(g.start_time);
    if (!(start > now) || !/^scheduled$/i.test(g.status || 'scheduled')) continue;
    const team = id => (g.teams || []).find(t => t.id === id)?.full_name || null;
    const home = team(g.home_team_id), away = team(g.away_team_id);
    if (!home || !away) continue;
    const players = new Map((g.players || []).map(p => [p.id, p.full_name]));
    for (const [bid, m] of Object.entries(g.markets || {})) {
      const book = AN_BOOKS[bid];
      if (!book) continue;
      const ev = m?.event || {};
      const live = o => o && !o.is_live && !o.is_alt_market && (o.line_status == null || o.line_status === 'normal') && american(o.odds) != null;
      const two = (list, a, b) => { const x = (list || []).filter(live); return [x.find(o => o.side === a), x.find(o => o.side === b)]; };
      const bg = { book: book.key, eventId: `an-${g.id}`, home, away, start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [], props: [], ladders: [], alts: [] };
      const [mh, ma] = two(ev.moneyline, 'home', 'away');
      if (mh && ma) bg.h2h.push({ name: home, price: american(mh.odds) }, { name: away, price: american(ma.odds) });
      const [sh, sa] = two(ev.spread, 'home', 'away');
      if (sh && sa && num(sh.value) != null && num(sh.value) === -num(sa.value) && num(sh.value) !== 0)
        bg.spreads.push({ name: home, price: american(sh.odds), point: num(sh.value) }, { name: away, price: american(sa.odds), point: num(sa.value) });
      const [to, tu] = two(ev.total, 'over', 'under');
      if (to && tu && num(to.value) != null && num(to.value) === num(tu.value))
        bg.totals.push({ name: 'Over', price: american(to.odds), point: num(to.value) }, { name: 'Under', price: american(tu.odds), point: num(tu.value) });
      for (const [type, mkey] of Object.entries(props)) {
        const pairs = new Map();
        for (const o of (ev[type] || []).filter(live)) {
          const k = `${o.player_id}|${num(o.value)}`;
          if (!pairs.has(k)) pairs.set(k, {});
          pairs.get(k)[o.side] = o;
        }
        for (const { over, under } of pairs.values()) {
          const player = over && players.get(over.player_id);
          if (!player || !under) continue;
          bg.props.push({ player, mkey, line: num(over.value), over: american(over.odds), under: american(under.odds) });
        }
      }
      if (bg.h2h.length || bg.spreads.length || bg.totals.length || bg.props.length) out.push(bg);
    }
  }
  return out;
}
const anDate = (now, d) => new Date(now - 5 * 3600e3 + d * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
function actionUrls(sport, { now = Date.now(), withProps = true } = {}) {
  const L = LEAGUES[sport];
  if (!L?.an) return [];
  const types = withProps ? Object.keys(AN_PROPS[sport] || {}) : [];
  const books = Object.keys(AN_BOOKS).join(',');
  return Array.from({ length: L.days }, (_, d) => `${AN}/${L.an}?bookIds=${books}&periods=event&date=${anDate(now, d)}${L.extra || ''}${types.length ? `&customPickTypes=${types.join(',')}` : ''}`);
}

// ── Matchbook ──
// events[]: name "Away at Home" (US sports) or "A vs B", start, markets[]
// { name, market-type money_line | handicap | total, runners[] { name,
// handicap, prices[] { side back | lay, decimal-odds, available-amount } } }.
// A player prop is a total named "Nix, B - Total Passing Yards".
const MB_STAT = /^(.+?) - Total (.+)$/;
function bestBack(r, minDepth) {
  const b = (r?.prices || []).filter(p => (p.side === 'back' || p.side === 'win') && p['decimal-odds'] > 1 && (p['available-amount'] || 0) >= minDepth)
    .sort((x, y) => y['decimal-odds'] - x['decimal-odds'])[0];
  return b ? decToAm(b['decimal-odds']) : null;
}
// two backs make a two-way price; an over-round past maxHold is a market
// nobody is making, not a price
function okPair(a, b, maxHold) {
  const p = x => (x > 0 ? 100 / (x + 100) : -x / (-x + 100));
  return a != null && b != null && p(a) + p(b) <= 1 + maxHold && p(a) + p(b) >= 0.97;
}
// Player props only with props: true. Its US props are a market maker's
// quotes with nothing matched: 27% sat within a point of Pinnacle's no-vig
// (median 1.8 points off, 22 shared lines), and one, Shaheed receptions
// -116 / -104 against Pinnacle's +151 / -193, made three fake plays
// (2026-10-15). Game lines track Pinnacle closely and stay on.
function parseMatchbook(payload, { now = Date.now(), minDepth = 20, maxHold = 0.08, props = false } = {}) {
  const out = [];
  for (const e of payload?.events || []) {
    const start = ms(e.start);
    if (!(start > now) || e.status !== 'open') continue;
    const m = /^(.+?)\s+(?:at|@)\s+(.+)$/.exec(String(e.name || '')) || /^(.+?)\s+vs\.?\s+(.+)$/.exec(String(e.name || ''));
    if (!m) continue;
    const away = m[1].trim(), home = m[2].trim();
    const bg = { book: 'matchbook', eventId: `mb-${e.id}`, home, away, start: new Date(start).toISOString(), h2h: [], spreads: [], totals: [], props: [], ladders: [], alts: [] };
    for (const mk of e.markets || []) {
      if (mk.status !== 'open' || /half|quarter|period|inning|1st|2nd|3rd/i.test(mk.name || '')) continue;
      const rs = mk.runners || [];
      if (mk['market-type'] === 'money_line' && /^moneyline$/i.test(mk.name || '') && rs.length === 2) {
        const h = rs.find(r => r.name === home), a = rs.find(r => r.name === away);
        const ph = bestBack(h, minDepth), pa = bestBack(a, minDepth);
        if (okPair(ph, pa, maxHold)) bg.h2h.push({ name: home, price: ph }, { name: away, price: pa });
      } else if (mk['market-type'] === 'handicap' && /^handicap$/i.test(mk.name || '') && rs.length === 2) {
        const h = rs.find(r => String(r.name).startsWith(home)), a = rs.find(r => String(r.name).startsWith(away));
        const ph = bestBack(h, minDepth), pa = bestBack(a, minDepth);
        if (h && a && num(h.handicap) === -num(a.handicap) && num(h.handicap) !== 0 && okPair(ph, pa, maxHold))
          bg.spreads.push({ name: home, price: ph, point: num(h.handicap) }, { name: away, price: pa, point: num(a.handicap) });
      } else if (mk['market-type'] === 'total' && rs.length === 2) {
        const o = rs.find(r => /^over/i.test(r.name)), u = rs.find(r => /^under/i.test(r.name));
        const line = num(o?.handicap ?? mk.handicap);
        const po = bestBack(o, minDepth), pu = bestBack(u, minDepth);
        if (line == null || !okPair(po, pu, maxHold)) continue;
        const sm = MB_STAT.exec(String(mk.name || ''));
        if (/^total$/i.test(mk.name || '')) bg.totals.push({ name: 'Over', price: po, point: line }, { name: 'Under', price: pu, point: line });
        else if (sm && props) bg.props.push({ player: sm[1].trim(), mkey: statOf(sm[2]), line, over: po, under: pu });
      }
    }
    if (bg.h2h.length || bg.spreads.length || bg.totals.length || bg.props.length) out.push(bg);
  }
  return out;
}
const MB_STATS = { 'passing yards': 'pass_yds', 'rushing yards': 'rush_yds', 'receiving yards': 'rec_yds', receptions: 'receptions', 'passing touchdowns': 'pass_tds',
  'rushing attempts': 'rush_att', 'pass completions': 'pass_comp', 'passing attempts': 'pass_att', points: 'points', rebounds: 'rebounds', assists: 'assists',
  'shots on goal': 'shots_on_goal', strikeouts: 'strikeouts', 'pitcher strikeouts': 'strikeouts', 'total bases': 'total_bases' };
const statOf = s => MB_STATS[String(s).toLowerCase().trim()] || canonMarket(s);

// Matchbook writes "Nix, B" or "Waddle, Jaylen": the full name is whoever else
// in the game has that surname and first initial (one match only)
function resolvePlayer(short, names) {
  const m = /^(.+?),\s*(.+)$/.exec(String(short || ''));
  if (!m) return short;
  const words = x => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').trim().split(/\s+/);
  const last = words(m[1]).join(' '), first = words(m[2]).join(' ');
  const hits = [...new Set(names)].filter(n => {
    const c = words(n);
    return c.length >= 2 && c.slice(1).join(' ') === last && (c[0] === first || (first.length <= 2 && c[0][0] === first[0]));
  });
  return hits.length === 1 ? hits[0] : `${m[2]} ${m[1]}`;
}
// after mergeGames: Matchbook's prop names → the other books' full names
function resolveMatchbookNames(games) {
  for (const g of games || []) {
    const mb = g.bookmakers.find(b => b.key === 'matchbook');
    if (!mb) continue;
    const names = g.bookmakers.filter(b => b !== mb).flatMap(b => b.markets.flatMap(m => m.outcomes.map(o => o.description).filter(Boolean)));
    for (const m of mb.markets) for (const o of m.outcomes) if (o.description) o.description = resolvePlayer(o.description, names);
  }
  return games;
}

// ── fetch ──
// → { books: { nfl: [book games], … }, counts: { source: n }, errors }
async function fetchExtraBooks(http, { sports = Object.keys(LEAGUES), now = Date.now(), action = true, matchbook = true, withProps = true } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const get = url => http.get(url, { headers, timeout: 20000 }).then(r => r?.data);
  const books = Object.fromEntries(sports.map(s => [s, []]));
  const errors = [], counts = { action: 0, matchbook: 0 };
  const jobs = [];
  if (action) for (const s of sports) for (const url of actionUrls(s, { now, withProps })) jobs.push(async () => {
    try { const gs = parseAction(await get(url), { now, props: withProps ? AN_PROPS[s] : {} }); books[s].push(...gs); counts.action += gs.length; }
    catch (e) { errors.push(`action ${s}: ${e.response?.status || e.message}`); }
  });
  if (matchbook) {
    const ids = [...new Set(sports.map(s => LEAGUES[s].mb).filter(Boolean))];
    for (const id of ids) jobs.push(async () => {
      try {
        const gs = parseMatchbook(await get(`${MB}?sport-ids=${id}&per-page=300&include-prices=true&price-depth=3&states=open&odds-type=DECIMAL`), { now });
        // one sport id covers several leagues: mergeGames keeps the ones Pinnacle has
        for (const s of sports.filter(x => LEAGUES[x].mb === id)) books[s].push(...gs);
        counts.matchbook += gs.length;
      } catch (e) { errors.push(`matchbook ${id}: ${e.response?.status || e.message}`); }
    });
  }
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < jobs.length) await jobs[i++](); }));
  return { books, counts, errors };
}

module.exports = { AN_BOOKS, AN_PROPS, LEAGUES, TITLES, SOFT_BOOKS, parseAction, actionUrls, parseMatchbook, resolvePlayer, resolveMatchbookNames, fetchExtraBooks };
