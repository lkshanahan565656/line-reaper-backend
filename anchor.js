// ─── ANCHOR: does a sharp book price this pick'em prop at all? ───────────────
// Every lane found the pick'em apps sit on the sharp number wherever a book
// prices the prop. An "unanchored" leg is one no sharp book (Pinnacle,
// FanDuel, BetRivers, Kalshi) lists for the same player and stat at any
// number: there is nothing to copy, so the app's line is its own guess.
// Tested 2026-10-25 (checks/unanchored-2026-10-25): no side, model or picker
// beat the apps' break-even on unanchored legs, so this is a tag that tells a
// user when there is no sharp number, never a play. Pure functions.

const ANCHOR_BOOKS = ['pinnacle', 'fanduel', 'betrivers', 'kalshi'];
const SHORT = { pinnacle: 'PIN', fanduel: 'FD', betrivers: 'BR', kalshi: 'KAL' };
const NAME = { pinnacle: 'Pinnacle', fanduel: 'FanDuel', betrivers: 'BetRivers', kalshi: 'Kalshi' };

// quotes: [{ book, line }] for the row's player, stat and game (any line);
// kalshi: true when Kalshi lists the player and stat at any rung.
// → { books: ['pinnacle', ...], lines: { pinnacle: 24.5 } } (the line nearest the apps')
function sportAnchor(row, quotes = [], { kalshi = false } = {}) {
  const appLines = Object.values(row?.books || {}).map(c => Number(c.line)).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = appLines.length ? appLines[Math.floor(appLines.length / 2)] : null;
  const lines = {};
  for (const q of quotes || []) {
    if (!ANCHOR_BOOKS.includes(q?.book) || !Number.isFinite(Number(q.line))) continue;
    const l = Number(q.line), o = lines[q.book];
    if (o == null || (mid != null && Math.abs(l - mid) < Math.abs(o - mid))) lines[q.book] = l;
  }
  if (kalshi && lines.kalshi == null) lines.kalshi = null;
  const books = ANCHOR_BOOKS.filter(b => b in lines);
  return { books, lines };
}

// Esports: Pinnacle, FanDuel and Kalshi post no esports player props; BetRivers
// hangs some tier-one per-map kill ladders. A row is anchored when BetRivers
// lists the same player's kills in a game near the row's start.
// brPlayers: Map `${game}|${nameKey}` → [startMs]
function esportsAnchor(row, brPlayers, nameKey, slackMs = 12 * 3600e3) {
  const isKills = /^(k|kills)(\||$)/i.test(String(row?.mkey || '')) || /kills/i.test(String(row?.market || ''));
  const t = Date.parse(row?.startTime || '');
  const starts = isKills && brPlayers ? brPlayers.get(`${row.sport}|${nameKey(row.player)}`) : null;
  const hit = !!starts?.some(s => !t || !s || Math.abs(s - t) <= slackMs);
  return hit ? { books: ['betrivers'], lines: { betrivers: null }, note: 'BetRivers map kills' } : { books: [], lines: {} };
}

// BetRivers esports events (esbooks.js) → the player index esportsAnchor reads
const ES_GAME = { LOL: 'LOL', DOTA: 'DOTA', CS: 'CS', CS2: 'CS', VAL: 'VAL' };
function brPlayerIndex(events, nameKey) {
  const idx = new Map();
  for (const g of events || []) {
    if (g?.book !== 'betrivers' || !g.players?.length) continue;
    const game = ES_GAME[String(g.game || '').toUpperCase()];
    if (!game) continue;
    for (const p of g.players) {
      const k = `${game}|${nameKey(p.player)}`;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(g.start || null);
    }
  }
  return idx;
}

const anchored = row => !!row?.anchor?.books?.length;
// "PIN 24.5 · FD 24.5" or "no sharp line"
function label(a) {
  if (!a?.books?.length) return 'no sharp line';
  return a.books.map(b => (a.lines?.[b] != null ? `${SHORT[b]} ${a.lines[b]}` : SHORT[b])).join(' · ');
}
function title(a) {
  if (!a?.books?.length) return 'No sharp book (Pinnacle, FanDuel, BetRivers, Kalshi) lists this player and stat: the app\'s line has no sharp number to copy. Tested 10-25: unanchored legs showed no edge.';
  return `${a.books.map(b => NAME[b]).join(', ')} list this player and stat${a.note ? ` (${a.note})` : ''}`;
}

// share of legs (one per app cell) with no sharp line, per sport and app
function summarize(rows) {
  const blank = () => ({ legs: 0, unanchored: 0 });
  const total = blank(), bySport = {}, byApp = {};
  for (const r of rows || []) {
    const sport = r.esports ? 'ESPORTS' : r.sport;
    const u = !anchored(r);
    for (const app of Object.keys(r.books || {})) {
      for (const o of [total, bySport[sport] ||= blank(), (byApp[app] ||= {})[sport] ||= blank()]) { o.legs++; if (u) o.unanchored++; }
    }
  }
  return { total, bySport, byApp };
}

module.exports = { ANCHOR_BOOKS, SHORT, sportAnchor, esportsAnchor, brPlayerIndex, anchored, label, title, summarize };
