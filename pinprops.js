// ─── PINNACLE PLAYER PROPS: THE SHARP PRICE FOR PICK'EM LINES ────────────────
// Pinnacle takes the sharpest action and posts both sides of its player props
// (NFL, NBA, WNBA, NHL, MLB, and college football's bigger games) on the same guest feed its website
// reads (guest.api.arcadia.pinnacle.com). Each prop is a "special" matchup
// ("C.J. Stroud Total Pass Completions") with Over and Under participants,
// priced in the league's straight markets. The vig comes out (power method on
// the pair), and the P(over) at Pinnacle's line becomes a source in
// sportprops.fairFor, worth several pick'em books. Not a licensed feed: it
// sits behind the pinnacle licence gate (licences.js) like the esports prices.
// Pure parsers are tested against a saved response; fetch is a thin wrapper.

const { canonName, canonMarket } = require('./ev');

const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
// CFB: Pinnacle's NCAA football league (26 player props up 2026-10-14)
// CBB: Pinnacle's NCAA basketball league (1 listing, futures only, 2026-10-15; the season starts in November)
const LEAGUES = { NFL: 889, NBA: 487, WNBA: 578, NHL: 1456, MLB: 246, CFB: 880, CBB: 493 };

// Pinnacle's stat words → the board's market keys (canonMarket), per sport
const STAT = {
  'pass completions': 'pass_comp', 'pass attempts': 'pass_att', 'touchdown passes': 'pass_tds', 'passing yards': 'pass_yds',
  'receptions': 'receptions', 'receiving yards': 'rec_yds', 'rushing yards': 'rush_yds', 'rushing attempts': 'rush_att', 'interceptions': 'pass_ints',
  'points': 'points', 'rebounds': 'rebounds', 'assists': 'assists', 'threes made': 'threes', 'pts & rebs & asts': 'pra',
  'pts & rebs': 'pts_rebs', 'pts & asts': 'pts_asts', 'rebs & asts': 'rebs_asts', 'steals': 'steals', 'blocks': 'blocks',
  'points & rebounds & assists': 'pra', 'points & rebounds': 'pts_rebs', 'points & assists': 'pts_asts', 'rebounds & assists': 'rebs_asts',
  'steals & blocks': 'stocks', 'blocks & steals': 'stocks', 'turnovers': 'turnovers', 'free throws made': 'ftm',
  'goals': 'goals', 'shots on goal': 'shots_on_goal', 'saves': 'saves',
  'bases': 'total_bases', 'home runs': 'home_runs', 'strikeouts': 'strikeouts', 'earned runs': 'earned_runs', 'pitching outs': 'pitcher_outs',
  'hits allowed': 'hits_allowed', 'hits': 'hits', 'runs': 'runs', 'rbis': 'rbis',
};

// "C.J. Stroud Total Pass Completions" → { player, mkey }
function parseDescription(desc) {
  const m = /^(.+?)\s+Total\s+(.+?)(?:\s*\(.*\))?$/.exec(String(desc || '').trim());
  if (!m) return null;
  // "Pts + Rebs" and "Pts & Rebs" are one stat
  const stat = m[2].toLowerCase().replace(/\s*\+\s*/g, ' & ');
  const mkey = STAT[stat] || canonMarket(stat);
  return { player: m[1].trim(), mkey };
}

const { toProb } = require('./mathutil');
// power devig: p^k + q^k = 1, so the longshot gives up more of the margin
function devigPower(po, pu) {
  let lo = 0.5, hi = 2;
  for (let i = 0; i < 50; i++) {
    const k = (lo + hi) / 2;
    if (po ** k + pu ** k > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return po ** k;
}

// matchups + straight markets for one league → [{ sport, player, key, mkey, line, pOver, start, over, under }]
function parseLeague(sport, matchups, markets, now = Date.now()) {
  const priced = new Map();
  for (const m of markets || []) if (m.type === 'total' && m.period === 0) priced.set(m.matchupId, m);
  const out = [];
  for (const mu of matchups || []) {
    if (mu.type !== 'special' || !/player props/i.test(mu.special?.category || '')) continue;
    const d = parseDescription(mu.special?.description);
    const mk = priced.get(mu.id);
    if (!d || !mk) continue;
    const start = Date.parse(mu.startTime || mu.parent?.startTime || '');
    if (!(start > now)) continue;
    const ids = Object.fromEntries((mu.participants || []).map(p => [p.name, p.id]));
    const over = mk.prices?.find(p => p.participantId === ids.Over), under = mk.prices?.find(p => p.participantId === ids.Under);
    if (!over || !under || over.points == null || over.points !== under.points) continue;
    const po = toProb(over.price), pu = toProb(under.price);
    if (!(po > 0 && pu > 0) || po + pu < 1) continue;
    out.push({ sport, player: d.player, mkey: d.mkey, key: `${sport}|${canonName(d.player)}|${d.mkey}`, line: Number(over.points),
      pOver: +devigPower(po, pu).toFixed(4), over: over.price, under: under.price, start: new Date(start).toISOString() });
  }
  return out;
}

// Fetch every league → { props, errors }. key (PINNACLE_GUEST_KEY) is sent
// when set; the feed answered without one from GitHub's runners (2026-10-14).
async function fetchPinnacleProps(http, key = '', leagues = LEAGUES) {
  const headers = { Accept: 'application/json', ...(key ? { 'X-API-Key': key } : {}) };
  const props = [], errors = [];
  for (const [sport, id] of Object.entries(leagues)) {
    try {
      const [mu, mk] = await Promise.all([
        http.get(`${PIN}/leagues/${id}/matchups`, { headers, timeout: 20000 }),
        http.get(`${PIN}/leagues/${id}/markets/straight`, { headers, timeout: 20000 }),
      ]);
      props.push(...parseLeague(sport, mu?.data, mk?.data));
    } catch (e) { errors.push(`${sport}: ${e.response?.status || e.message}`); }
  }
  return { props, errors };
}

// board row key → every Pinnacle quote for it (a player can have props up for
// two games at once)
function indexProps(props) {
  const idx = new Map();
  for (const p of props || []) { if (!idx.has(p.key)) idx.set(p.key, []); idx.get(p.key).push(p); }
  return idx;
}
// The quote for one board row: the same game only. Pinnacle posts opening
// night while the pick'em apps still list tonight's preseason game (Tatum 17.5
// points on PrizePicks vs 26.5 at Pinnacle, 2026-10-14), so a quote more than
// slackMs from the row's start is a different game, never a fair.
// Pinnacle can hang several lines on one stat (tennis totals and their
// alternates): quoteFor returns the one nearest the row's own lines,
// quotesForGame every line of that game (null when there is none).
function quotesForGame(idx, row, slackMs = 3 * 3600e3) {
  const list = idx?.get(row?.key);
  if (!list?.length) return null;
  const t = Date.parse(row.startTime || '');
  if (!t) return null;
  let best = null;
  for (const q of list) {
    const d = Math.abs(Date.parse(q.start) - t);
    if (d <= slackMs && (!best || d < best.d)) best = { q, d };
  }
  return best ? list.filter(q => q.start === best.q.start) : null;
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
// the quote nearest `line` (a list, or one quote)
function nearestLine(qs, line) {
  if (!Array.isArray(qs)) return qs || null;
  if (line == null) return qs[0] || null;
  return qs.reduce((a, b) => (!a || Math.abs(b.line - line) < Math.abs(a.line - line) ? b : a), null);
}
function quoteFor(idx, row, slackMs = 3 * 3600e3) {
  const qs = quotesForGame(idx, row, slackMs);
  if (!qs) return null;
  return nearestLine(qs, median(Object.values(row.books || {}).map(c => c.line).filter(x => x != null)));
}

module.exports = { quotesForGame, nearestLine, LEAGUES, STAT, parseDescription, devigPower, parseLeague, fetchPinnacleProps, indexProps, quoteFor };
