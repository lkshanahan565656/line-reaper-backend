const fs = require('fs');
const KAL = 'https://api.elections.kalshi.com/trade-api/v2';
const get = async u => { try { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) }); if (!r.ok) return { error: r.status }; return await r.json(); } catch (e) { return { error: e.message }; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const SER = 'KXUFCMOV KXUFCDISTANCE KXUFCROUNDS KXUFCVICROUND KXUFCFIGHT KXMMAFIGHT KXNASCARTOP3 KXNASCARTOP5 KXNASCARTOP10 KXNASCARTOP20 KXNASCARRACE KXEPLGOAL KXEPLANYGOAL KXMLSGOAL KXLALIGAGOAL KXSERIEAGOAL KXBUNDESLIGAGOAL KXLIGUE1GOAL KXUCLGOAL KXLIGAMXGOAL KXUELGOAL KXEPLSOA KXUCLSOA KXUCLSOT KXUCLAST KXEPLAST KXEPLFIRSTGOAL KXMLSFIRSTGOAL KXEPLSOT KXMLSSOT KXMLSAST KXLALIGASOT KXF1RACETOP10 KXF1 KXPGABIRDIES KXATPTOTALSETS KXWTAGTOTAL KXATPGTOTAL KXATPMATCH KXWTAMATCH'.split(' ');
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const out = [];
  const pick = m => ({ t: m.ticker, title: m.title, yes: m.yes_sub_title, sub: m.subtitle, rules: (m.rules_primary || '').slice(0, 300), fs: m.floor_strike, st: m.strike_type, cs: m.custom_strike, exp: m.expected_expiration_time, close: m.close_time, bid: m.yes_bid_dollars, ask: m.yes_ask_dollars, vol: m.volume, oi: m.open_interest, status: m.status, result: m.result });
  for (const s of SER) {
    const open = await get(`${KAL}/events?series_ticker=${s}&status=open&with_nested_markets=true&limit=200`);
    const evs = open.events || [];
    const nm = evs.reduce((a, e) => a + (e.markets || []).length, 0);
    out.push(`\n### ${s}: ${evs.length} open events, ${nm} markets${open.error ? ' err ' + open.error : ''}`);
    for (const e of evs.slice(0, 2)) {
      out.push(` EVENT ${e.event_ticker} | ${e.title} | ${e.sub_title} | strike_date ${e.strike_date}`);
      for (const m of (e.markets || []).slice(0, 6)) out.push('   ' + JSON.stringify(pick(m)));
    }
    if (!evs.length) {
      const st = await get(`${KAL}/events?series_ticker=${s}&status=settled&with_nested_markets=true&limit=1`);
      for (const e of (st.events || [])) {
        out.push(` SETTLED ${e.event_ticker} | ${e.title} | ${e.sub_title}`);
        for (const m of (e.markets || []).slice(0, 4)) out.push('   ' + JSON.stringify(pick(m)));
      }
    }
    await wait(150);
  }
  fs.writeFileSync('out/kfmt.txt', out.join('\n'));
})();
