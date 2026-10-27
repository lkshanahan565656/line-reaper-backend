// ─── GLOBAL SEARCH: ONE BOX OVER EVERYTHING THE SITE HOLDS RIGHT NOW ────────
// The app's SEARCH box (and /api/search, /api/v1/search) looks a name up in
// what the server already has in memory, never in anything made up:
//   - games on the odds screen (oddsscreen.js): a team, or "Lakers Celtics",
//     with each side's best bettable price for the picked state
//   - players on the props board (propsboard.js): their props and apps
//   - stat markets on the props board ("Pass Yards", "Kills") and the game
//     markets (moneyline, spread, total) when there are games
//   - esports series: the MATCHUPS engines (LoL, CS2, Valorant) and the
//     esports board's matches (Dota 2 and the rest)
//   - leagues (leagues.js) that hold anything right now
// Each hit carries `go`: where the app jumps (a tab, a view and its filter,
// a row id), the same for everyone. Nothing here is per user and nothing is
// a bet or a claim: prices are the venues' own, with no fair or EV.
//
// Pure: build(sources, { now }) → entries; query(entries, q, opts) → hits.
'use strict';

const KINDS = ['game', 'series', 'player', 'market', 'league'];
const KIND_LABEL = { game: 'Games', series: 'Esports series', player: 'Players', market: 'Markets', league: 'Leagues' };
const MAX_Q = 60;
const GAME_MARKETS = [
  { key: 'ml', name: 'Moneyline', words: 'moneyline money line ml winner h2h' },
  { key: 'spread', name: 'Spread', words: 'spread handicap point spread run line puck line' },
  { key: 'total', name: 'Total', words: 'total over under o/u points total' },
];

// lower case, accents off, punctuation to spaces: "Gen.G" → "gen g", "Mbappé" → "mbappe"
function norm(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
}
const cleanQ = q => String(q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_Q);
const iso = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
const r4 = x => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

// the side's best bettable price (oddsscreen.js marks it per state)
function sidePrice(s) {
  const v = (s.venues || []).find(x => x.best && !x.ref);
  return v ? { label: s.label, venue: v.venue, venueName: v.name, american: v.american ?? null, decimal: r4(v.decimal), point: v.point ?? null } : { label: s.label, venue: null };
}

function gameEntries(screen) {
  const out = [];
  for (const g of screen?.games || []) {
    if (!g || !g.id || !g.home || !g.away) continue;
    const ml = (g.markets || []).find(m => m.key === 'ml') || (g.markets || [])[0];
    out.push({
      kind: 'game', id: `g:${g.id}`, title: `${g.away} @ ${g.home}`, sub: g.leagueLabel || g.league || '', start: iso(g.start),
      names: [g.home, g.away], words: [g.leagueLabel, g.league].filter(Boolean),
      market: ml ? ml.label || ml.key : null, prices: ml ? (ml.sides || []).map(sidePrice) : [],
      venues: g.venues ?? null,
      go: { tab: 'odds', view: 'lines', game: String(g.id), league: g.league || '', q: g.home },
    });
  }
  return out;
}

// one player a sport: their props across the apps
function playerEntries(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || !r.player) continue;
    const k = `${r.sport || ''}|${norm(r.player)}`;
    let e = by.get(k);
    if (!e) {
      e = { kind: 'player', id: `p:${k}`, title: r.player, sport: r.sport || '', team: r.team || '', esports: !!r.esports, start: null, markets: new Map(), apps: new Set(), matchTitle: r.matchTitle || '' };
      by.set(k, e);
    }
    if (!e.team && r.team) e.team = r.team;
    const st = iso(r.startTime);
    if (st && (!e.start || st < e.start)) e.start = st;
    const books = Object.entries(r.books || {});
    for (const [b] of books) e.apps.add(b);
    if (r.market && !e.markets.has(r.market)) {
      const line = books.map(([, c]) => c?.line).find(Number.isFinite);
      e.markets.set(r.market, line ?? null);
    }
  }
  return [...by.values()].map(e => ({
    kind: 'player', id: e.id, title: e.title, sub: [e.sport, e.team].filter(Boolean).join(' · '), start: e.start,
    names: [e.title], words: [e.team, e.sport, e.matchTitle].filter(Boolean),
    props: e.markets.size, apps: [...e.apps].sort(),
    lines: [...e.markets.entries()].slice(0, 3).map(([market, line]) => ({ market, line })),
    go: { tab: 'props', view: 'cards', sport: e.sport || 'ALL', q: e.title },
  }));
}

// a stat market a sport on the props board, and the game markets when there are games
function marketEntries(rows, games) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || !r.market) continue;
    const k = `${r.sport || ''}|${norm(r.market)}`;
    const e = by.get(k) || { market: r.market, sport: r.sport || '', players: new Set() };
    e.players.add(norm(r.player));
    by.set(k, e);
  }
  const out = [...by.values()].map(e => ({
    kind: 'market', id: `m:${e.sport}|${norm(e.market)}`, title: e.market, sub: `${e.sport ? e.sport + ' ' : ''}player props`,
    names: [e.market], words: [e.sport], count: e.players.size, countWord: 'players',
    go: { tab: 'props', view: 'cards', sport: e.sport || 'ALL', q: e.market },
  }));
  const gs = games || [];
  for (const m of GAME_MARKETS) {
    const n = gs.filter(g => (g.markets || []).some(x => x.key === m.key)).length;
    if (n) out.push({ kind: 'market', id: `m:game|${m.key}`, title: m.name, sub: 'Game lines on the odds screen', names: [m.name], words: [m.words], count: n, countWord: 'games', go: { tab: 'odds', view: 'lines', market: m.key } });
  }
  return out;
}

const pairKey = (game, teams) => `${String(game || '').toUpperCase()}|${(teams || []).map(norm).sort().join('|')}`;
// MATCHUPS first (they open on the series' own card), then the board's other matches
function seriesEntries(matchups, matches) {
  const out = [], seen = new Set();
  for (const mu of matchups || []) {
    const names = (mu?.teams || []).map(t => t?.name).filter(Boolean);
    if (!mu?.id || names.length < 2) continue;
    seen.add(pairKey(mu.game, names));
    const k = mu.markets?.kalshi, u = mu.markets?.pmus;
    out.push({
      kind: 'series', id: `mu:${mu.game}:${mu.id}`, title: names.join(' vs '), sub: [mu.game === 'VAL' ? 'VALORANT' : mu.game === 'LOL' ? 'LoL' : mu.game, mu.league].filter(Boolean).join(' · '), start: iso(mu.start),
      names, words: [mu.league, mu.game, ...(mu.teams || []).map(t => t?.code)].filter(Boolean), live: mu.state === 'inProgress',
      // the cost to buy each side, fee in, as the MATCHUPS card shows it (cents on an exchange)
      exchanges: [k?.sides ? { venue: 'kalshi', venueName: 'Kalshi', costs: k.sides.map(sd => r4(sd?.cost)) } : null, u?.sides ? { venue: 'polymarketus', venueName: 'Polymarket US', costs: u.sides.map(sd => r4(sd?.cost)) } : null].filter(Boolean),
      go: { tab: 'esports', mode: 'matchups', game: mu.game, id: String(mu.id) },
    });
  }
  for (const m of matches || []) {
    const names = (m?.teams || []).map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
    if (!m?.id || names.length < 2) continue;
    const g = String(m.game || '').toUpperCase();
    const key = pairKey(g === 'CS' ? 'CS2' : g, names);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'series', id: `es:${m.id}`, title: names.join(' vs '), sub: [m.label || m.game, m.tournament].filter(Boolean).join(' · '), start: iso(m.start),
      names, words: [m.tournament, m.label, m.game].filter(Boolean), live: !!m.live,
      go: { tab: 'esports', mode: 'matches', game: m.game, id: String(m.id) },
    });
  }
  return out;
}

// leagues.js entries that hold something now, with what they hold
function leagueEntries(defs, { games = [], rows = [], matchups = [], matches = [] } = {}) {
  const out = [];
  for (const [slug, L] of Object.entries(defs || {})) {
    const keys = new Set((L.keys || []).map(k => String(k).toLowerCase()));
    const nGames = games.filter(g => keys.has(String(g.league || '').toLowerCase())).length;
    const nProps = L.props ? rows.filter(r => r.sport === L.props).length : 0;
    const esGame = L.es?.emu || L.es?.game;
    const nSeries = esGame ? matchups.filter(m => m.game === esGame).length + matches.filter(m => keys.has(String(m.game || '').toLowerCase())).length : 0;
    if (!nGames && !nProps && !nSeries) continue;
    // the app view that holds the most of it
    let go;
    if (L.esports && nSeries) go = { tab: 'esports', mode: L.es?.emu && L.es.emu !== 'SOCCER' ? 'matchups' : 'matches', game: L.es?.emu && L.es.emu !== 'SOCCER' ? L.es.emu : L.es?.game || '' };
    else if (nGames && L.lines) go = { tab: 'odds', view: 'lines', league: L.lines };
    else if (nProps) go = { tab: 'props', view: 'cards', sport: L.props, q: '' };
    else if (nSeries) go = { tab: 'esports', mode: 'matchups', game: esGame };
    else continue;
    out.push({
      kind: 'league', id: `l:${slug}`, title: L.name, sub: L.long && L.long !== L.name ? L.long : '', names: [L.name, L.long], words: [slug, ...(L.keys || []), L.noun].filter(Boolean),
      counts: { games: nGames, props: nProps, series: nSeries }, page: L.path, go,
    });
  }
  return out;
}

// every entry, with the text it is found by
function build({ screen = null, propRows = [], matchups = [], esMatches = [], leagues = {} } = {}) {
  const games = screen?.games || [];
  const entries = [
    ...gameEntries(screen),
    ...seriesEntries(matchups, esMatches),
    ...playerEntries(propRows),
    ...marketEntries(propRows, games),
    ...leagueEntries(leagues, { games, rows: propRows, matchups, matches: esMatches }),
  ];
  for (const e of entries) {
    e._names = (e.names || []).map(norm).filter(Boolean);
    e._all = norm([e.title, ...(e.names || []), ...(e.words || [])].join(' '));
    e._words = new Set(e._all.split(' '));
    delete e.names; delete e.words;
  }
  return entries;
}

// how well one entry fits the query (0 = not at all). Every query word must
// start a word of the entry (or sit inside its text); a whole name scores most.
function score(e, qn, toks) {
  if (!toks.length) return 0;
  const title = norm(e.title);
  let s = 0;
  if (title === qn || e._names.includes(qn)) s = 100;
  else if (title.startsWith(qn) || e._names.some(n => n.startsWith(qn))) s = 80;
  else if (e._names.some(n => n.includes(qn))) s = 60;
  for (const t of toks) {
    if (e._words.has(t)) { s += 6; continue; }
    if ([...e._words].some(w => w.startsWith(t))) { s += 4; continue; }
    if (t.length >= 3 && e._all.includes(t)) { s += 1; continue; }
    return 0;
  }
  return s;
}
const KIND_RANK = { game: 5, series: 5, player: 4, league: 3, market: 2 };

// the hits for q, best first; at most `limit` in all and `perKind` of a kind
function query(entries, q, { limit = 30, perKind = 8, kinds = null, now = Date.now() } = {}) {
  const qn = norm(cleanQ(q));
  const toks = qn.split(' ').filter(Boolean);
  if (!toks.length || qn.replace(/ /g, '').length < 2) return [];
  const want = kinds && kinds.length ? new Set(kinds) : null;
  const scored = [];
  for (const e of entries || []) {
    if (want && !want.has(e.kind)) continue;
    const s = score(e, qn, toks);
    if (!s) continue;
    // sooner first among equals; anything already over long ago sinks
    const t = e.start ? Date.parse(e.start) : NaN;
    const soon = Number.isFinite(t) ? (t < now - 6 * 3600e3 ? -3 : Math.max(0, 2 - Math.max(0, t - now) / 86400e3)) : 0;
    scored.push({ e, s: s + KIND_RANK[e.kind] + soon });
  }
  scored.sort((a, b) => b.s - a.s || String(a.e.title).localeCompare(String(b.e.title)));
  const per = {}, out = [];
  for (const { e } of scored) {
    if (out.length >= limit) break;
    per[e.kind] = (per[e.kind] || 0) + 1;
    if (per[e.kind] > perKind) continue;
    out.push(publicHit(e));
  }
  return out;
}
// an entry as the API sends it (no search internals)
function publicHit(e) {
  const { _names, _all, _words, ...rest } = e;
  return rest;
}

// what the search holds, a count a kind (the box's empty state says it)
function summary(entries) {
  const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const e of entries || []) counts[e.kind] = (counts[e.kind] || 0) + 1;
  return counts;
}

module.exports = { KINDS, KIND_LABEL, GAME_MARKETS, MAX_Q, norm, cleanQ, build, query, summary, gameEntries, playerEntries, marketEntries, seriesEntries, leagueEntries };
