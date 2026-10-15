// ─── MY SLIPS, ESPORTS LEGS ──────────────────────────────────────────────────
// A pasted slip line or Pikkit row for a CS2, LoL, Valorant or Dota player's
// kills, headshots or assists (one map or a span of maps) is matched to the
// esports board's pick for that player, match and stat, then followed like
// the esports record follows its own picks: the books' consensus price of the
// leg at the user's own line when we first saw it and at the close, the app's
// line at the close, and the match stats once it is over (tracker.js,
// graders). The record is its own (esports-slip-legs): the legs are the same
// for everyone who sends them (app, player, stat, side, line, match), never
// the people.
//
// Esports has no Pinnacle player line, so the price is the books' consensus
// on the board's curve (server marketFairProb), the same market price the
// esports record's CLV uses. It says so on the leg.
//
// A player in two or three matches on one day has one board pick per match
// (esmatch.js). The slip names the opponent ("vs G2"); with none, the match
// whose posted line equals the leg's line is taken and the leg is marked
// "match uncertain". A leg we can't place says why, never a guess:
//   'before'   the match started before the leg reached us
//   'player'   no esports line for that player near the bet's time
//   'market'   the player is listed, that stat or map span isn't
//   'match'    two matches fit and nothing in the leg tells them apart

const { statKind, sportKey } = require('./tracker');
const { pickOpponent, sameTeam, looseTeam } = require('./esmatch');
const { legDecimal: appLegDecimal } = require('./sporttrack');
const { legDecimal: slipLegDecimal } = require('./slips');

const ES_SPORTS = new Set(['CS', 'LOL', 'VAL', 'DOTA', 'COD']);
const BEFORE_MS = 60 * 60e3, AFTER_MS = 7 * 86400e3;
const BOOK = { prizepicks: 'PP', underdog: 'UD', sleeper: 'SL' };
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sideOf = s => (/^(over|more|higher|o)$/i.test(String(s || '')) ? 'OVER' : /^(under|less|lower|u)$/i.test(String(s || '')) ? 'UNDER' : null);
const sameLine = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;

// does the leg's sport tag name an esport
const isEsportsLeg = leg => !!leg?.sport && ES_SPORTS.has(sportKey(leg.sport));
// a stat we price: kills, headshots, assists
const knownStat = market => /kill|head\s?shot|\bhs\b|assist/i.test(String(market || '')) && !/fantasy/i.test(String(market || ''));
// the maps a market text names ("MAPS 1-2 Kills"), else null
const hasSpan = market => /\b(?:maps?|games?)\s*\d/i.test(String(market || ''));

// the app's own line on a board pick, or null where that app doesn't list it
function appLine(p, app) {
  if (app === 'prizepicks') return p.lineSource === 'pp' ? p.ppLine : null;
  if (app === 'underdog') return p.udLine;
  if (app === 'sleeper') return p.sleeperLine;
  return [p.lineSource === 'pp' ? p.ppLine : null, p.udLine, p.sleeperLine].find(x => x != null) ?? null;
}
const anyLine = (p, line) => [p.lineSource === 'pp' ? p.ppLine : null, p.udLine, p.sleeperLine, p.ppLine].some(x => sameLine(x, line));

// the opponent a pick names fits the one on the slip: "G2", "G2 Esports", "NaVi" / "Natus Vincere"
function oppFits(p, name) {
  const o = pickOpponent(p);
  if (!o || !name) return false;
  return sameTeam(o, name) || looseTeam(o, name) || sq(o) === sq(name) || (sq(name).length >= 3 && (sq(o).includes(sq(name)) || sq(name).includes(sq(o))));
}

const matchId = p => p.matchTag || (p.gameId != null && p.gameId !== '' ? `g:${p.gameId}` : `t:${String(p.startTime || '').slice(0, 13)}|${sq(p.matchTitle)}`);

// one leg → { pick, uncertain } or { reason, near? }.
// picks: the esports board; normalizeName / parseMapSpan are the server's.
function matchEsLeg(leg, picks, { now = Date.now(), normalizeName, parseMapSpan }) {
  const sport = leg.sport ? sportKey(leg.sport) : null;
  const name = normalizeName(leg.player);
  const betAt = Date.parse(leg.betAt || '') || now;
  let cands = (picks || []).filter(p => normalizeName(p.player) === name && (!sport || sportKey(p.sport) === sport));
  cands = cands.filter(p => { const s = Date.parse(p.startTime); return s >= betAt - BEFORE_MS && s <= betAt + AFTER_MS; });
  if (!cands.length) return { reason: 'player' };
  if (!knownStat(leg.market)) return { reason: 'market', near: [...new Set(cands.map(p => p.displayMarket || p.market))].slice(0, 6) };
  const stat = statKind(leg.market), span = hasSpan(leg.market) ? parseMapSpan(leg.market).label : null;
  const hit = cands.filter(p => statKind(p.market) === stat && (!span || parseMapSpan(p.market).label === span));
  if (!hit.length) return { reason: 'market', near: [...new Set(cands.map(p => p.displayMarket || p.market))].slice(0, 6) };

  // one match per group
  const byMatch = new Map();
  for (const p of hit) { const k = matchId(p); (byMatch.get(k) || byMatch.set(k, []).get(k)).push(p); }
  let groups = [...byMatch.values()];
  let uncertain = false;
  if (groups.length > 1) {
    const withOpp = leg.opp ? groups.filter(g => g.some(p => oppFits(p, leg.opp))) : [];
    if (withOpp.length === 1) groups = withOpp;
    else if (leg.opp) return { reason: 'match', near: groups.map(g => pickOpponent(g[0])).filter(Boolean).slice(0, 4), opp: leg.opp };
    else {
      // no opponent named: the match whose posted line is the leg's line
      const sameLn = groups.filter(g => g.some(p => anyLine(p, leg.line)));
      if (sameLn.length !== 1) return { reason: 'match', near: groups.map(g => pickOpponent(g[0])).filter(Boolean).slice(0, 4) };
      groups = sameLn;
      uncertain = true;
    }
  }
  // within the match, the span the leg's line sits on when the text named none
  const g = groups[0];
  let pick = g.find(p => sameLine(appLine(p, leg.app), leg.line)) || g.find(p => anyLine(p, leg.line));
  if (!pick) {
    if (new Set(g.map(p => parseMapSpan(p.market).label)).size > 1) return { reason: 'market', near: [...new Set(g.map(p => p.displayMarket || p.market))].slice(0, 6) };
    pick = g[0];
  }
  return { pick, uncertain };
}

// What the leg pays per unit if it wins: the app's own multiplier where its
// board cell sits on the leg's line, else the app's break-even.
function legPayout(pick, app, side, line) {
  if (app === 'underdog' && sameLine(pick.udLine, line) && pick.udSides) {
    const m = Number(side === 'OVER' ? pick.udSides.over : pick.udSides.under);
    if (m > 0) return r4(appLegDecimal('underdog', m));
  }
  if (app === 'sleeper' && sameLine(pick.sleeperLine, line) && pick.slSides) {
    const m = Number(side === 'OVER' ? pick.slSides.over : pick.slSides.under);
    if (m > 1) return r4(appLegDecimal('sleeper', m));
  }
  return slipLegDecimal(app);
}

// the board pick as the tracker takes it for this leg: the leg's own side and
// line on its app, a key of its own so every (app, side, line) ticket is a row
function legPick(pick, leg) {
  const app = String(leg.app || '').toLowerCase();
  const book = BOOK[app] || 'PP';
  const side = sideOf(leg.side), line = Number(leg.line);
  const slipKey = `${app}|${side}|${line}|${pick.matchTag || ''}`;
  return {
    ...pick, side, bestBook: book, bestEv: 0, prob: null, ev: null, lineGap: null, matchupLed: null,
    ...(book === 'UD' ? { udLine: line } : book === 'SL' ? { sleeperLine: line } : { ppLine: line, lineSource: 'pp' }),
    slipKey,
    trackExtra: { slipKey, slipApp: app, signalDecimal: legPayout(pick, app, side, line) },
  };
}

// a tracked row → what MY SLIPS shows for the leg
function view(b, { uncertain = false } = {}) {
  const open = b.status === 'open';
  const status = b.status === 'review' ? 'locked' : b.status;
  const dec = b.signalDecimal;
  const start = Date.parse(b.startTime || ''), closeAt = Date.parse(b.closeAt || '');
  const age = Number.isFinite(start) && Number.isFinite(closeAt) ? r2((start - closeAt) / 60e3) : null;
  const priced = b.signalFair != null && b.closeFair != null;
  const ownBook = ['PP', 'UD', 'SL'].includes(b.signalBook) && ['prizepicks', 'underdog', 'sleeper'].includes(b.slipApp);
  return {
    id: undefined, esports: true, status, final: b.status === 'graded' || b.status === 'void',
    matched: { sport: b.sport, player: b.player, market: b.displayMarket || b.market, mkey: null, start: b.startTime, matchTitle: b.matchTitle || '' },
    matchUncertain: uncertain || undefined,
    trackedAt: b.signalAt, decimal: dec, signalFair: b.signalFair, closeFair: b.closeFair,
    closeEv: open || b.closeFair == null ? null : r2((b.closeFair * dec - 1) * 100),
    evNow: open && b.closeFair != null ? r2((b.closeFair * dec - 1) * 100) : null,
    fairMove: priced ? r2((b.closeFair - b.signalFair) * 100) : null,
    closeOk: open ? null : age != null ? age <= 60 : null, closeAgeMin: open ? null : age,
    appClose: ownBook ? b.closeLine ?? null : null,
    lineMove: ownBook && b.closeLine != null && b.closeLine !== b.signalLine ? r4(b.clv ?? 0) : null,
    closeLines: b.closeLines || null,
    outcome: b.outcome || null, result: b.result ?? null, voidReason: b.status === 'void' ? b.note || 'voided' : null,
  };
}

// tracker: tracker.js createTracker with idSuffix = p => p.slipKey
// prepare(synthetic, original): the server's hook to carry the original pick's pricing context over
function createEsSlipLog({ tracker, normalizeName, parseMapSpan, prepare = () => {}, now = () => Date.now() }) {
  const byId = async () => new Map((await tracker.list({ limit: 1e9 })).map(b => [b.id, b]));

  // legs: [{ id, app, sport, player, market, side, line, betAt, opp? }] → { results }
  async function grade(legs, { picks = [] } = {}) {
    const t = now();
    const known = await byId();
    const results = {}, fresh = [];
    for (const leg of legs || []) {
      const id = String(leg?.id || '').slice(0, 200);
      const side = sideOf(leg?.side), line = Number(leg?.line);
      if (!id || !side || !Number.isFinite(line) || !leg.player || !leg.market) { if (id) results[id] = { id, status: 'nohistory', reason: 'unread', final: true }; continue; }
      const L = { ...leg, app: String(leg.app || '').toLowerCase(), side, line };
      const m = matchEsLeg(L, picks, { now: t, normalizeName, parseMapSpan });
      if (!m.pick) {
        const betAt = Date.parse(leg.betAt || '') || t;
        results[id] = { id, status: 'nohistory', reason: m.reason === 'player' && t - betAt > AFTER_MS ? 'before' : m.reason, near: m.near || null, opp: m.opp || null, esports: true, final: t - betAt > AFTER_MS };
        continue;
      }
      const sp = legPick(m.pick, L);
      const tid = tracker.pickId(sp);
      const b = known.get(tid);
      if (b) { results[id] = { ...view(b, { uncertain: m.uncertain }), id }; continue; }
      if (!(Date.parse(m.pick.startTime) > t)) { results[id] = { id, status: 'nohistory', reason: 'before', esports: true, final: true, matched: { sport: m.pick.sport, player: m.pick.player, market: m.pick.displayMarket || m.pick.market, start: m.pick.startTime, matchTitle: m.pick.matchTitle || '' } }; continue; }
      prepare(sp, m.pick);
      fresh.push({ id, tid, sp, uncertain: m.uncertain });
    }
    if (fresh.length) {
      await tracker.recordBoard(fresh.map(f => f.sp));
      const after = await byId();
      for (const f of fresh) { const b = after.get(f.tid); results[f.id] = b ? { ...view(b, { uncertain: f.uncertain }), id: f.id } : { id: f.id, status: 'nohistory', reason: 'before', esports: true, final: true }; }
    }
    return { results, at: new Date(t).toISOString() };
  }

  // the board's current picks for every open row, so each follows its own app's line and the close price
  async function follow(picks) {
    const open = await tracker.list({ status: 'open', limit: 1e9 });
    if (!open.length) return [];
    const idx = new Map();
    for (const p of picks || []) { const k = `${sportKey(p.sport)}|${normalizeName(p.player)}|${statKind(p.market)}|${parseMapSpan(p.market).label}`; (idx.get(k) || idx.set(k, []).get(k)).push(p); }
    const out = [];
    for (const r of open) {
      const list = idx.get(`${r.sport}|${normalizeName(r.player)}|${r.stat}|${parseMapSpan(r.market).label}`) || [];
      const p = list.find(x => (r.matchTag && x.matchTag === r.matchTag) || (r.gameId != null && x.gameId != null && String(x.gameId) === String(r.gameId))) || (!r.matchTag && list.length === 1 ? list[0] : null);
      if (!p) continue;
      // the row follows its own app's line: a Sleeper row whose Sleeper line is gone must not close on PrizePicks' number
      const need = r.signalBook === 'UD' ? p.udLine : r.signalBook === 'SL' ? p.sleeperLine : r.slipApp === 'prizepicks' && p.lineSource !== 'pp' ? null : p.ppLine;
      if (need == null) continue;
      const sp = { ...p, side: null, bestEv: null, slipKey: r.slipKey };
      prepare(sp, p);
      out.push(sp);
    }
    if (out.length) await tracker.recordBoard(out);
    return out;
  }
  return { grade, follow, tracker };
}

module.exports = { createEsSlipLog, matchEsLeg, legPick, legPayout, view, isEsportsLeg, knownStat, oppFits, ES_SPORTS };
