// ─── PINNACLE TENNIS AND UFC LINES AS PICK'EM FAIRS ───────────────────────────
// Pinnacle posts no player props for tennis or MMA, but its match markets are
// the same bets the pick'em apps list per player:
//   Tennis (the "Games" child matchup): total games → Games Played / Total
//   Games, each player's team total → Games Won, the first set's total → 1st
//   Set Games Played. The set matchup: total sets → Sets Played, a player's
//   +1.5 sets → Sets Won over 0.5, the moneyline → Sets Won over 1.5 (best
//   of three).
//   MMA: total rounds → Fight Time in minutes (Pinnacle's 2.5 rounds is 2:30
//   of round 3, so 12.5 minutes), for both fighters.
// Every line Pinnacle hangs (alternates too) becomes a quote in pinprops'
// shape, so the board prices them exactly like an NFL prop. Pure parsers;
// fetch is a thin wrapper over the same guest feed.

const { canonName } = require('./ev');
const { devigPower } = require('./pinprops');

const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const SPORTS = { TENNIS: 33, MMA: 22 };
const toProb = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

// two prices → P(first) with the vig out, or null
function pair(a, b) {
  const pa = toProb(Number(a)), pb = toProb(Number(b));
  if (!(pa > 0 && pb > 0) || pa + pb < 1) return null;
  return devigPower(pa, pb);
}
const quote = (sport, player, mkey, line, pOver, start, extra = {}) => ({
  sport, player, mkey, key: `${sport}|${canonName(player)}|${mkey}`, line: +line, pOver: +pOver.toFixed(4), start, ...extra,
});
const byDesig = (prices, d) => (prices || []).find(p => p.designation === d);

// Tennis: matchups + straight markets for sport 33 → quotes
function parseTennis(matchups, markets, now = Date.now()) {
  const byId = new Map((matchups || []).map(m => [m.id, m]));
  const out = [];
  for (const mk of markets || []) {
    const mu = byId.get(mk.matchupId);
    if (!mu || mu.type !== 'matchup') continue;
    const top = mu.parentId ? byId.get(mu.parentId) : mu;
    if (!top) continue;
    const start = Date.parse(top.startTime || mu.startTime || '');
    if (!(start > now)) continue;
    const parts = top.participants || [];
    const home = parts.find(p => p.alignment === 'home')?.name, away = parts.find(p => p.alignment === 'away')?.name;
    // doubles teams ("Harrison C / Skupski N") never match a pick'em player
    if (!home || !away || /\//.test(home + away)) continue;
    const iso = new Date(start).toISOString();
    const both = (mkey, line, p) => { out.push(quote('TENNIS', home, mkey, line, p, iso)); out.push(quote('TENNIS', away, mkey, line, p, iso)); };
    const units = mu.units || '';
    if (units === 'Games') {
      if (mk.type === 'total' && (mk.period === 0 || mk.period === 1)) {
        const o = byDesig(mk.prices, 'over'), u = byDesig(mk.prices, 'under');
        if (!o || !u || o.points == null || o.points !== u.points) continue;
        const p = pair(o.price, u.price);
        if (p != null) both(mk.period === 0 ? 'games_played' : '1st_set_games_played', o.points, p);
      } else if (mk.type === 'team_total' && mk.period === 0 && (mk.side === 'home' || mk.side === 'away')) {
        const o = byDesig(mk.prices, 'over'), u = byDesig(mk.prices, 'under');
        if (!o || !u || o.points == null || o.points !== u.points) continue;
        const p = pair(o.price, u.price);
        if (p != null) out.push(quote('TENNIS', mk.side === 'home' ? home : away, 'games_won', o.points, p, iso));
      }
    } else if (units === 'Sets' && !mu.parentId && mk.period === 0) {
      const best = top.bestOfX || top.league?.bestOfX || 3;
      if (mk.type === 'total') {
        const o = byDesig(mk.prices, 'over'), u = byDesig(mk.prices, 'under');
        if (!o || !u || o.points == null || o.points !== u.points) continue;
        const p = pair(o.price, u.price);
        if (p != null) both('sets_played', o.points, p);
      } else if (mk.type === 'moneyline' && best === 3) {
        const h = byDesig(mk.prices, 'home'), a = byDesig(mk.prices, 'away');
        const p = h && a ? pair(h.price, a.price) : null;
        if (p != null) { out.push(quote('TENNIS', home, 'sets_won', 1.5, p, iso)); out.push(quote('TENNIS', away, 'sets_won', 1.5, 1 - p, iso)); }
      } else if (mk.type === 'spread' && best === 3) {
        // the +1.5 side wins a set or more: Sets Won over 0.5
        const h = byDesig(mk.prices, 'home'), a = byDesig(mk.prices, 'away');
        if (!h || !a || Math.abs(h.points) !== 1.5 || h.points !== -a.points) continue;
        const p = pair(h.price, a.price);
        if (p == null) continue;
        if (h.points === 1.5) out.push(quote('TENNIS', home, 'sets_won', 0.5, p, iso));
        else out.push(quote('TENNIS', away, 'sets_won', 0.5, 1 - p, iso));
      }
    }
  }
  return dedupe(out);
}

// MMA: total rounds → Fight Time (minutes) for both fighters
function parseMma(matchups, markets, now = Date.now()) {
  const byId = new Map((matchups || []).map(m => [m.id, m]));
  const out = [];
  for (const mk of markets || []) {
    if (mk.type !== 'total' || mk.period !== 0) continue;
    const mu = byId.get(mk.matchupId);
    if (!mu || mu.type !== 'matchup' || mu.parentId) continue;
    const start = Date.parse(mu.startTime || '');
    if (!(start > now)) continue;
    const o = byDesig(mk.prices, 'over'), u = byDesig(mk.prices, 'under');
    if (!o || !u || o.points == null || o.points !== u.points || o.points % 1 !== 0.5) continue;
    const p = pair(o.price, u.price);
    if (p == null) continue;
    const iso = new Date(start).toISOString(), minutes = o.points * 5;
    for (const f of mu.participants || []) if (f.name) out.push(quote('MMA', f.name, 'fight_time', minutes, p, iso, { rounds: o.points }));
  }
  return dedupe(out);
}

// MMA fights for the UFC model (ufcboard.js): each fight's no-vig moneyline
// and main total rounds (the line nearest 50/50), the league, and whether it
// is the card's main event (the last start on its day in its league).
// → [{ id, league, start, home, away, pHome, rounds, pOver, over, under, ml: { home, away }, mainEvent }]
function parseMmaFights(matchups, markets, now = Date.now()) {
  const byId = new Map((matchups || []).filter(m => m.type === 'matchup' && !m.parentId).map(m => [m.id, m]));
  const fights = new Map();
  for (const mu of byId.values()) {
    const start = Date.parse(mu.startTime || '');
    const parts = mu.participants || [];
    const home = parts.find(p => p.alignment === 'home')?.name, away = parts.find(p => p.alignment === 'away')?.name;
    if (!(start > now) || !home || !away) continue;
    fights.set(mu.id, { id: mu.id, league: mu.league?.name || '', start: new Date(start).toISOString(), home, away, pHome: null, rounds: null, pOver: null, over: null, under: null, ml: null, mainEvent: false });
  }
  const totals = new Map();
  for (const mk of markets || []) {
    const f = fights.get(mk.matchupId);
    if (!f || mk.period !== 0) continue;
    if (mk.type === 'moneyline') {
      const h = byDesig(mk.prices, 'home'), a = byDesig(mk.prices, 'away');
      const p = h && a ? pair(h.price, a.price) : null;
      if (p != null) { f.pHome = +p.toFixed(4); f.ml = { home: h.price, away: a.price }; }
    } else if (mk.type === 'total') {
      const o = byDesig(mk.prices, 'over'), u = byDesig(mk.prices, 'under');
      if (!o || !u || o.points == null || o.points !== u.points || o.points % 1 !== 0.5) continue;
      const p = pair(o.price, u.price);
      if (p == null) continue;
      if (!totals.has(f.id)) totals.set(f.id, []);
      totals.get(f.id).push({ rounds: o.points, pOver: p, over: o.price, under: u.price, alt: !!mk.isAlternate });
    }
  }
  for (const [id, list] of totals) {
    const main = list.filter(t => !t.alt).length ? list.filter(t => !t.alt) : list;
    const t = main.reduce((a, b) => (Math.abs(b.pOver - 0.5) < Math.abs(a.pOver - 0.5) ? b : a));
    Object.assign(fights.get(id), { rounds: t.rounds, pOver: +t.pOver.toFixed(4), over: t.over, under: t.under });
  }
  const out = [...fights.values()];
  // a card: one league's fights within 10 hours of the one before; its main
  // event is the last start, named only when 5+ of the card's fights are up
  const byLeague = new Map();
  for (const f of out) { if (!byLeague.has(f.league)) byLeague.set(f.league, []); byLeague.get(f.league).push(f); }
  for (const list of byLeague.values()) {
    list.sort((a, b) => (a.start < b.start ? -1 : 1));
    let card = [];
    // (a start shared by two fights is a placeholder: no main event named)
    const close = () => { const l = card[card.length - 1]; if (card.length >= 5 && card.filter(f => f.start === l.start).length === 1) l.mainEvent = true; card = []; };
    for (const f of list) { if (card.length && Date.parse(f.start) - Date.parse(card[card.length - 1].start) > 10 * 3600e3) close(); card.push(f); }
    close();
  }
  return out;
}

// one quote per key, line and game (Pinnacle can list a line twice)
function dedupe(qs) {
  const seen = new Set();
  return qs.filter(q => { const k = `${q.key}|${q.line}|${q.start}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function fetchPinnacleExtra(http, key = '') {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(key ? { 'X-API-Key': key } : {}) };
  const props = [], errors = [], mmaFights = [];
  for (const [sport, id] of Object.entries(SPORTS)) {
    try {
      const [mu, mk] = await Promise.all([
        http.get(`${PIN}/sports/${id}/matchups`, { headers, timeout: 30000 }),
        http.get(`${PIN}/sports/${id}/markets/straight`, { headers, timeout: 30000 }),
      ]);
      props.push(...(sport === 'TENNIS' ? parseTennis : parseMma)(mu?.data, mk?.data));
      if (sport === 'MMA') mmaFights.push(...parseMmaFights(mu?.data, mk?.data));
    } catch (e) { errors.push(`${sport}: ${e.response?.status || e.message}`); }
  }
  return { props, errors, mmaFights };
}

module.exports = { SPORTS, parseTennis, parseMma, parseMmaFights, fetchPinnacleExtra };
