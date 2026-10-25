// Replays the diag-outrec snapshots through outrights.js (flags, Pinnacle close), then settles on Kalshi.
// node grade.js <snaps.jsonl.gz>  (run from a checkout of main with npm ci done; R = repo dir)
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const R = process.env.R || '.';
const o = require(path.resolve(R, 'outrights.js'));
const ex = require(path.resolve(R, 'execcheck.js'));
const pmus = require(path.resolve(R, 'pmus.js'));
const lines = zlib.gunzipSync(fs.readFileSync(process.argv[2])).toString().split('\n').filter(Boolean);
const store = new Map();
const mem = { all: async () => [...store.values()].map(x => JSON.parse(JSON.stringify(x))), put: async b => { store.set(b.id, JSON.parse(JSON.stringify(b))); } };
let t = 0;
const http = { get: async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }); return { data: await r.json() }; } };
const tr = o.createOutrightsTracker({ store: mem, http, now: () => t });
const boards = [];
(async () => {
  let last = null;
  for (const l of lines) {
    const s = JSON.parse(l); t = Date.parse(s.at); last = s;
    const pins = Object.entries(s.pin).flatMap(([k, v]) => o.parsePinLeague(k.split('|')[0], v.mu || [], v.mk || [], t));
    const exch = [...s.kalshi.map(o.parseKalshiEvent), ...s.pmus.map(x => o.parsePmusEvent(x.e, x.sport))].filter(Boolean);
    const books = new Map();
    for (const [k, v] of Object.entries(s.books || {})) {
      const [venue, id] = k.split('|');
      if (venue === 'kalshi' && !v.status) for (const buy of ['yes', 'no']) books.set(`kalshi|${id}|${buy}`, ex.kalshiAsks(v, buy));
      if (venue === 'polymarketus' && !v.status) { const b = pmus.parseBook(v); if (b) for (const buy of ['yes', 'no']) books.set(`polymarketus|${id}|${buy}`, ex.pmusAsks(b, buy === 'yes' ? 'long' : 'short')); }
    }
    await tr.scan({ pins, pinReadAt: t, exch, books });
    const b = tr.state.board.filter(x => !x.season);
    boards.push({ at: s.at, sides: b.length, pos: b.filter(x => x.ev > 0).length, ev3: b.filter(x => x.ev >= 0.03).length, byType: [...new Set(b.map(x => `${x.venue}:${x.type}`))] });
  }
  // close everything past cutoff, then settle
  t = Date.now();
  await tr.scan({ pins: [], pinReadAt: 0, exch: [] });
  const s1 = await tr.settle({ limit: 500, minAgeMs: 0 });
  const all = await mem.all();
  const out = { scans: lines.length, from: JSON.parse(lines[0]).at, to: last.at, settle: s1, record: o.summarize(all), bySport: o.summarizeBy(all, b => b.sport), byVenue: o.summarizeBy(all, b => `${b.sport} ${b.venue} ${b.type}`), boards, flags: all.map(({ fairs, ...b }) => b) };
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/grade.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ scans: out.scans, settle: s1, record: out.record, byVenue: out.byVenue }, null, 1));
  for (const b of all) console.log(b.venue, b.type, b.runner, b.buy, 'cost', b.cost, 'fairFlag', b.fairAtFlag, 'close', b.closeFair, 'clv', b.clv, b.outcome || b.status, b.minsBefore + 'm');
})();
