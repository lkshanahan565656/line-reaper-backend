// ─── UFC HISTORY: EVERY UFC FIGHT'S TIME, STRIKES AND TAKEDOWNS ─────────────
// UFCStats (ufcstats.com) publishes every UFC fight's result and per-round
// stats. Greco1899/scrape_ufc_stats on GitHub mirrors it as CSV files that
// refresh daily; this reads those files (a public dataset on GitHub, no key,
// nothing to get past) and turns them into:
//   fights   one row a fight: date, the two fighters, rounds scheduled, the
//            round and clock it ended, minutes fought, method, winner, and
//            each fighter's significant strikes and takedowns landed
//   careers  each fighter's UFC minutes, strikes landed and absorbed, and
//            takedowns landed and conceded, before a given date
//   results  a finished fight's stats for one fighter, for grading
// Pure parsers; createUfcData is a thin fetch-and-cache wrapper.

const { canonName } = require('./ev');

const BASE = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main';
const FILES = { events: 'ufc_event_details.csv', results: 'ufc_fight_results.csv', stats: 'ufc_fight_stats.csv' };

// RFC 4180 CSV → array of row objects keyed by the header
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
// "October 17, 2026" → "2026-10-17"
function isoDate(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(String(s || '').trim());
  if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2])).toISOString().slice(0, 10);
}
const landed = s => { const m = /^(\d+)\s+of\s+(\d+)$/.exec(String(s || '').trim()); return m ? +m[1] : null; };
const mmss = s => { const m = /^(\d+):(\d{2})$/.exec(String(s || '').trim()); return m ? +m[1] * 60 + +m[2] : null; };
const bout = s => String(s || '').trim().replace(/\s+/g, ' ');
const isDecision = m => /^Decision/i.test(m || '');
// fights that settle nothing at the apps (overturned, no contest)
const isVoid = m => /overturned|no contest/i.test(m || '');

// weight class → one of the twelve divisions (catchweights and open weight: 'Other')
const DIVISIONS = ["Women's Strawweight", "Women's Flyweight", "Women's Bantamweight", "Women's Featherweight", 'Flyweight', 'Bantamweight',
  'Featherweight', 'Lightweight', 'Welterweight', 'Middleweight', 'Light Heavyweight', 'Heavyweight'];
function division(w) {
  const s = String(w || '');
  for (const d of DIVISIONS) if (s.includes(d) && !(d === 'Heavyweight' && s.includes('Light Heavyweight'))) return d;
  return 'Other';
}

// the three CSVs → fights, oldest first
function buildFights({ events, results, stats }) {
  const dateOf = new Map(events.map(e => [bout(e.EVENT), isoDate(e.DATE)]));
  const per = new Map();
  for (const r of stats) {
    const k = `${bout(r.EVENT)}|${bout(r.BOUT)}`;
    if (!per.has(k)) per.set(k, new Map());
    const m = per.get(k), f = bout(r.FIGHTER);
    if (!m.has(f)) m.set(f, { sig: 0, td: 0, ok: true });
    const x = m.get(f), a = landed(r['SIG.STR.']), t = landed(r.TD);
    if (a == null || t == null) { x.ok = false; continue; }
    x.sig += a; x.td += t;
  }
  const out = [];
  for (const r of results) {
    const ev = bout(r.EVENT), b = bout(r.BOUT), date = dateOf.get(ev);
    if (!date) continue;
    const names = b.split(/\s+vs\.\s+/);
    const fm = /^(\d)\s+Rnd\s+\((5-5-5(?:-5-5)?)\)$/.exec(String(r['TIME FORMAT'] || '').trim());
    if (names.length !== 2 || !fm) continue;
    const sched = +fm[1], round = parseInt(r.ROUND, 10), sec = mmss(r.TIME);
    if (!(sched === 3 || sched === 5) || !(round >= 1) || sec == null) continue;
    const st = per.get(`${ev}|${b}`) || new Map();
    const o = String(r.OUTCOME || '').trim();
    out.push({ date, event: ev, bout: b, sched, round, sec, T: +(((round - 1) * 5) + sec / 60).toFixed(3), method: String(r.METHOD || '').trim(),
      win: o === 'W/L' ? 0 : o === 'L/W' ? 1 : null, div: division(r.WEIGHTCLASS), url: r.URL || '',
      f: names.map(n => { const s = st.get(n); return { name: n, sig: s?.ok ? s.sig : null, td: s?.ok ? s.td : null }; }) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// fights → career totals per fighter, counting only fights before `before`
// (an ISO date; null counts all). Map(canonName → career)
function careers(fights, before = null) {
  const m = new Map();
  for (const f of fights) {
    if (before && f.date >= before) break;
    if (isVoid(f.method) || f.f.some(x => x.sig == null)) continue;
    for (let i = 0; i < 2; i++) {
      const me = f.f[i], op = f.f[1 - i], k = canonName(me.name);
      if (!m.has(k)) m.set(k, { name: me.name, n: 0, mins: 0, sigL: 0, sigA: 0, tdL: 0, tdA: 0, div: f.div, last: f.date });
      const c = m.get(k);
      c.n++; c.mins += f.T; c.sigL += me.sig; c.sigA += op.sig; c.tdL += me.td; c.tdA += op.td; c.div = f.div; c.last = f.date;
    }
  }
  return m;
}

// the career for an app's or Pinnacle's spelling of a name: the exact name,
// else the one fighter with the same surname and first initial (SuYoung You
// for Soyoung You, Abus Magomedov for Abusupiyan Magomedov), else null
const toks = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
  .split(/[\s-]+/).map(x => x.replace(/[^a-z]/g, '')).filter(Boolean);
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
// map: canonName → career ({ name, last }). The index is built once per map.
function findCareer(map, name) {
  const k = canonName(name);
  if (!k) return null;
  if (map.has(k)) return map.get(k);
  const t = toks(name), last = t[t.length - 1], first = t[0];
  if (!last || !first || t.length < 2) return null;
  if (!map._byLast) {
    Object.defineProperty(map, '_byLast', { value: new Map(), enumerable: false });
    for (const c of map.values()) { const tt = toks(c.name); if (tt.length < 2) continue; const l = tt[tt.length - 1]; if (!map._byLast.has(l)) map._byLast.set(l, []); map._byLast.get(l).push({ c, first: tt[0] }); }
  }
  const cands = (map._byLast.get(last) || []).filter(x => x.first[0] === first[0] && (x.first.startsWith(first) || first.startsWith(x.first) || lev(x.first, first) <= 2));
  if (cands.length === 1) return cands[0].c;
  // several: the one who fought most recently
  return cands.length > 1 ? cands.sort((a, b) => (String(a.c.last) < String(b.c.last) ? 1 : -1))[0].c : null;
}

// a fighter's finished fight near `start` (the app's start time) → { fight, me, op } | null
function fightOf(fights, player, start, { windowDays = 2 } = {}) {
  const k = canonName(player), t = Date.parse(start || '');
  if (!k || !t) return null;
  const near = [];
  for (let i = fights.length - 1; i >= 0; i--) {
    const f = fights[i], d = Date.parse(f.date + 'T12:00:00Z') - t;
    if (d < -(windowDays + 1) * 86400e3) break;
    if (Math.abs(d) <= windowDays * 86400e3) near.push({ f, d });
  }
  // the name as spelled, then a spelling apart (findCareer), then, inside one
  // fight, the surname and first initial when only one of the two carries them
  // (Timothy Angel Cuamba / Timmy Cuamba)
  const tp = toks(player), sur = tp[tp.length - 1], ini = (tp[0] || '')[0];
  const passes = [
    f => f.f.findIndex(x => canonName(x.name) === k),
    f => { const m = new Map(f.f.map((x, i) => [canonName(x.name), { name: x.name, i }])); const c = findCareer(m, player); return c ? c.i : -1; },
    f => { const hits = f.f.map((x, i) => { const tx = toks(x.name); return tx[tx.length - 1] === sur && (tx[0] || '')[0] === ini ? i : -1; }).filter(i => i >= 0); return hits.length === 1 ? hits[0] : -1; },
  ];
  for (const pass of passes) {
    let best = null;
    for (const { f, d } of near) { const at = pass(f); if (at >= 0 && (!best || Math.abs(d) < best.d)) best = { d: Math.abs(d), fight: f, idx: at }; }
    if (best) return { fight: best.fight, me: best.fight.f[best.idx], op: best.fight.f[1 - best.idx], won: best.fight.win == null ? null : best.fight.win === best.idx };
  }
  return null;
}

// one leg's result off a finished fight → { result, outcome, source } | { void } | null
const STAT = { significant_strikes: 'sig', takedowns: 'td' };
function gradeLeg(fights, pick) {
  const f = fightOf(fights, pick.player, pick.startTime);
  if (!f) return null;
  if (isVoid(f.fight.method)) return { void: 'no contest' };
  let v = null;
  if (STAT[pick.mkey]) v = f.me[STAT[pick.mkey]];
  else if (pick.mkey === 'fight_time') v = f.fight.T;
  else if (pick.mkey === 'finishes' || /^[1-5](st|nd|rd|th)_round_finish$/.test(pick.mkey)) {
    if (f.won == null) return null;
    const fin = f.won && !isDecision(f.fight.method);
    v = pick.mkey === 'finishes' ? (fin ? 1 : 0) : fin && f.fight.round === parseInt(pick.mkey, 10) ? 1 : 0;
  }
  if (v == null) return null;
  const line = Number(pick.signalLine);
  return { result: v, outcome: v === line ? 'push' : (v > line) === (pick.signalSide === 'Over') ? 'win' : 'loss', source: 'ufcstats', eventId: f.fight.url || `${f.fight.date}|${f.fight.bout}` };
}

// Fetch side: the three files once every ttl; a failed fetch keeps the last good copy
function createUfcData({ http, ttlMs = 6 * 3600e3, log = () => {}, now = () => Date.now() } = {}) {
  const state = { fights: [], at: 0, error: null, latest: null, loading: null };
  async function refresh(force = false) {
    if (!force && state.fights.length && now() - state.at < ttlMs) return state;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        const get = async f => String((await http.get(`${BASE}/${f}`, { timeout: 60000, responseType: 'text', transformResponse: x => x }))?.data || '');
        const [events, results, stats] = await Promise.all([get(FILES.events), get(FILES.results), get(FILES.stats)]);
        const fights = buildFights({ events: parseCsv(events), results: parseCsv(results), stats: parseCsv(stats) });
        if (fights.length < 1000) throw new Error(`only ${fights.length} fights`);
        Object.assign(state, { fights, at: now(), error: null, latest: fights[fights.length - 1].date });
      } catch (e) { state.error = e.message; log(`UFC data: ${e.message}`); }
      state.loading = null;
      return state;
    })();
    return state.loading;
  }
  let careerCache = { at: 0, m: new Map() };
  const careerMap = () => { if (careerCache.at !== state.at) careerCache = { at: state.at, m: careers(state.fights) }; return careerCache.m; };
  return {
    refresh, state,
    ready: () => state.fights.length > 0,
    careerOf: name => findCareer(careerMap(), name),
    grade: pick => (state.fights.length ? gradeLeg(state.fights, pick) : null),
    status: () => ({ fights: state.fights.length, latest: state.latest, at: state.at ? new Date(state.at).toISOString() : null, error: state.error }),
  };
}

module.exports = { BASE, FILES, findCareer, parseCsv, isoDate, buildFights, careers, fightOf, gradeLeg, division, isDecision, isVoid, DIVISIONS, createUfcData };
