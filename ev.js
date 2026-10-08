// ─── +EV SCREENER ─────────────────────────────────────────────────────────────
// Finds prices that beat the sharp market. For every market (moneyline, spread
// at a given number, total at a given number, player prop at a given line) we:
//
//   1. take each sharp book that prices every side, and remove its vig
//      (power method by default: it shades longshots the way real books do),
//   2. average those no-vig probabilities (weighted by how sharp the book is)
//      into a fair price,
//   3. score every book's price against it: EV = fair prob × decimal odds − 1.
//
// With no sharp book on a market we fall back to the devigged median of all
// books (needs MIN_CONSENSUS_BOOKS) and label the row "consensus", which is
// weaker evidence. DFS apps (PrizePicks, Underdog) have no per-side price, so
// their legs are scored against the same fair probability at the same line.
//
// Pure functions only. The server feeds it whatever odds it already caches, so
// the screener costs no extra Odds API credits.

const SHARP_WEIGHTS = {
  pinnacle: 1, circa: 1, ps3838: 1,
  novig: 0.7, prophetx: 0.7, sporttrade: 0.7, betfair_ex_eu: 0.7, betfair_ex_uk: 0.7, matchbook: 0.6,
  lowvig: 0.4, betonlineag: 0.4,
};
const DFS_BOOKS = new Set(['prizepicks', 'underdog', 'sleeper', 'pick6', 'betr', 'parlayplay']);
const MIN_CONSENSUS_BOOKS = 4;

// ── odds math ──
function americanToDecimal(a) {
  a = Number(a);
  if (!Number.isFinite(a) || a === 0 || Math.abs(a) < 100) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}
function decimalToAmerican(d) {
  if (!(d > 1)) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
const probToAmerican = p => (p > 0 && p < 1 ? decimalToAmerican(1 / p) : null);

// No-vig probabilities from a full set of decimal prices.
function devig(decimals, method = 'power') {
  const imp = decimals.map(d => 1 / d);
  const sum = imp.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  if (method === 'multiplicative' || sum <= 1) return imp.map(p => p / sum);
  // power: find k with Σ p_i^k = 1 (k > 1 when there is vig)
  let lo = 1, hi = 20;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    const s = imp.reduce((a, p) => a + p ** k, 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const out = imp.map(p => p ** k);
  const t = out.reduce((a, b) => a + b, 0);
  return out.map(p => p / t);
}

// ── market names ──
// Odds API keys, Owls categories and DFS stat labels all name the same props
// differently. Everything is reduced to one canonical key.
const MARKET_ALIASES = [
  [/^(player_)?points?_rebounds?_assists?$|^pts_?rebs_?asts$|^pra$|^pts\+rebs\+asts$|^points \+ rebounds \+ assists$/, 'pra'],
  [/^(player_)?points?_rebounds?$|^pts_?rebs$|^pts\+rebs$|^points \+ rebounds$/, 'pts_rebs'],
  [/^(player_)?points?_assists?$|^pts_?asts$|^pts\+asts$|^points \+ assists$/, 'pts_asts'],
  [/^(player_)?rebounds?_assists?$|^rebs_?asts$|^rebs\+asts$|^rebounds \+ assists$/, 'rebs_asts'],
  [/^(player_)?threes?(_made)?$|^3-?pt(s)? made$|^3-pointers made$|^3pm$/, 'threes'],
  [/^(player_)?points?$|^pts$/, 'points'],
  [/^(player_)?rebounds?$|^rebs$/, 'rebounds'],
  [/^(player_)?assists?$|^asts$/, 'assists'],
  [/^(player_)?steals?$/, 'steals'],
  [/^(player_)?blocks?$|^(player_)?blocked[_ ]shots$/, 'blocks'],
  [/^(player_)?shots_on_goal$|^shots on goal$|^sog$/, 'shots_on_goal'],
  [/^(player_)?goals$/, 'goals'],
  [/^batter_hits$|^hits$/, 'hits'],
  [/^batter_total_bases$|^total bases$/, 'total_bases'],
  [/^batter_home_runs$|^home runs$/, 'home_runs'],
  [/^batter_rbis$|^rbis?$/, 'rbis'],
  [/^batter_runs_scored$|^runs$/, 'runs'],
  [/^batter_stolen_bases$|^stolen bases$/, 'stolen_bases'],
  [/^pitcher_strikeouts$|^pitcher strikeouts$|^strikeouts$/, 'strikeouts'],
  [/^pitcher_outs$|^pitching outs$|^pitcher outs$/, 'pitcher_outs'],
  [/^player_pass_yds$|^pass(ing)? yards$/, 'pass_yds'],
  [/^player_pass_tds$|^pass(ing)? tds$|^passing touchdowns$/, 'pass_tds'],
  [/^player_rush_yds$|^rush(ing)? yards$/, 'rush_yds'],
  [/^player_reception_yds$|^receiving yards$|^rec yards$/, 'rec_yds'],
  [/^player_receptions$|^receptions$/, 'receptions'],
];
function canonMarket(m) {
  const s = String(m || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [re, key] of MARKET_ALIASES) if (re.test(s)) return key;
  return s.replace(/\s+/g, '_');
}
const canonName = n => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

// ── normalize feeds into quotes ──
// quote: { group, eventId, sport, event, start, market, player, point, side, book, price }
function quotesFromGames(games, { sport } = {}) {
  const out = [];
  for (const g of games || []) {
    // keyed by teams and day, not feed id, so Owls and the Odds API merge into one market
    const day = g.commence_time ? String(g.commence_time).slice(0, 10) : '';
    const eventId = g.home_team ? `${canonName(g.away_team)}@${canonName(g.home_team)}|${day}` : g.id;
    const base = { eventId, sport: sport || g.sport_key || g.sport || '', event: `${g.away_team} @ ${g.home_team}`, start: g.commence_time || null };
    // Odds API / Owls game-line shape
    for (const bm of g.bookmakers || []) {
      const book = String(bm.key || bm.title || '').toLowerCase();
      for (const m of bm.markets || []) {
        const key = m.key;
        for (const o of m.outcomes || []) {
          if (o.price == null) continue;
          let group, side, point = o.point ?? null, player = null, market = key;
          if (key === 'h2h') { group = `${eventId}|h2h`; side = o.name; }
          else if (key === 'spreads') {
            if (point == null) continue;
            const homePt = o.name === g.home_team ? point : -point;
            group = `${eventId}|spreads|${homePt}`; side = `${o.name} ${point > 0 ? '+' : ''}${point}`;
          } else if (key === 'totals') {
            if (point == null) continue;
            group = `${eventId}|totals|${point}`; side = o.name;
          } else if (o.description && /^(over|under)$/i.test(o.name) && point != null) {
            player = o.description; market = canonMarket(key);
            group = `${eventId}|${market}|${canonName(player)}|${point}`; side = cap(o.name);
          } else continue;
          out.push({ ...base, group, market, player, point, side, book, price: Number(o.price) });
        }
      }
    }
    // Odds API props cache / Owls props shape: books[].props[]
    for (const bk of g.books || []) {
      const book = String(bk.key || bk.title || bk.name || '').toLowerCase();
      for (const p of bk.props || bk.player_props || []) {
        const player = p.player || p.playerName || p.player_name || p.name;
        const market = canonMarket(p.market || p.category || p.stat_type || p.type);
        const point = p.line ?? p.point ?? p.value;
        if (!player || point == null) continue;
        const group = `${eventId}|${market}|${canonName(player)}|${point}`;
        const over = p.overPrice ?? p.over_price ?? p.overOdds ?? p.over;
        const under = p.underPrice ?? p.under_price ?? p.underOdds ?? p.under;
        if (over != null) out.push({ ...base, group, market, player, point: Number(point), side: 'Over', book, price: Number(over) });
        if (under != null) out.push({ ...base, group, market, player, point: Number(point), side: 'Under', book, price: Number(under) });
      }
    }
  }
  return out;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// ── fair prices ──
function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
}

// One market's quotes → { sides, fair: {side: prob}, source, sharpBooks }
function fairForGroup(quotes, { method = 'power', weights = SHARP_WEIGHTS, minConsensus = MIN_CONSENSUS_BOOKS } = {}) {
  const sides = [...new Set(quotes.map(q => q.side))];
  if (sides.length < 2) return null;
  const byBook = new Map();
  for (const q of quotes) {
    if (DFS_BOOKS.has(q.book)) continue;
    const d = americanToDecimal(q.price);
    if (!d) continue;
    if (!byBook.has(q.book)) byBook.set(q.book, {});
    byBook.get(q.book)[q.side] = d;
  }
  const complete = [...byBook].filter(([, px]) => sides.every(s => px[s]));
  const novig = ([book, px]) => ({ book, p: devig(sides.map(s => px[s]), method) });

  const sharp = complete.filter(([b]) => weights[b]).map(novig).filter(x => x.p);
  if (sharp.length) {
    const W = sharp.reduce((a, x) => a + weights[x.book], 0);
    const fair = {};
    sides.forEach((s, i) => { fair[s] = sharp.reduce((a, x) => a + weights[x.book] * x.p[i], 0) / W; });
    return { sides, fair, source: 'sharp', sharpBooks: sharp.map(x => x.book) };
  }
  if (complete.length >= minConsensus) {
    const all = complete.map(novig).filter(x => x.p);
    const raw = sides.map((_, i) => median(all.map(x => x.p[i])));
    const t = raw.reduce((a, b) => a + b, 0);
    const fair = {};
    sides.forEach((s, i) => { fair[s] = raw[i] / t; });
    return { sides, fair, source: 'consensus', sharpBooks: [] };
  }
  return null;
}

// ── the screen ──
// games: arrays in Odds API / Owls shape (see quotesFromGames)
// dfsLines: [{book, sport, player, market, line, startTime, overMultiplier, underMultiplier}]
// dfsEv(prob, book, mult) → EV % for one DFS leg (the server's calcBookEV)
function screen({ feeds = [], dfsLines = [], dfsEv = null, now = Date.now(), minEv = 0, method = 'power', kellyFraction = 0.25 } = {}) {
  const quotes = feeds.flatMap(f => quotesFromGames(f.games, { sport: f.sport }).map(q => ({ ...q, updated: f.updated || null })));
  const groups = new Map();
  for (const q of quotes) {
    if (q.start && Date.parse(q.start) <= now) continue;      // live or started: prices are stale
    if (!groups.has(q.group)) groups.set(q.group, []);
    groups.get(q.group).push(q);
  }

  const rows = [];
  const propFair = new Map();   // player|market|line → fair, for DFS legs
  for (const [group, qs] of groups) {
    const f = fairForGroup(qs, { method });
    if (!f) continue;
    const head = qs[0];
    if (head.player) propFair.set(`${canonName(head.player)}|${head.market}|${head.point}`, { f, head });

    for (const side of f.sides) {
      const fp = f.fair[side];
      // best price per book on this side (books can appear twice across feeds)
      const best = new Map();
      for (const q of qs) {
        if (q.side !== side || DFS_BOOKS.has(q.book)) continue;
        const d = americanToDecimal(q.price);
        if (d && (!best.has(q.book) || d > best.get(q.book).d)) best.set(q.book, { d, q });
      }
      for (const [book, { d, q }] of best) {
        const ev = (fp * d - 1) * 100;
        if (ev < minEv) continue;
        rows.push({
          group, sport: q.sport, event: q.event, start: q.start, market: q.market, player: q.player, point: q.point,
          side, book, price: q.price, decimal: round(d, 3), fairProb: round(fp * 100, 2), fairPrice: probToAmerican(fp),
          ev: round(ev, 2), kelly: round(Math.max(0, (fp * d - 1) / (d - 1)) * kellyFraction * 100, 2),
          source: f.source, sharpBooks: f.sharpBooks, books: best.size, updated: q.updated,
        });
      }
    }
  }

  // DFS legs at exactly a line the books price. Different line → skipped:
  // moving a fair price across lines needs a distribution we don't have here.
  if (dfsEv) {
    for (const l of dfsLines) {
      if (l.startTime && Date.parse(l.startTime) <= now) continue;
      const hit = propFair.get(`${canonName(l.player)}|${canonMarket(l.market)}|${Number(l.line)}`);
      if (!hit) continue;
      const { f, head } = hit;
      for (const side of ['Over', 'Under']) {
        const fp = f.fair[side];
        if (fp == null) continue;
        const mult = side === 'Over' ? l.overMultiplier : l.underMultiplier;
        const ev = dfsEv(fp, l.book, mult ?? 1);
        if (ev == null || ev < minEv) continue;
        rows.push({
          group: head.group, sport: head.sport || l.sport, event: head.event, start: head.start || l.startTime,
          market: head.market, player: l.player, point: Number(l.line), side, book: l.book, price: null,
          multiplier: mult ?? null, fairProb: round(fp * 100, 2), fairPrice: probToAmerican(fp), ev: round(ev, 2),
          kelly: null, source: f.source, sharpBooks: f.sharpBooks, dfs: true, updated: head.updated,
        });
      }
    }
  }

  rows.sort((a, b) => b.ev - a.ev);
  return rows;
}
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

// ── live edges ──
// Rows that newly cleared minEv since the last screen (new to the board, or
// improved from below). A cooldown per row stops a price that flickers around
// the threshold from alerting every refresh.
const rowKey = r => `${r.group}|${r.side}|${r.book}`;
function diffEv(prev, next, { minEv = 3, now = Date.now(), seen = new Map(), cooldownMs = 30 * 60000 } = {}) {
  const before = new Map((prev || []).map(r => [rowKey(r), r]));
  const out = [];
  for (const r of next || []) {
    if (r.ev < minEv) continue;
    const old = before.get(rowKey(r));
    if (old && old.ev >= minEv) continue;
    const k = rowKey(r), last = seen.get(k);
    if (last != null && now - last < cooldownMs) continue;
    seen.set(k, now);
    out.push({ ...r, kind: 'ev', at: new Date(now).toISOString(), previousEv: old?.ev ?? null });
  }
  for (const [k, t] of seen) if (now - t > 24 * 3600000) seen.delete(k);
  return out;
}

function describeEv(r) {
  const what = r.player ? `${r.player} ${r.side} ${r.point} ${r.market}` : `${r.event} ${r.market === 'h2h' ? 'ML' : r.market} ${r.side}`;
  const price = r.dfs ? (r.multiplier && r.multiplier !== 1 ? `${r.multiplier}x` : 'pick') : (r.price > 0 ? `+${r.price}` : r.price);
  return `💰 +${r.ev.toFixed(1)}% ${what} @ ${r.book} ${price} (fair ${r.fairPrice > 0 ? '+' : ''}${r.fairPrice}${r.source === 'consensus' ? ', consensus' : ''})`;
}

module.exports = {
  americanToDecimal, decimalToAmerican, probToAmerican, devig, canonMarket, canonName,
  quotesFromGames, fairForGroup, screen, diffEv, describeEv, rowKey, SHARP_WEIGHTS, DFS_BOOKS,
};
