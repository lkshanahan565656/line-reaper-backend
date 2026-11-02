// Public bettor records and the Kalshi link (pubrecord.js, leaderboard.js, kalshilink.js)
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
const {
  V1Error, app, axios, bigGames, createEvStoreFromEnv, esBets, esBetsCtx,
  freeBooksState, gradeEsBets, gradeSlipLegs, leagueStates, lineBets, pick6, publicApi,
  resultsBackup, schedule, sendErr, shareImageUrl, shareImgMemo, siteOrigin, v1Auth, v1Route,
  v1State, v1Str, widgetGate
} = ctx;

const pubRecord = require('../pubrecord');
const leaderboard = require('../leaderboard');
const pubRecords = pubRecord.createRecordStore({ store: resultsBackup.wrap('pubRecords', createEvStoreFromEnv(process.env, { table: 'pub_records', fileVar: 'PUB_RECORDS_FILE', file: 'pub-records.json', user: true })),
  perHour: parseInt(process.env.PUB_RECORDS_PER_HOUR, 10) || undefined });
pubRecords.init().catch(e => console.warn('Public records: store failed to initialise:', e.message));
const pubRecordState = { lastRun: null, lastMs: null, legs: 0, changed: 0, error: null, running: false };
// every live record's legs not final yet, through the slip graders; one pass at a time
// each record gets up to 300 legs a pass (its newest first), records taken in
// turn from pass to pass so one big imported history can't starve the rest
let pubRecordTurn = 0;
// a record that sends slips while a pass runs is graded (and its feed read) right after it
const pubRecordAgain = new Set();
async function gradePubRecords({ only = null, maxLegs = 900 } = {}) {
  if (pubRecordState.running) { if (only) pubRecordAgain.add(only); return pubRecordState; }
  pubRecordState.running = true;
  const t0 = Date.now();
  let legsN = 0, changed = 0;
  try {
    await pubRecords.init();
    const all = only ? [only] : pubRecords.liveHandles();
    const start = all.length ? pubRecordTurn++ % all.length : 0;
    for (const h of [...all.slice(start), ...all.slice(0, start)]) {
      if (legsN >= maxLegs) break;
      // game-line bets: the odds screen's line-bet log (linebets.js), Pinnacle's close and the final
      const pb = pubRecords.pendingBets(h).slice(0, 200);
      const pbLine = pb.filter(b => b.track?.kind !== 'es'), pbEs = pb.filter(b => b.track?.kind === 'es');
      if (pbLine.length) changed += await pubRecords.applyBetGrades(h, await lineBets.settle(pbLine, { games: freeBooksState.games || {} }));
      if (pbEs.length) changed += await pubRecords.applyBetGrades(h, await esBets.settle(pbEs, esBetsCtx()));
      const chunk = pubRecords.pendingLegs(h).slice(0, Math.min(300, maxLegs - legsN));
      if (!chunk.length) continue;
      legsN += chunk.length;
      const out = await gradeSlipLegs(chunk);
      changed += await pubRecords.applyGrades(h, out.results);
    }
    Object.assign(pubRecordState, { lastRun: new Date().toISOString(), lastMs: Date.now() - t0, legs: legsN, changed, error: null });
  } catch (e) { pubRecordState.error = e.message; console.warn('Public records: grading:', e.message); }
  finally { pubRecordState.running = false; }
  // each record's own feed: new picks logged before the start, new results (outfeed.js)
  await ctx.feedBettors({ only }).catch(e => { ctx.bettorFeedState.error = e.message; console.warn('Record feed:', e.message); });
  const next = [...pubRecordAgain][0];
  if (next) { pubRecordAgain.delete(next); setImmediate(() => gradePubRecords({ only: next, maxLegs: 600 }).then(() => pubForget(next)).catch(() => {})); }
  return pubRecordState;
}
schedule('7,17,27,37,47,57 * * * *', () => gradePubRecords().catch(() => {}));
// MATCHUPS' esports series bets: closes and results every ten minutes (Pinnacle's reads also observe)
schedule('3,13,23,33,43,53 * * * *', () => gradeEsBets());
const recordKey = req => { const a = String(req.get('authorization') || ''); return /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '').trim() : String(req.body?.key || ''); };
const pubTables = () => ({ pick6: pick6.state.payouts || null });
// the view, memoised a minute per handle and page (a shared link is opened by every previewer at once)
const pubViewMemo = new Map();
async function pubView(handle, page = 1) {
  await pubRecords.init();
  const c = pubRecord.cleanHandle(handle);
  const meta = c.handle && pubRecords.get(c.handle);
  if (!meta) return null;
  const key = `${c.handle}|${page}`, hit = pubViewMemo.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const v = meta.status === 'live' ? pubRecord.recordView(meta, pubRecords.slipsOf(c.handle), { tables: pubTables(), page, bets: pubRecords.betsOf(c.handle) }) : { handle: meta.handle, status: meta.status, unpublishedAt: meta.unpublishedAt, at: new Date().toISOString() };
  if (pubViewMemo.size > 200) pubViewMemo.clear();
  pubViewMemo.set(key, { at: Date.now(), v });
  return v;
}
const pubForget = h => { for (const k of [...pubViewMemo.keys()]) if (k.startsWith(`${h}|`)) pubViewMemo.delete(k); shareImgMemo.clear(); pubIndexMemo = null; pubBoardMemo = null; };
app.post('/api/records', async (req, res) => {
  try {
    const out = await pubRecords.publish({ handle: req.body?.handle, token: recordKey(req) || null, who: publicApi.callerOf(req) });
    pubForget(out.handle);
    res.set('Cache-Control', 'no-store').status(out.already ? 200 : 201).json({ ...out, url: `${siteOrigin(req)}/r/${out.handle}`,
      note: out.token && !out.already ? 'Keep this key: it is the only way to add slips to or unpublish this record, and it is shown once.' : undefined });
  } catch (e) { if (e.retryAfter) res.set('Retry-After', String(e.retryAfter)); sendErr(res, e); }
});
app.post('/api/records/:handle/slips', async (req, res) => {
  try {
    const out = await pubRecords.addSlips(req.params.handle, recordKey(req), req.body?.slips);
    const h = pubRecord.cleanHandle(req.params.handle).handle;
    pubForget(h);
    // the new legs go to the graders now, so a pre-game leg is read before its start
    if (out.added) gradePubRecords({ only: h, maxLegs: 600 }).then(() => pubForget(h)).catch(() => {});
    res.set('Cache-Control', 'no-store').json(out);
  } catch (e) { sendErr(res, e); }
});
// MY BETS' game-line bets (a track { kind: 'line' }) to the same record
app.post('/api/records/:handle/bets', async (req, res) => {
  try {
    const out = await pubRecords.addBets(req.params.handle, recordKey(req), req.body?.bets);
    const h = pubRecord.cleanHandle(req.params.handle).handle;
    pubForget(h);
    if (out.added) gradePubRecords({ only: h, maxLegs: 600 }).then(() => pubForget(h)).catch(() => {});
    res.set('Cache-Control', 'no-store').json(out);
  } catch (e) { sendErr(res, e); }
});
// the owner takes the record off the public list at /r, or puts it back. body: { listed }
app.post('/api/records/:handle/listing', async (req, res) => {
  try {
    const out = await pubRecords.setListed(req.params.handle, recordKey(req), req.body?.listed !== false);
    pubIndexMemo = null; pubForget(out.handle);
    res.set('Cache-Control', 'no-store').json(out);
  } catch (e) { sendErr(res, e); }
});
// the public list of records: one row a listed record, from its own view, memoised two minutes
let pubIndexMemo = null;
async function pubIndex() {
  await pubRecords.init();
  if (pubIndexMemo && Date.now() - pubIndexMemo.at < 120e3) return pubIndexMemo.v;
  const rows = [];
  for (const h of pubRecords.listedHandles()) {
    const v = await pubView(h, 1);
    if (v && v.status === 'live') rows.push(pubRecord.indexRow(v));
  }
  const v = pubRecord.indexView(rows);
  pubIndexMemo = { at: Date.now(), v };
  return v;
}
// ── the leaderboard (leaderboard.js): listed records ranked by CLV against
// Pinnacle's close, ranked only at 50 graded. Each record's counted picks are
// read once every two minutes; a filter (league, window, state) is cheap on top.
let pubBoardMemo = null;
async function pubBoardRecords() {
  await pubRecords.init();
  if (pubBoardMemo && Date.now() - pubBoardMemo.at < 120e3) return pubBoardMemo.v;
  const v = pubRecords.listedHandles().map(h => pubRecord.boardEntries(pubRecords.get(h), pubRecords.slipsOf(h), pubRecords.betsOf(h), { tables: pubTables() }));
  pubBoardMemo = { at: Date.now(), v };
  return v;
}
const boardOpts = q => ({ league: q.league, window: q.window, state: q.state || 'TX', mine: q.venues === 'mine', bar: pubRecord.BAR, clvT: pubRecord.CLV_T });
async function pubBoard(q = {}) { return leaderboard.build(await pubBoardRecords(), boardOpts(q)); }
// a record's own place on the default board (listed records only)
async function pubPlace(handle) {
  const meta = pubRecords.get(handle);
  if (!meta || meta.status !== 'live') return null;
  if (meta.unlisted) return { handle, ranked: 0, rows: [], listed: false };
  return { ...leaderboard.placeOf(await pubBoard({}), handle), listed: true };
}
app.get('/api/leaderboard', widgetGate, async (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=60').json(leaderboard.publicBody(await pubBoard(req.query))); } catch (e) { sendErr(res, e); }
});
function v1BoardQuery(q) {
  const window = v1Str(q.window, /^[a-z0-9]{1,5}$/, 'window');
  if (window && !leaderboard.WINDOWS[window]) throw new V1Error(400, 'bad_parameter', `window is one of ${Object.keys(leaderboard.WINDOWS).join(', ')}.`);
  const venuesQ = v1Str(q.venues, /^[a-z]{1,8}$/, 'venues');
  if (venuesQ && venuesQ !== 'mine') throw new V1Error(400, 'bad_parameter', 'venues is mine (only apps and venues confirmed in the state), or left out.');
  v1Str(q.league, /^[a-z0-9_]{1,30}$/, 'league');
  return { ...q, window: window || undefined, venues: venuesQ || undefined, state: v1State(q.state) || undefined };
}
app.get('/api/v1/leaderboard', v1Auth, v1Route(async req => leaderboard.publicBody(await pubBoard(v1BoardQuery(req.query)))));
app.get('/api/records', widgetGate, async (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=60').json(await pubIndex()); } catch (e) { sendErr(res, e); }
});
app.get('/r', widgetGate, async (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=60').type('html').send(pubRecord.indexHtml(await pubIndex(), { origin: siteOrigin(req), board: await pubBoard(req.query), states: leagueStates() })); }
  catch (e) { res.status(500).set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><body style="background:#080b10;color:#e2e8f0;font:16px system-ui;padding:24px">The list of records could not be read just now. Try again in a minute.</body>'); console.warn('Records index:', e.message); }
});
app.delete('/api/records/:handle', async (req, res) => {
  try {
    const out = await pubRecords.unpublish(req.params.handle, recordKey(req));
    pubForget(out.handle);
    // an unpublished record stops reading its Kalshi account, and the key is dropped
    if (kalshiLinks) await kalshiLinks.disconnect(out.handle).catch(e => console.warn('Kalshi link: disconnect:', e.message));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (e) { sendErr(res, e); }
});
// whether a key manages a handle (the app checks its saved key on open)
app.post('/api/records/:handle/check', async (req, res) => {
  await pubRecords.init().catch(() => {});
  const h = pubRecord.cleanHandle(req.params.handle).handle;
  const r = h && pubRecords.get(h);
  res.set('Cache-Control', 'no-store').json({ handle: h || null, exists: !!r, status: r?.status || null, owner: !!(h && pubRecords.owns(h, recordKey(req))), slips: r ? pubRecords.slipsOf(h).length : 0, bets: r ? pubRecords.betsOf(h).length : 0, listed: r ? !r.unlisted : null });
});
// ─── KALSHI LINK (kalshilink.js) ─────────────────────────────────────────────
// A record's owner connects their Kalshi account with a READ-ONLY key; every
// five minutes each account's new fills on a game line we follow go to the
// record as "Kalshi (connected)" bets, graded like MY BETS (Pinnacle's close,
// the final). On only with AUTH_SECRET (the key is sealed with it) and, on
// Railway, DATABASE_URL (a file there is lost at every deploy). KALSHI_LINK=off
// turns it off. The keys are never in the results backup.
const kalshiLinkMod = require('../kalshilink');
const KALSHI_LINK_ON = !!process.env.AUTH_SECRET && !/^(off|0|false|no)$/i.test(String(process.env.KALSHI_LINK || '').trim())
  && (!!process.env.DATABASE_URL || !(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID));
const kalshiLinkWhyOff = () => (KALSHI_LINK_ON ? null : !process.env.AUTH_SECRET ? 'AUTH_SECRET is not set on this server.'
  : /^(off|0|false|no)$/i.test(String(process.env.KALSHI_LINK || '').trim()) ? 'KALSHI_LINK is off.' : 'DATABASE_URL is not set, so a saved key would be lost at the next deploy.');
const kalshiLinks = KALSHI_LINK_ON ? kalshiLinkMod.createKalshiLinks({
  store: createEvStoreFromEnv(process.env, { table: 'kalshi_links', fileVar: 'KALSHI_LINKS_FILE', file: 'kalshi-links.json' }),
  secret: process.env.AUTH_SECRET, base: process.env.KALSHI_API_BASE || kalshiLinkMod.API_BASE,
  // axios.get looked up per call (tests stub it); never the shared polite queue, which shares answers by URL
  http: { get: (url, cfg) => axios.get(url, cfg) },
}) : null;
if (kalshiLinks) kalshiLinks.init().catch(e => console.warn('Kalshi link: store failed to initialise:', e.message));
// a Kalshi ticker → the record bets its YES and NO are, from the line shop's game index
function kalshiFillLookup() {
  let big = null;
  try { big = bigGames(); } catch { return () => null; }
  const raw = new Map();
  for (const [league, list] of Object.entries(freeBooksState.games || {})) for (const g of list || []) raw.set(String(g.id).replace(/^pin-/, ''), { g, league });
  const toBet = (key, game) => {
    const hit = key && raw.get(String(game.id).replace(/^pin-/, ''));
    return hit ? kalshiLinkMod.betForKey(key, hit.g, hit.league) : null;
  };
  return ticker => {
    const m = big?.rows?.get(`kalshi:${ticker}`);
    if (!m) return null;
    const yes = toBet(m.yes, m.game), no = toBet(m.no, m.game);
    return yes || no ? { yes, no } : null;
  };
}
async function pollKalshiLinks() {
  if (!kalshiLinks) return null;
  return kalshiLinks.pollAll({ lookup: kalshiFillLookup(), addBets: (h, list) => pubRecords.addVerifiedBets(h, list),
    onAdded: h => { pubForget(h); gradePubRecords({ only: h, maxLegs: 600 }).then(() => pubForget(h)).catch(() => {}); } });
}
if (kalshiLinks) schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', () => pollKalshiLinks().catch(e => console.warn('Kalshi link: poll:', e.message)));
async function kalshiOwner(req) {
  await pubRecords.init();
  const h = pubRecord.cleanHandle(req.params.handle).handle;
  const r = h && pubRecords.get(h);
  if (!r || r.status !== 'live') throw Object.assign(new Error('No published record with that handle.'), { status: 404 });
  if (!pubRecords.owns(h, recordKey(req))) throw Object.assign(new Error('That key does not manage this record.'), { status: 403 });
  if (!kalshiLinks) throw Object.assign(new Error(`Connecting Kalshi is not switched on here: ${kalshiLinkWhyOff()}`), { status: 503 });
  return h;
}
app.get('/api/kalshi-link', (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: !!kalshiLinks, why: kalshiLinkWhyOff(), scopes: ['read'],
  note: 'Read-only keys only: a key that can trade or move money is refused and never saved.' }));
app.get('/api/records/:handle/kalshi', async (req, res) => {
  try { const h = await kalshiOwner(req); res.set('Cache-Control', 'no-store').json(await kalshiLinks.status(h)); } catch (e) { sendErr(res, e); }
});
// body: { keyId, privateKey }; checked with Kalshi (read-only) before anything is saved
app.post('/api/records/:handle/kalshi', async (req, res) => {
  try {
    const h = await kalshiOwner(req);
    const out = await kalshiLinks.connect(h, req.body?.keyId, req.body?.privateKey);
    res.set('Cache-Control', 'no-store').status(201).json(out);
  } catch (e) { sendErr(res, e); }
});
app.delete('/api/records/:handle/kalshi', async (req, res) => {
  try { const h = await kalshiOwner(req); res.set('Cache-Control', 'no-store').json(await kalshiLinks.disconnect(h)); } catch (e) { sendErr(res, e); }
});
app.get('/api/records/:handle', widgetGate, async (req, res) => {
  try {
    const v = await pubView(req.params.handle, parseInt(req.query.page, 10) || 1);
    if (!v) return res.status(404).json({ error: 'No record with that handle.' });
    res.set('Cache-Control', 'public, max-age=60').json(v);
  } catch (e) { sendErr(res, e); }
});
app.get('/api/records/:handle/slips.:ext', widgetGate, async (req, res) => {
  try {
    if (!/^(csv|json)$/.test(req.params.ext)) return res.status(404).json({ error: 'csv or json' });
    const v = await pubView(req.params.handle, 1);
    if (!v || v.status !== 'live') return res.status(404).json({ error: 'No published record with that handle.' });
    const all = pubRecord.recordView(pubRecords.get(v.handle), pubRecords.slipsOf(v.handle), { tables: pubTables(), perPage: 1e6, bets: pubRecords.betsOf(v.handle) });
    const name = `line-reaper-record-${v.handle}-${new Date().toISOString().slice(0, 10)}.${req.params.ext}`;
    res.set({ 'Cache-Control': 'public, max-age=60', 'Content-Disposition': `attachment; filename="${name}"` });
    if (req.params.ext === 'csv') return res.type('text/csv; charset=utf-8').send(pubRecord.csv(all));
    res.json(all);
  } catch (e) { sendErr(res, e); }
});
app.get('/r/:handle', widgetGate, async (req, res) => {
  try {
    const v = await pubView(req.params.handle, parseInt(req.query.page, 10) || 1);
    const o = siteOrigin(req);
    if (!v) return res.status(404).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Line Reaper</title><body style="background:#080b10;color:#e2e8f0;font:16px system-ui;padding:24px">No bettor record with that handle. <a style="color:#34d399" href="/app?start=myslips">Publish your own from MY SLIPS</a>.</body>`);
    const place = v.status === 'live' ? await pubPlace(v.handle).catch(() => null) : null;
    res.set('Cache-Control', 'public, max-age=60').type('html').send(pubRecord.pageHtml(v, { origin: o, url: `${o}/r/${v.handle}`, image: shareImageUrl(o, `record-${v.handle}`, ''), place }));
  } catch (e) { res.status(500).set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><body style="background:#080b10;color:#e2e8f0;font:16px system-ui;padding:24px">This record could not be read just now. Try again in a minute.</body>'); console.warn('Public record page:', e.message); }
});


return {
  pubRecord, leaderboard, pubRecords, pubRecordState, recordKey, pubTables, pubView, pubIndex,
  pubBoard, kalshiLinkWhyOff, kalshiLinks, kalshiFillLookup, pollKalshiLinks
};
};
