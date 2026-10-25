// ─── NFL MODEL ON THE ODDS SCREEN (nflgl.js) ─────────────────────────────────
// Our NFL game-line model (nflmodel.js) next to Kalshi and Pinnacle on every
// NFL contract Kalshi lists, and its own forward record:
//
//   data      nflverse's games.csv (schedule, finals, rest, roof) every 6 hours
//             and ESPN's NFL scoreboard every refresh for finals the same
//             night. Ratings are rebuilt from every final in kickoff order
//             with the frozen parameters (seeds/nflmodel-params.json).
//   prices    the Kalshi contracts matched to Pinnacle's NFL games
//             (bigmoney.gameIndex: bet keys ml|home, spread|<home pts>|home,
//             total|<line>|over ...). Kalshi's cost has its taker fee in.
//   record    a contract where our chance is 3+ points over Kalshi's cost is
//             frozen once, 60 minutes or less before kickoff (the backtest's
//             bet time), with what $200 and $1,000 fill at when a book was
//             read. Pinnacle's no-vig price of the same bet is followed to
//             kickoff (the close), Kalshi's mid too, and the final grades it.
//             Kinds: nfl-ml, nfl-spread, nfl-total, each judged alone.
//
// A model, not an edge: the held-out backtest (checks/nfl-gameline-2026-10-25)
// says how it did against Kalshi. Alerts never fire from here.

const M = require('./nflmodel');
const { score, resultsShortfall, tStat, PROVEN_N } = require('./results');

const NFLVERSE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const FLAG_PTS = 0.03;
const FREEZE_MIN = 60;            // minutes before kickoff a flag is frozen (the backtest's T-60)
const CLOSE_OK_MIN = 60;          // a close read more than this before kickoff is not a close
const NFLVERSE_EVERY_MS = 6 * 3600e3;
const KINDS = { ml: 'nfl-ml', spread: 'nfl-spread', total: 'nfl-total' };
const KIND_LABEL = { 'nfl-ml': 'NFL model moneyline', 'nfl-spread': 'NFL model spread', 'nfl-total': 'NFL model total' };
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const ms = t => { const x = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const isNfl = b => /^nfl$/i.test(String(b?.league || '')) || /^nfl$/i.test(String(b?.game?.league || ''));

// a bet key → our chance of it from a game's chances (home/away as in the key)
function modelP(key, ch) {
  const p = String(key).split('|'), kind = p[1], side = p[p.length - 1];
  if (kind === 'ml') return side === 'home' ? ch.pHome : side === 'away' ? r4(1 - ch.pHome) : null;
  if (kind === 'spread') {
    const h = Number(p[2]);              // the home side's points: home -3.5 → covers when margin > 3.5
    if (!Number.isFinite(h)) return null;
    const pHome = ch.home(-h);
    return side === 'home' ? pHome : side === 'away' ? r4(1 - pHome) : null;
  }
  if (kind === 'total') {
    const L = Number(p[2]);
    if (!Number.isFinite(L)) return null;
    const pOver = ch.over(L);
    return side === 'over' ? pOver : side === 'under' ? r4(1 - pOver) : null;
  }
  return null;
}
const kindOf = key => KINDS[String(key).split('|')[1]] || null;

// a final → did this bet key win? 'win' | 'loss' | 'push'
function outcomeOf(key, homeScore, awayScore) {
  const p = String(key).split('|'), kind = p[1], side = p[p.length - 1];
  const m = homeScore - awayScore, t = homeScore + awayScore;
  if (kind === 'ml') { if (m === 0) return 'push'; return (m > 0) === (side === 'home') ? 'win' : 'loss'; }
  if (kind === 'spread') {
    const v = m + Number(p[2]);          // home margin with the home side's points
    if (v === 0) return 'push';
    return (v > 0) === (side === 'home') ? 'win' : 'loss';
  }
  if (kind === 'total') { const L = Number(p[2]); if (t === L) return 'push'; return (t > L) === (side === 'over') ? 'win' : 'loss'; }
  return null;
}

// ESPN scoreboard → finals [{ home, away, homeScore, awayScore, kickoff }]
function parseEspn(body) {
  const out = [];
  for (const ev of body?.events || []) {
    const c = ev.competitions?.[0];
    if (!c || !c.status?.type?.completed) continue;
    const h = c.competitors?.find(x => x.homeAway === 'home'), a = c.competitors?.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const home = M.code(h.team?.abbreviation), away = M.code(a.team?.abbreviation);
    const hs = Number(h.score), as = Number(a.score);
    if (!M.TEAMS[home] || !M.TEAMS[away] || !Number.isFinite(hs) || !Number.isFinite(as)) continue;
    out.push({ home, away, homeScore: hs, awayScore: as, kickoff: ms(c.date || ev.date), espn: String(ev.id || '') });
  }
  return out;
}

// finals laid over nflverse's games (same teams, kickoff within a day)
function mergeFinals(games, finals) {
  let added = 0;
  for (const f of finals || []) {
    const g = games.find(x => !x.done && ((x.home === f.home && x.away === f.away) || (x.home === f.away && x.away === f.home)) && Math.abs(x.kickoff - f.kickoff) < 36 * 3600e3);
    if (!g) continue;
    const flip = g.home !== f.home;
    g.homeScore = flip ? f.awayScore : f.homeScore; g.awayScore = flip ? f.homeScore : f.awayScore; g.done = true; g.from = 'espn';
    added++;
  }
  return added;
}

function createNflModel({ http, store = null, bets = () => [], fill = null, now = () => Date.now(), params = null, log = () => {} } = {}) {
  const opts = { ...M.DEFAULTS, ...(params || require('./seeds/nflmodel-params.json')) };
  const state = { games: [], ratings: null, nflverseAt: 0, espnAt: 0, refreshedAt: null, finals: 0, upcoming: 0, errors: [], backtest: null, records: 0, frozen: 0, graded: 0 };
  try { state.backtest = require('./seeds/nflmodel-backtest.json'); } catch { state.backtest = null; }
  const preds = new Map();   // game id → { pred, chances }
  let booted = false;
  async function boot() {
    if (booted || !store) return;
    booted = true;
    try { await store.init(); } catch (e) { state.errors = [`store: ${e.message}`]; }
  }
  function rebuild() {
    const R = M.createRatings(opts);
    const t = now();
    for (const g of state.games) if (g.done && g.kickoff < t) R.update(g);
    preds.clear();
    let up = 0;
    for (const g of state.games) {
      if (g.done || g.kickoff < t - 4 * 3600e3 || g.kickoff > t + 10 * 86400e3) continue;
      const pred = R.predict(g);
      preds.set(g.id, { pred, ch: M.chances(pred, opts) });
      up++;
    }
    state.ratings = R;
    state.upcoming = up;
  }
  async function refresh() {
    await boot();
    const errors = [];
    if (now() - state.nflverseAt > NFLVERSE_EVERY_MS || !state.games.length) {
      try {
        const r = await http.get(NFLVERSE_URL, { timeout: 30000, responseType: 'text', transformResponse: x => x });
        const games = M.parseNflverse(r.data);
        if (games.length > 5000) { state.games = games; state.nflverseAt = now(); }
        else errors.push(`nflverse: ${games.length} games read`);
      } catch (e) { errors.push(`nflverse: ${e.response?.status || e.message}`); }
    }
    if (state.games.length) {
      try {
        const r = await http.get(ESPN_URL, { timeout: 20000 });
        state.finals = mergeFinals(state.games, parseEspn(r.data));
        state.espnAt = now();
      } catch (e) { errors.push(`espn: ${e.response?.status || e.message}`); }
      rebuild();
    }
    state.errors = errors;
    state.refreshedAt = new Date(now()).toISOString();
    await grade().catch(e => { state.errors.push(`grade: ${e.message}`); });
    return status();
  }
  // a Pinnacle game → our game (either way round: neutral sites can list the other team first)
  function gameFor(pg) {
    const h = M.teamCode(pg.home), a = M.teamCode(pg.away), t = ms(pg.start);
    if (!h || !a || t == null) return null;
    for (const g of state.games) {
      if (Math.abs(g.kickoff - t) > 12 * 3600e3) continue;
      if (g.home === h && g.away === a) return { g, flip: false };
      if (g.home === a && g.away === h) return { g, flip: true };
    }
    return null;
  }
  // a Pinnacle-keyed bet → the same bet the way our game has its teams
  const flipKey = key => {
    const p = String(key).split('|');
    const side = p[p.length - 1];
    if (p[1] === 'ml') return [p[0], 'ml', side === 'home' ? 'away' : 'home'].join('|');
    if (p[1] === 'spread') return [p[0], 'spread', String(-Number(p[2])), side === 'home' ? 'away' : 'home'].join('|');
    return key;
  };
  // The NFL board: every game we price with each Kalshi contract on it.
  function view() {
    const t = now();
    const byGame = new Map();
    const list = bets() || [];
    for (const b of (list.values ? list.values() : list)) {
      if (!isNfl(b)) continue;
      const hit = gameFor(b.game);
      if (!hit) continue;
      const P = preds.get(hit.g.id);
      if (!P) continue;
      const ours = hit.flip ? flipKey(b.key) : b.key;
      const p = modelP(ours, P.ch);
      if (p == null) continue;
      if (!byGame.has(hit.g.id)) {
        const g = hit.g;
        byGame.set(hit.g.id, { id: g.id, home: M.TEAMS[g.home]?.[0] || g.home, away: M.TEAMS[g.away]?.[0] || g.away, kickoff: new Date(g.kickoff).toISOString(), week: g.week,
          model: { margin: r1(P.pred.margin), total: r1(P.pred.total), pHome: P.ch.pHome, homeGames: P.pred.homeGames, awayGames: P.pred.awayGames },
          nflverse: { spread: g.spread, total: g.total }, rows: [] });
      }
      const k = (b.venues || []).find(v => v.venue === 'kalshi');
      const cost = k?.implied ?? null;
      byGame.get(hit.g.id).rows.push({ key: b.key, flip: hit.flip, kind: kindOf(b.key), label: b.label, model: p, pin: b.pin ?? null,
        kalshi: k ? { cost, price: k.price, mid: k.mid ?? null, marketId: k.marketId, side: k.side, url: k.url } : null,
        edge: cost != null ? r4(p - cost) : null, pinEdge: cost != null && b.pin != null ? r4(b.pin - cost) : null,
        flag: cost != null && p - cost >= FLAG_PTS, minsToStart: Math.round((ms(b.game.start) - t) / 60e3), start: b.game.start });
    }
    const games = [...byGame.values()].map(g => ({ ...g, rows: g.rows.sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || (b.edge ?? -9) - (a.edge ?? -9)) }))
      .sort((a, b) => ms(a.kickoff) - ms(b.kickoff));
    return games;
  }
  // every few minutes: freeze new flags inside the hour, follow the close
  async function tick() {
    await boot();
    if (!store || !preds.size) return { frozen: 0, followed: 0 };
    const t = now();
    const all = await store.all();
    const have = new Map(all.map(r => [r.id, r]));
    let frozen = 0, followed = 0;
    for (const g of view()) {
      for (const row of g.rows) {
        const start = ms(row.start);
        if (start == null || !row.kalshi) continue;
        const id = `nfl:${row.key}|kalshi`;
        const rec = have.get(id);
        if (rec && rec.status === 'open' && start > t) {
          // the close: Pinnacle's no-vig chance and Kalshi's mid, last read before kickoff
          rec.pinClose = row.pin; rec.kalshiClose = row.kalshi.mid; rec.closeAt = new Date(t).toISOString();
          await store.put(rec); followed++;
          continue;
        }
        if (rec || !row.flag || start <= t || start - t > FREEZE_MIN * 60e3) continue;
        // what $200 and $1,000 fill at on Kalshi's book (null: no book read, or it can't take it all)
        let sized = null;
        if (fill) {
          const ref = { venue: 'kalshi', id: String(row.kalshi.marketId), buy: row.kalshi.side };
          try { sized = { at200: await fill(ref, 200), at1000: await fill(ref, 1000) }; } catch { sized = null; }
        }
        const r = { id, kind: row.kind, betKey: row.key, flip: row.flip, label: row.label, game: `${g.away} at ${g.home}`, gameId: g.id, start: row.start,
          model: row.model, cost: row.kalshi.cost, price: row.kalshi.price, marketId: row.kalshi.marketId, side: row.kalshi.side,
          pinAtFlag: row.pin, kalshiMidAtFlag: row.kalshi.mid, edge: row.edge, sized, flaggedAt: new Date(t).toISOString(), status: 'open',
          pinClose: row.pin, kalshiClose: row.kalshi.mid, closeAt: new Date(t).toISOString() };
        await store.put(r); frozen++;
      }
    }
    // kicked off: the close is in
    for (const r of all) {
      if (r.status !== 'open' || ms(r.start) > t) continue;
      const okClose = ms(r.closeAt) != null && ms(r.start) - ms(r.closeAt) <= CLOSE_OK_MIN * 60e3;
      r.closeOk = okClose;
      r.clv = okClose && r.pinClose > 0 ? r4(r.pinClose / r.cost - 1) : null;
      r.kalshiClv = okClose && r.kalshiClose > 0 ? r4(r.kalshiClose / r.cost - 1) : null;
      for (const [k, s] of Object.entries(r.sized || {})) if (s?.cost > 0 && r.pinClose > 0 && okClose) r[`clv${k.slice(2)}`] = r4(r.pinClose / s.cost - 1);
      r.status = 'locked';
      await store.put(r);
    }
    state.frozen += frozen;
    return { frozen, followed };
  }
  async function grade() {
    if (!store) return { graded: 0 };
    let n = 0;
    for (const r of await store.all()) {
      if (r.status !== 'locked') continue;
      const g = state.games.find(x => x.id === r.gameId);
      if (!g || !g.done) continue;
      // the record's key is Pinnacle's way round; a flipped game reads the other way
      const key = r.flip ? flipKey(r.betKey) : r.betKey;
      const out = outcomeOf(key, g.homeScore, g.awayScore);
      if (!out) continue;
      r.outcome = out;
      r.profit = out === 'win' ? r4((1 - r.cost) / r.cost) : out === 'loss' ? -1 : 0;
      r.final = `${g.awayScore}-${g.homeScore}`;
      r.status = 'graded'; r.gradedAt = new Date(now()).toISOString();
      await store.put(r); n++;
    }
    state.graded += n;
    return { graded: n };
  }
  // one kind alone; proven only on the strict rule (50 games, CLV t 2+ vs
  // Pinnacle's close, results not 1.5 sd under it); never pooled
  async function record() {
    const rows = store ? await store.all() : [];
    const kinds = {};
    for (const kind of Object.values(KINDS)) {
      const rs = rows.filter(r => r.kind === kind);
      const done = rs.filter(r => r.status === 'locked' || r.status === 'graded');
      const bets = done.map(r => ({ profit: r.status === 'graded' && r.outcome !== 'push' ? r.profit : null, staked: r.status === 'graded' && r.outcome !== 'push' ? 1 : 0, clv: r.clv ?? null }));
      const s = score(bets);
      const games = new Set(done.filter(r => r.clv != null).map(r => `${r.gameId}`)).size;
      const short = resultsShortfall(done.filter(r => r.status === 'graded' && r.outcome !== 'push' && r.pinClose > 0 && r.closeOk).map(r => ({ win: r.outcome === 'win', p: r.pinClose, d: 1 / r.cost })));
      const proven = s.clvN >= PROVEN_N && games >= PROVEN_N && (s.clvT ?? -Infinity) >= 2 && s.avgClv > 0 && !short.short;
      kinds[kind] = { label: KIND_LABEL[kind], open: rs.filter(r => r.status === 'open').length, n: done.length, graded: s.graded, wins: s.wins, losses: s.losses,
        avgClv: s.avgClv, clvT: s.clvT, clvN: s.clvN, beatClosePct: s.beatClosePct, games, of: PROVEN_N,
        kalshiClv: (() => { const v = done.map(r => r.kalshiClv).filter(Number.isFinite); return v.length ? { n: v.length, mean: r4(v.reduce((a, x) => a + x, 0) / v.length), t: tStat(v) } : null; })(),
        verdict: proven ? 'proven' : 'model, not an edge', note: proven ? null : `${Math.min(games, s.clvN)} of ${PROVEN_N} graded vs Pinnacle's close${s.avgClv != null ? `, ${s.avgClv > 0 ? '+' : ''}${(s.avgClv * 100).toFixed(1)}% CLV, t ${s.clvT ?? 'n/a'}` : ''}`,
        short: short.short ? short.note : null };
    }
    const recent = rows.sort((a, b) => String(b.flaggedAt).localeCompare(String(a.flaggedAt))).slice(0, 200)
      .map(r => ({ kind: r.kind, label: r.label, game: r.game, start: r.start, model: r.model, cost: r.cost, edge: r.edge, pinAtFlag: r.pinAtFlag, pinClose: r.pinClose, clv: r.clv, kalshiClv: r.kalshiClv,
        sized: r.sized, status: r.status, outcome: r.outcome || null, final: r.final || null, flaggedAt: r.flaggedAt }));
    return { kinds, recent, total: rows.length };
  }
  function status() {
    const R = state.ratings;
    return { on: true, games: state.games.length, finals: state.games.filter(g => g.done).length, upcoming: state.upcoming, nflverseAt: state.nflverseAt ? new Date(state.nflverseAt).toISOString() : null,
      espnAt: state.espnAt ? new Date(state.espnAt).toISOString() : null, refreshedAt: state.refreshedAt, errors: state.errors.slice(0, 5), ratings: R ? R.status() : null,
      params: { k: opts.k, cap: opts.cap, shrink: opts.shrink, hfa: opts.hfa, rest: opts.rest, kt: opts.kt, sd: opts.sd, sdT: opts.sdT, fitted: opts.fitted || null }, flagPts: FLAG_PTS, freezeMin: FREEZE_MIN };
  }
  const ratings = () => (state.ratings ? state.ratings.table() : []);
  return { refresh, tick, grade, view, record, status, ratings, state, _rebuild: rebuild };
}

module.exports = { createNflModel, modelP, outcomeOf, parseEspn, mergeFinals, kindOf, KINDS, FLAG_PTS, FREEZE_MIN, NFLVERSE_URL, ESPN_URL };
