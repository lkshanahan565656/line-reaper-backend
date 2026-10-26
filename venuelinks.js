// ─── TAP TO VENUE: WHERE EACH PRICED ROW OPENS ───────────────────────────────
// Every priced row in the app carries a link to the venue that offers it.
// The link is plain navigation: no stake, no prefilled slip, no copy to the
// clipboard, no bet placed, and the same link for everyone.
//
// Exact links, where the venue has a public page per market:
//   Kalshi          kalshi.com/markets/<event ticker>, from a market or event
//                   ticker (KXNFLSPREAD-26OCT25NYGHOU-HOU18 → the event
//                   kxnflspread-26oct25nyghou), the same URL the server's
//                   exchange readers have always written
//   Polymarket US   polymarket.us/sports/<league>/<event slug>, from a market
//                   slug (aec-nfl-lar-lv-2026-10-25 → nfl-lar-lv-2026-10-25),
//                   the page pmus.js links. Never polymarket.com: that is the
//                   international site, closed to US users.
// Board links, where a venue has no public per-market or per-player page we
// can build (labelled so, the player and line are shown beside it):
//   Gemini          exchange.gemini.com/predictions
//   PrizePicks      app.prizepicks.com
//   Underdog        underdogfantasy.com/pick-em/higher-lower/all
//   Sleeper         sleeper.com (Picks lives in its app)
//   DK Pick6        pick6.draftkings.com/?sport=<league>
//   sportsbooks     each book's sportsbook home page
// Pinnacle and Matchbook are reference prices, not places to bet: no link.
//
// A URL handed in by the server is used only when its host belongs to the
// venue; anything else is rebuilt from the ids or falls back to the board.
//
// Runs in Node (tests, server) and in the browser (inlined into /app as
// window.LRVenue). Pure functions, plus a small tap counter for the server.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRVenue = factory();
}(/** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // venue key → { name, short label, hosts it may link to, board URL }
  const VENUES = {
    kalshi: { name: 'Kalshi', short: 'KALSHI', hosts: ['kalshi.com'], board: () => 'https://kalshi.com/' },
    polymarketus: { name: 'Polymarket US', short: 'PM US', hosts: ['polymarket.us'],
      board: c => { const l = PMUS_LEAGUE_OF[c.league] || c.league; return l && PMUS_LEAGUES.has(l) ? `https://polymarket.us/sports/${l}` : 'https://polymarket.us/'; } },
    gemini: { name: 'Gemini', short: 'GEMINI', hosts: ['gemini.com'], board: () => 'https://exchange.gemini.com/predictions' },
    prizepicks: { name: 'PrizePicks', short: 'PP', hosts: ['prizepicks.com'], board: () => 'https://app.prizepicks.com/' },
    underdog: { name: 'Underdog', short: 'UD', hosts: ['underdogfantasy.com'], board: () => 'https://underdogfantasy.com/pick-em/higher-lower/all' },
    sleeper: { name: 'Sleeper', short: 'SLEEPER', hosts: ['sleeper.com', 'sleeper.app'], board: () => 'https://sleeper.com/' },
    pick6: { name: 'DK Pick6', short: 'PICK6', hosts: ['pick6.draftkings.com'],
      board: c => (c.league && /^[A-Za-z0-9]{2,10}$/.test(c.league) ? `https://pick6.draftkings.com/?sport=${c.league.toUpperCase()}` : 'https://pick6.draftkings.com/') },
    fanduel: { name: 'FanDuel', short: 'FANDUEL', hosts: ['fanduel.com'], board: () => 'https://sportsbook.fanduel.com/' },
    betrivers: { name: 'BetRivers', short: 'BETRIVERS', hosts: ['betrivers.com'], board: () => 'https://www.betrivers.com/' },
    draftkings: { name: 'DraftKings', short: 'DK', hosts: ['draftkings.com'], board: () => 'https://sportsbook.draftkings.com/' },
    betmgm: { name: 'BetMGM', short: 'BETMGM', hosts: ['betmgm.com'], board: () => 'https://sports.betmgm.com/' },
    caesars: { name: 'Caesars', short: 'CAESARS', hosts: ['caesars.com'], board: () => 'https://sportsbook.caesars.com/' },
    bet365: { name: 'bet365', short: 'BET365', hosts: ['bet365.com'], board: () => 'https://www.bet365.com/' },
    fanatics: { name: 'Fanatics', short: 'FANATICS', hosts: ['fanatics.com'], board: () => 'https://sportsbook.fanatics.com/' },
    hardrock: { name: 'Hard Rock', short: 'HARD ROCK', hosts: ['hardrock.bet'], board: () => 'https://www.hardrock.bet/' },
    thescore: { name: 'theScore Bet', short: 'THESCORE', hosts: ['thescore.bet'], board: () => 'https://thescore.bet/' },
  };
  const ALIAS = {
    pp: 'prizepicks', ud: 'underdog', sl: 'sleeper', p6: 'pick6', 'dk pick6': 'pick6', 'draftkings pick6': 'pick6',
    kalshi_mid: 'kalshi', kalshi_props: 'kalshi', 'polymarket us': 'polymarketus', polymarket_us: 'polymarketus', pmus: 'polymarketus',
    'gemini predictions': 'gemini', williamhill_us: 'caesars', hard_rock_bet: 'hardrock', hardrockbet: 'hardrock', 'hard rock': 'hardrock',
    'thescore bet': 'thescore', 'pm us': 'polymarketus', 'theScore': 'thescore',
  };
  // reference prices only: never a place to bet
  const REFERENCE = new Set(['pinnacle', 'matchbook']);
  // never linked, whatever the venue (US users only go to polymarket.us)
  const FORBIDDEN = /(^|\.)polymarket\.com$/i;

  function keyOf(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const l = s.toLowerCase();
    if (VENUES[l]) return l;
    if (ALIAS[l]) return ALIAS[l];
    for (const k of Object.keys(VENUES)) if (VENUES[k].name.toLowerCase() === l) return k;
    return REFERENCE.has(l) ? l : null;
  }
  const hostOf = u => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.hostname.toLowerCase() : null; } catch { return null; } };
  const hostOk = (h, hosts) => !!h && !FORBIDDEN.test(h) && hosts.some(d => h === d || h.endsWith('.' + d));
  // is this URL one the venue may be linked at?
  function validFor(venue, url) {
    const v = VENUES[keyOf(venue)];
    return !!v && hostOk(hostOf(url), v.hosts);
  }
  // every host any venue link may point at (the browser tests check against it)
  const allHosts = () => [...new Set(Object.values(VENUES).flatMap(v => v.hosts))];
  function hostAllowed(url) { return hostOk(hostOf(url), allHosts()); }

  // KXNFLSPREAD-26OCT25NYGHOU-HOU18 or the event ticker itself → the event ticker
  function kalshiEvent(t) {
    const s = String(t || '').trim();
    if (!/^[A-Za-z0-9]+(-[A-Za-z0-9.]+){1,3}$/.test(s)) return null;
    return s.split('-').slice(0, 2).join('-').toLowerCase();
  }
  // Polymarket US league codes (pmusbooks.js LEAGUES, esmatchupdata.js games)
  const PMUS_LEAGUES = new Set(['nfl', 'cfb', 'nba', 'wnba', 'nhl', 'mlb', 'cbb', 'epl', 'lal', 'bun', 'sea', 'fl1', 'mls', 'ere', 'bra', 'ucl',
    'atp', 'wta', 'ufc', 'khl', 'ahl', 'shl', 'kbo', 'npb', 'lol', 'cs2', 'val', 'dota2', 'cod']);
  const PMUS_LEAGUE_OF = { ncaaf: 'cfb', ncaab: 'cbb', laliga: 'lal', bundesliga: 'bun', seriea: 'sea', ligue1: 'fl1', eredivisie: 'ere', brasileirao: 'bra', cs: 'cs2', dota: 'dota2' };
  // a market slug (aec-nfl-lar-lv-2026-10-25, tsc-nfl-pit-no-2026-10-25-total-42pt5)
  // or an event slug → { league, event }
  function pmusEvent(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(s)) return null;
    const m = /^([a-z0-9-]*?\d{4}-\d{2}-\d{2})(?:-|$)/.exec(s);
    if (!m) return null;
    let segs = m[1].split('-');
    // a market slug starts with a 3-letter market code before the league
    if (segs.length > 4 && /^[a-z]{3}$/.test(segs[0]) && PMUS_LEAGUES.has(segs[1])) segs = segs.slice(1);
    if (!PMUS_LEAGUES.has(segs[0]) || segs.length < 5) return null;
    return { league: segs[0], event: segs.join('-') };
  }

  // venue + what we know → { venue, name, href, exact, label, title } or null.
  // ctx: { url, ticker, id, slug, league, player, what } (any may be missing)
  function link(venue, ctx) {
    const c = ctx || {};
    const k = keyOf(venue);
    const v = k && VENUES[k];
    if (!v) return null;
    const lg = c.league ? String(c.league).toLowerCase() : '';
    const out = (href, exact) => ({
      venue: k, name: v.name, href, exact,
      label: exact ? `${v.short} ↗` : `${v.short} BOARD ↗`,
      title: exact ? `Open this market on ${v.name}` : `Open the ${v.name} board${c.what ? ` and find ${c.what}` : ''}: ${v.name} has no public link to this exact ${c.player ? 'player' : 'market'}`,
    });
    if (c.url && hostOk(hostOf(c.url), v.hosts)) {
      // a server URL that is only the venue's home page is a board link
      const p = (() => { try { return new URL(c.url).pathname; } catch { return '/'; } })();
      return out(String(c.url), p.length > 1);
    }
    if (k === 'kalshi') {
      const e = kalshiEvent(c.ticker || c.id);
      if (e) return out(`https://kalshi.com/markets/${e}`, true);
    }
    if (k === 'polymarketus') {
      const e = pmusEvent(c.slug || c.id);
      if (e) return out(`https://polymarket.us/sports/${encodeURIComponent(e.league)}/${encodeURIComponent(e.event)}`, true);
    }
    return out(v.board({ league: k === 'pick6' ? String(c.league || '') : lg }), false);
  }

  // ── tap counts for /api/ops (server side) ──
  // Product telemetry only: a count per venue and kind of link per UTC day.
  // Nothing about who tapped is kept.
  function createTapCounter({ now = () => Date.now(), days = 14 } = {}) {
    const counts = new Map();   // 'YYYY-MM-DD|venue|exact|board' → n
    const since = new Date(now()).toISOString();
    const dayOf = t => new Date(t).toISOString().slice(0, 10);
    function prune() {
      const cut = dayOf(now() - days * 864e5);
      for (const id of counts.keys()) if (id.slice(0, 10) < cut) counts.delete(id);
    }
    function tap(venue, exact) {
      const k = keyOf(venue);
      if (!k || !VENUES[k]) return false;
      const id = `${dayOf(now())}|${k}|${exact ? 'exact' : 'board'}`;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (counts.size > 2000) prune();
      return true;
    }
    function state() {
      prune();
      const byVenue = {}, byDay = {};
      let total = 0;
      for (const [id, n] of counts) {
        const [day, venue, kind] = id.split('|');
        byVenue[venue] = byVenue[venue] || { exact: 0, board: 0, total: 0 };
        byVenue[venue][kind] += n; byVenue[venue].total += n;
        byDay[day] = (byDay[day] || 0) + n;
        total += n;
      }
      return { total, byVenue, byDay, days, countingSince: since, note: 'Taps on venue links in /app, counted per venue and day. Nothing about the person tapping is kept.' };
    }
    // backup rows (results backup): one per day, venue and kind
    const dump = () => [...counts].map(([id, n]) => ({ id, n }));
    function load(rows) {
      for (const r of rows || []) {
        if (!r || typeof r.id !== 'string' || !/^\d{4}-\d{2}-\d{2}\|[a-z0-9]+\|(exact|board)$/.test(r.id)) continue;
        const n = Math.max(0, Math.floor(+r.n || 0));
        if (n > (counts.get(r.id) || 0)) counts.set(r.id, n);
      }
      prune();
    }
    return { tap, state, dump, load };
  }

  return { VENUES, REFERENCE, keyOf, link, validFor, hostAllowed, allHosts, kalshiEvent, pmusEvent, createTapCounter };
}));
