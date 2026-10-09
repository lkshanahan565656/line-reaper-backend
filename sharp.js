// ─── SHARP MONEY TRACKER ──────────────────────────────────────────────────────
// Watches every odds snapshot (one per poll, ~30s per sport) and turns price
// changes into the signals a sharp bettor actually acts on:
//
//   move        one book moved one side by ≥ minMoveProb of implied probability
//   steam       ≥ steamMinBooks books moved the same side the same way inside
//               steamWindowMs: coordinated money hitting the market
//   sharp_lead  a sharp book moved and ≥ 2 soft books that price the market
//               haven't. Their old number is the bet; stale(now) lists the
//               leads that are still open until the soft books catch up
//   rlm         (reverseLineMoves) the public holds ≥ 60% of bets on a side but
//               the price moved against it; big_money when handle% outruns
//               ticket% on a side
//
// Moves are measured in implied probability so -110 → -130 and +300 → +250 are
// on one scale. A spread/total point change is converted at 2.5 probability
// points per half point. Sign convention everywhere: deltaProb > 0 means that
// side got more likely / more expensive, i.e. money came in on it.
//
// Pure helpers plus one stateful tracker; the server feeds it what it already
// polls, so it costs no extra API credits.

const DEFAULTS = {
  sharpBooks: ['pinnacle', 'circa', 'novig', 'prophetx', 'betfair_ex_eu', 'sporttrade', 'lowvig', 'betonlineag'],
  steamWindowMs: 3 * 60e3,
  steamMinBooks: 3,
  minMoveProb: 0.02,
  staleWindowMs: 5 * 60e3,
  minStaleBooks: 2,
  maxEvents: 500,
  historyMs: 6 * 3600e3,
};
const MARKETS = new Set(['h2h', 'spreads', 'totals']);
const POINT_PROB = 0.05;   // per full point: each half point ≈ 2.5 probability points
const EPS = 1e-9;          // 0.02 thresholds must survive float noise

// ── odds math ──
function impliedProb(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || Math.abs(a) < 100) return null;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

// Side identity: the point is part of the observation, not the side, so a
// spread moving -3 → -3.5 is a move on "Celtics", not a new market.
function sideKey(market, outcome) {
  const name = String(outcome?.name ?? '');
  if (market === 'totals') return /^o/i.test(name) ? 'Over' : /^u/i.test(name) ? 'Under' : name;
  return name;
}

// Signed probability change of one side between two observations {price, point}.
function moveDelta(market, side, from, to) {
  const pf = impliedProb(from.price), pt = impliedProb(to.price);
  if (pf == null || pt == null) return 0;
  let pts = 0;
  if (market !== 'h2h' && from.point != null && to.point != null) {
    const d = to.point - from.point;
    // laying more points or getting fewer is worse for a spread side or an
    // Under; a higher total is worse for the Over
    pts = (market === 'totals' && side === 'Over' ? d : -d) * POINT_PROB;
  }
  return pt - pf + pts;
}

const gameLabel = g => `${g.away_team} @ ${g.home_team}`;
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;
const iso = ms => new Date(ms).toISOString();

// ── tracker ──
function createSharpTracker(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sharp = new Set(o.sharpBooks.map(b => String(b).toLowerCase()));
  const series = new Map();     // gid|market|side|book → { anchor, last, hist, ... }
  const bySide = new Map();     // gid|market|side → Set of series keys
  const games = new Map();      // gid → { sport, game, start, startMs }
  const buckets = new Map();    // gid|market|side → recent up-moves [{ book, at, delta, isSharp }]
  const steamFired = new Map(); // gid|market|side → at
  const lastUp = new Map();     // series key → at of its last up-move
  const leads = [];             // open sharp leads
  const log = [];
  const lastIngest = {};
  let seq = 0;

  const base = (kind, now, gid, market, side) => {
    const g = games.get(gid);
    return { kind, id: `${kind}-${now}-${++seq}`, at: iso(now), ts: now, sport: g.sport, game: g.game, gameId: gid, start: g.start, market, side };
  };
  const obsOut = x => ({ price: x.price, point: x.point });

  function dropSeries(k) {
    const s = series.get(k);
    if (!s) return;
    series.delete(k);
    lastUp.delete(k);
    const set = bySide.get(s.sideKey);
    if (set) { set.delete(k); if (!set.size) bySide.delete(s.sideKey); }
  }

  function prune(now) {
    for (const [gid, g] of games) {
      if (g.startMs != null && g.startMs <= now) {
        for (const [k, s] of series) if (s.gameId === gid) dropSeries(k);
        games.delete(gid);
      }
    }
    const cut = now - o.historyMs;
    for (const [k, s] of series) {
      if (s.last.at < cut) { dropSeries(k); continue; }
      // keep the latest observation even if it's old, so the next poll has a base
      while (s.hist.length > 1 && s.hist[0].at < cut) s.hist.shift();
    }
    for (const [k, list] of buckets) {
      const keep = list.filter(m => now - m.at <= o.steamWindowMs && games.has(m.gameId));
      if (keep.length) buckets.set(k, keep); else buckets.delete(k);
    }
    for (const [k, t] of steamFired) if (now - t >= o.steamWindowMs) steamFired.delete(k);
    for (const [k, t] of lastUp) if (now - t > Math.max(o.steamWindowMs, o.staleWindowMs)) lastUp.delete(k);
    settleLeads(now);
  }

  // A soft book has caught up once it moved half a threshold toward the sharp
  // side since the lead opened; a lead dies when every soft book has, when it
  // expires, or when the sharp book walks its move back.
  function settleLeads(now) {
    for (let i = leads.length - 1; i >= 0; i--) {
      const L = leads[i], e = L.event;
      const sharpS = series.get(L.sharpKey);
      let open = now < L.expires && games.has(e.gameId) && sharpS;
      if (open && moveDelta(e.market, e.side, e.from, sharpS.last) < o.minMoveProb / 2 - EPS) open = false;
      if (open) {
        for (const [book, then] of L.stale) {
          const s = series.get(L.softKeys.get(book));
          if (!s || moveDelta(e.market, e.side, then, s.last) >= o.minMoveProb / 2 - EPS) L.stale.delete(book);
        }
        if (!L.stale.size) open = false;
      }
      if (!open) leads.splice(i, 1);
    }
  }

  function ingest(sport, snapshot, now = Date.now()) {
    const fresh = [];
    const touched = new Set();
    for (const g of snapshot || []) {
      const startMs = g.commence_time ? Date.parse(g.commence_time) : NaN;
      if (Number.isFinite(startMs) && startMs <= now) continue;   // live prices aren't sharp signals
      const gid = String(g.id ?? gameLabel(g));
      games.set(gid, { sport, game: gameLabel(g), start: g.commence_time || null, startMs: Number.isFinite(startMs) ? startMs : null });
      for (const bm of g.bookmakers || []) {
        const book = String(bm.key || bm.title || '').toLowerCase();
        if (!book) continue;
        const seen = new Set();
        for (const m of bm.markets || []) {
          if (!MARKETS.has(m.key)) continue;
          for (const oc of m.outcomes || []) {
            if (impliedProb(oc.price) == null) continue;
            if (m.key !== 'h2h' && oc.point == null) continue;
            const side = sideKey(m.key, oc);
            const sk = `${gid}|${m.key}|${side}`;
            const k = `${sk}|${book}`;
            if (seen.has(k)) continue;   // alt lines in one market: first one is the main line
            seen.add(k);
            const obs = { at: now, price: Number(oc.price), point: m.key === 'h2h' ? null : Number(oc.point) };
            const s = series.get(k);
            if (!s) {
              series.set(k, { key: k, sideKey: sk, gameId: gid, market: m.key, side, book, isSharp: sharp.has(book), anchor: obs, last: obs, hist: [obs] });
              if (!bySide.has(sk)) bySide.set(sk, new Set());
              bySide.get(sk).add(k);
              continue;
            }
            if (obs.price !== s.last.price || obs.point !== s.last.point) s.hist.push(obs);
            s.last = obs;
            // measured from the last reported move, not the last poll, so a line
            // that creeps a cent at a time still gets reported once it adds up
            const d = moveDelta(m.key, side, s.anchor, obs);
            if (Math.abs(d) < o.minMoveProb - EPS) continue;
            fresh.push({ ...base('move', now, gid, m.key, side), book, isSharp: s.isSharp, from: obsOut(s.anchor), to: obsOut(obs), deltaProb: round(d) });
            s.anchor = obs;
            // only the side money came in on drives steam/leads; the other side's
            // drop is the same information mirrored
            if (d > 0) {
              lastUp.set(k, now);
              if (!buckets.has(sk)) buckets.set(sk, []);
              buckets.get(sk).push({ book, at: now, delta: d, isSharp: s.isSharp, gameId: gid });
              touched.add(sk);
            }
          }
        }
      }
    }

    settleLeads(now);   // before new leads, so this tick's soft moves can close old ones

    const out = [...fresh];
    for (const sk of touched) {
      const list = buckets.get(sk).filter(m => now - m.at <= o.steamWindowMs);
      buckets.set(sk, list);
      const per = new Map();
      for (const m of list) per.set(m.book, (per.get(m.book) || 0) + m.delta);
      if (per.size < o.steamMinBooks) continue;
      const fired = steamFired.get(sk);
      if (fired != null && now - fired < o.steamWindowMs) continue;
      steamFired.set(sk, now);
      buckets.delete(sk);   // consume: the next steam needs a fresh set of books
      const [gid, market, side] = splitSide(sk);
      const books = [...per.keys()];
      out.push({
        ...base('steam', now, gid, market, side), direction: 'up', books,
        sharpCount: books.filter(b => sharp.has(b)).length, isSharp: books.some(b => sharp.has(b)),
        leader: list[0].book, deltaProb: round([...per.values()].reduce((a, b) => a + b, 0) / per.size), windowMs: o.steamWindowMs,
      });
    }

    for (const mv of fresh) {
      if (!mv.isSharp || mv.deltaProb <= 0) continue;
      const sk = `${mv.gameId}|${mv.market}|${mv.side}`;
      const stale = new Map(), softKeys = new Map();
      for (const k of bySide.get(sk) || []) {
        const s = series.get(k);
        if (s.isSharp || now - s.last.at > o.staleWindowMs) continue;   // not quoting any more
        const up = lastUp.get(k);
        if (up != null && now - up <= o.staleWindowMs) continue;        // already moved: not stale
        stale.set(s.book, s.last);
        softKeys.set(s.book, k);
      }
      if (stale.size < o.minStaleBooks) continue;
      // a newer move by the same sharp book supersedes its older lead
      for (let i = leads.length - 1; i >= 0; i--) if (leads[i].sharpKey === `${sk}|${mv.book}`) leads.splice(i, 1);
      const ev = {
        ...base('sharp_lead', now, mv.gameId, mv.market, mv.side), book: mv.book, isSharp: true,
        from: mv.from, to: mv.to, deltaProb: mv.deltaProb,
        staleBooks: [...stale].map(([book, x]) => ({ book, ...obsOut(x) })), expiresAt: iso(now + o.staleWindowMs),
      };
      leads.push({ event: ev, sharpKey: `${sk}|${mv.book}`, stale, softKeys, expires: now + o.staleWindowMs });
      out.push(ev);
    }

    prune(now);
    lastIngest[sport] = iso(now);
    log.unshift(...out);
    if (log.length > o.maxEvents) log.length = o.maxEvents;
    return out;
  }

  function events({ sport, kind, sinceMs, limit = 100 } = {}) {
    const kinds = kind == null ? null : new Set([].concat(kind));
    const res = [];
    for (const e of log) {
      if (res.length >= limit) break;
      if (sport && e.sport !== sport) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      if (sinceMs != null && e.ts < sinceMs) continue;
      res.push(e);
    }
    return res;
  }

  function stale(now = Date.now()) {
    settleLeads(now);
    return leads.map(L => ({
      ...L.event,
      staleBooks: [...L.stale.keys()].map(book => ({ book, ...obsOut(series.get(L.softKeys.get(book)).last) })),
      ageMs: now - L.event.ts,
    })).sort((a, b) => b.ts - a.ts);
  }

  function state() {
    const byKind = {};
    for (const e of log) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return { games: games.size, series: series.size, events: log.length, byKind, openLeads: leads.length, lastIngest: { ...lastIngest } };
  }

  return { ingest, events, stale, state };
}
// gid may itself contain '|', so split from the right
function splitSide(sk) {
  const parts = sk.split('|');
  const side = parts.pop(), market = parts.pop();
  return [parts.join('|'), market, side];
}

// ── reverse line movement ──
const MARKET_NAMES = { h2h: 'h2h', ml: 'h2h', moneyline: 'h2h', spread: 'spreads', spreads: 'spreads', ats: 'spreads', total: 'totals', totals: 'totals', ou: 'totals' };
const pick = (obj, keys) => { for (const k of keys) if (obj?.[k] != null && Number.isFinite(Number(obj[k]))) return Number(obj[k]); return null; };

// Splits feeds disagree on names and on 0–1 vs 0–100; normalize to percents.
function normSplit(x) {
  let bets = pick(x, ['betsPct', 'betPct', 'bets', 'tickets', 'ticketsPct', 'ticketPct']);
  let money = pick(x, ['moneyPct', 'money', 'handle', 'handlePct']);
  if ((bets == null || bets <= 1) && (money == null || money <= 1) && (bets != null || money != null)) {
    bets = bets == null ? null : bets * 100;
    money = money == null ? null : money * 100;
  }
  return { betsPct: bets, moneyPct: money };
}

// events: tracker move events; splits: { 'Away @ Home': { market: { side: {betsPct, moneyPct} } } }
function reverseLineMoves(events, splits, { minBetsPct = 60, minDivergence = 15, minMoveProb = 0.01 } = {}) {
  // net move per side: average across books of each book's summed delta;
  // sharp books alone when any moved, since they're the number that matters
  const per = new Map();
  for (const e of events || []) {
    if (e.kind !== 'move') continue;
    const k = `${e.game}|${e.market}|${e.side}`;
    if (!per.has(k)) per.set(k, { sharp: new Map(), all: new Map() });
    const p = per.get(k);
    p.all.set(e.book, (p.all.get(e.book) || 0) + e.deltaProb);
    if (e.isSharp) p.sharp.set(e.book, (p.sharp.get(e.book) || 0) + e.deltaProb);
  }
  const net = k => {
    const p = per.get(k);
    if (!p) return null;
    const m = p.sharp.size ? p.sharp : p.all;
    return [...m.values()].reduce((a, b) => a + b, 0) / m.size;
  };

  const out = [];
  for (const [game, markets] of Object.entries(splits || {})) {
    for (const [mkey, sides] of Object.entries(markets || {})) {
      const market = MARKET_NAMES[String(mkey).toLowerCase()] || mkey;
      for (const [rawSide, x] of Object.entries(sides || {})) {
        const side = market === 'totals' ? sideKey('totals', { name: rawSide }) : rawSide;
        const { betsPct, moneyPct } = normSplit(x);
        const d = net(`${game}|${market}|${side}`);
        if (betsPct != null && betsPct >= minBetsPct && d != null && d <= -minMoveProb + EPS) {
          out.push({ kind: 'rlm', game, market, side, betsPct, moneyPct, deltaProb: round(d) });
        }
        if (betsPct != null && moneyPct != null && moneyPct - betsPct >= minDivergence) {
          out.push({ kind: 'big_money', game, market, side, betsPct, moneyPct, ...(d != null ? { deltaProb: round(d) } : {}) });
        }
      }
    }
  }
  return out;
}

// ── plain English ──
const BOOK_NAMES = {
  pinnacle: 'Pinnacle', circa: 'Circa', novig: 'Novig', prophetx: 'ProphetX', betfair_ex_eu: 'Betfair', betfair_ex_uk: 'Betfair',
  sporttrade: 'Sporttrade', lowvig: 'LowVig', betonlineag: 'BetOnline', draftkings: 'DraftKings', fanduel: 'FanDuel',
  betmgm: 'BetMGM', caesars: 'Caesars', williamhill_us: 'Caesars', betrivers: 'BetRivers', espnbet: 'ESPN BET',
  fanatics: 'Fanatics', hardrockbet: 'Hard Rock', bovada: 'Bovada', mybookieag: 'MyBookie', bet365: 'bet365', ballybet: 'Bally Bet',
};
const bookName = b => BOOK_NAMES[b] || String(b || '').replace(/(^|_)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
const fmtPrice = p => (p > 0 ? `+${p}` : `${p}`);
const fmtPoint = p => (p > 0 ? `+${p}` : `${p}`);
const fmtPts = d => `${Math.abs(d * 100).toFixed(1)} pts`;
const sideLabel = (market, side, point) =>
  market === 'h2h' ? `${side} ML` : market === 'totals' ? `${side} ${point ?? ''}`.trim() : point == null ? side : `${side} ${fmtPoint(point)}`;
const quote = (market, x) => (market === 'h2h' || x.point == null ? fmtPrice(x.price) : `${market === 'totals' ? x.point : fmtPoint(x.point)} ${fmtPrice(x.price)}`);

function describeSharp(e) {
  const pt = e.to?.point;
  if (e.kind === 'move') {
    return `MOVE: ${bookName(e.book)}${e.isSharp ? ' (sharp)' : ''} ${sideLabel(e.market, e.side)} ${quote(e.market, e.from)} → ${quote(e.market, e.to)} (${e.deltaProb > 0 ? '+' : '-'}${fmtPts(e.deltaProb)})`;
  }
  if (e.kind === 'steam') {
    return `STEAM: ${sideLabel(e.market, e.side)} moved ${fmtPts(e.deltaProb)} at ${e.books.length} books (${bookName(e.leader)} first)`;
  }
  if (e.kind === 'sharp_lead') {
    const stale = e.staleBooks || [];
    // show the soft book's point only when it differs from the sharp number
    const q = s => (e.market !== 'h2h' && s.point != null && s.point !== pt ? quote(e.market, s) : fmtPrice(s.price));
    const same = stale.every(s => q(s) === q(stale[0]));
    const tail = !stale.length ? 'soft books caught up'
      : same ? `${stale.map(s => bookName(s.book)).join(', ')} still at ${q(stale[0])}`
        : `still at ${stale.map(s => `${bookName(s.book)} ${q(s)}`).join(', ')}`;
    return `SHARP LEAD: ${bookName(e.book)} moved ${sideLabel(e.market, e.side, pt)}; ${tail}`;
  }
  if (e.kind === 'rlm') {
    return `RLM: ${Math.round(e.betsPct)}% of bets on ${sideLabel(e.market, e.side)} but the line moved ${fmtPts(e.deltaProb)} against it (${e.game})`;
  }
  if (e.kind === 'big_money') {
    return `BIG MONEY: ${sideLabel(e.market, e.side)} has ${Math.round(e.moneyPct)}% of the money on ${Math.round(e.betsPct)}% of bets (${e.game})`;
  }
  return `${String(e.kind || 'event').toUpperCase()}: ${e.game || ''} ${e.side || ''}`.trim();
}

module.exports = { createSharpTracker, impliedProb, sideKey, moveDelta, reverseLineMoves, describeSharp, bookName, DEFAULTS };
