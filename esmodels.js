// Esports model report card (v3.145.0).
//
// Every esports record graded against what it needed to win, in one place:
// each single-leg model's hit rate next to the break-even its payouts set,
// and the same-match stacks' sweeps next to the payout the app would have to
// show for them to pay. Rows from days a team played more than one match and
// that were priced before the match tag existed (esmatch.multiMatchRows, no
// matchTag) are left out: some were graded on the wrong map.
//
// Verdicts, at the project's 50-graded bar:
//   early     fewer than 50 graded
//   failed    50+ graded and the hit rate is 2+ standard errors under break-even
//   losing    50+ graded, under break-even but not by 2 standard errors
//   ahead     50+ graded, over break-even but under 2 standard errors
//   beats     50+ graded and 2+ standard errors over break-even: still needs
//             the independent re-check before anyone bets it
// A failed model's legs stop showing as plays on the Lines table.
const { multiMatchRows } = require('./esmatch');

const MIN_N = 50;
const { r1, r2 } = require('./mathutil');

// which record a row belongs to; the h2h record holds both model-only legs
// and legs Pinnacle agreed with (fair 'h2h-sharp'), judged apart
const MODELS = [
  { key: 'h2h', store: 'h2h', label: 'Matchup kill model (H2H) alone', what: "our head-to-head model: the player's share of his team's kills x what his team makes against this opponent", test: r => r.fair !== 'h2h-sharp' },
  { key: 'h2hSharp', store: 'h2h', label: 'Matchup model + Pinnacle agree', what: 'H2H legs where the Pinnacle-based fair took the same side within 5 points', test: r => r.fair === 'h2h-sharp' },
  { key: 'rounds', store: 'rounds', label: 'Round model (CS2, Valorant)', what: "Pinnacle's rounds on each map x the player's kills a round" },
  { key: 'share', store: 'share', label: 'Kill share (LoL, Dota)', what: "Pinnacle's team kills x the player's share of them" },
  { key: 'esStale', store: 'esStale', label: 'Stale app lines', what: 'one app moved, another still had the old line' },
  { key: 'board', store: 'esports', label: "Board picks (books' consensus)", what: "the board's +EV legs on the apps' consensus with calibration" },
];

// Pure: one record's graded rows → the card line
function gradeRows(rows) {
  const g = rows.filter(r => r.status === 'graded' && (r.outcome === 'win' || r.outcome === 'loss') && Number(r.signalDecimal) > 1);
  const n = g.length;
  const wins = g.filter(r => r.outcome === 'win').length;
  const be = g.map(r => 1 / r.signalDecimal);
  const beSum = be.reduce((a, b) => a + b, 0);
  const sd = Math.sqrt(be.reduce((a, p) => a + p * (1 - p), 0));
  const units = g.reduce((a, r) => a + (Number(r.profit) || 0), 0);
  const priced = n ? g.reduce((a, r) => a + (Number(r.signalProb) || 0), 0) / n : null;
  const z = n && sd > 0 ? (wins - beSum) / sd : null;
  const verdict = n < MIN_N ? 'early' : z <= -2 ? 'failed' : z >= 2 ? 'beats' : wins < beSum ? 'losing' : 'ahead';
  return {
    graded: n, wins, losses: n - wins,
    hitPct: n ? r1(wins / n * 100) : null,
    breakEvenPct: n ? r1(beSum / n * 100) : null,
    pricedPct: priced != null ? r1(priced) : null,
    units: r2(units), roi: n ? r2(units / n * 100) : null,
    z: z != null ? r2(z) : null, verdict,
  };
}

// one subject per player, stat, maps and match: several apps' rows on one
// result are one piece of evidence, so the card also says how many there were
const subjectOf = r => [r.sport, String(r.player || '').toLowerCase(), r.stat, (r.maps || []).join('-'), r.matchTag || r.gameId].join('|');

// Pure: records { store: rows } → model cards. Rows from multi-match days
// without a match tag are dropped first, across every record together.
function modelCards(records = {}) {
  const all = Object.values(records).flat();
  const exposed = multiMatchRows(all.filter(r => !r.matchTag));
  const out = [];
  for (const m of MODELS) {
    const rows = (records[m.store] || []).filter(r => !exposed.has(r) && (!m.test || m.test(r)));
    const card = gradeRows(rows);
    const graded = rows.filter(r => r.status === 'graded');
    out.push({ key: m.key, label: m.label, what: m.what, ...card,
      subjects: new Set(graded.map(subjectOf)).size,
      left: Math.max(0, MIN_N - card.graded),
      dropped: (records[m.store] || []).filter(r => exposed.has(r) && (!m.test || m.test(r)) && r.status === 'graded').length });
  }
  return out;
}

// Pure: graded same-match stacks → per app and size, the sweeps against the
// stakes and the payout an all-legs-win entry needs for the record to have
// broken even. stake 1u each; Power-style tables pay only a sweep, so the
// record breaks even at payout = stacks / sweeps (Sleeper's payout varies
// a stack, so it is said as a share of the payout the app showed).
// matches: one match per app counts once (an app re-logs a match per side).
function stackCards(rows = []) {
  const g = rows.filter(r => r.kind === 'stack' && r.status === 'graded' && r.size >= 2);
  const groups = new Map();
  for (const r of g) {
    const k = `${r.book}|${r.size}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [book, size] = k.split('|');
    const swept = list.filter(r => r.hits === r.size);
    const flex = list.some(r => /flex/.test(r.table || ''));
    const std = list.map(r => r.paysAll).filter(Number.isFinite);
    const standard = std.length ? r2(std.reduce((a, b) => a + b, 0) / std.length) : null;
    const paidOnSweeps = swept.reduce((a, r) => a + (r.paysAll || 0), 0);
    // the share of the standard payout at which the record breaks even
    const share = swept.length && !flex ? list.length / paidOnSweeps : null;
    const matches = new Set(list.map(r => `${String(r.start || '').slice(0, 10)}|${(r.legs || []).map(l => String(l.team || '').toLowerCase()).sort()[0]}`)).size;
    out.push({
      book, size: +size, flex, stacks: list.length, matches,
      swept: swept.length, sweptMatches: new Set(swept.map(r => `${String(r.start || '').slice(0, 10)}|${r.legs?.[0]?.gameId}`)).size,
      expectedSwept: r2(list.reduce((a, r) => a + (r.probAll || 0), 0)),
      independentSwept: r2(list.reduce((a, r) => a + (r.legs || []).reduce((m, l) => m * (l.prob || 0) / 100, 1), 0)),
      units: r2(list.reduce((a, r) => a + (r.profit || 0), 0)),
      standardPays: standard,
      // payout needed: on a fixed table, stacks / sweeps; else as a share
      needsPays: share != null && standard != null ? r1(standard * share) : null,
      needsShare: share != null ? r2(share) : null,
      // one sweep fewer: how fragile that number is
      needsPaysOneFewer: swept.length > 1 && standard != null && !flex ? r1(standard * list.length / (paidOnSweeps - paidOnSweeps / swept.length)) : null,
      verdict: swept.length < 10 ? 'early' : 'judge',
    });
  }
  return out.sort((a, b) => b.stacks - a.stacks);
}

// Pure: the card for one model key, or null
const verdictOf = (cards, key) => (cards || []).find(c => c.key === key)?.verdict || null;

module.exports = { modelCards, stackCards, gradeRows, verdictOf, MODELS, MIN_N };
