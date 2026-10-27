// ─── SOCCER MODEL ON MATCHUPS (soccergl.js) ──────────────────────────────────
// Our soccer match model (soccermodel.js) beside Kalshi, Polymarket US and
// Pinnacle on every league match the exchanges list, and its own record:
//
//   data      the ratings start from seeds/soccermodel-seed.json (every
//             football-data.co.uk final to the build). football-data's
//             current-season files are re-read every 12 hours (results and
//             shots on target, two or three updates a week), ESPN's
//             scoreboards every refresh for the last three days' finals.
//   prices    the Kalshi and Polymarket US three-way contracts matched to
//             Pinnacle's soccer games (bigmoney.gameIndex: bet keys
//             <game>|ml3|home, |draw, |away), each venue's cost with its fee.
//   record    a contract where our chance is 3+ points over the venue's cost
//             is frozen once, 60 minutes or less before kickoff (the
//             backtest's bet time), with what $200 and $1,000 fill at when a
//             book was read. Pinnacle's no-vig price of the same outcome is
//             followed to kickoff (the close) and the 90-minute result grades
//             it. Kinds soccer-1x2-kalshi and soccer-1x2-pmus, judged alone.
//
// A model, not an edge: the held-out backtest (checks/soccer-model-2026-10-25)
// says how it did against the exchanges. Alerts never fire from here.

const M = require('./soccermodel');
const { score, resultsShortfall, tStat, PROVEN_N } = require('./results');

const FD = 'https://www.football-data.co.uk';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const FLAG_PTS = 0.03;
const FREEZE_MIN = 60;
const CLOSE_OK_MIN = 60;
const FD_EVERY_MS = 12 * 3600e3;
const VENUES = { kalshi: 'soccer-1x2-kalshi', polymarketus: 'soccer-1x2-pmus' };
const KIND_LABEL = { 'soccer-1x2-kalshi': 'Soccer model 1X2 on Kalshi', 'soccer-1x2-pmus': 'Soccer model 1X2 on Polymarket US' };
// Pinnacle's league names → our league code, ESPN's slug, football-data's file
const PIN_LEAGUES = [
  [/^England - Premier League$/i, 'E0', 'eng.1', 'mmz4281/{s}/E0.csv'],
  [/^England - Championship$/i, 'E1', 'eng.2', 'mmz4281/{s}/E1.csv'],
  [/^Spain - La Liga$/i, 'SP1', 'esp.1', 'mmz4281/{s}/SP1.csv'],
  [/^Germany - Bundesliga$/i, 'D1', 'ger.1', 'mmz4281/{s}/D1.csv'],
  [/^Italy - Serie A$/i, 'I1', 'ita.1', 'mmz4281/{s}/I1.csv'],
  [/^France - Ligue 1$/i, 'F1', 'fra.1', 'mmz4281/{s}/F1.csv'],
  [/^Netherlands - Eredivisie$/i, 'N1', 'ned.1', 'mmz4281/{s}/N1.csv'],
  [/^Portugal - Primeira Liga$/i, 'P1', 'por.1', 'mmz4281/{s}/P1.csv'],
  [/^USA - Major League Soccer$/i, 'USA', 'usa.1', 'new/USA.csv'],
  [/^Mexico - Liga MX$/i, 'MEX', 'mex.1', 'new/MEX.csv'],
  [/^Brazil - Serie A$/i, 'BRA', 'bra.1', 'new/BRA.csv'],
];
const leagueOf = name => { const hit = PIN_LEAGUES.find(([re]) => re.test(String(name || ''))); return hit ? hit[1] : null; };
const { r4OrNull: r4 } = require('./mathutil');
const ms = t => { const x = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(x) ? x : null; };
const isSoccer = b => /soccer/i.test(String(b?.game?.sport || '')) || String(b?.key || '').split('|')[1] === 'ml3';
const PICK = { home: 'h', draw: 'd', away: 'a' };
// football-data's season folder for a date ("2627" from August 2026)
const seasonOf = t => { const d = new Date(t), y = d.getUTCFullYear() % 100, m = d.getUTCMonth(); const a = m >= 6 ? y : y - 1; return `${String(a).padStart(2, '0')}${String(a + 1).padStart(2, '0')}`; };
const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

// ESPN scoreboard → finals [{ league, home, away, hg, ag, hst, ast, kickoff }]
function parseEspn(body, league) {
  const out = [];
  for (const ev of body?.events || []) {
    const c = ev.competitions?.[0];
    if (!c || !c.status?.type?.completed) continue;
    // a cup tie settled after extra time or penalties is not the 90-minute result the contracts pay on
    if (/AET|PEN|extra|penalt/i.test(`${c.status?.type?.shortDetail || ''} ${c.status?.type?.detail || ''}`)) continue;
    const h = c.competitors?.find(x => x.homeAway === 'home'), a = c.competitors?.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const hg = Number(h.score), ag = Number(a.score);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const sot = t => { const s = (t.statistics || []).find(x => x.name === 'shotsOnTarget'); const v = Number(s?.displayValue); return Number.isFinite(v) ? v : null; };
    out.push({ league, home: h.team?.displayName || h.team?.name, away: a.team?.displayName || a.team?.name, hg, ag, hst: sot(h), ast: sot(a), kickoff: ms(c.date || ev.date), done: true, from: 'espn' });
  }
  return out;
}

function createSoccerModel({ http, store = null, bets = () => [], fill = null, now = () => Date.now(), params = null, seed = undefined, log = () => {} } = {}) {
  const opts = { ...M.DEFAULTS, ...(params || require('./seeds/soccermodel-params.json')) };
  const seedData = seed !== undefined ? seed : (() => { try { return require('./seeds/soccermodel-seed.json'); } catch { return null; } })();
  const state = { fd: [], fdAt: 0, fdFiles: 0, espn: [], espnAt: null, refreshedAt: null, errors: [], ratings: null, built: null, backtest: null, upcoming: 0 };
  try { state.backtest = require('./seeds/soccermodel-backtest.json'); } catch { state.backtest = null; }
  let booted = false;
  async function boot() {
    if (booted || !store) return;
    booted = true;
    try { await store.init(); } catch (e) { state.errors = [`store: ${e.message}`]; }
  }
  // every final we know of, once: football-data first (it has shots on target), ESPN for what it hasn't got yet
  function finals() {
    const out = [...state.fd];
    for (const e of state.espn) {
      const dup = out.some(m => m.league === e.league && Math.abs(m.kickoff - e.kickoff) < 36 * 3600e3 && M.sameClub(m.home, e.home) && M.sameClub(m.away, e.away));
      if (!dup) out.push(e);
    }
    return out.sort((a, b) => a.kickoff - b.kickoff);
  }
  // ratings: the seed, then every final after it in kickoff order
  function rebuild() {
    const R = M.createRatings(opts);
    const t = now();
    let from = -Infinity;
    if (seedData) { R.importState(seedData); from = ms(seedData.lastMatch) ?? -Infinity; }
    let added = 0;
    for (const m of finals()) {
      if (!m.done || m.kickoff >= t || m.kickoff <= from) continue;
      // football-data files carry the season; ESPN's rows take it from the date
      R.update({ ...m, season: m.season || (/^(USA|MEX|BRA|ARG|JPN|NOR|SWE|CHN|IRL|FIN)$/.test(m.league) ? String(new Date(m.kickoff).getUTCFullYear()) : seasonOf(m.kickoff)) });
      added++;
    }
    state.ratings = R;
    state.built = { seedTo: seedData?.lastMatch || null, added, at: new Date(t).toISOString() };
  }
  async function refresh() {
    await boot();
    const errors = [];
    const t = now();
    if (t - state.fdAt > FD_EVERY_MS) {
      const s = seasonOf(t), rows = [];
      let files = 0;
      for (const [, code, , file] of PIN_LEAGUES) {
        try {
          const r = await http.get(`${FD}/${file.replace('{s}', s)}`, { timeout: 30000, responseType: 'text', transformResponse: x => x });
          const ms0 = M.parseFootballData(r.data, code, file.includes('{s}') ? s : null).filter(m => m.kickoff > t - 400 * 86400e3);
          rows.push(...ms0); files++;
        } catch (e) { errors.push(`football-data ${code}: ${e.response?.status || e.message}`); }
      }
      if (files) { state.fd = rows; state.fdAt = t; state.fdFiles = files; }
    }
    const espn = [];
    // one day a call: ESPN's soccer scoreboards answer 400 to a date range
    for (const [, code, slug] of PIN_LEAGUES) {
      for (const d of [0, 1, 2]) {
        try {
          const r = await http.get(`${ESPN}/${slug}/scoreboard`, { params: { dates: ymd(t - d * 86400e3) }, timeout: 20000 });
          espn.push(...parseEspn(r.data, code));
        } catch (e) { errors.push(`espn ${slug} ${ymd(t - d * 86400e3)}: ${e.response?.status || e.message}`); }
      }
    }
    if (espn.length || !state.espn.length) state.espn = espn;
    state.espnAt = new Date(t).toISOString();
    rebuild();
    state.errors = errors.slice(0, 8);
    state.refreshedAt = new Date(t).toISOString();
    await grade().catch(e => { state.errors.push(`grade: ${e.message}`); });
    return status();
  }
  const ensure = () => { if (!state.ratings) rebuild(); return state.ratings; };
  // The board: every soccer game in a league we rate, its three outcomes with each exchange's cost.
  function view() {
    const R = ensure();
    const t = now();
    const byGame = new Map();
    const list = bets() || [];
    for (const b of (list.values ? list.values() : list)) {
      if (!isSoccer(b)) continue;
      const p = String(b.key).split('|');
      if (p[1] !== 'ml3' || !PICK[p[2]]) continue;
      const code = leagueOf(b.game?.league);
      if (!code) continue;
      const start = ms(b.game.start);
      if (start == null || start < t - 3 * 3600e3 || start > t + 8 * 86400e3) continue;
      const gid = String(b.game.id);
      if (!byGame.has(gid)) {
        const home = R.resolve(code, b.game.home), away = R.resolve(code, b.game.away);
        const pred = home && away ? R.predict(code, home, away) : null;
        byGame.set(gid, { id: gid, league: M.LEAGUES[code]?.name || code, code, home: b.game.home, away: b.game.away, start: new Date(start).toISOString(),
          rated: { home, away }, model: pred && pred.known ? { h: pred.h, d: pred.d, a: pred.a, lh: pred.lh, la: pred.la, over25: pred.over25, btts: pred.btts, homeGames: pred.homeGames, awayGames: pred.awayGames } : null,
          rows: [] });
      }
      const g = byGame.get(gid);
      const pick = PICK[p[2]];
      const model = g.model ? g.model[pick] : null;
      const venue = v => {
        const x = (b.venues || []).find(y => y.venue === v);
        return x ? { cost: x.implied, price: x.price, mid: x.mid ?? null, marketId: x.marketId, side: x.side, url: x.url || null } : null;
      };
      const k = venue('kalshi'), u = venue('polymarketus');
      const edge = x => (x && model != null ? r4(model - x.cost) : null);
      g.rows.push({ key: b.key, pick: p[2], label: b.label, model, pin: b.pin ?? null, kalshi: k, pmus: u,
        edge: { kalshi: edge(k), pmus: edge(u) }, flag: { kalshi: edge(k) != null && edge(k) >= FLAG_PTS, pmus: edge(u) != null && edge(u) >= FLAG_PTS },
        minsToStart: Math.round((start - t) / 60e3), start: b.game.start });
    }
    const order = { home: 0, draw: 1, away: 2 };
    const games = [...byGame.values()].map(g => ({ ...g, rows: g.rows.sort((a, b) => order[a.pick] - order[b.pick]) })).sort((a, b) => ms(a.start) - ms(b.start));
    state.upcoming = games.length;
    return games;
  }
  // every few minutes: freeze new flags inside the hour, follow the close
  async function tick() {
    await boot();
    if (!store) return { frozen: 0, followed: 0 };
    const t = now();
    const all = await store.all();
    const have = new Map(all.map(r => [r.id, r]));
    let frozen = 0, followed = 0;
    for (const g of view()) {
      for (const row of g.rows) {
        const start = ms(row.start);
        if (start == null) continue;
        for (const [venue, kind] of Object.entries(VENUES)) {
          const v = venue === 'kalshi' ? row.kalshi : row.pmus;
          if (!v) continue;
          const id = `soccer:${row.key}|${venue}`;
          const rec = have.get(id);
          if (rec && rec.status === 'open' && start > t) {
            rec.pinClose = row.pin; rec.venueClose = v.mid; rec.closeAt = new Date(t).toISOString();
            await store.put(rec); followed++;
            continue;
          }
          if (rec || !row.flag[venue === 'kalshi' ? 'kalshi' : 'pmus'] || start <= t || start - t > FREEZE_MIN * 60e3) continue;
          let sized = null;
          if (fill && v.marketId != null) {
            const ref = { venue, id: String(v.marketId), buy: v.side };
            try { sized = { at200: await fill(ref, 200), at1000: await fill(ref, 1000) }; } catch { sized = null; }
          }
          const r = { id, kind, venue, betKey: row.key, pick: row.pick, label: row.label, game: `${g.home} v ${g.away}`, gameId: g.id, league: g.code, rated: g.rated, start: row.start,
            model: row.model, cost: v.cost, price: v.price, marketId: v.marketId, side: v.side, pinAtFlag: row.pin, venueMidAtFlag: v.mid, edge: r4(row.model - v.cost), sized,
            flaggedAt: new Date(t).toISOString(), status: 'open', pinClose: row.pin, venueClose: v.mid, closeAt: new Date(t).toISOString() };
          await store.put(r); frozen++;
        }
      }
    }
    for (const r of all) {
      if (r.status !== 'open' || ms(r.start) > t) continue;
      const okClose = ms(r.closeAt) != null && ms(r.start) - ms(r.closeAt) <= CLOSE_OK_MIN * 60e3;
      r.closeOk = okClose;
      r.clv = okClose && r.pinClose > 0 ? r4(r.pinClose / r.cost - 1) : null;
      r.venueClv = okClose && r.venueClose > 0 ? r4(r.venueClose / r.cost - 1) : null;
      for (const [k, s] of Object.entries(r.sized || {})) if (s?.cost > 0 && r.pinClose > 0 && okClose) r[`clv${k.slice(2)}`] = r4(r.pinClose / s.cost - 1);
      r.status = 'locked';
      await store.put(r);
    }
    return { frozen, followed };
  }
  async function grade() {
    if (!store) return { graded: 0 };
    let n = 0;
    const done = finals();
    for (const r of await store.all()) {
      if (r.status !== 'locked') continue;
      const t = ms(r.start);
      const f = done.find(m => m.league === r.league && Math.abs(m.kickoff - t) < 12 * 3600e3 && r.rated?.home && r.rated?.away
        && M.sameClub(m.home, r.rated.home) && M.sameClub(m.away, r.rated.away));
      if (!f) continue;
      const res = f.hg > f.ag ? 'home' : f.hg === f.ag ? 'draw' : 'away';
      r.outcome = res === r.pick ? 'win' : 'loss';
      r.profit = r.outcome === 'win' ? r4((1 - r.cost) / r.cost) : -1;
      r.final = `${f.hg}-${f.ag}`;
      r.status = 'graded'; r.gradedAt = new Date(now()).toISOString();
      await store.put(r); n++;
    }
    return { graded: n };
  }
  // one venue alone; proven only on the strict rule (50 games, CLV t 2+ vs Pinnacle's close, results not 1.5 sd under it)
  async function record() {
    const rows = store ? await store.all() : [];
    const kinds = {};
    for (const kind of Object.values(VENUES)) {
      const rs = rows.filter(r => r.kind === kind);
      const done = rs.filter(r => r.status === 'locked' || r.status === 'graded');
      const s = score(done.map(r => ({ profit: r.status === 'graded' ? r.profit : null, staked: r.status === 'graded' ? 1 : 0, clv: r.clv ?? null })));
      const games = new Set(done.filter(r => r.clv != null).map(r => r.gameId)).size;
      const short = resultsShortfall(done.filter(r => r.status === 'graded' && r.pinClose > 0 && r.closeOk).map(r => ({ win: r.outcome === 'win', p: r.pinClose, d: 1 / r.cost })));
      const proven = s.clvN >= PROVEN_N && games >= PROVEN_N && (s.clvT ?? -Infinity) >= 2 && s.avgClv > 0 && !short.short;
      const vClv = done.map(r => r.venueClv).filter(Number.isFinite);
      kinds[kind] = { label: KIND_LABEL[kind], open: rs.filter(r => r.status === 'open').length, n: done.length, graded: s.graded, wins: s.wins, losses: s.losses,
        avgClv: s.avgClv, clvT: s.clvT, clvN: s.clvN, beatClosePct: s.beatClosePct, games, of: PROVEN_N,
        venueClv: vClv.length ? { n: vClv.length, mean: r4(vClv.reduce((a, x) => a + x, 0) / vClv.length), t: tStat(vClv) } : null,
        verdict: proven ? 'proven' : 'model, not an edge',
        note: proven ? null : `${Math.min(games, s.clvN)} of ${PROVEN_N} graded vs Pinnacle's close${s.avgClv != null ? `, ${s.avgClv > 0 ? '+' : ''}${(s.avgClv * 100).toFixed(1)}% CLV, t ${s.clvT ?? 'n/a'}` : ''}`,
        short: short.short ? short.note : null };
    }
    const recent = rows.sort((a, b) => String(b.flaggedAt).localeCompare(String(a.flaggedAt))).slice(0, 200)
      .map(r => ({ kind: r.kind, venue: r.venue, label: r.label, game: r.game, league: r.league, start: r.start, model: r.model, cost: r.cost, edge: r.edge, pinAtFlag: r.pinAtFlag, pinClose: r.pinClose,
        clv: r.clv, venueClv: r.venueClv, sized: r.sized, status: r.status, outcome: r.outcome || null, final: r.final || null, flaggedAt: r.flaggedAt }));
    return { kinds, recent, total: rows.length };
  }
  function status() {
    const R = state.ratings;
    return { on: true, seed: seedData ? { lastMatch: seedData.lastMatch, teams: (seedData.teams || []).length } : null, built: state.built,
      footballData: { files: state.fdFiles, rows: state.fd.length, at: state.fdAt ? new Date(state.fdAt).toISOString() : null }, espn: { finals: state.espn.length, at: state.espnAt },
      refreshedAt: state.refreshedAt, errors: state.errors.slice(0, 8), upcoming: state.upcoming, ratings: R ? R.status() : null,
      leagues: PIN_LEAGUES.map(([, c]) => c), flagPts: FLAG_PTS, freezeMin: FREEZE_MIN,
      params: { k: opts.k, shrink: opts.shrink, promo: opts.promo, wSot: opts.wSot, rho: opts.rho, fitted: opts.fitted || null } };
  }
  const ratings = (code = null) => ensure().table(code).filter(t => !code || t.league === code).filter(t => PIN_LEAGUES.some(([, c]) => c === t.league));
  return { refresh, tick, grade, view, record, status, ratings, state, _rebuild: rebuild };
}

module.exports = { createSoccerModel, parseEspn, leagueOf, seasonOf, PIN_LEAGUES, VENUES, FLAG_PTS, FREEZE_MIN };
