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
  { tool: 'Kalshi maker bids', where: 'ODDS SCREEN > MAKER', tag: 'research', why: 'A resting bid under the fair. Nothing places an order.' },
  { tool: 'F1 and golf outrights', where: 'ODDS SCREEN > OUTRIGHTS', tag: 'research', why: 'Pinnacle takes small limits there, so its fair is weaker.' },
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

module.exports = { publicClaims, profitOf, isClaim, LABELS, CLAIM_KINDS, PICKEM };
