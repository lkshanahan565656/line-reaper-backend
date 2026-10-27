// ─── PUBLIC CLAIMS: WHAT THE SALES PAGE MAY SAY ──────────────────────────────
// The sales page (/), the Learn pages and the app's welcome screen read
// GET /api/claims, so a public page claims only what the close scoreboard
// (closeboard.js) marks proven, with the numbers read live, never typed in.
//
// A claim is a scoreboard row that is:
//   - marked proven there (50 graded games, CLV t of 2 against Pinnacle's own
//     close, results not running 1.5 sd short of it, never pooled), and
//   - a kind that closes on Pinnacle's own price and may alert (main lines,
//     pick'em sharp price): the same kinds closeboard.alertBooks allows, and
//   - at a venue we read ourselves (never an Action Network copy).
// /api/results scores more loosely (it once marked "big money · BetRivers"
// proven while its raw re-check failed), so it is never the source here.
//
// Each claim says whether a Texas resident can bet it (venues.js), whether its
// results show a profit yet (units at 1u a game, t of 2 on the units), and
// whether it alerts. Everything else the app shows is labelled a model or
// research (LABELS), whatever its numbers say.
//
// Pure: publicClaims({ board, txBoard, alertBooks, now }) → JSON for the page.

const venues = require('./venues');

const CLAIM_KINDS = new Set(['ev', 'props-ev']);
const PICKEM = new Set(['prizepicks', 'underdog', 'sleeper', 'pick6', 'betr', 'chalkboard', 'parlayplay', 'dabble']);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// The tools the app shows that are not a proven edge, and the tag each wears
// in the app. They never become a claim from this list: a tool earns a line in
// `proven` only through the scoreboard.
const LABELS = [
  { tool: 'Exchange Shopper: best prices above fair', where: 'ODDS SCREEN', tag: 'research', why: 'A price above Pinnacle\'s fair, with what the exchange book fills. Exchange flags have not beaten the close yet.' },
  { tool: 'NBA, CFB and CBB props models', where: 'PROPS', tag: 'model, not an edge', why: 'Our own projections. None has cleared our bar against the apps\' lines in held-out tests.' },
  { tool: 'NFL model', where: 'ODDS SCREEN > NFL MODEL', tag: 'model, not an edge', why: 'Kalshi\'s price an hour before kickoff beat it in the held-out test.' },
  { tool: 'Esports matchups (LoL, CS2, Valorant, Dota 2) and soccer', where: 'ESPORTS > MATCHUPS', tag: 'model, not an edge', why: 'The exchanges\' own prices beat our ratings in walk-forward tests.' },
  { tool: 'Esports map kill Unders', where: 'ESPORTS > MAP UNDERS', tag: 'research', why: 'Unders where Pinnacle\'s map number sits under the apps\' lines summed, priced on our kill model. Under 50 graded; nothing alerts.' },
  { tool: 'Kalshi maker bids', where: 'ODDS SCREEN > MAKER', tag: 'research', why: 'A resting bid under the fair. Nothing places an order.' },
  { tool: 'F1, golf and season futures outrights', where: 'ODDS SCREEN > OUTRIGHTS', tag: 'research', why: 'Pinnacle takes small limits there, so its fair is weaker.' },
  { tool: 'Injury news', where: 'PROPS > INJURY NEWS', tag: 'research', why: 'Legs left up after news. Not ahead of the close so far.' },
  { tool: 'Sharp Tail and big money', where: 'SHARP TAIL, BIG MONEY', tag: 'research', why: 'Following big accounts has not beaten the close in our tests.' },
  { tool: 'Pick\'em leg flags (PrizePicks, Underdog, Sleeper, DK Pick6)', where: 'PROPS', tag: 'not proven', why: 'Flagged legs have broken about even against Pinnacle\'s close.', pickem: true },
];

// units at 1u a graded game, and whether they clear chance (t of 2). The
// scoreboard gives units, the close's expected units and z = (units - exp) / sd.
function profitOf(r) {
  const u = r.resultsUnits, e = r.resultsExpUnits, z = r.resultsZ;
  if (u == null) return { units: null, shown: false };
  const sd = z ? (u - e) / z : null;
  const t = sd > 0 ? u / sd : null;
  return { units: r2(u), shown: u > 0 && t != null && t >= 2 };
}

function claimRow(r, { alerting } = {}) {
  const p = profitOf(r);
  return {
    kind: r.kind, kindLabel: r.kindLabel, book: r.book, bookName: r.bookName,
    graded: r.graded, beatPct: r.beatPct, clv: r.avgClv, clv2min: r.avgExecClv, clv2minN: r.execN,
    wins: r.wins, losses: r.losses, units: p.units, profitShown: p.shown,
    texas: venues.legalIn('TX')(r.book), pickem: PICKEM.has(r.book), alerts: !!alerting,
  };
}

const isClaim = r => r && r.mark === 'proven' && CLAIM_KINDS.has(r.kind) && !r.relayed;

function publicClaims({ board, txBoard, alertBooks = new Set(), now = Date.now() } = {}) {
  const rows = board?.rows || [];
  const proven = rows.filter(isClaim).map(r => claimRow(r, { alerting: alertBooks.has(r.book) })).sort((a, b) => b.graded - a.graded);
  const txProven = (txBoard?.rows || []).filter(isClaim).map(r => claimRow(r, { alerting: alertBooks.has(r.book) })).filter(r => r.texas);
  const building = rows.filter(r => r.mark === 'promising' || r.mark === 'early').length;
  const tx = venues.stateInfo('TX');
  const list = pick => tx.venues.filter(v => PICKEM.has(v.key) === pick).map(v => ({ key: v.key, name: v.name, read: v.read, why: v.why }));
  const o = board?.overall || {};
  return {
    at: new Date(now).toISOString(),
    rule: { graded: board?.target || 50, clvT: 2, close: 'Pinnacle\'s no-vig close', kinds: [...CLAIM_KINDS] },
    proven,
    building,
    overall: { graded: o.graded ?? 0, beatPct: o.beatPct ?? null, clv: o.avgClv ?? null },
    texas: { name: tx.name, note: tx.note, asOf: tx.asOf, proven: txProven, pickem: list(true), exchanges: list(false) },
    labels: LABELS.filter(l => !(l.pickem && proven.some(p => p.pickem))).map(({ pickem, ...l }) => l),
  };
}

// ─── THE RESULTS PAGE: EVERY KIND ON THE SAME STRICT RULE ────────────────────
// The record a visitor can check line by line. One row per kind and venue on
// the close scoreboard, with the label the sales page would give it: 'proven'
// only when it is a claim (isClaim, the same test as publicClaims), so the two
// pages can never disagree. Everything else says why it is not proven.
// Units show as a profit only on a proven row whose units clear chance.
function labelOf(r) {
  if (isClaim(r)) return { label: 'proven', why: null };
  // map kill Unders: research with its own bar (mapunders.js); its close is our model's, never a sharp's
  if (r.kind === 'props-es-map-under') return { label: r.mark === 'not graded yet' && !(r.wins + r.losses) ? 'not graded yet' : 'research', why: `Research, not an edge: ${(r.wins || 0) + (r.losses || 0)} of 50 graded. Nothing sharp prices a player's map kills, so it is judged on results by match (ESPORTS > MAP UNDERS), never proven here.` };
  if (r.mark === 'no sharp close') return { label: 'no sharp close', why: 'Closes on our own curve or soft books, so the CLV is the flag\'s own edge again. Shown, never judged.' };
  if (r.relayed) return { label: r.mark === 'not graded yet' ? 'not graded yet' : 'copied book', why: 'Read through Action Network\'s copy, never at the book itself, so it cannot be proven.' };
  if (!CLAIM_KINDS.has(r.kind)) {
    const why = r.note || (r.kind === 'bigmoney' ? 'Big money is research: following big accounts has not held up in our raw re-checks.'
      : r.kind.startsWith('props-') ? 'Pick\'em legs of this kind are research: only pick\'em sharp-price legs on Pinnacle\'s close can be proven.'
      : 'Only main lines and pick\'em sharp-price legs closing on Pinnacle can be proven.');
    return { label: r.mark === 'not graded yet' ? 'not graded yet' : 'research', why };
  }
  if (r.mark === 'not graded yet') return { label: 'not graded yet', why: 'Nothing has closed yet.' };
  if (r.mark === 'avoid') return { label: 'losing to the close', why: r.note || null };
  return { label: r.mark === 'promising' ? 'building' : r.mark === 'early' ? 'too early' : r.mark, why: r.note || (r.graded < 50 ? `${r.graded} of 50 graded.` : 'The CLV t is under 2.') };
}
function publicRecord({ board, now = Date.now() } = {}) {
  const rows = (board?.rows || []).map(r => {
    const l = labelOf(r);
    const p = profitOf(r);
    const units = r.resultsUnits ?? r.units ?? null;
    return {
      kind: r.kind, kindLabel: r.kindLabel, book: r.book, bookName: r.bookName, relayed: !!r.relayed,
      recorded: r.recorded, open: r.open, graded: r.graded, target: board.target || 50, staleClose: r.staleClose, unverified: r.unverified,
      beatPct: r.beatPct, clv: r.avgClv, clvT: r.clvT ?? null, clv2min: r.avgExecClv, clv2minN: r.execN,
      wins: r.wins, losses: r.losses, units: units == null ? null : r2(units), expUnits: r.resultsExpUnits ?? null,
      // a profit is said only of a proven row whose units clear chance
      profitShown: l.label === 'proven' && p.shown,
      texas: venues.legalIn('TX')(r.book), label: l.label, why: l.why,
    };
  });
  const o = board?.overall || {};
  return {
    at: new Date(now).toISOString(),
    rule: { graded: board?.target || 50, clvT: 2, close: 'Pinnacle\'s no-vig close', kinds: [...CLAIM_KINDS], shortfallSd: 1.5,
      text: 'A kind is marked proven only with 50 graded games at one venue we read ourselves, a CLV t of 2 or more against Pinnacle\'s close, and results not running 1.5 sd under what that close expected. Never pooled, never alt or stale lines, never copied books, and of the pick\'em kinds only sharp-price legs.' },
    overall: { graded: o.graded ?? 0, beatPct: o.beatPct ?? null, clv: o.avgClv ?? null, clvT: o.clvT ?? null, label: 'pooled, never proven' },
    proven: rows.filter(r => r.label === 'proven').length,
    rows,
    labels: LABELS.filter(l => !(l.pickem && rows.some(r => r.label === 'proven' && PICKEM.has(r.book)))).map(({ pickem, ...l }) => l),
  };
}

module.exports = { publicRecord, labelOf, publicClaims, profitOf, isClaim, LABELS, CLAIM_KINDS, PICKEM };
