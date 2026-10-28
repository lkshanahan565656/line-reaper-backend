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
//           venue × market × side. Season futures have their own rule (below).
//   close   Pinnacle's fair for the side at its last read <= 20 min before
//           its cutoff (no such read: no close, not graded)
//   result  Kalshi's settlement (a Polymarket US flag settles on the same
//           runner's Kalshi market when Kalshi lists it, else Polymarket US's)
//   verdict per sport (kind exchange-outrights:f1, :golf), 50 graded: CLV t>=2
//           and results not 1.5 sd short of what the close expects → passes
//           the record (then a raw re-check); CLV <= 0 or 1.5 sd short → fails
//
// SEASON FUTURES (kind exchange-futures:{venue}, checks/futures-2026-10-26/PREREGISTERED.md):
// title, conference, division and make-the-playoffs markets in the NFL, NBA,
// NHL, college football and college basketball. These settle months out, so
// a flag is graded on Pinnacle's own fair 24 hours (primary) and 7 days later.
//   fair    multiplicative, power and Shin no-vig; YES = the lowest, NO = 1 − the
//           highest. Skipped over 40% margin or under 4 runners. Names must
//           match both ways. Pinnacle open on the market and read in 5 min.
//   flag    $200 fills fully, fee in, at +3% or better, fair 3%+; again for
//           the same side only 7 days after its last flag
//   grade   CLV = Pinnacle's fair at the read nearest 24 h (and 7 d) after the
//           flag, within 2 h, over the $200 cost. 50 graded at 24 h a venue:
//           mean > 0 with t >= 2 over MARKETS (one mean a futures market) and
//           the 7 d mean not negative → passes the record; mean <= 0 → fails.
//           Settlement on Kalshi is kept as an anecdote.
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
const fees = require('./fees');
const KALSHI_RATE = fees.SCHEDULES.kalshi.taker.rate;
const PMUS_RATE = fees.SCHEDULES.polymarketus.taker.rate;
const FUTURES_KIND = 'exchange-futures';
const SEASON = { edge: 0.03, tier: 200, minFair: 0.03, maxMargin: 0.4, minRunners: 4, horizons: [['h24', 24 * 3600e3], ['d7', 7 * 86400e3]], slackMs: 2 * 3600e3, reflagMs: 7 * 86400e3 };
const SEASON_SPORTS = new Set(['nfl', 'nba', 'nhl', 'cfb', 'cbb']);

const { r4OrNull: r4, num, toProb } = require('./mathutil');
const amount = v => num(v && typeof v === 'object' ? v.value : v);
const inUnit = p => p > 0 && p < 1;

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
// withMult (season futures): the multiplicative no-vig is a third method a price must beat
function fairsOf(runners, target = 1, { withMult = false } = {}) {
  const qs = runners.map(r => toProb(r.american));
  const pw = devigPower(qs, target), sh = devigShin(qs, target);
  if (!pw || !sh) return null;
  const S = qs.reduce((a, b) => a + b, 0);
  return runners.map((r, i) => {
    const xs = withMult ? [pw[i], sh[i], qs[i] * target / S] : [pw[i], sh[i]];
    return { ...r, q: r4(qs[i]), power: r4(pw[i]), shin: r4(sh[i]), ...(withMult ? { mult: r4(qs[i] * target / S) } : {}),
      fairYes: r4(Math.min(...xs)), fairNo: r4(1 - Math.max(...xs)) };
  });
}
// a two-way Yes/No price → the same three-method fair (season) or two (top N)
function twoWayFair(yes, no, withMult = false) {
  const q = [toProb(yes), toProb(no)];
  const pw = devigPower(q, 1), sh = devigShin(q, 1);
  if (!pw || !sh) return null;
  const xs = withMult ? [pw[0], sh[0], q[0] / (q[0] + q[1])] : [pw[0], sh[0]];
  return { power: r4(pw[0]), shin: r4(sh[0]), fairYes: r4(Math.min(...xs)), fairNo: r4(1 - Math.max(...xs)) };
}
// season futures: an exchange name and a Pinnacle name must pick each other
// ("Mississippi" alone never takes "Mississippi St."); "St." reads as "State"
const stName = n => String(n || '').replace(/\bSt\.?(?=\s|$)/g, 'State');
function mutualRunner(list, name, names) {
  const r = findRunner(list, stName(name), x => stName(x.name));
  if (!r) return null;
  // the exchange's name may be the shorter one ("Miami" for "Miami Heat"), never the longer
  const ours = nameWords(stName(r.name));
  if (!nameWords(stName(name)).every(w => ours.includes(w))) return null;
  const back = findRunner(names.map(n => ({ name: n })), stName(r.name), x => stName(x.name));
  return back && back.name === name ? r : null;
}
const overround = runners => r4(runners.reduce((s, r) => s + toProb(r.american), 0) - 1);

// ── Pinnacle ──
// Pinnacle sports read: 44 Formula 1, 17 Golf. Season futures sit in these leagues.
const PIN_SPORTS = { f1: 44, golf: 17 };
const PIN_SEASON_LEAGUES = { nfl: 889, nba: 487, nhl: 1456, cfb: 880, cbb: 493 };
// the season specials a league read keeps: futures and the make-the-playoffs Yes/No
const pinSeasonSpecial = m => m.type === 'special' && (/futures/i.test(m.special?.category || '') || /to make the playoffs$/i.test(m.special?.description || ''));
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
  ['nfl', /^AFC Conference (Champion|Winner)/i, 'nfl-afc'], ['nfl', /^NFC Conference (Champion|Winner)/i, 'nfl-nfc'],
  ...['afc', 'nfc'].flatMap(c => ['east', 'north', 'south', 'west'].map(d => ['nfl', new RegExp(`^${c} ${d} (Division )?Winner$`, 'i'), `nfl-${c}-${d}`])),
  ['nhl', /NHL Eastern Conference Winner/i, 'nhl-east'], ['nhl', /NHL Western Conference Winner/i, 'nhl-west'],
  ['cbb', /Men's NCAA Tournament Winner/i, 'cbb-champ'],
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
      // "Dallas Cowboys To Make the Playoffs" Yes/No → one two-way season market a league
      const pm = SEASON_SPORTS.has(sport) && /^(.+?)\s+to Make the Playoffs$/i.exec(desc);
      if (pm) {
        const yesId = (mu.participants || []).find(p => /^yes$/i.test(p.name))?.id, noId = (mu.participants || []).find(p => /^no$/i.test(p.name))?.id;
        const yes = mk.prices?.find(p => p.participantId === yesId)?.price, no = mk.prices?.find(p => p.participantId === noId)?.price;
        if (yes == null || no == null) continue;
        const gk = `${league}|playoffs`;
        if (!tops.has(gk)) tops.set(gk, { ...base, id: `${league}|playoffs`, type: 'season', key: `${sport}-playoffs`, title: `${league} to make the playoffs`, runners: [], twoWay: true });
        const g = tops.get(gk);
        g.runners.push({ name: pm[1].trim(), american: yes, no, pinId: String(mu.id), cutoff: base.cutoff, limit });
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
  KXNHLEAST: { sport: 'nhl', type: 'season', key: 'nhl-east' }, KXNHLWEST: { sport: 'nhl', type: 'season', key: 'nhl-west' }, KXMARMAD: { sport: 'cbb', type: 'season', key: 'cbb-champ' },
  KXNFLPLAYOFF: { sport: 'nfl', type: 'season', key: 'nfl-playoffs' }, KXNBAPLAYOFF: { sport: 'nba', type: 'season', key: 'nba-playoffs' }, KXNCAAFPLAYOFF: { sport: 'cfb', type: 'season', key: 'cfb-playoffs' },
  ...Object.fromEntries(['afc', 'nfc'].flatMap(c => ['east', 'north', 'south', 'west'].map(d => [`KXNFL${c}${d}`.toUpperCase(), { sport: 'nfl', type: 'season', key: `nfl-${c}-${d}` }]))),
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
// Polymarket US season futures event slug → { sport, key } ("nba-eastconf-2027-05-19-w", "nfl-2027-01-10-playoffq")
const PMUS_SEASON = [
  [/^nba-champ-.*-w$/, 'nba', 'nba-champ'], [/^nba-eastconf-.*-w$/, 'nba', 'nba-east'], [/^nba-westconf-.*-w$/, 'nba', 'nba-west'], [/^nba-playoffs-.*-q$/, 'nba', 'nba-playoffs'],
  [/^nhl-champ-.*-w$/, 'nhl', 'nhl-champ'], [/^nhl-eastconf-.*-w$/, 'nhl', 'nhl-east'], [/^nhl-westconf-.*-w$/, 'nhl', 'nhl-west'],
  [/^nfl-champ-.*-w$/, 'nfl', 'nfl-champ'], [/^nfl-afcchamp-.*-w$/, 'nfl', 'nfl-afc'], [/^nfl-nfcchamp-.*-w$/, 'nfl', 'nfl-nfc'], [/^nfl-\d{4}-\d\d-\d\d-playoffq$/, 'nfl', 'nfl-playoffs'],
  [/^nfl-(afc|nfc)(east|north|south|west)-.*-w$/, 'nfl', m => `nfl-${m[1]}-${m[2]}`], [/^cbb-champ-.*-w$/, 'cbb', 'cbb-champ'], [/^cfb-cfp-.*-playoffq$/, 'cfb', 'cfb-playoffs'],
];
const PMUS_SEASON_LEAGUES = ['nfl', 'nba', 'nhl', 'cbb', 'cfb'];
function pmusSeasonOf(slug) {
  for (const [re, sport, key] of PMUS_SEASON) { const m = re.exec(String(slug || '')); if (m) return { sport, key: typeof key === 'function' ? key(m) : key }; }
  return null;
}
// one Polymarket US season futures event → an exchange market | null; a runner is named by its team (full name) when the market carries one
function parsePmusSeasonEvent(e) {
  const t = pmusSeasonOf(e?.slug);
  if (!t || !Array.isArray(e.markets) || e.closed) return null;
  const runners = [];
  for (const m of e.markets) {
    if (m.closed || (m.status && m.status !== 'MARKET_STATUS_OPEN')) continue;
    const ask = amount(m.bestAskQuote), bid = amount(m.bestBidQuote), fr = num(m.feeCoefficient);
    const team = (m.marketSides || []).find(x => x.long)?.team?.name;
    runners.push({ name: String(team || m.titleShort || m.title || '').trim(), marketId: m.slug, yesAsk: inUnit(ask) ? ask : null, yesBid: inUnit(bid) ? bid : null,
      noAsk: inUnit(bid) ? r4(1 - bid) : null, yesAskSize: null, noAskSize: null, feeRate: fr != null && fr >= 0 && fr < 1 ? fr : PMUS_RATE });
  }
  if (!runners.length) return null;
  return { venue: 'polymarketus', id: e.slug, sport: t.sport, type: 'season', key: t.key, scope: null, title: e.title || e.slug, end: e.endDate || null, runners };
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

// the top-of-book fee a contract (fees.js: priced on a 100-contract order, the
// shopper's number; the size tiers below walk the book with each fill's round-up)
const feeFor = (venue, p, rate) => fees.contractFee(venue === 'kalshi' ? 'kalshi' : 'polymarketus', p, { rate: rate ?? null }) ?? 0;
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
    const season = x.type === 'season', names = x.runners.map(r => r.name);
    const pinOf = (list, name) => (season ? mutualRunner(list, name, names) : findRunner(list, name));
    if (p.twoWay) {
      fairs = p.runners.map(r => { const f = twoWayFair(r.american, r.no, season); return f ? { ...r, ...f } : null; }).filter(Boolean);
    } else {
      if (season && (p.runners.length < SEASON.minRunners || overround(p.runners) > SEASON.maxMargin + 1e-9)) continue;
      // runners the exchange lists and Pinnacle doesn't: their exchange mid is held back
      const missing = x.type === 'h2h' ? 0 : x.runners.filter(r => !pinOf(p.runners, r.name)).reduce((s, r) => {
        // the mid where the spread is 10c or less, else the bid (an empty book's 0/100 says nothing)
        const mid = r.yesBid != null && r.yesAsk != null && r.yesAsk - r.yesBid <= 0.1 + 1e-9 ? (r.yesBid + r.yesAsk) / 2 : (r.yesBid || 0);
        return s + Math.max(0, mid);
      }, 0);
      if (missing > MAX_MISSING) continue;
      fairs = fairsOf(p.runners, 1 - missing, { withMult: season });
      if (!fairs) continue;
      fairs.missing = r4(missing);
    }
    const margin = p.twoWay ? null : overround(p.runners);
    const family = x.type === 'h2h' ? 'h2h' : x.type === 'season' ? 'season' : 'outright';
    for (const r of x.runners) {
      const f = pinOf(fairs, r.name);
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
        out.push({ sideKey, venue: x.venue, sport: x.sport, type: x.type, key: x.key || null, scope: x.scope, family, season: family === 'season', event: x.title, exchangeEvent: x.id,
          runner: r.name, buy, marketId: r.marketId, pinId: f.pinId || p.id, pinMarket: p.id, pinRunner: f.name, pinAmerican: buy === 'yes' ? f.american : (f.no ?? null),
          cutoff: f.cutoff || p.cutoff, pinLimit: f.limit ?? p.limit, margin, missing: fairs.missing ?? 0, fair, fairPower: buy === 'yes' ? f.power : r4(1 - f.power), fairShin: buy === 'yes' ? f.shin : r4(1 - f.shin),
          price: ask, cost, ev: fees.edge(fair, cost), tiers, sized: books.has(sideKey) ? 'book' : asks ? 'top' : null, feeRate: r.feeRate });
      }
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// a board row worth a book read: the top price clears the edge before size is known
const candidate = x => (x.season ? x.fair >= SEASON.minFair && x.ev >= SEASON.edge - 1e-9 : x.fair >= MIN_FAIR && x.ev >= EDGE[x.family] - 1e-9);
// the pre-registered season futures flag: $200 full at +3%, fair 3%+, Pinnacle open and read in the last 5 min
function flagSeasonOf(x, t, pinReadAt) {
  if (!x.season || !(x.fair >= SEASON.minFair)) return null;
  if (!(t - pinReadAt <= PIN_FRESH_MS) || !(Date.parse(x.cutoff) > t)) return null;
  const tier = x.tiers?.[SEASON.tier];
  if (!tier || !tier.full || !(tier.ev >= SEASON.edge - 1e-9)) return null;
  return { tier };
}
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
  if (b.closeFair > 0) out.clv = fees.edge(b.closeFair, b.cost);
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
// the judged kinds: one per sport; season futures one per venue
const kindOf = b => (b.kind === FUTURES_KIND ? `${FUTURES_KIND}:${b.venue}` : `${KIND}:${b.sport}`);

// season futures flags → the record: CLV at 24 h (primary) and 7 d vs Pinnacle's own fair,
// the t-stat over markets (one mean a futures market: its runners move together)
function summarizeFutures(rows = [], { minN = MIN_N } = {}) {
  const g = rows.filter(b => b.clv24 != null);
  const byMarket = new Map();
  for (const b of g) { const k = `${b.venue}|${b.pinMarket}`; if (!byMarket.has(k)) byMarket.set(k, []); byMarket.get(k).push(b.clv24); }
  const all = stat(g.map(b => b.clv24)), mk = stat([...byMarket.values()].map(xs => xs.reduce((s, x) => s + x, 0) / xs.length));
  const d7 = stat(rows.filter(b => b.clv7 != null).map(b => b.clv7));
  const res = rows.filter(b => b.outcome === 'win' || b.outcome === 'loss');
  let verdict = 'lead';
  if (all.n >= minN) verdict = all.mean <= 0 || !(mk.mean > 0) ? 'fail' : mk.t >= 2 && !(d7.mean < 0) ? 'passes the record' : 'lead';
  return {
    flagged: rows.length, open: rows.filter(b => b.status === 'open').length, missing24: rows.filter(b => b.h24Missing).length,
    graded: all.n, of: minN, markets: byMarket.size, clv: all.mean, clvT: all.t, marketClv: mk.mean, marketT: mk.t,
    beat: g.length ? r4(g.filter(b => b.clv24 > 0).length / g.length) : null, graded7: d7.n, clv7: d7.mean, clv7T: d7.t,
    evAtFlag: stat(rows.map(b => b.evAtFlag).filter(x => x != null)).mean, settled: res.length, won: res.filter(b => b.outcome === 'win').length, lost: res.filter(b => b.outcome === 'loss').length, verdict,
  };
}

// ── the live record ──
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const PMUS_API = 'https://gateway.polymarket.us';
// a Polymarket US market's settlement from /v1/events/slug: outcomePrices ["1","0"] once closed
function pmusResultOf(event, slug) {
  const m = (event?.markets || []).find(x => x.slug === slug);
  if (!m || !(m.closed || /RESOLVED|SETTLED|CLOSED/i.test(String(m.status || '')))) return null;
  let px = m.outcomePrices;
  try { if (typeof px === 'string') px = JSON.parse(px); } catch { return null; }
  const yes = num(px?.[0]);
  return yes === 1 ? 'yes' : yes === 0 ? 'no' : null;
}

// store: { init?, all, put }; http.get(url, cfg) axios-style.
function createOutrightsTracker({ store, http, now = () => Date.now() } = {}) {
  const loaded = (async () => { if (store.init) await store.init(); })();
  const state = { scans: 0, lastScan: null, sides: 0, candidates: 0, flagged: 0, futuresFlagged: 0, settled: 0, errors: [], board: [], boardAt: null, pinAt: null, counts: null };
  const err = e => { state.errors = [String(e?.response?.status || e?.message || e).slice(0, 160), ...state.errors].slice(0, 5); };

  // one pass: input { pins, pinReadAt, exch, books } → the board, new flags, open flags followed and closed
  async function scan({ pins = [], pinReadAt = 0, exch = [], books = new Map() } = {}) {
    await loaded;
    const t = now();
    const board = boardOf({ pins, exch, books });
    state.board = board; state.boardAt = new Date(t).toISOString(); state.pinAt = pinReadAt ? new Date(pinReadAt).toISOString() : null;
    state.sides = board.length; state.candidates = board.filter(candidate).length;
    state.counts = { pinnacle: pins.length, exchange: exch.length, kalshi: exch.filter(x => x.venue === 'kalshi').length, polymarketus: exch.filter(x => x.venue === 'polymarketus').length };
    const bySide = new Map(board.map(x => [x.sideKey, x]));
    const byPin = new Map();
    for (const x of board) { const k = `${x.pinMarket}|${x.pinRunner}|${x.buy}`; if (!byPin.has(k)) byPin.set(k, x); }
    const all = await store.all();
    const have = new Map(all.map(b => [b.id, b]));
    const changed = new Map();
    const fresh = t - pinReadAt <= PIN_FRESH_MS;
    const lastSeason = new Map();
    for (const b of all) {
      if (b.kind === FUTURES_KIND && !(lastSeason.get(b.sideKey) >= b.flaggedAt)) lastSeason.set(b.sideKey, b.flaggedAt);
      if (b.status !== 'open') continue;
      if (b.kind === FUTURES_KIND) {
        if (followSeason(b, bySide.get(b.sideKey) || byPin.get(`${b.pinMarket}|${b.pinRunner}|${b.buy}`), t, fresh ? pinReadAt : null)) changed.set(b.id, b);
        continue;
      }
      if (Date.parse(b.cutoff) <= t) { closeFlag(b); changed.set(b.id, b); continue; }
      const x = bySide.get(b.sideKey) || byPin.get(`${b.pinMarket}|${b.pinRunner}|${b.buy}`);
      if (!x || !fresh) continue;
      const moved = x.fair !== b.fairLast;
      b.fairLast = x.fair; b.fairLastAt = new Date(pinReadAt).toISOString();
      if (moved) { (b.fairs ||= []).push([t, x.fair]); if (b.fairs.length > 300) b.fairs = b.fairs.filter((_, i) => i % 2 === 0); }
      if (moved || t - (b.savedAt || 0) >= 10 * 60e3) { b.savedAt = t; changed.set(b.id, b); }
    }
    for (const x of board) {
      if (x.season) {
        const last = lastSeason.get(x.sideKey);
        if (last && t - Date.parse(last) < SEASON.reflagMs) continue;
        const f = flagSeasonOf(x, t, pinReadAt);
        if (!f) continue;
        const at = new Date(t).toISOString();
        const b = { id: `${x.sideKey}|${at}`, kind: FUTURES_KIND, sideKey: x.sideKey, venue: x.venue, sport: x.sport, type: x.type, key: x.key || null, family: 'season',
          event: x.event, exchangeEvent: x.exchangeEvent, runner: x.runner, buy: x.buy, marketId: x.marketId,
          kalshiTwin: x.venue === 'polymarketus' ? board.find(y => y.venue === 'kalshi' && y.pinMarket === x.pinMarket && y.pinRunner === x.pinRunner && y.buy === x.buy)?.marketId || null : null,
          pinMarket: x.pinMarket, pinId: x.pinId, pinRunner: x.pinRunner, pinAmerican: x.pinAmerican, pinLimit: x.pinLimit, margin: x.margin, missing: x.missing,
          cutoff: x.cutoff, flaggedAt: at, price: x.price, cost: f.tier.cost, contracts: f.tier.contracts, sized: x.sized, evAtFlag: f.tier.ev,
          fairAtFlag: x.fair, fairPower: x.fairPower, fairShin: x.fairShin,
          tiers: Object.fromEntries(TIERS.map(n => [n, x.tiers?.[n] ? { cost: x.tiers[n].cost, ev: x.tiers[n].ev, full: x.tiers[n].full } : null])),
          fairLast: x.fair, fairLastAt: new Date(pinReadAt).toISOString(), status: 'open' };
        lastSeason.set(x.sideKey, at); changed.set(b.id, b); state.futuresFlagged++;
        continue;
      }
      if (have.has(x.sideKey)) continue;
      const f = flagOf(x, t, pinReadAt);
      if (!f) continue;
      const twin = x.venue === 'polymarketus' ? board.find(y => y.venue === 'kalshi' && y.pinMarket === x.pinMarket && y.pinRunner === x.pinRunner && y.type === x.type && y.buy === x.buy) : null;
      const b = { id: x.sideKey, kind: KIND, sideKey: x.sideKey, venue: x.venue, sport: x.sport, type: x.type, scope: x.scope, family: x.family,
        event: x.event, exchangeEvent: x.exchangeEvent, runner: x.runner, buy: x.buy, marketId: x.marketId, kalshiTwin: twin?.marketId || null,
        pinMarket: x.pinMarket, pinId: x.pinId, pinRunner: x.pinRunner, pinAmerican: x.pinAmerican, pinLimit: x.pinLimit, margin: x.margin, missing: x.missing,
        cutoff: x.cutoff, flaggedAt: new Date(t).toISOString(), minsBefore: f.mins, price: x.price, cost: f.tier.cost, contracts: f.tier.contracts, sized: x.sized,
        evAtFlag: f.tier.ev, fairAtFlag: x.fair, fairPower: x.fairPower, fairShin: x.fairShin,
        tiers: Object.fromEntries(TIERS.map(n => [n, x.tiers?.[n] ? { cost: x.tiers[n].cost, ev: x.tiers[n].ev, full: x.tiers[n].full } : null])),
        fairLast: x.fair, fairLastAt: new Date(pinReadAt).toISOString(), fairs: [[t, x.fair]], status: 'open' };
      have.set(b.id, b); changed.set(b.id, b); state.flagged++;
    }
    for (const b of changed.values()) await store.put(b);
    state.scans++; state.lastScan = new Date(t).toISOString();
    return { sides: board.length, changed: changed.size };
  }

  // an open season flag: follow Pinnacle's fair, keep the read nearest 24 h and 7 d
  // after the flag (within 2 h, Pinnacle open), grade each once its window is past
  function followSeason(b, x, t, readAt) {
    let ch = false;
    if (x && readAt != null && Date.parse(x.cutoff) > readAt) {
      if (x.fair !== b.fairLast) { b.fairLast = x.fair; b.fairLastAt = new Date(readAt).toISOString(); ch = true; }
      if (x.cutoff !== b.cutoff) { b.cutoff = x.cutoff; ch = true; }
    }
    const t0 = Date.parse(b.flaggedAt);
    for (const [h, ms] of SEASON.horizons) {
      if (b[`${h}Done`]) continue;
      const target = t0 + ms;
      if (x && readAt != null && Date.parse(x.cutoff) > readAt && Math.abs(readAt - target) <= SEASON.slackMs) {
        const cur = b[h];
        if (!cur || Math.abs(readAt - target) < Math.abs(Date.parse(cur.at) - target)) { b[h] = { fair: x.fair, at: new Date(readAt).toISOString() }; ch = true; }
      }
      if (t > target + SEASON.slackMs) {
        b[`${h}Done`] = true; ch = true;
        if (!b[h]) b[`${h}Missing`] = true;
        else if (h === 'h24') { b.clv24 = fees.edge(b.h24.fair, b.cost); b.clv = b.clv24; }
        else b.clv7 = fees.edge(b.d7.fair, b.cost);
      }
    }
    if (b.d7Done && b.status === 'open') { b.status = 'closed'; b.nextTryAt = t; ch = true; }
    return ch;
  }

  function closeFlag(b) {
    b.status = 'closed';
    const age = Date.parse(b.cutoff) - Date.parse(b.fairLastAt || 0);
    if (b.fairLast > 0 && age <= CLOSE_MAX_AGE_MS) { b.closeFair = b.fairLast; Object.assign(b, grade(b)); }
    else { b.closeFair = null; b.closeMissing = true; }
    delete b.fairs;
  }

  // closed flags: the settlement (Kalshi's market, or the Polymarket US flag's Kalshi twin, else Polymarket US's own)
  async function settle({ limit = 20, minAgeMs = 30 * 60e3 } = {}) {
    await loaded;
    const t = now();
    const due = (await store.all()).filter(b => b.status === 'closed' && (b.kind === FUTURES_KIND ? t >= (b.nextTryAt || 0) : t - Date.parse(b.cutoff) >= minAgeMs && !(b.resultTries >= 200)))
      .sort((a, b) => Date.parse(a.cutoff) - Date.parse(b.cutoff)).slice(0, limit);
    let n = 0;
    for (const b of due) {
      try {
        let res = null;
        const ticker = b.venue === 'kalshi' ? b.marketId : b.kalshiTwin;
        if (ticker) {
          const r = await http.get(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}`, { timeout: 8000 });
          const m = r?.data?.market, v = String(m?.result || '').toLowerCase();
          if (v === 'yes' || v === 'no') res = v;
          else if (v === 'void' && /settled|finalized/.test(String(m?.status))) res = 'void';
        } else if (b.venue === 'polymarketus' && b.exchangeEvent) {
          const r = await http.get(`${PMUS_API}/v1/events/slug/${encodeURIComponent(b.exchangeEvent)}`, { timeout: 8000 });
          res = pmusResultOf(r?.data?.event || r?.data, b.marketId);
        }
        if (res) { b.result = res; Object.assign(b, grade(b)); b.status = 'settled'; b.settledVia = ticker ? (b.venue === 'kalshi' ? 'kalshi' : 'kalshi twin') : 'polymarketus'; n++; }
        else { b.resultTries = (b.resultTries || 0) + 1; if (b.kind === FUTURES_KIND) b.nextTryAt = t + 86400e3; }
        await store.put(b);
      } catch (e) { err(e); b.resultTries = (b.resultTries || 0) + 1; if (b.kind === FUTURES_KIND) b.nextTryAt = t + 86400e3; }
    }
    state.settled += n;
    return { due: due.length, settled: n };
  }
  async function list() { await loaded; return store.all(); }
  return { scan, settle, list, state, ready: () => loaded };
}

// ── the reads ──
// Pinnacle: each F1 and golf league (/sports/{id}/leagues, then matchups +
// straight markets a league) and the NFL/NBA/NHL leagues' season futures.
// Kalshi: one /events call a series. Polymarket US: /v2/sports for the golf
// and F1 leagues with open events (every 15 min), then each league's
// /events?type=futures. Books only for sides whose top price clears the edge:
// at most `kalshiBooks` Kalshi and `pmusBooks` Polymarket US reads a pass,
// each kept 2 min; a 403/429 holds that venue's books for 10 min.
const PIN_API = 'https://guest.api.arcadia.pinnacle.com/0.1';
function createOutrightsFeed({ http, key = '', now = () => Date.now(), kalshiBooks = 10, pmusBooks = 2, kalshiAsks, pmusParseBook, pmusAsks } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(key ? { 'X-API-Key': key } : {}) };
  const st = { pinAt: 0, pins: [], kalshiAt: 0, kalshi: [], pmusAt: 0, pmus: [], pmSeason: [], pmSeasonAt: 0, pmLeagues: null, pmLeaguesAt: 0, books: new Map(), hold: {}, errors: [], reads: { pinnacle: 0, kalshi: 0, polymarketus: 0, books: 0 } };
  const err = (w, e) => { st.errors = [`${w}: ${String(e?.response?.status || e?.message || e).slice(0, 120)}`, ...st.errors].slice(0, 8); };
  const get = async (venue, url, cfg = {}) => { st.reads[venue]++; return (await http.get(url, { timeout: 15000, ...cfg }))?.data; };

  async function readPinnacle() {
    const t = now(), pins = [];
    let ok = 0;
    for (const [sport, id] of Object.entries(PIN_SPORTS)) {
      try {
        const lg = await get('pinnacle', `${PIN_API}/sports/${id}/leagues`, { params: { all: false }, headers });
        for (const l of (Array.isArray(lg) ? lg : []).filter(l => l.matchupCount > 0).slice(0, 12)) {
          try {
            const [mu, mk] = await Promise.all([get('pinnacle', `${PIN_API}/leagues/${l.id}/matchups`, { headers }), get('pinnacle', `${PIN_API}/leagues/${l.id}/markets/straight`, { headers })]);
            pins.push(...parsePinLeague(sport, mu, mk, t)); ok++;
          } catch (e) { err(`pinnacle ${sport} ${l.id}`, e); }
        }
      } catch (e) { err(`pinnacle ${sport}`, e); }
    }
    for (const [sport, id] of Object.entries(PIN_SEASON_LEAGUES)) {
      try {
        const [mu, mk] = await Promise.all([get('pinnacle', `${PIN_API}/leagues/${id}/matchups`, { headers }), get('pinnacle', `${PIN_API}/leagues/${id}/markets/straight`, { headers })]);
        pins.push(...parsePinLeague(sport, (mu || []).filter(pinSeasonSpecial), mk, t)); ok++;
      } catch (e) { err(`pinnacle ${sport}`, e); }
    }
    if (ok) { st.pins = pins; st.pinAt = t; }
  }
  async function readKalshi() {
    const evs = [];
    let ok = 0;
    for (const s of KALSHI_SERIES_LIST) {
      try {
        const d = await get('kalshi', `${KALSHI_API}/events`, { params: { series_ticker: s, status: 'open', with_nested_markets: true, limit: 50 } });
        evs.push(...(d?.events || []).map(parseKalshiEvent).filter(Boolean)); ok++;
      } catch (e) { err(`kalshi ${s}`, e); }
    }
    if (ok) { st.kalshi = evs; st.kalshiAt = now(); }
  }
  async function readPmus() {
    const t = now();
    try {
      if (!st.pmLeagues || t - st.pmLeaguesAt > 15 * 60e3) {
        const d = await get('polymarketus', `${PMUS_API}/v2/sports`);
        st.pmLeagues = (d?.sports || []).flatMap(x => (x.leagues || []).map(l => ({ slug: l.slug, sport: x.slug === 'golf' ? 'golf' : l.slug === 'f1' ? 'f1' : null, n: l.activeEventCount })))
          .filter(l => l.sport && l.n > 0).slice(0, 12);
        st.pmLeaguesAt = t;
      }
      const evs = [];
      for (const l of st.pmLeagues) {
        try {
          const d = await get('polymarketus', `${PMUS_API}/v2/leagues/${encodeURIComponent(l.slug)}/events`, { params: { type: 'futures', limit: 50 } });
          evs.push(...(d?.events || []).map(e => parsePmusEvent(e, l.sport)).filter(Boolean));
        } catch (e) { err(`polymarketus ${l.slug}`, e); if (e?.response?.status === 429) break; }
      }
      // season futures move slowly and Polymarket US turns away extra reads: every 10 minutes
      if (t - st.pmSeasonAt >= 10 * 60e3) {
        const season = [];
        let ok = 0;
        for (const lg of PMUS_SEASON_LEAGUES) {
          try {
            const d = await get('polymarketus', `${PMUS_API}/v2/leagues/${lg}/events`, { params: { type: 'futures', limit: 100 } });
            season.push(...(d?.events || []).map(parsePmusSeasonEvent).filter(Boolean)); ok++;
          } catch (e) { err(`polymarketus ${lg}`, e); if (e?.response?.status === 429) break; }
        }
        if (ok) { st.pmSeason = season; st.pmSeasonAt = t; }
      }
      st.pmus = [...evs, ...st.pmSeason]; st.pmusAt = now();
    } catch (e) { err('polymarketus sports', e); }
  }
  // books for the candidates of a first board
  async function readBooks(board) {
    const t = now(), budget = { kalshi: kalshiBooks, polymarketus: pmusBooks };
    for (const [k, v] of st.books) if (t - v.at > 2 * 60e3) st.books.delete(k);
    for (const x of board.filter(candidate)) {
      if (st.books.has(x.sideKey) || !(budget[x.venue] > 0) || (st.hold[x.venue] || 0) > t) continue;
      budget[x.venue]--;
      try {
        if (x.venue === 'kalshi') {
          const d = await get('kalshi', `${KALSHI_API}/markets/${encodeURIComponent(x.marketId)}/orderbook`);
          for (const buy of ['yes', 'no']) st.books.set(`kalshi|${x.marketId}|${buy}`, { at: t, asks: kalshiAsks(d, buy) });
        } else {
          const b = pmusParseBook(await get('polymarketus', `${PMUS_API}/v1/markets/${encodeURIComponent(x.marketId)}/book`));
          if (b) for (const buy of ['yes', 'no']) st.books.set(`polymarketus|${x.marketId}|${buy}`, { at: t, asks: b.open === false ? [] : pmusAsks(b, buy === 'yes' ? 'long' : 'short') });
        }
        st.reads.books++;
      } catch (e) { err(`book ${x.venue}`, e); if ([403, 429].includes(e?.response?.status)) st.hold[x.venue] = t + 10 * 60e3; }
    }
    return new Map([...st.books].map(([k, v]) => [k, v.asks]));
  }
  // one pass → { pins, pinReadAt, exch, books }
  async function read({ pinnacle = true, kalshi = true, polymarketus = true } = {}) {
    await Promise.all([pinnacle ? readPinnacle() : null, kalshi ? readKalshi() : null, polymarketus ? readPmus() : null]);
    const exch = [...(kalshi ? st.kalshi : []), ...(polymarketus ? st.pmus : [])];
    const books = await readBooks(boardOf({ pins: st.pins, exch }));
    return { pins: st.pins, pinReadAt: st.pinAt, exch, books };
  }
  return { read, state: st };
}

module.exports = {
  KIND, FUTURES_KIND, SEASON, SEASON_SPORTS, PMUS_SEASON_LEAGUES, SPORTS, EDGE, FLAG_TIER, TIERS, MIN_FAIR, MAX_MISSING, PIN_FRESH_MS, CLOSE_MAX_AGE_MS, WINDOW_MIN, MIN_N, KALSHI_RATE, PMUS_RATE,
  PIN_SPORTS, PIN_SEASON_LEAGUES, KALSHI_SERIES, KALSHI_SERIES_LIST,
  nameWords, sameName, findRunner, mutualRunner, devigPower, devigShin, fairsOf, twoWayFair, overround, toProb, pmusSeasonOf, parsePmusSeasonEvent, flagSeasonOf, summarizeFutures,
  pinTypeOf, parsePinLeague, parseKalshiEvent, pmusTypeOf, parsePmusEvent, matchPin, tiersOf, boardOf, candidate, flagOf, grade, summarize, summarizeBy, kindOf,
  pmusResultOf, createOutrightsTracker, createOutrightsFeed,
};
