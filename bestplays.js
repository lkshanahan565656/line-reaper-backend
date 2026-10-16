// ─── BEST PLAYS ───────────────────────────────────────────────────────────────
// One ranked list of what's worth betting right now, across the app: Sharp
// Tail entries, esports exchange edges, esports props, sports props (the PROPS
// board's sharp-priced pick'em plays), sportsbook lines and player props,
// exchange value and exchange arbs. Each
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
const { moveText } = require('./steam');
const { moverText } = require('./movers');
const { canonName } = require('./ev');
const { idOf: sportPropId } = require('./sporttrack');
const sportPropsLib = require('./sportprops');

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
const ms = t => { const x = Date.parse(t); return Number.isFinite(x) ? x : null; };
const quarter = x => Math.floor(x * 4) / 4;

const TIER = { proven: 0, promising: 1, early: 2 };
const DEFAULTS = {
  tailMaxAgeMs: 2 * 3600e3,   // a sharp's buy older than this has been priced in
  propMinEv: 0.02,            // props: at least 2% EV over the pick'em break-even
  lineMinEv: 0.02,            // sportsbook game lines: 2% or more over the fair price
  lineMaxEv: 0.15,            // past this it's nearly always a stale or wrong number
  lineMaxAgeMs: 45 * 60e3,    // book prices older than this have likely moved
  lineMinBooks: 3,            // a consensus price needs a few books behind it
  lineNeedsAgree: true,       // a game line needs two sharp sources that agree (ev.js agree)
  edgeMaxUnits: 1,            // esports edges and exchange value until proven
  provenMaxUnits: 2,
  entryMinEv: 0.03,           // an Underdog entry: at least 3% EV on the whole entry
  entryMaxLegs: 3,            // more legs, more variance, and the greedy pick gets worse
  bidShare: 0.5,              // a limit bid is half a take: it fills when the price is moving against it
  arbMaxLegs: 4,              // a 16-bet set isn't a play anyone places
  middleMinEvPct: 3,          // exchange middles: 3% EV or more (they miss most of the time)
  kellyFraction: 0.25,
  bankrollUnits: 100,         // 1u = 1% of bankroll
  limit: 300,
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
  // only: cut names (['signal']) to judge on those cuts alone, without 'all'
  return (source, labels, { only = null } = {}) => {
    const def = SOURCES[source];
    const found = only ? [] : [by.get(`${source}|all|all`)];
    for (const cut of def ? def.cuts : []) {
      if (only && cut.join('+') !== only.join('+')) continue;
      const vals = cut.map(k => labels[k]);
      if (vals.some(v => v == null || v === '')) continue;
      found.push(by.get(`${source}|${cut.join('+')}|${vals.join(' · ')}`));
    }
    const hits = found.filter(Boolean);
    // an "avoid" stands unless a narrower cut inside it beats the close on its
    // own: standing price gaps lose on US leagues (Kalshi is the sharp book
    // there) but can win on soccer and tennis, where Polymarket leads
    const keys = p => (p.by && p.by !== 'all' ? p.by.split('+') : []);
    const inside = (q, p) => keys(p).length > 0 && keys(q).length > keys(p).length && keys(p).every(k => keys(q).includes(k));
    const avoid = hits.find(p => p.verdict === 'avoid' && !hits.some(q => ['proven', 'promising'].includes(q.verdict) && inside(q, p)));
    if (avoid) return { avoid };
    // the best verdict any of its cuts has earned; the most specific cut wins ties
    const best = hits.filter(p => p.verdict !== 'avoid').reduce((a, p) => (!a || TIER[p.verdict] < TIER[a.verdict] || (TIER[p.verdict] === TIER[a.verdict] && (p.by || '').length > (a.by || '').length) ? p : a), null);
    return { verdict: best ? best.verdict : 'early', play: best && best.verdict !== 'early' ? best : null };
  };
}

// "proven: A grade · sports, +4.1% CLV over 34 bets"
function evidence(p) {
  if (!p) return null;
  const name = p.play === 'all' ? `every ${p.label} play` : `${p.label}: ${p.play}`;
  const stat = p.avgClv != null ? `${p.avgClv > 0 ? '+' : ''}${(p.avgClv * 100).toFixed(1)}% CLV` : p.roi != null ? `${p.roi > 0 ? '+' : ''}${(p.roi * 100).toFixed(1)}% ROI` : null;
  // a sportsbook group below its own book's 50 graded: say so with the real numbers
  if (p.provenNote) return `${p.provenNote} (${name})`;
  return `${p.verdict} (${name}${stat ? `, ${stat}` : ''} over ${p.n} bets)`;
}

// What a play type's record says so far, at any verdict, from its most
// specific cut with a graded bet: "record so far (Sports props: NFL): 3-2,
// +1.4% CLV over 5" or, with nothing graded, "not graded yet".
function recordIndex(plays = []) {
  const by = new Map();
  for (const p of plays) by.set(`${p.source}|${p.by || 'all'}|${p.play}`, p);
  const SOURCES = require('./results').SOURCES;
  return (source, labels) => {
    const def = SOURCES[source];
    const found = [];
    for (const cut of def ? def.cuts : []) {
      const vals = cut.map(k => labels[k]);
      if (vals.some(v => v == null || v === '')) continue;
      const p = by.get(`${source}|${cut.join('+')}|${vals.join(' · ')}`);
      if (p) found.push(p);
    }
    const p = found.sort((a, b) => b.by.split('+').length - a.by.split('+').length || b.n - a.n)[0] || by.get(`${source}|all|all`);
    if (!p || !(p.graded > 0 || p.clvN > 0)) return 'not graded yet';
    const name = p.play === 'all' ? p.label : `${p.label}: ${p.play}`;
    const parts = [];
    if (p.graded) parts.push(`${p.wins}-${p.losses}${p.units != null ? ` (${p.units > 0 ? '+' : ''}${p.units}u)` : ''}`);
    if (p.avgClv != null) parts.push(`${p.avgClv > 0 ? '+' : ''}${(p.avgClv * 100).toFixed(1)}% CLV over ${p.clvN}`);
    return `record so far (${name}): ${parts.join(', ')}`;
  };
}

// ¼ Kelly on a binary contract that costs c and wins with probability p
function kellyUnits(p, c, cap, o) {
  if (!(p > c && c > 0 && c < 1)) return 0;
  const f = (p - c) / (1 - c);
  return Math.min(cap, quarter(o.kellyFraction * f * o.bankrollUnits));
}

// Sharp Tail entries still worth following: sized, priced at a venue, recent,
// not started, and not since sold by the wallet that bought them. The venue's
// units decide: a signal's reason is about Polymarket's price, and Kalshi or
// a book can still size it (the server sizes every venue with the same caps).
function tailRows(signals, verdict, o, now) {
  const exits = new Map();
  for (const s of signals) if (s.type === 'exit') {
    const k = `${s.wallet}|${s.asset || s.conditionId}`;
    exits.set(k, Math.max(exits.get(k) || 0, ms(s.at) || 0));
  }
  const rows = [], dropped = [];
  for (const s of signals) {
    if (s.type !== 'entry' || s.locked || s.blocked) continue;
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
      track: { kind: 'tail', id: s.id },
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
      const pin = e.refSource === 'pinnacle';
      const labels = { sport: m.game, book: e.venue, market: e.kind, fair: pin ? 'vs Pinnacle' : 'vs exchanges' };
      const vd = verdict('esportsEdges', labels);
      if (vd.avoid) { dropped.push({ kind: 'esportsEdge', title: m.label, play: vd.avoid.play }); continue; }
      const cap = vd.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
      const units = kellyUnits(e.fair, e.cost, cap, o);
      if (!(units > 0)) continue;
      const why = [`fair price ${Math.round(e.fair * 100)}c ${pin ? "from Pinnacle's no-vig line" : 'from the other markets'}, ${Math.round(e.cost * 100)}c here after fees`];
      if (vd.play) why.push(evidence(vd.play));
      const mk = (m.markets || []).find(x => x.key === e.market);
      rows.push({
        id: `edge:${m.id}|${e.market}|${e.outcome}|${e.venue}`, kind: 'esportsEdge', label: `${m.game} match edge`, title: m.label || (m.teams || []).join(' vs '),
        bet: `${e.outcome}${mk?.label && e.kind !== 'match' ? ` (${mk.label})` : ''}`, venue: e.venue === 'kalshi' ? 'Kalshi' : e.venue === 'polymarket' ? 'Polymarket' : e.venue,
        price: e.cost, american: null, maxPrice: null, units, ev: r4(e.ev), verdict: vd.verdict, why,
        url: m.links?.[e.venue] || null, startsAt: m.start || null, at: null, warning: null,
      });
    }
    // limit bids inside a wide book: value if a seller comes down to them
    for (const b of m.bids || []) {
      if (!(b.cost > 0 && b.cost < 1) || b.fair == null || !(b.ev > 0)) continue;
      const venue = b.venue === 'kalshi' ? 'Kalshi' : b.venue === 'polymarket' ? 'Polymarket' : b.venue;
      const vd = verdict('esportsEdges', { sport: m.game, book: `${b.venue}-bid`, market: b.kind, fair: 'limit bid' });
      if (vd.avoid) { dropped.push({ kind: 'esportsEdge', title: m.label, play: vd.avoid.play }); continue; }
      const cap = vd.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
      const units = quarter(o.bidShare * kellyUnits(b.fair, b.cost, cap, o));
      if (!(units > 0)) continue;
      const mk = (m.markets || []).find(x => x.key === b.market);
      const why = [`fair ${Math.round(b.fair * 100)}c from the other markets; the book is ${Math.round(b.bid * 100)}/${Math.round(b.ask * 100)}c, so take has no edge but a ${Math.round(b.price * 100)}c bid does`,
        'cancel it at the start; it only counts once a seller fills it'];
      if (vd.play) why.push(evidence(vd.play));
      rows.push({
        id: `bid:${m.id}|${b.market}|${b.outcome}|${b.venue}`, kind: 'esportsEdge', label: `${m.game} limit bid`, title: m.label || (m.teams || []).join(' vs '),
        bet: `Bid ${Math.round(b.price * 100)}c on ${b.outcome}${mk?.label && b.kind !== 'match' ? ` (${mk.label})` : ''}`, venue,
        price: b.price, american: null, maxPrice: b.price, units, ev: r4(b.ev), verdict: vd.verdict, why,
        url: m.links?.[b.venue] || null, startsAt: m.start || null, at: null, warning: null,
      });
    }
  }
  return { rows, dropped };
}

// exchange value (xvalue.js): a Kalshi or Polymarket US ask under
// Polymarket's live mid, ¼ Kelly like an esports edge
const VALUE_VENUES = { kalshi: 'Kalshi', polymarketus: 'Polymarket US' };
// the results cut a value bet falls in: steam, or a standing gap to Polymarket or to Kalshi
const valueSignal = e => e.mover ? 'line mover' : e.steam ? 'steam' : e.ref?.venue === 'kalshi' ? 'Kalshi price' : 'price gap';
function valueRows(edges, verdict, o, now) {
  const rows = [], dropped = [];
  for (const e of edges) {
    const start = ms(e.start);
    if (start == null || start <= now || !(e.cost > 0 && e.cost < 1) || !(e.ev > 0 || (e.mover && e.ev >= 0))) continue;
    const labels = { signal: valueSignal(e), sport: e.league || e.category, book: e.venue, market: e.market };
    const vd = verdict('exchangeValue', labels);
    if (vd.avoid) { dropped.push({ kind: 'exchangeValue', title: e.title, play: vd.avoid.play }); continue; }
    // a line mover is priced near fair: it's a play only once its own record
    // beats the close, and that record's CLV is its edge
    let vdm = vd, p = e.fair;
    if (e.mover) {
      vdm = verdict('exchangeValue', labels, { only: ['signal'] });
      if (!['proven', 'promising'].includes(vdm.verdict) || !(vdm.play?.avgClv > 0)) continue;
      p = Math.max(e.fair, e.cost * (1 + vdm.play.avgClv));
    }
    const cap = vdm.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
    const units = kellyUnits(p, e.cost, cap, o);
    if (!(units > 0)) continue;
    const venue = VALUE_VENUES[e.venue] || e.venue;
    const ref = e.refName || 'Polymarket';
    const why = [`${ref}'s book has it at ${r2(e.fair * 100)}c, ${venue} sells it for ${r2(e.cost * 100)}c with the fee`];
    if (e.steam) why.unshift(`Steam: ${moveText(e.steam, venue, ref)}`);
    if (e.mover) why.unshift(`Line mover: ${moverText(e.mover)}`);
    if (vdm.play) why.push(evidence(vdm.play));
    rows.push({
      id: `value:${e.id}`, kind: 'exchangeValue', label: `${String(e.league || e.category || '').toUpperCase()} ${e.mover ? 'line mover' : e.steam ? 'steam' : 'exchange value'}`, title: e.title, steam: !!e.steam,
      bet: e.pick, venue, price: e.cost, american: null, maxPrice: null, units, ev: r4(p / e.cost - 1), verdict: vdm.verdict, why,
      url: e.url, startsAt: e.start, at: null, warning: null,
    });
  }
  return { rows, dropped };
}

// esports player props on the pick'em apps, 1u each as graded
function propRows(picks, verdict, o, now) {
  const rows = [], dropped = [];
  for (const p of picks) {
    // clvWarn: this kind of pick keeps losing the closing line (server.js)
    if (p.locked || !p.side || p.bestEv == null || p.bestEv / 100 < o.propMinEv || p.clvWarn) continue;
    const start = ms(p.startTime);
    if (start == null || start <= now) continue;
    const labels = { sport: sportKey(p.sport), stat: statKind(p.market), side: p.side };
    const vd = verdict('esportsPicks', labels);
    const title = `${p.player}${p.team ? ` (${p.team})` : ''}`;
    if (vd.avoid) { dropped.push({ kind: 'esportsProp', title, play: vd.avoid.play }); continue; }
    const book = p.bestBook === 'UD' ? 'Underdog' : p.bestBook === 'SL' ? 'Sleeper' : 'PrizePicks';
    const line = p.bestBook === 'UD' && p.udLine != null ? p.udLine : p.bestBook === 'SL' && p.sleeperLine != null ? p.sleeperLine : p.ppLine ?? p.udLine;
    const why = [`model ${p.modelPred} vs line ${line}, ${p.prob}% to hit`];
    // a line gap: the other books' numbers, so the bettor sees why and checks the line before playing
    const gapNames = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper' };
    if (p.lineGap) why.unshift(`line gap: ${p.lineGap.vs.map(v => `${gapNames[v.book] || v.book} has ${v.line}`).join(', ')}`);
    if (p.sampleSize) why.push(`${p.sampleSize} maps of history`);
    if (vd.play) why.push(evidence(vd.play));
    rows.push({
      id: `prop:${p.sport}|${p.player}|${p.market}`, kind: 'esportsProp', label: `${labels.sport} ${p.lineGap ? 'line gap' : 'prop'}`, title,
      bet: `${p.side === 'OVER' ? 'More' : 'Less'} than ${line} ${p.displayMarket || p.market}`, venue: book, price: null, american: null, maxPrice: null,
      units: 1, ev: r4(p.bestEv / 100), verdict: vd.verdict, why, url: null, startsAt: p.startTime, at: null, warning: null,
      // what MY BETS sends back to settle a logged bet from the pick tracker
      track: { kind: 'prop', sport: p.sport, player: p.player, market: p.market, line, side: p.side, startsAt: p.startTime },
    });
  }
  return { rows, dropped };
}

// sports props on the pick'em apps, priced off a sharp line by the EV screen
// (ev.js): Kalshi's player ladders, or sportsbooks when a key is set. 1u each.
const PROP_NAMES = {
  anytime_td: 'touchdowns', rush_rec_yds: 'rush + rec yards', rush_att: 'rush attempts', pass_comp: 'completions',
  pass_att: 'pass attempts', pass_ints: 'interceptions thrown', hits_allowed: 'hits allowed', hits_runs_rbis: 'hits + runs + RBIs',
  pra: 'pts + rebs + asts', pts_rebs: 'pts + rebs', pts_asts: 'pts + asts', rebs_asts: 'rebs + asts', stocks: 'steals + blocks',
  ftm: 'free throws made', rec_yds: 'receiving yards', rush_yds: 'rushing yards', pass_yds: 'passing yards', pass_tds: 'passing TDs',
  rbis: 'RBIs', shots_on_goal: 'shots on goal',
};
const propName = m => PROP_NAMES[m] || String(m || '').replace(/_/g, ' ');
function dfsBet(r) {
  if (r.market === 'anytime_td' && r.point === 0.5) return r.side === 'Over' ? 'Scores a touchdown' : 'No touchdown';
  return `${r.side === 'Over' ? 'More' : 'Less'} than ${r.point} ${propName(r.market)}`;
}
function dfsRows(rows, o, now, skip = new Set()) {
  const out = [];
  for (const r of rows) {
    if (!r.dfs || r.ev == null || r.ev / 100 < o.propMinEv) continue;
    // the PROPS board's play on the same leg carries the record: it goes in instead
    if (skip.has(sportPropKey(r.player, r.book, r.side, r.point))) continue;
    const start = ms(r.start);
    if (start == null || start <= now) continue;
    const book = r.book === 'underdog' ? 'Underdog' : r.book === 'prizepicks' ? 'PrizePicks' : r.book === 'sleeper' ? 'Sleeper' : r.book;
    const ref = (r.sharpBooks || []).map(b => (b === 'kalshi_props' ? 'Kalshi' : b)).join(', ') || 'consensus';
    out.push({
      id: `dfs:${r.group}|${r.side}|${r.book}`, kind: 'sportsProp', label: `${String(r.sport || '').toUpperCase()} prop`, title: r.player,
      bet: dfsBet(r), venue: book, price: null, american: null, maxPrice: null,
      units: 1, ev: r4(r.ev / 100), verdict: 'early', why: [`${ref} prices it at ${r.fairProb}% to hit`],
      url: null, startsAt: r.start, at: null, warning: null,
    });
  }
  return out;
}

// The PROPS board's flagged sports plays (sportprops.js): each pick'em book's
// line priced on Pinnacle's devigged prop, Kalshi's ladder and the other apps,
// the same plays the sports props record (sporttrack.js) follows and grades.
// 1u each, as graded. flagged: [{ row, play, kind }] with kind 'gap' or 'ev'.
// the PrizePicks entries a leg's fair clears, cheapest break-even first
const ppEntriesTxt = list => (!list?.length ? 'clears no entry'
  : list.length === sportPropsLib.PP_ENTRIES.length ? 'clears every PrizePicks entry' : `clears ${list.join(', ')}`);
const SOURCE_NAMES = { pinnacle: 'Pinnacle', kalshi: 'Kalshi', fanduel: 'FanDuel', betrivers: 'BetRivers', prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper' };
const sportPropKey = (player, book, side, line) => `${canonName(player)}|${book}|${side}|${Number(line)}`;
function boardPropRows(flagged, verdict, record, o, now) {
  const rows = [], dropped = [], seen = new Set();
  for (const { row, play: p, kind } of flagged) {
    if (!row || !p || !['sharp', 'gap', 'ev'].includes(kind) || !(p.ev / 100 >= o.propMinEv)) continue;
    const start = ms(row.startTime);
    if (start == null || start <= now) continue;
    const key = sportPropKey(row.player, p.book, p.side, p.line);
    if (seen.has(key)) continue;
    seen.add(key);
    const venue = SOURCE_NAMES[p.book] || bookName(p.book);
    const labels = { kind: kind === 'gap' ? 'line gap' : kind === 'sharp' ? 'sharp consensus' : 'sharp price', sport: row.sport, book: venue, stat: row.mkey };
    const vd = verdict('sportsProps', labels);
    const title = `${row.player}${row.team ? ` (${row.team})` : ''}`;
    if (vd.avoid) { dropped.push({ kind: 'sportsProp', title, play: vd.avoid.play }); continue; }
    // the sharp prices first: "Pinnacle 47% over 5.5, Underdog 6.5, Sleeper 6.5"
    const sharpSrc = x => ['pinnacle', 'kalshi', 'fanduel', 'betrivers'].includes(x.book);
    const src = [...(p.sources || [])].sort((a, b) => (b.book === 'pinnacle') - (a.book === 'pinnacle') || (b.book === 'kalshi') - (a.book === 'kalshi'))
      .map(x => (sharpSrc(x) ? `${SOURCE_NAMES[x.book]} ${x.p}% over ${x.line}` : `${SOURCE_NAMES[x.book] || x.book} ${x.line}`));
    const why = [`fair ${(p.fair * 100).toFixed(1)}% to hit from ${src.join(', ')}`];
    if (kind === 'sharp' && p.entry) why.push(`priced as a ${p.entry} leg; ${ppEntriesTxt(p.entries)}`);
    if (p.stale) why.push(`the books moved ${p.stale.pts} points our way while ${venue}'s line stood still`);
    if (kind === 'gap' && p.gap) why.unshift(`line gap: ${p.gap.vs.map(v => `${SOURCE_NAMES[v.book] || v.book} has ${v.line}`).join(', ')}`);
    why.push(vd.play ? evidence(vd.play) : record('sportsProps', labels));
    rows.push({
      id: `sprop:${sportPropId(row, p)}`, kind: 'sportsProp', label: `${String(row.sport || '').toUpperCase()} ${kind === 'gap' ? 'line gap' : kind === 'sharp' ? 'sharp consensus' : 'prop'}`, title,
      bet: dfsBet({ market: row.mkey, side: p.side, point: p.line }), venue, price: null, american: null, maxPrice: null,
      units: 1, ev: r4(p.ev / 100), verdict: vd.verdict, why, url: null, startsAt: row.startTime, at: null, warning: null,
    });
  }
  return { rows, dropped, keys: seen };
}

// sportsbook player props the EV screen prices above fair: FanDuel's and
// BetRivers' props against Pinnacle's devigged prop (freebooks.js), judged on
// the +EV screener's own record. Sized like a game line.
function bookPropRows(lines, verdict, record, o, now) {
  const rows = [], dropped = [];
  for (const r of lines) {
    if (r.dfs || !r.player || r.ev == null || r.ev / 100 < o.lineMinEv || r.ev / 100 > o.lineMaxEv) continue;
    if (!(r.decimal > 1) || !(r.fairProb > 0) || r.point == null) continue;
    const start = ms(r.start), seen = ms(r.updated);
    if (start == null || start <= now || seen == null || now - seen > o.lineMaxAgeMs) continue;
    if (r.source !== 'sharp' && !(r.books >= o.lineMinBooks)) continue;
    const labels = { sport: r.sport, book: r.book, market: r.market };
    const vd = verdict('ev', labels);
    if (vd.avoid) { dropped.push({ kind: 'bookProp', title: r.player, play: vd.avoid.play }); continue; }
    const cap = vd.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
    const units = kellyUnits(r.fairProb / 100, 1 / r.decimal, cap, o);
    if (!(units > 0)) continue;
    const ref = (r.sharpBooks || []).length ? r.sharpBooks.map(bookName).join(', ') : `${r.books} books`;
    const why = [`fair ${r.fairPrice > 0 ? '+' : ''}${r.fairPrice} (${r.fairProb}%) from ${ref}, ${bookName(r.book)} pays ${r.price > 0 ? '+' : ''}${r.price}`];
    why.push(vd.play ? evidence(vd.play) : record('ev', labels));
    rows.push({
      id: `bprop:${r.group}|${r.side}|${r.book}`, kind: 'bookProp', label: `${String(r.sport || '').toUpperCase()} player prop`, title: `${r.player}${r.event ? ` · ${r.event}` : ''}`,
      bet: dfsBet({ market: r.market, side: r.side, point: r.point }), venue: bookName(r.book), price: null, american: r.price, maxPrice: null,
      units, ev: r4(r.ev / 100), verdict: vd.verdict, why, url: null, startsAt: r.start, at: r.updated, warning: null,
    });
  }
  return { rows, dropped };
}

// sportsbook game lines the EV screen (ev.js) prices above fair, from the
// Odds API. Sized like an esports edge: ¼ Kelly, capped until proven.
const BOOK_NAMES = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars', betrivers: 'BetRivers',
  espnbet: 'ESPN Bet', fanatics: 'Fanatics', hardrockbet: 'Hard Rock', hard_rock_bet: 'Hard Rock', ballybet: 'Bally Bet', betparx: 'BetPARX',
  bovada: 'Bovada', betonlineag: 'BetOnline', lowvig: 'LowVig', mybookieag: 'MyBookie', betus: 'BetUS', betanysports: 'BetAnySports',
  prizepicks: 'PrizePicks', underdog: 'Underdog', sleeper: 'Sleeper',
  pinnacle: 'Pinnacle', novig: 'Novig', prophetx: 'ProphetX', kalshi: 'Kalshi', kalshi_mid: 'Kalshi', polymarket: 'Polymarket', fliff: 'Fliff', bet365: 'Bet365',
};
const bookName = k => BOOK_NAMES[k] || String(k || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const LINE_MARKETS = { h2h: 'moneyline', spreads: 'spread', totals: 'total' };
function lineRows(lines, verdict, o, now) {
  const rows = [], dropped = [];
  for (const r of lines) {
    if (r.dfs || r.player || r.ev == null || r.ev / 100 < o.lineMinEv || r.ev / 100 > o.lineMaxEv) continue;
    if (!(r.decimal > 1) || !(r.fairProb > 0)) continue;
    // two sharp sources (Pinnacle and Kalshi's mid) within a few points of each other
    if (o.lineNeedsAgree && !r.agree) continue;
    const start = ms(r.start), seen = ms(r.updated);
    if (start == null || start <= now || seen == null || now - seen > o.lineMaxAgeMs) continue;
    if (r.source !== 'sharp' && !(r.books >= o.lineMinBooks)) continue;
    const labels = { sport: r.sport, book: r.book, market: r.market };
    const vd = verdict('ev', labels);
    const title = r.event || r.group;
    if (vd.avoid) { dropped.push({ kind: 'bookLine', title, play: vd.avoid.play }); continue; }
    const cap = vd.verdict === 'proven' ? o.provenMaxUnits : o.edgeMaxUnits;
    const units = kellyUnits(r.fairProb / 100, 1 / r.decimal, cap, o);
    if (!(units > 0)) continue;
    const kind = LINE_MARKETS[r.market] || r.market;
    // a spread side already carries its points ("Bills -3.5"); a total's doesn't
    const point = r.market === 'totals' && r.point != null ? ` ${r.point}` : '';
    const ref = (r.sharpBooks || []).length ? r.sharpBooks.map(bookName).join(', ') : `${r.books} books`;
    const why = [`fair ${r.fairPrice > 0 ? '+' : ''}${r.fairPrice} (${r.fairProb}%) from ${ref}, ${bookName(r.book)} pays ${r.price > 0 ? '+' : ''}${r.price}`];
    if (vd.play) why.push(evidence(vd.play));
    rows.push({
      id: `line:${r.group}|${r.side}|${r.book}`, kind: 'bookLine', label: `${String(r.sport || '').toUpperCase()} ${kind}`, title,
      bet: `${r.side}${point}`, venue: bookName(r.book), price: null, american: r.price, maxPrice: null,
      units, ev: r4(r.ev / 100), verdict: vd.verdict, why, url: null, startsAt: r.start, at: r.updated, warning: null,
    });
  }
  return { rows, dropped };
}

// exchange arbs (xarb.js) and esports match arbs: both sides for under $1.
// Units don't apply: the stake splits across the legs.
const VENUE_NAMES = { kalshi: 'Kalshi', polymarket: 'Polymarket', polymarketus: 'Polymarket US', novig: 'Novig', prophetx: 'ProphetX' };
const venueName = l => l.venueTitle || VENUE_NAMES[l.venue] || l.venue;

function arbRows(arbs, esportsArbs, o) {
  const rows = [];
  for (const a of arbs) {
    if (a.locked || !(a.profitPct > 0) || !(a.legs || []).length || a.legs.length > o.arbMaxLegs) continue;
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

// exchange middles (xarb.findMiddles): two lines on two exchanges, one leg
// always pays, both inside the window. Half a unit until the middles record
// proves out (a whole one then), from middleMinEv up; a losing record drops them.
function middleRows(middles, verdict, o, now) {
  const rows = [], dropped = [];
  for (const m of middles) {
    const start = ms(m.startTime);
    if (start == null || start <= now || !(m.evPct >= o.middleMinEvPct) || (m.legs || []).length !== 2) continue;
    const vd = verdict('middles', { league: m.league, kind: m.kind });
    if (vd.avoid) { dropped.push({ kind: 'middle', title: m.title, play: vd.avoid.play }); continue; }
    const lo = Math.floor(m.low) + 1, hi = Math.ceil(m.high) - 1;
    const what = m.kind === 'total' ? 'the total' : m.subject || 'the margin';
    const why = [`both pay if ${what} lands ${lo === hi ? lo : `${lo} to ${hi}`} (about ${Math.round(m.hitProb * 100)}%), a miss costs ${Math.abs(m.missPct)}%`];
    if (vd.play) why.push(evidence(vd.play));
    rows.push({
      id: `middle:${m.id}`, kind: 'middle', label: `${String(m.league || '').toUpperCase()} middle`, title: m.title,
      bet: m.legs.map(l => `${venueName(l)}: ${l.pick}`).join(' + '), venue: [...new Set(m.legs.map(venueName))].join(' + '),
      price: m.totalCost ?? null, american: null, maxPrice: null, units: vd.verdict === 'proven' ? 1 : 0.5, ev: r4(m.evPct / 100), verdict: vd.verdict, why,
      url: m.legs[0]?.url || null, startsAt: m.startTime, at: null, warning: null, legs: m.legs,
    });
  }
  return { rows, dropped };
}

// The best Underdog entry from today's esports prop plays. A pick'em leg is
// never bet alone: the bet is the entry, and its EV depends on the payout table
// and on legs from one series moving together (slip.js prices both). Only
// legs at Underdog's standard price go in, since a boosted or discounted leg
// changes the payout the standard tables assume. ¼ Kelly on the entry's own
// payout distribution, 1u = 1% of bankroll, capped like an unproven edge.
const UD_TABLES = (() => {
  const { PAYOUTS } = require('./slip');
  return { underdog_standard: PAYOUTS.underdog_standard, underdog_flex: PAYOUTS.underdog_flex };
})();
function entryRows(picks, propRowIds, o, now) {
  const { bestSlips } = require('./slip');
  const pool = [];
  for (const p of picks) {
    if (!propRowIds.has(`prop:${p.sport}|${p.player}|${p.market}`) || !p.pricing || p.bestBook !== 'UD') continue;
    if (p.udMultiplier != null && Math.abs(p.udMultiplier - 1) > 1e-6) continue;
    pool.push({
      player: p.player, team: p.team, gameId: p.gameId, sport: p.sport, market: p.displayMarket || p.market,
      side: p.side, line: p.pricing.line, prob: p.prob / 100, ev: p.bestEv, startTime: p.startTime,
      meanPerMap: p.pricing.meanPerMap, k: p.pricing.k, stat: p.pricing.stat, scenarios: p.pricing.scenarios, shift: p.pricing.shift || 0,
    });
  }
  if (pool.length < 2) return [];
  const slips = bestSlips(pool.slice(0, 30), { maxLegs: o.entryMaxLegs, payouts: UD_TABLES }).filter(sl => sl.ev / 100 >= o.entryMinEv);
  if (!slips.length) return [];
  const best = slips[0];
  const legs = best.picks;
  const starts = legs.map(l => ms(l.startTime)).filter(x => x != null && x > now);
  const units = Math.min(o.edgeMaxUnits, Math.max(0.25, quarter(o.kellyFraction * best.kelly * o.bankrollUnits)));
  const table = best.table === 'underdog_flex' ? 'Flex' : 'Standard';
  return [{
    id: `entry:${legs.map(l => `${l.player}|${l.market}`).sort().join('+')}`, kind: 'esportsProp', label: `Underdog ${legs.length}-pick ${table}`,
    title: legs.map(l => l.player).join(' + '),
    bet: legs.map(l => `${l.player} ${l.side === 'OVER' ? 'More' : 'Less'} ${l.line} ${l.market}`).join(' · '),
    venue: 'Underdog', price: null, american: null, maxPrice: null,
    units, ev: r4(best.ev / 100), verdict: 'early',
    why: [`all ${legs.length} hit ${(best.probAll * 100).toFixed(1)}% of the time${best.correlated ? ', counting legs from the same series moving together' : ''}`,
      `${table} payout table, each leg on its own row below`],
    url: null, startsAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null, at: null, warning: null,
  }];
}

// { signals, matches, picks, arbs, plays } → { rows (ranked), dropped, counts }
function bestPlays({ signals = [], matches = [], picks = [], props = [], sportProps = [], lines = [], arbs = [], value = [], middles = [], plays = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const verdict = verdictIndex(plays), record = recordIndex(plays);
  const esArbs = [];
  for (const m of matches) {
    const start = ms(m.start);
    if (m.live || (start != null && start <= now)) continue;
    for (const a of m.arbs || []) esArbs.push({ match: m, arb: a });
  }
  const board = boardPropRows(sportProps, verdict, record, o, now);
  const parts = [tailRows(signals, verdict, o, now), edgeRows(matches, verdict, o, now), propRows(picks, verdict, o, now), lineRows(lines, verdict, o, now), valueRows(value, verdict, o, now), middleRows(middles, verdict, o, now),
    board, bookPropRows(lines, verdict, record, o, now)];
  const propIds = new Set(parts[2].rows.map(r => r.id));
  const rows = [...parts.flatMap(p => p.rows), ...entryRows(picks, propIds, o, now), ...dfsRows(props, o, now, board.keys), ...arbRows(arbs, esArbs, o)];
  const tier = r => (r.verdict === 'arb' ? 0 : TIER[r.verdict] ?? 2);
  rows.sort((a, b) => tier(a) - tier(b) || (b.ev ?? -1) - (a.ev ?? -1));
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { rows: rows.slice(0, o.limit), total: rows.length, counts, dropped: parts.flatMap(p => p.dropped) };
}

module.exports = { bestPlays, verdictIndex, recordIndex, valueSignal, kellyUnits, DEFAULTS };
