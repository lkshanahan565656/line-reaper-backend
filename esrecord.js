// ─── ESPORTS PICK'EM BOARD: EVERY LEG, NEXT TO EVERY SHARP, GRADED ──────────
// The weekend board recorder (nflsunday.js, scripts/nflsunday-record.js) run
// with LEAGUES=CS,LOL,VAL,DOTA,R6,COD: every esports leg on PrizePicks,
// Underdog, Sleeper and DK Pick6, and beside them whatever prices the same
// match somewhere sharp:
//
//   pinnacle-es   Pinnacle's guest feed: series and map winners, map
//                 handicaps, total maps, per-map round totals (CS2, VAL, R6)
//                 and kill totals (LoL, Dota). No player props at all.
//   betrivers-es  BetRivers (Kambi) team lines on the few tier-one events it
//                 lists, and 'betrivers': its per-map player kill ladders,
//                 the only sharp-side price on a player stat
//   kalshi-es     Kalshi's match-winner books (yes bid and ask per team)
//   pmus-es       Polymarket US's match-winner books (bid, ask, fee)
//   FanDuel lists no real esports (virtual eSoccer only), so it isn't read.
//
// A CS team can play two or three Bo1s a day, and the apps list a player once
// per match, so an app leg's key carries its own match id (the app's game id,
// or start and title): "CS|zywoo|k|1-2|g:underdog:272169". Across apps the
// legs of one player in one match are joined later by esmatch.matchTags.
//
// This module is the pure part: reads → log entries, a leg's sharps at bet
// time and close, the result from a grader's per-map numbers, the lineup
// guard, and the report against each app's break-even. Nothing here flags or
// alerts; it is a record.

const { canonName } = require('./ev');
const { normalizeMarket, parseMapSpan } = require('./esmarkets');
const esmatch = require('./esmatch');
const { factorHitsDistribution, legLoadings } = require('./slip');
const NS = require('./nflsunday');

const ES_SPORTS = ['CS', 'LOL', 'VAL', 'DOTA', 'R6', 'COD'];
// an app's or a book's label → the board's esports key, or null
function esKey(label) {
  const s = String(label || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  if (!s) return null;
  if (/^(CS|CS2|CSGO|COUNTER ?STRIKE)/.test(s)) return 'CS';
  if (/^(LOL|LEAGUE OF LEGENDS)/.test(s)) return 'LOL';
  if (/^(VAL|VALORANT)/.test(s)) return 'VAL';
  if (/^DOTA/.test(s)) return 'DOTA';
  if (/^(R6|RAINBOW)/.test(s)) return 'R6';
  if (/^(COD|CALL OF DUTY)/.test(s)) return 'COD';
  return null;
}
const isEsBoard = leagues => leagues.length > 0 && leagues.every(l => ES_SPORTS.includes(l));
// esbooks/esboard game names → board keys
const GAME_SP = { CS2: 'CS', LOL: 'LOL', VAL: 'VAL', DOTA: 'DOTA', COD: 'COD', R6: 'R6' };
// the stat a grader reads, from the market key ("k|1-2" → kills); null: no grader
const STAT = { k: 'kills', hs: 'headshots', ast: 'assists' };
const statOf = mkey => STAT[String(mkey || '').split('|')[0]] || null;
const iso = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? new Date(x).toISOString() : ''; };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = x => Math.round(x * 1e4) / 1e4;

// ── reads → entries ──
// the app's own match id for a line: its game id, else start and title
function midOf(l) {
  if (l.gameId != null && l.gameId !== '') return `g:${l.book}:${l.gameId}`;
  return `t:${iso(l.startTime).slice(0, 16)}|${canonName(l.matchTitle || l.opponent || '')}`;
}
// one app's esports lines (sport already the board key) → Map(key → { v, m }),
// v as nflsunday.appEntries: [line, over mult, under mult, over open, under open]
function esAppEntries(lines, sport) {
  const out = new Map();
  for (const l of lines || []) {
    if (!l?.player || l.sport !== sport) continue;
    const line = num(l.line);
    if (line == null) continue;
    const mkey = normalizeMarket(l.market);
    const key = `${sport}|${canonName(l.player)}|${mkey}|${midOf(l)}`;
    const pp = l.book === 'prizepicks';
    const v = [line, pp ? null : num(l.overMultiplier), pp ? null : num(l.underMultiplier), l.overOpen === false ? 0 : 1, l.underOpen === false ? 0 : 1];
    const old = out.get(key);
    if (old && (old.v[3] + old.v[4] > v[3] + v[4] || (old.v[3] + old.v[4] === v[3] + v[4] && old.v[0] <= v[0]))) continue;
    out.set(key, { v, m: { p: l.player, tm: l.team || '', st: iso(l.startTime), mt: l.matchTitle || l.opponent || '', mk: l.market || '', mkey, sp: sport, gid: l.gameId ?? null, bk: l.book } });
  }
  return out;
}
// Pinnacle's esports matches (esbooks.parsePinnacle) → Map('M|SP|id' → { v: ladders, m })
// ladders: { 'series|0|ml': [[x, p, limit]], 'rounds|1|total': … }
function pinEntries(matches, src = 'pin') {
  const out = new Map();
  for (const m of matches || []) {
    const sp = GAME_SP[m.game];
    if (!sp) continue;
    const v = {};
    for (const [k, pts] of m.ladders) v[k] = pts.map(q => [q.x, r4(q.p), q.limit ?? null]).sort((a, b) => a[0] - b[0]);
    out.set(`M|${sp}|${src}:${m.id}`, { v, m: { sp, teams: m.teams, st: m.start ? new Date(m.start).toISOString() : '', lg: m.league || '' } });
  }
  return out;
}
// BetRivers (esbooks.parseKambiEsports events) → team lines and player kill ladders
function kambiEntries(events) {
  const teams = new Map(), players = new Map();
  for (const e of events || []) {
    const sp = GAME_SP[e.game];
    if (!sp) continue;
    const v = {};
    for (const l of e.lines || []) (v[l.key] ||= []).push([l.x, l.prices[0], l.prices[1]]);
    const st = e.start ? new Date(e.start).toISOString() : '';
    teams.set(`M|${sp}|br:${e.eventId}`, { v, m: { sp, teams: e.teams, st, lg: e.league || '' } });
    for (const p of e.players || []) {
      const key = `${sp}|${canonName(p.player)}|k|${p.period}`;
      if (!players.has(key)) players.set(key, { v: [], m: { p: p.player, sp, st, tm: e.teams[p.team] || '', mkey: `k|${p.period}` } });
      const x = players.get(key);
      if (!x.v.some(q => q[0] === p.line)) x.v.push([p.line, p.prices[0], p.prices[1]]);
    }
  }
  for (const x of players.values()) x.v.sort((a, b) => a[0] - b[0]);
  return { teams, players };
}
// Kalshi's start from its ticker: "KXCS2GAME-26OCT251130NAVIFAZE" = 11:30 US Eastern on 2026-10-25
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function etOffsetH(y, mo, d) {
  // US Eastern: EDT (−4) from the 2nd Sunday of March to the 1st Sunday of November
  const nthSun = (m, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const t = Date.UTC(y, mo, d);
  return t >= Date.UTC(y, 2, nthSun(2, 2)) && t < Date.UTC(y, 10, nthSun(10, 1)) ? 4 : 5;
}
function kalshiStart(ticker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{4})/.exec(String(ticker || ''));
  if (!m || MON[m[2]] == null) return '';
  const y = 2000 + +m[1], mo = MON[m[2]], d = +m[3], hh = +m[4].slice(0, 2), mm = +m[4].slice(2);
  return new Date(Date.UTC(y, mo, d, hh + etOffsetH(y, mo, d), mm)).toISOString();
}
// Kalshi esports events (series KX…GAME, nested markets) → Map('K|SP|ticker' → { v: [[team, bid, ask]], m })
function kalshiEntries(events, sp) {
  const out = new Map();
  for (const e of events || []) {
    const rows = [];
    for (const k of e.markets || []) {
      const bid = num(k.yes_bid_dollars) ?? (num(k.yes_bid) != null ? num(k.yes_bid) / 100 : null);
      const ask = num(k.yes_ask_dollars) ?? (num(k.yes_ask) != null ? num(k.yes_ask) / 100 : null);
      if (!k.yes_sub_title) continue;
      rows.push([String(k.yes_sub_title).trim(), bid, ask]);
    }
    if (rows.length < 2) continue;
    out.set(`K|${sp}|${e.event_ticker}`, { v: rows, m: { sp, title: e.title || '', st: kalshiStart(e.event_ticker), teams: rows.map(r => r[0]) } });
  }
  return out;
}
// Polymarket US league events → Map('U|SP|slug' → { v: [bid, ask, fee], m: { sides: [long team, short team] } })
const amt = v => num(v && typeof v === 'object' ? v.value : v);
function pmusEntries(events, sp) {
  const out = new Map();
  for (const e of events || []) {
    if (e?.ended === true || e?.closed === true) continue;
    for (const m of e.markets || []) {
      if (!/match_winner$/.test(String(m.sportsMarketType || ''))) continue;
      const sides = (m.marketSides || []).map(s => ({ name: s.team?.name || s.description || '', long: s.long === true || s.long === 'true' }));
      const long = sides.find(s => s.long)?.name, short = sides.find(s => !s.long)?.name;
      if (!long || !short) continue;
      out.set(`U|${sp}|${m.slug}`, { v: [amt(m.bestBidQuote), amt(m.bestAskQuote), num(m.feeCoefficient)], m: { sp, sides: [long, short], st: iso(e.startTime || m.gameStartTime), ev: e.slug || '' } });
    }
  }
  return out;
}

// ── a leg's sharps ──
const fits = (a, b) => esmatch.sameTeam(a, b) || esmatch.looseTeam(a, b);
// the leg as a line esmatch understands (Sleeper's borrowed title reads like Underdog's)
const asLine = leg => ({ book: leg.app === 'sleeper' ? 'x' : leg.app, team: leg.team, matchTitle: leg.matchTitle, startTime: leg.start, player: leg.player, sport: leg.sport, gameId: leg.gid });
// matches of one source near the leg: [{ key, m, i }] where i is the leg team's index
function matchFor(leg, srcSeries, meta, teamsOf = m => m.teams) {
  const list = [];
  for (const k of srcSeries?.keys() || []) {
    const m = meta.get(k);
    if (!m || m.sp !== leg.sport) continue;
    list.push({ k, m });
  }
  const hit = esmatch.sideFor(list, asLine(leg), { teamsOf: x => teamsOf(x.m) || [], startOf: x => Date.parse(x.m.st || ''), fits });
  return hit ? { key: hit.m.k, i: hit.i, m: hit.m.m } : null;
}
// a ladder's main point: the one nearest 50/50
const mainOf = pts => (Array.isArray(pts) && pts.length ? pts.reduce((a, b) => (Math.abs(b[1] - 0.5) < Math.abs(a[1] - 0.5) ? b : a)) : null);
function pinAt(ladders, i, sport) {
  if (!ladders) return null;
  const ml = ladders['series|0|ml']?.[0];
  const unit = ['LOL', 'DOTA'].includes(sport) ? 'kills' : 'rounds';
  const tot = mainOf(ladders[`${unit}|1|total`]);
  return {
    pTeam: ml ? r4(i === 0 ? ml[1] : 1 - ml[1]) : null, limit: ml?.[2] ?? null,
    map1: tot ? { unit, line: -tot[0], pOver: tot[1] } : null,
  };
}
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function kambiAt(v, i) {
  const ml = v?.['series|0|ml']?.[0];
  if (!ml) return null;
  const a = toProb(ml[1]), b = toProb(ml[2]);
  const p0 = a / (a + b);
  return { pTeam: r4(i === 0 ? p0 : 1 - p0) };
}
function kalshiAt(v, team) {
  const row = (v || []).find(r => fits(r[0], team));
  if (!row || row[1] == null || row[2] == null || !(row[2] > row[1])) return null;
  return { pTeam: r4((row[1] + row[2]) / 2), spread: r4(row[2] - row[1]) };
}
function pmusAt(v, m, team) {
  if (!v || v[0] == null || v[1] == null) return null;
  const longIs = fits(m.sides[0], team), shortIs = fits(m.sides[1], team);
  if (longIs === shortIs) return null;
  const mid = (v[0] + v[1]) / 2;
  return { pTeam: r4(longIs ? mid : 1 - mid), spread: r4(v[1] - v[0]) };
}
// every sharp's read of the leg's match (and BetRivers' price on the leg's own
// number) at bet time and at the last read before the start
function sharpsFor(leg, series, meta) {
  const start = Date.parse(leg.start), times = { bet: leg.bet.t, close: start - 1 };
  const out = { bet: {}, close: {} };
  const pin = matchFor(leg, series['pinnacle-es'], meta);
  const br = matchFor(leg, series['betrivers-es'], meta);
  const ks = matchFor(leg, series['kalshi-es'], meta);
  const us = matchFor(leg, series['pmus-es'], meta, m => m.sides);
  const brPlayer = series.betrivers?.get(`${leg.sport}|${canonName(leg.player)}|${leg.mkey}`);
  for (const [when, t] of Object.entries(times)) {
    const o = out[when];
    if (pin) o.pinnacle = pinAt(NS.at(series['pinnacle-es'].get(pin.key), t), pin.i, leg.sport);
    if (br) o.betrivers = kambiAt(NS.at(series['betrivers-es'].get(br.key), t), br.i);
    if (ks) o.kalshi = kalshiAt(NS.at(series['kalshi-es'].get(ks.key), t), leg.team);
    if (us) o.pmus = pmusAt(NS.at(series['pmus-es'].get(us.key), t), us.m, leg.team);
    const line = when === 'bet' ? leg.bet.v[0] : leg.close.v[0];
    if (brPlayer) o.brPlayer = NS.bookAt(NS.at(brPlayer, t), line);
    for (const k of Object.keys(o)) if (!o[k]) delete o[k];
  }
  return out;
}

// ── legs ──
// every app leg with its match pieces, its sharps, and its cross-app match tag
function buildEsLegs(series, meta, o = {}) {
  const legs = NS.buildLegs(series, meta, o);
  for (const leg of legs) {
    const m = meta.get(leg.key) || {};
    leg.mid = leg.key.split('|').slice(4).join('|');   // sport|player|stat|span|match
    leg.gid = m.gid ?? null;
    leg.stat = statOf(leg.mkey);
    leg.span = String(leg.mkey || '').split('|')[1] || '1';
    leg.opp = esmatch.lineOpponent(asLine(leg)) || null;
    leg.sharp = sharpsFor(leg, series, meta);
  }
  // one player's legs in one match share a tag across apps (esmatch.matchTags)
  const lines = legs.map(asLine);
  const tags = esmatch.matchTags(lines, { playerOf: l => canonName(l.player), sportOf: l => l.sport });
  legs.forEach((leg, i) => { leg.tag = tags.get(lines[i]) ?? null; });
  // players whose team plays more than one match that day (the round-robin trap)
  const multi = esmatch.multiMatchRows(legs.map(l => ({ ...asLine(l), startTime: l.start, _leg: l })), { sportOf: r => r.sport });
  for (const r of multi) r._leg.multi = true;
  annotate(legs);
  return legs;
}

// ── pre-registered 10-24, before any result was read ──
// (a) a leg whose app sits a full line (1.0+) off the other apps' consensus
//     (median of their bet-time lines, same player, stat, span and match):
//     play the side the consensus favours on the odd app (its line under the
//     consensus → Over). 'a-consensus-2': two or more other apps.
// (b) same-match 6-pick stacks: per app, match, stat and side, three legs a
//     team (the three highest lines), every leg one way; sweep rate against
//     the standard payout and the repriced one (standard × P(all) if
//     independent / P(all) with the measured same-match link, slip.js
//     FACTORS, legs at 50%), the "If repriced" figure of the stack cards
// (c) Unders on every Map 1 kills leg of a match where Pinnacle's Map 1 total
//     (main line) sits under what the app's own lines add up to: LoL and Dota
//     kills straight; CS2 and Valorant rounds = the ten players' kills over
//     total kills a round (2 × the h2h model's team pace: CS 3.4, VAL 3.47).
//     A team needs 4+ players listed; its sum is scaled to five.
//     'c-map1-under-5': Pinnacle 5%+ under.
const KILLS_PER_ROUND = { CS: 6.8, VAL: 6.94 };
const median = xs => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function annotate(legs) {
  const byTag = new Map();
  for (const l of legs) if (l.tag != null) {
    const k = `${l.sport}|${canonName(l.player)}|${l.mkey}|${l.tag}`;
    (byTag.get(k) || byTag.set(k, []).get(k)).push(l);
  }
  for (const group of byTag.values()) for (const l of group) {
    const others = group.filter(x => x.app !== l.app).map(x => x.bet.v[0]);
    if (!others.length) continue;
    const c = median(others);
    l.cons = { line: c, apps: others.length, diff: +(l.bet.v[0] - c).toFixed(2) };
  }
  // (c): the app's own Map 1 kill lines in each match against Pinnacle's Map 1 total
  const byMatch = new Map();
  for (const l of legs) if (l.mkey === 'k|1') {
    const k = `${l.app}|${l.mid}`;
    (byMatch.get(k) || byMatch.set(k, []).get(k)).push(l);
  }
  for (const group of byMatch.values()) {
    const teams = new Map();
    for (const l of group) if (l.team) (teams.get(l.team) || teams.set(l.team, []).get(l.team)).push(l.bet.v[0]);
    const pin = group.map(l => l.sharp.bet.pinnacle?.map1).find(Boolean);
    if (teams.size !== 2 || [...teams.values()].some(v => v.length < 4) || !pin) continue;
    const kills = [...teams.values()].reduce((s, v) => s + v.reduce((a, b) => a + b, 0) * 5 / v.length, 0);
    const kpr = KILLS_PER_ROUND[group[0].sport];
    const implied = pin.unit === 'kills' ? kills : kpr ? kills / kpr : null;
    if (implied == null) continue;
    const info = { pinLine: pin.line, implied: +implied.toFixed(2), under: pin.line < implied, under5: pin.line < implied * 0.95 };
    for (const l of group) l.map1 = info;
  }
}
const PREREG = {
  'a-consensus': (leg, s) => leg.cons && Math.abs(leg.cons.diff) >= 1 && s.side === (leg.cons.diff < 0 ? 'Over' : 'Under'),
  'a-consensus-2': (leg, s) => leg.cons && leg.cons.apps >= 2 && Math.abs(leg.cons.diff) >= 1 && s.side === (leg.cons.diff < 0 ? 'Over' : 'Under'),
  'c-map1-under': (leg, s) => !!leg.map1?.under && s.side === 'Under',
  'c-map1-under-5': (leg, s) => !!leg.map1?.under5 && s.side === 'Under',
};

// a leg's two sides at bet time: break-even, and BetRivers' no-vig chance on
// the app's exact number then and at the close (the only player-stat sharp)
function esSides(leg) {
  const out = [];
  for (const side of ['Over', 'Under']) {
    const v = leg.bet.v;
    if ((side === 'Over' ? v[3] : v[4]) === 0) continue;
    const be = NS.breakEven(leg.app, side, v);
    if (!(be > 0 && be < 1)) continue;
    const pick = q => (q?.exact ? (side === 'Over' ? q.pOver : r4(1 - q.pOver)) : null);
    const fair = pick(leg.sharp.bet.brPlayer);
    const closeFair = leg.close.v[0] === v[0] ? pick(leg.sharp.close.brPlayer) : null;
    // the app's own line from bet time to the close, in this side's favour (+ = better for the bet)
    const lineMove = +((side === 'Over' ? 1 : -1) * (leg.close.v[0] - v[0])).toFixed(2);
    out.push({ side, line: v[0], mult: side === 'Over' ? v[1] : v[2], be: r4(be), fair, closeFair, lineMove });
  }
  return out;
}

// ── grading ──
// a grader's per-map numbers ({ maps: { 1: 18, 2: 22 }, complete } or
// { unavailable }) → the leg's result over its span, as the tracker settles:
// every map of the span, or a Bo3 that ended 2-0 on a "Maps 1-3" line (maps
// played, when maps 1 and 2 are there); a missing map 1 or 2 is a void
function resultFromMaps(res, market) {
  if (!res) return { pending: true };
  if (res.unavailable) return { void: res.unavailable };
  if (!res.maps) return { pending: true };
  const { label } = parseMapSpan(market);
  const [a, b] = String(label).split('-').map(Number);
  const maps = [];
  for (let m = a; m <= (b || a); m++) maps.push(m);
  const have = maps.filter(m => res.maps[m] != null);
  if (have.length === maps.length) return { result: maps.reduce((s, m) => s + res.maps[m], 0) };
  if (!res.complete) return { pending: true };
  if (maps.filter(m => res.maps[m] == null).every(m => m >= 3) && have.length >= 2) return { result: have.reduce((s, m) => s + res.maps[m], 0), partial: true };
  return { void: `series ended after ${have.length} of ${maps.length} maps` };
}
// The round-robin trap (10-20): a whole lineup graded 0 kills means the grader
// read the wrong match or a map with no stats, never a real result. Any app
// match whose kill legs (3 or more) all came back 0 is void, every leg of it.
function lineupGuard(legs, results) {
  const groups = new Map();
  for (const l of legs) {
    if (l.stat !== 'kills') continue;
    const r = results.get(`${l.app}|${l.key}`);
    if (r?.result == null) continue;
    const k = `${l.app}|${l.mid}|${l.mkey}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(l);
  }
  let voided = 0;
  for (const g of groups.values()) {
    if (g.length < 3 || g.some(l => results.get(`${l.app}|${l.key}`).result !== 0)) continue;
    const ids = new Set(g.map(l => l.mid));
    for (const l of legs) if (ids.has(l.mid) && l.app === g[0].app) {
      const id = `${l.app}|${l.key}`, r = results.get(id);
      if (r?.result != null) { results.set(id, { void: 'whole lineup graded 0 (wrong match)' }); voided++; }
    }
  }
  return voided;
}

// ── stacks (b) ──
const STACK_STD = { prizepicks: 37.5, underdog: 35, sleeper: 1, pick6: 25 };
function stacks(legs, results) {
  const groups = new Map();
  for (const l of legs) {
    if (!l.stat || !l.team) continue;
    for (const s of esSides(l)) {
      const k = `${l.app}|${l.mid}|${l.mkey}|${s.side}`;
      (groups.get(k) || groups.set(k, []).get(k)).push({ l, s });
    }
  }
  const rows = [];
  for (const g of groups.values()) {
    const teams = new Map();
    for (const x of g) (teams.get(x.l.team) || teams.set(x.l.team, []).get(x.l.team)).push(x);
    const tl = [...teams.values()];
    if (tl.length !== 2 || tl.some(t => t.length < 3)) continue;
    const six = tl.flatMap(t => t.sort((a, b) => b.l.bet.v[0] - a.l.bet.v[0]).slice(0, 3));
    const res = six.map(x => results.get(`${x.l.app}|${x.l.key}`));
    const app = g[0].l.app, side = g[0].s.side;
    const base = { app, sport: six[0].l.sport, mkey: six[0].l.mkey, side, match: six[0].l.matchTitle, start: six[0].l.start };
    if (res.some(r => !r || r.pending)) { rows.push({ ...base, status: 'pending' }); continue; }
    if (res.some(r => r.void != null || r.result == null)) { rows.push({ ...base, status: 'void' }); continue; }
    const outs = six.map((x, i) => NS.outcome(x.s.side, x.s.line, res[i].result));
    if (outs.includes('push')) { rows.push({ ...base, status: 'push' }); continue; }
    const mult = six.reduce((p, x) => p * (x.s.mult > 0 ? x.s.mult : 1), 1);
    const std = STACK_STD[app] * (app === 'prizepicks' ? 1 : mult);
    const loads = six.map(x => legLoadings({ sport: x.l.sport, stat: x.l.stat, side: side.toUpperCase(), team: x.l.team }));
    const dist = factorHitsDistribution(six.map(() => 0.5), loads, six.map(x => x.l.team));
    const pAll = dist[6], pInd = 0.5 ** 6;
    rows.push({ ...base, status: 'graded', swept: outs.every(o => o === 'win'), hits: outs.filter(o => o === 'win').length, std: +std.toFixed(2), repriced: +(std * pInd / pAll).toFixed(2), pAll: r4(pAll) });
  }
  const sum = list => {
    const g = list.filter(r => r.status === 'graded');
    const sw = g.filter(r => r.swept);
    return { stacks: g.length, swept: sw.length, pending: list.filter(r => r.status === 'pending').length, void: list.filter(r => r.status !== 'graded' && r.status !== 'pending').length,
      needStd: +g.reduce((s, r) => s + 1 / r.std, 0).toFixed(2), needRepriced: +g.reduce((s, r) => s + 1 / r.repriced, 0).toFixed(2),
      expCorrelated: +g.reduce((s, r) => s + r.pAll, 0).toFixed(2),
      unitsStd: +(sw.reduce((s, r) => s + r.std, 0) - g.length).toFixed(1), unitsRepriced: +(sw.reduce((s, r) => s + r.repriced, 0) - g.length).toFixed(1) };
  };
  const by = {};
  for (const r of rows) { const k = `${r.sport}|${r.app}|${r.side}`; (by[k] ||= []).push(r); }
  return { all: sum(rows), byApp: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, sum(v)]).sort((a, b) => b[1].stacks - a[1].stacks)), rows };
}

// ── the report ──
function tallyEs(rows) {
  const t = NS.tally(rows);
  const mv = rows.filter(r => r.out !== 'push');
  t.lineMove = mv.length ? +(mv.reduce((s, r) => s + r.lineMove, 0) / mv.length).toFixed(2) : null;
  return t;
}
function summarize(legs, results) {
  const rows = [], counts = { legs: legs.length, pending: 0, void: 0, noGrader: 0, graded: 0, multiMatch: 0 };
  for (const leg of legs) {
    const r = results.get(`${leg.app}|${leg.key}`);
    if (!r || r.skip) { counts.noGrader++; continue; }
    if (r.pending) { counts.pending++; continue; }
    if (r.void != null) { counts.void++; continue; }
    counts.graded++;
    if (leg.multi) counts.multiMatch++;
    for (const s of esSides(leg)) {
      const out = NS.outcome(s.side, s.line, r.result);
      const clv = s.fair != null && s.closeFair != null ? s.closeFair - s.fair : null;
      const base = { app: leg.app, sport: leg.sport, stat: leg.stat, mkey: leg.mkey, side: s.side, be: s.be, out, clv, lineMove: s.lineMove };
      rows.push({ ...base, kind: 'all' });
      for (const [kind, rule] of Object.entries(PREREG)) if (rule(leg, s)) rows.push({ ...base, kind, prereg: true });
      if (s.fair != null) rows.push({ ...base, kind: 'br-player-priced' });
      if (s.fair != null && s.fair >= s.be) rows.push({ ...base, kind: 'br-player-backed' });
    }
  }
  const group = keyOf => {
    const g = new Map();
    for (const r of rows) { const k = keyOf(r); if (!k) continue; (g.get(k) || g.set(k, []).get(k)).push(r); }
    return Object.fromEntries([...g].map(([k, v]) => [k, tallyEs(v)]).sort((a, b) => b[1].n - a[1].n));
  };
  const all = r => r.kind === 'all';
  return {
    counts,
    byGameStatAppSide: group(r => (all(r) ? `${r.sport}|${r.stat}|${r.app}|${r.side}` : null)),
    byMarket: group(r => (all(r) ? `${r.sport}|${r.mkey}|${r.app}|${r.side}` : null)),
    byApp: group(r => (all(r) ? `${r.app}|${r.side}` : null)),
    prereg: group(r => (r.prereg ? `${r.kind}|${r.app}` : null)),
    preregAll: group(r => (r.prereg ? r.kind : null)),
    sharpKinds: group(r => (/^br-/.test(r.kind) ? `${r.kind}|${r.app}` : null)),
    stacks: stacks(legs, results),
    coverage: coverage(legs),
  };
}
// per game: legs, and which sharps price them (the player stat, or only the match)
function coverage(legs) {
  const out = {};
  for (const l of legs) {
    const c = out[l.sport] ||= { legs: 0, playerSharp: 0, matchOnly: 0, noSharp: 0, pinnacle: 0, kalshi: 0, pmus: 0, betrivers: 0, pinMap1: 0 };
    const b = l.sharp.bet;
    c.legs++;
    if (b.pinnacle) c.pinnacle++;
    if (b.pinnacle?.map1) c.pinMap1++;
    if (b.kalshi) c.kalshi++;
    if (b.pmus) c.pmus++;
    if (b.betrivers) c.betrivers++;
    if (b.brPlayer?.exact) c.playerSharp++;
    else if (b.pinnacle || b.kalshi || b.pmus || b.betrivers) c.matchOnly++;
    else c.noSharp++;
  }
  return out;
}
function reportText(rep, { title = 'Esports pick\'em board' } = {}) {
  const pct = x => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
  const row = (k, t) => `${k.padEnd(40)} ${String(t.n).padStart(5)}  ${`${t.w}-${t.l}${t.p ? `-${t.p}` : ''}`.padEnd(11)} ${pct(t.hit).padStart(6)} vs ${pct(t.be).padStart(6)}  z ${String(t.z ?? '-').padStart(5)}  ${String(t.units).padStart(7)}u  line move ${t.lineMove ?? '-'}  clv ${t.clv == null ? '-' : `${t.clv}pt (${t.clvN})`}`;
  const c = rep.counts;
  const L = [`${title}: ${c.legs} legs, ${c.graded} graded, ${c.pending} not graded yet, ${c.void} void, ${c.noGrader} with no grader (R6, CoD, fantasy, first bloods, deaths); ${c.multiMatch} graded legs from players with two or more matches that day`, ''];
  L.push('Pre-registered 10-24 (before any result):');
  for (const [k, t] of Object.entries(rep.preregAll)) L.push(row(k, t));
  for (const [k, t] of Object.entries(rep.prereg)) L.push(row(`  ${k}`, t));
  const s = rep.stacks.all;
  L.push(`(b) same-match 6-pick stacks: ${s.swept} swept of ${s.stacks} graded (${s.pending} waiting, ${s.void} void or push); break-even needs ${s.needStd} sweeps at standard payouts, ${s.needRepriced} if repriced; the link model expects ${s.expCorrelated}; units ${s.unitsStd} at standard, ${s.unitsRepriced} if repriced`);
  for (const [k, t] of Object.entries(rep.stacks.byApp)) L.push(`  ${k.padEnd(28)} ${t.swept} of ${t.stacks}, needs ${t.needStd} (std) / ${t.needRepriced} (repriced), units ${t.unitsStd} / ${t.unitsRepriced}`);
  L.push('', 'Per app and side:');
  for (const [k, t] of Object.entries(rep.byApp)) L.push(row(k, t));
  L.push('', 'Per game, stat, app and side (units at 1u a leg at the break-even price):');
  for (const [k, t] of Object.entries(rep.byGameStatAppSide)) L.push(row(k, t));
  L.push('', 'BetRivers player kill ladders at the app\'s exact number (the only sharp on a player stat):');
  if (!Object.keys(rep.sharpKinds).length) L.push('none');
  for (const [k, t] of Object.entries(rep.sharpKinds)) L.push(row(k, t));
  L.push('', 'Coverage per game (legs; player stat priced by a sharp; match priced only; no sharp at all; Pinnacle, its Map 1 total, Kalshi, Polymarket US, BetRivers):');
  for (const [k, v] of Object.entries(rep.coverage)) L.push(`${k.padEnd(5)} ${JSON.stringify(v)}`);
  return L.join('\n');
}

module.exports = { ES_SPORTS, esKey, isEsBoard, GAME_SP, STAT, statOf, midOf, esAppEntries, pinEntries, kambiEntries, kalshiStart, kalshiEntries, pmusEntries,
  matchFor, pinAt, kalshiAt, pmusAt, sharpsFor, buildEsLegs, annotate, PREREG, KILLS_PER_ROUND, esSides, resultFromMaps, lineupGuard, stacks, summarize, coverage, reportText };
