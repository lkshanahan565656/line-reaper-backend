// ─── FEES: EVERY VENUE'S CUT, ONE PLACE ───────────────────────────────────────
// What each venue we price takes, so a price can be shown and graded after the
// fee: the AFTER FEES view (CUSTOMIZE > After fees), the Exchange Shopper's
// "above fair", the exchange records on RESULTS (CLV at the all-in cost) and the
// TOOLS calculator all read these numbers, never their own copy.
//
// Pure, no I/O. Runs in Node (require('./fees')) and in the browser (served at
// /fees.js, window.LRFees), so the screen and the tests use the same file.
//
// Each schedule says where it came from and how sure we are:
//   verified    read from the venue's own published page on `checked`
//   recorded    copied earlier from the venue (its help center or its own app
//               data) on the date given; not re-read on `checked`
//   unverified  no page from the venue itself could be read: shown as such on
//               screen, never presented as the venue's schedule
//
// Exchange fees are per contract at price p (dollars, 0..1; a contract pays $1):
//   fee(C contracts) = rate × C × p × (1 − p), rounded up per order
// A price on screen is a per-contract price, priced on an order of LOT (100)
// contracts: Kalshi's and Gemini's round-up to the cent on 100 contracts is the
// round-up to the centicent on one, which is Kalshi's own rule since 2026-07-07
// ("fee + positionCost rounded to a centicent"). One contract alone can pay a
// whole cent (2c at 50c, not 1.75c); the size tiers walk the real book
// (depthfill.js) with each fill's own round-up.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRFees = factory();
}(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const CHECKED = '2026-10-26';
  const LOT = 100;
  const isNum = x => typeof x === 'number' && Number.isFinite(x);
  const inUnit = p => isNum(p) && p > 0 && p < 1;
  const r4 = x => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
  // the epsilon keeps float noise (0.0175000001) from adding a cent
  const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;

  // ── the schedules ──
  const SCHEDULES = {
    kalshi: {
      name: 'Kalshi', kind: 'exchange', status: 'verified', checked: CHECKED, effective: '2026-07-07',
      source: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
      taker: { rate: 0.07, rounding: 'cent' },
      // maker multiplier 1 on most sports series (KXNFLGAME, KXNBA...), 0 by
      // default. The series' own fee_type says which: 'quadratic' (no maker
      // fee) on NHL spreads and totals as read 10-25 (kmaker.js reads it live)
      maker: { rate: 0.0175, rounding: 'cent', freeOn: 'NHL spreads and totals (series fee_type "quadratic")' },
      summary: 'Taker 0.07 × C × p × (1 − p), maker 0.0175 × C × p × (1 − p) on most sports series, rounded up. NHL spreads and totals: no maker fee.',
    },
    gemini: {
      name: 'Gemini', kind: 'exchange', status: 'verified', checked: CHECKED, effective: '2026-03-18',
      source: 'https://www.gemini.com/fees/predictions',
      taker: { rate: 0.07, rounding: 'cent' },
      maker: { rate: 0.0175, rounding: 'cent' },
      summary: 'Taker 0.07 × C × p × (1 − p), maker 0.0175 × C × p × (1 − p), rounded up to the next cent (contracts listed from 2026-03-18).',
    },
    polymarketus: {
      name: 'Polymarket US', kind: 'exchange', status: 'unverified', checked: CHECKED,
      // each market carries its own feeCoefficient (pmus.js reads it); 0.0695
      // is the value those markets gave on every sports read since 10-14. No fee
      // page published by Polymarket US itself could be read on `checked`, so
      // the schedule is the API's number, not a cited page
      source: 'https://gateway.polymarket.us (each market\'s feeCoefficient field)',
      taker: { rate: 0.0695, rounding: 'none', perMarket: 'feeCoefficient' },
      maker: null,
      summary: "Taker = the market's own feeCoefficient (0.0695 on sports) × C × p × (1 − p), not rounded. Read from each market; Polymarket US's own fee page could not be read, so unverified.",
    },
    matchbook: {
      name: 'Matchbook', kind: 'commission', status: 'unverified', checked: CHECKED, source: null,
      commission: { rate: null },
      summary: "Commission on net winnings; we could not read Matchbook's rate, so its price is shown raw. Reference only, not a US venue.",
    },
    pinnacle: { name: 'Pinnacle', kind: 'book', status: 'verified', checked: CHECKED, source: null, summary: 'Sportsbook: the margin is in the price, no separate fee. Reference only.' },
    sportsbook: { name: 'Sportsbooks', kind: 'book', status: 'verified', checked: CHECKED, source: null, summary: 'FanDuel, BetRivers and the Action Network copies: the margin is in the price, no separate fee.' },
    // pick'em apps: no fee, the cut is in the multiplier, so a leg's after-fee
    // price is the per-leg chance where the slip breaks even. The tables are
    // calc.js PICKEM (kept equal to slip.js and slips.js by a test)
    prizepicks: {
      name: 'PrizePicks', kind: 'pickem', status: 'recorded', checked: '2026-09-09',
      source: 'PrizePicks help center, "Potential outcomes" (updated 2026-09-09)',
      types: ['prizepicks_power', 'prizepicks_flex'], defaultType: 'prizepicks_power', defaultN: 3,
      unpublished: 'Goblin and demon picks pay less and more than the table; PrizePicks does not publish those payouts, so they are not priced here.',
      summary: 'Power 2 to 6 picks (3x to 37.5x), Flex 3 to 6. Lowered for same-team lineups. Goblin and demon payouts are not published.',
    },
    underdog: {
      name: 'Underdog', kind: 'pickem', status: 'recorded', checked: '2026-10-15',
      source: 'Underdog help center, "Pick\'em Standard & Flex Entry Payouts"',
      types: ['underdog_standard', 'underdog_flex'], defaultType: 'underdog_standard', defaultN: 3,
      summary: 'Standard 2 to 6 picks (3.5x to 35x), Flex 3 to 6. Underdog moves the multiplier for correlated or favoured picks and shows the new number in the app.',
    },
    pick6: {
      name: 'DK Pick6', kind: 'pickem', status: 'recorded', checked: '2026-10-15',
      source: 'pick6.draftkings.com entry data (entryDetails.payoutPackages), refreshed by the server on each read',
      types: ['pick6'], defaultType: 'pick6', defaultN: 3,
      summary: 'Pays 3x to 80x on 2 to 8 picks (its fixed table); a pick marked 0.9x pays less, a contest bonus can pay more once the pool settles.',
    },
    sleeper: {
      name: 'Sleeper', kind: 'pickem', status: 'unverified', checked: CHECKED,
      source: 'https://support.sleeper.com/en/articles/9047931-sleeper-player-picks-rules',
      types: [], perPick: 1.78,
      unpublished: 'Sleeper pays the entry fee times the score the app shows before you submit; it publishes no table by pick count.',
      summary: "No published table: each entry shows its own payout. Break-even here uses 1.78x a pick (what Sleeper's lines showed, unverified).",
    },
    betr: {
      name: 'Betr', kind: 'pickem', status: 'unverified', checked: CHECKED, source: null,
      types: ['betr'], defaultType: 'betr', defaultN: 3,
      summary: "Taken to pay like PrizePicks Power; Betr's own table could not be read, and its lines are not priced.",
    },
  };
  // a provider id → its schedule key
  const ALIAS = { fanduel: 'sportsbook', betrivers: 'sportsbook', draftkings: 'sportsbook', betmgm: 'sportsbook', caesars: 'sportsbook',
    bet365: 'sportsbook', fanatics: 'sportsbook', hardrock: 'sportsbook', thescore: 'sportsbook', polymarket_us: 'polymarketus', pmus: 'polymarketus',
    dkpick6: 'pick6', pp: 'prizepicks', ud: 'underdog' };
  function schedule(venue) {
    const k = String(venue || '').toLowerCase();
    return SCHEDULES[k] || SCHEDULES[ALIAS[k]] || null;
  }
  const kindOf = venue => schedule(venue)?.kind || 'book';

  // ── exchanges ──
  // the rate a side pays: the market's own (Polymarket US feeCoefficient) when
  // given, else the schedule's
  function rateOf(venue, { rate = null, maker = false } = {}) {
    const s = schedule(venue);
    if (isNum(rate) && rate >= 0 && rate < 1) return rate;
    const leg = maker ? s?.maker : s?.taker;
    return leg && isNum(leg.rate) ? leg.rate : 0;
  }
  // the fee on one order of `contracts` at p, in dollars. round: true rounds up
  // to the cent (Kalshi, Gemini), false leaves it (Polymarket US); null takes
  // the venue's own rule
  function orderFee(venue, price, contracts = 1, { rate = null, maker = false, round = null } = {}) {
    const p = Number(price), n = Number(contracts);
    if (!inUnit(p) || !(n > 0)) return 0;
    const r = rateOf(venue, { rate, maker });
    const leg = maker ? schedule(venue)?.maker : schedule(venue)?.taker;
    const doRound = round == null ? leg?.rounding === 'cent' : !!round;
    const f = r * n * p * (1 - p);
    return Math.max(0, doRound ? ceilTo(f * 100, 1) / 100 : f);
  }
  // the fee a contract, priced on an order of `lot` contracts
  function contractFee(venue, price, { rate = null, maker = false, lot = LOT, round = null } = {}) {
    if (!inUnit(Number(price))) return null;
    return orderFee(venue, price, lot, { rate, maker, round }) / lot;
  }
  // what one contract costs all in: the price plus its fee. This is the
  // after-fee implied probability and the break-even win chance at that price
  function allInCost(venue, price, opts = {}) {
    const f = contractFee(venue, price, opts);
    return f == null ? null : r4(Number(price) + f);
  }
  // the listed price back from an all-in cost (inverse of p + r·p(1−p)), for a
  // screen that only kept the cost; within a centicent of the listed price
  function priceFromCost(venue, cost, opts = {}) {
    const c = Number(cost);
    if (!inUnit(c)) return null;
    const r = rateOf(venue, opts);
    if (!(r > 0)) return c;
    const b = 1 + r, disc = b * b - 4 * r * c;
    return disc < 0 ? null : r4((b - Math.sqrt(disc)) / (2 * r));
  }

  // ── after the fee, any venue ──
  // { venue, decimal } (a price as the screen shows it) → the after-fee
  // implied probability. inPrice: the price already has the fee in (Kalshi,
  // Gemini and Polymarket US prices on every screen are ask + fee), so the
  // implied chance IS the after-fee one. A commission venue with no rate we
  // could read → null (shown raw, never guessed).
  // (pick'em: decimal is the pick's multiplier as the app shows it, or null)
  function afterFee({ venue = '', decimal = null, price = null, inPrice = true, rate = null } = {}) {
    const s = schedule(venue), kind = s?.kind || 'book';
    if (kind === 'pickem') {
      const be = legBreakeven(venue, { multiplier: decimal });
      return be == null ? null : { implied: be.breakeven, breakeven: be.breakeven, fee: null, basis: be.label, status: s.status };
    }
    let cost = null, listed = null;
    if (kind === 'exchange') {
      if (inUnit(price)) { listed = Number(price); cost = allInCost(venue, listed, { rate }); }
      else if (isNum(decimal) && decimal > 1) {
        cost = 1 / decimal;
        if (!inPrice) { listed = cost; cost = allInCost(venue, listed, { rate }); } else listed = priceFromCost(venue, cost, { rate });
      }
      if (!inUnit(cost)) return null;
      return { implied: r4(cost), breakeven: r4(cost), fee: listed == null ? null : r4(cost - listed), listed: r4(listed), basis: 'all-in cost a contract', status: s.status };
    }
    if (kind === 'commission') {
      const c = s?.commission?.rate;
      if (!isNum(decimal) || !(decimal > 1)) return null;
      if (!isNum(c)) return { implied: null, breakeven: null, fee: null, basis: 'commission not known', status: s.status, raw: r4(1 / decimal) };
      const eff = 1 + (decimal - 1) * (1 - c);
      return { implied: r4(1 / eff), breakeven: r4(1 / eff), fee: r4(1 / eff - 1 / decimal), basis: `${c * 100}% commission`, status: s.status };
    }
    if (!isNum(decimal) || !(decimal > 1)) return null;
    return { implied: r4(1 / decimal), breakeven: r4(1 / decimal), fee: 0, basis: 'margin in the price', status: s?.status || 'verified' };
  }

  // the edge of a price over a fair chance, both after the fee: fair / cost − 1.
  // The Exchange Shopper's EV ("above fair") and an exchange record's CLV
  // (fair = Pinnacle's no-vig at the close) are this same number
  function edge(fair, cost) {
    return inUnit(fair) && inUnit(cost) ? r4(fair / cost - 1) : null;
  }

  // ── pick'em apps ──
  // calc.js holds the payout tables (PICKEM) and the break-even search; this
  // reads them at call time so the two files don't load each other on start
  function calcLib() {
    if (typeof module === 'object' && module.exports) return require('./calc');
    return typeof self !== 'undefined' ? /** @type {any} */ (self).LRCalc : null;
  }
  // an app's slip types and break-evens per leg, every size
  function pickemTable(venue) {
    const s = schedule(venue), C = calcLib();
    if (!s || s.kind !== 'pickem') return [];
    if (s.perPick) return [{ type: 'per_pick', label: `${s.name} (${s.perPick}x a pick)`, n: 1, breakeven: r4(1 / s.perPick) }];
    if (!C) return [];
    const rows = [];
    for (const t of s.types) for (const n of Object.keys(C.PICKEM[t]?.tables || {}).map(Number)) {
      const x = C.pickemSlip(t, n);
      if (x && x.breakeven != null) rows.push({ type: t, label: `${x.label} ${n}-pick`, n, breakeven: x.breakeven });
    }
    return rows;
  }
  // the break-even per leg of the app's default slip (3-pick Power / Standard),
  // or of `type` at `n` picks. multiplier: the pick's own payout as the app
  // shows it. Sleeper's is the pick's whole payout (1.78x), so break-even is
  // 1 / m; Underdog's and Pick6's scale the slip (1x standard, 0.9x on a
  // favoured side), and on an all-or-nothing slip a leg at m× breaks even at
  // the standard leg's chance / m (p · q^(n−1) · T · m = 1 with q^n · T = 1)
  function legBreakeven(venue, { type = null, n = null, multiplier = null } = {}) {
    const s = schedule(venue);
    if (!s || s.kind !== 'pickem') return null;
    const rows = pickemTable(venue);
    const m = isNum(multiplier) && multiplier > 0 ? multiplier : null;
    if (s.perPick) {
      const x = m || s.perPick;
      return { type: 'per_pick', label: `${s.name} ${x.toFixed(2)}x pick`, n: 1, breakeven: r4(1 / x) };
    }
    const t = type || s.defaultType, k = n || s.defaultN;
    const row = rows.find(r => r.type === t && r.n === k) || null;
    if (!row || !m || Math.abs(m - 1) < 1e-9) return row;
    return { ...row, label: `${row.label} at ${m.toFixed(2)}x`, multiplier: m, breakeven: r4(row.breakeven / m) };
  }

  // every schedule for the FEES footnote
  function footnote() {
    return Object.entries(SCHEDULES).map(([id, s]) => ({ id, name: s.name, kind: s.kind, status: s.status, checked: s.checked, effective: s.effective || null,
      source: s.source, summary: s.summary, unpublished: s.unpublished || null, breakeven: s.kind === 'pickem' ? legBreakeven(id) : null }));
  }

  return { CHECKED, LOT, SCHEDULES, schedule, kindOf, rateOf, orderFee, contractFee, allInCost, priceFromCost, afterFee, edge,
    pickemTable, legBreakeven, footnote };
}));
