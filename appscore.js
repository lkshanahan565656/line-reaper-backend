// ─── APP SCORECARD: EACH PICK'EM APP'S NUMBER AGAINST PINNACLE'S CLOSE ───────
// Which app, and which stat on that app, sits furthest from Pinnacle's closing
// player-prop number, how often, and does the side the close favours win often
// enough to clear that app's break-even?
//
// One leg = one app's closing number on one player stat in one game, next to
// Pinnacle's raw close on the same prop (the prop close book, propclose.js; or
// the NFL Sunday recorder's legs). For each leg:
//
//   gap        the app's line minus Pinnacle's main line (the one nearest
//              50/50), in stat units; "off the close" when not 0
//   pOver      Pinnacle's no-vig P(over) at the app's own number: exact when
//              Pinnacle hangs it, else read along the stat's curve from
//              Pinnacle's nearest line (marked, never exact)
//   distance   |pOver - 50%| in points of win chance, comparable across stats
//   favoured   the side the close gives more than 50% at the app's number
//   be         that side's break-even at the app's real payout
//   clears     favoured chance >= break-even
//
// The judged rule (checks/app-scorecard-2026-10-25/PREREGISTERED.md): the
// favoured side of every leg that clears, graded on the box score. A cell
// counts only at 50 graded, z 2 or more above break-even and units above
// zero; until then it is research, alerts off, record kind app-card.
//
// Pure functions, plus a small grader (createResults) that settles each
// closed prop once from the box score for every app's leg on it.

const NS = require('./nflsunday');
const PC = require('./propclose');
const { devigPower } = require('./pinprops');

const APPS = ['prizepicks', 'underdog', 'sleeper', 'pick6'];
const LABEL = { prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper', pick6: 'DK Pick6' };
const PROVEN_N = 50, PROVEN_Z = 2;
const KIND = 'app-card';
const { r4, toProb } = require('./mathutil');

// Pinnacle's main line: the rung whose P(over) is nearest 50%
function pinMain(pin) {
  let best = null;
  for (const q of pin || []) if (q && q[1] > 0 && q[1] < 1 && (!best || Math.abs(q[1] - 0.5) < Math.abs(best[1] - 0.5))) best = q;
  return best;
}

// an app cell as the board keeps it ({ line, over, under, overOpen, underOpen })
// → nflsunday's [line, over mult, under mult, over open, under open]
const cellOf = c => (c && c.line != null ? [Number(c.line), c.over ?? null, c.under ?? null, c.overOpen === false ? 0 : 1, c.underOpen === false ? 0 : 1] : null);

// one closed prop (propclose entry shape: { sport, mkey, pin: [[line, pOver]],
// cells?: { app: [line, over, under, oo, uo] }, apps?: { app: line } }) and an
// app → the scorecard's leg, or null when the app or Pinnacle has no number.
// A cell recorded without its multipliers (entries before 3.179.0 kept the
// line alone) has no break-even unless the app pays one flat price (PrizePicks).
function legOf(entry, app) {
  if (!entry) return null;
  let v = entry.cells?.[app] || null;
  if (!v && entry.apps?.[app] != null) v = [Number(entry.apps[app]), null, null, 1, 1];
  if (!v || !Number.isFinite(v[0])) return null;
  const main = pinMain(entry.pin);
  if (!main) return null;
  const line = v[0];
  const at = PC.sourceAt({ sport: entry.sport, mkey: entry.mkey, pin: entry.pin }, line, 'pinnacle');
  if (!at || !(at.pOver > 0 && at.pOver < 1)) return null;
  const pOver = at.pOver;
  // dead even at the app's number: no side is favoured
  const favSide = pOver > 0.5 ? 'Over' : pOver < 0.5 ? 'Under' : null;
  const favP = favSide ? (favSide === 'Over' ? pOver : 1 - pOver) : 0.5;
  // the side to take: the larger margin over its own break-even. PrizePicks
  // pays both sides the same, so that is the favoured side; Underdog, Sleeper
  // and Pick6 move the payout instead of the line, so it can be the other one.
  // an Underdog side alone above 1.35x (anytime TD) could be either of its two
  // payout regimes (the 3-pick standard or a straight decimal price), so its
  // break-even is not known and the leg counts in the distances only
  const udOneSided = app === 'underdog' && ((v[3] === 0) !== (v[4] === 0) || v[1] == null || v[2] == null) && Math.max(v[1] || 0, v[2] || 0) > 1.35;
  const multKnown = (app === 'prizepicks' || v[1] != null || v[2] != null) && !udOneSided;
  let side = favSide, p = favP, be = null;
  if (multKnown) {
    let best = null;
    for (const s of ['Over', 'Under']) {
      if ((s === 'Over' ? v[3] : v[4]) === 0) continue;
      const b = NS.breakEven(app, s, v);
      if (!(b > 0 && b < 1)) continue;
      const ps = s === 'Over' ? pOver : 1 - pOver;
      if (!best || ps - b > best.p - best.be + 1e-12 || (Math.abs(ps - b - (best.p - best.be)) <= 1e-12 && s === favSide)) best = { s, p: ps, be: b };
    }
    if (best) ({ s: side, p, be } = best);
  }
  return {
    app, sport: entry.sport, mkey: entry.mkey, line, pinLine: main[0], gap: +(line - main[0]).toFixed(2), exact: !!at.exact,
    pOver: r4(pOver), dist: r4(Math.abs(pOver - 0.5)), favSide, favP: r4(favP),
    side, p: r4(p), be: be != null ? r4(be) : null, edge: be != null ? r4(p - be) : null, clears: be != null && p >= be,
  };
}

// a leg and the player's stat → 'win' | 'loss' | 'push' for the favoured side, or null
const outcomeOf = (leg, result) => (leg.side && Number.isFinite(result) ? NS.outcome(leg.side, leg.line, result) : null);

// the bar on one slice's graded tally
function barOf(t) {
  if (t.n >= PROVEN_N) return t.z >= PROVEN_Z && t.units > 0 ? 'passes, needs the raw re-check' : 'fails';
  return `${t.n} of ${PROVEN_N} graded`;
}

// legs [{ ...legOf, out? }] → one slice's numbers
function agg(legs) {
  const n = legs.length;
  const mean = f => (n ? legs.reduce((a, l) => a + f(l), 0) / n : null);
  const withBe = legs.filter(l => l.be != null);
  const pct = x => (x == null ? null : +(x * 100).toFixed(1));
  const graded = legs.filter(l => l.out && l.be != null);
  const all = NS.tally(graded.map(l => ({ out: l.out, be: l.be })));
  const clears = NS.tally(graded.filter(l => l.clears).map(l => ({ out: l.out, be: l.be })));
  return {
    n,
    exact: pct(mean(l => (l.gap === 0 ? 1 : 0))),
    off: pct(mean(l => (l.gap !== 0 ? 1 : 0))),
    low: pct(mean(l => (l.gap < 0 ? 1 : 0))),
    high: pct(mean(l => (l.gap > 0 ? 1 : 0))),
    gapAbs: n ? +mean(l => Math.abs(l.gap)).toFixed(2) : null,
    dist: pct(mean(l => l.dist)),
    favP: pct(mean(l => l.favP)),
    priced: withBe.length,
    be: withBe.length ? pct(withBe.reduce((a, l) => a + l.be, 0) / withBe.length) : null,
    p: withBe.length ? pct(withBe.reduce((a, l) => a + l.p, 0) / withBe.length) : null,
    edge: withBe.length ? pct(withBe.reduce((a, l) => a + l.edge, 0) / withBe.length) : null,
    clears: withBe.length ? pct(withBe.filter(l => l.clears).length / withBe.length) : null,
    clearsN: withBe.filter(l => l.clears).length,
    curve: legs.filter(l => !l.exact).length,
    graded: all, judged: { ...clears, bar: barOf(clears) },
  };
}

// legs → the scorecard: per app, and per app and stat (cells with at least
// minCell legs)
function scorecard(legs, { minCell = 5 } = {}) {
  const byApp = new Map(), byCell = new Map();
  for (const l of legs || []) {
    if (!l) continue;
    (byApp.get(l.app) || byApp.set(l.app, []).get(l.app)).push(l);
    const k = `${l.app}|${l.mkey}`;
    (byCell.get(k) || byCell.set(k, []).get(k)).push(l);
  }
  // closest to bettable first: the mean margin of the side to take over its
  // break-even, then the share that clears, then the distance off 50/50
  const rank = (a, b) => (b.edge ?? -1e9) - (a.edge ?? -1e9) || (b.clears ?? -1) - (a.clears ?? -1) || (b.dist ?? -1) - (a.dist ?? -1) || b.n - a.n;
  const apps = [...byApp].map(([app, list]) => ({ app, label: LABEL[app] || app, ...agg(list) })).sort(rank);
  const cells = [...byCell].filter(([, list]) => list.length >= minCell)
    .map(([k, list]) => { const [app, mkey] = k.split('|'); return { app, label: LABEL[app] || app, mkey, ...agg(list) }; }).sort(rank);
  const graded = (legs || []).filter(l => l && l.out).length;
  return { legs: (legs || []).filter(Boolean).length, graded, apps, cells, bar: { n: PROVEN_N, z: PROVEN_Z } };
}

// ── the prop close book → legs ──
// entries: [[key, entry]]; results: key → { result } | { void } | undefined
function legsFromBook(entries, results = new Map(), { apps = APPS } = {}) {
  const out = [];
  for (const [key, e] of entries || []) {
    if (!e?.pin?.length) continue;
    const r = results.get(key);
    if (r?.void) continue;
    for (const app of apps) {
      const leg = legOf(e, app);
      if (!leg) continue;
      leg.key = key;
      if (r && Number.isFinite(r.result)) leg.out = outcomeOf(leg, r.result);
      out.push(leg);
    }
  }
  return out;
}

// ── the NFL Sunday recorder's legs (legs.json.gz) → legs ──
// at: 'close' (the app's last number before kickoff, the scorecard) or 'bet'
// (its number an hour out, the bettable one), both against Pinnacle's close.
// Pinnacle's close in the recorder's leg is its rung at (or nearest) the
// app's closing number, raw American prices; it is de-vigged here.
function legsFromBoard(boardLegs, { at = 'close' } = {}) {
  const out = [];
  for (const b of boardLegs || []) {
    const q = b?.close?.books?.pinnacle;
    const v = at === 'bet' ? b?.bet?.v : b?.close?.v;
    if (!q || !Array.isArray(v) || q.over == null || q.under == null) continue;
    const po = toProb(q.over), pu = toProb(q.under);
    if (!(po > 0 && pu > 0) || po + pu < 1) continue;
    const entry = { sport: b.sport || 'NFL', mkey: b.mkey, pin: [[q.line, r4(devigPower(po, pu))]], cells: { [b.app]: v } };
    const leg = legOf(entry, b.app);
    if (!leg) continue;
    leg.key = b.key;
    const g = b.graded;
    if (g && !g.void && !g.skip && Number.isFinite(g.result)) leg.out = outcomeOf(leg, g.result);
    out.push(leg);
  }
  return out;
}

// ── settling closed props from the box score ──
// store: evtrack store ({ init, all, put }); grader: the combined sports
// grader ({ grade(pick), canGrade(pick) }). One result per prop, shared by
// every app's leg on it. A prop is asked for 3 hours after its start and
// voided 3 days on if the box never names the player.
const READY_AFTER_MS = 3 * 3600e3, VOID_AFTER_MS = 3 * 86400e3;
function createResults({ store, grader, now = () => Date.now(), log = console } = {}) {
  const done = new Map();
  const loaded = (async () => {
    if (store?.init) await store.init();
    for (const d of (store ? await store.all() : [])) if (d?.id && d.key) done.set(d.key, d);
  })().catch(e => log.warn?.(`App scorecard: load failed: ${e.message}`));
  let running = false, last = null;

  // entries: [[key, entry]] closed props; budget: grader calls this pass
  async function run(entries, { budget = 120, sports = null } = {}) {
    await loaded;
    if (running) return { skipped: true };
    running = true;
    let asked = 0, graded = 0, voided = 0;
    try {
      const t = now();
      for (const [key, e] of entries || []) {
        if (done.has(key) || !e?.pin?.length) continue;
        if (sports && !sports.includes(e.sport)) continue;
        const start = Date.parse(e.start || '');
        if (!(t - start >= READY_AFTER_MS)) continue;
        const pick = { sport: e.sport, mkey: e.mkey, player: e.player, team: e.team, matchTitle: e.matchTitle, startTime: e.start, start: e.start, signalLine: pinMain(e.pin)[0], signalSide: 'Over' };
        let r = null;
        if (grader.canGrade && !grader.canGrade(pick)) r = { void: 'no results source for this stat' };
        else {
          if (asked >= budget) break;
          asked++;
          let g = null;
          try { g = await grader.grade(pick); } catch (err) { log.warn?.(`App scorecard: grade: ${err.message}`); }
          if (g && !g.pending && Number.isFinite(g.result)) r = { result: g.result, eventId: g.eventId || null };
          else if (g?.void) r = { void: g.void };
          else if (t - start > VOID_AFTER_MS) r = { void: g?.pending ? 'never final' : 'not in the box score (did not play?)' };
        }
        if (!r) continue;
        const doc = { id: `ac|${key}`, key, status: r.void ? 'void' : 'graded', start: e.start, sport: e.sport, ...r, gradedAt: new Date(t).toISOString() };
        done.set(key, doc);
        if (r.void) voided++; else graded++;
        if (store) await store.put(doc).catch(err => log.warn?.(`App scorecard: save: ${err.message}`));
      }
    } finally { running = false; }
    last = { at: new Date(now()).toISOString(), asked, graded, voided };
    return last;
  }
  const get = key => done.get(key) || null;
  const map = () => done;
  function status() {
    let graded = 0, voided = 0;
    for (const d of done.values()) { if (d.status === 'graded') graded++; else voided++; }
    return { graded, voided, last };
  }
  return { run, get, map, status, ready: () => loaded };
}

// ── text, for the checks and the report ──
function reportText(card, { title = 'App scorecard vs Pinnacle\'s close' } = {}) {
  const p = x => (x == null ? '   -' : `${x.toFixed(1)}%`.padStart(6));
  const t = x => (x.n ? `${x.w}-${x.l}${x.p ? `-${x.p}` : ''} ${(x.hit * 100).toFixed(1)}% vs ${(x.be * 100).toFixed(1)}% z ${x.z} ${x.units > 0 ? '+' : ''}${x.units}u` : 'none graded');
  const row = r => `${`${r.label}${r.mkey ? ` ${r.mkey}` : ''}`.padEnd(32)} ${String(r.n).padStart(5)} ${p(r.exact)} ${p(r.off)} ${p(r.low)} ${p(r.high)} ${String(r.gapAbs ?? '-').padStart(6)} ${p(r.dist)} ${p(r.favP)} ${p(r.p)} ${p(r.be)} ${p(r.edge)} ${p(r.clears)}  side: ${t(r.graded)}  |  clears: ${t(r.judged)} [${r.judged.bar}]`;
  const head = `${'app / stat'.padEnd(32)} ${'legs'.padStart(5)} ${'same'.padStart(6)} ${'off'.padStart(6)} ${'low'.padStart(6)} ${'high'.padStart(6)} ${'|gap|'.padStart(6)} ${'dist'.padStart(6)} ${'favP'.padStart(6)} ${'p'.padStart(6)} ${'be'.padStart(6)} ${'edge'.padStart(6)} ${'clears'.padStart(6)}`;
  return [`${title}: ${card.legs} legs, ${card.graded} graded`, '', 'Per app (ranked by edge: the side to take, its chance on Pinnacle\'s close minus the app\'s break-even):', head, ...card.apps.map(row),
    '', 'Per app and stat:', head, ...card.cells.map(row),
    '', 'same: app at Pinnacle\'s main closing number; off: not; low: app below it (the Over gets the better number); high: above (the Under).',
    'dist: |P(over) - 50%| at the app\'s number on Pinnacle\'s close (exact, or along the stat\'s curve from Pinnacle\'s nearest line); favP: the favoured side\'s chance.',
    'side: the side with the larger margin over its own break-even (PrizePicks: the favoured side); p: its chance; be: its break-even; edge: p - be.',
    'clears: p at or past break-even. Judged: the clears, 50 graded, z 2+, units > 0, then the raw re-check.'].join('\n');
}

module.exports = { APPS, LABEL, KIND, PROVEN_N, PROVEN_Z, pinMain, cellOf, legOf, outcomeOf, agg, barOf, scorecard, legsFromBook, legsFromBoard, createResults, reportText, READY_AFTER_MS, VOID_AFTER_MS };
