// Public API v1, widgets and share cards (publicapi.js, embeds.js)
// Moved out of server.js as it was (the route split): mount(ctx) runs where
// the section used to be, so routes keep their order. ctx carries what the
// section reads from server.js; it returns what server.js reads back.
'use strict';

module.exports = function mount(ctx) {
// ctx.discordBot, ctx.pubBoard, ctx.pubRecord and ctx.pubView mount later and
// ctx.evBookProven is replaced every refresh: read them when a request runs
const {
  FREE_BOOKS_MAX_AGE_MS, PAYWALL, alertHistoryFor, alertQueryOf, app, bigMoves, claims, closeBoard,
  closeBoardFor, createEvStoreFromEnv, digest, digestFor, digestIndex,
  freeBooksState, hideWallets, isAdmin, learn, lineArchive, lineGame, lineHist, lineIndexBody,
  lineProp, lineQuery, movesFor, oddsFmt, oddsHistory, oddsScreen, oddsScreenFor, planOfReq,
  planOfUserId, plans, recordFlags, resultsBackup, searchBody,
  searchLib, shopDepth, shopQuotes, shopState, shopper, siteOrigin, statusView, stripPolymarketLinks,
  venues, webhookLicence
} = ctx;

const publicApi = require('../publicapi');
const embeds = require('../embeds');
const shareCards = require('../sharecards');
const apiKeys = publicApi.createKeyStore({ store: resultsBackup.wrap('apiKeys', createEvStoreFromEnv(process.env, { table: 'api_keys', fileVar: 'API_KEYS_FILE', file: 'api-keys.json', user: true })) });
apiKeys.init().catch(e => console.warn('API keys: store failed to initialise:', e.message));
const apiLimiter = publicApi.createLimiter();
const widgetLimiter = publicApi.createLimiter({ perMinute: publicApi.WIDGET_PER_MINUTE, perDay: 0 });
const v1Safe = x => hideWallets(stripPolymarketLinks(x));
const v1FullTier = () => !PAYWALL;
const v1Stale = () => Date.now() - Date.parse(freeBooksState.gamesAt || 0) >= FREE_BOOKS_MAX_AGE_MS;
class V1Error extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const v1Str = (v, re, name) => {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (!re.test(s)) throw new V1Error(400, 'bad_parameter', `${name} is not valid.`);
  return s;
};
const v1Int = (v, lo, hi, def, name) => {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new V1Error(400, 'bad_parameter', `${name} must be a whole number from ${lo} to ${hi}.`);
  return n;
};
const v1Num = (v, lo, hi, name) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new V1Error(400, 'bad_parameter', `${name} must be a number from ${lo} to ${hi}.`);
  return n;
};
const V1_MARKETS = new Set(['moneyline', 'spread', 'total', 'player_prop']);
// ?state=TX: only venues a resident there can use (venues.js); a bad code is a 400, not everything
function v1State(v) {
  if (v == null || v === '') return null;
  const st = venues.stateOf(v);
  if (!st) throw new V1Error(400, 'bad_parameter', 'state is a two-letter US state code, like TX (DC too).');
  return st;
}
const v1StateHead = st => (st ? { state: st, stateName: venues.stateInfo(st).name, stateNote: `Only venues a source says a ${venues.stateInfo(st).name} resident can use. ${venues.CHECK}` } : {});
// each endpoint's body from its query and path values; the routes, the
// widgets and the /developers examples all call these
const v1 = {
  bestPrices(q) {
    const league = v1Str(q.league, /^[a-z0-9]{1,20}$/, 'league');
    const markets = q.market ? String(q.market).toLowerCase().split(',').map(x => x.trim()).filter(Boolean) : null;
    if (markets && (markets.length > 4 || markets.some(m => !V1_MARKETS.has(m)))) throw new V1Error(400, 'bad_parameter', 'market is one or more of moneyline, spread, total, player_prop.');
    const venue = v1Str(q.venue, /^[a-z0-9]{1,20}$/, 'venue');
    const minEv = v1Num(q.minEv, -100, 1000, 'minEv') ?? 0;
    const minSize = v1Num(q.minSize, 0, 100000, 'minSize');
    const hours = v1Num(q.hours, 0.1, 336, 'hours') ?? 48;
    const limit = v1Int(q.limit, 1, 200, 50, 'limit');
    const state = v1State(q.state);
    const lic = webhookLicence();
    const at = new Date().toISOString();
    const head = { at, builtAt: shopState.builtAt || null, stale: v1Stale(), fairFrom: "Pinnacle's no-vig price (power method); EV is after each venue's fee",
      labels: { proven: "PROVEN: the venue's main lines are proven on RESULTS", lead: 'LEAD: research, not a proven edge' } };
    if (!v1FullTier()) return { ...head, locked: true, note: 'Fair prices and EV are for subscribers while the paywall is on, so no rows are listed here.', count: 0, rows: [] };
    const st = shopQuotes();
    const key = `bp|${lic.kalshi ? 1 : 0}${lic.polymarket ? 1 : 0}|${st.builtAt}|${league}|${markets}|${venue}|${minEv}|${minSize}|${hours}|${state}`;
    const rows = v1MemoSync(key, () => {
      let quotes = lic.kalshi ? [...st.free.quotes, ...st.kalshi.quotes] : st.free.quotes;
      if (!lic.polymarket) quotes = quotes.filter(x => !String(x.providerId).startsWith('polymarket'));
      const view = shopper.build(quotes, { league, marketTypes: markets, providers: venue ? [venue] : null, state, toMs: Date.now() + hours * 3600e3,
        minEv: minEv / 100, minSize: minSize || null, sort: 'ev', stake: 100, method: 'power', limit: 200, proven: ctx.evBookProven, depth: shopDepth.forQuote });
      return publicApi.bestPrices(view, { limit: 200 });
    });
    return { ...head, ...v1StateHead(state), locked: false, count: Math.min(rows.length, limit), rows: rows.slice(0, limit) };
  },
  moves(q) {
    const window = v1Str(q.window, /^(open|3h|1h)$/, 'window') || 'open';
    const type = v1Str(q.type, /^(price|line)$/, 'type') || 'price';
    const league = v1Str(q.league, /^[a-z0-9]{1,20}$/, 'league');
    const kind = v1Str(q.kind, /^(game|prop)$/, 'kind');
    const limit = v1Int(q.limit, 1, 200, 50, 'limit');
    const base = movesFor({ window, kalshiOk: !!webhookLicence().kalshi });
    const rows = bigMoves.rank(base.rows.filter(r => !kind || r.kind === kind), { league, type, sort: 'move' });
    return { at: base.updated, window, type, league, kind, linesAt: base.linesAt, stale: !!base.stale, total: rows.length, rows: rows.slice(0, limit).map(publicApi.moveRow),
      note: 'A move is information, not a proven edge. Venues still at the old number have graded as no edge against the close.' };
  },
  moveHistory(gameId, q) {
    const id = String(gameId || '').slice(0, 80);
    const market = v1Str(q.market, /^(ml|spread|total)$/, 'market');
    const lic = webhookLicence();
    const live = oddsHistory.forGame(id);
    let series = (live.length ? live : lineArchive.gameSeries(id)).filter(x => !market || x.market === market);
    if (!lic.kalshi) series = series.map(x => ({ ...x, pts: x.pts.map(([t, p, f, px]) => [t, p, f, Object.fromEntries(Object.entries(px).filter(([k]) => k !== 'kalshi'))]) }));
    if (!series.length) throw new V1Error(404, 'not_found', `No saved prices for that game: an id comes from /api/v1/moves, /api/v1/lines or /api/v1/leagues/{league}, and history is kept ${lineHist.KEEP_DAYS} days after the start (/api/v1/lines/game/{gameId} has it as CSV too).`);
    const g = oddsScreenFor({ kalshiOk: !!lic.kalshi }).games.find(x => x.id === id);
    return { gameId: id, game: g ? { event: `${g.away} @ ${g.home}`, league: g.league, leagueLabel: g.leagueLabel, start: g.start } : null, fairShown: v1FullTier(),
      series: publicApi.historySeries(series, { withFair: v1FullTier() }) };
  },
  leagues() {
    const s = oddsScreenFor({ kalshiOk: !!webhookLicence().kalshi });
    return { at: new Date().toISOString(), linesAt: s.updated, stale: !!s.stale, leagues: s.leagues.map(l => ({ ...l, board: `/api/v1/leagues/${l.key}` })) };
  },
  league(lg, q) {
    const league = v1Str(lg, /^[a-z0-9]{1,20}$/, 'league');
    const search = String(q.q || '').slice(0, 60);
    const state = v1State(q.state);
    const s = oddsScreenFor({ league, q: search, state, kalshiOk: !!webhookLicence().kalshi });
    if (!s.games.length && !s.leagues.some(l => l.key === league)) throw new V1Error(404, 'not_found', `No ${league} games in the next 48 hours. /api/v1/leagues lists the leagues on the board.`);
    const full = v1FullTier();
    return { at: new Date().toISOString(), league, ...v1StateHead(state), linesAt: s.updated, stale: !!s.stale, fairShown: full, venues: s.venues, count: s.games.length,
      games: (full ? s : oddsScreen.stripPro(s)).games.map(g => publicApi.boardGame(g, { withFair: full })),
      note: 'Fair is Pinnacle\'s no-vig price. Reference venues (Pinnacle, Matchbook, Polymarket global) are prices to read, not places to bet from the US; second-hand prices are copies, never a play alone.' };
  },
  async record(q) {
    const days = v1Num(q.days, 0, 3650, 'days') || 0;
    const state = v1State(q.state);
    const rec = claims.publicRecord({ board: await closeBoardFor(webhookLicence(), days, state) });
    return { ...rec, ...v1StateHead(state), days: days || null, flags: '/api/v1/record/flags' };
  },
  async flags(q) {
    const days = v1Num(q.days, 0, 3650, 'days') || 0;
    const kind = v1Str(q.kind, /^[\w-]{1,40}$/, 'kind'), book = v1Str(q.book, /^[\w-]{1,40}$/, 'book');
    const limit = v1Int(q.limit, 1, 1000, 200, 'limit'), offset = v1Int(q.offset, 0, 1e7, 0, 'offset');
    const { rows } = await recordFlags({ query: { days: days || undefined, kind: kind || undefined, book: book || undefined } });
    return { at: new Date().toISOString(), days: days || null, kind, book, columns: closeBoard.FLAG_COLUMNS, total: rows.length, offset, limit, flags: rows.slice(offset, offset + limit) };
  },
  states(st) {
    if (st == null) return { asOf: venues.table().asOf, check: venues.CHECK, states: venues.statesList(), table: '/api/states/table' };
    const info = venues.stateInfo(v1State(st));
    if (!info) throw new V1Error(404, 'not_found', 'A state is its two-letter code, like TX.');
    return info;
  },
  digests: () => digestIndex(),
  // the alert history: with the paywall on, the API is the free view (bets shown once their games start)
  alerts: q => {
    // a misspelt filter is a 400 that says so, never every alert
    const kind = v1Str(q.kind, /^[a-z]{1,20}$/, 'kind');
    if (kind && !require('../push').KIND_KEYS.includes(kind)) throw new V1Error(400, 'bad_parameter', `kind is one of ${require('../push').KIND_KEYS.join(', ')}.`);
    v1Num(q.days, 0, 3650, 'days');
    v1Int(q.limit, 1, 500, 100, 'limit');
    if (q.before != null && q.before !== '' && !Number.isFinite(Date.parse(q.before))) throw new V1Error(400, 'bad_parameter', 'before is an ISO time, e.g. 2026-10-27T00:00:00Z.');
    return alertHistoryFor({ ...alertQueryOf(q), full: !PAYWALL });
  },
  async digest(week) {
    const w = String(week || '');
    if (!digest.validWeek(w)) throw new V1Error(400, 'bad_parameter', 'A week is the date of its Monday, like 2026-10-19.');
    const out = await digestFor(w);
    if (!out) throw new V1Error(404, 'not_found', 'That week has not started.');
    return { ...out, share: `/digest/${w}` };
  },
  status: () => statusView(),
};
// a short synchronous memo for the shopper's per-query build
const v1Sync = new Map();
function v1MemoSync(key, fn) {
  const hit = v1Sync.get(key);
  if (hit && Date.now() - hit.at < 30e3) return hit.v;
  const v = fn();
  if (v1Sync.size > 200) v1Sync.clear();
  v1Sync.set(key, { at: Date.now(), v });
  return v;
}
function v1Fail(res, e) {
  if (!(e instanceof V1Error)) console.warn('API v1:', e.message);
  const status = e instanceof V1Error ? e.status : 500;
  return res.status(status).set('Cache-Control', 'no-store').json({ error: { code: e instanceof V1Error ? e.code : 'server_error', message: e instanceof V1Error ? e.message : 'Something went wrong on our side. Try again in a minute.' } });
}
// every /api/v1 answer: the headers a browser caller may read
app.use('/api/v1', (req, res, next) => {
  res.set({ 'Access-Control-Expose-Headers': 'ETag, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Daily-Limit, X-RateLimit-Daily-Remaining, Retry-After', 'X-Robots-Tag': 'noindex' });
  next();
});
const v1KeyOf = req => req.get('x-api-key') || (typeof req.query.key === 'string' ? req.query.key : '');
// a key's limits follow its plan (plans.js): its account's, or Free for a key
// made signed out once the paywall is on; the admin token is always Pro
async function v1PlanOf(req, doc) {
  if (isAdmin(req)) return 'pro';
  return planOfUserId(doc.userId);
}
const v1Limits = plan => { const l = plans.limitsOf(plan); return { perMinute: l.apiPerMinute, perDay: l.apiPerDay }; };
async function v1Auth(req, res, next) {
  const key = v1KeyOf(req);
  const doc = apiKeys.check(key);
  if (!doc) return v1Fail(res, new V1Error(401, key ? 'bad_key' : 'no_key', key ? 'That key is not known or was revoked. Make a new one at /developers.' : 'Send your key in an X-API-Key header. Make one free at /developers.'));
  const plan = await v1PlanOf(req, doc);
  const lim = apiLimiter.take(doc.id, v1Limits(plan));
  publicApi.limitHeaders(res, lim);
  res.set('X-Line-Reaper-Plan', plan);
  const more = plan === 'free' && PAYWALL ? ' Pro keys get more: /pricing.' : '';
  if (!lim.ok) return v1Fail(res, new V1Error(429, 'rate_limited', lim.over === 'day' ? `Over ${lim.dayLimit} calls today (UTC). Try again tomorrow.${more}` : `Over ${lim.limit} calls this minute. Try again in ${lim.retryAfter} s.${more}`));
  req.apiKey = doc;
  req.apiPlan = plan;
  next();
}
const v1Route = fn => async (req, res) => {
  try { publicApi.sendCached(req, res, v1Safe(await fn(req))); } catch (e) { v1Fail(res, e); }
};
app.get('/api/v1', (req, res) => publicApi.sendCached(req, res, { version: publicApi.VERSION, docs: '/developers', auth: 'X-API-Key header (or ?key=)', limits: publicApi.LIMITS,
  plans: PAYWALL ? Object.fromEntries(plans.PLAN_IDS.map(id => [id, v1Limits(id)])) : null, pricing: '/pricing',
  endpoints: publicApi.ENDPOINTS.map(e => ({ path: e.path, title: e.title, params: Object.fromEntries(e.params) })), widgets: ['/embed/best-price', '/embed/line-move', '/embed/record', '/embed.js'],
  feed: { status: 'GET /api/v1/feed', connect: 'PUT /api/v1/feed/discord with {"url": "<Discord webhook URL>"}', records: 'PUT /api/v1/feed/records with {"handles": ["<handle>"], "results": true}', disconnect: 'DELETE /api/v1/feed/discord', docs: '/developers#feed' },
  bot: { status: 'GET /api/v1/bot', connect: 'PUT /api/v1/bot/discord with {"appId", "publicKey", "botToken"}', disconnect: 'DELETE /api/v1/bot/discord', commands: ctx.discordBot.COMMANDS.map(c => `/${c.name}`), docs: '/developers#bot',
    telegram: { connect: 'PUT /api/v1/bot/telegram with {"botToken": "<token from @BotFather>"}', disconnect: 'DELETE /api/v1/bot/telegram', commands: ['/odds', '/props', '/moves', '/record', '/lines', '/settings', '/help'] } } }, { scope: 'public', maxAge: 300 }));
app.post('/api/v1/keys', async (req, res) => {
  try {
    // a signed-in account keeps at most its plan's number of live keys
    const plan = req.user ? planOfReq(req) : (PAYWALL ? 'free' : 'pro');
    if (req.user) {
      await apiKeys.init();
      const live = apiKeys.listFor(req.user.id).filter(k => !k.revokedAt).length, max = plans.limitsOf(plan).apiKeys;
      if (live >= max) throw new V1Error(403, 'plan_limit', `Your plan keeps ${max} live API key${max === 1 ? '' : 's'}. Revoke one at /developers${plan === 'free' ? ', or see /pricing for Pro' : ''}.`);
    }
    const out = await apiKeys.create({ name: req.body?.name, userId: req.user?.id || null, who: publicApi.callerOf(req) });
    res.status(201).set('Cache-Control', 'no-store').json({ ...out, note: 'Shown once: keep it somewhere safe. Only a hash of it is stored.', plan, limits: v1Limits(plan) });
  } catch (e) {
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    v1Fail(res, e.status && !(e instanceof V1Error) ? new V1Error(e.status, e.status === 429 ? 'rate_limited' : 'unavailable', e.message) : e);
  }
});
// a signed-in account's keys (never the keys themselves)
app.get('/api/v1/keys', async (req, res) => {
  if (!req.user) return v1Fail(res, new V1Error(401, 'not_signed_in', 'Sign in to list the keys made from your account.'));
  await apiKeys.init().catch(() => {});
  res.set('Cache-Control', 'no-store').json({ keys: apiKeys.listFor(req.user.id) });
});
app.get('/api/v1/key', v1Auth, (req, res) => res.set('Cache-Control', 'no-store').json({ key: publicApi.publicKey(req.apiKey), usage: apiLimiter.usage(req.apiKey.id), plan: req.apiPlan, limits: v1Limits(req.apiPlan) }));
app.delete('/api/v1/key', v1Auth, async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ revoked: await apiKeys.revoke(v1KeyOf(req)) }); } catch (e) { v1Fail(res, e); }
});
app.get('/api/v1/best-prices', v1Auth, v1Route(req => v1.bestPrices(req.query)));
app.get('/api/v1/moves', v1Auth, v1Route(req => v1.moves(req.query)));
app.get('/api/v1/moves/:gameId', v1Auth, v1Route(req => v1.moveHistory(req.params.gameId, req.query)));
app.get('/api/v1/leagues', v1Auth, v1Route(() => v1.leagues()));
app.get('/api/v1/leagues/:league', v1Auth, v1Route(req => v1.league(req.params.league, req.query)));
app.get('/api/v1/record', v1Auth, v1Route(req => v1.record(req.query)));
app.get('/api/v1/record/flags', v1Auth, v1Route(req => v1.flags(req.query)));
app.get('/api/v1/states', v1Auth, v1Route(() => v1.states()));
app.get('/api/v1/states/:state', v1Auth, v1Route(req => v1.states(req.params.state)));
app.get('/api/v1/digest', v1Auth, v1Route(() => v1.digests()));
app.get('/api/v1/digest/:week', v1Auth, v1Route(req => v1.digest(req.params.week)));
app.get('/api/v1/alerts', v1Auth, v1Route(req => v1.alerts(req.query)));
// line history (linehist.js): the plan's window (limitsOf(plan).historyDays), JSON or ?format=csv
const v1LineDays = req => (PAYWALL ? plans.limitsOf(req.apiPlan).historyDays : lineHist.KEEP_DAYS);
const v1LineFormat = q => v1Str(q.format, /^(json|csv)$/, 'format') || 'json';
function v1LinesBody(query, plan, days) {
  const q = { ...lineQuery(query), league: v1Str(query.league, /^[a-z0-9]{1,20}$/, 'league') || '', kind: v1Str(query.kind, /^(game|prop)$/, 'kind') || '' };
  const b = lineIndexBody(q, { days, limit: v1Int(query.limit, 1, 500, 100, 'limit') });
  return { at: new Date().toISOString(), keepDays: b.keepDays, windowDays: days, plan, since: b.since, total: b.total, next: b.next,
    markets: b.rows.map(r => ({ ...r, history: r.kind === 'game' ? `/api/v1/lines/game/${encodeURIComponent(r.key)}?market=${r.market}` : `/api/v1/lines/prop?key=${encodeURIComponent(r.key)}`,
      page: r.kind === 'game' ? `/lines/game/${encodeURIComponent(r.key)}?market=${r.market}` : `/lines/prop?key=${encodeURIComponent(r.key)}` })) };
}
app.get('/api/v1/lines', v1Auth, v1Route(req => v1LinesBody(req.query, req.apiPlan, v1LineDays(req))));
function v1LineSend(req, res, d, days) {
  try {
    const format = v1LineFormat(req.query);
    if (!d.series.length) throw new V1Error(404, 'not_found', `No saved prices for that market in your window (${days} days${days < lineHist.KEEP_DAYS ? `; Pro keys get ${lineHist.KEEP_DAYS}: /pricing` : ''}). Ids come from /api/v1/lines.`);
    const meta = { kind: d.kind, id: d.id, ...d.meta, onBoard: d.live, keepDays: lineHist.KEEP_DAYS, windowDays: days, plan: req.apiPlan, fairShown: v1FullTier(),
      note: 'Every point is a price we read. Reads older than 6 hours after the start are thinned to the biggest moves; nothing is filled in.' };
    if (format === 'csv') return publicApi.sendCached(req, res, lineHist.toCsv(meta, d.series), { type: 'text/csv; charset=utf-8' });
    publicApi.sendCached(req, res, v1Safe(lineHist.toJson(meta, d.series)));
  } catch (e) { v1Fail(res, e); }
}
app.get('/api/v1/lines/game/:gameId', v1Auth, (req, res) => {
  const days = v1LineDays(req);
  let d;
  try {
    const market = v1Str(req.query.market, /^(ml|spread|total)$/, 'market');
    d = lineGame(String(req.params.gameId || '').slice(0, 80), { pro: v1FullTier(), kalshi: !!webhookLicence().kalshi, days });
    if (market) d = { ...d, series: d.series.filter(x => x.market === market) };
  } catch (e) { return v1Fail(res, e); }
  v1LineSend(req, res, d, days);
});
app.get('/api/v1/lines/prop', v1Auth, (req, res) => {
  const days = v1LineDays(req);
  const key = String(req.query.key || '').slice(0, 300);
  if (!key) return v1Fail(res, new V1Error(400, 'bad_parameter', 'key: a prop market key from /api/v1/lines?kind=prop.'));
  v1LineSend(req, res, lineProp(key, { pro: v1FullTier(), kalshi: !!webhookLicence().kalshi, days }), days);
});
app.get('/api/v1/status', v1Auth, v1Route(() => v1.status()));
app.get('/api/v1/records/:handle', v1Auth, v1Route(async req => {
  const c = ctx.pubRecord.cleanHandle(req.params.handle);
  const v = c.handle ? await ctx.pubView(c.handle, 1) : null;
  if (!v) throw new V1Error(404, 'not_found', 'No published bettor record with that handle.');
  return ctx.pubRecord.bettorCard(v);
}));
// the app's SEARCH box: games, esports series, players, markets and leagues the site holds now
app.get('/api/v1/search', v1Auth, v1Route(req => {
  if (searchLib.cleanQ(req.query.q).length < 2) throw new V1Error(400, 'bad_parameter', 'q: two or more letters, e.g. q=lakers');
  const kinds = req.query.kind ? String(req.query.kind).toLowerCase().split(',').map(k => k.trim()).filter(Boolean) : [];
  if (kinds.some(k => !searchLib.KINDS.includes(k))) throw new V1Error(400, 'bad_parameter', `kind is one or more of ${searchLib.KINDS.join(', ')}.`);
  v1State(req.query.state);
  return searchBody(req, { limit: v1Int(req.query.limit, 1, 60, 30, 'limit') });
}));

// ── widgets: no key, a per-address limit, the same bodies as the API ──
function widgetGate(req, res, next) {
  const lim = widgetLimiter.take(publicApi.callerOf(req));
  if (!lim.ok) return res.status(429).set({ 'Retry-After': String(lim.retryAfter), 'Cache-Control': 'no-store' }).type('html').send('<!doctype html><meta charset="utf-8"><body style="background:#080b10;color:#94a3b8;font:13px system-ui;margin:8px">Too many widget loads from this address. It will load again in a minute.</body>');
  next();
}
const widgetId = req => String(req.query._id || '').replace(/[^\w-]/g, '').slice(0, 40);
const sendWidget = (req, res, html) => publicApi.sendCached(req, res, html, { type: 'text/html; charset=utf-8', maxAge: 60, scope: 'public' });
const widgetError = (res, e) => res.status(e instanceof V1Error ? e.status : 500).set('Cache-Control', 'no-store').type('html')
  .send(`<!doctype html><meta charset="utf-8"><body style="background:#080b10;color:#94a3b8;font:13px system-ui;margin:8px">${learn.esc(e instanceof V1Error ? e.message : 'This widget could not load. It tries again in a minute.')}</body>`);
app.get('/embed/best-price', widgetGate, (req, res) => {
  try {
    const n = v1Int(req.query.n, 1, 5, 1, 'n');
    const body = v1Safe(v1.bestPrices({ league: req.query.league, market: req.query.market, venue: req.query.venue, state: req.query.state, limit: n }));
    sendWidget(req, res, embeds.bestPriceWidget(body.rows, { league: v1Str(req.query.league, /^[a-z0-9]{1,20}$/, 'league'), at: body.builtAt, locked: body.locked, stale: body.stale, origin: siteOrigin(req), id: widgetId(req), fmt: oddsFmt.fmtOf(req.query.odds) }));
  } catch (e) { widgetError(res, e); }
});
app.get('/embed/line-move', widgetGate, (req, res) => {
  try {
    let game = String(req.query.game || '').slice(0, 80), market = v1Str(req.query.market, /^(ml|spread|total)$/, 'market');
    if (!game) {
      // today's biggest game-line move, price first
      const base = movesFor({ window: 'open', kalshiOk: !!webhookLicence().kalshi });
      const games = base.rows.filter(r => r.kind === 'game');
      const top = bigMoves.rank(games, { type: 'price', sort: 'move' })[0] || bigMoves.rank(games, { type: 'line', sort: 'move' })[0];
      if (top) { game = top.gameId; market = market || top.market; }
    }
    let hist = null;
    if (game) { try { hist = v1Safe(v1.moveHistory(game, {})); } catch (e) { if (!(e instanceof V1Error)) throw e; } }
    const g = hist?.game ? { ...hist.game } : null;
    const sideIndex = v1Int(req.query.side, 0, 2, 0, 'side');
    sendWidget(req, res, embeds.lineMoveWidget({ game: g || (hist ? { event: game, leagueLabel: '', start: hist.series[0]?.start } : (game ? { event: game } : null)), series: hist?.series || [], market, sideIndex,
      withFair: v1FullTier(), origin: siteOrigin(req), id: widgetId(req), venueName: v => bigMoves.NAMES[v] || venues.NAMES[v] || v, fmt: oddsFmt.fmtOf(req.query.odds) }));
  } catch (e) { widgetError(res, e); }
});
app.get('/embed/record', widgetGate, async (req, res) => {
  try {
    // ?handle=: a bettor's own published record (pubrecord.js), the same card as /api/v1/records/<handle>
    if (req.query.handle != null) {
      const c = ctx.pubRecord.cleanHandle(req.query.handle);
      const v = c.handle ? await ctx.pubView(c.handle, 1) : null;
      return sendWidget(req, res, embeds.bettorWidget(ctx.pubRecord.bettorCard(v || { handle: c.handle || null, status: 'missing' }), { origin: siteOrigin(req), id: widgetId(req) }));
    }
    sendWidget(req, res, embeds.recordWidget(publicApi.recordCard(await v1.record({})), { origin: siteOrigin(req), id: widgetId(req) }));
  } catch (e) { widgetError(res, e); }
});
app.get('/embed.js', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/javascript').send(embeds.embedScript(siteOrigin(req))));

// ── SHARE CARDS: a PNG of a price row, a line chart, a league or the record ──
// sharecards.js draws each one from the same bodies as the API and widgets
// (so a card never says more than RESULTS), and resvg turns it into a PNG.
// /card/<kind>.png (or .svg) is the image; /share/<kind> is the page a pasted
// link opens, with Open Graph and Twitter tags pointing at the image. Same
// card for everyone: nothing from an account, no stake, no slips.
const SHARE_KINDS = new Set(['price', 'move', 'league', 'record', 'digest', 'alerts', 'leaderboard']);
const cardStr = (v, re, max = 120) => { const s = String(v ?? '').slice(0, max); return re.test(s) ? s : null; };
// the card's data and its words, from the query; never from numbers the browser sends
async function shareCardFor(kind, q, origin) {
  const venueName = v => bigMoves.NAMES[v] || venues.NAMES[v] || v;
  const fmt = oddsFmt.fmtOf(q.odds);
  // a bettor's own record (pubrecord.js), /card/record-<handle>.png
  const bettor = /^record-([a-z0-9_]{3,20})$/.exec(kind);
  if (bettor) {
    const v = await ctx.pubView(bettor[1], 1);
    if (!v) throw new V1Error(404, 'not_found', 'No bettor record with that handle.');
    return { svg: shareCards.bettorCard(v, { origin }), at: v.at, title: `@${v.handle}: verified pick'em record`, description: 'Slips logged before the start, graded against Pinnacle\'s close.', open: `/r/${v.handle}`, page: `/r/${v.handle}` };
  }
  if (kind === 'leaderboard') {
    const v = await ctx.pubBoard({ league: q.league, window: q.window });
    return { svg: shareCards.boardCard(v, { origin }), at: v.at, title: 'Bettor leaderboard: CLV against Pinnacle\'s close', description: `Published records ranked only at ${v.bar} picks logged before the start. ${v.ranked.length} ranked.`, open: '/r#board', page: '/r#board' };
  }
  if (kind === 'price') {
    const id = cardStr(q.id, /^[^\u0000-\u001f<>]{1,300}$/, 300);
    const at = new Date().toISOString();
    let d;
    if (!v1FullTier()) d = { locked: true, at };
    else if (v1Stale()) d = { stale: true, at };
    else {
      const st = shopQuotes(), lic = webhookLicence();
      const rows = v1MemoSync(`card|${lic.kalshi ? 1 : 0}${lic.polymarket ? 1 : 0}|${st.builtAt}`, () => {
        let quotes = lic.kalshi ? [...st.free.quotes, ...st.kalshi.quotes] : st.free.quotes;
        if (!lic.polymarket) quotes = quotes.filter(x => !String(x.providerId).startsWith('polymarket'));
        // every side's best price, above the fair or not, so a row shared from a
        // screen set to show both is found
        const view = shopper.build(quotes, { sort: 'ev', stake: 100, method: 'power', limit: 1000, minEv: -1, proven: ctx.evBookProven, depth: shopDepth.forQuote });
        return publicApi.bestPrices(view, { limit: 1000 });
      });
      const row = id ? rows.find(r => r.id === id) || null : rows.find(r => r.evPct > 0) || null;
      d = { row, at: st.builtAt || at, gone: !!id && !row };
    }
    const r = d.row;
    return { svg: shareCards.priceCard(r, { ...d, origin, fmt }), at: d.at,
      title: r ? `${r.selection} ${r.price.american != null ? oddsFmt.fromAm(r.price.american, fmt) : ''} at ${r.venueName}` : d.gone ? 'A price that has moved' : 'Best price above the fair',
      description: r ? `${r.event}. Pinnacle's fair ${oddsFmt.fromAm(r.fair.american, fmt)}, EV ${r.evPct > 0 ? '+' : ''}${r.evPct ?? '—'}% after the fee. ${r.label === 'proven' ? `${r.venueName} main lines are proven on RESULTS; this row is one price, not a result.` : 'LEAD: research, not a proven edge.'}` : 'Open the app for every price beside the fair.',
      open: '?start=odds' };
  }
  if (kind === 'move') {
    const game = cardStr(q.game, /^[\w:.|@ -]{1,80}$/, 80);
    const market = cardStr(q.market, /^(ml|spread|total)$/);
    const side = cardStr(q.side, /^[^\u0000-\u001f<>]{1,80}$/, 80);
    const sideIndex = Math.min(2, Math.max(0, parseInt(q.i, 10) || 0));
    let hist = null;
    if (game) { try { hist = v1.moveHistory(game, {}); } catch (e) { if (!(e instanceof V1Error)) throw e; } }
    const g = hist?.game || (hist ? { event: game, leagueLabel: '', start: hist.series[0]?.start } : null);
    const pick = hist ? shareCards.pickSeries(hist.series, { market, side, sideIndex }) : null;
    const last = pick?.s?.points[pick.s.points.length - 1];
    return { svg: shareCards.moveCard({ game: g, series: hist?.series || [], market, side, sideIndex, withFair: v1FullTier(), origin, venueName, fmt }), at: last?.t || null,
      title: g ? `${g.event}: line move` : 'Line move', description: pick?.s ? `${g.leagueLabel ? g.leagueLabel + ' · ' : ''}${pick.s.side}: each venue's price over time against Pinnacle's fair. Information, not an edge.` : 'No saved prices for this game.',
      open: '?start=odds' };
  }
  if (kind === 'league') {
    const slug = cardStr(q.league, /^[a-z0-9]{2,12}$/);
    const cfg = slug && Object.prototype.hasOwnProperty.call(shareCards.LEAGUE_PAGES, slug) ? shareCards.LEAGUE_PAGES[slug] : null;
    if (!cfg) throw new V1Error(404, 'not_found', 'No such league page.');
    const lic = webhookLicence();
    // the sharer's state (My state): only its venues are counted and priced; none = every venue, as before
    const stCode = venues.stateOf(q.state) || null, inSt = stCode ? venues.legalIn(stCode) : () => true;
    let games = 0, markets = 0, withFair = 0, stale = false, at = null;
    const vs = new Set();
    for (const key of cfg.keys) {
      const s = oddsScreenFor({ league: key, kalshiOk: !!lic.kalshi });
      stale = s.stale; at = s.updated;
      for (const gm of s.games) {
        games++;
        for (const m of gm.markets) { markets++; if (m.sides.some(x => x.fair != null)) withFair++; for (const sd of m.sides) for (const v of sd.venues) if (!v.ref && inSt(v.venue)) vs.add(v.venue); }
      }
    }
    const bp = cfg.keys.map(k => v1.bestPrices({ league: k, limit: 200, ...(stCode ? { state: stCode } : {}) }));
    const rows = bp.flatMap(b => b.rows).sort((a, b) => (b.evPct ?? -1e9) - (a.evPct ?? -1e9));
    const stName = stCode ? venues.stateInfo(stCode).name : null;
    const d = { name: cfg.name, games, markets, withFair, venues: vs.size, aboveFair: rows.length, rows, at: at || new Date().toISOString(), stale: games ? stale : false, locked: bp.some(b => b.locked), esports: !!cfg.esports, stateName: stName };
    const pageQs = new URLSearchParams([...(stCode ? [['state', stCode]] : []), ...(fmt !== 'american' ? [['odds', fmt]] : [])]).toString();
    return { svg: shareCards.leagueCard(d, { origin, fmt }), at: d.at, title: `${cfg.name} odds: every venue beside Pinnacle's fair`,
      description: games ? `${games} game${games === 1 ? '' : 's'} in the next 48 hours, ${vs.size} venues${stName ? ` a ${stName} resident can use` : ''}, ${d.locked ? 'fair prices for subscribers' : `${rows.length} price${rows.length === 1 ? '' : 's'} above the fair (research, not a record)`}.` : `No ${cfg.name} games on the board right now.`,
      open: `${cfg.path}${pageQs ? `?${pageQs}` : ''}` };
  }
  if (kind === 'record') {
    const card = publicApi.recordCard(await v1.record({}));
    const p = card.proven;
    return { svg: shareCards.recordCardSvg(card, { origin }), at: card.at, title: 'Line Reaper: the public record',
      description: p.length ? `Proven on the strict rule: ${p.map(r => `${r.venueName} ${r.kindLabel || r.kind} (${r.graded} graded, CLV ${r.clvPct > 0 ? '+' : ''}${r.clvPct?.toFixed(1)}% vs the close${r.profitShown ? '' : ', profit not shown'})`).join('; ')}. ${card.notProven} other kinds are not proven.`
        : `Nothing is proven yet on the strict rule. ${card.notProven} kinds on the record are building or losing to the close.`,
      open: '?start=results' };
  }
  if (kind === 'alerts') {
    // the free view: an alert's bets count once their games start
    const v = await alertHistoryFor({ ...alertQueryOf({}), limit: 1, full: !PAYWALL });
    const s = v.summary;
    return { svg: shareCards.alertsCard(v, { origin }), at: v.at, title: 'Line Reaper: every alert we sent, graded',
      description: s.alerts ? `${s.alerts} alerts since ${String(v.startedAt).slice(0, 10)}, ${s.graded} bets graded against the close. Proven only where RESULTS proves it.` : 'Every alert is kept from the day storing began, graded against the close.',
      open: '/alerts', page: '/alerts' };
  }
  // digest
  const week = cardStr(q.week, /^\d{4}-\d{2}-\d{2}$/) || digest.dueWeek(Date.now());
  const out = digest.validWeek(week) ? await digestFor(week) : null;
  if (!out) throw new V1Error(404, 'not_found', 'That week has no digest.');
  return { svg: shareCards.digestCard(out.digest, { origin, frozen: out.frozen }), at: out.digest.builtAt, title: `Line Reaper record: week of ${out.digest.name}`,
    description: digest.pushText(out.digest).split('\n').slice(0, 2).join(' '), open: `/digest/${week}`, page: `/digest/${week}` };
}
// the card's own query string: only the keys its kind reads, in a fixed order
// odds: the sharer's odds format (oddsfmt.js); state: the sharer's My state, for a league's venues
const SHARE_KEYS = { price: ['id', 'odds'], move: ['game', 'market', 'side', 'i', 'odds'], league: ['league', 'state', 'odds'], record: [], digest: ['week'], alerts: [], leaderboard: ['league', 'window'] };
function shareQuery(kind, q) {
  const p = new URLSearchParams();
  for (const k of SHARE_KEYS[kind] || []) if (q[k] != null && q[k] !== '') p.set(k, String(q[k]).slice(0, 300));
  return p.toString();
}
// PNGs drawn in the last minute are served again (a pasted link is fetched by
// every app that previews it at once)
const shareImgMemo = new Map();
const shareStats = { drawn: 0, served: 0, errors: 0, lastError: null, png: null };
async function shareImage(kind, q, origin, ext) {
  const key = `${kind}|${shareQuery(kind, q)}|${origin}|${ext}|${v1FullTier() ? 1 : 0}`;
  const hit = shareImgMemo.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const c = await shareCardFor(kind, q, origin);
  let body = null, type = 'image/svg+xml';
  if (ext === 'png') { body = await shareCards.renderPng(c.svg); if (body) type = 'image/png'; }
  if (!body) body = Buffer.from(c.svg);
  shareStats.drawn++;
  const v = { body, type };
  if (shareImgMemo.size > 80) shareImgMemo.clear();
  shareImgMemo.set(key, { at: Date.now(), v });
  return v;
}
app.get('/card/:kind.:ext', widgetGate, async (req, res) => {
  const { kind, ext } = req.params;
  if (!(SHARE_KINDS.has(kind) || /^record-[a-z0-9_]{3,20}$/.test(kind)) || !/^(png|svg)$/.test(ext)) return res.status(404).type('text/plain').send('No such card. Cards: price, move, league, record, record-<handle>, leaderboard, digest, alerts (.png or .svg).');
  try {
    const img = await shareImage(kind, req.query, siteOrigin(req), ext);
    shareStats.served++;
    res.set({ 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' });
    if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="line-reaper-${kind}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${img.type === 'image/png' ? 'png' : 'svg'}"`);
    res.type(img.type).send(img.body);
  } catch (e) {
    if (!(e instanceof V1Error)) { shareStats.errors++; shareStats.lastError = e.message; console.warn('Share card:', e.message); }
    res.status(e instanceof V1Error ? e.status : 500).set('Cache-Control', 'no-store').type('text/plain').send(e instanceof V1Error ? e.message : 'This card could not be drawn. Try again in a minute.');
  }
});
// the image URL a preview reads: absolute, and new every 10 minutes so an app
// that keeps a preview for days shows a recent read when it fetches again
const shareImageUrl = (origin, kind, qs) => `${origin}/card/${kind}.png?${qs ? `${qs}&` : ''}v=${Math.floor(Date.now() / 600e3).toString(36)}`;
async function sendSharePage(req, res, kind, q) {
  try {
    const origin = siteOrigin(req), qs = shareQuery(kind, q);
    const c = await shareCardFor(kind, q, origin);
    const open = /^(#lr&|\?start=)/.test(String(q.to || '')) ? shareCards.safeOpen(q.to) : c.open.startsWith('/') ? c.open : shareCards.safeOpen(c.open);
    res.set({ 'Cache-Control': 'public, max-age=60' }).type('html').send(shareCards.sharePage({ title: c.title, description: c.description, image: shareImageUrl(origin, kind, qs),
      url: `${origin}${req.path}${qs ? `?${qs}` : ''}`, open, openLabel: kind === 'league' ? 'OPEN THE LEAGUE PAGE' : kind === 'digest' ? 'OPEN THE WEEK' : 'OPEN IN LINE REAPER',
      note: c.at ? `Read ${String(c.at).slice(0, 16).replace('T', ' ')} UTC.` : '' }));
  } catch (e) {
    res.status(e instanceof V1Error ? e.status : 500).set('Cache-Control', 'no-store').type('html')
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Line Reaper</title><body style="background:#080b10;color:#e2e8f0;font:16px system-ui;padding:24px">${learn.esc(e instanceof V1Error ? e.message : 'This card could not be drawn just now.')} <a style="color:#34d399" href="/app">Open the app</a>.</body>`);
  }
}
app.get('/share/:kind', widgetGate, (req, res) => {
  if (!SHARE_KINDS.has(req.params.kind)) return res.status(404).type('text/plain').send('No such share page.');
  return sendSharePage(req, res, req.params.kind, req.query);
});
// /results: the record's share page (the app's RESULTS tab is one tap away)
app.get('/results', widgetGate, (req, res) => sendSharePage(req, res, 'record', { to: '?start=results' }));


return {
  publicApi, embeds, shareCards, apiKeys, apiLimiter, v1Safe, v1FullTier, v1Str, v1State, v1, v1Fail,
  v1KeyOf, v1Limits, v1Auth, v1Route, v1LinesBody, widgetGate, shareImgMemo, shareImageUrl, V1Error
};
};
