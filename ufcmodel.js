// ─── UFC MODEL: PINNACLE'S FIGHT LENGTH × EACH FIGHTER'S OWN RATES ──────────
// Pinnacle prices every UFC fight's moneyline and total rounds; the pick'em
// apps hang Fight Time, Finishes, Round Finish, Significant Strikes and
// Takedowns legs, which no sharp book prices. This prices them off
// Pinnacle's two numbers (pre-registered 2026-10-25,
// checks/ufc-pin-2026-10-25/PREREGISTERED.md):
//
//   fight length  a baseline hazard of the fight ending, per 30-second bin
//                 (3- and 5-round fights apart), fitted on UFC fights
//                 2019-2024; one fight's curve is the baseline times c, with c
//                 set so P(time > 5 x L) is Pinnacle's no-vig Over at its total L
//   Fight Time    P(time > x minutes) off that curve (exact at x = 5 x L)
//   finishes      P(win) from Pinnacle's no-vig moneyline x P(it ends in the
//                 window), the winner taken as independent of the finish
//   strikes, TDs  the fighter's landed rate a minute, w x his own (shrunk to
//                 his division with m minutes of prior) + (1 - w) x what the
//                 opponent absorbs; given the time, a negative binomial with
//                 that mean x minutes; summed over the fight-length curve
//
// Pure functions. The fitted numbers live in seeds/ufc-model.json, rebuilt by
// checks/ufc-pin-2026-10-25/fit.js.

const PARAMS = (() => { try { return require('./seeds/ufc-model.json'); } catch { return null; } })();
const EPS = 1e-9;

// ── fight length ──
// fights → { bin, h3, h5 }: finishes per minute fought in each bin
function fitHazard(fights, { from = '2019-01-01', to = '2025-01-01', bin = 0.5, isDecision, isVoid } = {}) {
  const out = { bin };
  for (const sched of [3, 5]) {
    const n = Math.round((sched * 5) / bin), ev = new Array(n).fill(0), ex = new Array(n).fill(0);
    for (const f of fights) {
      if (f.sched !== sched || f.date < from || f.date >= to || isVoid(f.method)) continue;
      const T = Math.min(f.T, sched * 5);
      for (let i = 0; i < n && T > i * bin; i++) ex[i] += Math.min(bin, T - i * bin);
      if (!isDecision(f.method) && T < sched * 5 - EPS) ev[Math.min(n - 1, Math.floor(T / bin))]++;
    }
    out[`h${sched}`] = ev.map((e, i) => (ex[i] ? +(e / ex[i]).toFixed(5) : 0));
  }
  return out;
}
// the baseline's cumulative hazard to x minutes
function H0(x, sched, P = PARAMS) {
  const h = P?.hazard?.[`h${sched}`], bin = P?.hazard?.bin || 0.5;
  if (!h) return null;
  let s = 0;
  for (let i = 0; i < h.length && x > i * bin; i++) s += h[i] * Math.min(bin, x - i * bin);
  return s;
}
// Pinnacle's total: P(over L rounds) → c (null if it can't be set)
function curveC(sched, rounds, pOver, P = PARAMS) {
  const h = H0(rounds * 5, sched, P);
  if (!(h > 0) || !(pOver > 0 && pOver < 1)) return null;
  return -Math.log(pOver) / h;
}
// P(the fight lasts past x minutes)
const survive = (x, sched, c, P = PARAMS) => (x <= 0 ? 1 : Math.exp(-c * H0(Math.min(x, sched * 5), sched, P)));
// the curve as a distribution: [{ t, p }] over the bins (mid-bin times) plus the full distance
function timeDist(sched, c, P = PARAMS) {
  const bin = P.hazard.bin, full = sched * 5, out = [];
  let prev = 1;
  for (let a = bin; a <= full + EPS; a += bin) {
    const s = survive(a, sched, c, P);
    out.push({ t: a - bin / 2, p: prev - s });
    prev = s;
  }
  out.push({ t: full, p: prev, distance: true });
  return out;
}

// five rounds: a main event, a total over 3, or an app line past 15 minutes
const schedOf = ({ rounds, appMinutes, mainEvent } = {}) => (rounds >= 3 || appMinutes > 15 || mainEvent ? 5 : 3);

// ── counts ──
// negative binomial (mean mu, size k: variance mu + mu^2 / k): P(X > line)
function nbOver(line, mu, k) {
  if (!(mu > 0)) return line < 0 ? 1 : 0;
  const top = Math.floor(line);
  if (top < 0) return 1;
  const pr = k / (k + mu);
  let p = Math.exp(k * Math.log(pr)), cdf = p;
  for (let x = 1; x <= top; x++) { p *= ((x - 1 + k) / x) * (1 - pr); cdf += p; }
  return Math.max(0, Math.min(1, 1 - cdf));
}
// a fighter's rate a minute for a stat: his own (landed) and the opponent's
// conceded, each shrunk to the division. stat: 'sig' | 'td'
function rateOf(me, op, stat, P = PARAMS) {
  const s = P?.[stat], prior = s?.prior?.[me?.div] ?? s?.prior?.all;
  if (!s || !me || !op || !(prior > 0)) return null;
  const L = stat === 'sig' ? 'sigL' : 'tdL', A = stat === 'sig' ? 'sigA' : 'tdA';
  const own = (me[L] + s.m * prior) / (me.mins + s.m), conc = (op[A] + s.m * prior) / (op.mins + s.m);
  return s.w * own + (1 - s.w) * conc;
}
// P(count > line) for one fighter, summed over the fight-length curve
function statOver(line, rate, dist, k) {
  let p = 0;
  for (const b of dist) if (b.p > 0) p += b.p * nbOver(line, rate * b.t, k);
  return p;
}

// ── one fight's prices ──
// fight: { sched, rounds (Pinnacle's total), pOver (no-vig Over), pWin: { [canon]: p } }
// leg: { mkey, line, player (canon), me, op (careers) }
// → { pOver, exact, basis } | null
function priceLeg(fight, leg, P = PARAMS) {
  if (!P || !fight || !(fight.pOver > 0)) return null;
  const c = curveC(fight.sched, fight.rounds, fight.pOver, P);
  if (c == null) return null;
  const full = fight.sched * 5, line = Number(leg.line);
  switch (leg.mkey) {
    case 'fight_time': {
      if (!(line > 0 && line < full)) return null;
      const exact = Math.abs(line - fight.rounds * 5) < EPS;
      return { pOver: exact ? fight.pOver : survive(line, fight.sched, c, P), exact, basis: 'time' };
    }
    case 'finishes': case '1st_round_finish': case '2nd_round_finish': case '3rd_round_finish': case '4th_round_finish': case '5th_round_finish': {
      const pw = fight.pWin?.[leg.player];
      if (!(pw > 0 && pw < 1) || Math.abs(line - 0.5) > EPS) return null;
      let window;
      if (leg.mkey === 'finishes') window = 1 - survive(full - EPS, fight.sched, c, P);
      else {
        const r = parseInt(leg.mkey, 10);
        if (r > fight.sched) return null;
        window = survive((r - 1) * 5, fight.sched, c, P) - survive(r * 5 - EPS, fight.sched, c, P);
      }
      return { pOver: pw * window, exact: false, basis: 'fin' };
    }
    case 'significant_strikes': case 'takedowns': {
      const stat = leg.mkey === 'takedowns' ? 'td' : 'sig', s = P[stat];
      // the fighter needs 2+ UFC fights; an opponent new to the UFC concedes his division's rate
      if (!leg.me || leg.me.n < (s.minFights || 2)) return null;
      const op = leg.op || { n: 0, mins: 0, sigL: 0, sigA: 0, tdL: 0, tdA: 0 };
      const r = rateOf(leg.me, op, stat, P);
      if (!(r > 0)) return null;
      return { pOver: statOver(line, r, timeDist(fight.sched, c, P), s.k), exact: false, basis: 'stat', rate: +r.toFixed(3) };
    }
    default: return null;
  }
}

module.exports = { PARAMS, fitHazard, H0, curveC, survive, timeDist, schedOf, nbOver, rateOf, statOver, priceLeg };
