// ─── ESPORTS MARKET LABELS (esmarkets.js) ──────────────────────────────────
// The map span and stat of an app's esports line ("MAPS 1-2 Kills", "Kills on
// Maps 1+2", "Kills Maps 1 2") as one key, shared by the server and the board
// recorder (esrecord.js). Moved out of server.js unchanged, 10-24.

// ONE parser for map spans, used by both the predictor and the cross-book key.
// Formats seen in the wild:
//   "Kills on Maps 1+2"    → maps 1,2      (2 maps)
//   "Kills on Maps 1+2+3"  → maps 1,2,3    (3 maps)  ← was silently read as 2
//   "MAPS 1-2 Kills"       → range 1..2    (2 maps)
//   "Kills on Maps 1-3"    → range 1..3    (3 maps)
//   "Kills on Map 1"       → map 1         (1 map)
//   "GAME 1+2+3 Kills"     → COD games     (3 maps)
// Returns { count, label } — label is the canonical span for cross-book keys.
function parseMapSpan(propText) {
  // "Maps 1 2" (Sleeper) → treat the space as a plus
  const t = (propText || '').toUpperCase().replace(/(\d)\s+(\d)/g, '$1+$2');
  const m = t.match(/(?:MAPS?|GAMES?)\s*([\d\s+\-–]+)/);
  if (!m) return { count: 1, label: '1' };
  const body = m[1].replace(/\s+/g, '');

  // Sum form: 1+2, 1+2+3 — count the terms
  if (body.includes('+')) {
    const nums = body.split('+').map(n => parseInt(n)).filter(n => isFinite(n));
    if (nums.length >= 2) return { count: nums.length, label: `${Math.min(...nums)}-${Math.max(...nums)}` };
  }
  // Range form: 1-2, 1-3 — inclusive span
  const r = body.match(/^(\d)[-–](\d)/);
  if (r) {
    const a = parseInt(r[1]), b = parseInt(r[2]);
    if (isFinite(a) && isFinite(b) && b >= a) return { count: b - a + 1, label: `${a}-${b}` };
  }
  const single = body.match(/^(\d)/);
  if (single) return { count: 1, label: single[1] };
  return { count: 1, label: '1' };
}

function normalizeName(n) {
  return (n || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

// Handles: "MAPS 1-2 Kills" (PP), "Kills on Maps 1+2" (UD), "Kills Map 1+2" (Betr), "Kills Maps 1 2" (Sleeper)
function normalizeMarket(m) {
  const s = (m || '').toLowerCase();
  const isHS       = s.includes('headshot') || /\bhs\b/.test(s);
  const isAssists  = s.includes('assist');
  const isFantasy  = s.includes('fantasy');
  // "First Bloods" and "Deaths" are stats of their own: read as kills, a
  // PrizePicks first-blood line (6 to 8) sat on Underdog's kills line (30)
  const isFB       = /first ?(blood|kill)/.test(s);
  const isDeaths   = s.includes('death');
  // "Kills Maps 1 2" (Sleeper) uses spaces — normalize to the + form first
  let mapCount = parseMapSpan(s.replace(/(\d)\s+(\d)/g, '$1+$2')).label;
  let stat = isHS ? 'hs' : isFB ? 'fb' : isAssists ? 'ast' : isFantasy ? 'fp' : isDeaths ? 'death'
    : s.includes('kill') ? 'k' : 'x:' + s.replace(/maps?\s*[\d+\-\s]+|games?\s*[\d+\-\s]+|on\b/g, '').replace(/[^a-z]/g, '');
  return `${stat}|${mapCount}`;
}

module.exports = { parseMapSpan, normalizeName, normalizeMarket };
