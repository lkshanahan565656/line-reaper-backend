// ─── PUBLIC API v1: KEYS, RATE LIMITS, ETAGS AND THE SHAPES IT SERVES ────────
// GET /api/v1/* is a read-only, versioned copy of what the app shows, the same
// for every caller: best prices above the fair (with fill size), line moves
// and one game's line history, the strict RESULTS record and weekly digest,
// per-league boards and feed status. Nothing here places a bet, sizes a bet
// for someone, or takes per-user alert settings (CFTC 4.14(a)(9): the same
// information goes to everyone).
//
// Keys: anyone can make one on /developers (signed in or not). The key is
// shown once; only its SHA-256 is kept, so a key never sits in a store or a
// backup. Keys live in the same kind of store as the rest of the account data
// (Postgres with DATABASE_URL, else a file, carried across deploys by the
// results backup).
//
// Shapes are pure functions of what the server already built (shopper views,
// the odds screen, the close scoreboard's public record), so tests run them on
// fixtures and the /developers page shows them on live data.

const crypto = require('crypto');

const VERSION = 'v1';
const LIMITS = { perMinute: 60, perDay: 5000 };
const WIDGET_PER_MINUTE = 120;
const KEY_CREATE = { perHour: 5, max: 20000 };
const FEED_HANDLES = 10;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

// ── keys ──
// store: { init(), all(), put(doc) }. doc: { id, hash, name, userId, createdAt, revokedAt }
function createKeyStore({ store, now = () => Date.now(), random = n => crypto.randomBytes(n) } = {}) {
  const byHash = new Map();
  const created = new Map();   // who → [times], for the per-hour cap on new keys
  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        await store.init?.();
        for (const d of await store.all()) if (d && d.hash && d.id) byHash.set(d.hash, d);
      })();
    }
    return ready;
  }
  // who: a hashed caller address (never stored), for the per-hour cap
  async function create({ name = '', userId = null, who = '' } = {}) {
    await init();
    const t = now();
    const recent = (created.get(who) || []).filter(x => t - x < 3600e3);
    if (recent.length >= KEY_CREATE.perHour) { const e = new Error(`At most ${KEY_CREATE.perHour} new keys an hour from one address. Try again later.`); e.status = 429; e.retryAfter = Math.ceil((recent[0] + 3600e3 - t) / 1000); throw e; }
    if (byHash.size >= KEY_CREATE.max) { const e = new Error('No new keys can be made right now.'); e.status = 503; throw e; }
    const key = `lr_${random(24).toString('base64url')}`;
    const doc = { id: `k_${random(6).toString('hex')}`, hash: sha256(key), name: cleanName(name) || 'unnamed key', userId: userId || null, createdAt: new Date(t).toISOString(), revokedAt: null, status: 'active' };
    byHash.set(doc.hash, doc);
    created.set(who, [...recent, t]);
    if (created.size > 5000) created.clear();
    await store.put(doc);
    return { key, ...publicKey(doc) };
  }
  // the key's record, or null (unknown or revoked)
  function check(key) {
    if (typeof key !== 'string' || !/^lr_[\w-]{20,64}$/.test(key)) return null;
    const d = byHash.get(sha256(key));
    return d && !d.revokedAt ? d : null;
  }
  async function revoke(key) {
    await init();
    const d = check(key);
    if (!d) return null;
    const out = { ...d, revokedAt: new Date(now()).toISOString(), status: 'revoked', feed: null, bot: null, tgBot: null };
    byHash.set(d.hash, out);
    await store.put(out);
    return publicKey(out);
  }
  const listFor = userId => (userId ? [...byHash.values()].filter(d => d.userId === userId).map(publicKey) : []);
  const stats = () => ({ keys: [...byHash.values()].filter(d => !d.revokedAt).length, revoked: [...byHash.values()].filter(d => d.revokedAt).length,
    feeds: [...byHash.values()].filter(d => !d.revokedAt && d.feed && !d.feed.deadAt).length,
    bots: [...byHash.values()].filter(d => !d.revokedAt && d.bot).length,
    telegramBots: [...byHash.values()].filter(d => !d.revokedAt && d.tgBot).length });
  // ── the Discord feed a key's owner connected (outfeed.js): one webhook per
  // key, kept sealed (the caller seals it), dropped with the key on revoke ──
  async function setFeed(key, feed) {
    await init();
    const d = check(key);
    if (!d) return null;
    const out = { ...d, feed: feed || null };
    byHash.set(d.hash, out);
    await store.put(out);
    return out;
  }
  // the bettor records a key's feed also gets (pubrecord.js handles, at most
  // FEED_HANDLES) and whether it keeps the RESULTS posts too
  async function setFeedRecords(key, { handles = [], results = true } = {}) {
    await init();
    const d = check(key);
    if (!d || !d.feed) return null;
    const out = { ...d, feed: { ...d.feed, handles: [...new Set(handles)].slice(0, FEED_HANDLES), results: results !== false } };
    byHash.set(d.hash, out);
    await store.put(out);
    return out;
  }
  // every live key's feed subscribed to one handle: [{ keyId, feed }]
  const feedsFor = handle => feeds().filter(x => (x.feed.handles || []).includes(handle));
  // every live key's feed: [{ keyId, feed }]
  const feeds = () => [...byHash.values()].filter(d => !d.revokedAt && d.feed && !d.feed.deadAt).map(d => ({ keyId: d.id, feed: d.feed, userId: d.userId || null }));
  // after a send: ok resets the failure count; dead (or 5 fails in a row) retires the feed
  async function markFeed(keyId, r) {
    const d = [...byHash.values()].find(x => x.id === keyId);
    if (!d || !d.feed) return null;
    const t = new Date(now()).toISOString();
    const fails = r.ok ? 0 : (d.feed.fails || 0) + 1;
    const feed = { ...d.feed, fails, lastOkAt: r.ok ? t : d.feed.lastOkAt || null, lastFailAt: r.ok ? d.feed.lastFailAt || null : t,
      lastError: r.ok ? null : String(r.why || '').slice(0, 160), deadAt: !r.ok && (r.dead || fails >= 5) ? t : null };
    const out = { ...d, feed };
    byHash.set(d.hash, out);
    await store.put(out);
    return feed;
  }
  // ── the Discord app a key's owner connected for slash commands
  // (discordbot.js): { appId, publicKey, addedAt }; the public key is public,
  // the bot token is never kept. One app per key, dropped on revoke ──
  async function setBot(key, bot) {
    await init();
    const d = check(key);
    if (!d) return null;
    const out = { ...d, bot: bot || null };
    byHash.set(d.hash, out);
    await store.put(out);
    return out;
  }
  // the live key that connected this app id, or null
  const botFor = appId => [...byHash.values()].find(d => !d.revokedAt && d.bot && d.bot.appId === String(appId)) || null;
  const bots = () => [...byHash.values()].filter(d => !d.revokedAt && d.bot).map(d => ({ keyId: d.id, bot: d.bot }));
  async function markBot(keyId, patch) {
    const d = [...byHash.values()].find(x => x.id === keyId);
    if (!d || !d.bot) return null;
    const out = { ...d, bot: { ...d.bot, ...patch } };
    byHash.set(d.hash, out);
    await store.put(out);
    return out.bot;
  }
  // ── the Telegram bot a key's owner connected for commands (telegrambot.js):
  // { botId, username, sealed, addedAt }; the token is kept sealed (the caller
  // seals it) because each answer is sent with it. One bot per key, dropped on revoke ──
  async function setTgBot(key, bot) {
    await init();
    const d = check(key);
    if (!d) return null;
    const out = { ...d, tgBot: bot || null };
    byHash.set(d.hash, out);
    await store.put(out);
    return out;
  }
  const tgBotFor = botId => [...byHash.values()].find(d => !d.revokedAt && d.tgBot && d.tgBot.botId === String(botId)) || null;
  const tgBots = () => [...byHash.values()].filter(d => !d.revokedAt && d.tgBot).map(d => ({ keyId: d.id, tgBot: d.tgBot }));
  async function markTgBot(keyId, patch) {
    const d = [...byHash.values()].find(x => x.id === keyId);
    if (!d || !d.tgBot) return null;
    const out = { ...d, tgBot: { ...d.tgBot, ...patch } };
    byHash.set(d.hash, out);
    await store.put(out);
    return out.tgBot;
  }
  return { init, create, check, revoke, listFor, stats, setFeed, setFeedRecords, feeds, feedsFor, markFeed, setBot, botFor, bots, markBot, setTgBot, tgBotFor, tgBots, markTgBot };
}
const publicKey = d => ({ id: d.id, name: d.name, createdAt: d.createdAt, revokedAt: d.revokedAt || null, signedIn: !!d.userId });

// ── rate limits: fixed windows, a minute and a UTC day, per key (or per address for widgets) ──
function createLimiter({ perMinute: perMinuteDefault = LIMITS.perMinute, perDay: perDayDefault = LIMITS.perDay, now = () => Date.now() } = {}) {
  const used = new Map();   // id → { m, mn, d, dn }
  // lim: this caller's plan limits ({ perMinute, perDay }), else the limiter's own
  function take(id, lim = null) {
    const perMinute = lim?.perMinute ?? perMinuteDefault, perDay = lim?.perDay ?? perDayDefault;
    const t = now();
    const m = Math.floor(t / 60e3), d = Math.floor(t / 86400e3);
    let u = used.get(id);
    if (!u) { if (used.size > 50000) used.clear(); u = { m, mn: 0, d, dn: 0 }; used.set(id, u); }
    if (u.m !== m) { u.m = m; u.mn = 0; }
    if (u.d !== d) { u.d = d; u.dn = 0; }
    const resetMin = Math.ceil(((m + 1) * 60e3 - t) / 1000), resetDay = Math.ceil(((d + 1) * 86400e3 - t) / 1000);
    const over = u.mn >= perMinute ? 'minute' : perDay && u.dn >= perDay ? 'day' : null;
    if (!over) { u.mn++; u.dn++; }
    return { ok: !over, over, limit: perMinute, remaining: Math.max(0, perMinute - u.mn), reset: resetMin,
      dayLimit: perDay || null, dayRemaining: perDay ? Math.max(0, perDay - u.dn) : null, retryAfter: over === 'day' ? resetDay : resetMin };
  }
  const usage = id => { const u = used.get(id); const t = now(); return { minute: u && u.m === Math.floor(t / 60e3) ? u.mn : 0, today: u && u.d === Math.floor(t / 86400e3) ? u.dn : 0 }; };
  return { take, usage };
}
function limitHeaders(res, r) {
  res.set({ 'X-RateLimit-Limit': String(r.limit), 'X-RateLimit-Remaining': String(r.remaining), 'X-RateLimit-Reset': String(r.reset) });
  if (r.dayLimit) res.set({ 'X-RateLimit-Daily-Limit': String(r.dayLimit), 'X-RateLimit-Daily-Remaining': String(r.dayRemaining) });
  if (!r.ok) res.set('Retry-After', String(r.retryAfter));
}
// The caller's address: the last X-Forwarded-For hop is the one Railway's proxy
// added (the earlier ones are whatever the client sent). Hashed, never stored.
function callerOf(req) {
  const xf = String(req.get?.('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
  return sha256(`lr-caller|${xf[xf.length - 1] || req.ip || req.socket?.remoteAddress || ''}`).slice(0, 24);
}

// ── ETag: a hash of the body; If-None-Match with it answers 304, no body ──
// A weak tag: the top-level `at` (when this answer was made) is left out of
// the hash, so an answer whose data has not changed keeps its tag.
function etagOf(body) { return `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"`; }
function sendCached(req, res, body, { type = 'application/json; charset=utf-8', maxAge = 15, scope = 'private' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const tag = typeof body === 'string' || !body || Array.isArray(body) || !('at' in body) ? etagOf(text) : etagOf(JSON.stringify({ ...body, at: undefined }));
  res.set({ ETag: tag, 'Cache-Control': `${scope}, max-age=${maxAge}` });
  const inm = String(req.get?.('if-none-match') || '');
  if (inm && inm.split(',').map(s => s.trim()).some(x => x === tag || x === '*' || x.replace(/^W\//, '') === tag.replace(/^W\//, ''))) return res.status(304).end();
  return res.status(200).type(type).send(text);
}

// ── shapes ──
const EXCHANGES = new Set(['kalshi', 'polymarketus', 'gemini', 'matchbook']);
// what a price fills: an exchange's book read (largest of $50/$200/$1,000 it
// takes whole, after the fee) or why there is no number. Never a guess.
function fillOf(provider, z) {
  if (!EXCHANGES.has(provider)) return { status: 'not published', note: 'Sportsbooks do not publish limits.' };
  if (!z) return { status: 'unknown', note: 'No book read for this price.' };
  if (z.unread) return { status: 'unread', note: 'Order book not read in the last 5 minutes.' };
  if (z.empty) return { status: 'empty', fillsUsd: 0, note: 'Nothing on the book at this price.' };
  const top = [1000, 200, 50].find(t => z.tiers?.[t]?.full) || 0;
  return { status: 'read', fillsUsd: top, topUsd: z.topUsd ?? null, depthUsd: z.depthUsd ?? null, atFairUsd: z.atFairUsd ?? null, ageSec: z.ageSec ?? null };
}
// The label a best-price row wears, as the app's shopper tags it: PROVEN only
// where the close scoreboard proves that venue's main lines (and only on a
// main line); everything else is a LEAD, which is research.
function priceLabel(o) {
  const proven = o.rank?.label === 'proven' && o.marketType !== 'player_prop' && !o.oneWay;
  return proven
    ? { label: 'proven', labelText: `PROVEN: ${o.providerName || o.provider} main lines are proven against Pinnacle's close on RESULTS. This row is one price, not a result.` }
    : { label: 'lead', labelText: 'LEAD: research, not a proven edge. A price above the fair has not beaten the close at this venue yet.' };
}
// view: shopper.build() output (full, not stripped)
function bestPrices(view, { limit = 50 } = {}) {
  return (view.opportunities || []).slice(0, limit).map(o => ({
    id: o.key, market: o.market, event: o.event, sport: o.sport, league: o.league, start: o.start,
    marketType: o.marketType, marketName: o.marketName, line: o.line ?? null, player: o.player || null, selection: o.selection,
    venue: o.provider, venueName: o.providerName,
    price: { american: o.american ?? null, decimalAfterFees: r4(o.effective) },
    fair: { prob: r4(o.fair), american: o.fairAmerican ?? null, source: o.fairSource || null },
    evPct: o.ev == null ? null : r2(o.ev * 100), edgePts: r2(o.edgePts),
    secondBest: o.second ? { venue: o.second.provider, venueName: o.second.name, american: o.second.american ?? null, decimalAfterFees: r4(o.second.effective) } : null,
    fill: fillOf(o.provider, o.size), access: o.access, altLine: !!o.oneWay, freshness: o.freshness || null,
    confidence: o.rank?.confidence ?? null, ...priceLabel(o),
  }));
}
// one odds-screen game (oddsscreen.build) → its markets with every venue's price
function boardGame(g, { withFair = true } = {}) {
  return {
    id: g.id, league: g.league, leagueLabel: g.leagueLabel, start: g.start, home: g.home, away: g.away, venues: g.venues,
    markets: g.markets.map(m => ({ market: m.key, label: m.label, point: m.point ?? null, bestHold: m.bestHold ?? null,
      sides: m.sides.map(s => ({ side: s.name, label: s.label, fair: withFair ? { prob: s.fair ?? null, american: s.fairAmerican ?? null } : null,
        best: s.best ? { venue: s.best.venue, venueName: s.best.name, american: s.best.american, evPct: withFair && s.best.ev != null ? r2(s.best.ev * 100) : null } : null,
        prices: s.venues.map(v => ({ venue: v.venue, venueName: v.name, american: v.american, decimal: v.decimal, point: v.point, lineDiffers: !!v.lineDiffers,
          reference: !!v.ref, secondHand: !!v.secondHand, url: v.url || null })) })) })),
  };
}
function moveRow(r) {
  return { id: r.id, kind: r.kind, type: r.type, league: r.league, leagueLabel: r.leagueLabel || null, gameId: r.gameId || null, event: r.event, start: r.start,
    market: r.market || null, marketLabel: r.marketLabel || null, side: r.side, venue: r.venue, venueName: r.venueName, from: r.from, to: r.to, move: r.move,
    unit: r.type === 'line' ? 'points' : 'percentage points of win chance', since: r.since, now: r.now ?? null,
    followers: (r.followers || []).map(f => ({ venue: f.venue, venueName: f.name, status: f.status || null, american: f.american ?? null, point: f.point ?? null })) };
}
// oddsHistory.forGame(id) → per market and side: [{ t, point, fair, prices }]
function historySeries(series, { withFair = true } = {}) {
  return series.map(x => ({ id: x.id, market: x.market, side: x.label, start: x.start,
    points: x.pts.map(([t, point, fair, px]) => ({ t: new Date(t).toISOString(), point: point ?? null, fair: withFair ? fair ?? null : null, prices: px })) }));
}
// the proven-record card: only what RESULTS marks proven, profit only where it says so
function recordCard(rec) {
  const proven = (rec.rows || []).filter(r => r.label === 'proven').map(r => ({
    kind: r.kind, kindLabel: r.kindLabel, venue: r.book, venueName: r.bookName, graded: r.graded, clvPct: r.clv, clvT: r.clvT, beatPct: r.beatPct,
    wins: r.wins, losses: r.losses, profitShown: !!r.profitShown, units: r.profitShown ? r.units : null, texas: !!r.texas,
  }));
  const others = (rec.rows || []).filter(r => r.label !== 'proven');
  return { at: rec.at, rule: rec.rule?.text || null, proven, notProven: others.length,
    building: others.filter(r => r.label === 'building' || r.label === 'too early').length,
    losing: others.filter(r => r.label === 'losing to the close').length };
}

// ── the endpoint list (the /developers page and GET /api/v1 read it) ──
const ENDPOINTS = [
  { path: '/api/v1/best-prices', title: 'Best prices above the fair', params: [['league', 'one league key, e.g. nfl, nba, nhl, ncaaf'], ['market', 'moneyline, spread, total or player_prop (comma list)'], ['venue', 'only this venue (e.g. kalshi, betrivers)'], ['minEv', 'minimum EV in percent after fees, default 0'], ['minSize', 'dollars every exchange price must fill, fee in'], ['hours', 'games starting within this many hours (default 48)'], ['state', 'two-letter US state code, e.g. TX: only venues a source says a resident can use'], ['limit', '1 to 200, default 50']],
    about: "Each side's best bettable price that sits above Pinnacle's no-vig fair, after the venue's fee, with the second-best price, what an exchange book fills, and the label the app gives it (PROVEN or LEAD)." },
  { path: '/api/v1/moves', title: 'Biggest line moves', params: [['window', 'open (since first seen), 3h or 1h'], ['type', 'price or line'], ['league', 'one league key'], ['kind', 'game or prop'], ['limit', '1 to 200, default 50']],
    about: "Today's largest moves at each venue since we first saw the market, and whether every other venue followed. Information, not an edge." },
  { path: '/api/v1/moves/{gameId}', title: "One game's line history", params: [['market', 'ml, spread or total (all when left out)']],
    about: "Every side's fair and each venue's price over time, a point when anything moved (at most every 4 minutes) or every 30 minutes. Kept 30 days after the start (thinned to the biggest moves once a game is 6 hours past its start)." },
  { path: '/api/v1/lines', title: 'Line history: every market kept', params: [['q', 'team or player search'], ['league', 'one league key'], ['kind', 'game or prop'], ['before', 'an ISO start time: older markets (paging)'], ['limit', '1 to 500, default 100']],
    about: "Every game line and player prop we keep, on the board now or closed in the last 30 days (Free keys: the last 3 days once the paywall is on), with when we first and last read it and links to its history." },
  { path: '/api/v1/lines/game/{gameId}', title: "One game's line history (CSV or JSON)", params: [['market', 'ml, spread or total (all when left out)'], ['format', 'json (default) or csv']],
    about: "Each side's price at every venue we read, Pinnacle included, over time, with the fair where shown. CSV has one row per read and venue: time_utc, event, league, market, side, line, venue, american, decimal, implied_prob, fair_prob. Only reads we made; a market older than 6 hours past its start is thinned to its biggest moves." },
  { path: '/api/v1/lines/prop', title: "One prop's line history (CSV or JSON)", params: [['key', 'the market key from /api/v1/lines?kind=prop'], ['format', 'json (default) or csv']],
    about: 'Over and Under at every venue that priced the prop (books, exchanges and pick\'em apps), over time, in the same columns as a game.' },
  { path: '/api/v1/leagues', title: 'Leagues on the board', params: [], about: 'Every league with games in the next 48 hours, and how many.' },
  { path: '/api/v1/leagues/{league}', title: "A league's board", params: [['q', 'team name search'], ['state', 'two-letter US state code, e.g. TX: only venues a source says a resident can use']], about: "Every game in the league in the next 48 hours: moneyline, spread and total, each venue's price, the fair and the best price." },
  { path: '/api/v1/record', title: 'The public record (RESULTS)', params: [['days', 'only flags from the last N days'], ['state', 'two-letter US state code, e.g. TX: only venues a source says a resident can use']], about: 'Every kind and venue on the close scoreboard with its label: proven only on the strict rule, everything else says why not.' },
  { path: '/api/v1/record/flags', title: 'Every closed flag behind the record', params: [['days', 'last N days'], ['kind', 'one kind, e.g. ev'], ['book', 'one venue'], ['limit', '1 to 1000, default 200'], ['offset', 'rows to skip']], about: 'One row per closed flag: when, the price, what it filled, the close, CLV and the result.' },
  { path: '/api/v1/leaderboard', title: 'Bettor leaderboard (CLV vs Pinnacle)', params: [['league', 'one league code, e.g. NBA, NFL, CFB, LOL'], ['window', '7d, 30d or all (default)'], ['state', 'two-letter US state code (default TX): each row says whether that app or venue is confirmed there'], ['venues', 'mine: only apps and venues confirmed in that state']], about: "Published bettor records ranked by the low end of the 95% interval of their average CLV against Pinnacle's no-vig close, one app or venue at a time. Ranked only at 50 graded picks logged before the start; under that a row is building with no rank. The label is the record's own; no profit or units." },
  { path: '/api/v1/states', title: 'States and their venues', params: [], about: 'Every US state and DC with how many venues a resident can use there, and the date the table was read.' },
  { path: '/api/v1/states/{state}', title: "One state's venues", params: [], about: 'The venues legal there, the ones no source vouches for (check with the venue) and the ones not legal there, each with its source and date.' },
  { path: '/api/v1/digest', title: 'Weekly digest: the weeks', params: [], about: 'The weeks the digest covers, which are frozen (sent Monday 13:00 UTC) and which are still being built.' },
  { path: '/api/v1/digest/{week}', title: 'Weekly digest: one week', params: [], about: "One week (the date of its Monday): what graded, the move toward the 50 bar, and what became proven or started losing to the close." },
  { path: '/api/v1/alerts', title: 'Alert history', params: [['days', 'last N days'], ['kind', 'one push kind: ev, sharp, exchange, tail, esports, gas or other'], ['limit', '1 to 500, default 100'], ['before', 'an ISO time: older alerts (paging)']],
    about: "Every alert the site sent since it began storing them, with the time, the text, how many phones and webhooks it reached, and each bet it named graded like RESULTS: CLV at the alert's price, Pinnacle's own close where kept, the result and the RESULTS label. With the paywall on, an alert's bets show once their games start." },
  { path: '/api/v1/search', title: 'Search', params: [['q', 'a team, player, league, market or esports series (2+ letters)'], ['kind', 'game, series, player, market or league (comma list)'], ['state', 'two-letter US state code, e.g. TX: best prices only at venues a source says a resident can use'], ['limit', '1 to 60, default 30']],
    about: "What the app's SEARCH box finds, from what the site holds now: games with each side's best bettable price, esports series with the cost to buy each side, players and their props, markets and leagues. No fair or EV." },
  { path: '/api/v1/status', title: 'Feed status', params: [], about: "Every venue's last good read, staleness and uptime, the same as /status." },
  { path: '/api/v1/records/{handle}', title: "A bettor's public record", params: [],
    about: "One published bettor record (/r/<handle>) as the record widget shows it: picks logged before their start, each app and venue against Pinnacle's close with its label (proven only on the strict rule, never pooled), picks logged late counted apart. No units or profit." },
  { path: '/api/v1/key', title: 'This key', params: [], about: "Your key's name, when it was made and what it has used this minute and today." },
];

module.exports = { FEED_HANDLES, VERSION, LIMITS, WIDGET_PER_MINUTE, KEY_CREATE, ENDPOINTS, EXCHANGES, sha256, createKeyStore, createLimiter, limitHeaders, callerOf, etagOf, sendCached,
  fillOf, priceLabel, bestPrices, boardGame, moveRow, historySeries, recordCard, publicKey, cleanName };
