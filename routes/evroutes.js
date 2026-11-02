// +EV screener, my state and alert history endpoints
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// values set up further down server.js, or replaced on refresh, are read per request through ctx
const {
  EV_ALERT_MIN, LICENCE_NOTE, PAYWALL, TAIL_REGION, alertDelayMs, alertLog, alertLogLib, altTracker,
  app, createEvStoreFromEnv, delayed, describeSharp, esBookTracker,
  esStaleState, esStaleTracker, esportsEdgeTracker, evListeners,
  evRowOk, evTracker, exchangeState, exchanges, hasLive, hasPro, hiddenWallets,
  leadLagTracker, licenceOf, liveFor, liveListeners, mapUndersModelTracker, mentions,
  push, redactEv, requireLive, requirePro, resultsBackup, reverseLineMoves, runEvScreen,
  sharpListeners, sharpTracker, siteOrigin, splitsMap, sportTracker, staleTracker,
  venues, webhookLicence, xvalueTracker
} = ctx;

app.get('/api/ev', (req, res) => {
  const { rows: all, feeds, at } = runEvScreen();
  // ?state=TX: only venues a resident of that state can use (venues.js)
  const inState = venues.rowLegalIn(req.query.state);
  const rows = all.filter(evRowOk(licenceOf(req))).filter(inState);
  const pro = hasPro(req);
  // free users can't filter by anything a locked row hides (book, EV, market, side)
  const q = pro ? req.query : { sport: req.query.sport, props: req.query.props, dfs: req.query.dfs, limit: req.query.limit };
  const minEv = pro ? parseFloat(q.minEv) : 1;
  const books = q.book ? String(q.book).toLowerCase().split(',') : null;
  let out = rows.filter(r =>
    (!q.sport || r.sport === q.sport) &&
    (!Number.isFinite(minEv) || r.ev >= minEv) &&
    (!books || books.includes(r.book)) &&
    (!q.market || r.market === q.market) &&
    (q.props == null || (q.props === '1') === !!r.player) &&
    (q.dfs == null || (q.dfs === '1') === !!r.dfs) &&
    (!q.source || r.source === q.source) &&
    (q.agree !== '1' || r.agree));
  const total = out.length;
  // the bar: +2% with two sharp sources agreeing (sportsbook rows; the
  // pick'em legs have their own consensus on the PROPS board)
  const clear = rows.filter(r => !r.dfs && r.ev >= 2);
  const counts = { clear2: clear.length, agree2: clear.filter(r => r.agree).length,
    agree2Lines: clear.filter(r => r.agree && !r.player).length, agree2Props: clear.filter(r => r.agree && r.player).length };
  out = out.slice(0, Math.min(parseInt(q.limit) || 200, 1000));
  // ladders and alternate lines: their own list (clearing rungs first)
  const alt = (runEvScreen().alt || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.alt = alt.length; counts.altClear = alt.filter(r => r.clears).length;
  const altOut = alt.slice(0, 300);
  // BetRivers' esports lines: their own list too (esbooks.js)
  const es = (ctx.esBooksState.rows || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.esports = es.length; counts.esportsClear = es.filter(r => r.clears).length;
  const esOut = es.slice(0, 300);
  // books and apps still on the number Pinnacle just left (stalelines.js)
  const stale = (ctx.staleState.rows || []).filter(evRowOk(licenceOf(req))).filter(inState).filter(r => !q.sport || r.sport === q.sport);
  counts.stale = stale.length; counts.staleClear = stale.filter(r => r.clears).length;
  const staleOut = stale.slice(0, 300);
  // esports: one pick'em app moved a kill line, another hasn't (esstale.js)
  const esStale = (esStaleState.rows || []).filter(r => !q.sport || r.sport === q.sport).map(r => ({ ...r, es: true, book: r.app, marketLabel: r.market })).filter(inState);
  counts.esStale = esStale.length; counts.esStaleClear = esStale.filter(r => r.clears).length;
  const esStaleOut = esStale.slice(0, 200);
  res.json({ rows: pro ? out : redactEv(out), alt: pro ? altOut : redactEv(altOut).map(r => ({ ...r, alt: true })),
    esports: pro ? esOut : redactEv(esOut).map(r => ({ ...r, esports: true })), esportsAt: ctx.esBooksState.screenedAt,
    // free users see a lock per row the Pro view shows at its default floor (+1%)
    stale: pro ? staleOut : redactEv(staleOut.filter(r => r.ev >= 1)).map(r => ({ ...r, stale: true })), staleAt: ctx.staleState.screenedAt, staleLag: ctx.staleState.enabled ? ctx.staleState.engine.lagSummary() : null,
    esStale: pro ? esStaleOut : redactEv(esStaleOut.filter(r => r.ev >= 1)).map(r => ({ ...r, es: true, stale: true })), esStaleAt: esStaleState.screenedAt, esStaleLag: esStaleState.enabled ? esStaleState.engine.lagSummary() : null,
    count: total, counts, pro, live: hasLive(req), updated: new Date(at).toISOString(), feeds, state: venues.stateInfo(req.query.state) });
});
// New edges as they appear: event "ev" carries an array of rows.
// ?sport=nba&kind=steam,sharp_lead&limit=100. Open sharp leads (soft books
// still stale) are the actionable part, so they're Pro.
app.get('/api/sharp', (req, res) => {
  const kind = req.query.kind ? String(req.query.kind).split(',') : undefined;
  const pro = hasPro(req);
  const events = sharpTracker.events({ sport: req.query.sport, kind, limit: Math.min(parseInt(req.query.limit) || 100, 500) })
    .filter(e => pro || e.kind !== 'sharp_lead')
    .map(e => ({ ...e, text: describeSharp(e) }));
  const stale = pro ? sharpTracker.stale().filter(l => !req.query.sport || l.sport === req.query.sport).map(e => ({ ...e, text: describeSharp(e) })) : [];
  let rlm = [];
  try { rlm = reverseLineMoves(sharpTracker.events({ limit: 500 }), splitsMap()).map(e => ({ ...e, text: describeSharp(e) })); } catch { /* splits shape unknown */ }
  res.json({ events, stale, rlm, pro, lockedLeads: pro ? 0 : sharpTracker.stale().length, state: sharpTracker.state() });
});
// Kalshi and Polymarket prices: each only with its data licence, and
// Polymarket's never in US mode (a US person can't trade there)
app.get('/api/exchanges', (req, res) => {
  const lic = licenceOf(req);
  const ok = r => (r.exchange === 'kalshi' ? lic.kalshi : r.exchange === 'polymarket' ? lic.polymarket && TAIL_REGION !== 'us' : true);
  const withheld = ['kalshi', 'polymarket'].filter(x => !lic[x]);
  res.json({ markets: exchanges.toMarketsList(exchangeState.rows.filter(ok)), updated: exchangeState.updated, errors: exchangeState.errors,
    region: TAIL_REGION, ...(withheld.length ? { withheld, note: LICENCE_NOTE } : {}) });
});
// The screener's own record: free to see, since it's the sales pitch.
app.get('/api/ev/record', async (req, res) => {
  const q = req.query;
  const out = await evTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // an exchange's own line in the by-book table needs its licence
  const ok = evRowOk(licenceOf(req));
  const inState = venues.legalIn(q.state);
  if (out?.byBook) out.byBook = Object.fromEntries(Object.entries(out.byBook).filter(([book]) => ok({ book }) && inState(book)));
  out.state = venues.stateInfo(q.state);
  // the ladders' and alternate lines' record, apart from the main lines'
  out.alt = await altTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  out.esports = await esBookTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // stale lines: the books' rows here, the apps' legs from the props record
  out.stale = await staleTracker.summary({ sport: q.sport, book: q.book, source: q.source, sinceDays: parseFloat(q.days) || undefined });
  // Kalshi moved first, Polymarket US still at the old price: a lead, judged at 50 graded
  out.leadLag = await leadLagTracker.summary({ sport: q.sport, book: q.book, sinceDays: parseFloat(q.days) || undefined });
  // the props record has no sport cut: with one asked for, the apps' lines stay off
  const kinds = q.sport ? {} : (await sportTracker.summary({ sinceDays: parseFloat(q.days) || undefined })).byKind || {};
  out.staleApps = q.sport ? null : { stale: kinds.stale || null, single: kinds['stale-single'] || null };
  // esports: legs at an app another app had just moved away from, graded on the result
  try { const es = await esStaleTracker.summary(); out.esStale = { overall: es.overall, byBook: es.byBook, open: es.counts.open + es.counts.locked, mkt: es.overall }; }
  catch { out.esStale = null; }
  res.json(out);
});
// Every book and every kind against the close (closeboard.js): graded toward
// 50, beat-the-close rate, CLV and the tracker's own mark. Free: it's the
// record. A Kalshi or Polymarket row needs its licence, as on /api/ev/record.
const closeBoard = require('../closeboard');
const closeBoardCache = new Map();   // key → { at, body }
// the scoreboard for a viewer's licences (the webhook's when none), cached a minute
// state (venues.js): only the venues a resident there can use, every total
// re-pooled from those; none for the alert gate, which is the same for everyone
// every record the scoreboard reads, cut to a viewer's licences and state
async function closeBoardLists(lic = webhookLicence(), state = null) {
  const inState = venues.rowLegalIn(state);
  const ok = r => evRowOk(lic)(r) && inState(r);
  const all = { status: undefined, limit: 1e9 };
  const [ev, alt, stale, esports, props, bigMoney, esMapUnders] = await Promise.all([evTracker.list(all), altTracker.list(all), staleTracker.list(all),
    esBookTracker.list(all), sportTracker.list({ limit: 1e9 }), ctx.bigTracker.list(), mapUndersModelTracker.list({ limit: 1e9 })]);
  return { ev: ev.filter(ok), alt: alt.filter(ok), stale: stale.filter(ok), esports: esports.filter(ok),
    props: props.filter(r => venues.legalIn(state)(closeBoard.propsVenue(r))), bigMoney: bigMoney.filter(inState),
    esMapUnders: esMapUnders.filter(r => venues.legalIn(state)(closeBoard.propsVenue(r))) };
}
async function closeBoardFor(lic = webhookLicence(), days = 0, state = null) {
  const key = `${JSON.stringify(lic)}|${days}|${venues.stateOf(state) || ''}`;
  const hit = closeBoardCache.get(key);
  if (!hit || Date.now() - hit.at > 60e3) {
    const body = closeBoard.scoreboard(await closeBoardLists(lic, state), { since: days > 0 ? Date.now() - days * 86400e3 : 0 });
    closeBoardCache.set(key, { at: Date.now(), body: { ...body, state: venues.stateInfo(state), at: new Date().toISOString() } });
  }
  return closeBoardCache.get(key).body;
}
app.get('/api/ev/scoreboard', async (req, res) => {
  try {
    res.json(await closeBoardFor(licenceOf(req), parseFloat(req.query.days) || 0, req.query.state));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// What a public page may claim (claims.js): the scoreboard's proven rows of
// the kinds that close on Pinnacle's own price, the Texas cut, and the labels
// every other tool wears. The sales page, /learn and the welcome screen read it.
const claims = require('../claims');
// ── MY STATE (venuestates.js via venues.js) ──
// Which venues a resident of each state can use, with a source and a date per
// entry. A view filter only: prices, alerts and the record are the same for
// everyone (CFTC 4.14(a)(9)); unknown is never shown as available.
app.get('/api/states', (req, res) => res.set('Cache-Control', 'public, max-age=300').json({ asOf: venues.table().asOf, check: venues.CHECK, states: venues.statesList() }));
app.get('/api/states/table', (req, res) => res.set('Cache-Control', 'public, max-age=300').json(venues.table()));
app.get('/api/states/:state', (req, res) => {
  const info = venues.stateInfo(req.params.state);
  if (!info) return res.status(404).json({ error: 'A state is its two-letter code, like TX. /api/states lists them.' });
  res.set('Cache-Control', 'public, max-age=300').json(info);
});
app.get('/api/claims', async (req, res) => {
  try {
    const lic = webhookLicence();
    const [board, txBoard] = await Promise.all([closeBoardFor(lic, 0, null), closeBoardFor(lic, 0, 'TX')]);
    res.set('Cache-Control', 'public, max-age=60').json(claims.publicClaims({ board, txBoard, alertBooks: ctx.evBookProven }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The public record (RESULTS): every kind and venue on the scoreboard with
// the label the sales page would give it (claims.publicRecord, the same test as
// /api/claims), and every closed flag behind it as CSV or JSON. Public, the
// same for everyone (the webhook's licences), so anyone can check the numbers.
// Open flags are today's live edges and never in it.
app.get('/api/record', async (req, res) => {
  try {
    const days = parseFloat(req.query.days) || 0;
    const board = await closeBoardFor(webhookLicence(), days, null);
    res.set('Cache-Control', 'public, max-age=60').json({ ...claims.publicRecord({ board }), days: days > 0 ? days : null,
      columns: closeBoard.FLAG_COLUMNS, downloads: { csv: '/api/record/flags.csv', json: '/api/record/flags.json' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const recordFlagsMemo = require('../ops').createMemo({ ttlMs: 60e3 });
async function recordFlags(req) {
  const days = parseFloat(req.query.days) || 0;
  const q = k => (typeof req.query[k] === 'string' && /^[\w-]{1,40}$/.test(req.query[k]) ? req.query[k] : null);
  const kind = q('kind'), book = q('book');
  const rows = await recordFlagsMemo(`flags|${days > 0 ? days : 0}|${kind || ''}|${book || ''}`, async () =>
    closeBoard.flags(await closeBoardLists(webhookLicence(), null), { since: days > 0 ? Date.now() - days * 86400e3 : 0, kind, book }));
  const name = `line-reaper-record${kind ? `-${kind}` : ''}${book ? `-${book}` : ''}${days > 0 ? `-${days}d` : ''}-${new Date().toISOString().slice(0, 10)}`;
  return { rows, name, days, kind, book };
}
app.get('/api/record/flags.csv', async (req, res) => {
  try {
    const { rows, name } = await recordFlags(req);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'public, max-age=60' })
      .send(closeBoard.flagsCsv(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/record/flags.json', async (req, res) => {
  try {
    const { rows, name, days, kind, book } = await recordFlags(req);
    res.set({ 'Content-Disposition': `attachment; filename="${name}.json"`, 'Cache-Control': 'public, max-age=60' })
      .json({ at: new Date().toISOString(), days: days > 0 ? days : null, kind, book, columns: closeBoard.FLAG_COLUMNS, n: rows.length, flags: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The weekly record digest (digest.js): per kind and venue, what graded in the
// week, the move toward the 50 bar, CLV and record for the week and all time,
// and what became proven or started losing to the close. Read from the same
// public record as RESULTS and the sales page, the same for everyone. Published
// (frozen, and one push to every phone with alerts on) Monday 13:00 UTC; the
// week so far and older weeks are built from the record on request.
const digest = require('../digest');
const digestStore = resultsBackup.wrap('recordDigest', createEvStoreFromEnv(process.env, { table: 'record_digests', fileVar: 'DIGEST_FILE', file: 'record-digests.json' }), { appendOnly: false });
const digestReady = digestStore.init().catch(e => console.warn('Digest store:', e.message));
const digestMemo = require('../ops').createMemo({ ttlMs: 10 * 60e3 });
const digestOrigin = () => String(process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://line-reaper-backend-production.up.railway.app')).replace(/\/+$/, '');
async function frozenDigests() { await digestReady; return (await digestStore.all()).filter(d => d.status === 'frozen' && d.digest); }
// → { digest, frozen, sentAt } for a week id; null for a week in the future
async function digestFor(week) {
  const now = Date.now();
  if (digest.weekOf(week).from > now) return null;
  const f = (await frozenDigests()).find(d => d.week === week);
  if (f) return { digest: f.digest, frozen: true, sentAt: f.pushedAt || f.builtAt, pushed: f.pushSent ?? null };
  const d = await digestMemo(`digest|${week}`, async () => digest.build({ lists: await closeBoardLists(webhookLicence(), null), week, now }));
  return { digest: d, frozen: false, sentAt: null, pushed: null };
}
// The Monday send: freeze the week that just ended and push it once. Hourly
// from :00, so a deploy over 13:00 sends at the next hour; a week already
// frozen is never sent again, and a send more than 12 hours late is frozen
// without the push (a stale weekly buzz helps nobody).
const digestState = { lastRunAt: null, last: null, error: null };
async function publishDigest(now = Date.now()) {
  const week = digest.dueWeek(now);
  if (now < digest.sendAt(week)) return null;
  const bk = process.env.DATABASE_URL ? 'ready' : resultsBackup.status().state;
  if (bk !== 'ready' && bk !== 'off') { digestState.error = `results backup ${bk}: the record may be incomplete, waiting`; return null; }
  if ((await frozenDigests()).some(d => d.week === week)) return null;
  const d = digest.build({ lists: await closeBoardLists(webhookLicence(), null), week, now });
  const doc = { id: `week-${week}`, status: 'frozen', week, builtAt: d.builtAt, digest: d, pushedAt: null, pushSent: null };
  await digestStore.put(doc);
  let sent = null;
  if (now - digest.sendAt(week) < 12 * 3600e3) {
    sent = await push.send(digest.pushText(d, { origin: digestOrigin() }), 'Weekly record').catch(e => { digestState.error = `push: ${e.message}`; return 0; });
    await digestStore.put({ ...doc, pushedAt: new Date().toISOString(), pushSent: sent });
    // Discord and Telegram get the same week (outfeed.js); a failure there never stops the freeze
    await ctx.feedDigest(d).catch(e => { ctx.outFeedState.digest.error = e.message; console.warn('Feed digest:', e.message); });
  }
  digestState.lastRunAt = new Date().toISOString();
  digestState.last = { week, graded: d.summary.graded, pushSent: sent };
  digestState.error = null;
  return digestState.last;
}
// the weeks the digest covers (newest first, at most 13): /api/digest and /api/v1/digest
async function digestIndex(now = Date.now()) {
  const frozen = await frozenDigests();
  const lists = await closeBoardLists(webhookLicence(), null);
  const first = Math.min(...Object.values(lists).flat().map(digest.startOf).filter(t => t > 0), now);
  const cur = digest.weekOf(now);
  const weeks = [];
  for (let t = cur.from, i = 0; t >= digest.weekStart(first) && i < 13; t -= digest.WEEK, i++) {
    const id = digest.weekOf(t).id, f = frozen.find(d => d.week === id);
    weeks.push({ week: id, name: digest.weekName(id), partial: t === cur.from, frozen: !!f, sentAt: f ? f.pushedAt || f.builtAt : null,
      graded: f ? f.digest.summary.graded : null, share: `/digest/${id}` });
  }
  return { at: new Date(now).toISOString(), current: cur.id, sendsAt: 'Monday 13:00 UTC', nextSend: new Date(digest.sendAt(cur.id)).toISOString(), weeks };
}
app.get('/api/digest', async (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=60').json(await digestIndex()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/digest/:week', async (req, res) => {
  try {
    const week = String(req.params.week || '');
    if (!digest.validWeek(week)) return res.status(400).json({ error: 'A week is the date of its Monday, like 2026-10-19' });
    const out = await digestFor(week);
    if (!out) return res.status(404).json({ error: 'That week has not started' });
    res.set('Cache-Control', 'public, max-age=60').json({ ...out, share: `/digest/${week}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The share link: a read-only public page for one week, under the sales page's rule
app.get('/digest', (req, res) => res.redirect(302, `/digest/${digest.dueWeek(Date.now())}`));
app.get('/digest/:week', async (req, res) => {
  try {
    const week = String(req.params.week || '');
    const out = digest.validWeek(week) ? await digestFor(week) : null;
    if (!out) return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Line Reaper</title><body style="background:#080b10;color:#e2e8f0;font:16px system-ui;padding:24px">That week has no digest. <a style="color:#34d399" href="/digest">See the latest week</a>.</body>`);
    res.set('Cache-Control', 'public, max-age=300').type('html').send(digest.renderPage(out.digest, { origin: siteOrigin(req), frozen: out.frozen, sentAt: out.sentAt }));
  } catch (e) { res.status(500).type('text/plain').send(e.message); }
});
// ── ALERT HISTORY (alertlog.js) ──
// Every alert sent since the log began, each bet it named graded by its own
// tracker with RESULTS' code and label. The same for everyone; with the
// paywall on, a free viewer sees an alert's bets once their games start.
const alertViewMemo = require('../ops').createMemo({ ttlMs: 60e3, max: 40 });
async function alertHistory({ days = 0, kind = null, limit = 100, before = null, full = true, delayMs = null } = {}) {
  const docs = await alertLog.all();
  const want = { ev: new Set(), xvalue: new Set(), esports: new Set() };
  for (const d of docs) for (const it of d.items || []) if (want[it.tracker]) want[it.tracker].add(it.ref);
  const pick = (list, ids) => new Map(list.filter(b => ids.has(b.id)).map(b => [b.id, b]));
  const read = (t, k) => (want[k].size ? t.list({ limit: 1e9 }) : []);
  const [evRows, xvRows, esRows, board] = await Promise.all([read(evTracker, 'ev'), read(xvalueTracker, 'xvalue'), read(esportsEdgeTracker, 'esports'), closeBoardFor(webhookLicence(), 0, null)]);
  const rec = new Map(claims.publicRecord({ board }).rows.map(r => [`${r.kind}|${r.book}`, r]));
  const labelOf = (k, book) => { const r = rec.get(`${k}|${book}`); return r ? { label: r.label, why: r.why, profitShown: !!r.profitShown } : null; };
  const hidden = hiddenWallets();
  return alertLogLib.view(docs, { rows: { ev: pick(evRows, want.ev), xvalue: pick(xvRows, want.xvalue), esports: pick(esRows, want.esports) }, labelOf, startedAt: alertLog.startedAt(),
    full, delayMs, days, kind, limit, before, hide: d => hidden.length > 0 && mentions(d.lines, hidden) });
}
const alertQueryOf = (q = {}) => ({
  days: Math.max(0, parseFloat(q.days) || 0),
  kind: typeof q.kind === 'string' && require('../push').KIND_KEYS.includes(q.kind) ? q.kind : null,
  limit: Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100)),
  before: typeof q.before === 'string' && Number.isFinite(Date.parse(q.before)) ? new Date(Date.parse(q.before)).toISOString() : null,
});
// Pro sees open alerts live; Plus once the delay has passed; Free once the games start
const alertQuery = req => ({ ...alertQueryOf(req.query), full: hasLive(req), delayMs: hasPro(req) && !hasLive(req) ? alertDelayMs(req) : null });
const alertHistoryFor = q => alertViewMemo(JSON.stringify(q), () => alertHistory(q));
app.get('/api/alerts/history', async (req, res) => {
  try { res.set('Cache-Control', `${PAYWALL ? 'private' : 'public'}, max-age=60`).json(await alertHistoryFor(alertQuery(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/alerts', async (req, res) => {
  try { res.set('Cache-Control', `${PAYWALL ? 'private' : 'public'}, max-age=60`).type('html').send(alertLogLib.renderPage(await alertHistoryFor(alertQuery(req)), { origin: siteOrigin(req) })); }
  catch (e) { res.status(500).type('text/plain').send('The alert history could not be read just now. Try again in a minute.'); }
});
app.get('/api/ev/record/bets', async (req, res) => {
  // open bets are today's live edges, so only closed ones are free
  const status = hasPro(req) ? req.query.status : 'closed';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  // ?book=fanduel&source=alt&sport=nhl narrow the list; ?before=<flaggedAt> pages back
  const q = k => (typeof req.query[k] === 'string' && req.query[k]) || undefined;
  const bets = (await (req.query.alt === '1' ? altTracker : req.query.es === '1' ? esBookTracker : req.query.stale === '1' ? staleTracker : req.query.leadlag === '1' ? leadLagTracker : evTracker)
    .list({ status, limit: limit * 2, book: q('book'), source: q('source'), sport: q('sport'), before: q('before') })).filter(evRowOk(licenceOf(req))).slice(0, limit);
  res.json({ bets });
});
// one subject's line history on every source (stale lines), e.g. ?key=pin-123|spread
app.get('/api/stale/history', requirePro, (req, res) => {
  const h = ctx.staleState.engine.history(String(req.query.key || ''));
  if (!h) return res.json({ error: 'no such subject' });
  // Kalshi's prices need its licence, as on /api/ev
  if (!licenceOf(req).kalshi) delete h.sources.kalshi;
  res.json(h);
});
// Plus: the same list, each alert shown once ALERT_DELAY_MIN has passed
app.get('/api/ev/alerts', requirePro, (req, res) => res.json({ alerts: delayed(ctx.evRecent, req).filter(evRowOk(licenceOf(req))).slice(0, parseInt(req.query.limit) || 50), minEv: EV_ALERT_MIN,
  delayMinutes: alertDelayMs(req) / 60e3, live: hasLive(req) }));
app.get('/api/ev/stream', requireLive, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  // what this viewer may see (data licences), fixed for the connection
  const lic = licenceOf(req), evOk = evRowOk(lic);
  res.write(`event: hello\ndata: ${JSON.stringify({ at: ctx.evCache.at, rows: ctx.evCache.rows.length })}\n\n`);
  const send = rows => { const mine = rows.filter(evOk); if (mine.length) res.write(`event: ev\ndata: ${JSON.stringify(mine)}\n\n`); };
  const sendSharp = evs => res.write(`event: sharp\ndata: ${JSON.stringify(evs.map(e => ({ ...e, text: describeSharp(e) })))}\n\n`);
  sharpListeners.add(sendSharp);
  // sharp tail: `tail` (signals), `whale` (big prints) and `xarb` (new arbs),
  // each an array, cut to this viewer's licences (and no polymarket.com links in US mode)
  const sendLive = (type, data) => {
    const mine = liveFor(type, data, lic);
    if (mine.length) res.write(`event: ${type}\ndata: ${JSON.stringify(mine)}\n\n`);
  };
  liveListeners.add(sendLive);
  // a heartbeat with the board time lets the page refresh even when nothing new crossed the line
  const ping = setInterval(() => res.write(`event: tick\ndata: ${JSON.stringify({ at: ctx.evCache.at })}\n\n`), 25000);
  evListeners.add(send);
  req.on('close', () => { clearInterval(ping); evListeners.delete(send); sharpListeners.delete(sendSharp); liveListeners.delete(sendLive); });
});


return {
  closeBoard, closeBoardLists, closeBoardFor, claims, recordFlags, digest, digestStore, digestOrigin,
  digestFor, digestState, publishDigest, digestIndex, alertQueryOf, alertHistoryFor
};
};
