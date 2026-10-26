// ─── PUBLIC BETTOR RECORDS: A BETTOR'S OWN SLIPS, GRADED IN PUBLIC ──────────
// MY SLIPS keeps a bettor's slips in their browser. PUBLISH RECORD sends them
// here under a handle the bettor picks, and /r/<handle> shows every slip
// graded the way RESULTS grades our own kinds: each leg against Pinnacle's own
// last number before the start (at the leg's line, never read along a curve)
// and settled from the box scores, with the same strict label.
//
// What makes it a record anyone can check:
//   - the time a slip reached us is stamped here (receivedAt), never taken
//     from the browser or a tracker's file. A slip whose earliest leg started
//     before that time is LATE: shown, never counted. An imported history is
//     therefore all LATE, and the record counts only slips logged from here on.
//   - a slip, once in, can't be edited or taken out one at a time. The only way
//     out is UNPUBLISH, which wipes the whole record; publishing the handle
//     again starts a new record, and the page says so.
//   - results come from our graders (box scores, settlements), never from the
//     bettor's mark or a tracker's profit. Units are 1 unit a slip at the
//     app's standard payout table; no stake or payout is ever stored here.
//   - the label is the RESULTS rule: 'proven' only with 50 legs at one app
//     graded against Pinnacle's close at their own line, a CLV t of 2 or more,
//     and results not running 1.5 sd under what that close expected. Never
//     pooled across apps. Units are called a profit only on a proven row whose
//     units also clear chance.
//
// The page is the same for every viewer: no follow, no copy, no alerts tied to
// a record, no sizing (CFTC 4.14(a)(9)). The handle is the bettor's own words;
// we don't check who is behind it, and the page says so.
//
// Store: { init(), all(), put(doc) } (evtrack's file or Postgres store, wrapped
// by the results backup). Docs: one 'record' per handle and one 'slip' per
// slip. Nothing is ever deleted (the backup only adds missing ids): unpublish
// rewrites the docs empty.

const crypto = require('crypto');
const S = require('./slips');

const MAX_SLIPS = 5000, MAX_POST = 500, MAX_LEGS = 12, MAX_RECORDS = 20000;
const CREATE_PER_HOUR = 3;
const BAR = 50, CLV_T = 2, SHORT_SD = 1.5;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'api', 'app', 'card', 'cards', 'share', 'results', 'record', 'records', 'lr', 'linereaper', 'line_reaper', 'line_reaper_', 'official', 'support',
  'help', 'status', 'learn', 'leagues', 'developers', 'digest', 'null', 'undefined', 'pinnacle', 'kalshi', 'polymarket', 'prizepicks', 'underdog', 'sleeper', 'pikkit', 'staff', 'mod', 'root']);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const str = (v, n = 80) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const err = (status, message) => Object.assign(new Error(message), { status });

function cleanHandle(h) {
  const s = String(h ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE_RE.test(s)) return { error: 'A handle is 3 to 20 letters, digits or _.' };
  if (RESERVED.has(s) || /^(line_?reaper|lr_)/.test(s)) return { error: 'That handle is reserved. Pick another.' };
  return { handle: s };
}

// a slip from the browser → what we keep: the legs and the app, nothing about money
function cleanSlip(s) {
  if (!s || typeof s !== 'object') return null;
  const id = str(s.id, 80);
  const app = S.APPS[s.app] ? s.app : 'other';
  if (!id || !Array.isArray(s.legs) || !s.legs.length || s.legs.length > MAX_LEGS) return null;
  const legs = [];
  for (const l of s.legs) {
    const side = l?.side === 'Over' || l?.side === 'Under' ? l.side : null;
    const line = Number(l?.line);
    const player = str(l?.player), market = str(l?.market, 60);
    if (!side || !Number.isFinite(line) || !player || !market) return null;
    legs.push({ player, market, side, line, ...(l.sport ? { sport: str(l.sport, 12).toUpperCase() } : {}), ...(l.opp ? { opp: str(l.opp, 40) } : {}) });
  }
  const placed = Date.parse(s.placedAt || '');
  const source = ['paste', 'board', 'pikkit', 'import'].includes(s.source) ? s.source : 'paste';
  return { id, app, flex: !!s.flex, legs, placedAt: Number.isFinite(placed) ? new Date(placed).toISOString() : null, source,
    ...(s.format ? { format: str(s.format, 20) } : {}), ...(s.timed ? { timed: true } : s.timed === false ? { timed: false } : {}) };
}

// what we keep of a grade: enough to show and check it
function slimGrade(g) {
  if (!g || typeof g !== 'object') return null;
  const m = g.matched;
  const raw = g.raw && g.raw.source ? { source: g.raw.source, fair: g.raw.fair ?? null, ev: g.raw.ev ?? null, line: g.raw.line ?? null, exact: !!g.raw.exact, ok: g.raw.ok !== false } : null;
  return {
    status: g.status || null, final: !!g.final, ...(g.reason ? { reason: g.reason } : {}),
    ...(m ? { matched: { sport: m.sport || null, player: m.player || null, market: m.market || null, start: m.start || null, matchTitle: m.matchTitle || '' } } : {}),
    decimal: g.decimal ?? null, closeFair: g.closeFair ?? null, closeEv: g.closeEv ?? null, closeOk: g.closeOk ?? null, raw,
    outcome: g.outcome || null, result: g.result ?? null, voidReason: g.voidReason || null, gradeSource: g.gradeSource || null,
    ...(g.late ? { late: true } : {}), ...(g.esports ? { esports: true } : {}), ...(g.matchUncertain ? { matchUncertain: true } : {}),
  };
}

// ── the store ──
function createRecordStore({ store, now = () => Date.now(), random = n => crypto.randomBytes(n), log = console, perHour = CREATE_PER_HOUR } = {}) {
  const records = new Map();   // handle → record doc
  const slips = new Map();     // handle → Map(slipId → slip doc)
  const created = new Map();   // who → [times]
  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        await store.init?.();
        for (const d of await store.all()) {
          if (!d || !d.handle) continue;
          if (d.kind === 'record') records.set(d.handle, d);
          else if (d.kind === 'slip' && d.slip) { if (!slips.has(d.handle)) slips.set(d.handle, new Map()); slips.get(d.handle).set(d.slip.id, d); }
        }
      })().catch(e => { log.warn?.(`Public records: load failed: ${e.message}`); });
    }
    return ready;
  }
  const live = h => { const r = records.get(h); return r && r.status === 'live' ? r : null; };
  const owns = (r, token) => !!r && typeof token === 'string' && /^lrr_[\w-]{20,64}$/.test(token) && sha256(token) === r.ownerHash;

  // a new handle, or the same owner publishing an unpublished handle again
  async function publish({ handle, token = null, who = '' } = {}) {
    await init();
    const c = cleanHandle(handle);
    if (c.error) throw err(400, c.error);
    const h = c.handle, t = now(), at = new Date(t).toISOString();
    const prev = records.get(h);
    if (prev) {
      if (!owns(prev, token)) throw err(409, 'That handle is taken. Pick another.');
      if (prev.status === 'live') return { handle: h, token, record: publicMeta(prev), already: true };
      const doc = { ...prev, status: 'live', publishedAt: at, restarts: [...(prev.restarts || []), { unpublishedAt: prev.unpublishedAt, republishedAt: at }].slice(-20), unpublishedAt: null };
      records.set(h, doc);
      await store.put(doc);
      return { handle: h, token, record: publicMeta(doc) };
    }
    const recent = (created.get(who) || []).filter(x => t - x < 3600e3);
    if (recent.length >= perHour) throw Object.assign(err(429, `At most ${perHour} new records an hour from one address. Try again later.`), { retryAfter: Math.ceil((recent[0] + 3600e3 - t) / 1000) });
    if (records.size >= MAX_RECORDS) throw err(503, 'No new records can be made right now.');
    const tok = `lrr_${random(24).toString('base64url')}`;
    const doc = { id: `rec|${h}`, kind: 'record', status: 'live', handle: h, ownerHash: sha256(tok), createdAt: at, publishedAt: at, unpublishedAt: null, restarts: [] };
    records.set(h, doc);
    created.set(who, [...recent, t]);
    if (created.size > 5000) created.clear();
    await store.put(doc);
    return { handle: h, token: tok, record: publicMeta(doc) };
  }

  // slips in: each new id stamped with the time it reached us; an id we have is left alone
  async function addSlips(handle, token, list) {
    await init();
    const h = cleanHandle(handle).handle;
    const r = h && live(h);
    if (!r) throw err(404, 'No published record with that handle.');
    if (!owns(r, token)) throw err(403, 'That key does not manage this record.');
    if (!Array.isArray(list)) throw err(400, 'slips needed');
    if (list.length > MAX_POST) throw err(413, `At most ${MAX_POST} slips at a time.`);
    if (!slips.has(h)) slips.set(h, new Map());
    const have = slips.get(h);
    const at = new Date(now()).toISOString();
    let added = 0, skipped = 0, bad = 0;
    for (const raw of list) {
      const s = cleanSlip(raw);
      if (!s) { bad++; continue; }
      if (have.has(s.id)) { skipped++; continue; }
      if ([...have.values()].filter(d => d.status === 'live').length >= MAX_SLIPS) { bad++; continue; }
      const doc = { id: `slip|${h}|${s.id}`, kind: 'slip', status: 'live', handle: h, slip: s, receivedAt: at, grades: {} };
      have.set(s.id, doc);
      await store.put(doc);
      added++;
    }
    return { added, skipped, bad, total: [...have.values()].filter(d => d.status === 'live').length };
  }

  // the whole record out: every slip emptied, the handle kept for its owner
  async function unpublish(handle, token) {
    await init();
    const h = cleanHandle(handle).handle;
    const r = h && records.get(h);
    if (!r || r.status !== 'live') throw err(404, 'No published record with that handle.');
    if (!owns(r, token)) throw err(403, 'That key does not manage this record.');
    const at = new Date(now()).toISOString();
    for (const d of slips.get(h)?.values() || []) {
      if (d.status !== 'live') continue;
      const out = { id: d.id, kind: 'slip', status: 'removed', handle: h, slip: { id: d.slip.id }, removedAt: at };
      slips.get(h).set(d.slip.id, out);
      await store.put(out);
    }
    const doc = { ...r, status: 'unpublished', unpublishedAt: at };
    records.set(h, doc);
    await store.put(doc);
    return { handle: h, unpublishedAt: at };
  }

  // grades back from the slip graders, by leg key → kept on each slip that has the leg
  async function applyGrades(handle, results) {
    const have = slips.get(handle);
    if (!have || !results) return 0;
    let changed = 0;
    for (const d of have.values()) {
      if (d.status !== 'live') continue;
      const sl = gradeSlip(d);
      let touched = false;
      const grades = { ...d.grades };
      for (const l of sl.legs) {
        const k = S.legKey(sl, l), g = results[k];
        if (!g) continue;
        const v = slimGrade(g);
        if (JSON.stringify(v) === JSON.stringify(grades[k])) continue;
        grades[k] = v; touched = true;
      }
      if (touched) { const out = { ...d, grades }; have.set(d.slip.id, out); await store.put(out); changed++; }
    }
    return changed;
  }

  // every leg of a live record not final yet, in the grader's request shape
  function pendingLegs(handle) {
    const have = slips.get(handle);
    if (!have) return [];
    // newest first: a slip logged before its games is read before they start
    const docs = [...have.values()].filter(d => d.status === 'live').sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const grades = Object.assign({}, ...docs.map(d => d.grades));
    return S.gradeRequest(docs.map(gradeSlip), undefined, grades);
  }

  const get = h => records.get(h) || null;
  const slipsOf = h => [...(slips.get(h)?.values() || [])].filter(d => d.status === 'live');
  const liveHandles = () => [...records.values()].filter(r => r.status === 'live').map(r => r.handle);
  const stats = () => ({ live: liveHandles().length, unpublished: [...records.values()].filter(r => r.status !== 'live').length,
    slips: [...slips.values()].reduce((a, m) => a + [...m.values()].filter(d => d.status === 'live').length, 0) });
  return { init, publish, addSlips, unpublish, applyGrades, pendingLegs, get, slipsOf, liveHandles, stats, owns: (h, t) => owns(records.get(h), t) };
}
const publicMeta = r => ({ handle: r.handle, status: r.status, createdAt: r.createdAt, publishedAt: r.publishedAt, unpublishedAt: r.unpublishedAt || null, restarts: (r.restarts || []).length });

// the slip as the graders see it: the bet time is the one the bettor gave when
// it is not after the slip reached us (a later one is taken as the arrival)
function gradeSlip(d) {
  const s = d.slip, got = Date.parse(d.receivedAt);
  const claimed = Date.parse(s.placedAt || '');
  const placedAt = Number.isFinite(claimed) && claimed <= got ? s.placedAt : d.receivedAt;
  return { id: s.id, app: s.app, flex: s.flex, legs: s.legs, placedAt, source: s.source, ...(s.format ? { format: s.format } : {}), ...(s.timed != null ? { timed: s.timed } : {}) };
}

// ── the record ──
// on time: every leg's game known and starting after the slip reached us
function timingOf(d, grades) {
  const sl = gradeSlip(d);
  const got = Date.parse(d.receivedAt);
  let first = null, unknown = 0;
  for (const l of sl.legs) {
    const st = Date.parse(grades[S.legKey(sl, l)]?.matched?.start || '');
    if (!Number.isFinite(st)) { unknown++; continue; }
    if (first == null || st < first) first = st;
  }
  if (first != null && first <= got) return { timing: 'late', firstStart: new Date(first).toISOString() };
  if (unknown) return { timing: 'checking', firstStart: first == null ? null : new Date(first).toISOString() };
  return { timing: 'on time', firstStart: new Date(first).toISOString() };
}

// a leg against Pinnacle's own close at its own line, read in the hour before the start
const pinLeg = g => !!g && g.raw?.source === 'pinnacle' && g.raw.exact && g.raw.ok !== false && g.raw.ev != null && g.raw.fair != null && (g.status === 'locked' || g.status === 'graded');
const done = g => !!g && (g.outcome === 'win' || g.outcome === 'loss');

function meanT(xs) {
  const n = xs.length;
  if (!n) return { mean: null, t: null };
  const m = xs.reduce((a, x) => a + x, 0) / n;
  if (n < 2) return { mean: m, t: null };
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  return { mean: m, t: v > 0 ? m / Math.sqrt(v / n) : null };
}

// one group of on-time legs (unique) and slips → its numbers and label
function groupStats(legs, slipViews) {
  const pin = legs.filter(x => pinLeg(x.g));
  const clv = meanT(pin.map(x => x.g.raw.ev));
  const graded = legs.filter(x => done(x.g));
  const pinGraded = pin.filter(x => done(x.g));
  // results against what Pinnacle's close expected for the same legs
  const exp = pinGraded.reduce((a, x) => a + x.g.raw.fair, 0), vr = pinGraded.reduce((a, x) => a + x.g.raw.fair * (1 - x.g.raw.fair), 0);
  const pinWins = pinGraded.filter(x => x.g.outcome === 'win').length;
  const shortZ = vr > 0 ? (pinWins - exp) / Math.sqrt(vr) : null;
  // the hit rate against each leg's own break-even
  const be = graded.filter(x => x.be > 0);
  const beSum = be.reduce((a, x) => a + x.be, 0), beVar = be.reduce((a, x) => a + x.be * (1 - x.be), 0), beWins = be.filter(x => x.g.outcome === 'win').length;
  // slips settled from the legs, 1 unit each at the app's table
  const settled = slipViews.filter(v => ['win', 'loss', 'paid', 'push', 'void'].includes(v.result) && v.multiple != null);
  const rets = settled.map(v => v.multiple - 1);
  const u = meanT(rets);
  const won = slipViews.filter(v => v.result === 'win' || (v.result === 'paid' && v.multiple > 1)).length;
  const lost = slipViews.filter(v => v.result === 'loss' || (v.result === 'paid' && v.multiple < 1)).length;
  const push = slipViews.filter(v => v.result === 'push' || v.result === 'void' || (v.result === 'paid' && v.multiple === 1)).length;
  const t = {
    legs: legs.length, pinN: pin.length, target: BAR, clv: r2(clv.mean), clvT: r2(clv.t), beat: pin.length ? r4(pin.filter(x => x.g.raw.ev > 0).length / pin.length) : null,
    graded: graded.length, hits: graded.filter(x => x.g.outcome === 'win').length, hitRate: graded.length ? r4(graded.filter(x => x.g.outcome === 'win').length / graded.length) : null,
    be: be.length ? r4(beSum / be.length) : null, beZ: beVar > 0 ? r2((beWins - beSum) / Math.sqrt(beVar)) : null,
    pinGraded: pinGraded.length, pinWins, pinExpWins: r2(exp), shortZ: r2(shortZ),
    slips: slipViews.length, open: slipViews.filter(v => v.result === 'open' || !v.result).length, won, lost, push, record: `${won}-${lost}${push ? `-${push}` : ''}`,
    settled: settled.length, units: settled.length ? r2(rets.reduce((a, x) => a + x, 0)) : null, unitsT: r2(u.t), noTable: slipViews.filter(v => v.result !== 'open' && v.multiple == null).length,
  };
  return { ...t, ...labelOf(t) };
}

// the RESULTS rule on one app's legs
function labelOf(t) {
  if (!t.pinN) return { label: 'not graded yet', why: 'No leg logged before its start has Pinnacle\'s close at its own line yet.' };
  if (t.pinN < BAR) return { label: t.clv > 0 ? 'building' : 'too early', why: `${t.pinN} of ${BAR} legs graded against Pinnacle's close.` };
  if (t.clv < 0) return { label: 'losing to the close', why: `Legs average ${t.clv}% against Pinnacle's close.` };
  if (!(t.clvT >= CLV_T)) return { label: 'building', why: `The CLV t is ${t.clvT ?? '—'}, under ${CLV_T}.` };
  if (t.shortZ != null && t.shortZ < -SHORT_SD) return { label: 'building', why: `Results are running ${Math.abs(t.shortZ)} sd under what Pinnacle's close expected.` };
  return { label: 'proven', why: null };
}

// tables: the apps' live payout tables (Pick6's as last read)
function recordView(meta, docs, { tables = null, now = Date.now(), page = 1, perPage = 100 } = {}) {
  const grades = Object.assign({}, ...docs.map(d => d.grades || {}));
  const rows = docs.map(d => {
    const sl = gradeSlip(d);
    const tm = timingOf(d, grades);
    // the result from the legs alone: no mark, no tracker's profit, no payout typed
    const v = S.slipView({ ...sl, stake: null, payout: null, mult: null, result: null }, grades, tables);
    return { d, sl, v, ...tm };
  }).sort((a, b) => Date.parse(b.d.receivedAt) - Date.parse(a.d.receivedAt) || String(b.sl.id).localeCompare(String(a.sl.id)));
  const onTime = rows.filter(r => r.timing === 'on time');
  // each leg once, with the break-even of the first slip it was on
  const legsOf = list => {
    const seen = new Map();
    for (const r of list) for (const l of r.v.legs) { const k = S.legKey(r.sl, l); if (!seen.has(k)) seen.set(k, { app: r.sl.app, g: l.g, be: r.v.be }); }
    return [...seen.values()];
  };
  const allLegs = legsOf(onTime);
  const apps = [...new Set(onTime.map(r => r.sl.app))].map(app => ({ app, appName: S.appLabel(app),
    ...groupStats(allLegs.filter(x => x.app === app), onTime.filter(r => r.sl.app === app).map(r => r.v)) }))
    .map(a => ({ ...a, profitShown: a.label === 'proven' && a.units > 0 && a.unitsT >= CLV_T }))
    .sort((a, b) => b.pinN - a.pinN || b.legs - a.legs);
  const pooled = groupStats(allLegs, onTime.map(r => r.v));
  const late = rows.filter(r => r.timing === 'late');
  const lateStats = groupStats(legsOf(late), late.map(r => r.v));
  const n = rows.length, pages = Math.max(1, Math.ceil(n / perPage)), p = Math.min(Math.max(1, page | 0), pages);
  return {
    at: new Date(now).toISOString(), handle: meta.handle, status: meta.status, createdAt: meta.createdAt, publishedAt: meta.publishedAt, restarts: (meta.restarts || []).map(x => ({ ...x })),
    rule: { graded: BAR, clvT: CLV_T, shortfallSd: SHORT_SD, close: 'Pinnacle\'s no-vig close at the leg\'s own line',
      text: `An app is marked proven only with ${BAR} legs logged before their start and graded against Pinnacle's own close at the leg's line, a CLV t of ${CLV_T} or more, and results not running ${SHORT_SD} sd under what that close expected. Never pooled across apps. Units count 1 unit a slip at the app's standard table and are called a profit only on a proven app whose units also clear chance (t of ${CLV_T}).` },
    disclosure: 'Imported or typed in by the bettor, not placed through Line Reaper. Line Reaper does not take bets and does not check who is behind a handle. A slip counts only when it reached us before its first game started; we can\'t see bets that were never logged here.',
    counts: { slips: n, onTime: onTime.length, late: late.length, checking: rows.filter(r => r.timing === 'checking').length },
    apps, proven: apps.filter(a => a.label === 'proven').map(a => a.appName),
    pooled: { ...pooled, label: 'pooled, never proven', why: 'Every app together. A record is judged one app at a time.', profitShown: false },
    late: { slips: late.length, legs: lateStats.legs, graded: lateStats.graded, hits: lateStats.hits, hitRate: lateStats.hitRate, record: lateStats.record, note: 'Logged after the first game started (an imported history, or a slip typed in late). Graded from the box scores and shown, never counted in the record.' },
    page: p, pages, perPage,
    slips: rows.slice((p - 1) * perPage, p * perPage).map(slipOut),
  };
}

function slipOut(r) {
  const { d, sl, v } = r;
  return {
    id: sl.id, app: sl.app, appName: S.appLabel(sl.app), legsN: sl.legs.length, flex: !!sl.flex, receivedAt: d.receivedAt, placedAtClaimed: d.slip.placedAt || null,
    source: d.slip.source, timing: r.timing, firstStart: r.firstStart, counted: r.timing === 'on time',
    result: v.result || 'open', multiple: v.multiple ?? null, units: v.multiple != null && v.result && v.result !== 'open' ? r2(v.multiple - 1) : null, be: v.be ?? null,
    legs: v.legs.map(l => {
      const g = l.g;
      return { player: l.player, market: l.market, side: l.side, line: l.line, sport: g?.matched?.sport || l.sport || null,
        game: g?.matched?.matchTitle || null, start: g?.matched?.start || null,
        status: g ? g.status : 'checking', reason: g?.reason || null,
        pinFair: pinLeg(g) ? g.raw.fair : null, pinClv: pinLeg(g) ? g.raw.ev : null,
        pinNote: g?.raw?.source === 'pinnacle' && !pinLeg(g) ? (g.raw.ok === false ? 'Pinnacle read over an hour early' : !g.raw.exact ? `Pinnacle only at ${g.raw.line}` : null) : g?.raw?.source === 'kalshi' ? 'Kalshi only, no Pinnacle close' : null,
        outcome: g?.outcome || (g?.status === 'void' ? 'void' : null), stat: g?.result ?? null, gradedBy: g?.gradeSource || null };
    }),
  };
}

// ── downloads ──
const CSV_COLS = ['slip_id', 'received_at_utc', 'placed_at_given', 'app', 'legs', 'timing', 'counted', 'slip_result', 'slip_units', 'leg', 'sport', 'player', 'market', 'side', 'line', 'game', 'start_utc',
  'pinnacle_close_fair', 'clv_vs_pinnacle_pct', 'leg_result', 'stat', 'graded_by'];
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function csv(view) {
  const out = [CSV_COLS.join(',')];
  for (const s of view.slips) s.legs.forEach((l, i) => out.push([s.id, s.receivedAt, s.placedAtClaimed, s.appName, s.legsN, s.timing, s.counted ? 'yes' : 'no', s.result, s.units, i + 1, l.sport, l.player, l.market, l.side, l.line, l.game, l.start,
    l.pinFair, l.pinClv, l.outcome, l.stat, l.gradedBy].map(cell).join(',')));
  return out.join('\n') + '\n';
}

// ── the page ──
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (x, d = 1) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Number(x).toFixed(d)}%`);
const share = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const utc = t => { const ms = Date.parse(t || ''); return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—'; };
const unitsText = (u, shown) => (u == null ? '—' : `${u > 0 ? '+' : ''}${u.toFixed(2)}u${shown ? '' : '*'}`);
const TAG = { proven: 'pv', 'losing to the close': 'neg', building: 'bd' };

const PAGE_CSS = `
.stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin:0 0 18px; }
.stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px 12px; min-width:0; }
.stat b { display:block; font:700 20px var(--mono); color:var(--text); overflow-wrap:anywhere; }
.stat span { font:600 10px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.stat small { display:block; color:var(--muted); font:500 11px var(--mono); }
.tag { display:inline-block; font:600 10px var(--mono); letter-spacing:.08em; text-transform:uppercase; border:1px solid var(--border2); color:var(--text2); border-radius:4px; padding:1px 6px; white-space:nowrap; }
.tag.pv { color:var(--green2); border-color:rgba(52,211,153,.5); }
.tag.neg, .neg { color:#f87171; } .tag.neg { border-color:rgba(248,113,113,.5); }
.tag.bd { color:#f59e0b; border-color:rgba(245,158,11,.5); }
.tag.late { color:#f87171; border-color:rgba(248,113,113,.5); }
.pos { color:var(--green2); }
.sub { display:block; color:var(--muted); font:500 11px var(--mono); white-space:normal; min-width:120px; }
.disc { background:var(--card); border:1px solid var(--border2); border-left:3px solid #f59e0b; border-radius:8px; padding:10px 12px; color:var(--text2); font-size:14px; margin:0 0 18px; }
.links { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 20px; }
.links .go { margin:0; }
.slip { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:0 0 10px; min-width:0; }
.slip.late { opacity:.75; }
.slip-h { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; font-size:14px; }
.slip-h b { font-family:var(--mono); }
.slip .meta { font:500 11px var(--mono); color:var(--muted); margin:2px 0 6px; overflow-wrap:anywhere; }
.leg { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:2px 12px; border-top:1px solid var(--border); padding:6px 0; font-size:13px; }
.leg .who { overflow-wrap:anywhere; }
.leg .num { font-family:var(--mono); text-align:right; white-space:nowrap; }
.leg small { display:block; color:var(--muted); font:500 11px var(--mono); overflow-wrap:anywhere; white-space:normal; }
nav.pg { display:flex; justify-content:space-between; gap:12px; margin:12px 0 0; font:600 12px var(--mono); }
@media (max-width:600px) { .stats { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
`;

function pageHtml(view, { origin = '', image = null, url = null } = {}) {
  const v = view;
  const title = `@${v.handle}: verified pick'em record`;
  const p = v.pooled;
  const description = v.status !== 'live' ? `@${v.handle} unpublished this record.`
    : v.proven.length ? `${v.proven.join(', ')} marked proven on the strict rule: legs logged before the start, graded against Pinnacle's close.`
    : `${p.pinN} of ${BAR} legs graded against Pinnacle's close${p.clv != null ? `, CLV ${pc(p.clv)}` : ''}. Nothing proven yet on the strict rule. Logged before the start, settled from box scores.`;
  const tags = [
    `<meta property="og:type" content="profile">`, `<meta property="og:site_name" content="Line Reaper">`,
    `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(description)}">`,
    url ? `<meta property="og:url" content="${esc(url)}">` : '', image ? `<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="${esc(description)}">`,
  ].filter(Boolean).join('\n');
  const { CSS, LOGO, FAVICON } = require('./learn');
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Line Reaper</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#080b10">
${tags}
<link rel="icon" href="${FAVICON}">
<style>${CSS}${PAGE_CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app?start=myslips">OPEN THE APP</a></div></header>
<main>`;
  const foot = `</main>
<footer><div class="in"><nav><a href="/">Line Reaper</a><a href="/results">Our own record</a><a href="/learn">Learn</a><a href="/terms">Terms</a><a href="/responsible-gambling">Responsible gambling</a></nav>
<div>Line Reaper is an information service, not a sportsbook or a picks seller. It does not take bets. A bettor's record is their own; past results do not predict future ones. 21+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>
</body>
</html>`;
  if (v.status !== 'live') {
    return `${head}<p class="kicker">Bettor record</p><h1>@${esc(v.handle)}</h1><p class="lead">This record was unpublished on ${esc(utc(v.unpublishedAt || v.at))}. Its slips were removed.</p>${foot}`;
  }
  const stat = (k, val, sub, cls = '') => `<div class="stat"><span>${esc(k)}</span><b class="${cls}">${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const cls = x => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
  const label = l => `<span class="tag ${TAG[l] || ''}">${esc(l)}</span>`;
  const restarted = v.restarts.length ? ` Restarted ${v.restarts.length} time${v.restarts.length === 1 ? '' : 's'}: the earlier record was unpublished and its slips removed (last restart ${esc(utc(v.restarts[v.restarts.length - 1].republishedAt))}).` : '';
  const headline = v.proven.length ? `<span class="tag pv">proven at ${esc(v.proven.join(', '))}</span>` : '<span class="tag">nothing proven yet</span>';
  let body = `<p class="kicker">Bettor record · imported, not placed through us</p>
<h1>@${esc(v.handle)}</h1>
<p class="lead">Pick'em slips this bettor logged on Line Reaper, each leg graded against Pinnacle's close at its own line and settled from the box scores. Published ${esc(utc(v.publishedAt))}.${restarted}</p>
<div class="disc">${esc(v.disclosure)}</div>
<p>${headline}</p>
<div class="stats">
${stat('Legs vs Pinnacle', `${p.pinN} / ${BAR}`, 'logged before the start')}
${stat('CLV vs Pinnacle', pc(p.clv), p.clvT != null ? `t ${p.clvT} · beat ${share(p.beat)}` : 'no closes yet', cls(p.clv))}
${stat('Legs hit', share(p.hitRate), p.be != null ? `vs ${(p.be * 100).toFixed(1)}% break-even, ${p.graded} graded` : `${p.graded} graded`)}
${stat('Slips', p.record, `${unitsText(p.units, false)} at 1u a slip · ${p.open} open`, cls(p.units))}
</div>`;
  if (!v.counts.slips) {
    body += `<div class="ex"><div class="ex-h">No slips yet</div><p>Nothing logged yet. Slips appear here the moment the bettor adds them in MY SLIPS, stamped with the time they reached us.</p></div>`;
  }
  // by app: each app judged on its own
  body += `<h2>By app</h2>
<div class="scroll"><table><thead><tr><th>App</th><th>Label</th><th>Legs vs Pinnacle</th><th>CLV</th><th>Legs hit</th><th>Slips</th><th>Units</th></tr></thead><tbody>
${v.apps.map(a => `<tr><td>${esc(a.appName)}</td><td>${label(a.label)}${a.why ? `<span class="sub">${esc(a.why)}</span>` : ''}</td><td>${a.pinN} / ${BAR}</td><td class="${cls(a.clv)}">${pc(a.clv)}${a.clvT != null ? `<span class="sub">t ${a.clvT}</span>` : ''}</td><td>${share(a.hitRate)}<span class="sub">${a.graded} graded${a.be != null ? `, needs ${(a.be * 100).toFixed(1)}%` : ''}</span></td><td>${a.record}${a.open ? `<span class="sub">${a.open} open</span>` : ''}</td><td class="${cls(a.units)}">${unitsText(a.units, a.profitShown)}</td></tr>`).join('')}
<tr><td>All apps</td><td>${label(p.label)}<span class="sub">${esc(p.why)}</span></td><td>${p.pinN}</td><td class="${cls(p.clv)}">${pc(p.clv)}</td><td>${share(p.hitRate)}</td><td>${p.record}</td><td class="${cls(p.units)}">${unitsText(p.units, false)}</td></tr>
</tbody></table></div>
<p class="note">* Units are 1 unit a slip settled from the box scores at the app's standard payout table${p.noTable ? ` (${p.noTable} slip${p.noTable === 1 ? '' : 's'} at an app with no fixed table count in the record, not the units)` : ''}. ${esc(v.rule.text)}</p>`;
  body += `<h2>Late slips</h2><p class="note">${v.late.slips ? `${v.late.slips} slip${v.late.slips === 1 ? '' : 's'} (${v.late.legs} legs, ${v.late.graded} graded, ${share(v.late.hitRate)} hit). ` : 'None. '}${esc(v.late.note)}</p>`;
  const base = `/r/${encodeURIComponent(v.handle)}`;
  body += `<div class="links"><a class="go" href="/api/records/${encodeURIComponent(v.handle)}/slips.csv">DOWNLOAD CSV</a><a class="go" href="/api/records/${encodeURIComponent(v.handle)}/slips.json">DOWNLOAD JSON</a><a class="go" href="/card/record-${encodeURIComponent(v.handle)}.png">SHARE CARD</a></div>`;
  body += `<h2>Slip by slip</h2><p class="note">Newest first. Times are when each slip reached Line Reaper. ${v.counts.onTime} on time, ${v.counts.late} late, ${v.counts.checking} still matching to a game.</p>`;
  body += v.slips.map(s => {
    const res = s.result === 'open' ? 'open' : s.result === 'paid' ? `paid ${s.multiple}x` : s.result;
    const tcls = s.result === 'win' || (s.result === 'paid' && s.multiple > 1) ? 'pos' : s.result === 'loss' ? 'neg' : '';
    return `<div class="slip${s.timing === 'late' ? ' late' : ''}"><div class="slip-h"><b>${esc(s.appName)}</b><span>${s.legsN}-pick${s.flex ? ' flex' : ''}</span><span class="${tcls}">${esc(res.toUpperCase())}${s.units != null ? ` ${s.units > 0 ? '+' : ''}${s.units.toFixed(2)}u` : ''}</span>${s.timing === 'late' ? '<span class="tag late">LATE · not counted</span>' : s.timing === 'checking' ? '<span class="tag">matching</span>' : ''}</div>
<div class="meta">logged ${esc(utc(s.receivedAt))}${s.firstStart ? ` · first game ${esc(utc(s.firstStart))}` : ''}${s.placedAtClaimed && s.source !== 'paste' ? ` · bettor's time ${esc(utc(s.placedAtClaimed))}` : ''}</div>
${s.legs.map(l => `<div class="leg"><div class="who"><b>${esc(l.player)}</b> ${esc(l.side)} ${esc(l.line)} ${esc(l.market)}<small>${esc([l.sport, l.game, l.start ? utc(l.start) : null].filter(Boolean).join(' · ') || (l.status === 'nohistory' ? 'no game found for this leg' : 'matching to a game'))}</small></div><div class="num"><span class="${l.outcome === 'win' ? 'pos' : l.outcome === 'loss' ? 'neg' : ''}">${esc(l.outcome ? l.outcome.toUpperCase() : l.status === 'open' ? 'before start' : '—')}${l.stat != null ? ` ${esc(l.stat)}` : ''}</span><small>${l.pinClv != null ? `PIN ${pc(l.pinClv)}` : esc(l.pinNote || 'no Pinnacle close')}</small></div></div>`).join('')}
</div>`;
  }).join('');
  if (v.pages > 1) body += `<nav class="pg"><span>${v.page > 1 ? `<a href="${base}?page=${v.page - 1}">← Newer</a>` : ''}</span><span>page ${v.page} of ${v.pages}</span><span>${v.page < v.pages ? `<a href="${base}?page=${v.page + 1}">Older →</a>` : ''}</span></nav>`;
  body += `<p class="note" style="margin-top:18px">Read ${esc(utc(v.at))}. The same page for everyone: no follow, copy or alert buttons, and no stake sizes.${origin ? '' : ''}</p>`;
  return head + body + foot;
}

module.exports = { createRecordStore, cleanHandle, cleanSlip, slimGrade, gradeSlip, timingOf, labelOf, groupStats, recordView, csv, pageHtml, pinLeg, BAR, CLV_T, SHORT_SD, MAX_POST, HANDLE_RE };
