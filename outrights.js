// ─── EXCHANGE OUTRIGHTS: F1 AND GOLF ON KALSHI AND POLYMARKET US VS PINNACLE ──
// Every taker play on Kalshi and Polymarket US game lines so far lost 0.6% to
// 2.1% to Pinnacle's close. Many-runner markets (a race winner, a golf
// tournament winner, top 5/10/20, podium) are thinner on the exchanges, so
// this prices each exchange runner against Pinnacle's no-vig fair for the same
// market and keeps a record of the prices that clear it after fees at a real
// fill size. Rules fixed before any data
// (checks/exchange-outrights-2026-10-25/PREREGISTERED.md):
//
//   fair    Pinnacle's price for the same runner with the margin taken out
//           twice, by the power method and by Shin's method, over the runners
//           Pinnacle lists; the LOWER of the two for a Yes, the higher for a No
//           (a price must beat both). When the exchange lists runners Pinnacle
//           doesn't, their exchange mid is held back from the total first
//           (at most 15%, else the market is skipped as incomplete).
//           Top N and head-to-heads are Pinnacle's own two-way prices.
//   flag    the first read where $50 fills in whole contracts, fee in, at
//           +3% or better over that fair (+2% on head-to-heads), the side's
//           fair is 2% or more, 2 min to 7 days before Pinnacle's cutoff, and
//           Pinnacle's market was read in the last 5 minutes. One flag per
//           venue × market × side. Season futures are shown, never flagged.
//   close   Pinnacle's fair for the side at its last read <= 20 min before
//           its cutoff (no such read: no close, not graded)
//   result  Kalshi's settlement (a Polymarket US flag settles on the same
//           runner's Kalshi market when Kalshi lists it, else Polymarket US's)
//   verdict per sport (kind exchange-outrights:f1, :golf), 50 graded: CLV t>=2
//           and results not 1.5 sd short of what the close expects → passes
//           the record (then a raw re-check); CLV <= 0 or 1.5 sd short → fails
//
// Research, not a tip sheet: alerts off, no orders, no sizing. EXCHANGE_OUTRIGHTS=off stops it.

const depthfill = require('./depthfill');

const KIND = 'exchange-outrights';
const SPORTS = ['f1', 'golf'];
const EDGE = { outright: 0.03, h2h: 0.02 };
const FLAG_TIER = 50;
const TIERS = [50, 200, 1000];
const MIN_FAIR = 0.02;
const MAX_MISSING = 0.15;
const PIN_FRESH_MS = 5 * 60e3;
const CLOSE_MAX_AGE_MS = 20 * 60e3;
const WINDOW_MIN = [2, 7 * 1440];
const MIN_N = 50;
const KALSHI_RATE = 0.07;
const PMUS_RATE = 0.0695;

const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const amount = v => num(v && typeof v === 'object' ? v.value : v);
const inUnit = p => p > 0 && p < 1;
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

// ── names ──
// "Carlos Sainz Jr." / "Sainz" / "Søren Kjeldsen" → comparable words
function nameWords(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !/^(jr|sr|ii|iii|iv)$/.test(w));
}
// one runner name against another: same words, one a subset of the other
// (a surname alone), or same surname and first initial
function sameName(a, b) {
  const x = nameWords(a), y = nameWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.every(w => l.includes(w)) && s.some(w => w.length >= 3)) return true;
  return s.length > 1 && s[s.length - 1] === l[l.length - 1] && s[s.length - 1].length >= 3 && s[0][0] === l[0][0];
}
// the one runner in `list` named `name` (ambiguous → null)
function findRunner(list, name, key = r => r.name) {
  const exact = list.filter(r => nameWords(key(r)).join(' ') === nameWords(name).join(' '));
  if (exact.length === 1) return exact[0];
  const hits = list.filter(r => sameName(key(r), name));
  return hits.length === 1 ? hits[0] : null;
}

// ── de-vig ──
// power: p_i = q_i^k with sum p_i = target
function devigPower(qs, target = 1) {
  if (!qs.length || qs.some(q => !(q > 0 && q < 1))) return null;
  let lo = 0.2, hi = 20;
  const f = k => qs.reduce((s, q) => s + q ** k, 0);
  if (f(lo) < target || f(hi) > target) return null;
  for (let i = 0; i < 80; i++) { const k = (lo + hi) / 2; if (f(k) > target) lo = k; else hi = k; }
  const k = (lo + hi) / 2;
  return qs.map(q => q ** k);
}
// Shin: p_i = (sqrt(z² + 4(1−z) q_i²/S) − z) / (2(1−z)), z solved for sum p_i = target
function devigShin(qs, target = 1) {
  if (!qs.length || qs.some(q => !(q > 0 && q < 1))) return null;
  const S = qs.reduce((s, q) => s + q, 0);
  const at = z => qs.map(q => (Math.sqrt(z * z + 4 * (1 - z) * q * q / S) - z) / (2 * (1 - z)));
  const sum = z => at(z).reduce((s, p) => s + p, 0);
  if (sum(0) < target) return qs.map(q => q * target / S);     // under-round: scale (never seen on Pinnacle)
  let lo = 0, hi = 0.99;
  if (sum(hi) > target) return null;
  for (let i = 0; i < 80; i++) { const z = (lo + hi) / 2; if (sum(z) > target) lo = z; else hi = z; }
  return at((lo + hi) / 2);
}
// one market's Pinnacle runners [{ name, american }] → [{ name, american, q, power, shin, fairYes, fairNo }]
// target: the share of the field Pinnacle's listed runners cover
function fairsOf(runners, target = 1) {
  const qs = runners.map(r => toProb(r.american));
  const pw = devigPower(qs, target), sh = devigShin(qs, target);
  if (!pw || !sh) return null;
  return runners.map((r, i) => ({ ...r, q: r4(qs[i]), power: r4(pw[i]), shin: r4(sh[i]),
    fairYes: r4(Math.min(pw[i], sh[i])), fairNo: r4(1 - Math.max(pw[i], sh[i])) }));
}
const overround = runners => r4(runners.reduce((s, r) => s + toProb(r.american), 0) - 1);

// ── Pinnacle ──
// Pinnacle sports read: 44 Formula 1, 17 Golf. Season futures sit in these leagues.
const PIN_SPORTS = { f1: 44, golf: 17 };
const PIN_SEASON_LEAGUES = { nfl: 889, nba: 487, nhl: 1456 };
// a futures special's description → { type, scope?, key? }
function pinTypeOf(sport, desc, category) {
  const d = String(desc || '');
  if (sport === 'f1') {
    if (/sprint/i.test(d)) return null;
    if (/pole/i.test(d)) return { type: 'pole' };
    if (/podium|top 3\b/i.test(d)) return { type: 'top3' };
    if (/drivers'? champ/i.test(d)) return { type: 'season', key: 'f1-drivers' };
    if (/constructor/i.test(d)) return null;
    if (/winner$/i.test(d)) return { type: 'winner' };
    return null;
  }
  if (sport === 'golf') {
    if (/round|leader|nationality|top|without|group/i.test(d)) return null;
    if (/^futures$/i.test(category || '')) return { type: 'winner' };
    return null;
  }
  const seasonKey = SEASON_PIN.find(([sp, re]) => sp === sport && re.test(d));
  return seasonKey ? { type: 'season', key: seasonKey[2] } : null;
}
// Pinnacle season futures descriptions → our key (matched to Kalshi's series below)
const SEASON_PIN = [
  ['nba', /NBA Champion$/i, 'nba-champ'], ['nba', /NBA Eastern Conference Winner/i, 'nba-east'], ['nba', /NBA Western Conference Winner/i, 'nba-west'],
  ['nba', /NBA Regular Season MVP/i, 'nba-mvp'], ['nfl', /Super Bowl|NFL Champion/i, 'nfl-champ'], ['nfl', /AFC (Champion|Winner)/i, 'nfl-afc'],
  ['nfl', /NFC (Champion|Winner)/i, 'nfl-nfc'], ['nfl', /NFL (Regular Season )?MVP/i, 'nfl-mvp'], ['nhl', /Stanley Cup|NHL Champion/i, 'nhl-champ'],
];

// one league's matchups + straight markets → Pinnacle markets:
//   { src, id, sport, league, type, scope, key, title, cutoff, limit, runners: [{ name, american }] }
// type winner | pole | top3 | season (many runners), top5/top10/top20/... (one
// Yes/No per player, grouped into one market a tournament and N), h2h (two runners)
function parsePinLeague(sport, matchups = [], markets = [], now = Date.now()) {
  const priced = new Map();
  for (const m of markets || []) if (m && m.period === 0 && m.type === 'moneyline' && !m.isAlternate && (m.status == null || m.status === 'open')) priced.set(m.matchupId, m);
  const out = [], tops = new Map();
  for (const mu of matchups || []) {
    const mk = priced.get(mu.id);
    if (!mk || mu.isLive) continue;
    const cutoff = Date.parse(mk.cutoffAt || mu.startTime || '');
    if (!(cutoff > now)) continue;
    const league = mu.league?.name || '';
    const limit = (mk.limits || []).find(l => l.type === 'maxRiskStake')?.amount ?? null;
    const base = { src: 'pinnacle', id: String(mu.id), sport, league, cutoff: new Date(cutoff).toISOString(), limit };
    if (mu.type === 'special') {
      const desc = mu.special?.description || '', cat = mu.special?.category || '';
      const tm = /^(.+?)\s+Top\s+(\d+)\s+Finish/i.exec(desc);
      if (tm && (sport === 'golf' || sport === 'f1')) {
        const yesId = (mu.participants || []).find(p => /^yes$/i.test(p.name))?.id, noId = (mu.participants || []).find(p => /^no$/i.test(p.name))?.id;
        const yes = mk.prices?.find(p => p.participantId === yesId)?.price, no = mk.prices?.find(p => p.participantId === noId)?.price;
        if (yes == null || no == null) continue;
        const n = Number(tm[2]), gk = `${league}|${n}`;
        if (!tops.has(gk)) tops.set(gk, { ...base, id: `${league}|top${n}`, type: `top${n}`, title: `${league} Top ${n}`, runners: [], twoWay: true });
        const g = tops.get(gk);
        g.runners.push({ name: tm[1].trim(), american: yes, no, pinId: String(mu.id) });
        if (Date.parse(g.cutoff) > cutoff) g.cutoff = base.cutoff;
        continue;
      }
      const t = pinTypeOf(sport, desc, cat);
      if (!t) continue;
      const runners = (mu.participants || []).map(p => ({ name: p.name, american: mk.prices?.find(x => x.participantId === p.id)?.price }))
        .filter(r => r.american != null && !/^(the )?field$|any other|^other/i.test(r.name));
      if (runners.length < 3) continue;
      out.push({ ...base, type: t.type, key: t.key || null, title: desc, runners });
    } else if (mu.type === 'matchup' && (sport === 'f1' || sport === 'golf')) {
      const ps = mu.participants || [];
      if (ps.length !== 2) continue;
      const price = d => mk.prices?.find(p => p.designation === d)?.price;
      const home = ps.find(p => p.alignment === 'home'), away = ps.find(p => p.alignment === 'away');
      if (!home || !away || price('home') == null || price('away') == null) continue;
      const rm = /(\d)(?:st|nd|rd|th) Round/i.exec(league);
      out.push({ ...base, type: 'h2h', scope: rm ? `r${rm[1]}` : 'event', title: `${home.name} v ${away.name}`,
        runners: [{ name: home.name, american: price('home') }, { name: away.name, american: price('away') }] });
    }
  }
  for (const g of tops.values()) if (g.runners.length) out.push(g);
  return out;
}

// ── exchanges ──
// Kalshi series → { sport, type, scope? }. KXF1H2H / KXPGAH2H titles carry the round.
const KALSHI_SERIES = {
  KXF1RACE: { sport: 'f1', type: 'winner' }, KXF1POLE: { sport: 'f1', type: 'pole' }, KXF1RACEPODIUM: { sport: 'f1', type: 'top3' },
  KXF1TOP5: { sport: 'f1', type: 'top5' }, KXF1RACETOP5: { sport: 'f1', type: 'top5' }, KXF1TOP10: { sport: 'f1', type: 'top10' }, KXF1RACETOP10: { sport: 'f1', type: 'top10' },
  KXF1H2H: { sport: 'f1', type: 'h2h' }, KXF1: { sport: 'f1', type: 'season', key: 'f1-drivers' },
  KXPGATOUR: { sport: 'golf', type: 'winner' }, KXDPWORLDTOUR: { sport: 'golf', type: 'winner' }, KXLIVTOUR: { sport: 'golf', type: 'winner' },
  KXPGATOP5: { sport: 'golf', type: 'top5' }, KXPGATOP10: { sport: 'golf', type: 'top10' }, KXPGATOP20: { sport: 'golf', type: 'top20' }, KXPGATOP40: { sport: 'golf', type: 'top40' },
  KXDPWTTOP5: { sport: 'golf', type: 'top5' }, KXDPWTTOP10: { sport: 'golf', type: 'top10' }, KXDPWTTOP20: { sport: 'golf', type: 'top20' },
  KXLIVTOP5: { sport: 'golf', type: 'top5' }, KXLIVTOP10: { sport: 'golf', type: 'top10' },
  KXPGAH2H: { sport: 'golf', type: 'h2h' }, KXGOLFH2H: { sport: 'golf', type: 'h2h' }, KXDPWTH2H: { sport: 'golf', type: 'h2h' }, KXLIVH2H: { sport: 'golf', type: 'h2h' },
  KXSB: { sport: 'nfl', type: 'season', key: 'nfl-champ' }, KXNFLAFCCHAMP: { sport: 'nfl', type: 'season', key: 'nfl-afc' }, KXNFLNFCCHAMP: { sport: 'nfl', type: 'season', key: 'nfl-nfc' },
  KXNFLMVP: { sport: 'nfl', type: 'season', key: 'nfl-mvp' }, KXNBA: { sport: 'nba', type: 'season', key: 'nba-champ' }, KXNBAEAST: { sport: 'nba', type: 'season', key: 'nba-east' },
  KXNBAWEST: { sport: 'nba', type: 'season', key: 'nba-west' }, KXNBAMVP: { sport: 'nba', type: 'season', key: 'nba-mvp' }, KXNHL: { sport: 'nhl', type: 'season', key: 'nhl-champ' },
};
const KALSHI_SERIES_LIST = Object.keys(KALSHI_SERIES);
const kalshiPrice = (m, f) => num(m[`${f}_dollars`] ?? (m[f] != null ? Number(m[f]) / 100 : null));
// a Kalshi event (with nested markets) → an exchange market | null.
// Each runner: buy YES at yes_ask (size yes_ask_size), NO at no_ask (size: the YES bid's size).
function parseKalshiEvent(e) {
  const series = String(e?.series_ticker || String(e?.event_ticker || '').split('-')[0]).toUpperCase();
  const def = KALSHI_SERIES[series];
  if (!def || !Array.isArray(e.markets)) return null;
  const rm = /(\d)(?:st|nd|rd|th) Round/i.exec(`${e.title || ''} ${e.sub_title || ''}`);
  const runners = [];
  for (const m of e.markets) {
    if (m.status && !/^(active|open)$/i.test(m.status)) continue;
    const name = m.yes_sub_title || m.subtitle || m.title;
    if (!name) continue;
    runners.push({ name: String(name).trim(), marketId: m.ticker, yesAsk: kalshiPrice(m, 'yes_ask'), yesBid: kalshiPrice(m, 'yes_bid'), noAsk: kalshiPrice(m, 'no_ask'),
      yesAskSize: num(m.yes_ask_size_fp ?? m.yes_ask_size), noAskSize: num(m.yes_bid_size_fp ?? m.yes_bid_size), feeRate: KALSHI_RATE });
  }
  if (!runners.length) return null;
  return { venue: 'kalshi', id: e.event_ticker, series, sport: def.sport, type: def.type, key: def.key || null, scope: def.type === 'h2h' ? (rm ? `r${rm[1]}` : 'event') : null,
    title: [e.title, e.sub_title].filter(Boolean).join(' · '), end: e.markets[0]?.expected_expiration_time || e.markets[0]?.close_time || null, runners };
}
// Polymarket US futures event slug → type: "f1-mcusgp-2026-10-25-w" winner, -top3/-top5/-top10;
// golf "pga-vidamexi-2026-10-29-w" winner (round leaders and constructors left out)
function pmusTypeOf(slug, sport) {
  const s = String(slug || '');
  if (sport === 'f1' && /^f1-dc-/.test(s)) return { type: 'season', key: 'f1-drivers' };
  if (/-cons$|-r\dl$|^f1-cc-/.test(s)) return null;
  if (/-w$/.test(s)) return { type: 'winner' };
  const t = /-top(\d+)$/.exec(s);
  return t ? { type: `top${t[1]}` } : null;
}
// one /v2/leagues/{slug}/events?type=futures event → an exchange market | null.
// Buy YES at the best offer, NO at 1 − the best bid (no sizes here: a book read sizes it).
function parsePmusEvent(e, sport) {
  const t = pmusTypeOf(e?.slug, sport);
  if (!t || !Array.isArray(e.markets) || e.closed) return null;
  const runners = [];
  for (const m of e.markets) {
    if (m.closed || (m.status && m.status !== 'MARKET_STATUS_OPEN')) continue;
    const ask = amount(m.bestAskQuote), bid = amount(m.bestBidQuote);
    const fr = num(m.feeCoefficient);
    runners.push({ name: String(m.titleShort || m.title || '').trim(), marketId: m.slug, yesAsk: inUnit(ask) ? ask : null, yesBid: inUnit(bid) ? bid : null,
      noAsk: inUnit(bid) ? r4(1 - bid) : null, yesAskSize: null, noAskSize: null, feeRate: fr != null && fr >= 0 && fr < 1 ? fr : PMUS_RATE });
  }
  if (!runners.length) return null;
  return { venue: 'polymarketus', id: e.slug, sport, type: t.type, key: t.key || null, scope: null, title: e.title || e.slug, end: e.startTime || e.startDate || null, runners };
}

// ── matching ──
// how far apart an exchange market's date and Pinnacle's cutoff may be
const DAYS_APART = { f1: 3, golf: 6 };
// exchange market ↔ Pinnacle market: same sport and type, dates close, most of
// Pinnacle's runners on the exchange (H2H: both drivers/golfers and the same round)
function matchPin(x, pins) {
  const cands = pins.filter(p => p.sport === x.sport && p.type === x.type && (x.type !== 'season' || p.key === x.key) && (x.type !== 'h2h' || p.scope === x.scope));
  let best = null;
  for (const p of cands) {
    if (x.type !== 'season' && x.end && Math.abs(Date.parse(x.end) - Date.parse(p.cutoff)) > (DAYS_APART[x.sport] || 3) * 86400e3) continue;
    const hits = p.runners.filter(r => findRunner(x.runners, r.name)).length;
    const need = x.type === 'h2h' ? 2 : Math.max(2, Math.ceil(p.runners.length * 0.7));
    if (hits < need || (x.type === 'h2h' && x.runners.length !== 2)) continue;
    if (!best || hits > best.hits) best = { pin: p, hits };
  }
  return best?.pin || null;
}

// the top-of-book cost a contract, fee in, before Kalshi's round-up to the cent
// (the size tiers below walk the book with the round-up, per fill)
const feeFor = (venue, p, rate) => (rate ?? (venue === 'kalshi' ? KALSHI_RATE : PMUS_RATE)) * p * (1 - p);
// a side's fill at each tier from asks [[price, contracts]] → { 50: {...walk, ev}, ... }
function tiersOf(venue, asks, fair, rate) {
  const fee = { rate: rate ?? (venue === 'kalshi' ? KALSHI_RATE : PMUS_RATE), roundCent: venue === 'kalshi' };
  const out = {};
  for (const t of TIERS) { const w = depthfill.walk(asks, t, fee); out[t] = w ? { ...w, ev: depthfill.evOf(fair, w.cost) } : null; }
  return out;
}

// Every exchange runner side priced against Pinnacle.
// pins: parsePinLeague output; exch: parseKalshiEvent / parsePmusEvent output;
// books: Map `${venue}|${marketId}|${buy}` → asks [[p, n]] read this pass (optional)
// → [{ sideKey, venue, sport, type, scope, family, event, runner, buy, marketId, pinId, pinRunner, cutoff, pinLimit, margin,
//      missing, fair, fairPower, fairShin, price, cost, ev, tiers, sized, season }]
function boardOf({ pins = [], exch = [], books = new Map() } = {}) {
  const out = [];
  for (const x of exch) {
    const p = matchPin(x, pins);
    if (!p) continue;
    let fairs;
    if (p.twoWay) {
      fairs = p.runners.map(r => { const pw = devigPower([toProb(r.american), toProb(r.no)], 1), sh = devigShin([toProb(r.american), toProb(r.no)], 1);
        return pw && sh ? { ...r, power: r4(pw[0]), shin: r4(sh[0]), fairYes: r4(Math.min(pw[0], sh[0])), fairNo: r4(1 - Math.max(pw[0], sh[0])) } : null; }).filter(Boolean);
    } else {
      // runners the exchange lists and Pinnacle doesn't: their exchange mid is held back
      const missing = x.type === 'h2h' ? 0 : x.runners.filter(r => !findRunner(p.runners, r.name)).reduce((s, r) => {
        // the mid where the spread is 10c or less, else the bid (an empty book's 0/100 says nothing)
        const mid = r.yesBid != null && r.yesAsk != null && r.yesAsk - r.yesBid <= 0.1 + 1e-9 ? (r.yesBid + r.yesAsk) / 2 : (r.yesBid || 0);
        return s + Math.max(0, mid);
      }, 0);
      if (missing > MAX_MISSING) continue;
      fairs = fairsOf(p.runners, 1 - missing);
      if (!fairs) continue;
      fairs.missing = r4(missing);
    }
    const margin = p.twoWay ? null : overround(p.runners);
    const family = x.type === 'h2h' ? 'h2h' : x.type === 'season' ? 'season' : 'outright';
    for (const r of x.runners) {
      const f = findRunner(fairs, r.name);
      if (!f) continue;
      for (const buy of ['yes', 'no']) {
        const ask = buy === 'yes' ? r.yesAsk : r.noAsk;
        // a head-to-head's No is the other runner's Yes: priced once
        if (!inUnit(ask) || (x.type === 'h2h' && buy === 'no')) continue;
        const fair = buy === 'yes' ? f.fairYes : f.fairNo;
        if (!inUnit(fair)) continue;
        const cost = r4(ask + feeFor(x.venue, ask, r.feeRate));
        const sideKey = `${x.venue}|${r.marketId}|${buy}`;
        const topSize = buy === 'yes' ? r.yesAskSize : r.noAskSize;
        const asks = books.get(sideKey) || (topSize > 0 ? [[ask, topSize]] : null);
        const tiers = asks ? tiersOf(x.venue, asks, fair, r.feeRate) : null;
        out.push({ sideKey, venue: x.venue, sport: x.sport, type: x.type, scope: x.scope, family, season: family === 'season', event: x.title, exchangeEvent: x.id,
          runner: r.name, buy, marketId: r.marketId, pinId: f.pinId || p.id, pinMarket: p.id, pinRunner: f.name, pinAmerican: buy === 'yes' ? f.american : (f.no ?? null),
          cutoff: p.cutoff, pinLimit: p.limit, margin, missing: fairs.missing ?? 0, fair, fairPower: buy === 'yes' ? f.power : r4(1 - f.power), fairShin: buy === 'yes' ? f.shin : r4(1 - f.shin),
          price: ask, cost, ev: r4(fair / cost - 1), tiers, sized: books.has(sideKey) ? 'book' : asks ? 'top' : null, feeRate: r.feeRate });
      }
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// a board row worth a book read: the top price clears the edge before size is known
const candidate = x => !x.season && x.fair >= MIN_FAIR && x.ev >= EDGE[x.family] - 1e-9;
// the pre-registered flag for one board row at time t
function flagOf(x, t, pinReadAt) {
  if (x.season || !(x.fair >= MIN_FAIR)) return null;
  if (!(t - pinReadAt <= PIN_FRESH_MS)) return null;
  const mins = (Date.parse(x.cutoff) - t) / 60e3;
  if (!(mins >= WINDOW_MIN[0] && mins <= WINDOW_MIN[1])) return null;
  const tier = x.tiers?.[FLAG_TIER];
  if (!tier || !tier.full || !(tier.ev >= EDGE[x.family] - 1e-9)) return null;
  return { mins: Math.round(mins), tier };
}

// one closed flag → CLV and result per $1 at the $50 fill's all-in cost
function grade(b) {
  const out = {};
  if (b.closeFair > 0) out.clv = r4(b.closeFair / b.cost - 1);
  if (b.result === 'yes' || b.result === 'no') {
    const won = (b.buy === 'yes') === (b.result === 'yes');
    out.outcome = won ? 'win' : 'loss';
    out.profit = won ? r4(1 / b.cost - 1) : -1;
  } else if (b.result === 'void') { out.outcome = 'push'; out.profit = 0; }
  return out;
}

const stat = xs => {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, t: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: r4(mean), t: sd > 0 ? Math.round(mean / (sd / Math.sqrt(n)) * 100) / 100 : null };
};
// flags → the record row: CLV vs Pinnacle's close, results vs what the close expects, verdict
function summarize(rows = [], { minN = MIN_N } = {}) {
  const graded = rows.filter(b => b.clv != null);
  const clv = stat(graded.map(b => b.clv));
  const res = graded.filter(b => b.outcome === 'win' || b.outcome === 'loss' || b.outcome === 'push');
  const profit = r4(res.reduce((s, b) => s + b.profit, 0));
  const exp = r4(res.reduce((s, b) => s + (b.closeFair / b.cost - 1), 0));
  const sd = Math.sqrt(res.reduce((s, b) => s + b.closeFair * (1 - b.closeFair) / (b.cost * b.cost), 0));
  const z = sd > 0 ? Math.round((profit - exp) / sd * 100) / 100 : null;
  let verdict = 'lead';
  if (clv.n >= minN) verdict = (clv.mean <= 0 || (z != null && z <= -1.5)) ? 'fail' : clv.t >= 2 ? 'passes the record' : 'lead';
  else if (z != null && res.length >= 20 && z <= -1.5) verdict = 'lead (results short)';
  return {
    flagged: rows.length, open: rows.filter(b => b.status === 'open').length, closeMissing: rows.filter(b => b.closeMissing).length,
    graded: clv.n, of: minN, clv: clv.mean, clvT: clv.t, beatClose: graded.length ? r4(graded.filter(b => b.clv > 0).length / graded.length) : null,
    evAtFlag: stat(rows.map(b => b.evAtFlag).filter(x => x != null)).mean,
    results: res.length, won: res.filter(b => b.outcome === 'win').length, lost: res.filter(b => b.outcome === 'loss').length,
    profit, expected: exp, z, verdict,
  };
}
function summarizeBy(rows, keyOf, o) {
  const m = new Map();
  for (const b of rows) { const k = keyOf(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
  return [...m].map(([key, xs]) => ({ key, ...summarize(xs, o) })).sort((a, b) => b.flagged - a.flagged);
}
// the judged kinds: one per sport
const kindOf = b => `${KIND}:${b.sport}`;

module.exports = {
  KIND, SPORTS, EDGE, FLAG_TIER, TIERS, MIN_FAIR, MAX_MISSING, PIN_FRESH_MS, CLOSE_MAX_AGE_MS, WINDOW_MIN, MIN_N, KALSHI_RATE, PMUS_RATE,
  PIN_SPORTS, PIN_SEASON_LEAGUES, KALSHI_SERIES, KALSHI_SERIES_LIST,
  nameWords, sameName, findRunner, devigPower, devigShin, fairsOf, overround, toProb,
  pinTypeOf, parsePinLeague, parseKalshiEvent, pmusTypeOf, parsePmusEvent, matchPin, tiersOf, boardOf, candidate, flagOf, grade, summarize, summarizeBy, kindOf,
};
