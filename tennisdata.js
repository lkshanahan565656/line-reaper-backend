// ─── TENNIS MATCHUPS: DATA AND ENGINE (tennisdata.js) ─────────────────────────
// Feeds tennismodel.js: the seed of finished matches (ESPN's ATP/WTA
// scoreboards 2016 on, seeds/tennis-matches.json.gz), fresh results from the
// same scoreboards, and today's match-winner prices on the Texas venues
// (Kalshi, Polymarket US) next to Pinnacle's no-vig where Pinnacle lists the
// match. The model price is a model, not an edge: see the backtest file.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const T = require('./tennismodel');

const SEED = path.join(__dirname, 'seeds', 'tennis-matches.json.gz');
const BACKTEST = path.join(__dirname, 'seeds', 'tennis-matchup-backtest.json');
const SLAM_RE = /australian open|roland garros|french open|wimbledon|us open/i;
const SURF = ['hard', 'clay', 'grass'];
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// one ESPN singles row (the diag pull's shape, or built from a live
// scoreboard by espnRows) → a finished match, or null
function matchFromEspn(r) {
  if (!r || !/FINAL|RETIRED/.test(r.st || '')) return null;
  const ps = r.ps || [];
  if (ps.length !== 2 || ps.some(p => !p.n || /^tbd$/i.test(p.n) || !p.id || Number(p.id) < 0)) return null;
  if (ps[0].w === ps[1].w) return null;
  const t = Date.parse(r.date || '');
  if (!t) return null;
  const wi = ps[0].w ? 0 : 1;
  const setsWon = (ps[wi].s || []).filter((g, i) => g != null && g > (ps[1 - wi].s?.[i] ?? 0)).length;
  const qual = /qualif/i.test(r.round || '');
  const slamMen = SLAM_RE.test(r.ev || '') && r.tour === 'atp' && !qual;
  const ret = /RETIRED/.test(r.st);
  const bo = setsWon >= 3 || (slamMen && ret && setsWon >= 2) ? 5 : 3;
  return { id: String(r.cid), t, tour: r.tour, ev: r.ev || '', round: r.round || null, a: String(ps[0].id), an: ps[0].n, b: String(ps[1].id), bn: ps[1].n, w: ps[0].w ? 1 : 0, surf: T.surfaceOf(r.ev, t), bo, ret: ret ? 1 : 0 };
}
// a live ESPN scoreboard answer → the pull's row shape (singles only)
function espnRows(board, tour) {
  const out = [];
  for (const ev of board?.events || []) for (const g of ev.groupings || []) for (const c of g.competitions || []) {
    if (!/singles/i.test(`${c.type?.slug || ''} ${c.type?.text || ''} ${g.grouping?.slug || ''} ${g.grouping?.displayName || ''}`)) continue;
    const ps = (c.competitors || []).map(x => ({ n: x.athlete?.displayName || '', id: x.id, w: x.winner ? 1 : 0, s: (x.linescores || []).map(s => num(s.value)) }));
    if (ps.length !== 2) continue;
    out.push({ tour, ev: ev.name, evId: ev.id, cid: c.id, date: c.date || c.startDate, st: c.status?.type?.name || '', done: c.status?.type?.completed ? 1 : 0, round: c.round?.displayName || null, ps });
  }
  return out;
}

// compact seed: { players: [[id, name]], events: [name], rows: [[min, ai, bi, w, surf, bo, ev, ret, tour]] }
function compactMatches(list) {
  const pIdx = new Map(), players = [], eIdx = new Map(), events = [];
  const pi = (id, n) => { if (!pIdx.has(id)) { pIdx.set(id, players.length); players.push([id, n]); } else players[pIdx.get(id)][1] = n; return pIdx.get(id); };
  const ei = n => { if (!eIdx.has(n)) { eIdx.set(n, events.length); events.push(n); } return eIdx.get(n); };
  const rows = list.map(m => [Math.round(m.t / 60e3), pi(m.a, m.an), pi(m.b, m.bn), m.w, SURF.indexOf(m.surf), m.bo, ei(m.ev), m.ret ? 1 : 0, m.tour === 'wta' ? 1 : 0, m.id]);
  return { v: 1, players, events, rows };
}
function expandMatches(seed) {
  if (!seed?.rows) return [];
  const P = seed.players, E = seed.events;
  return seed.rows.map(r => ({ id: r[9], t: r[0] * 60e3, a: P[r[1]][0], an: P[r[1]][1], b: P[r[2]][0], bn: P[r[2]][1], w: r[3], surf: SURF[r[4]] || 'hard', bo: r[5], ev: E[r[6]], ret: r[7], tour: r[8] ? 'wta' : 'atp' }));
}
function loadSeed(file = SEED) {
  try { return expandMatches(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)))); } catch { return []; }
}
function loadBacktest(file = BACKTEST) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}


// ── live engine ──
const ES = require('./esmatchupdata');
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const PMUS = 'https://gateway.polymarket.us';
const PMUS_SITE = 'https://polymarket.us';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/tennis';
const ENGINE = {
  series: ['KXATPMATCH', 'KXWTAMATCH'],
  kalshiFee: 0.07, pmusFee: 0.0695, maxSpread: 0.08,
  edge: 0.03,              // the pre-registered flag: model p - cost to buy
  flagMinMins: 60,         // flags only at reads 60+ minutes before the start
  flagMaxMins: 24 * 60,
  resultsEveryMs: 20 * 60e3, venuesEveryMs: 3 * 60e3, aheadDays: 3, provenN: 50,
};
const MONTH_NO = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// "KXATPMATCH-26OCT25SINALC" → that day, 00:00 US Eastern (ms)
function kalshiDay(ticker) {
  const m = String(ticker || '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || !(m[2] in MONTH_NO)) return null;
  return Date.UTC(2000 + Number(m[1]), MONTH_NO[m[2]], Number(m[3]), 4);
}
const numOf = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
// Kalshi events (with nested markets) → [{ ticker, title, day, players: [{ name, ticker, bid, ask }] }]
function parseKalshiEvents(events) {
  const out = [];
  for (const ev of events || []) {
    const mks = (ev.markets || []).filter(m => !m.status || /^(active|open|initialized)$/.test(m.status));
    if (mks.length !== 2) continue;
    const players = mks.map(m => ({ name: m.yes_sub_title || '', ticker: m.ticker, bid: numOf(m.yes_bid_dollars), ask: numOf(m.yes_ask_dollars) }));
    if (players.some(x => !x.name)) continue;
    out.push({ ticker: ev.event_ticker, series: ev.series_ticker || String(ev.event_ticker || '').split('-')[0], title: ev.title || '', day: kalshiDay(ev.event_ticker), players });
  }
  return out;
}
// a Kalshi pair → { prob (first player, no-vig mid), sides: [{ ask, bid, cost }] }
function kalshiQuote(k, flip, o = ENGINE) {
  const [a, b] = flip ? [k.players[1], k.players[0]] : k.players;
  const mid = q => (q.bid > 0 && q.ask < 1 && q.ask > q.bid && q.ask - q.bid <= o.maxSpread + 1e-9 ? (q.bid + q.ask) / 2 : null);
  const ma = mid(a), mb = mid(b);
  const prob = ma != null && mb != null ? ma / (ma + mb) : ma != null ? ma : mb != null ? 1 - mb : null;
  const side = q => (q.ask > 0 && q.ask < 1 ? { ask: q.ask, bid: q.bid, cost: r4(q.ask + o.kalshiFee * q.ask * (1 - q.ask)) } : null);
  return { prob: r4(prob), sides: [side(a), side(b)], url: k.ticker ? `https://kalshi.com/markets/${String(k.series).toLowerCase()}/${String(k.ticker).toLowerCase()}` : null };
}
const lastOf = n => T.nameKey(n).last;
const pairKey = (a, b) => [lastOf(a), lastOf(b)].sort().join('|');
// do two name pairs name the same match? → null | { flip }
function samePair([a1, a2], [b1, b2]) {
  const s0 = Math.min(T.nameScore(a1, b1), T.nameScore(a2, b2)), s1 = Math.min(T.nameScore(a1, b2), T.nameScore(a2, b1));
  if (Math.max(s0, s1) < 0.8) return null;
  return { flip: s1 > s0 };
}

function createTennisEngine({ http, store = null, pinnacle = () => [], kalshiOn = true, pmusOn = true, log = console, now = () => Date.now(), seed = null, opts = {} } = {}) {
  const o = { ...ENGINE, ...opts };
  const matches = new Map();
  for (const m of seed || loadSeed()) matches.set(m.id, m);
  const tourOf = new Map();   // player id → 'atp' | 'wta'
  const state = {
    ratings: null, ready: false, resultsAt: null, resultsError: null, newResults: 0, schedule: [],
    kalshi: { on: !!kalshiOn, events: [], at: null, error: null }, pmus: { on: !!pmusOn, events: [], at: null, error: null },
    record: new Map(), recordLoaded: false, backtest: loadBacktest(), lastResult: null,
  };
  let byLast = new Map();
  function rebuild() {
    const list = [...matches.values()].sort((a, b) => a.t - b.t);
    state.ratings = T.buildRatings(list);
    tourOf.clear();
    for (const m of list) { tourOf.set(m.a, m.tour); tourOf.set(m.b, m.tour); }
    byLast = new Map();
    for (const m of list) for (const [id, n] of [[m.a, m.an], [m.b, m.bn]]) {
      const k = lastOf(n); if (!byLast.has(k)) byLast.set(k, new Map());
      byLast.get(k).set(id, n);
    }
    state.lastResult = list.length ? new Date(list[list.length - 1].t).toISOString() : null;
  }
  rebuild();
  // a venue's player name → our player id (the best name fit; ties go to the most matches)
  function resolve(name) {
    const k = lastOf(name);
    const cands = [...(byLast.get(k) || new Map())];
    // "Bautista Agut" style double surnames: try every word
    if (!cands.length) for (const w of T.nameKey(name).all) if (w.length > 2) cands.push(...(byLast.get(w) || new Map()));
    let best = null;
    for (const [id, n] of cands) {
      const s = T.nameScore(name, n);
      if (s < 0.8) continue;
      const p = state.ratings.player(id);
      const key = [s, p ? p.n : 0];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { id, name: n, key };
    }
    return best ? { id: best.id, name: best.name, fit: best.key[0] } : null;
  }

  async function refreshResults() {
    const t = now();
    let added = 0;
    const sched = [];
    try {
      for (const tour of ['atp', 'wta']) for (const d of [-1, 0, 1]) {
        const day = new Date(t + d * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
        const res = await http.get(`${ESPN}/${tour}/scoreboard`, { params: { dates: day }, timeout: 15000 });
        for (const r of espnRows(res?.data, tour)) {
          const m = matchFromEspn(r);
          if (m) {
            if (!matches.has(m.id)) {
              const known = tourOf.get(m.a) || tourOf.get(m.b);
              const tr = known || m.tour;
              matches.set(m.id, { ...m, tour: tr, bo: tr === 'wta' ? 3 : m.bo }); added++;
            }
          } else if (/SCHEDULED|IN_PROGRESS/.test(r.st || '') && r.ps.every(x => x.n && !/^tbd$/i.test(x.n))) {
            sched.push({ id: String(r.cid), tour, ev: r.ev, round: r.round, start: r.date, live: /IN_PROGRESS/.test(r.st), names: r.ps.map(x => x.n), ids: r.ps.map(x => String(x.id)) });
          }
        }
      }
      if (added) rebuild();
      const seen = new Set();
      state.schedule = sched.filter(x => !seen.has(x.id) && seen.add(x.id));
      Object.assign(state, { resultsAt: new Date(t).toISOString(), resultsError: null, newResults: state.newResults + added, ready: true });
    } catch (e) {
      state.resultsError = `${e.response?.status || ''} ${e.message}`.trim();
      state.ready = matches.size > 0;
      log.warn?.(`Tennis matchups: ESPN: ${state.resultsError}`);
    }
    return added;
  }
  async function refreshKalshi() {
    if (!state.kalshi.on || !http) return;
    const t = now(), evs = [];
    try {
      for (const series of o.series) {
        let cursor = null;
        for (let page = 0; page < 5; page++) {
          const res = await http.get(`${KALSHI}/events`, { params: { series_ticker: series, status: 'open', with_nested_markets: true, limit: 200, ...(cursor ? { cursor } : {}) }, timeout: 15000 });
          evs.push(...(res?.data?.events || []));
          cursor = res?.data?.cursor;
          if (!cursor || !(res?.data?.events || []).length) break;
        }
      }
      Object.assign(state.kalshi, { events: parseKalshiEvents(evs), at: new Date(t).toISOString(), error: null });
    } catch (e) {
      state.kalshi.error = `${e.response?.status || ''} ${e.message}`.trim();
      log.warn?.(`Tennis matchups: Kalshi: ${state.kalshi.error}`);
    }
  }
  async function refreshPmus() {
    if (!state.pmus.on || !http) return;
    const t = now(), out = [];
    try {
      for (const league of ['atp', 'wta']) {
        for (let page = 0; page < 4; page++) {
          const res = await http.get(`${PMUS}/v2/leagues/${league}/events`, { params: { limit: 50, offset: page * 50 }, timeout: 10000 });
          const list = Array.isArray(res?.data?.events) ? res.data.events : [];
          out.push(...ES.parsePmusEvents(list, { ...ES.DEFAULTS, pmusFeeRate: o.pmusFee }, league, 'tennis_match_winner').map(x => ({ ...x, league, url: `${PMUS_SITE}/sports/${league}/${encodeURIComponent(x.slug)}` })));
          if (list.length < 50) break;
        }
      }
      Object.assign(state.pmus, { events: out, at: new Date(t).toISOString(), error: null });
    } catch (e) {
      state.pmus.error = `${e.response?.status || ''} ${e.message}`.trim();
      log.warn?.(`Tennis matchups: Polymarket US: ${state.pmus.error}`);
    }
  }
  const fresh = (v, ms = 10 * 60e3) => v.at && now() - Date.parse(v.at) <= ms;

  // every match ahead on Kalshi or Polymarket US, with the model and Pinnacle
  function list({ days = o.aheadDays, tour = null } = {}) {
    const t = now();
    const items = [];
    const find = (names, start) => items.find(it => (start == null || it.start == null || Math.abs(Date.parse(it.start) - start) < 30 * 3600e3) && samePair(it.names, names));
    const add = (names, start, patch) => {
      let it = find(names, start);
      if (!it) { it = { names, start: start != null ? new Date(start).toISOString() : null, startFrom: null, sources: {} }; items.push(it); }
      return it;
    };
    if (fresh(state.pmus)) for (const e of state.pmus.events) {
      const st = Date.parse(e.start || '') || null;
      const it = add(e.teams, st);
      it.sources.pmus = { e, flip: samePair(it.names, e.teams)?.flip || false };
      if (st && !it.startFrom) { it.start = new Date(st).toISOString(); it.startFrom = 'Polymarket US'; }
      it.event = it.event || String(e.slug || '').split('-')[0];
      it.tour = it.tour || e.league;
    }
    if (fresh(state.kalshi)) for (const k of state.kalshi.events) {
      const names = k.players.map(x => x.name);
      const it = add(names, k.day != null ? k.day + 12 * 3600e3 : null);
      it.sources.kalshi = { k, flip: samePair(it.names, names)?.flip || false };
      it.tour = it.tour || (/WTA/.test(k.series) ? 'wta' : 'atp');
      if (!it.start && k.day != null) { it.start = new Date(k.day).toISOString(); it.startFrom = 'Kalshi (day only)'; it.dayOnly = true; }
    }
    // Pinnacle and ESPN only add to matches a Texas venue lists
    for (const g of pinnacle() || []) {
      if (g.sport !== 'tennis' || !g.ml) continue;
      const st = Date.parse(g.start || '');
      const it = items.find(x => samePair(x.names, [g.home, g.away]) && (x.dayOnly || !x.start || Math.abs(Date.parse(x.start) - st) < 30 * 3600e3));
      if (!it) continue;
      const flip = samePair(it.names, [g.home, g.away]).flip;
      it.sources.pinnacle = { prob: r4(flip ? g.ml.away : g.ml.home), league: g.league, start: g.start };
      it.start = new Date(st).toISOString(); it.startFrom = 'Pinnacle'; it.dayOnly = false;
      it.event = g.league || it.event;
    }
    for (const s of state.schedule) {
      const it = items.find(x => samePair(x.names, s.names));
      if (!it) continue;
      it.espn = { ev: s.ev, round: s.round, live: s.live };
      if ((it.dayOnly || !it.start) && s.start) { it.start = s.start; it.startFrom = 'ESPN'; it.dayOnly = false; }
      it.event = s.ev || it.event; it.round = s.round;
    }
    const out = [];
    for (const it of items) {
      const st = Date.parse(it.start || '');
      if (Number.isFinite(st) && (st > t + days * 86400e3 || (!it.dayOnly && st < t - 4 * 3600e3) || (it.dayOnly && st < t - 30 * 3600e3))) continue;
      if (it.espn?.live) continue;
      const players = it.names.map(n => { const r = resolve(n); return { name: n, id: r?.id || null, matched: r?.name || null }; });
      const trAll = players.map(p => (p.id ? tourOf.get(p.id) : null)).find(Boolean) || it.tour || 'atp';
      if (tour && trAll !== tour) continue;
      const evName = it.espn?.ev || it.event || '';
      const surf = T.surfaceOf(evName, Number.isFinite(st) ? st : t);
      const qual = /qualif/i.test(`${it.round || ''} ${evName}`);
      const bestOf = trAll === 'atp' && SLAM_RE.test(evName) && !qual ? 5 : 3;
      const pred = players.every(p => p.id) ? state.ratings.predict(players[0].id, players[1].id, { surf, t: Number.isFinite(st) ? st : t, bestOf }) : { priced: false, reason: 'not in our results', matches: players.map(p => (p.id ? state.ratings.player(p.id)?.n || 0 : 0)) };
      const kq = it.sources.kalshi ? kalshiQuote(it.sources.kalshi.k, it.sources.kalshi.flip, o) : null;
      const uq = it.sources.pmus ? ES.pmusPrice(it.sources.pmus.e, it.sources.pmus.flip, { ...ES.DEFAULTS }) : null;
      if (uq) uq.url = it.sources.pmus.e.url;
      const pin = it.sources.pinnacle || null;
      const model = pred.priced ? pred.p : null;
      const edges = [];
      if (model != null) for (const [venue, q] of [['Kalshi', kq], ['Polymarket US', uq]]) for (let i = 0; i < 2; i++) {
        const c = q?.sides?.[i]?.cost;
        if (c != null) edges.push({ venue, side: i, player: it.names[i], cost: c, edge: r4((i === 0 ? model : 1 - model) - c) });
      }
      const id = `${trAll}-${pairKey(it.names[0], it.names[1]).replace(/\|/g, '-')}-${new Date(Number.isFinite(st) ? st : t).toISOString().slice(0, 10)}`;
      out.push({
        id, tour: trAll, event: evName || null, round: it.round || null, surface: surf, bestOf, start: it.start, startFrom: it.startFrom, dayOnly: !!it.dayOnly,
        players: players.map((p, i) => ({ ...p, view: p.id ? state.ratings.view(p.id) : null, model: model == null ? null : r4(i === 0 ? model : 1 - model) })),
        model: { priced: pred.priced, p: model, reason: pred.priced ? null : pred.reason, matches: pred.matches, detail: pred.priced ? pred : null },
        explain: T.explain(pred, it.names),
        markets: { kalshi: kq, pmus: uq, pinnacle: pin ? { prob: pin.prob, league: pin.league } : null },
        compare: { model, pinnacle: pin?.prob ?? null, kalshi: kq?.prob ?? null, pmus: uq?.prob ?? null, vsPinnacle: model != null && pin ? r4(model - pin.prob) : null },
        edges: edges.sort((a, b) => b.edge - a.edge),
      });
    }
    return out.sort((a, b) => (Date.parse(a.start) || Infinity) - (Date.parse(b.start) || Infinity));
  }

  // the record: kind tennis-matchups, flags at 3+ points over the cost, 60+ minutes out
  async function track() {
    if (!store) return;
    if (!state.recordLoaded) { for (const r of await store.all()) if (String(r.id).startsWith('ten:')) state.record.set(r.id, r); state.recordLoaded = true; }
    const t = now(), changed = [];
    for (const mu of list({ days: 2 })) {
      if (mu.dayOnly) continue;
      const st = Date.parse(mu.start), mins = (st - t) / 60e3;
      for (const e of mu.edges) {
        const id = `ten:${e.venue === 'Kalshi' ? 'k' : 'u'}:${mu.id}:${e.side}`;
        let row = state.record.get(id);
        const pin = mu.compare.pinnacle == null ? null : e.side === 0 ? mu.compare.pinnacle : r4(1 - mu.compare.pinnacle);
        if (!row && e.edge >= o.edge && mins >= o.flagMinMins && mins <= o.flagMaxMins) {
          row = { id, kind: 'tennis-matchups', venue: e.venue, matchId: mu.id, tour: mu.tour, event: mu.event, start: mu.start, players: mu.players.map(p => ({ name: p.name, id: p.id })), side: e.side, pick: e.player,
            model: e.side === 0 ? mu.model.p : r4(1 - mu.model.p), cost: e.cost, edge: e.edge, pinAtFlag: pin, flaggedAt: new Date(t).toISOString(), pinClose: null, status: 'open' };
          state.record.set(id, row); changed.push(row);
        } else if (row && row.status === 'open' && mins > 0) {
          let moved = false;
          if (pin != null && pin !== row.pinClose) { row.pinClose = pin; row.pinCloseAt = new Date(t).toISOString(); moved = true; }
          const vq = e.venue === 'Kalshi' ? mu.markets.kalshi : mu.markets.pmus;
          const vp = vq?.prob == null ? null : e.side === 0 ? vq.prob : r4(1 - vq.prob);
          if (vp != null && vp !== row.venueClose) { row.venueClose = vp; moved = true; }
          if (moved) changed.push(row);
        }
      }
    }
    for (const row of state.record.values()) {
      if (row.status !== 'open' || t < Date.parse(row.start)) continue;
      const [a, b] = row.players.map(p => p.id);
      const st = Date.parse(row.start);
      const m = a && b ? [...matches.values()].find(x => ((x.a === a && x.b === b) || (x.a === b && x.b === a)) && x.t > st - 18 * 3600e3 && x.t < st + 36 * 3600e3) : null;
      if (m) {
        const pickId = row.players[row.side].id;
        const won = (m.w === 1 ? m.a : m.b) === pickId;
        Object.assign(row, { status: 'graded', won, profit: r4(won ? 1 / row.cost - 1 : -1), clv: row.pinClose != null ? r4(row.pinClose / row.cost - 1) : null, retired: !!m.ret, gradedAt: new Date(t).toISOString(), source: 'espn' });
        changed.push(row);
      } else if (t - st > 4 * 86400e3) { Object.assign(row, { status: 'void', why: 'no ESPN result in four days (walkover, Challenger or a name we could not match)' }); changed.push(row); }
    }
    if (changed.length) await store.putMany(changed);
  }
  function record() {
    const rows = [...state.record.values()].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    const g = rows.filter(r => r.status === 'graded');
    const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const tOf = a => { if (a.length < 2) return null; const mu = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1)); return sd > 0 ? r4(mu / (sd / Math.sqrt(a.length))) : null; };
    const clv = g.filter(r => r.clv != null).map(r => r.clv);
    const sum = rs => ({ graded: rs.length, wins: rs.filter(r => r.won).length, profitUnits: r4(rs.reduce((s, r) => s + r.profit, 0)), roi: r4(mean(rs.map(r => r.profit))) });
    return {
      kind: 'tennis-matchups', provenN: o.provenN, alerts: false,
      summary: { flagged: rows.length, open: rows.filter(r => r.status === 'open').length, void: rows.filter(r => r.status === 'void').length, ...sum(g),
        clvN: clv.length, clvMean: r4(mean(clv)), clvT: tOf(clv), byVenue: { Kalshi: sum(g.filter(r => r.venue === 'Kalshi')), 'Polymarket US': sum(g.filter(r => r.venue !== 'Kalshi')) },
        proven: false, note: `${g.length} of ${o.provenN} graded. Judged on CLV vs Pinnacle's close and results at 50; alerts off.` },
      rows: rows.slice(0, 200),
    };
  }
  async function refresh({ results = true } = {}) {
    if (results) await refreshResults();
    await Promise.all([refreshKalshi(), refreshPmus()]);
    await track().catch(e => log.warn?.(`Tennis matchups record: ${e.message}`));
    return status();
  }
  function status() {
    return {
      game: 'TEN', label: 'Tennis', ready: state.ready, matches: matches.size, players: state.ratings.size(), lastResult: state.lastResult, resultsAt: state.resultsAt,
      newResults: state.newResults, error: state.resultsError, scheduled: state.schedule.length,
      kalshi: { on: state.kalshi.on, events: state.kalshi.events.length, at: state.kalshi.at, error: state.kalshi.error },
      pmus: { on: state.pmus.on, markets: state.pmus.events.length, at: state.pmus.at, error: state.pmus.error },
    };
  }
  return { refresh, refreshResults, refreshKalshi, refreshPmus, list, track, record, status, resolve, state, ratings: () => state.ratings, matches, tourOf: id => tourOf.get(id) || null };
}

module.exports = { SEED, BACKTEST, SLAM_RE, ENGINE, matchFromEspn, espnRows, compactMatches, expandMatches, loadSeed, loadBacktest, kalshiDay, parseKalshiEvents, kalshiQuote, samePair, pairKey, createTennisEngine };
