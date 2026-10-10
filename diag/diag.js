// One-off diagnostics: how Kalshi, Polymarket and Polymarket US games pair.
// Prints compact JSON sections between ==== markers.
const axios = require('axios');
const xarb = require('../xarb');
const pmus = require('../pmus');

const gaps = { 'api.elections.kalshi.com': 80, 'gamma-api.polymarket.com': 120, 'gateway.polymarket.us': 80, 'docs.polymarket.us': 0 };
const last = {};
const http = {
  async get(url, opts = {}) {
    const host = new URL(url).host;
    const wait = (last[host] || 0) + (gaps[host] ?? 100) - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last[host] = Date.now();
    for (let i = 0; ; i++) {
      try { return await axios.get(url, { timeout: 20000, ...opts }); }
      catch (e) {
        if (e?.response?.status === 429 && i < 4) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        throw e;
      }
    }
  },
};
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const countBy = (xs, f) => { const o = {}; for (const x of xs) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
const NOW = Date.now();

async function main() {
  // docs: list endpoints
  try {
    const d = await http.get('https://docs.polymarket.us/llms.txt');
    out('pmus-docs', String(d.data).split('\n').filter(l => /events|markets|series|sports|GET|list/i.test(l)).slice(0, 80));
  } catch (e) { out('pmus-docs-error', e.message); }

  // Kalshi: every game series
  const series = await xarb.fetchKalshiGameSeries(http).catch(e => { out('kalshi-series-error', e.message); return xarb.SEED_GAME_SERIES; });
  const kalshi = [];
  const perSeries = {};
  for (const s of series) {
    const r = await xarb.fetchKalshiEvents(http, { seriesTicker: s, maxPages: 5, onPage: page => { const rows = xarb.parseKalshiBinaries(page); perSeries[s] = (perSeries[s] || 0) + rows.length; kalshi.push(...rows); } });
    if (r.errors.length) perSeries[s] = `err ${r.errors[0].message}`;
  }
  out('kalshi-series', { series: series.length, withRows: Object.values(perSeries).filter(n => n > 0).length, rows: kalshi.length });
  out('kalshi-kinds', countBy(kalshi, r => `${r.league || r.category}|${r.kind}`));

  // Polymarket: the scan's volume-ordered list, and games by tag in a window
  const polyVol = [];
  const pv = await xarb.fetchPolymarketEvents(http, { onPage: page => polyVol.push(...xarb.parsePolymarketBinaries(page, { now: NOW })) });
  out('poly-volume', { events: pv.count, pages: pv.pages, rows: polyVol.length, teams: polyVol.filter(r => r.kind === 'teams').length, kinds: countBy(polyVol.filter(r => r.category === 'sports'), r => `${r.league}|${r.kind}`) });

  const polyGames = [];
  let gEvents = 0, gPages = 0, slugsPerPrefix = {};
  const min = new Date(NOW - 6 * 3600e3).toISOString(), max = new Date(NOW + 48 * 3600e3).toISOString();
  for (let offset = 0; gPages < 40; offset += 100) {
    const res = await http.get('https://gamma-api.polymarket.com/events', { params: { tag_id: 100639, closed: false, end_date_min: min, end_date_max: max, order: 'endDate', ascending: true, limit: 100, offset } });
    const page = Array.isArray(res.data) ? res.data : [];
    gPages++; gEvents += page.length;
    for (const e of page) { const p = String(e.slug || '').split('-')[0]; slugsPerPrefix[p] = (slugsPerPrefix[p] || 0) + 1; }
    polyGames.push(...xarb.parsePolymarketBinaries(page, { now: NOW }));
    if (page.length < 100) break;
  }
  out('poly-games', { events: gEvents, pages: gPages, rows: polyGames.length, teams: polyGames.filter(r => r.kind === 'teams').length,
    prefixes: Object.entries(slugsPerPrefix).sort((a, b) => b[1] - a[1]).slice(0, 60), kinds: countBy(polyGames.filter(r => r.category === 'sports'), r => `${r.league}|${r.kind}`) });

  for (const [name, poly] of [['volume', polyVol], ['games', polyGames]]) {
    const matches = xarb.matchMarkets(kalshi, poly, { now: NOW });
    out(`matches-${name}`, { total: matches.length, by: countBy(matches, m => m.by), byLeague: countBy(matches.filter(m => m.by !== 'title'), m => `${m.kalshi.league}|${m.by}`) });
  }

  // unmatched two-team games in the big leagues, with Kalshi's games the same day
  const matches = xarb.matchMarkets(kalshi, polyGames, { now: NOW });
  const matchedP = new Set(matches.map(m => m.polymarket.gameSlug));
  const kTeams = kalshi.filter(r => r.kind === 'teams' && !r.hasDraw);
  const samples = {};
  for (const p of polyGames.filter(r => r.kind === 'teams' && !matchedP.has(r.gameSlug))) {
    const L = p.league || p.gameSlug.split('-')[0];
    (samples[L] ||= []);
    if (samples[L].length >= 8) continue;
    const t = Date.parse(p.startTime || p.closeTime);
    const near = kTeams.filter(k => (!k.league || !p.league || k.league === p.league))
      .map(k => ({ k, d: Math.abs((Date.parse(k.startTime || '') || Date.parse(k.closeTime || '') || 0) - t) }))
      .sort((a, b) => a.d - b.d).slice(0, 3)
      .map(({ k, d }) => `${k.id} [${k.outcomeLabel} | ${k.noLabel}] start=${k.startTime} exp=${k.expectedExpiration} dh=${Math.round(d / 36e5)}`);
    samples[L].push({ slug: p.gameSlug, teams: [p.outcomeLabel, p.noLabel], start: p.startTime, close: p.closeTime, league: p.league, near });
  }
  out('unmatched-samples', samples);
  out('kalshi-teams-sample', Object.fromEntries(Object.entries(countBy(kTeams, r => r.league || 'none')).map(([L]) => [L, kTeams.filter(r => (r.league || 'none') === L).slice(0, 4).map(r => `${r.id} [${r.outcomeLabel} | ${r.noLabel}] start=${r.startTime} day=${r.gameDay}`)])));

  // Polymarket US: which game slugs exist there, and does matchBet find each bet
  const slugs = [...new Set(polyGames.filter(r => ['teams', 'total', 'spread'].includes(r.kind)).map(r => r.gameSlug))];
  const us = pmus.createPolymarketUs({ http, log: null });
  const found = {}, kinds = {}, rawByKind = {};
  let hits = 0, tried = 0, rawEvent = null;
  const missesBy = {};
  for (const slug of slugs.slice(0, 400)) {
    let ev = null;
    try {
      const res = await http.get(`${pmus.GATEWAY}/v1/events/slug/${encodeURIComponent(slug)}`);
      ev = pmus.parseEvent(res.data);
      if (!rawEvent && ev && ev.markets.length) rawEvent = res.data;
      for (const m of (res.data?.event || res.data)?.markets || []) {
        const k = String(m.sportsMarketType || m.marketType || 'none');
        kinds[k] = (kinds[k] || 0) + 1;
        if (!rawByKind[k]) rawByKind[k] = m;
      }
    } catch (e) { if (e?.response?.status !== 404) found[`err:${e.message}`] = (found[`err:${e.message}`] || 0) + 1; }
    const L = slug.split('-')[0];
    found[`${L}|${ev ? 'yes' : 'no'}`] = (found[`${L}|${ev ? 'yes' : 'no'}`] || 0) + 1;
    if (!ev) continue;
    for (const r of polyGames.filter(x => x.gameSlug === slug && ['teams', 'total', 'spread'].includes(x.kind))) {
      const bet = r.kind === 'teams' ? { kind: 'moneyline', team: r.outcomeLabel, teams: [r.outcomeLabel, r.noLabel] }
        : r.kind === 'total' ? { kind: 'total', over: true, line: r.line }
        : { kind: 'spread', team: r.lineTeam, line: -r.line, teams: [r.outcomeLabel, r.noLabel] };
      tried++;
      const hit = pmus.matchBet(ev, bet);
      if (hit) hits++;
      else { const k = `${L}|${r.kind}`; (missesBy[k] ||= []); if (missesBy[k].length < 4) missesBy[k].push({ q: r.title, bet, us: ev.markets.filter(m => m.kind === bet.kind).slice(0, 4).map(m => ({ slug: m.slug, line: m.line, long: m.long, short: m.short, open: m.open })) }); }
    }
  }
  out('pmus-found', { slugs: slugs.length, checked: Math.min(400, slugs.length), found, tried, hits });
  out('pmus-kinds', kinds);
  out('pmus-misses', missesBy);
  const trim = m => JSON.parse(JSON.stringify(m, (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v)));
  out('pmus-raw-market-by-kind', Object.fromEntries(Object.entries(rawByKind).slice(0, 12).map(([k, m]) => [k, trim(m)])));
  if (rawEvent) { const e = rawEvent.event || rawEvent; out('pmus-raw-event-keys', { keys: Object.keys(e), sample: trim({ ...e, markets: undefined }) }); }

  // one book, raw
  const anyMarket = Object.values(rawByKind)[0];
  if (anyMarket?.slug) {
    try { const b = await http.get(`${pmus.GATEWAY}/v1/markets/${encodeURIComponent(anyMarket.slug)}/book`); out('pmus-raw-book', trim(b.data)); }
    catch (e) { out('pmus-book-error', e.message); }
  }
  // list endpoints, if any
  for (const path of ['/v1/events?limit=5', '/v1/events?active=true&limit=5', '/v1/markets?limit=5', '/v1/sports', '/v1/series?limit=5']) {
    try { const r = await http.get(pmus.GATEWAY + path); const d = r.data; out(`pmus-list ${path}`, { status: r.status, keys: d && typeof d === 'object' ? Object.keys(d) : typeof d, n: Array.isArray(d) ? d.length : Array.isArray(d?.events) ? d.events.length : Array.isArray(d?.markets) ? d.markets.length : null, first: trim(Array.isArray(d) ? d[0] : d?.events?.[0] || d?.markets?.[0] || d?.sports?.[0] || null) }); }
    catch (e) { out(`pmus-list ${path}`, { error: e.message, status: e?.response?.status }); }
  }
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
