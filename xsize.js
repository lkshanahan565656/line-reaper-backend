// ─── EXCHANGE LINES AT REAL SIZE: THE RECORD ─────────────────────────────────
// Kalshi, Gemini and Polymarket US are where a Texan can bet a game line. The
// 10-14 work priced them at the top of the book; this prices them at what a
// subscriber pays for $50, $200 and $1,000 (depthfill.js: the book walked,
// fee in), against Pinnacle's no-vig fair at the same line, read the same
// minute. Rules fixed before any data (checks/xsize-2026-10-24/PREREGISTERED.md):
//
//   flag    the whole tier fills at +1% or better over Pinnacle's fair, game
//           starting 2 min to 24 h out
//   kinds   one record per venue × tier, never pooled; Pinnacle alt lines are
//           kept apart and never judged
//   bet     the first flag per venue × market × side × tier
//   close   Pinnacle's fair for that side at its last read before the start
//           (no read in the last 20 minutes: no close, not graded)
//   result  ESPN final, profit per $1 at the fill cost
//   verdict 50 graded: CLV t ≥ 2 and results not 1.5 sd short of what the
//           close expects → passes the record (then a raw re-check); CLV ≤ 0
//           or results 1.5 sd short → fails. Under 50: a lead.
//
// No alerts, not in Best Plays: a record until it passes. EXCHANGE_SIZE=off stops it.

const D = require('./depthfill');
const pingames = require('./pingames');
const execcheck = require('./execcheck');
const pmus = require('./pmus');
const { outcomeOf } = require('./evtrack');
const fees = require('./fees');

const VENUES = ['kalshi', 'gemini', 'polymarketus'];
// Polymarket US answered 429 at 7 book reads in a pass beside its own board reads (10-25): 3 a pass
const MAX_READS = { kalshi: 30, gemini: 30, polymarketus: 3 };
const MIN_N = 50;
const CLOSE_MAX_AGE_MS = 20 * 60e3;
const { r4 } = require('./mathutil');
const prob = a => { const x = Number(a); return !Number.isFinite(x) || x === 0 ? null : x < 0 ? -x / (-x + 100) : 100 / (x + 100); };
// Kalshi's all-in cost a contract (fees.js), the same number the shopper ranks on
const kcost = p => fees.allInCost('kalshi', p);

// Pinnacle's fair for one side of a parsed Pinnacle game (pingames.parseGames)
// → { p, alt, limit } | null. three: the venue's result market is three-way.
function pinFair(pg, market, side, point, { three = false } = {}) {
  if (!pg) return null;
  const is = (a, b) => a === b || pingames.sameTeam(a, b);
  if (market === 'h2h') {
    const ml = pg.ml;
    if (!ml || (ml.draw != null) !== three) return null;
    const p = /^draw$/i.test(side) ? ml.draw : is(side, pg.home) ? ml.home : is(side, pg.away) ? ml.away : null;
    return p > 0 && p < 1 ? { p, alt: false, limit: ml.limit ?? null } : null;
  }
  const pt = Number(point);
  if (!Number.isFinite(pt)) return null;
  if (market === 'spreads') {
    const team = String(side).replace(/\s+[+-]?\d+(?:\.\d+)?$/, '');
    const home = is(team, pg.home) ? true : is(team, pg.away) ? false : null;
    if (home == null) return null;
    const want = home ? pt : -pt;
    const s = pg.spreads.filter(x => x.home === want).sort((a, b) => a.alt - b.alt)[0];
    return s ? { p: home ? s.pHome : r4(1 - s.pHome), alt: !!s.alt, limit: s.limit ?? null } : null;
  }
  if (market === 'totals') {
    const t = pg.totals.filter(x => x.line === pt).sort((a, b) => a.alt - b.alt)[0];
    if (!t) return null;
    return /^over$/i.test(side) ? { p: t.pOver, alt: !!t.alt, limit: t.limit ?? null } : /^under$/i.test(side) ? { p: r4(1 - t.pOver), alt: !!t.alt, limit: t.limit ?? null } : null;
  }
  return null;
}

// Every venue side Pinnacle prices, with its top-of-book cost (fee in):
// games (freebooks games by sport, Gemini and Polymarket US outcomes carrying
// ref), pinGames (Pinnacle's parsed games), kalshiRows (xarb Kalshi rows)
// → [{ venue, ref, sideKey, sport, event, start, market, side, point, fair, cost, ev, alt, limit }]
function sidesOf({ games = {}, pinGames = [], kalshiRows = [] } = {}) {
  const pinBy = new Map(pinGames.map(pg => [`pin-${pg.id}`, pg]));
  const sportBy = new Map();
  const out = [];
  const push = (x, f) => { if (f && x.cost > 0 && x.cost < 1) out.push({ ...x, sideKey: `${x.venue}|${x.ref.id}|${x.ref.buy}`, fair: f.p, alt: f.alt, limit: f.limit, ev: fees.edge(f.p, x.cost) }); };
  for (const [sport, gs] of Object.entries(games)) {
    for (const g of gs || []) {
      sportBy.set(g.id, sport);
      const pg = pinBy.get(g.id);
      if (!pg) continue;
      const event = `${g.away_team} @ ${g.home_team}`;
      for (const bm of g.bookmakers || []) {
        if (bm.key !== 'gemini' && bm.key !== 'polymarketus') continue;
        for (const m of bm.markets || []) {
          if (!/^(h2h|spreads|totals)$/.test(m.key)) continue;
          const three = m.key === 'h2h' && m.outcomes.length === 3;
          for (const o of m.outcomes) {
            if (!o.ref?.id || o.ref.venue !== bm.key) continue;
            const side = m.key === 'spreads' ? `${o.name} ${o.point > 0 ? '+' : ''}${o.point}` : o.name;
            push({ venue: bm.key, ref: o.ref, sport, event, start: g.commence_time, market: m.key, side, point: o.point ?? null, cost: prob(o.price) },
              pinFair(pg, m.key, side, o.point, { three }));
          }
        }
      }
    }
  }
  let matched = [];
  try { matched = pingames.matchRows(kalshiRows.filter(r => r.exchange === 'kalshi' && r.tradable !== false), pinGames); } catch { matched = []; }
  for (const { row, game } of matched) {
    const sport = sportBy.get(`pin-${game.id}`);
    if (!sport) continue;
    const base = { venue: 'kalshi', sport, event: `${game.away} @ ${game.home}`, start: game.start };
    const teamOf = label => (pingames.sameTeam(label, game.home) ? game.home : pingames.sameTeam(label, game.away) ? game.away : null);
    const sides = [];
    if (row.game3) {
      const team = row.game3.pick === 'draw' ? 'Draw' : teamOf(row.outcomeLabel);
      if (team) sides.push({ buy: 'yes', market: 'h2h', side: team, point: null, three: true });
    } else if (row.kind === 'teams') {
      const t = teamOf(row.outcomeLabel), o = t === game.home ? game.away : t === game.away ? game.home : null;
      if (t && o) sides.push({ buy: 'yes', market: 'h2h', side: t, point: null }, { buy: 'no', market: 'h2h', side: o, point: null });
    } else if (row.kind === 'total' && Number.isFinite(row.line)) {
      sides.push({ buy: 'yes', market: 'totals', side: 'Over', point: row.line }, { buy: 'no', market: 'totals', side: 'Under', point: row.line });
    } else if (row.kind === 'spread' && Number.isFinite(row.line) && row.lineTeam) {
      const t = teamOf(row.lineTeam), o = t === game.home ? game.away : t === game.away ? game.home : null;
      if (t && o) sides.push({ buy: 'yes', market: 'spreads', side: `${t} -${row.line}`, point: -row.line }, { buy: 'no', market: 'spreads', side: `${o} +${row.line}`, point: row.line });
    }
    for (const s of sides) {
      const ask = s.buy === 'yes' ? row.yesAsk : row.noAsk;
      push({ ...base, ref: { venue: 'kalshi', id: row.id, buy: s.buy }, market: s.market, side: s.side, point: s.point, cost: kcost(ask) },
        pinFair(game, s.market, s.side, s.point, { three: !!s.three }));
    }
  }
  return out;
}

// a book read → asks for the side and its fee
async function readAsks(http, ref) {
  if (ref.venue === 'kalshi') return { asks: execcheck.kalshiAsks((await http.get(execcheck.KALSHI_BOOK_URL(ref.id), { timeout: 8000 }))?.data, ref.buy), fee: D.VENUES.kalshi };
  if (ref.venue === 'gemini') return { asks: D.geminiAsks((await http.get(D.GEMINI_BOOK_URL(ref.id), { timeout: 8000 }))?.data, ref.buy), fee: D.VENUES.gemini };
  const b = pmus.parseBook((await http.get(`${pmus.GATEWAY}/v1/markets/${encodeURIComponent(ref.id)}/book`, { timeout: 8000 }))?.data);
  if (!b || b.open === false) return null;
  return { asks: execcheck.pmusAsks(b, ref.buy), fee: { rate: ref.rate ?? D.VENUES.polymarketus.rate, roundCent: false } };
}

// onBook(ref, { asks, fee }, at): every book read, handed on (the shopper keeps them for its size column)
function createSizeTracker({ store, http, now = () => Date.now(), maxReads = MAX_READS, onBook = null } = {}) {
  const loaded = (async () => { if (store.init) await store.init(); })();
  const holdUntil = {};
  const state = { scans: 0, lastScan: null, sides: 0, candidates: {}, reads: {}, flags: 0, errors: [] };

  // one minute's pass: sides from the latest reads; the books of those whose
  // top beats the fair by 1% read and walked; new flags recorded, open bets'
  // fairs kept, started ones closed
  async function scan(input) {
    await loaded;
    const t = now();
    const all = sidesOf(input);
    state.sides = all.length;
    // per venue: sides priced, how many at Pinnacle's fair or better at the top, the best top EV
    state.byVenue = {};
    for (const x of all) {
      const v = (state.byVenue[x.venue] ||= { sides: 0, atFair: 0, mainAtFlag: 0, bestEv: null });
      v.sides++;
      if (x.ev >= 0) v.atFair++;
      if (x.ev >= D.FLAG_EV && !x.alt) v.mainAtFlag++;
      if (v.bestEv == null || x.ev > v.bestEv) v.bestEv = x.ev;
    }
    const bySide = new Map(all.map(s => [s.sideKey, s]));
    const bets = await store.all();
    const changed = new Map();
    // open bets: Pinnacle's latest fair for the side; started → closed
    for (const b of bets) {
      if (b.status !== 'open') continue;
      const s = bySide.get(b.sideKey);
      if (s && Date.parse(b.start) > t) { b.fairLast = s.fair; b.fairLastAt = new Date(t).toISOString(); b.altLast = s.alt; changed.set(b.id, b); }
      if (Date.parse(b.start) <= t) { close(b); changed.set(b.id, b); }
    }
    // candidates: top of book at the flag or better, in the window
    const cands = all.filter(s => s.ev >= D.FLAG_EV && (Date.parse(s.start) - t) / 60e3 >= 2 && (Date.parse(s.start) - t) / 60e3 <= 1440)
      .sort((a, b) => b.ev - a.ev);
    const per = {};
    const todo = cands.filter(c => { per[c.venue] = (per[c.venue] || 0) + 1; return per[c.venue] <= (maxReads[c.venue] || 0) && !(t < (holdUntil[c.venue] || 0)); });
    state.candidates = per;
    const have = new Map(bets.map(b => [b.id, b]));
    const one = async c => {
      let book = null;
      try { book = await readAsks(http, c.ref); }
      catch (e) {
        const st = e.response?.status;
        if (st === 403 || st === 429) holdUntil[c.venue] = t + 10 * 60e3;
        state.errors = [`${c.venue}: ${st || e.message}`, ...state.errors].slice(0, 5);
      }
      state.reads[c.venue] = (state.reads[c.venue] || 0) + 1;
      if (!book) return;
      if (onBook) { try { onBook(c.ref, book, t); } catch { /* the record never waits on the shopper */ } }
      const f = D.fillsOf(book.asks, c.fair, book.fee);
      for (const tier of D.TIERS) {
        const w = f.tiers[tier];
        const id = `${c.sideKey}|${tier}`;
        const old = have.get(id);
        if (!D.flagged(w)) continue;
        if (old) { if (old.status === 'open') { old.lastFlagAt = new Date(t).toISOString(); old.flagReads = (old.flagReads || 1) + 1; changed.set(id, old); } continue; }
        const b = {
          id, sideKey: c.sideKey, venue: c.venue, tier, sport: c.sport, event: c.event, start: c.start, market: c.market, side: c.side, point: c.point,
          marketId: c.ref.id, buy: c.ref.buy, alt: c.alt, limit: c.limit, fairAtFlag: c.fair, topCost: f.top?.cost ?? null, cost: w.cost,
          usd: w.usd, contracts: w.contracts, ev: w.ev, edgeUsd: f.atEdge, flaggedAt: new Date(t).toISOString(), lastFlagAt: new Date(t).toISOString(), flagReads: 1,
          minsBefore: Math.round((Date.parse(c.start) - t) / 60e3), fairLast: c.fair, fairLastAt: new Date(t).toISOString(), status: 'open',
        };
        have.set(id, b); changed.set(id, b); state.flags++;
      }
    };
    // a venue's books one after another (the polite client spaces each host), the venues side by side
    await Promise.all(VENUES.map(async v => { for (const c of todo.filter(x => x.venue === v)) await one(c); }));
    for (const b of changed.values()) await store.put(b);
    state.scans++; state.lastScan = new Date(t).toISOString(); state.lastScanMs = now() - t;
    return { sides: all.length, candidates: cands.length, read: todo.length };
  }

  // Pinnacle's last fair before the start is the close, if read in the last 20 minutes
  function close(b) {
    b.status = 'closed';
    const age = Date.parse(b.start) - Date.parse(b.fairLastAt || 0);
    if (b.fairLast > 0 && age <= CLOSE_MAX_AGE_MS) { b.closeFair = b.fairLast; b.closeAlt = !!b.altLast; b.clv = fees.edge(b.closeFair, b.cost); }
    else { b.closeFair = null; b.clv = null; b.closeMissing = true; }
  }

  // closed bets with a close and no result: the final from grader.gradeGame
  // ({ league, home, away, start } → { home, away } points | { pending } | null)
  async function gradeResults(grader, leagueOf, { limit = 40, minAgeMs = 3 * 3600e3 } = {}) {
    await loaded;
    const t = now();
    const due = (await store.all()).filter(b => b.status === 'closed' && b.closeFair != null && b.outcome == null && !(b.resultTries >= 12) && leagueOf(b.sport)
      && t - Date.parse(b.start) >= minAgeMs).slice(0, limit);
    let graded = 0;
    const cache = new Map();
    for (const b of due) {
      const [away, home] = String(b.event).split(' @ ');
      const k = `${b.sport}|${b.event}|${b.start}`;
      let sc = cache.get(k);
      if (sc === undefined) { try { sc = await grader.gradeGame({ league: leagueOf(b.sport), home, away, start: b.start }); } catch { sc = null; } cache.set(k, sc); }
      if (sc?.pending) continue;
      const outcome = sc ? outcomeOf(b, sc) : null;
      if (!outcome) b.resultTries = (b.resultTries || 0) + 1;
      else { b.outcome = outcome; b.profit = outcome === 'win' ? r4(1 / b.cost - 1) : outcome === 'loss' ? -1 : 0; b.score = { home: sc.home, away: sc.away }; graded++; }
      await store.put(b);
    }
    return { due: due.length, graded };
  }

  async function list() { await loaded; return store.all(); }
  return { scan, gradeResults, list, state, ready: () => loaded };
}

// bets → the record: one row per venue × tier (main lines; alt lines apart),
// with the pre-registered verdict, and descriptive cuts
function summarize(bets = [], { minN = MIN_N } = {}) {
  const stat = xs => {
    const n = xs.length;
    if (!n) return { n: 0 };
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    return { n, mean: r4(mean), t: sd > 0 ? Math.round(mean / (sd / Math.sqrt(n)) * 100) / 100 : null };
  };
  const rowOf = bs => {
    const graded = bs.filter(b => b.clv != null);
    const clv = stat(graded.map(b => b.clv));
    const res = graded.filter(b => b.outcome === 'win' || b.outcome === 'loss' || b.outcome === 'push');
    const profit = r4(res.reduce((s, b) => s + b.profit, 0));
    // what the close expects per $1 at the fill: p_close / cost − 1; variance of a $1 bet p(1−p)/cost²
    const exp = r4(res.reduce((s, b) => s + (b.closeFair / b.cost - 1), 0));
    const sd = Math.sqrt(res.reduce((s, b) => s + b.closeFair * (1 - b.closeFair) / (b.cost * b.cost), 0));
    const z = sd > 0 ? Math.round((profit - exp) / sd * 100) / 100 : null;
    const won = res.filter(b => b.outcome === 'win').length, lost = res.filter(b => b.outcome === 'loss').length;
    let verdict = 'lead';
    if (clv.n >= minN) verdict = (clv.mean <= 0 || (z != null && z <= -1.5)) ? 'fail' : clv.t >= 2 ? 'passes the record' : 'lead';
    else if (z != null && res.length >= 20 && z <= -1.5) verdict = 'lead (results short)';
    const life = bs.map(b => (Date.parse(b.lastFlagAt) - Date.parse(b.flaggedAt)) / 60e3).filter(Number.isFinite);
    return { flagged: bs.length, open: bs.filter(b => b.status === 'open').length, noClose: bs.filter(b => b.closeMissing).length,
      graded: clv.n, clv: clv.mean ?? null, clvT: clv.t ?? null, beatClose: graded.length ? r4(graded.filter(b => b.clv > 0).length / graded.length) : null,
      results: res.length, won, lost, profit, expected: exp, z, verdict,
      avgEv: bs.length ? r4(bs.reduce((s, b) => s + b.ev, 0) / bs.length) : null,
      medianMinsFlagged: life.length ? life.sort((a, b) => a - b)[Math.floor(life.length / 2)] : null };
  };
  const group = (bs, keyOf) => {
    const m = new Map();
    for (const b of bs) { const k = keyOf(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
    return [...m].map(([k, xs]) => ({ key: k, ...rowOf(xs) })).sort((a, b) => b.flagged - a.flagged);
  };
  const main = bets.filter(b => !b.alt), alt = bets.filter(b => b.alt);
  return {
    rule: `whole tier fills at +${D.FLAG_EV * 100}% or better over Pinnacle's no-vig, fee in; judged at ${minN} graded per venue and tier`,
    kinds: group(main, b => `${b.venue}|${b.tier}`),
    alt: group(alt, b => `${b.venue}|${b.tier}`),
    bySport: group(main, b => `${b.venue}|${b.tier}|${b.sport}`),
    byStart: group(main, b => `${b.venue}|${b.tier}|${D.startBucket(b.minsBefore)}`),
    byMarket: group(main, b => `${b.venue}|${b.tier}|${b.market}`),
  };
}

module.exports = { VENUES, MAX_READS, MIN_N, pinFair, sidesOf, readAsks, createSizeTracker, summarize };
