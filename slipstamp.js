// ─── SLIP STAMP: A SLIP CHECKED BY THE SERVER AT THE MOMENT IT IS LOGGED ─────
// A slip logged from a board row, the esports slip or a copied app slip goes
// through POST /api/slips/stamp before MY SLIPS keeps it. The server logs each
// leg in the slip log at this moment (so its sharp price is followed from now
// to the close) and answers, leg by leg, in plain words:
//
//   ok         the leg's game starts after now: logged, with the server time,
//              the start, the app's own line and multiplier on the board now,
//              the sharp fair at the leg's line and Pinnacle's own fair when
//              Pinnacle hangs that exact line
//   started    the game had started: the slip is refused, never kept to show
//              up LATE on a public record later
//   unmatched  no board lists the leg right now, so its start can't be
//              checked here: it can be logged, and the record grades its
//              timing when the box score finds the game (the bettor is told so)
//
// Pure: the server hands in the slip log's answers and the board lookups.

const MAX_LEGS = 12;

const WHY = {
  player: "isn't on any app's board right now, so its start can't be checked here",
  market: "is on the board, but not that stat, so its start can't be checked here",
  esports: "isn't on the esports board right now, so its start can't be checked here",
  unread: "couldn't be read as a pick (Player Over 24.5 Stat)",
};

// '7:20 PM ET' (the board's times are UTC; US apps show Eastern)
function etTime(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const o = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' };
  const sameDay = new Date(t).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return `${sameDay ? '' : `${new Date(t).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}, `}${new Date(t).toLocaleTimeString('en-US', o)} ET`;
}

const legName = l => `${String(l.player || '').trim()} ${l.side === 'Under' ? 'Under' : 'Over'} ${l.line} ${String(l.market || '').trim()}`.replace(/\s+/g, ' ');

// one leg + its slip-log answer (+ the board's extras) → the stamp's verdict
function verdict(leg, g, { now = Date.now(), extra = null } = {}) {
  const name = legName(leg);
  const start = g?.matched?.start || null;
  const st = Date.parse(start || '');
  const title = g?.matched?.matchTitle || '';
  if (Number.isFinite(st) && st <= now) {
    return { status: 'started', start, matchTitle: title,
      why: `${name}: ${title ? `${title} ` : 'its game '}started at ${etTime(start, now)}. A leg goes on your record only before its game starts.` };
  }
  if (g?.status === 'nohistory' && g.reason === 'before') {
    return { status: 'started', start, matchTitle: title, why: `${name}: its game had already started. A leg goes on your record only before its game starts.` };
  }
  // the browser's own start for a leg no board lists now (a row tapped minutes ago)
  const own = Date.parse(leg.start || '');
  if (!Number.isFinite(st) && Number.isFinite(own) && own <= now) {
    return { status: 'started', start: leg.start, matchTitle: '', why: `${name}: its game started at ${etTime(leg.start, now)}. A leg goes on your record only before its game starts.` };
  }
  if (Number.isFinite(st)) {
    const e = extra || {};
    return { status: 'ok', start, matchTitle: title, sport: g.matched.sport || null, esports: !!g.esports,
      fair: g.signalFair ?? null, decimal: g.decimal ?? null, trackedAt: g.trackedAt || null,
      appLine: e.appLine ?? null, mult: e.mult ?? null, pin: e.pin ?? null,
      // the app moved off the number the leg was tapped at
      ...(e.appLine != null && e.appLine !== Number(leg.line) ? { moved: `the app shows ${e.appLine} now, not ${leg.line}` } : {}) };
  }
  const reason = g?.reason && WHY[g.reason] ? g.reason : 'player';
  return { status: reason === 'unread' ? 'unread' : 'unmatched', reason,
    why: `${name} ${WHY[reason]}.${reason === 'unread' ? '' : ' It can still be logged: the record checks its start from the box score, and a leg whose game had already started shows LATE and isn\'t counted.'}` };
}

// the slip's legs and their verdicts → the answer
function stamp(legs, verdicts, { now = Date.now() } = {}) {
  const out = legs.map((l, i) => ({ i, player: l.player, market: l.market, side: l.side, line: Number(l.line), ...verdicts[i] }));
  const started = out.filter(l => l.status === 'started');
  const unread = out.filter(l => l.status === 'unread');
  return {
    at: new Date(now).toISOString(),
    ok: !started.length && !unread.length,
    started: started.length, unmatched: out.filter(l => l.status === 'unmatched').length,
    why: started.length ? started.map(l => l.why).join(' ') : unread.length ? unread.map(l => l.why).join(' ') : null,
    legs: out,
  };
}

// a request body → clean legs, or { error }
function cleanLegs(body) {
  const legs = Array.isArray(body?.legs) ? body.legs : null;
  if (!legs || !legs.length) return { error: 'legs needed' };
  if (legs.length > MAX_LEGS) return { error: `at most ${MAX_LEGS} legs a slip` };
  const app = String(body.app || '').toLowerCase().slice(0, 20);
  return { app, legs: legs.map(l => ({
    player: String(l?.player || '').slice(0, 80), market: String(l?.market || '').slice(0, 60),
    side: /^(under|less|lower|u)$/i.test(String(l?.side || '')) ? 'Under' : /^(over|more|higher|o)$/i.test(String(l?.side || '')) ? 'Over' : null,
    line: Number(l?.line), ...(l?.sport ? { sport: String(l.sport).slice(0, 12) } : {}), ...(l?.opp ? { opp: String(l.opp).slice(0, 40) } : {}),
    ...(l?.start && Number.isFinite(Date.parse(l.start)) ? { start: new Date(Date.parse(l.start)).toISOString() } : {}),
  })) };
}

module.exports = { verdict, stamp, cleanLegs, etTime, legName, MAX_LEGS };
