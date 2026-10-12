// ─── BEST PLAYS ───────────────────────────────────────────────────────────────
// One ranked list of what's worth betting right now, across the app: Sharp
// Tail entries, esports exchange edges, esports props and exchange arbs. Each
// row says what to bet, where, at what price, how many units and why.
//
// The ranking leans on the RESULTS scoreboard (results.js): every live play is
// matched to the plays its track record is cut into (its grade, its category,
// its venue, ...). A play type the record says to avoid drops out; one that's
// proven ranks first. Within a tier, the bigger edge goes first.
//
//   tier 0  proven play types, and arbs (both sides bought for under $1)
//   tier 1  promising play types
//   tier 2  too early to tell
//
// Units are the same for everyone (no per-user sizing): Sharp Tail keeps its
// own size, a prop is 1u (how it's graded), and an esports edge is ¼ Kelly
// with 1u = 1% of bankroll, capped at 1u until its play type is proven (2u).
// The inputs are already licence- and region-gated by the server.

const { sportKey, statKind } = require('./tracker');

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = Date.parse(t); return Number.isFinite(x) ? x : null; };
const quarter = x => Math.floor(x * 4) / 4;

const TIER = { proven: 0, promising: 1, early: 2 };
const DEFAULTS = {
  tailMaxAgeMs: 2 * 3600e3,   // a sharp's buy older than this has been priced in
  propMinEv: 0.02,            // props: at least 2% EV over the pick'em break-even
  edgeMaxUnits: 1,            // esports edges until proven
  provenMaxUnits: 2,
  kellyFraction: 0.25,
  bankrollUnits: 100,         // 1u = 1% of bankroll
  limit: 50,
};

// each source's labels, in the shape results.js cuts plays by
function tailLabels(s) {
  const v = s.venue;
  return { grade: s.grade ? `${s.grade} grade` : null, category: s.category || 'other', venue: v ? String(v.name || v.key || 'venue') : 'Polymarket', consensus: s.isConsensus ? 'consensus' : 'single wallet' };
}

// plays → lookup(source, labels) → { verdict, play } or { avoid: play }
function verdictIndex(plays = []) {
  const by = new Map();
  for (const p of plays) by.set(`${p.source}|${p.by || 'all'}|${p.play}`, p);
  const SOURCES = require('./results').SOURCES;
  return (source, labels) => {
    const def = SOURCES[source];
    const found = [by.get(`${source}|all|all`)];
    for (const cut of def ? def.cuts : []) {
      const vals = cut.map(k => labels[k]);
      if (vals.some(v => v == null || v === '')) continue;
      found.push(by.get(`${source}|${cut.join('+')}|${vals.join(' · ')}`));
    }
    const hits = found.filter(Boolean);
    const avoid = hits.find(p => p.verdict === 'avoid');
    if (avoid) return { avoid };
    // the best verdict any of its cuts has earned; the most specific cut wins ties
    const best = hits.reduce((a, p) => (!a || TIER[p.verdict] < TIER[a.verdict] || (TIER[p.verdict] === TIER[a.verdict] && (p.by || '').length > (a.by || '').length) ? p : a), null);
    return { verdict: best ? best.verdict : 'early', play: best && best.verdict !== 'early' ? best : null };
  };
}

// "proven: A grade · sports, +4.1% CLV over 34 bets"
function evidence(p) {
  if (!p) return null;
  const name = p.play === 'all' ? `every ${p.label} play` : `${p.label}: ${p.play}`;
  const stat = p.avgClv != null ? `${p.avgClv > 0 ? '+' : ''}${(p.avgClv * 100).toFixed(1)}% CLV` : p.roi != null ? `${p.roi > 0 ? '+' : ''}${(p.roi * 100).toFixed(1)}% ROI` : null;
  return `${p.verdict} (${name}${stat ? `, ${stat}` : ''} over ${p.n} bets)`;
}

// ¼ Kelly on a binary contract that costs c and wins with probability p
function kellyUnits(p, c, cap, o) {
  if (!(p > c && c > 0 && c < 1)) return 0;
  const f = (p - c) / (1 - c);
  return Math.min(cap, quarter(o.kellyFraction * f * o.bankrollUnits));
}

// Sharp Tail entries still worth following: sized, priced at a venue, recent,
// not started, and not since sold by the wallet that bought them
function tailRows(signals, verdict, o, now) {
  const exits = new Map();
  for (const s of signals) if (s.type === 'exit') {
    const k = `${s.wallet}|${s.asset || s.conditionId}`;
    exits.set(k, Math.max(exits.get(k) || 0, ms(s.at) || 0));
  }
  const rows = [], dropped = [];
  for (const s of signals) {
    if (s.type !== 'entry' || s.locked || s.reason || s.blocked) continue;
    const v = s.venue;
    const units = Number(v?.units ?? s.units);
    if (!v || !(units > 0) || !(v.price > 0 && v.price < 1 || v.american != null)) continue;
    const seen = ms(s.seenAt || s.at);
    if (seen == null || now - seen > o.tailMaxAgeMs) continue;
    const start = ms(s.gameStartTime);
    if (start != null && start <= now) continue;
    if ((exits.get(`${s.wallet}|${s.asset || s.conditionId}`) || 0) > (ms(s.at) || 0)) continue;
    const labels = tailLabels(s);
    const vd = verdict('tail', labels);
    if (vd.avoid) { dropped.push({ kind: 'tail', title: s.market, play: vd.avoid.play }); continue; }
    const cost = v.cost ?? (v.price + (v.fee || 0));
    const ev = s.q != null && cost > 0 ? r4(s.q / cost - 1) : null;
    const why = [`${s.grade}-grade sharp${s.isConsensus ? `, with ${(s.consensus || []).length - 1} more graded wallet(s) on the same side` : ''} bought at ${Math.round(s.theirPrice * 100)}c`];
    if (s.q != null) why.push(`our win chance ${Math.round(s.q * 100)}%`);
    if (vd.play) why.push(evidence(vd.play));
    rows.push({
      id: `tail:${s.id}`, kind: 'tail', label: 'Sharp Tail', title: s.market, category: s.category,
      bet: v.buy || s.outcome, venue: v.name || v.key, price: v.american != null ? null : v.price, american: v.american ?? null,
      maxPrice: v.maxPrice ?? s.maxPrice ?? null, units, ev, verdict: vd.verdict, why, url: v.url || null,
      startsAt: s.gameStartTime || null, at: s.seenAt || s.at, warning: v.warning || null,
    });
  }
  return { rows, dropped };
}

// esports match board edges: a quote under the all-source fair price
function edgeRows(matches, verdict, o, now) {
  const rows = [], dropped = [];
  for (const m of matches) {
    const start = ms(m.start);
    if (m.live || (start != null && start <= now)) continue;
    for (const e of m.edges || []) {
      if (!(e.cost > 0 && e.cost < 1) || e.fair == null || !(e.ev > 0)) continue;
      const labels = { sport: m.game, book: e.venue, market: e.kind };
      const vd = verdict('esportsEdges', labels);
      if (vd.avoid) { dropped.push({ kind: 'esportsEdge', title: m.label, play: vd.avoid.play }); continue; }
      const cap = vd.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
      const units = kellyUnits(e.fair, e.cost, cap, o);
      if (!(units > 0)) continue;
      const why = [`fair price ${Math.round(e.fair * 100)}c from the other markets, ${Math.round(e.cost * 100)}c here after fees`];
      if (vd.play) why.push(evidence(vd.play));
      const mk = (m.markets || []).find(x => x.key === e.market);
      rows.push({
        id: `edge:${m.id}|${e.market}|${e.outcome}|${e.venue}`, kind: 'esportsEdge', label: `${m.game} match edge`, title: m.label || (m.teams || []).join(' vs '),
        bet: `${e.outcome}${mk?.label && e.kind !== 'match' ? ` (${mk.label})` : ''}`, venue: e.venue === 'kalshi' ? 'Kalshi' : e.venue === 'polymarket' ? 'Polymarket' : e.venue,
        price: e.cost, american: null, maxPrice: null, units, ev: r4(e.ev), verdict: vd.verdict, why,
        url: m.links?.[e.venue] || null, startsAt: m.start || null, at: null, warning: null,
      });
    }
  }
  return { rows, dropped };
}

// esports player props on the pick'em apps, 1u each as graded
function propRows(picks, verdict, o, now) {
  const rows = [], dropped = [];
  for (const p of picks) {
    if (p.locked || !p.side || p.bestEv == null || p.bestEv / 100 < o.propMinEv) continue;
    const start = ms(p.startTime);
    if (start == null || start <= now) continue;
    const labels = { sport: sportKey(p.sport), stat: statKind(p.market), side: p.side };
    const vd = verdict('esportsPicks', labels);
    const title = `${p.player}${p.team ? ` (${p.team})` : ''}`;
    if (vd.avoid) { dropped.push({ kind: 'esportsProp', title, play: vd.avoid.play }); continue; }
    const book = p.bestBook === 'UD' ? 'Underdog' : 'PrizePicks';
    const line = p.bestBook === 'UD' && p.udLine != null ? p.udLine : p.ppLine ?? p.udLine;
    const why = [`model ${p.modelPred} vs line ${line}, ${p.prob}% to hit`];
    if (p.sampleSize) why.push(`${p.sampleSize} maps of history`);
    if (vd.play) why.push(evidence(vd.play));
    rows.push({
      id: `prop:${p.sport}|${p.player}|${p.market}`, kind: 'esportsProp', label: `${labels.sport} prop`, title,
      bet: `${p.side === 'OVER' ? 'More' : 'Less'} than ${line} ${p.displayMarket || p.market}`, venue: book, price: null, american: null, maxPrice: null,
      units: 1, ev: r4(p.bestEv / 100), verdict: vd.verdict, why, url: null, startsAt: p.startTime, at: null, warning: null,
    });
  }
  return { rows, dropped };
}

// sports props on the pick'em apps, priced off a sharp line by the EV screen
// (ev.js): Kalshi's player ladders, or sportsbooks when a key is set. 1u each.
function dfsRows(rows, o, now) {
  const out = [];
  for (const r of rows) {
    if (!r.dfs || r.ev == null || r.ev / 100 < o.propMinEv) continue;
    const start = ms(r.start);
    if (start == null || start <= now) continue;
    const book = r.book === 'underdog' ? 'Underdog' : r.book === 'prizepicks' ? 'PrizePicks' : r.book;
    const ref = (r.sharpBooks || []).map(b => (b === 'kalshi_props' ? 'Kalshi' : b)).join(', ') || 'consensus';
    out.push({
      id: `dfs:${r.group}|${r.side}|${r.book}`, kind: 'sportsProp', label: `${r.sport} prop`, title: r.player,
      bet: `${r.side === 'Over' ? 'More' : 'Less'} than ${r.point} ${r.market.replace(/_/g, ' ')}`, venue: book, price: null, american: null, maxPrice: null,
      units: 1, ev: r4(r.ev / 100), verdict: 'early', why: [`${ref} prices it at ${r.fairProb}% to hit`],
      url: null, startsAt: r.start, at: null, warning: null,
    });
  }
  return out;
}

// exchange arbs (xarb.js) and esports match arbs: both sides for under $1.
// Units don't apply: the stake splits across the legs.
const VENUE_NAMES = { kalshi: 'Kalshi', polymarket: 'Polymarket', novig: 'Novig', prophetx: 'ProphetX' };
const venueName = l => l.venueTitle || VENUE_NAMES[l.venue] || l.venue;

function arbRows(arbs, esportsArbs) {
  const rows = [];
  for (const a of arbs) {
    if (a.locked || !(a.profitPct > 0) || !(a.legs || []).length) continue;
    const pcts = a.stakes?.legs?.map(l => l.pct);
    rows.push({
      id: `arb:${a.id}`, kind: 'arb', label: 'Exchange arb', title: a.title, category: a.category,
      bet: a.legs.map((l, i) => `${venueName(l)}: ${l.pick}${pcts?.[i] != null ? ` (${pcts[i]}% of stake)` : ''}`).join(' + '),
      venue: [...new Set(a.legs.map(venueName))].join(' + '), price: a.totalCost ?? null, american: null, maxPrice: null,
      units: null, ev: r4(a.profitPct / 100), verdict: 'arb', why: [`both sides cost ${Math.round((a.totalCost || 0) * 1000) / 10}c for a $1 payout`, ...(a.warnings || [])],
      url: a.legs[0]?.url || null, startsAt: a.closeTime || null, at: null, warning: (a.warnings || [])[0] || null, legs: a.legs,
    });
  }
  for (const { match: m, arb } of esportsArbs) {
    if (!(arb.profitPct > 0) || !arb.tight) continue;
    const total = arb.legs.reduce((x, l) => x + l.cost, 0);
    rows.push({
      id: `esarb:${m.id}|${arb.market}`, kind: 'arb', label: `${m.game} match arb`, title: m.label || (m.teams || []).join(' vs '),
      bet: arb.legs.map(l => `${l.venue === 'kalshi' ? 'Kalshi' : 'Polymarket'}: ${l.outcome} (${Math.round(l.cost / total * 100)}% of stake)`).join(' + '),
      venue: [...new Set(arb.legs.map(l => (l.venue === 'kalshi' ? 'Kalshi' : 'Polymarket')))].join(' + '), price: r4(total), american: null, maxPrice: null,
      units: null, ev: r4(arb.profitPct), verdict: 'arb', why: [`both sides cost ${Math.round(total * 1000) / 10}c for a $1 payout`],
      url: m.links?.[arb.legs[0].venue] || null, startsAt: m.start || null, at: null, warning: null,
    });
  }
  return rows;
}

// { signals, matches, picks, arbs, plays } → { rows (ranked), dropped, counts }
function bestPlays({ signals = [], matches = [], picks = [], props = [], arbs = [], plays = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const verdict = verdictIndex(plays);
  const esArbs = [];
  for (const m of matches) {
    const start = ms(m.start);
    if (m.live || (start != null && start <= now)) continue;
    for (const a of m.arbs || []) esArbs.push({ match: m, arb: a });
  }
  const parts = [tailRows(signals, verdict, o, now), edgeRows(matches, verdict, o, now), propRows(picks, verdict, o, now)];
  const rows = [...parts.flatMap(p => p.rows), ...dfsRows(props, o, now), ...arbRows(arbs, esArbs)];
  const tier = r => (r.verdict === 'arb' ? 0 : TIER[r.verdict] ?? 2);
  rows.sort((a, b) => tier(a) - tier(b) || (b.ev ?? -1) - (a.ev ?? -1));
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { rows: rows.slice(0, o.limit), total: rows.length, counts, dropped: parts.flatMap(p => p.dropped) };
}

module.exports = { bestPlays, verdictIndex, kellyUnits, DEFAULTS };
