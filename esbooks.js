// ─── ESPORTS AT BETRIVERS, PRICED OFF PINNACLE AND KALSHI ───────────────────
// The +EV tab priced only sports at the two free US books. Their esports:
//
//   FanDuel     nothing real: its "esports" page is virtual eSoccer,
//               eBasketball and eFootball (checked 2026-10-14)
//   BetRivers   Kambi's esports group: tier-one events only (LoL Worlds,
//               VCT Champions when on), but deep: match, map winners, map
//               handicap, total maps, and per map the kill handicap, total
//               kills and each team's kills (LoL, Dota) or the round
//               handicap and total rounds (Valorant, CS2)
//
// Each BetRivers line is priced at its own number against:
//
//   pinnacle   the guest feed's esports (sport 12): match, map, map
//              handicap and total maps on the main matchup; per-map round
//              spreads, totals and team totals (CS2, Valorant); per-map kill
//              spreads, totals and team totals on its "Kills" child matchups
//              (LoL, Dota). Power devig, its exact line when it posts one,
//              else its ladder of alternates read in z (altlines.ladderAt)
//   kalshi     the esports board's Kalshi mid (bid/ask, spread under 6¢) on
//              the match, map winners, total maps and map spread
//
//   polymarket the board's Polymarket mid (global book, spread under 6¢,
//              $500+ liquidity) on the same markets as Kalshi
//
// A line CLEARS when two exact sharp prices (Pinnacle taking $250+, Kalshi,
// Polymarket) sit within agreePts of each other and BetRivers beats their
// blend by minEv. A single source never clears: the kill and round lines,
// which only Pinnacle prices, show as single-source. Rows grade against
// Pinnacle's close in a tracker of their own, like the alt lines.
// Pure parsing and pricing; the server fetches.

const { teamsMatch } = require('./context');
const { devigPower } = require('./esboard');
const { ladderAt } = require('./altlines');
const { americanToDecimal, probToAmerican } = require('./ev');

const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const DEFAULTS = {
  minEv: 2,          // percent past the fair, as on the +EV tab
  maxEv: 25,         // past this a line is a bad match, not an edge
  agreePts: 5,       // Pinnacle and Kalshi within this many points of win chance
  agreeRel: 0.25,    // and this share of the smaller chance
  pinMinLimit: 250,  // Pinnacle counts toward clearing only where it takes this much
  kalshiMaxSpread: 0.06,
  minP: 0.05, maxP: 0.95,
  pairHours: 12,     // Kambi's start times can be hours off Pinnacle's
  weights: { pinnacle: 3, kalshi: 2, polymarket: 2 },
  polyMinLiquidity: 500,   // Polymarket books thinner than this ($) say little
};
const ROUND_GAMES = new Set(['CS2', 'VAL', 'R6']);

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = x => Math.round(x * 100) / 100;
const ms = t => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const GAME_RE = [[/^(cs2|cs:?go|counter-strike)/i, 'CS2'], [/^league of legends|^lol\b/i, 'LOL'], [/^valorant/i, 'VAL'], [/^dota/i, 'DOTA'], [/^call of duty/i, 'COD'], [/^rainbow six/i, 'R6']];
const gameOf = s => (GAME_RE.find(([re]) => re.test(String(s || '').trim())) || [])[1] || null;
const LABEL = { CS2: 'CS2', LOL: 'LoL', VAL: 'Valorant', DOTA: 'Dota 2', COD: 'CoD', R6: 'R6' };
const cleanTeam = s => String(s || '').replace(/\s*\((kills|regular)\)\s*$/i, '').trim();

// a market's ladder key: scope|period|type[|team]
//   series|0|ml, series|0|spread (maps), series|0|total (maps), map|N|ml,
//   rounds|N|spread|total|tt, kills|N|spread|total|tt (tt carries the team, 0 or 1)
// Ladder points: x = team 0's handicap (spread) or −line (totals), p = team
// 0 covers / over, so p rises with x; ml has one point at x 0.
const lkey = (scope, period, type, team) => `${scope}|${period}|${type}${type === 'tt' ? `|${team}` : ''}`;

// ── Pinnacle ──
// matchups: [{ id, parentId, type, units, league: { name }, participants, startTime, isLive }]
// markets:  [{ matchupId, period, type, side, status, limits, prices: [{ designation, points, price }] }]
// → [{ id, game, league, teams, start, ladders: Map(lkey → [{ x, p, limit }]) }]
function parsePinnacle(matchups, markets) {
  const byId = new Map(), kills = new Map();
  for (const m of matchups || []) {
    if (m?.type !== 'matchup' || m.isLive) continue;
    if (m.parentId != null) { if (m.units === 'Kills') kills.set(m.id, m.parentId); continue; }
    if (m.units && m.units !== 'Regular') continue;
    const game = gameOf(m.league?.name);
    const home = m.participants?.find(p => p.alignment === 'home')?.name, away = m.participants?.find(p => p.alignment === 'away')?.name;
    if (!game || !home || !away) continue;
    byId.set(m.id, { id: m.id, game, league: m.league?.name || null, teams: [cleanTeam(home), cleanTeam(away)], start: ms(m.startTime), ladders: new Map() });
  }
  for (const k of markets || []) {
    if (k?.status && k.status !== 'open') continue;
    const childOf = kills.get(k.matchupId);
    const m = byId.get(childOf ?? k.matchupId);
    const per = num(k.period);
    if (!m || per == null || per > 5) continue;
    const at = d => k.prices?.find(p => p.designation === d);
    let scope;
    if (childOf != null) { if (per < 1 || k.type === 'moneyline') continue; scope = 'kills'; }
    else if (per === 0) scope = 'series';
    else if (k.type === 'moneyline') scope = 'map';
    else if (ROUND_GAMES.has(m.game)) scope = 'rounds';
    else continue;
    let pt;
    if (k.type === 'moneyline') {
      const h = at('home'), a = at('away');
      const p = h && a ? devigPower(h.price, a.price) : null;
      if (p != null) pt = { key: lkey(scope, per, 'ml'), x: 0, p };
    } else if (k.type === 'spread') {
      const h = at('home'), a = at('away');
      if (!h || !a || num(h.points) == null || num(h.points) !== -num(a.points)) continue;
      const p = devigPower(h.price, a.price);
      if (p != null) pt = { key: lkey(scope, per, 'spread'), x: num(h.points), p };
    } else if (k.type === 'total' || k.type === 'team_total') {
      const o = at('over'), u = at('under');
      if (!o || !u || num(o.points) == null || num(o.points) !== num(u.points)) continue;
      const team = k.type === 'team_total' ? (k.side === 'home' ? 0 : k.side === 'away' ? 1 : null) : null;
      if (k.type === 'team_total' && team == null) continue;
      const p = devigPower(o.price, u.price);
      if (p != null) pt = { key: lkey(scope, per, k.type === 'total' ? 'total' : 'tt', team), x: -num(o.points), p };
    }
    if (!pt) continue;
    if (!m.ladders.has(pt.key)) m.ladders.set(pt.key, []);
    m.ladders.get(pt.key).push({ x: pt.x, p: pt.p, limit: num(k.limits?.[0]?.amount) });
  }
  return [...byId.values()].filter(m => m.ladders.size);
}

// ── BetRivers (Kambi) ──
// betoffer/event/{id}: events[0] (englishName "Home - Away", path [Esports,
// League of Legends, World Championship], start, state) and betOffers, each a
// criterion with outcomes OT_ONE (home) / OT_TWO (away) / OT_OVER / OT_UNDER,
// line in thousandths and oddsAmerican.
const KB_LINES = [
  [/^match odds$/i, () => ({ scope: 'series', period: 0, type: 'ml' })],
  [/^map (\d)$/i, m => ({ scope: 'map', period: +m[1], type: 'ml' })],
  [/^map handicap$/i, () => ({ scope: 'series', period: 0, type: 'spread' })],
  [/^total maps$/i, () => ({ scope: 'series', period: 0, type: 'total' })],
  [/^map (\d) - total kills$/i, m => ({ scope: 'kills', period: +m[1], type: 'total' })],
  [/^map (\d) - team kills handicap$/i, m => ({ scope: 'kills', period: +m[1], type: 'spread' })],
  [/^map (\d) - total kills by (?!the player)(.+)$/i, m => ({ scope: 'kills', period: +m[1], type: 'tt', teamName: m[2] })],
  [/^map (\d) - total rounds$/i, m => ({ scope: 'rounds', period: +m[1], type: 'total' })],
  [/^map (\d) - round handicap$/i, m => ({ scope: 'rounds', period: +m[1], type: 'spread' })],
  [/^map (\d) - total rounds (?:won )?by (?!the player)(.+)$/i, m => ({ scope: 'rounds', period: +m[1], type: 'tt', teamName: m[2] })],
];
const am = v => { const a = num(v); return a != null && Math.abs(a) >= 100 ? a : null; };
// → { book, eventId, game, league, teams, start, lines: [{ key, scope, period, type, team, x, prices: [a, b] }] }
//   prices[0] is team 0 (ml, spread) or the over (totals); x as in the ladders
function parseKambiEsports(payload, now = Date.now()) {
  const e = payload?.events?.[0];
  if (!e || e.state !== 'NOT_STARTED' || !(ms(e.start) > now)) return null;
  const path = (e.path || []).map(p => p.englishName);
  const game = gameOf(path[1]);
  const teams = String(e.englishName || '').split(' - ').map(s => s.trim());
  if (!game || teams.length !== 2) return null;
  const lines = [], seen = new Set(), players = [];
  const home = (e.participants || []).find(x => x.home === true)?.participantId, away = (e.participants || []).find(x => x.home === false)?.participantId;
  for (const b of payload.betOffers || []) {
    if (b?.suspended) continue;
    const label = String(b.criterion?.englishLabel || '').trim();
    // each player's kills on one map, a ladder of lines: priced by the kill-share model (sharemodel.js)
    const pk = /^map (\d) - total kills by the player$/i.exec(label);
    if (pk) {
      const os = (b.outcomes || []).filter(o => o.status === 'OPEN');
      const o = os.find(x => x.type === 'OT_OVER'), u = os.find(x => x.type === 'OT_UNDER');
      const line = num(o?.line) / 1000, team = o?.eventParticipantId === home ? 0 : o?.eventParticipantId === away ? 1 : null;
      const prices = [am(o?.oddsAmerican), am(u?.oddsAmerican)];
      if (o && u && o.line === u.line && o.participant && team != null && line > 0 && prices.every(x => x != null)) {
        players.push({ period: +pk[1], player: String(o.participant).trim(), team, line, prices });
      }
      continue;
    }
    let spec = null;
    for (const [re, fn] of KB_LINES) { const m = re.exec(label); if (m) { spec = fn(m); break; } }
    if (!spec) continue;
    const os = (b.outcomes || []).filter(o => o.status === 'OPEN');
    if (os.length !== 2) continue;
    const by = t => os.find(o => o.type === t);
    let team = null, x = 0, a, z;
    if (spec.type === 'ml' || spec.type === 'spread') {
      a = by('OT_ONE'); z = by('OT_TWO');
      if (!a || !z) continue;
      if (spec.type === 'spread') {
        const la = num(a.line), lz = num(z.line);
        if (la == null || la !== -lz || la === 0) continue;
        x = la / 1000;
      }
    } else {
      a = by('OT_OVER'); z = by('OT_UNDER');
      if (!a || !z || num(a.line) == null || a.line !== z.line) continue;
      x = -num(a.line) / 1000;
      if (spec.type === 'tt') {
        team = teamsMatch(spec.teamName, teams[0]) && !teamsMatch(spec.teamName, teams[1]) ? 0 : teamsMatch(spec.teamName, teams[1]) && !teamsMatch(spec.teamName, teams[0]) ? 1 : null;
        if (team == null) continue;
      }
    }
    const prices = [am(a.oddsAmerican), am(z.oddsAmerican)];
    if (prices.some(p => p == null) || Math.abs(Math.abs(x % 1) - 0.5) > 1e-9 && spec.type !== 'ml') continue;
    const key = lkey(spec.scope, spec.period, spec.type, team);
    if (seen.has(`${key}|${x}`)) continue;
    seen.add(`${key}|${x}`);
    lines.push({ key, scope: spec.scope, period: spec.period, type: spec.type, team, x, prices });
  }
  return { book: 'betrivers', eventId: e.id, game, league: path.slice(1).join(' · '), teams, start: ms(e.start), lines, players };
}
// ── Bovada (off unless BOVADA_ESPORTS=on: an offshore book) ──
// coupon/events/A/description/<event link>: [{ path, events: [{ description
// "A vs B", startTime, competitors, displayGroups: [{ description, markets:
// [{ description, period: { description "Game" | "Map N" }, outcomes: [{
// description, price: { american, handicap } }] }] }] }] }]. Same shape as
// parseKambiEsports, book 'bovada'; its list reaches past tier one (CCT,
// Challenger leagues), where BetRivers has nothing.
const BV_MARKETS = [
  [/^moneyline$/i, 'ml'], [/^(point )?spread$/i, 'spread'], [/^total$/i, 'total'],
  [/^asian handicap kills$/i, 'kspread'], [/^under\/over kills$/i, 'ktotal'],
  [/^(asian )?(handicap )?rounds?( handicap)?$/i, 'rspread'], [/^(under\/over |total )rounds$/i, 'rtotal'],
];
const bvAm = v => (/^even$/i.test(String(v || '').trim()) ? 100 : am(String(v || '').replace('+', '')));
function parseBovadaEsports(payload, now = Date.now()) {
  const node = Array.isArray(payload) ? payload[0] : null;
  const e = node?.events?.[0];
  if (!e || e.live || !(e.startTime > now)) return null;
  const path = (node.path || []).map(p => p.description);
  const game = gameOf(path.find(p => gameOf(p)) || '');
  const teams = String(e.description || '').split(/\s+vs\.?\s+/i).map(x => x.trim());
  if (!game || teams.length !== 2) return null;
  const lines = [], seen = new Set();
  const teamIdx = d => { const n = String(d || '').replace(/\s+-\s+map \d+$/i, ''); return sameT(n, teams[0]) && !sameT(n, teams[1]) ? 0 : sameT(n, teams[1]) && !sameT(n, teams[0]) ? 1 : null; };
  for (const dg of e.displayGroups || []) for (const mk of dg.markets || []) {
    if (mk.status && mk.status !== 'O') continue;
    const kind = (BV_MARKETS.find(([re]) => re.test(String(mk.description || '').trim())) || [])[1];
    const pm = /^map (\d)$/i.exec(String(mk.period?.description || ''));
    const period = /^(game|match)$/i.test(String(mk.period?.description || '')) ? 0 : pm ? +pm[1] : null;
    if (!kind || period == null) continue;
    const os = (mk.outcomes || []).filter(o => !o.status || o.status === 'O');
    const put = (scope, type, x, prices) => {
      const key = lkey(scope, scope === 'series' ? 0 : period, type, null);
      if (prices.some(p => p == null) || seen.has(`${key}|${x}`)) return;
      if (type !== 'ml' && Math.abs(Math.abs(x % 1) - 0.5) > 1e-9) return;
      seen.add(`${key}|${x}`);
      lines.push({ key, scope, period: scope === 'series' ? 0 : period, type, team: null, x, prices });
    };
    if (kind === 'ml') {
      const a = os.find(o => teamIdx(o.description) === 0), z = os.find(o => teamIdx(o.description) === 1);
      if (a && z) put(period === 0 ? 'series' : 'map', 'ml', 0, [bvAm(a.price?.american), bvAm(z.price?.american)]);
      continue;
    }
    const spread = /spread$/.test(kind), scope = kind[0] === 'k' ? 'kills' : kind[0] === 'r' ? 'rounds' : period === 0 ? 'series' : null;
    if (!scope) continue;
    if (spread) {
      for (const a of os.filter(o => teamIdx(o.description) === 0)) {
        const h = num(a.price?.handicap);
        const z = os.find(o => teamIdx(o.description) === 1 && num(o.price?.handicap) === -h);
        if (h != null && h !== 0 && z) put(scope, 'spread', h, [bvAm(a.price?.american), bvAm(z.price?.american)]);
      }
    } else {
      for (const o of os.filter(x => /^over/i.test(x.description))) {
        const L = num(o.price?.handicap);
        const u = os.find(x => /^under/i.test(x.description) && num(x.price?.handicap) === L);
        if (L != null && u) put(scope, 'total', -L, [bvAm(o.price?.american), bvAm(u.price?.american)]);
      }
    }
  }
  return { book: 'bovada', eventId: `bv-${e.id}`, game, league: path.slice(0, -1).reverse().join(' · '), teams, start: e.startTime, lines, players: [] };
}
const BOVADA = 'https://www.bovada.lv/services/sports/event/coupon/events/A/description';
async function fetchBovada(http, { max = 30, now = Date.now(), withinMs = 2 * 86400e3 } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': UA };
  const lv = await http.get(`${BOVADA}/esports?marketFilterId=def&preMatchOnly=true&lang=en`, { headers, timeout: 20000 });
  const links = (Array.isArray(lv?.data) ? lv.data : []).flatMap(x => x.events || []).filter(e => !e.live && e.startTime > now && e.startTime - now < withinMs)
    .sort((a, b) => a.startTime - b.startTime).slice(0, max).map(e => e.link);
  const out = [], errors = [];
  for (let i = 0; i < links.length; i += 4) {
    const got = await Promise.all(links.slice(i, i + 4).map(l => http.get(`${BOVADA}${l}?lang=en`, { headers, timeout: 20000 })
      .then(r => parseBovadaEsports(r?.data, now)).catch(e => { errors.push(`${l}: ${e.message}`); return null; })));
    out.push(...got.filter(Boolean));
  }
  return { events: out, listed: links.length, errors };
}

// listView payload → ids of matches not yet started, soonest first
function kambiEsportsIds(payload, { now = Date.now(), withinMs = 4 * 86400e3 } = {}) {
  return (payload?.events || []).map(x => x.event).filter(e => e && e.state === 'NOT_STARTED' && ms(e.start) > now && ms(e.start) - now < withinMs)
    .sort((a, b) => ms(a.start) - ms(b.start)).map(e => e.id);
}

// ── pairing ──
const sameT = (a, b) => teamsMatch(cleanTeam(a), cleanTeam(b));
function orient(teams, other) {
  const direct = sameT(teams[0], other[0]) && sameT(teams[1], other[1]);
  const swap = sameT(teams[0], other[1]) && sameT(teams[1], other[0]);
  return direct === swap ? null : direct ? 'same' : 'flipped';
}
// a ladder key and its points seen from the other team's side
function flipKey(key) {
  const [scope, per, type, team] = key.split('|');
  return type === 'tt' ? `${scope}|${per}|tt|${1 - Number(team)}` : key;
}
function flipPoints(key, pts) {
  const type = key.split('|')[2];
  if (type === 'ml') return pts.map(q => ({ ...q, p: 1 - q.p }));
  if (type === 'spread') return pts.map(q => ({ ...q, x: -q.x, p: 1 - q.p }));
  return pts;
}
// a source's ladders → the book's team order
function aligned(ladders, or) {
  if (or === 'same') return ladders;
  const out = new Map();
  for (const [k, pts] of ladders) out.set(flipKey(k), flipPoints(k, pts));
  return out;
}
function nearest(list, game, teams, start, hours) {
  let best = null;
  for (const m of list || []) {
    if (m.game !== game) continue;
    const or = orient(teams, m.teams);
    if (!or) continue;
    const gap = start != null && m.start != null ? Math.abs(start - m.start) : 0;
    if (gap > hours * 3600e3) continue;
    if (!best || gap < best.gap) best = { m, or, gap };
  }
  return best;
}
// the esports board's matches → Kalshi mids as ladders, in each match's own
// team order: [{ game, teams, start, ladders }]
// venue: 'kalshi' or 'polymarket' (the board quotes both; Polymarket's global
// book is the second exchange price, so a BetRivers line no longer leans on
// Pinnacle and Kalshi alone)
function kalshiLadders(boardMatches, o = DEFAULTS, venue = 'kalshi') {
  const out = [];
  for (const m of boardMatches || []) {
    if (m.live) continue;
    const ladders = new Map();
    const put = (key, x, p) => { if (!ladders.has(key)) ladders.set(key, []); ladders.get(key).push({ x, p }); };
    for (const mk of m.markets || []) {
      const q = mk.outcomes?.[0]?.quotes?.[venue];
      if (!q || !(q.bid > 0) || !(q.ask < 1) || !(q.ask > q.bid) || q.ask - q.bid > o.kalshiMaxSpread) continue;
      if (venue === 'polymarket' && q.liquidity != null && q.liquidity < o.polyMinLiquidity) continue;
      const mid = (q.bid + q.ask) / 2;
      if (mk.kind === 'match') put('series|0|ml', 0, mid);
      else if (mk.kind === 'map' && mk.n) put(`map|${mk.n}|ml`, 0, mid);
      else if (mk.kind === 'total' && mk.line != null) put('series|0|total', -mk.line, mid);
      else if (mk.kind === 'spread' && mk.line != null) {
        // outcome 0 is team t laying |line|: in team 0's handicap that's
        // x = −|line| (t 0, p) or x = +|line| (t 1, 1 − p)
        const L = Math.abs(mk.line);
        put('series|0|spread', mk.team === 0 ? -L : L, mk.team === 0 ? mid : 1 - mid);
      }
    }
    if (ladders.size) out.push({ game: m.game, teams: m.teams, start: ms(m.start), ladders });
  }
  return out;
}

// ── pricing ──
const MARKET = (scope, period, type) => (
  scope === 'series' ? { ml: 'Match', spread: 'Map handicap', total: 'Total maps' }[type]
    : scope === 'map' ? `Map ${period} winner`
      : `Map ${period} ${scope === 'kills' ? { spread: 'kill handicap', total: 'total kills', tt: 'team kills' }[type] : { spread: 'round handicap', total: 'total rounds', tt: 'team rounds' }[type]}`);
const fmtPts = x => (x > 0 ? `+${x}` : `${x}`);
function sideLabel(line, i, teams) {
  if (line.type === 'ml') return teams[i];
  if (line.type === 'spread') return `${teams[i]} ${fmtPts(i === 0 ? line.x : -line.x)}`;
  const word = i === 0 ? 'Over' : 'Under';
  return line.type === 'tt' ? `${teams[line.team]} ${word} ${-line.x}` : `${word} ${-line.x}`;
}
// one ladder at x: { p, exact, limit } (p for the ladder's own side)
function readLadder(pts, x, type, scope) {
  if (!pts?.length) return null;
  if (type === 'ml') return { p: pts[pts.length - 1].p, exact: true, limit: pts[pts.length - 1].limit ?? null };
  const hit = pts.find(q => Math.abs(q.x - x) < 1e-9);
  if (hit) return { p: hit.p, exact: true, limit: hit.limit ?? null };
  if (scope === 'series') return null;   // two or three map lines: no curve to read between
  // between two of Pinnacle's lines only, never past its last one: a LoL
  // kill handicap is flat near zero (the map winner takes the kills), so a
  // stretch from -3.5 priced FURIA +3.5 at 86% against a 69% book
  const r = ladderAt(pts, x, 1, 0);
  return r ? { ...r, limit: null } : null;
}

// books: parsed Kambi events; pin: parsePinnacle(); kalshi: kalshiLadders().
// fairs and costs (Maps) are filled for every side priced, for the tracker.
function screen({ books = [], pin = [], kalshi = [], poly = [], now = Date.now(), fairs = null, costs = null, o: opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts, weights: { ...DEFAULTS.weights, ...(opts.weights || {}) } };
  const rows = [], matched = [];
  for (const g of books || []) {
    const pm = nearest(pin, g.game, g.teams, g.start, o.pairHours);
    if (!pm) continue;
    // Pinnacle's start: Kambi listed both of tonight's Worlds play-in games 5 hours off
    const start = pm.m.start ?? g.start;
    if (!(start > now)) continue;
    const pl = aligned(pm.m.ladders, pm.or);
    const km = nearest(kalshi, g.game, g.teams, start, 6);
    const kl = km ? aligned(km.m.ladders, km.or) : new Map();
    const pmm = nearest(poly, g.game, g.teams, start, 6);
    const ql = pmm ? aligned(pmm.m.ladders, pmm.or) : new Map();
    matched.push({ eventId: g.eventId, pinId: pm.m.id, kalshi: !!km, polymarket: !!pmm, lines: g.lines.length });
    const event = `${g.teams[0]} vs ${g.teams[1]}`;
    for (const line of g.lines) {
      const pinAt = readLadder(pl.get(line.key), line.x, line.type, line.scope);
      const kalAt = readLadder(kl.get(line.key), line.x, line.type, line.scope);
      const kalExact = kalAt?.exact ? kalAt : null;
      const polAt = readLadder(ql.get(line.key), line.x, line.type, line.scope);
      const polExact = polAt?.exact ? polAt : null;
      if (!pinAt && !kalExact && !polExact) continue;
      const group = `es|${g.game}|${pm.m.id}|${line.key}|${line.x}`;
      for (const i of [0, 1]) {
        const sources = [];
        if (pinAt) sources.push({ book: 'pinnacle', p: i === 0 ? pinAt.p : 1 - pinAt.p, exact: pinAt.exact, limit: pinAt.limit });
        if (kalExact) sources.push({ book: 'kalshi', p: i === 0 ? kalExact.p : 1 - kalExact.p, exact: true });
        if (polExact) sources.push({ book: 'polymarket', p: i === 0 ? polExact.p : 1 - polExact.p, exact: true });
        const w = sources.reduce((s, x) => s + (o.weights[x.book] || 1), 0);
        const fair = sources.reduce((s, x) => s + x.p * (o.weights[x.book] || 1), 0) / w;
        const side = sideLabel(line, i, g.teams);
        if (fairs) fairs.set(`${group}|${side}`, r2(fair * 100));
        const price = line.prices[i], d = americanToDecimal(price);
        if (!d) continue;
        if (costs) costs.set(`${group}|${side}|${g.book || 'betrivers'}`, Math.round(1e4 / d) / 1e4);
        if (fair < o.minP || fair > o.maxP) continue;
        const ev = (fair * d - 1) * 100;
        if (ev < o.minEv || ev > o.maxEv) continue;
        const ps = sources.map(x => x.p);
        const spreadPts = ps.length > 1 ? r2((Math.max(...ps) - Math.min(...ps)) * 100) : null;
        const agree = ps.length > 1 && spreadPts <= o.agreePts && (Math.max(...ps) - Math.min(...ps)) <= o.agreeRel * Math.min(...ps);
        // two exact sharp prices that agree: Pinnacle (taking real size) with
        // Kalshi or Polymarket, or the two exchanges with each other
        const pinOk = pinAt?.exact && (pinAt.limit == null || pinAt.limit >= o.pinMinLimit);
        const exactN = (pinOk ? 1 : 0) + (kalExact ? 1 : 0) + (polExact ? 1 : 0);
        const clears = !!(agree && exactN >= 2 && (!pinAt || pinAt.exact));
        rows.push({
          sport: g.game.toLowerCase(), game: g.game, gameLabel: LABEL[g.game] || g.game, league: pm.m.league || g.league, event, start: new Date(start).toISOString(),
          group, market: line.key.split('|').slice(0, 3).join('|'), marketLabel: MARKET(line.scope, line.period, line.type), point: line.type === 'ml' ? null : (line.type === 'spread' ? (i === 0 ? line.x : -line.x) : -line.x),
          side, book: g.book || 'betrivers', price, decimal: Math.round(d * 1000) / 1000, fairProb: r2(fair * 100), fairPrice: probToAmerican(fair), ev: r2(ev),
          kelly: r2(Math.max(0, (fair * d - 1) / (d - 1)) * 25),
          source: clears ? 'esbook' : 'esbook-single', esports: true, clears, single: sources.length < 2, model: !sources.some(x => x.exact), agree, spreadPts,
          ...(pinAt?.limit != null ? { pinLimit: pinAt.limit } : {}),
          sharpBooks: sources.map(x => x.book),
          sources: sources.map(x => ({ book: x.book, p: r2(x.p * 100), exact: !!x.exact })),
        });
      }
    }
  }
  rows.sort((a, b) => (b.clears - a.clears) || b.ev - a.ev);
  return { rows, matched };
}

// counts for the status page and the reply
function summarize(books = [], res = { rows: [], matched: [] }, fairs = null) {
  const by = k => res.rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  const markets = {};
  for (const g of books) for (const l of g.lines) { const k = l.key.split('|')[0] + '|' + l.type; markets[k] = (markets[k] || 0) + 1; }
  return {
    events: books.length, lines: books.reduce((s, g) => s + g.lines.length, 0), matched: res.matched.length, withKalshi: res.matched.filter(m => m.kalshi).length,
    withPolymarket: res.matched.filter(m => m.polymarket).length, clearBySources: res.rows.filter(r => r.clears).reduce((m, r) => { const k = r.sharpBooks.join('+'); m[k] = (m[k] || 0) + 1; return m; }, {}),
    priced: fairs ? [...fairs.keys()].filter(k => k.startsWith('es|')).length : null,
    shown: res.rows.length, clear: res.rows.filter(r => r.clears).length, byGame: by('game'), byMarket: by('marketLabel'), linesByMarket: markets,
  };
}

// ── fetching ──
async function fetchPinnacle(http, key = '') {
  const headers = { Accept: 'application/json', 'User-Agent': UA, ...(key ? { 'X-API-Key': key } : {}) };
  const [mu, mk] = await Promise.all([
    http.get(`${PIN}/sports/12/matchups`, { headers, timeout: 20000 }),
    http.get(`${PIN}/sports/12/markets/straight`, { headers, timeout: 20000 }),
  ]);
  return parsePinnacle(mu?.data, mk?.data);
}
async function fetchKambi(http, { max = 30, now = Date.now() } = {}) {
  const q = 'lang=en_US&market=US';
  const headers = { Accept: 'application/json', 'User-Agent': UA };
  const lv = await http.get(`${KAMBI}/listView/esports/all/all/all/matches.json?${q}&useCombined=true`, { headers, timeout: 20000 });
  const ids = kambiEsportsIds(lv?.data, { now }).slice(0, max);
  const out = [], errors = [];
  for (let i = 0; i < ids.length; i += 4) {
    const got = await Promise.all(ids.slice(i, i + 4).map(id => http.get(`${KAMBI}/betoffer/event/${id}.json?${q}&includeParticipants=true`, { headers, timeout: 20000 })
      .then(r => parseKambiEsports(r?.data, now)).catch(e => { errors.push(`${id}: ${e.message}`); return null; })));
    out.push(...got.filter(Boolean));
  }
  return { events: out, listed: ids.length, errors };
}

module.exports = { parseBovadaEsports, fetchBovada, DEFAULTS, KAMBI, LABEL, cleanTeam, gameOf, parsePinnacle, parseKambiEsports, kambiEsportsIds, kalshiLadders, aligned, orient, readLadder, screen, summarize, fetchPinnacle, fetchKambi };
