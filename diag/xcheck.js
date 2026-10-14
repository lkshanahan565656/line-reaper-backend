// Independent check of the cross-book prices (diag only, never deployed).
// Every minute for RUN_MIN minutes: Pinnacle games + props, FanDuel and
// BetRivers read directly (freebooks), Action Network's copy of every book
// including FanDuel and BetRivers, Matchbook raw (with the money at each
// price). Every quote goes to out/quotes.jsonl as deltas; production's /api/ev
// every two minutes to out/prod.jsonl.
const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const pingames = require('../pingames');
const pinprops = require('../pinprops');
const freebooks = require('../freebooks');
const xbooks = require('../xbooks');
const ev = require('../ev');

const RUN_MIN = Number(process.env.RUN_MIN || 75);
const U = 'https://line-reaper-backend-production.up.railway.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
fs.mkdirSync('out', { recursive: true });
const qout = fs.createWriteStream('out/quotes.jsonl');
const pout = fs.createWriteStream('out/prod.jsonl');
const mout = fs.createWriteStream('out/matchbook.jsonl');
const log = (...a) => { console.log(new Date().toISOString(), ...a); fs.appendFileSync('out/log.txt', `${new Date().toISOString()} ${a.join(' ')}\n`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const keyId = new Map(), keys = [];
let last = new Map();

async function anBooks() {
  try {
    const r = await axios.get('https://api.actionnetwork.com/web/v1/books', { headers: { 'User-Agent': UA }, timeout: 20000 });
    const list = r.data?.books || r.data || [];
    fs.writeFileSync('out/an-books.json', JSON.stringify(list.map(b => ({ id: b.id, name: b.display_name || b.name, state: b.meta?.state || b.state, abbr: b.abbr }))));
    return list;
  } catch (e) { log('books', e.message); return []; }
}

(async () => {
  const books = await anBooks();
  // every FanDuel and BetRivers id Action Network lists, as fanduel_an_<id>
  for (const b of books) {
    const n = String(b.display_name || b.name || '');
    if (/fanduel/i.test(n) && !/dfs|fantasy|racing/i.test(n)) xbooks.AN_BOOKS[b.id] = { key: `fanduel_an_${b.id}`, title: n };
    if (/betrivers|rivers/i.test(n)) xbooks.AN_BOOKS[b.id] = { key: `betrivers_an_${b.id}`, title: n };
  }
  if (!Object.values(xbooks.AN_BOOKS).some(b => /^fanduel_an/.test(b.key))) { xbooks.AN_BOOKS[69] = { key: 'fanduel_an_69', title: 'FanDuel?' }; xbooks.AN_BOOKS[71] = { key: 'betrivers_an_71', title: 'BetRivers?' }; }
  log('an books', JSON.stringify(xbooks.AN_BOOKS));
  const t0 = Date.now();
  let cycle = 0, pinProps = [], propCache = new Map(), ladderCache = new Map(), sampled = false;
  while (Date.now() - t0 < RUN_MIN * 60e3) {
    const c0 = Date.now();
    const stamp = {};
    try {
      if (cycle % 2 === 0) {
        try { const p = await pinprops.fetchPinnacleProps(axios, ''); if (p.props.length) pinProps = p.props; } catch (e) { log('pinprops', e.message); }
      }
      stamp.pin = Date.now();
      const pin = await pingames.fetchPinnacleGames(axios, {});
      // Action Network + Matchbook, by hand so the raw Matchbook is kept
      const extra = {}, sports = Object.keys(xbooks.LEAGUES);
      for (const s of sports) extra[s] = [];
      stamp.an = Date.now();
      const jobs = [];
      for (const s of sports) for (const url of xbooks.actionUrls(s)) jobs.push(async () => {
        try {
          const r = await axios.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000 });
          if (!sampled && r.data?.games?.length) { sampled = true; fs.writeFileSync('out/an-sample.json', JSON.stringify(r.data.games[0]).slice(0, 400000)); }
          extra[s].push(...xbooks.parseAction(r.data, { props: xbooks.AN_PROPS[s] }));
        } catch (e) { log('an', s, e.response?.status || e.message); }
      });
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => { while (i < jobs.length) await jobs[i++](); }));
      stamp.mb = Date.now();
      const mbRaw = [];
      for (const id of [1, 4, 6, 3]) {
        try {
          const r = await axios.get(`https://api.matchbook.com/edge/rest/events?sport-ids=${id}&per-page=300&include-prices=true&price-depth=3&states=open&odds-type=DECIMAL`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000 });
          const gs = xbooks.parseMatchbook(r.data);
          for (const s of sports.filter(x => xbooks.LEAGUES[x].mb === id)) extra[s].push(...gs);
          if (cycle % 5 === 0) for (const e of r.data?.events || []) for (const mk of e.markets || []) {
            if (!/^(moneyline|handicap|total)$/i.test(mk.name || '') && !/ - Total /.test(mk.name || '')) continue;
            mbRaw.push({ ev: e.name, start: e.start, mk: mk.name, type: mk['market-type'], vol: mk.volume, runners: (mk.runners || []).map(r => ({ n: r.name, h: r.handicap, p: (r.prices || []).map(p => [p.side, p['decimal-odds'], Math.round(p['available-amount'] || 0)]) })) });
          }
        } catch (e) { log('mb', id, e.response?.status || e.message); }
      }
      if (mbRaw.length) mout.write(JSON.stringify({ t: stamp.mb, m: mbRaw }) + '\n');
      stamp.fd = Date.now();
      const fdProps = cycle % 2 === 0;
      const { games, errors } = await freebooks.fetchFreeBooks(axios, pin.games, { pinProps, fdProps, propCache, ladderCache, extra });
      stamp.end = Date.now();
      if (errors.length) log('free', errors.slice(0, 5).join(' | '));
      const now = new Map();
      for (const [s, gs] of Object.entries(games)) for (const q of ev.quotesFromGames(gs, { sport: s })) {
        const k = `${q.group}|${q.side}|${q.book}`;
        now.set(k, q.price);
      }
      const ch = [], rm = [];
      for (const [k, p] of now) {
        if (last.get(k) === p) continue;
        if (!keyId.has(k)) { keyId.set(k, keys.length); keys.push(k); }
        ch.push([keyId.get(k), p]);
      }
      for (const k of last.keys()) if (!now.has(k)) rm.push(keyId.get(k));
      last = now;
      // game starts, for filtering started games later
      const starts = {};
      for (const gs of Object.values(games)) for (const g of gs) starts[g.id] = g.commence_time;
      qout.write(JSON.stringify({ c: cycle, stamp, n: now.size, ch, rm, starts: cycle % 10 === 0 ? starts : undefined }) + '\n');
      log('cycle', cycle, 'quotes', now.size, 'changed', ch.length, 'removed', rm.length, 'secs', ((Date.now() - c0) / 1000).toFixed(0));
    } catch (e) { log('cycle err', e.stack); }
    if (cycle % 2 === 0) {
      try {
        const r = await axios.get(`${U}/api/ev?minEv=0&limit=1000`, { timeout: 30000 });
        pout.write(JSON.stringify({ t: Date.now(), counts: r.data.counts, count: r.data.count, updated: r.data.updated, rows: r.data.rows }) + '\n');
      } catch (e) { log('prod', e.response?.status || e.message); }
      if (cycle % 10 === 0) try { const r = await axios.get(`${U}/api/status`, { timeout: 30000 }); fs.writeFileSync(`out/status-${cycle}.json`, JSON.stringify(r.data)); } catch (e) { log('status', e.message); }
    }
    fs.writeFileSync('out/keys.json', JSON.stringify(keys));
    cycle++;
    const wait = 60e3 - (Date.now() - c0);
    if (wait > 0) await sleep(wait);
  }
  qout.end(); pout.end(); mout.end();
  await sleep(2000);
  for (const f of ['quotes.jsonl', 'prod.jsonl', 'matchbook.jsonl', 'keys.json']) {
    fs.writeFileSync(`out/${f}.gz`, zlib.gzipSync(fs.readFileSync(`out/${f}`)));
    fs.unlinkSync(`out/${f}`);
  }
  log('done');
})();
