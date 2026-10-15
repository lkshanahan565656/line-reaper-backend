// ─── DATA LICENCES FOR THE PAID PRODUCT ───────────────────────────────────────
// Some feeds are fine for the owner's own use but not for a product other
// people pay for: their terms ban scraping, or the licence covers one user.
// With PAYWALL=on (people paying) each of these stops being fetched at all,
// until its own *_DATA_OK setting says written permission (or a commercial
// licence) is in place. With the paywall off nothing changes.
//
// The gate sits on the shared axios instance (install()), so every fetcher in
// every module is covered without each one checking: a blocked request fails
// like a feed that's down, which every fetcher already handles.
//
// Polymarket and Kalshi are not here: they are free public APIs whose data is
// shown to the admin only until POLYMARKET_DISPLAY_OK / KALSHI_DISPLAY_OK
// (server.js licenceFor), so the owner keeps using them.

const BLOCKED = [
  { key: 'owls', name: 'Owls Insight', flag: 'OWLS_DATA_OK', hosts: ['api.owlsinsight.com'],
    why: 'The Owls licence covers one user, not a product others pay for.' },
  { key: 'prizepicks', name: 'PrizePicks', flag: 'PRIZEPICKS_DATA_OK', hosts: ['api.prizepicks.com', 'app.prizepicks.com', 'partner-api.prizepicks.com'],
    why: 'PrizePicks terms ban scraping.' },
  { key: 'sleeper', name: 'Sleeper', flag: 'SLEEPER_DATA_OK', hosts: ['api.sleeper.app'],
    why: 'Sleeper has no public lines API licence; its app API is used unofficially.' },
  { key: 'underdog', name: 'Underdog', flag: 'UNDERDOG_DATA_OK', hosts: ['api.underdogfantasy.com', 'stats.underdogfantasy.com'],
    why: 'Underdog terms ban scraping.' },
  { key: 'vlr', name: 'VLR.gg', flag: 'VLR_DATA_OK', hosts: ['vlr.gg', 'www.vlr.gg', 'vlrggapi.vercel.app'],
    why: 'VLR.gg terms ban scraping (vlrggapi is a scraper of it).' },
  { key: 'bo3', name: 'bo3.gg', flag: 'BO3_DATA_OK', hosts: ['bo3.gg', 'api.bo3.gg'],
    why: 'bo3.gg has no public API licence; its site API is used unofficially.' },
  { key: 'hltv', name: 'HLTV', flag: 'HLTV_DATA_OK', hosts: ['hltv.org', 'www.hltv.org'],
    why: 'HLTV terms ban scraping.' },
  { key: 'golgg', name: 'Games of Legends (gol.gg)', flag: 'GOLGG_DATA_OK', hosts: ['gol.gg'],
    why: 'gol.gg pages are scraped; no data licence.' },
  { key: 'pinnacle', name: 'Pinnacle', flag: 'PINNACLE_DATA_OK', hosts: ['guest.api.arcadia.pinnacle.com'],
    why: 'Pinnacle closed its public API on 2025-07-23; the guest API is unofficial.' },
  { key: 'fanduel', name: 'FanDuel', flag: 'FANDUEL_DATA_OK', hosts: ['sbapi.nj.sportsbook.fanduel.com'],
    why: 'Prices read from the page JSON its site uses: no licence for a paid product.' },
  { key: 'betrivers', name: 'BetRivers (Kambi)', flag: 'BETRIVERS_DATA_OK', hosts: ['eu-offering-api.kambicdn.com'],
    why: 'Prices read from the Kambi offering API its site uses: no licence for a paid product.' },
  { key: 'actionnetwork', name: 'Action Network', flag: 'ACTIONNETWORK_DATA_OK', hosts: ['api.actionnetwork.com'],
    why: 'DraftKings, BetMGM, Caesars, bet365, Fanatics, Hard Rock and theScore prices read from the JSON its odds pages use: no licence for a paid product.' },
  { key: 'matchbook', name: 'Matchbook', flag: 'MATCHBOOK_DATA_OK', hosts: ['api.matchbook.com'],
    why: "Matchbook's public REST prices; its API terms cover account holders, not a redistributed feed." },
  { key: 'pick6', name: 'DraftKings Pick6', flag: 'PICK6_DATA_OK', hosts: ['pick6.draftkings.com'],
    why: "Lines read from the loader data its site uses: no licence for a paid product." },
  { key: 'bovada', name: 'Bovada', flag: 'BOVADA_DATA_OK', hosts: ['www.bovada.lv', 'bovada.lv'],
    why: 'Prices read from the JSON its site uses; an offshore book, never a venue for US subscribers.' },
];

// Still on with the paywall on, but their terms need a read (or attribution)
// before charging. Listed in /api/status so nothing is forgotten.
const REVIEW = [
  { key: 'oddsapi', name: 'The Odds API', note: 'Paid plans allow use in apps; check the plan terms.' },
  { key: 'pandascore', name: 'PandaScore', note: 'Free tier terms: check commercial use.' },
  { key: 'lolesports', name: 'LoL Esports schedule', note: 'Unofficial use of the public key the lolesports site uses.' },
  { key: 'oracleselixir', name: "Oracle's Elixir", note: 'Free downloads; check terms and credit.' },
  { key: 'leaguepedia', name: 'Leaguepedia', note: 'CC BY-SA: credited on /data-sources.' },
  { key: 'opendota', name: 'OpenDota', note: 'Free API: credited on /data-sources.' },
];

const envOn = (env, k) => /^(1|on|true|yes)$/i.test(String(env[k] || '').trim());
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

function createLicences({ paywall = () => false, env = process.env, extraHosts = {} } = {}) {
  const sources = BLOCKED.map(s => ({ ...s, hosts: [...s.hosts, ...(extraHosts[s.key] || [])].map(h => h.toLowerCase()) }));
  const on = s => !paywall() || envOn(env, s.flag);
  const sourceFor = url => {
    const h = hostOf(url);
    return h ? sources.find(s => s.hosts.some(x => h === x || h.endsWith(`.${x}`))) || null : null;
  };
  // the source a request would break the licence of, or null
  const blocked = url => { const s = sourceFor(url); return s && !on(s) ? s : null; };
  const isOn = key => { const s = sources.find(x => x.key === key); return !s || on(s); };
  const state = () => ({
    paywall: !!paywall(),
    paused: sources.filter(s => !on(s)).map(s => s.key),
    sources: sources.map(s => ({ key: s.key, name: s.name, flag: s.flag, state: on(s) ? 'on' : 'paused', why: s.why })),
    review: REVIEW,
  });
  // what the app shows: names only, nothing about why
  const publicState = () => ({ paused: sources.filter(s => !on(s)).map(s => ({ key: s.key, name: s.name })) });

  // Rejects requests to a paused source. Logs each source once an hour.
  const lastLog = {};
  function install(axios, log = console) {
    return axios.interceptors.request.use(cfg => {
      const url = cfg.baseURL && !/^https?:/i.test(cfg.url || '') ? `${cfg.baseURL.replace(/\/$/, '')}/${String(cfg.url || '').replace(/^\//, '')}` : cfg.url;
      const s = blocked(url);
      if (!s) return cfg;
      if (!lastLog[s.key] || Date.now() - lastLog[s.key] > 3600000) {
        lastLog[s.key] = Date.now();
        log.warn?.(`Licences: ${s.name} paused while PAYWALL is on (set ${s.flag}=on once written permission is in).`);
      }
      const e = new Error(`${s.name} paused: waiting on data permission`);
      e.code = 'LICENCE_PAUSED';
      e.source = s.key;
      throw e;
    });
  }
  return { sources, blocked, isOn, state, publicState, install, sourceFor };
}

// ── wallets their owners asked us to hide (HIDDEN_WALLETS, comma-separated) ──
// The privacy policy promises a wallet owner can have their wallet hidden.
// Any list item (a trader, signal, board row, whale trade) that mentions a
// hidden wallet anywhere is dropped, and a bare string equal to one is nulled.
const hiddenWallets = (env = process.env) => String(env.HIDDEN_WALLETS || '').split(',').map(w => w.trim().toLowerCase()).filter(w => w.length >= 8);
function mentions(x, list) {
  const text = JSON.stringify(x ?? null).toLowerCase();
  return list.some(w => text.includes(w));
}
function hideWallets(x, list = hiddenWallets()) {
  if (!list.length) return x;
  const walk = v => {
    if (typeof v === 'string') return list.includes(v.toLowerCase()) ? null : v;
    if (Array.isArray(v)) return v.filter(i => !(i && typeof i === 'object' && mentions(i, list))).map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val);
    return out;
  };
  return walk(x);
}

module.exports = { createLicences, BLOCKED, REVIEW, hideWallets, hiddenWallets, mentions };
