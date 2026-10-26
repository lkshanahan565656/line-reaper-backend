// In-play add-on to the lead-lag recorder (diag/llrec.js, INPLAY=on).
// Pre-registered: /mnt/project-files/line-reaper/checks/inplay-2026-10-26/PREREGISTERED.md
// Its own loop (about every 20 s, not tied to the 1-min tick): Pinnacle's LIVE
// NBA / NHL / NFL / NCAAF full-game lines (matchups/live + markets/live/straight)
// and, for each Kalshi game matched to one of them, Kalshi's GAME, SPREAD and
// TOTAL events with every market's bid, ask and top-of-book size. Each Kalshi
// side whose ask (fee in) is at or past Pinnacle's no-vig fair on the same line
// gets its order book read and walked for $50 / $200 / $1,000.
//
// out/inplay.jsonl, one line per matched game per loop:
//   { t: Pinnacle read ms, tk: Kalshi read ms, gk, sp, lg, home, away, st, s: state,
//     ml: [home, away, limit], sp_: [[homePts, home, away, alt, limit]], to: [[line, over, under, alt, limit]],
//     k: [[ticker, kind, line, yesIsHome, yb, ya, ybSize, yaSize]] }    (kind m|s|t; prices in dollars)
// out/ipdepth.jsonl: { t, tk: ticker, buy, fair, line, f: [[usd, cost, ev, full] x tiers], top, atEdge }
const fs = require('fs');
const pingames = require('../pingames');
const xarb = require('../xarb');
const freebooks = require('../freebooks');
const D = require('../depthfill');
const execcheck = require('../execcheck');

const PIN = 'https://guest.api.arcadia.pinnacle.com/0.1';
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
const PSPORT = { basketball: 4, hockey: 19, football: 15 };
const PLEAGUE = { NBA: 'nba', NHL: 'nhl', NFL: 'nfl', NCAA: 'ncaaf' };
const KSER = { nba: 'KXNBA', nhl: 'KXNHL', nfl: 'KXNFL', ncaaf: 'KXNCAAF' };
const EVERY = +(process.env.INPLAY_EVERY_S || 20) * 1e3;
const STOP = Date.parse(process.env.INPLAY_STOP || '') || Infinity;
const MAX_BOOKS = 16;
const num = x => (x == null || x === '' ? null : Number.isFinite(+x) ? +x : null);
const prob = a => (a == null || !Number.isFinite(+a) || +a === 0 ? null : +a < 0 ? -a / (-a + 100) : 100 / (+a + 100));
const fee = p => p + 0.07 * p * (1 - p);
const wait = ms => new Promise(r => setTimeout(r, ms));

// Pinnacle live matchups + live markets → games { id, lg, home, away, st, s, ml, spreads, totals }
function parseLive(matchups, markets) {
  const by = new Map();
  for (const m of markets || []) {
    if (!m || m.period !== 0 || (m.status && m.status !== 'open')) continue;
    if (!by.has(m.matchupId)) by.set(m.matchupId, []);
    by.get(m.matchupId).push(m);
  }
  const out = [];
  for (const mu of matchups || []) {
    if (!mu || mu.type !== 'matchup' || !mu.isLive || (mu.units && mu.units !== 'Regular')) continue;
    const lg = PLEAGUE[mu.league?.name] || (process.env.INPLAY_ANY ? 'any' : null);
    if (!lg) continue;
    const parts = mu.participants || mu.parent?.participants || [];
    const home = parts.find(p => p.alignment === 'home')?.name, away = parts.find(p => p.alignment === 'away')?.name;
    if (!home || !away) continue;
    const pp = mu.parent?.participants || [];
    const sc = a => pp.find(p => p.alignment === a)?.state?.score ?? null;
    const g = { id: mu.id, lg, home, away, st: mu.parent?.startTime || mu.startTime, s: { h: sc('home'), a: sc('away'), ...(mu.parent?.state || mu.state || {}) }, ml: null, spreads: [], totals: [] };
    const lim = m => { const l = (m.limits || []).find(x => x?.type === 'maxRiskStake') || (m.limits || [])[0]; return Number(l?.amount) || null; };
    for (const m of by.get(mu.id) || []) {
      const price = d => m.prices?.find(p => p.designation === d);
      if (m.type === 'moneyline' && !m.isAlternate) {
        const h = price('home')?.price, a = price('away')?.price;
        if (h != null && a != null) g.ml = [h, a, lim(m)];
      } else if (m.type === 'spread') {
        const h = price('home'), a = price('away');
        if (h && a && h.points != null && Number(h.points) === -Number(a.points)) g.spreads.push([Number(h.points), h.price, a.price, m.isAlternate ? 1 : 0, lim(m)]);
      } else if (m.type === 'total') {
        const o = price('over'), u = price('under');
        if (o && u && o.points != null && Number(o.points) === Number(u.points)) g.totals.push([Number(o.points), o.price, u.price, m.isAlternate ? 1 : 0, lim(m)]);
      }
    }
    out.push(g);
  }
  return out;
}

// Kalshi /events/{ticker}?with_nested_markets payloads → [[ticker, kind m|s|t, line, yesIsHome, yb, ya, ybSize, yaSize, status]]
// (teams: the Kalshi game's labels; pol 'same' when teams[0] is Pinnacle's home)
function kalshiQuotes(evs, teams, pol) {
  const isHome = label => { const j = teams.findIndex(x => pingames.sameTeam(label, x) || x === label); return j < 0 ? null : (j === 0) === (pol === 'same'); };
  const half = x => Number.isFinite(x) && x > 0 && Math.abs((x * 2) % 2 - 1) < 1e-9;
  const kk = [];
  for (const e of evs) {
    const ev = e?.event ? { ...e.event, markets: e.event.markets || e.markets || [] } : null;
    if (!ev) continue;
    const ser = /(GAME|SPREAD|TOTAL)$/.exec(String(ev.series_ticker || ev.event_ticker?.split('-')[0] || ''))?.[1];
    for (const m of ev.markets) {
      const st = String(m.status || '').toLowerCase();
      if (!['active', 'open'].includes(st) || m.result) continue;
      const label = String(m.yes_sub_title || '').trim();
      const q = f => num(m[`${f}_dollars`]), z = f => num(m[`${f}_size_fp`] ?? m[`${f}_size`]);
      let kind = null, line = null, yh = null;
      if (ser === 'GAME') { kind = 'm'; yh = isHome(label); }
      else if (ser === 'SPREAD') {
        const team = label.match(/^(.+?)\s+wins?\s+by\b/i)?.[1]?.trim(), x = num(m.floor_strike);
        if (team && half(x) && (!m.strike_type || m.strike_type === 'greater')) { kind = 's'; line = x; yh = isHome(team); }
      } else if (ser === 'TOTAL') {
        const x = num(m.floor_strike);
        if (half(x) && (!m.strike_type || m.strike_type === 'greater') && !/under/i.test(label)) { kind = 't'; line = x; }
      }
      if (!kind || (kind !== 't' && yh == null)) continue;
      kk.push([m.ticker, kind, line, yh, q('yes_bid'), q('yes_ask'), z('yes_bid'), z('yes_ask')]);
    }
  }
  return kk;
}

// BetRivers (Kambi) live games: listView STARTED events → betoffer/event → { id, lg, home, away, st, s, ml, spreads, totals }
// (Pinnacle's guest feed serves live markets only with a key and caches the rest up to 15 min, so the
// live reference is BetRivers; see PREREGISTERED.md amendment). Main line = the pair closest to even.
const KLG = { nba: 'basketball/nba', nhl: 'ice_hockey/nhl', nfl: 'american_football/nfl', ncaaf: 'american_football/ncaaf' };
function kambiGame(lg, payload, live) {
  const e = payload?.events?.[0];
  if (!e) return null;
  const g0 = freebooks.parseKambiEvent({ ...payload, events: [{ ...e, state: 'NOT_STARTED' }] }, 0);
  if (!g0) return null;
  const prob1 = a => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
  const pairs = (outs, keyOf) => { const m = new Map(); for (const o of outs) { const k = keyOf(o); if (!m.has(k)) m.set(k, []); m.get(k).push(o); } return [...m.values()].filter(v => v.length === 2); };
  const mainIdx = ps => { let b = -1, bd = 9; ps.forEach((x, i) => { const d = Math.abs(prob1(x[1]) - prob1(x[2])); if (d < bd) { bd = d; b = i; } }); return b; };
  const h = g0.h2h.find(o => o.name === g0.home), a = g0.h2h.find(o => o.name === g0.away);
  let spreads = pairs(g0.spreads, o => Math.abs(o.point)).map(v => { const hh = v.find(o => o.name === g0.home), aa = v.find(o => o.name === g0.away); return hh && aa ? [hh.point, hh.price, aa.price, 1, null] : null; }).filter(Boolean);
  let totals = pairs(g0.totals, o => o.point).map(v => { const o = v.find(x => x.name === 'Over'), u = v.find(x => x.name === 'Under'); return o && u ? [o.point, o.price, u.price, 1, null] : null; }).filter(Boolean);
  const ms = mainIdx(spreads); if (ms >= 0) spreads[ms][3] = 0;
  const mt = mainIdx(totals); if (mt >= 0) totals[mt][3] = 0;
  const ld = live?.liveData || {};
  const st = { h: ld.score?.home ?? null, a: ld.score?.away ?? null, period: ld.matchClock?.period ?? null, min: ld.matchClock?.minute ?? null, sec: ld.matchClock?.second ?? null, running: ld.matchClock?.running ?? null, left: ld.matchClock?.minutesLeftInPeriod != null ? `${ld.matchClock.minutesLeftInPeriod}:${String(ld.matchClock.secondsLeftInMinute ?? 0).padStart(2, '0')}` : null };
  return { id: e.id, lg, home: g0.home, away: g0.away, st: e.start, s: st, ml: h && a ? [h.price, a.price, null] : null, spreads, totals };
}

function createInplay({ http, kget, stats }) {
  fs.mkdirSync('out', { recursive: true });
  const log = fs.createWriteStream('out/inplay.jsonl', { flags: 'a' });
  const dlog = fs.createWriteStream('out/ipdepth.jsonl', { flags: 'a' });
  const st = (stats.inplay = { loops: 0, lines: 0, books: 0, pinLive: {}, kGames: 0, matched: 0, brLive: {}, unmatched: {}, errors: {}, lastLoopMs: null, startedAt: new Date().toISOString() });
  let kgames = [], kgamesAt = 0, stopped = false;
  const err = (k, e) => { st.errors[k] = `${e.response?.status || ''} ${e.message || e}`.slice(0, 200); };

  // Kalshi GAME events open now (teams, start window), every 5 minutes
  async function discover() {
    if (Date.now() - kgamesAt < 5 * 60e3 && kgames.length) return;
    const rows = [];
    for (const [lg, root] of Object.entries(KSER)) {
      try {
        const r = await xarb.fetchKalshiEvents({ get: kget }, { seriesTicker: `${root}GAME`, maxPages: 3, onPage: page => rows.push(...xarb.parseKalshiBinaries(page).map(x => ({ ...x, lg, root }))) });
        if (r.errors.length) err(`kdisc_${lg}`, r.errors[0].message);
      } catch (e) { err(`kdisc_${lg}`, e); }
    }
    const groups = pingames.groupRows(rows.filter(r => r.exchange === 'kalshi'));
    kgames = groups.map(g => ({ ...g, lg: g.rows[0].lg, root: g.rows[0].root, suffix: String(g.key).split('|')[1] }));
    kgamesAt = Date.now(); st.kGames = kgames.length;
  }

  async function pinLive() {
    const games = [];
    await Promise.all(Object.entries(PSPORT).map(async ([sport, id]) => {
      try {
        const mu = (await http.get(`${PIN}/sports/${id}/matchups/live`, { headers: H, timeout: 12000 }))?.data;
        if (!Array.isArray(mu) || !mu.some(m => m.isLive && PLEAGUE[m.league?.name])) { st.pinLive[sport] = 0; return; }
        let mk;
        try { mk = (await http.get(`${PIN}/sports/${id}/markets/live/straight`, { headers: H, timeout: 12000 }))?.data; }
        catch (e) { err(`pinLiveMk_${sport}`, e); mk = (await http.get(`${PIN}/sports/${id}/markets/straight`, { headers: H, timeout: 15000 }))?.data; }
        const gs = parseLive(mu, mk);
        st.pinLive[sport] = gs.length;
        games.push(...gs);
      } catch (e) { err(`pinLive_${sport}`, e); }
    }));
    return games;
  }

  let sampled = 0;
  async function booksLive() {
    const games = [];
    await Promise.all(Object.entries(KLG).map(async ([lg, path]) => {
      try {
        const lv = (await http.get(`${freebooks.KAMBI}/listView/${path}/all/all/matches.json`, { params: { lang: 'en_US', market: 'US' }, timeout: 12000 }))?.data;
        const live = (lv?.events || []).filter(x => x?.event?.state === 'STARTED');
        st.brLive[lg] = live.length;
        await Promise.all(live.map(async x => {
          try {
            const p = (await http.get(`${freebooks.KAMBI}/betoffer/event/${x.event.id}.json`, { params: { lang: 'en_US', market: 'US' }, timeout: 12000 }))?.data;
            if (sampled < 2) { sampled++; fs.writeFileSync(`out/ipsample-${sampled}.json`, JSON.stringify({ live: x, p }).slice(0, 400000)); }
            const g = kambiGame(lg, p, x);
            if (g) games.push(g); else st.brNoParse = (st.brNoParse || 0) + 1;
          } catch (e) { err(`brEvent_${lg}`, e); }
        }));
      } catch (e) { err(`brList_${lg}`, e); }
    }));
    return games;
  }

  async function kEvent(ticker) {
    try { return (await kget(`${K}/events/${ticker}`, { params: { with_nested_markets: true }, timeout: 10000 }))?.data; }
    catch (e) { if (e.response?.status !== 404) err('kevent', e); return null; }
  }

  async function loop() {
    const t0 = Date.now();
    await discover();
    const pin = await booksLive();
    const t = Date.now();
    if (!pin.length) return;
    // match each live Pinnacle game to a Kalshi game: same league, teams either way round, window holds the start
    const jobs = [];
    for (const g of pin) {
      const sta = Date.parse(g.st || '');
      const cands = kgames.filter(k => k.lg === g.lg && (!Number.isFinite(sta) || (sta >= k.window[0] && sta <= k.window[1])))
        .map(k => ({ k, pol: pingames.sidesOf(k.teams, { home: g.home, away: g.away }) })).filter(x => x.pol);
      if (cands.length !== 1) { st.unmatched[`${g.lg} ${g.away} @ ${g.home}`] = cands.length; continue; }
      jobs.push({ g, k: cands[0].k, pol: cands[0].pol });
    }
    st.matched = jobs.length;
    const books = [];
    let i = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (i < jobs.length) {
        const job = jobs[i++];
        const { g, k, pol } = job;
        const evs = await Promise.all(['GAME', 'SPREAD', 'TOTAL'].map(s => kEvent(`${k.root}${s}-${k.suffix}`)));
        const tk = Date.now();
        const kk = kalshiQuotes(evs, k.teams, pol);
        const rec = { src: 'betrivers', t, tk, gk: k.key, pid: g.id, lg: g.lg, home: g.home, away: g.away, st: g.st, s: g.s, ml: g.ml, sp_: g.spreads, to: g.totals, k: kk };
        log.write(JSON.stringify(rec) + '\n'); st.lines++;
        // book reads: Kalshi sides at or past Pinnacle's fair on the same line
        for (const x of kk) {
          const [tick, kind, line, yh, yb, ya] = x;
          let pair = null;
          if (kind === 'm' && g.ml) pair = [g.ml[0], g.ml[1]];
          else if (kind === 's') { const s = g.spreads.find(s => (yh ? s[0] === -line : s[0] === line)); if (s) pair = [s[1], s[2]]; }
          else if (kind === 't') { const s = g.totals.find(s => s[0] === line); if (s) pair = [s[1], s[2]]; }
          if (!pair) continue;
          const f = pingames.devig(pair);
          if (!f) continue;
          // fair that YES wins / NO wins
          const pYes = kind === 't' ? f[0] : kind === 'm' ? (yh ? f[0] : f[1]) : (yh ? f[0] : f[1]);
          const sides = [['yes', ya, pYes], ['no', yb != null ? Math.round((1 - yb) * 100) / 100 : null, 1 - pYes]];
          for (const [buy, ask, fair] of sides) if (ask > 0 && ask < 1 && fair / fee(ask) - 1 >= 0) books.push({ tick, buy, fair, line, ev: fair / fee(ask) - 1 });
        }
      }
    }));
    books.sort((a, b) => b.ev - a.ev);
    for (const b of books.slice(0, MAX_BOOKS)) {
      try {
        const ob = (await kget(execcheck.KALSHI_BOOK_URL(b.tick), { timeout: 8000 }))?.data;
        const f = D.fillsOf(execcheck.kalshiAsks(ob, b.buy), b.fair, D.VENUES.kalshi);
        dlog.write(JSON.stringify({ t: Date.now(), tk: b.tick, buy: b.buy, fair: Math.round(b.fair * 1e4) / 1e4, line: b.line,
          f: D.TIERS.map(x => { const w = f.tiers[x]; return w ? [w.usd, w.cost, w.ev, w.full ? 1 : 0] : null; }), top: f.top, atEdge: f.atEdge }) + '\n');
        st.books++;
      } catch (e) { err('kbook', e); }
    }
    st.lastLoopMs = Date.now() - t0;
  }

  const done = (async () => {
    while (!stopped && Date.now() < STOP) {
      const s = Date.now();
      try { await loop(); } catch (e) { err('loop', e.stack || e); }
      st.loops++;
      await wait(Math.max(3000, EVERY - (Date.now() - s)));
    }
  })();
  return {
    async end() { stopped = true; await Promise.race([done, wait(60e3)]); await new Promise(r => log.end(r)); await new Promise(r => dlog.end(r)); },
  };
}

module.exports = { createInplay, parseLive, kalshiQuotes, PLEAGUE };
