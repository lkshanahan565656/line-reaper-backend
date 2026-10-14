// Log Pinnacle esports, Kalshi esports books and our pick'em board for a closing-line check.
const fs = require('fs'), zlib = require('zlib');
const G = 'https://guest.api.arcadia.pinnacle.com/0.1';
const PH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json', Origin: 'https://www.pinnacle.com', Referer: 'https://www.pinnacle.com/' };
const get = async (u, h = {}) => { try { const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(40000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j }; } catch (e) { return { status: 'ERR ' + e.message, j: null }; } };
const PROD = 'https://line-reaper-backend-production.up.railway.app';
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
const MIN = +(process.env.MINUTES || 300), STEP = +(process.env.STEP || 120);
const SERIES = ['KXLOLGAME','KXCS2GAME','KXVALORANTGAME','KXDOTA2GAME','KXLOLMAP','KXCS2MAP','KXVALORANTMAP','KXDOTA2MAP','KXLOLTOTALMAPS','KXCS2TOTALMAPS','KXLOLSPREAD','KXCS2SPREAD','KXR6GAME','KXCODGAME'];
const app = (f, o) => fs.appendFileSync(f, zlib.gzipSync(JSON.stringify(o) + '\n'));
fs.mkdirSync('out', { recursive: true });
let cycle = 0; const t0 = Date.now(); const seen = new Set();
(async () => {
  while (Date.now() - t0 < MIN * 60000) {
    const at = new Date().toISOString(), c0 = Date.now();
    const [mu, mk] = await Promise.all([get(`${G}/sports/12/matchups`, PH), get(`${G}/sports/12/markets/straight`, PH)]);
    const ms = (mu.j || []).filter(m => m.type === 'matchup');
    const newMu = ms.filter(m => !seen.has(m.id + '|' + m.isLive));
    for (const m of newMu) seen.add(m.id + '|' + m.isLive);
    const ids = new Set(ms.map(m => m.id));
    app('out/pin.jsonl.gz', { at, st: [mu.status, mk.status],
      mu: newMu.map(m => ({ id: m.id, p: m.parentId, u: m.units, lg: m.league?.name, st: m.startTime, live: m.isLive, bo: m.bestOf, ps: (m.participants || []).map(p => [p.alignment, p.name]) })),
      mk: (mk.j || []).filter(k => ids.has(k.matchupId)).map(k => ({ m: k.matchupId, k: k.key, per: k.period, t: k.type, alt: k.isAlternate ? 1 : 0, lim: k.limits?.[0]?.amount, s: k.status, pr: (k.prices || []).map(p => [p.designation, p.points, p.price]) })) });
    const kal = {};
    for (const s of SERIES) {
      const a = await get(`${KAL}/markets?series_ticker=${s}&status=open&limit=1000`);
      const list = (a.j?.markets || []);
      kal[s] = { st: a.status, m: [] };
      for (const m of list) {
        const row = { t: m.ticker, e: m.event_ticker, y: m.yes_sub_title, ya: m.yes_ask, yb: m.yes_bid, na: m.no_ask, nb: m.no_bid, v: m.volume, oi: m.open_interest, ft: m.floor_strike, exp: m.expected_expiration_time, close: m.close_time };
        if (/GAME$|MAP$/.test(s)) { const b = await get(`${KAL}/markets/${m.ticker}/orderbook?depth=8`); row.ob = b.j?.orderbook || null; }
        kal[s].m.push(row);
      }
    }
    app('out/kal.jsonl.gz', { at, kal });
    if (cycle % 5 === 0) {
      const pk = await get(`${PROD}/api/esports/picks`);
      app('out/picks.jsonl.gz', { at, st: pk.status, upd: pk.j?.updated, picks: (pk.j?.picks || []).map(p => ({ sport: p.sport, player: p.player, team: p.team, mt: p.matchTitle, market: p.market, start: p.startTime, pp: p.ppLine, ud: p.udLine, udm: p.udMultiplier, udr: p.udRegime, sl: p.sleeperLine, slm: p.sleeperMultiplier, mp: p.marketPred, raw: p.rawPred, q: p.marketQuotes, side: p.side, prob: p.prob, ev: p.ev, bb: p.bestBook, bev: p.bestEv, ctx: p.context, mu: p.matchup && { pMap: p.matchup.pMap, factor: p.matchup.factor, src: p.matchup.source }, gap: p.lineGap ? 1 : 0, pricing: p.pricing && { line: p.pricing.line, mpm: p.pricing.meanPerMap, k: p.pricing.k, sc: p.pricing.scenarios } })) });
    }
    console.log(at, 'cycle', cycle, 'pin', mu.status, ms.length, 'kal', Object.values(kal).reduce((a, x) => a + x.m.length, 0), 'took', Date.now() - c0);
    cycle++;
    const wait = STEP * 1000 - (Date.now() - c0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  fs.writeFileSync('out/DONE', new Date().toISOString());
})();
