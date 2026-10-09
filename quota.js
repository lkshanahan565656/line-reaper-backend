// ─── ODDS API CREDIT BUDGET ───────────────────────────────────────────────────
// The Odds API bills credits per call (markets × regions). Its free plan gives
// 500 a month, which a busy board would burn in an hour. Low-usage mode spreads
// whatever credits are left evenly over the rest of the month: after each
// billed call, the next one waits until that many credits have "accrued".
// Between calls everyone gets the cached odds, so the app keeps working, just
// with slower-moving numbers.
//
// On when ODDS_API_BUDGET is a number (credits per month), or automatically
// when the Odds API reports a plan of 1,000 credits or fewer. ODDS_API_BUDGET=off
// turns it off whatever the plan.
//
// Paced (a bigger plan, up to paceMax credits, e.g. the 20K and 100K plans):
// the same even spreading, without the low-usage cuts. Several budgets can
// split one plan: each gets `share` (a number or a function) of the credits
// left, and every one reads the same account-wide headers.

function msUntilReset(now, resetDay = 1) {
  const d = new Date(now);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() >= resetDay) m += 1;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // clamp day 31 in short months
  return Math.max(3600000, Date.UTC(y, m, Math.min(resetDay, days)) - now);
}

function createCreditBudget({ setting = '', resetDay = 1, reserve = 0.05, now = () => Date.now(), share = 1, paceMax = 0 } = {}) {
  const off = /^off$/i.test(setting);
  const fixed = parseInt(setting) > 0 ? parseInt(setting) : null;
  let remaining = null, used = 0, nextAt = 0, autoFree = false, small = false, blocked = 0, last = null;

  const plan = () => fixed ?? (remaining != null ? remaining + used : null);
  const active = () => !off && (fixed != null || autoFree);
  const paced = () => !off && (active() || small);
  const part = () => { const x = Number(typeof share === 'function' ? share() : share); return x > 0 ? Math.min(1, x) : 0; };
  const left = () => (remaining != null ? remaining : fixed != null ? Math.max(0, fixed - used) : Infinity);

  // read x-requests-remaining / x-requests-used from any Odds API reply
  function noteHeaders(h = {}) {
    const rem = parseFloat(h['x-requests-remaining']), u = parseFloat(h['x-requests-used']);
    if (isFinite(rem)) remaining = rem;
    if (isFinite(u)) used = u;
    const was = paced();
    if (isFinite(rem) && isFinite(u)) {
      autoFree = rem + u <= 1000;
      small = paceMax > 0 && rem + u <= paceMax;
    }
    // the call that revealed a small plan still counts toward the pacing
    if (!was && paced() && last) { const r = rate(); nextAt = last.at + (r > 0 ? last.cost / r : 0); }
  }

  // this budget's credits left after the reserve
  const spendable = () => Math.max(0, left() - (plan() || 0) * reserve) * part();
  // credits/ms we can spend and still last until the reset
  function rate() {
    return spendable() / msUntilReset(now(), resetDay);
  }

  // May we make a call costing `cost` credits now? { ok, waitMs }
  function check(cost) {
    if (!paced()) return { ok: true, waitMs: 0 };
    if (spendable() < cost) return { ok: false, waitMs: msUntilReset(now(), resetDay) };
    const t = now();
    return t >= nextAt ? { ok: true, waitMs: 0 } : { ok: false, waitMs: nextAt - t };
  }

  function spend(cost) {
    if (fixed != null && remaining == null) used += cost;
    last = { at: now(), cost };
    if (!paced()) return;
    const r = rate();
    nextAt = now() + (r > 0 ? cost / r : msUntilReset(now(), resetDay));
  }

  // check + spend in one step for callers that will make the call right away
  function take(cost) {
    const c = check(cost);
    if (c.ok) spend(cost); else blocked++;
    return c;
  }

  function state() {
    const r = paced() ? rate() : null;
    return {
      lowUsage: active(), paced: paced(), share: part(),
      reason: off ? 'off' : fixed != null ? 'ODDS_API_BUDGET' : autoFree ? 'free plan detected' : small ? `plan of ${plan()} credits: paced` : null,
      plan: plan(), remaining: remaining ?? (fixed != null ? left() : null), used,
      creditsPerDay: r != null ? Math.round(r * 86400000 * 10) / 10 : null,
      nextCallIn: paced() ? Math.max(0, Math.round((nextAt - now()) / 1000)) : 0,
      skippedCalls: blocked,
    };
  }

  return { noteHeaders, check, spend, take, state, active, paced };
}

// Credits one Odds API odds call costs: markets × regions.
const oddsCost = (markets, regions) =>
  String(markets).split(',').filter(Boolean).length * String(regions).split(',').filter(Boolean).length;

module.exports = { createCreditBudget, msUntilReset, oddsCost };
