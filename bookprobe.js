// ─── PICK'EM BOOK PROBE ───────────────────────────────────────────────────────
// The sandbox can't reach pick'em APIs and PrizePicks 403s datacenter IPs, so
// whether a book answers from Railway is checked live: GET /api/esports/probe/books
// tries each candidate and reports status, size and which sports it lists.
// ?url= fetches one more URL, only on the hosts below (no open proxy).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CANDIDATES = [
  { key: 'sleeper', url: 'https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control' },
  { key: 'sleeper-plain', url: 'https://api.sleeper.app/lines/available' },
  { key: 'parlayplay', url: 'https://parlayplay.io/api/v1/crossgame/search/?sport=All&league=&includeAlt=true',
    headers: { 'X-Parlay-Request': '1', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://parlayplay.io/', Origin: 'https://parlayplay.io' } },
  { key: 'prizepicks-partner', url: 'https://partner-api.prizepicks.com/projections?per_page=1000' },
  { key: 'prizepicks-cs', url: 'https://api.prizepicks.com/projections?league_id=265&per_page=250&single_stat=true',
    headers: { Origin: 'https://app.prizepicks.com', Referer: 'https://app.prizepicks.com/' } },
  { key: 'dabble', url: 'https://api.dabble.com/sportfixtures/details' },
];
const HOSTS = ['api.sleeper.app', 'sleeper.com', 'parlayplay.io', 'partner-api.prizepicks.com', 'api.prizepicks.com',
  'api.dabble.com', 'api.betr.app', 'pick6.draftkings.com', 'api.draftkings.com', 'api.chalkboard.io', 'api.hotstreak.gg', 'api.ownersbox.com'];

const SPORTISH = new Set(['sport', 'sport_id', 'sportName', 'sport_name', 'league', 'league_id', 'leagueName', 'leagueNameShort', 'league_name', 'wager_type', 'outcome', 'stat', 'stat_type', 'market', 'challengeName']);

// top-level shape plus value counts of the sport-like keys anywhere in the payload
function summarize(data) {
  const counts = {};
  let seen = 0;
  const walk = (v, depth) => {
    if (seen > 200000 || depth > 8 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      seen++;
      if (SPORTISH.has(k) && (typeof x === 'string' || typeof x === 'number')) {
        const C = counts[k] || (counts[k] = {});
        C[x] = (C[x] || 0) + 1;
      } else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  const top = Array.isArray(data) ? { array: data.length }
    : data && typeof data === 'object' ? Object.fromEntries(Object.entries(data).slice(0, 20).map(([k, x]) => [k, Array.isArray(x) ? `array(${x.length})` : typeof x]))
    : typeof data;
  const trimmed = {};
  for (const [k, C] of Object.entries(counts)) trimmed[k] = Object.fromEntries(Object.entries(C).sort((a, b) => b[1] - a[1]).slice(0, 40));
  return { top, values: trimmed };
}

const esportsRe = /\b(lol|league of legends|cs2?|csgo|counter|valorant|val|dota|esport|cod|call of duty|r6|rainbow|overwatch|halo|rocket)\b/i;

// first records that mention an esports word, for writing the parser
function esportsSample(data, n = 3) {
  const out = [];
  const walk = (v, depth) => {
    if (out.length >= n || depth > 6 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const flat = Object.values(v).filter(x => typeof x === 'string').join(' ');
    if (esportsRe.test(flat) && JSON.stringify(v).length < 6000) { out.push(v); return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

async function probeOne(axios, c) {
  const t0 = Date.now();
  try {
    const res = await axios.get(c.url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(c.headers || {}) }, timeout: 15000, validateStatus: () => true, maxContentLength: 40e6 });
    const body = res.data;
    const isJson = body && typeof body === 'object';
    const size = isJson ? JSON.stringify(body).length : String(body || '').length;
    return { key: c.key, url: c.url, status: res.status, ms: Date.now() - t0, size,
      ...(isJson ? { ...summarize(body), esportsSample: esportsSample(body), first: Array.isArray(body) ? body.slice(0, 2) : undefined }
        : { text: String(body || '').slice(0, 400) }) };
  } catch (e) {
    return { key: c.key, url: c.url, status: e.response?.status ?? null, error: String(e.message).slice(0, 200), ms: Date.now() - t0 };
  }
}

function mountBookProbe(app, axios) {
  app.get('/api/esports/probe/books', async (req, res) => {
    if (req.query.url) {
      let host = '';
      try { host = new URL(String(req.query.url)).hostname.toLowerCase(); } catch {}
      if (!HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return res.status(400).json({ error: 'host not on the probe list', hosts: HOSTS });
      return res.json(await probeOne(axios, { key: 'custom', url: String(req.query.url) }));
    }
    const only = req.query.only ? String(req.query.only).split(',') : null;
    const list = CANDIDATES.filter(c => !only || only.includes(c.key));
    res.json({ at: new Date().toISOString(), results: await Promise.all(list.map(c => probeOne(axios, c))) });
  });
}

module.exports = { mountBookProbe, summarize, esportsSample, CANDIDATES, HOSTS };
