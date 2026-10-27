// ─── MAP KILL UNDERS: PINNACLE'S MAP NUMBER UNDER THE APPS' LINES SUMMED ─────
// Pre-registered 10-26 16:56Z (checks/map-unders-2026-10-26/PREREGISTERED.md),
// after the 10-25 esports board's test (c): Map 1 kill Unders on PrizePicks,
// Underdog and Sleeper where Pinnacle's Map 1 total sat under the apps' own
// player lines added up went 37-19, but on 3 LoL matches. This records it on
// every esports board build, every day, so the sample grows in matches.
//
// For each app, match and span (Map 1, Map 2, or Maps 1-2), with 4+ players of
// BOTH teams listed at a kills line for exactly that span:
//   app sum   each team's lines summed and scaled to five, both teams added
//   anchor    Pinnacle's map N number: LoL and Dota 2, its two team kill
//             means added (team totals), else its map total kills; CS2 and
//             Valorant, its map rounds × kills a round (CS 6.8, VAL 6.94)
//   under     the anchor under the app sum ('map-under'); 'under5' 5%+ under
// The play ('map-under-model') is a flagged Under where OUR model's fair
// beats the app's break-even by a point: the kill-share model on Pinnacle's
// team kills (LoL, Dota 2) or the round model on Pinnacle's rounds (CS2,
// Valorant). The server feeds the board; this file is pure and unit-tested.
// Nothing here alerts.

const { probit } = require('./esboard');

const DEFAULTS = {
  // the spans read: single maps 1 and 2, and Maps 1-2 (added 18:28Z, before any row)
  spans: ['1', '2', '1-2'],
  minPlayers: 4,          // listed players a team needs on the app
  modelMargin: 0.01,      // our fair past the app's break-even
  leadMs: 6 * 3600e3,     // a row opens from 6 hours before the start
  under5: 0.95,           // 'under5': the anchor 5%+ under
  target: 50,             // graded legs a kind needs before it is judged
  minMatches: 10,         // and distinct matches
};
// kills a round, both teams (2 × the h2h model's team pace), as test (c)
const KPR = { CS: 6.8, VAL: 6.94 };
// spread of a team's kills on one map (esboard.KILL_SD) and of a map's rounds
const TEAM_SD = { LOL: 6, DOTA: 8 };
const ROUNDS_SD = { CS: 4.4, VAL: 4.4 };
// the board's game key → Pinnacle's (esbooks.parsePinnacle)
const PIN_GAME = { LOL: 'LOL', DOTA: 'DOTA', CS: 'CS2', VAL: 'VAL' };
const APP_NAME = { PP: 'PrizePicks', UD: 'Underdog', SL: 'Sleeper' };
const GAME_LABEL = { LOL: 'LoL', DOTA: 'Dota 2', CS: 'CS2', VAL: 'Valorant' };

const spanLabel = s => (String(s).includes('-') ? `Maps ${s}` : `Map ${s}`);
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;

// a ladder (points { x: −line, p: P over }) → the mean it implies: line +
// sd × z(P over), averaged over the points that aren't lopsided, or the main
// point (nearest 50/50) only
function ladderMean(pts, sd, { mainOnly = false } = {}) {
  const ok = (pts || []).filter(q => Number.isFinite(q?.x) && q.p >= 0.15 && q.p <= 0.85);
  if (!ok.length || !(sd > 0)) return null;
  const use = mainOnly ? [ok.reduce((a, b) => (Math.abs(b.p - 0.5) < Math.abs(a.p - 0.5) ? b : a))] : ok;
  const v = use.map(q => -q.x + sd * probit(q.p));
  return r2(v.reduce((a, b) => a + b, 0) / v.length);
}

// Pinnacle's anchor in kills for a span ('1', '2' or '1-2': each map's added,
// every map needed), off one match's ladders (a Map)
// → { kills, teams: [a, b] | null, src, rounds? } or null
const spanMaps = span => { const m = /^(\d)(?:-(\d))?$/.exec(String(span)); if (!m) return []; const out = []; for (let i = +m[1]; i <= +(m[2] || m[1]); i++) out.push(i); return out; };
function pinAnchor(ladders, game, span) {
  const maps = spanMaps(span);
  if (!maps.length) return null;
  const each = maps.map(n => mapAnchor(ladders, game, n));
  if (each.some(a => !a)) return null;
  if (each.length === 1) return each[0];
  const sum = f => r2(each.reduce((a, x) => a + f(x), 0));
  return { kills: sum(x => x.kills), teams: each.every(x => x.teams) ? [sum(x => x.teams[0]), sum(x => x.teams[1])] : null,
    src: [...new Set(each.map(x => x.src))].join(' + '), ...(each[0].rounds ? { rounds: sum(x => x.rounds) } : {}), maps: maps.length };
}
function mapAnchor(ladders, game, n) {
  const get = k => (ladders && typeof ladders.get === 'function' ? ladders.get(k) : ladders?.[k]);
  if (game === 'LOL' || game === 'DOTA') {
    const sd = TEAM_SD[game];
    const a = ladderMean(get(`kills|${n}|tt|0`), sd), b = ladderMean(get(`kills|${n}|tt|1`), sd);
    if (a > 0 && b > 0) return { kills: r2(a + b), teams: [a, b], src: 'team totals' };
    const t = ladderMean(get(`kills|${n}|total`), sd * Math.SQRT2, { mainOnly: true });
    return t > 0 ? { kills: t, teams: null, src: 'map total' } : null;
  }
  if (KPR[game]) {
    const r = ladderMean(get(`rounds|${n}|total`), ROUNDS_SD[game], { mainOnly: true });
    return r > 0 ? { kills: r2(r * KPR[game]), rounds: r, teams: null, src: 'rounds' } : null;
  }
  return null;
}

// legs: [{ app, game, matchId, map, team (0|1), player, line, ...anything }]
// anchorOf(matchId, game, map) → pinAnchor(...) or null
// → groups [{ app, game, matchId, map, teams: [{ n, sum, scaled }], appSum,
//   anchor, under, under5, gapPct, legs }] (every group with both teams
//   listed and an anchor; `under` says whether it qualifies)
function flagGroups(legs, anchorOf, o = {}) {
  const opt = { ...DEFAULTS, ...o };
  const byKey = new Map();
  for (const l of legs || []) {
    if (!l || !APP_NAME[l.app] || !opt.spans.includes(String(l.map)) || !(l.line > 0) || (l.team !== 0 && l.team !== 1)) continue;
    const k = `${l.app}|${l.matchId}|${l.map}`;
    const g = byKey.get(k) || byKey.set(k, { app: l.app, game: l.game, matchId: l.matchId, map: l.map, seen: new Set(), legs: [] }).get(k);
    const pk = `${l.team}|${String(l.player || '').toLowerCase()}`;
    if (g.seen.has(pk)) continue;
    g.seen.add(pk);
    g.legs.push(l);
  }
  const out = [];
  for (const g of byKey.values()) {
    const teams = [0, 1].map(i => {
      const ls = g.legs.filter(l => l.team === i);
      const sum = ls.reduce((a, l) => a + l.line, 0);
      return { n: ls.length, sum: r2(sum), scaled: ls.length ? r2(sum * 5 / ls.length) : 0 };
    });
    if (teams.some(t => t.n < opt.minPlayers)) continue;
    const anchor = anchorOf(g.matchId, g.game, g.map);
    if (!anchor || !(anchor.kills > 0)) continue;
    const appSum = r2(teams[0].scaled + teams[1].scaled);
    const { seen, ...rest } = g;
    out.push({ ...rest, teams, appSum, anchor, under: anchor.kills < appSum, under5: anchor.kills < appSum * opt.under5,
      gapPct: r2((anchor.kills / appSum - 1) * 100) });
  }
  return out;
}

// One flagged group's legs priced: model(leg, group) → our fair chance of the
// Under (0-1) or null; be(leg) → the app's break-even for the Under or null
// (the Under is closed). → [{ leg, group, fair, be, edge, model: bool }]
function priceGroup(group, { model, be, margin = DEFAULTS.modelMargin } = {}) {
  const out = [];
  for (const leg of group.legs) {
    const b = be(leg);
    if (!(b > 0 && b < 1)) continue;
    let fair = null;
    try { fair = model(leg, group); } catch { fair = null; }
    if (!(fair > 0 && fair < 1)) fair = null;
    const edge = fair != null ? r4(fair - b) : null;
    out.push({ leg, group, fair: fair != null ? r4(fair) : null, be: r4(b), edge, model: edge != null && edge >= margin });
  }
  return out;
}

// ── the record ──
// tracker rows (createTracker, trackExtra kept: appKey, be, game, span, …)
// → per game × app: graded legs, record, hit rate vs the mean break-even,
// units at each leg's break-even (signalDecimal = 1 / be), distinct matches,
// z naive and z by match (each match's legs move together), and the label
function matchOf(r) { return `${r.game || r.sport}|${r.gameId ?? ''}|${String(r.matchTitle || '').toLowerCase()}|${String(r.startTime || '').slice(0, 13)}`; }
function cell(rows, o = {}) {
  const opt = { ...DEFAULTS, ...o };
  const g = rows.filter(r => r.status === 'graded' && (r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'push'));
  const dec = g.filter(r => r.outcome !== 'push' && r.be > 0);
  const w = dec.filter(r => r.outcome === 'win').length, l = dec.length - w;
  const beSum = dec.reduce((a, r) => a + r.be, 0);
  const varSum = dec.reduce((a, r) => a + r.be * (1 - r.be), 0);
  const units = g.reduce((a, r) => a + (r.outcome === 'win' ? 1 / r.be - 1 : r.outcome === 'loss' ? -1 : 0), 0);
  const byMatch = new Map();
  for (const r of dec) { const k = matchOf(r); byMatch.set(k, (byMatch.get(k) || 0) + ((r.outcome === 'win' ? 1 : 0) - r.be)); }
  const s = [...byMatch.values()];
  const s2 = s.reduce((a, x) => a + x * x, 0);
  const matches = new Set(g.map(matchOf)).size;
  const z = varSum > 0 ? r2((w - beSum) / Math.sqrt(varSum)) : null;
  const zMatch = s.length >= 5 && s2 > 0 ? r2(s.reduce((a, x) => a + x, 0) / Math.sqrt(s2)) : null;
  const graded = g.length;
  const lead = graded >= opt.target && matches >= opt.minMatches && zMatch != null && zMatch >= 2 && units > 0;
  const hit = dec.length ? r4(w / dec.length) : null, beAvg = dec.length ? r4(beSum / dec.length) : null;
  return {
    graded, wins: w, losses: l, pushes: g.length - dec.length, hit, be: beAvg, units: r2(units), matches, z, zMatch,
    open: rows.filter(r => r.status === 'open' || r.status === 'locked').length,
    void: rows.filter(r => r.status === 'void').length,
    label: lead ? 'lead: re-check before any bet' : 'research, not an edge',
    why: lead ? null : graded < opt.target ? `${graded} of ${opt.target} graded`
      : matches < opt.minMatches ? `${matches} matches (needs ${opt.minMatches})`
        : zMatch == null || zMatch < 2 ? `z by match ${zMatch ?? '-'} (needs 2)` : 'units not positive',
    // a profit is shown only on a lead
    profitShown: lead,
  };
}
function mapRecord(rows, o = {}) {
  const list = rows || [];
  const by = (f) => {
    const m = new Map();
    for (const r of list) { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const cells = [...by(r => `${r.game || r.sport}|${r.appKey || r.signalBook}|${r.span ?? r.mapN ?? ''}`)].map(([k, rs]) => {
    const [game, app, span] = k.split('|');
    return { game, gameLabel: GAME_LABEL[game] || game, app, appName: APP_NAME[app] || app, span, spanLabel: spanLabel(span), ...cell(rs, o) };
  }).sort((a, b) => b.graded - a.graded || b.open - a.open);
  return { all: cell(list, o), cells, target: o.target || DEFAULTS.target, minMatches: o.minMatches || DEFAULTS.minMatches };
}

module.exports = { spanMaps, spanLabel, DEFAULTS, KPR, TEAM_SD, ROUNDS_SD, PIN_GAME, APP_NAME, GAME_LABEL, ladderMean, pinAnchor, flagGroups, priceGroup, mapRecord };
