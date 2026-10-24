// ─── OPPORTUNITY RANKING: HOW MUCH TO TRUST A PRICE GAP ──────────────────────
// A price above the fair is only worth a look if the fair is sound, the
// price is fresh, and the venue will take the bet. Each candidate gets a
// confidence between 0 and 1 built from named factors, and its score is
// EV × confidence. Every factor that moved the score is listed in reasons,
// so the ranking can be read and argued with.
//
// Ranking is not a record. Nothing here says a kind of bet wins: `proven`
// comes only from the tracker (the close scoreboard's proven set), and every
// other row is labelled a lead.
//
// Pure functions. The esports matchup engine ranks its model edges here too
// (fairSource 'model', with the model's own range in modelLow).

const FACTORS = {
  // where the fair came from
  fair: { pinnacle_matchbook: 1, pinnacle: 0.95, model: 0.8, consensus: 0.55, none: 0 },
  // sharp sources more than this many points apart: the fair itself is unsure
  disagreePts: 3, disagree: 0.7,
  freshness: { live: 1, recent: 0.8, stale: 0, unknown: 0.5 },
  secondHand: 0,     // a copy is never a play on its own
  oneWay: 0.6,       // a one-way alternate rung: FanDuel's alt lines failed on box scores (10-18)
  prop: 0.9,         // a prop priced off one sharp line
  // an EV this big is usually two different markets matched as one
  suspectEv: 0.12, suspect: 0.4,
  thinLiquidity: 0.5,
};

// c: { ev, fairSource ('pinnacle' | 'pinnacle_matchbook' | 'consensus' | 'model'),
// spreadPts, freshness, fairFreshness, access, oneWay, marketType, liquidity,
// stake, provider, proven: Set of provider ids the tracker marks proven,
// modelLow: EV at the low end of a model's range }
function rank(c, factors = FACTORS) {
  const reasons = [];
  let conf = 1;
  const mul = (f, why) => { if (f !== 1) { conf *= f; reasons.push({ factor: Math.round(f * 100) / 100, why }); } };
  const fs = c.fairSource || 'none';
  mul(factors.fair[fs] ?? 0, {
    pinnacle_matchbook: 'Fair from Pinnacle with Matchbook beside it', pinnacle: "Fair from Pinnacle's no-vig price alone",
    model: 'Fair from our model, not a market', consensus: 'Fair is the median of 4+ books (no sharp book on this line)', none: 'No fair price on this line',
  }[fs] || fs);
  if (c.spreadPts != null && c.spreadPts > factors.disagreePts) mul(factors.disagree, `Sharp sources ${c.spreadPts} points apart`);
  const fr = c.freshness || 'unknown';
  if (fr !== 'live') mul(factors.freshness[fr] ?? 0.5, fr === 'stale' ? 'Price is stale' : fr === 'recent' ? 'Price is a few minutes old' : 'Price age unknown');
  const ffr = c.fairFreshness || 'live';
  if (ffr === 'stale') mul(0, 'Fair price is stale');
  if (c.access === 'second_hand') mul(factors.secondHand, 'Second-hand copy (Action Network): confirm in the app first');
  if (c.oneWay) mul(factors.oneWay, 'One-way alternate rung');
  if (c.marketType === 'player_prop') mul(factors.prop, 'Player prop');
  if (c.ev != null && c.ev >= factors.suspectEv) mul(factors.suspect, 'EV this large usually means mismatched markets: check both sides');
  if (c.liquidity != null && c.stake != null && c.liquidity < c.stake) mul(factors.thinLiquidity, `Only $${Math.round(c.liquidity)} at this price`);
  if (c.modelLow != null && c.modelLow <= 0) mul(0.5, "Model's low end does not clear the price");
  const confidence = Math.max(0, Math.min(1, conf));
  const proven = !!(c.proven && c.provider && c.proven.has(c.provider));
  return { score: c.ev == null ? null : Math.round(c.ev * confidence * 1e5) / 1e5, confidence: Math.round(confidence * 100) / 100,
    reasons, label: proven ? 'proven' : 'lead', actionable: confidence > 0 && c.ev != null && c.ev > 0 };
}

// rank and sort candidates (each has ev and the fields above) best first
function rankAll(cands, opts = {}) {
  return cands.map(c => ({ ...c, rank: rank({ ...c, proven: opts.proven, stake: opts.stake }, opts.factors) }))
    .filter(c => c.rank.actionable && c.rank.score > 0)
    .sort((a, b) => b.rank.score - a.rank.score);
}

module.exports = { FACTORS, rank, rankAll };
