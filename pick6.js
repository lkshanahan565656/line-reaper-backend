// ─── DRAFTKINGS PICK6 READER ──────────────────────────────────────────────────
// Pick6's board comes from the loader data its site uses (pickem.js
// parsePick6Board), no login. One sport a tick, every pick group of that sport
// a second or so apart, so a 2-minute tick refreshes each sport about every
// 20 minutes, PrizePicks' pace. A 403 or 429 backs off from the first one,
// longer each time and never sooner than its Retry-After.
// Off unless PICK6=on; under the paywall it also needs PICK6_DATA_OK (licences.js).
// DraftKings answers our Railway server with a 403 but answers GitHub's, so
// while the direct read is blocked the reader takes the board the pick6-relay
// workflow saves on the pick6-data branch (relayUrl), each sport stamped with
// when GitHub read it.

const { decodeTurboStream, pick6Home, pick6Sports, pick6Payouts, parsePick6Board } = require('./pickem');

const BASE = 'https://pick6.draftkings.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  Accept: '*/*', 'Accept-Language': 'en-US', Referer: `${BASE}/`,
};
const SPORTS_EVERY_MS = 3 * 3600e3;     // the sport list and payout table
const STALE_MS = 45 * 60e3;             // a sport unread this long drops off the board
const BACKOFF_MS = 5 * 60e3, BACKOFF_MAX_MS = 2 * 3600e3;
const MAX_GROUPS = 8, GROUP_GAP_MS = 1200;

function retryAfterMs(headers) {
  const v = headers?.['retry-after'];
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

function createPick6Reader(axios, { enabled = false, relayUrl = null, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), log = console } = {}) {
  const st = {
    enabled, sports: [], sportsAt: 0, next: 0, payouts: null,
    bySport: {},          // label → { lines, at, groups }
    fail: { limited: 0, until: 0 }, lastError: null, reads: 0, running: false,
    relay: { at: null, reads: 0, error: null },
  };
  const get = async (params) => {
    const res = await axios.get(`${BASE}/_root.data`, { params, headers: HEADERS, timeout: 20000, responseType: 'text', transformResponse: x => x, maxContentLength: 20e6 });
    st.reads++;
    const home = pick6Home(decodeTurboStream(res.data));
    if (!home) throw new Error('Pick6: no board in the answer');
    return home;
  };
  // the relayed board: a sport replaces ours only when GitHub read it later
  async function readRelay() {
    if (!relayUrl) return;
    try {
      const res = await axios.get(relayUrl, { params: { t: Math.floor(now() / 60000) }, timeout: 20000, maxContentLength: 20e6 });
      const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      st.relay.reads++;
      st.relay.at = d?.at || null;
      st.relay.error = null;
      for (const [label, v] of Object.entries(d?.bySport || {})) {
        const at = Date.parse(v.at);
        if (!Number.isFinite(at) || !Array.isArray(v.lines)) continue;
        if (!st.bySport[label] || st.bySport[label].at < at) st.bySport[label] = { lines: v.lines, at, groups: v.groups || 0, relay: true };
      }
      if (d?.payouts && Object.keys(d.payouts).length) st.payouts = d.payouts;
      if (!st.sports.length && Array.isArray(d?.sports)) st.sports = d.sports;
    } catch (e) { st.relay.error = String(e.message).slice(0, 200); }
  }
  async function tick() {
    if (!st.enabled || st.running) return;
    if (now() < st.fail.until) { st.running = true; try { await readRelay(); } finally { st.running = false; } return; }
    st.running = true;
    try {
      if (!st.sports.length || now() - st.sportsAt > SPORTS_EVERY_MS) {
        const home = await get({});
        const sports = pick6Sports(home).filter(s => s.open);
        if (sports.length) { st.sports = sports; st.sportsAt = now(); }
        const pay = pick6Payouts(home);
        if (Object.keys(pay).length) st.payouts = pay;
        await sleep(GROUP_GAP_MS);
      }
      if (!st.sports.length) return;
      const sport = st.sports[st.next++ % st.sports.length];
      const first = await get({ sport: sport.label });
      const groups = (first.pickGroups || []).map(g => g.pickGroupId).filter(Boolean);
      let lines = parsePick6Board(first, sport.label);
      const read = new Set([first.selectedPickGroup?.pickGroupId]);
      for (const id of groups.slice(0, MAX_GROUPS)) {
        if (read.has(id)) continue;
        await sleep(GROUP_GAP_MS);
        const h = await get({ sport: sport.label, pickGroup: id });
        read.add(id);
        lines = lines.concat(parsePick6Board(h, sport.label));
      }
      // a player in two pick groups (one game, and the all-day slate) once
      const seen = new Set();
      lines = lines.filter(l => { const k = `${l.player}|${l.market}|${l.line}|${l.startTime}`; if (seen.has(k)) return false; seen.add(k); return true; });
      st.bySport[sport.label] = { lines, at: now(), groups: read.size };
      st.fail = { limited: 0, until: 0 };
      st.lastError = null;
      log.log?.(`Pick6 ${sport.label}: ${lines.length} lines from ${read.size} pick group${read.size === 1 ? '' : 's'}`);
    } catch (e) {
      const s = e.response?.status;
      st.lastError = { status: s ?? null, message: String(e.message).slice(0, 200), at: new Date(now()).toISOString() };
      if (s === 403 || s === 429) {
        st.fail.limited++;
        const wait = Math.max(retryAfterMs(e.response?.headers), Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (st.fail.limited - 1)));
        st.fail.until = now() + wait;
        log.warn?.(`Pick6 blocked (${s}): next try in ${Math.round(wait / 60000)} min${relayUrl ? ', reading the relay meanwhile' : ''}`);
        await readRelay();
      } else log.warn?.('Pick6 error:', e.message, s);
    } finally { st.running = false; }
  }
  // every fresh line, sports and esports
  function lines(t = now()) {
    const out = [];
    for (const v of Object.values(st.bySport)) if (t - v.at <= STALE_MS) out.push(...v.lines);
    return out;
  }
  // when each sport was last read, keyed `pick6|SPORT` for the record's executable check
  function readTimes() {
    const out = {};
    for (const [label, v] of Object.entries(st.bySport)) for (const l of v.lines.slice(0, 1)) out[`pick6|${l.sport}`] = new Date(v.at).toISOString();
    return out;
  }
  // what the relay workflow saves: every sport it read, stamped with when
  function snapshot() {
    return { at: new Date(now()).toISOString(), payouts: st.payouts, sports: st.sports,
      bySport: Object.fromEntries(Object.entries(st.bySport).map(([k, v]) => [k, { at: new Date(v.at).toISOString(), groups: v.groups, lines: v.lines }])) };
  }
  function status() {
    return { enabled: st.enabled, relay: relayUrl ? { ...st.relay, sports: Object.entries(st.bySport).filter(([, v]) => v.relay).map(([k]) => k) } : null, sports: st.sports.map(s => s.label), reads: st.reads, payouts: st.payouts,
      bySport: Object.fromEntries(Object.entries(st.bySport).map(([k, v]) => [k, { lines: v.lines.length, groups: v.groups, at: new Date(v.at).toISOString() }])),
      lines: lines().length, blockedUntil: st.fail.until > now() ? new Date(st.fail.until).toISOString() : null, lastError: st.lastError };
  }
  return { tick, readRelay, lines, readTimes, snapshot, status, state: st };
}

module.exports = { createPick6Reader, retryAfterMs };
