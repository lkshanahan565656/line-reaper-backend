// ─── ALERTS ───────────────────────────────────────────────────────────────────
// Watching a board refresh every five minutes is the job people pay to stop
// doing. After each refresh we diff the new board against the last one and
// raise three kinds of event:
//
//   edge      a pick crossed ALERT_MIN_EV (new to the board, or newly +EV)
//   move      the line moved on a pick that is +EV, or was +EV last refresh.
//             "with" means the market moved toward our side (the edge was
//             real and is shrinking: play now); "against" means away from it.
//   gone      a pick that was alerting fell back below the threshold or left
//
// Each pick alerts at most once per COOLDOWN for the same kind, so a line that
// flickers between two numbers doesn't spam the channel.

const DEFAULTS = {
  minEv: 5,             // % EV to call it an edge
  moveMinEv: 2,         // only report moves on picks at least this good
  cooldownMs: 30 * 60000,
  maxRecent: 200,
};

function keyOf(p) {
  return `${(p.player || '').toLowerCase()}|${(p.market || '').toLowerCase()}|${p.startTime || ''}`;
}

function lineOf(p) {
  return p.bestBook === 'UD' && p.udLine != null ? p.udLine : p.ppLine;
}

// Pure: previous board + new board → events. `seen` tracks cooldowns.
function diffBoards(prev, next, { minEv, moveMinEv, cooldownMs, now = Date.now(), seen = new Map() } = {}) {
  minEv ??= DEFAULTS.minEv;
  moveMinEv ??= DEFAULTS.moveMinEv;
  cooldownMs ??= DEFAULTS.cooldownMs;
  const before = new Map((prev || []).map(p => [keyOf(p), p]));
  const after = new Map((next || []).map(p => [keyOf(p), p]));
  const events = [];
  const fire = (kind, p, extra = {}) => {
    const k = `${kind}|${keyOf(p)}`;
    const last = seen.get(k);
    if (last != null && now - last < cooldownMs) return;
    seen.set(k, now);
    events.push({
      kind, at: new Date(now).toISOString(),
      sport: p.sport, player: p.player, team: p.team || '', market: p.displayMarket || p.market,
      side: p.side, line: lineOf(p), ev: p.bestEv, prob: p.prob, book: p.bestBook,
      startTime: p.startTime, context: p.context ? { opponent: p.context.opponent, pMap: p.context.pMap } : null,
      ...extra,
    });
  };

  for (const [k, p] of after) {
    if (!p.startTime || new Date(p.startTime).getTime() <= now) continue;   // live or over
    const old = before.get(k);
    const ev = p.bestEv ?? -Infinity, oldEv = old?.bestEv ?? -Infinity;

    if (ev >= minEv && (!old || oldEv < minEv)) fire('edge', p, { previousEv: old?.bestEv ?? null });

    const line = lineOf(p), oldLine = old ? lineOf(old) : null;
    if (old && line != null && oldLine != null && line !== oldLine && (ev >= moveMinEv || oldEv >= moveMinEv)) {
      // which way is "with" us depends on the side we were on before the move
      const side = old.side || p.side;
      const delta = line - oldLine;
      const toward = side === 'OVER' ? delta > 0 : delta < 0;
      fire('move', p, { from: oldLine, to: line, direction: toward ? 'with' : 'against', previousEv: old.bestEv, sideFlipped: !!(old.side && p.side && old.side !== p.side) });
    }

    if (old && oldEv >= minEv && ev < minEv) fire('gone', p, { previousEv: old.bestEv });
  }
  for (const [k, old] of before) {
    if (after.has(k)) continue;
    if ((old.bestEv ?? -Infinity) >= minEv && old.startTime && new Date(old.startTime).getTime() > now) {
      fire('gone', old, { previousEv: old.bestEv, removed: true });
    }
  }
  return events;
}

function describe(e) {
  const pct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const who = `${e.player} ${e.side || ''} ${e.line} ${e.market} (${e.sport}${e.book ? ', ' + e.book : ''})`;
  if (e.kind === 'edge') return `🎯 New edge ${pct(e.ev)}: ${who}`;
  if (e.kind === 'move') {
    const arrow = e.to > e.from ? '↑' : '↓';
    const note = e.direction === 'with' ? 'market moving our way, edge shrinking' : 'market moving away, edge growing';
    return `📈 Line ${arrow} ${e.from} → ${e.to}: ${e.player} ${e.market} · ${note} · now ${pct(e.ev)}${e.sideFlipped ? ' · SIDE FLIPPED' : ''}`;
  }
  return `⛔ Edge gone: ${e.player} ${e.market} (was ${pct(e.previousEv)}${e.removed ? ', pulled from the board' : ''})`;
}

// Discord-compatible webhook body. One message per refresh, up to 10 lines,
// so a big slate doesn't turn into a wall of posts.
function webhookBody(events) {
  const lines = events.slice(0, 10).map(describe);
  if (events.length > 10) lines.push(`…and ${events.length - 10} more`);
  return { username: 'Line Reaper', content: lines.join('\n') };
}

function createAlerter({ minEv, moveMinEv, cooldownMs, maxRecent = DEFAULTS.maxRecent, send, now = () => Date.now(), log = console } = {}) {
  let prev = null;
  const seen = new Map();
  const recent = [];
  const listeners = new Set();
  return {
    // Feed every new board here. The first board only primes the diff:
    // a restart shouldn't announce the whole slate as new.
    async onBoard(picks) {
      if (prev == null) { prev = picks.slice(); return []; }
      const events = diffBoards(prev, picks, { minEv, moveMinEv, cooldownMs, now: now(), seen });
      prev = picks.slice();
      if (!events.length) return events;
      for (const e of events) {
        recent.unshift(e);
        for (const fn of listeners) { try { fn(e); } catch { /* one bad listener can't stop the rest */ } }
      }
      recent.length = Math.min(recent.length, maxRecent);
      if (send) {
        try { await send(webhookBody(events)); }
        catch (e) { log.warn?.(`Alerts: webhook failed: ${e.response?.status || ''} ${e.message}`); }
      }
      // forget cooldowns older than a day so the map can't grow forever
      const cut = now() - 24 * 3600000;
      for (const [k, t] of seen) if (t < cut) seen.delete(k);
      return events;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    recent(limit = 50) { return recent.slice(0, limit); },
    listenerCount() { return listeners.size; },
  };
}

module.exports = { diffBoards, describe, webhookBody, createAlerter, keyOf, DEFAULTS };
