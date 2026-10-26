// ─── BETTING CALCULATORS ──────────────────────────────────────────────────────
// The math behind the TOOLS tab: the calculator suite every serious odds
// service ships (odds converter, no-vig fair odds, EV, Kelly, arbitrage, hedge,
// parlay, middles, free-bet and profit-boost conversion, closing line value,
// prop lines) plus the one OddsJam doesn't have: Kalshi and Polymarket prices
// with their taker fees folded in.
//
// Pure functions, no I/O. The same file runs in Node (tests, server) and in the
// browser (served at /calc.js, exposed as window.LRCalc), so the numbers on the
// page are the numbers the tests check.
//
// Every price is carried as DECIMAL odds (total return per $1 staked, stake
// included). Probabilities are 0..1. Functions return null rather than NaN when
// the input can't be priced, so the page can show a dash instead of garbage.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRCalc = factory();
}(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const ok = x => typeof x === 'number' && Number.isFinite(x);
  const okDec = d => ok(d) && d > 1;
  const okProb = p => ok(p) && p > 0 && p < 1;
  const sum = a => a.reduce((s, x) => s + x, 0);
  const round = (x, n = 2) => (ok(x) ? Math.round(x * 10 ** n) / 10 ** n : null);

  // ── odds formats ──
  function americanToDecimal(a) {
    if (!ok(a) || Math.abs(a) < 100) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
  }
  function decimalToAmerican(d) {
    if (!okDec(d)) return null;
    return d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
  }
  const probToDecimal = p => (okProb(p) ? 1 / p : null);
  const decimalToProb = d => (okDec(d) ? 1 / d : null);

  // Fractional odds as the nearest small fraction (denominator up to 100):
  // 2.5 → "3/2", 1.909 → "10/11".
  function decimalToFractional(d) {
    if (!okDec(d)) return null;
    const x = d - 1;
    let best = [Math.round(x), 1], err = Math.abs(x - best[0]);
    for (let den = 2; den <= 100 && err > 1e-6; den++) {
      const num = Math.round(x * den), e = Math.abs(x - num / den);
      if (num > 0 && e < err - 1e-12) { best = [num, den]; err = e; }
    }
    return `${best[0]}/${best[1]}`;
  }

  // Reads whatever a bettor types: "+150", "-110", "150" (American), "2.5" or
  // "1.91" (decimal), "3/2" (fractional), "45%" (probability), "45c" or "0.45"
  // (an exchange price in cents or dollars). Returns decimal odds or null.
  function parseOdds(input) {
    if (ok(input)) input = String(input);
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/))) {
      const n = +m[1], den = +m[2];
      return n > 0 && den > 0 ? 1 + n / den : null;
    }
    if ((m = s.match(/^(\d+(?:\.\d+)?)%$/))) return probToDecimal(+m[1] / 100);
    if ((m = s.match(/^(\d+(?:\.\d+)?)(?:c|¢)$/))) return probToDecimal(+m[1] / 100);
    if ((m = s.match(/^\$?(0?\.\d+)$/))) return probToDecimal(+m[1]);
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
    const v = +s;
    if (s[0] === '+' || s[0] === '-' || Math.abs(v) >= 100) return americanToDecimal(v);
    return v > 1 ? v : null;
  }

  // "+150", "-110", "EVEN" style
  function fmtAmerican(d) {
    const a = decimalToAmerican(d);
    if (a == null) return '—';
    const r = Math.round(a);
    if (r === 100 || r === -100) return '+100';
    return r > 0 ? `+${r}` : `${r}`;
  }

  function convert(input) {
    const d = typeof input === 'number' ? input : parseOdds(input);
    if (!okDec(d)) return null;
    return { decimal: round(d, 3), american: fmtAmerican(d), fractional: decimalToFractional(d),
      prob: 1 / d, cents: round(100 / d, 1) };
  }

  // ── vig ──
  // Overround is how far the implied probabilities add up past 100%. Hold is
  // the share of a balanced handle the book keeps: 1 − 1/Σ(1/d).
  function hold(decimals) {
    if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDec)) return null;
    const book = sum(decimals.map(d => 1 / d));
    return { book, overround: book - 1, hold: 1 - 1 / book };
  }

  // Fair probabilities from a market's prices, four standard ways. They agree on
  // a 50/50 market and split on a favourite vs a longshot, where the vig isn't
  // charged evenly: multiplicative takes it pro rata; additive takes the same
  // amount off each side; power and Shin load more of it on the longshot (the
  // favourite–longshot bias sharp books actually show). On a two-way market
  // Shin works out to exactly the additive split. "worst" is, per side,
  // the lowest of the four: the conservative read OddsJam calls worst case.
  function devig(decimals, method = 'multiplicative') {
    if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDec)) return null;
    const q = decimals.map(d => 1 / d), book = sum(q), n = q.length;
    if (method === 'worst') {
      const all = ['multiplicative', 'additive', 'power', 'shin'].map(m => devig(decimals, m)).filter(Boolean);
      return all.length ? q.map((_, i) => Math.min(...all.map(a => a[i]))) : null;
    }
    if (method === 'multiplicative') return q.map(x => x / book);
    if (method === 'additive') {
      const p = q.map(x => x - (book - 1) / n);
      return p.every(x => x > 0) ? p : null;
    }
    if (method === 'power') {
      // Σ q_i^k = 1. Each term falls as k grows (q < 1), so bisect on k.
      if (q.some(x => x >= 1)) return null;
      let lo = 0.01, hi = 100;
      for (let i = 0; i < 200; i++) {
        const k = (lo + hi) / 2;
        if (sum(q.map(x => x ** k)) > 1) lo = k; else hi = k;
      }
      const k = (lo + hi) / 2;
      return q.map(x => x ** k);
    }
    if (method === 'shin') {
      // Shin (1993): p_i = (√(z² + 4(1−z)·q_i²/B) − z) / (2(1−z)), z the share
      // of insider money, solved so the p_i sum to 1. A market with no
      // overround has z = 0 and the prices are already fair.
      if (book <= 1) return q.map(x => x / book);
      const ps = z => q.map(x => (Math.sqrt(z * z + 4 * (1 - z) * x * x / book) - z) / (2 * (1 - z)));
      let lo = 0, hi = 0.999;
      for (let i = 0; i < 200; i++) {
        const z = (lo + hi) / 2;
        if (sum(ps(z)) > 1) lo = z; else hi = z;
      }
      return ps((lo + hi) / 2);
    }
    return null;
  }

  // ── edge and sizing ──
  // EV per $1 staked at decimal d when the true win chance is p.
  const ev = (p, d) => (okProb(p) && okDec(d) ? p * d - 1 : null);

  // Kelly stake as a share of bankroll: (p·d − 1)/(d − 1), floored at zero
  // (never bet a negative edge), times the fraction you run (¼ is the sane
  // default; full Kelly is too swingy for an estimated p).
  function kelly(p, d, fraction = 1) {
    if (!okProb(p) || !okDec(d) || !ok(fraction) || fraction <= 0) return null;
    return Math.max(0, (p * d - 1) / (d - 1)) * fraction;
  }

  // ── arbitrage ──
  // Stakes on every outcome so each pays the same: stake_i ∝ 1/d_i. With
  // `roundTo` (say 1 or 5, so the bets don't look like a bot's) the stakes are
  // rounded and each outcome's own return is reported, since they then differ.
  function arbitrage(decimals, total = 100, roundTo = 0) {
    if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDec) || !(total > 0)) return null;
    const inv = decimals.map(d => 1 / d), book = sum(inv);
    let stakes = inv.map(x => total * x / book);
    if (roundTo > 0) stakes = stakes.map(s => Math.max(roundTo, Math.round(s / roundTo) * roundTo));
    const staked = sum(stakes);
    const returns = stakes.map((s, i) => s * decimals[i]);
    const profits = returns.map(r => r - staked);
    const worst = Math.min(...profits);
    return { isArb: book < 1, book, roi: 1 / book - 1, stakes, staked, returns, profits,
      profit: worst, worstRoi: worst / staked };
  }

  // ── hedging ──
  // An open bet of `stake` at decimal `openDec` (a parlay's full remaining
  // payout counts too), hedged at `hedgeDec`. "equal" locks the same result
  // whichever side lands: H = stake·openDec/hedgeDec. "breakeven" stakes just
  // enough that the hedge winning gets the original stake back: H = stake/(d−1).
  function hedge(stake, openDec, hedgeDec, mode = 'equal') {
    if (!(stake > 0) || !okDec(openDec) || !okDec(hedgeDec)) return null;
    const h = mode === 'breakeven' ? stake / (hedgeDec - 1) : stake * openDec / hedgeDec;
    const ifOpenWins = stake * (openDec - 1) - h;
    const ifHedgeWins = h * (hedgeDec - 1) - stake;
    return { hedgeStake: h, ifOpenWins, ifHedgeWins, guaranteed: Math.min(ifOpenWins, ifHedgeWins) };
  }

  // ── parlays ──
  // legs: [{ dec, prob? }]. Without a fair probability on every leg the EV is
  // left out: the book's own implied chances would make every parlay read 0.
  function parlay(legs, stake = 100) {
    if (!Array.isArray(legs) || !legs.length || !legs.every(l => okDec(l?.dec))) return null;
    const dec = legs.reduce((x, l) => x * l.dec, 1);
    const fair = legs.every(l => okProb(l.prob)) ? legs.reduce((x, l) => x * l.prob, 1) : null;
    return { dec, payout: stake * dec, profit: stake * (dec - 1), implied: 1 / dec,
      prob: fair, ev: fair != null ? fair * dec - 1 : null, fairDec: fair != null ? 1 / fair : null };
  }

  // ── middles ──
  // Over `lowLine` at decA and Under `highLine` at decB, staked so a miss costs
  // the same on either side (a·decA = b·decB). Hitting the window wins both.
  // Break-even is the hit rate where the window pays for the misses.
  function middle(decA, decB, total = 100, hitProb = null) {
    if (!okDec(decA) || !okDec(decB) || !(total > 0)) return null;
    const a = total * decB / (decA + decB), b = total - a;
    const miss = a * decA - total;            // same either side by construction
    const hit = a * decA + b * decB - total;
    const breakeven = hit > miss ? (miss >= 0 ? 0 : -miss / (hit - miss)) : null;
    const evDollars = okProb(hitProb) ? hitProb * hit + (1 - hitProb) * miss : null;
    return { stakeA: a, stakeB: b, miss, hit, breakeven, ev: evDollars, evPct: evDollars != null ? evDollars / total : null };
  }

  // ── promos ──
  // A free bet (stake not returned) of `amount` at freeDec, hedged with cash at
  // hedgeDec. Equal result: H = amount·(freeDec−1)/hedgeDec. Conversion is the
  // locked profit as a share of the free bet: 70%+ is a good one.
  function freeBet(amount, freeDec, hedgeDec) {
    if (!(amount > 0) || !okDec(freeDec) || !okDec(hedgeDec)) return null;
    const win = amount * (freeDec - 1);
    const h = win / hedgeDec;
    const profit = win - h;
    return { hedgeStake: h, profit, conversion: profit / amount };
  }

  // A profit boost of `boostPct` (50 = +50% on the winnings) on decimal d. With
  // the other side's price the fair chance comes from a no-vig of the original
  // two-way market, and the boost's EV and its hedge come with it.
  function profitBoost(d, boostPct, stake = 100, otherDec = null, method = 'multiplicative') {
    if (!okDec(d) || !ok(boostPct) || boostPct < 0 || !(stake > 0)) return null;
    const boosted = 1 + (d - 1) * (1 + boostPct / 100);
    const out = { boosted, profitIfWin: stake * (boosted - 1), prob: null, ev: null, hedge: null };
    if (okDec(otherDec)) {
      const fair = devig([d, otherDec], method);
      if (fair) { out.prob = fair[0]; out.ev = ev(fair[0], boosted); }
      out.hedge = hedge(stake, boosted, otherDec);
    }
    return out;
  }

  // ── closing line value ──
  // CLV of a bet at betDec against the closing market. With the other side's
  // closing price the close is de-vigged first (the honest version); without it
  // the raw closing price is used, which flatters the close by its vig.
  function clv(betDec, closeDec, closeOtherDec = null, method = 'multiplicative') {
    if (!okDec(betDec) || !okDec(closeDec)) return null;
    let fairProb = 1 / closeDec, devigged = false;
    if (okDec(closeOtherDec)) {
      const f = devig([closeDec, closeOtherDec], method);
      if (f) { fairProb = f[0]; devigged = true; }
    }
    return { clv: betDec * fairProb - 1, fairProb, fairDec: 1 / fairProb, devigged,
      probGain: fairProb - 1 / betDec };
  }

  // ── exchanges ──
  // Kalshi's taker fee per order: ceil to the cent of rate·n·p·(1−p), 7% by
  // default (the same formula exchanges.js charges arbs with). Polymarket's
  // per-market schedule: n·rate·(p(1−p))^exponent, no rounding; sports markets
  // run 0.05 with exponent 1.
  // (fees.js holds the schedule; this is its formula, so the TOOLS page works
  // even before /fees.js loads, and a test keeps the two equal)
  function kalshiFee(price, contracts = 1, rate = 0.07) {
    const p = Number(price);
    if (!(p > 0 && p < 1) || !(contracts > 0)) return 0;
    return Math.max(0, Math.ceil(rate * contracts * p * (1 - p) * 100 - 1e-9) / 100);
  }
  function polymarketFee(price, shares = 1, rate = 0.05, exponent = 1) {
    const p = Number(price);
    if (!(p > 0 && p < 1) || !(shares > 0) || !(rate >= 0)) return 0;
    return shares * rate * (p * (1 - p)) ** (exponent || 1);
  }

  // All-in cost of buying `contracts` at `price` dollars on a venue, and what
  // that is as sportsbook odds. Each contract pays $1, so the all-in price per
  // contract IS the break-even probability. `myProb` adds EV and Kelly.
  function exchangeBuy(price, contracts = 100, venue = 'kalshi', opts = {}) {
    const p = Number(price), n = Number(contracts);
    if (!(p > 0 && p < 1) || !(n > 0)) return null;
    // the schedules are fees.js's (a test keeps these equal): Kalshi and
    // Gemini 0.07 taker rounded up per order, Kalshi's resting (maker) bids
    // 0.0175, Polymarket US the market's own coefficient (0.0695 on sports)
    const fee = venue === 'kalshi' || venue === 'gemini' ? kalshiFee(p, n, opts.rate ?? 0.07)
      : venue === 'kalshi_maker' ? kalshiFee(p, n, opts.rate ?? 0.0175)
      : venue === 'polymarketus' ? polymarketFee(p, n, opts.rate ?? 0.0695, 1)
      : venue === 'polymarket' ? polymarketFee(p, n, opts.rate ?? 0.05, opts.exponent ?? 1) : 0;
    const cost = p * n + fee, perContract = cost / n;
    if (perContract >= 1) return { cost, fee, perContract, dec: null, american: '—', breakeven: perContract, profitIfWin: n - cost };
    const dec = 1 / perContract;
    const out = { cost, fee, perContract, dec, american: fmtAmerican(dec), breakeven: perContract, profitIfWin: n - cost,
      feeDrag: fee / cost };
    if (okProb(opts.myProb)) { out.ev = ev(opts.myProb, dec); out.kelly = kelly(opts.myProb, dec, opts.kellyFraction ?? 0.25); }
    return out;
  }

  // ── prop lines ──
  // Chance a count stat (kills, strikeouts, shots) goes over/under a line given
  // a projection. Poisson when only the mean is known; a discretised normal
  // when a standard deviation is given (bigger stats: points, yards). A
  // whole-number line can push, reported separately.
  function poissonPmf(k, m) {
    if (k < 0) return 0;
    let lp = -m + k * Math.log(m);
    for (let i = 2; i <= k; i++) lp -= Math.log(i);
    return Math.exp(lp);
  }
  function normalCdf(x) {
    // Abramowitz–Stegun 7.1.26 on erf, |error| < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function propLine(mean, line, sd = null) {
    if (!(mean > 0) || !ok(line) || line < 0) return null;
    const whole = Math.abs(line - Math.round(line)) < 1e-9;
    let under, push = 0;
    if (ok(sd) && sd > 0) {
      const cdf = x => normalCdf((x - mean) / sd);
      if (whole) { push = cdf(line + 0.5) - cdf(line - 0.5); under = cdf(line - 0.5); }
      else under = cdf(Math.floor(line) + 0.5);
    } else {
      const top = whole ? line - 1 : Math.floor(line);
      under = 0;
      for (let k = 0; k <= top; k++) under += poissonPmf(k, mean);
      if (whole) push = poissonPmf(line, mean);
    }
    const over = Math.max(0, 1 - under - push);
    // fair odds ignore the push (it's a refund): P(win | no push)
    const live = over + under;
    return { over, under, push, fairOver: live > 0 && over > 0 ? live / over : null, fairUnder: live > 0 && under > 0 ? live / under : null,
      dist: ok(sd) && sd > 0 ? 'normal' : 'poisson' };
  }

  // Probability a total or margin lands strictly inside (low, high), for a
  // middle, on a discretised normal: football totals run sd ≈ 13.5, NBA ≈ 18.
  function windowProb(mean, sd, low, high) {
    if (!ok(mean) || !(sd > 0) || !ok(low) || !ok(high) || high <= low) return null;
    const lo = Math.floor(low) + 1, hi = Math.ceil(high) - 1;   // whole scores strictly inside
    if (hi < lo) return 0;
    return normalCdf((hi + 0.5 - mean) / sd) - normalCdf((lo - 0.5 - mean) / sd);
  }

  // ── exchange combos ──
  // A Kalshi combo (parlay) is quoted on request by market makers. Priced off
  // each leg's fair, legs taken as independent: fair = the product. maxAsk is
  // the most a quote can ask, Kalshi's taker fee in, and still be worth minEv;
  // breakEven is the same at 0. Legs from one game move together, so their
  // product is only a rough guide (sameGame says so).
  function comboFair(legs, { minEv = 0.02, feeRate = 0.07 } = {}) {
    if (!Array.isArray(legs) || legs.length < 2 || !legs.every(l => okProb(l && l.fair))) return null;
    const fair = legs.reduce((p, l) => p * l.fair, 1);
    if (!okProb(fair)) return null;
    // the ask p whose all-in cost p + r·p·(1 − p) is `cost`
    const askFor = cost => {
      const r = feeRate, b = 1 + r, disc = b * b - 4 * r * cost;
      const p = r > 0 ? (b - Math.sqrt(Math.max(0, disc))) / (2 * r) : cost;
      return Math.floor(p * 100 + 1e-9) / 100;
    };
    const games = legs.map(l => l.game).filter(Boolean);
    return {
      fair: round(fair, 4), decimal: round(1 / fair, 3), american: Math.round(decimalToAmerican(1 / fair)),
      maxAsk: askFor(fair / (1 + minEv)), breakEven: askFor(fair),
      sameGame: new Set(games).size < games.length,
    };
  }


  // ── pick'em slips ──
  // Each app's payout table { picks: { hits: multiple } }, from the apps'
  // help pages (kept equal to slip.js PAYOUTS and slips.js POWER/FLEX by a
  // test). The app can show a lower number for correlated picks (same team or
  // game), and Pick6 multiplies by each pick's own multiplier: the payout the
  // app shows on the slip is the one that counts (pickemSlip's `shown`).
  const PICKEM = {
    prizepicks_power: { label: 'PrizePicks Power', app: 'prizepicks', tables: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 37.5 } } },
    prizepicks_flex: { label: 'PrizePicks Flex', app: 'prizepicks', tables: { 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } } },
    underdog_standard: { label: 'Underdog Standard', app: 'underdog', tables: { 2: { 2: 3.5 }, 3: { 3: 6.5 }, 4: { 4: 12 }, 5: { 5: 20 }, 6: { 6: 35 } } },
    underdog_flex: { label: 'Underdog Flex', app: 'underdog', tables: { 3: { 3: 3.25, 2: 1.09 }, 4: { 4: 6, 3: 1.4 }, 5: { 5: 10, 4: 2.5 }, 6: { 6: 25, 5: 2.6, 4: 0.25 } } },
    pick6: { label: 'DK Pick6', app: 'pick6', tables: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 12, 4: 1 }, 6: { 6: 25, 5: 1.5 }, 7: { 7: 40, 6: 2 }, 8: { 8: 80, 7: 3, 6: 1 } } },
    betr: { label: 'Betr Picks', app: 'betr', tables: { 2: { 2: 3 }, 3: { 3: 6 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 37.5 } } },
  };
  // P(k of n hit) with every leg at chance p
  function binom(n, k, p) {
    let c = 1;
    for (let i = 1; i <= k; i++) c = c * (n - k + i) / i;
    return c * p ** k * (1 - p) ** (n - k);
  }
  // a slip's EV per $1 when each leg hits with chance p (legs independent)
  function pickemEv(table, n, p) {
    if (!table || !(n >= 1) || !okProb(p)) return null;
    let back = 0;
    for (let k = 0; k <= n; k++) back += binom(n, k, p) * (table[k] || 0);
    return back - 1;
  }
  // the per-leg chance where the slip breaks even
  function pickemBreakeven(table, n) {
    if (!table || !(n >= 1) || !(pickemEv(table, n, 0.999) > 0)) return null;
    let lo = 0.001, hi = 0.999;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (pickemEv(table, n, m) > 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  // One slip type at n picks: the table (the top multiple replaced by `shown`
  // when the app shows another), the break-even per leg as a chance and as
  // American odds, and at `p` (the user's chance per leg) the EV and the
  // chance of each payout.
  function pickemSlip(type, n, { p = null, shown = null, tables = null } = {}) {
    const def = PICKEM[type];
    const base = (tables && tables[n]) || def?.tables[n];
    if (!base) return null;
    const table = { ...base };
    if (shown > 1) table[n] = shown;
    const be = pickemBreakeven(table, n);
    const out = {
      type, label: def?.label || type, n, table, top: table[n], breakeven: be == null ? null : round(be, 4),
      breakevenAmerican: be == null ? null : Math.round(decimalToAmerican(1 / be)),
      outcomes: Object.keys(table).map(Number).sort((a, b) => b - a).map(k => ({ hits: k, pays: table[k], chance: okProb(p) ? round(binom(n, k, p), 4) : null })),
    };
    if (okProb(p)) { out.ev = round(pickemEv(table, n, p), 4); out.chanceAny = round(out.outcomes.reduce((a, o) => a + (o.chance || 0), 0), 4); }
    return out;
  }
  // every slip type an app offers, every size
  function pickemGrid({ p = null, tables = {} } = {}) {
    const rows = [];
    for (const type of Object.keys(PICKEM)) for (const n of Object.keys(tables[type] || PICKEM[type].tables).map(Number)) {
      const s = pickemSlip(type, n, { p, tables: tables[type] });
      if (s) rows.push(s);
    }
    return rows;
  }

  return { comboFair, americanToDecimal, decimalToAmerican, decimalToFractional, decimalToProb, probToDecimal,
    parseOdds, fmtAmerican, convert, hold, devig, ev, kelly, arbitrage, hedge, parlay, middle,
    freeBet, profitBoost, clv, kalshiFee, polymarketFee, exchangeBuy, poissonPmf, normalCdf, propLine,
    windowProb, round, PICKEM, pickemEv, pickemBreakeven, pickemSlip, pickemGrid };
}));
