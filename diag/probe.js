const K = 'https://api.elections.kalshi.com/trade-api/v2';
const j = async (p) => { const r = await fetch(K + p); const t = await r.text(); console.log('\n### GET', p, r.status); console.log(t.slice(0, 2500)); try { return JSON.parse(t); } catch { return null; } };
(async () => {
  const s = await (await fetch(K + '/series')).json();
  const gas = (s.series || []).filter(x => /GAS|AAA/i.test(x.ticker) || /gas/i.test(x.title || ''));
  console.log('gas series', gas.length, JSON.stringify(gas.map(x => [x.ticker, x.title, x.frequency, x.category])));
  console.log('one series full', JSON.stringify(gas.find(x => x.ticker === 'KXAAAGASDCA') || gas[0], null, 1).slice(0, 4000));
  await j('/historical/cutoff');
  await j('/historical/markets?series_ticker=KXAAAGASDCA&limit=5');
  await j('/historical/events?series_ticker=KXAAAGASDCA&limit=5');
  await j('/events?series_ticker=KXAAAGASDCA&status=settled&limit=3&with_nested_markets=true');
  const m = await j('/historical/markets?series_ticker=KXAAAGASD&limit=5');
  await j('/historical/markets?limit=3&tickers=KXAAAGASDCA-26AUG01-4.6500');
  // oldest gas events reachable
  for (const st of ['CA', 'TX', 'NY']) {
    let cur = null, n = 0, last = null, first = null;
    for (let i = 0; i < 50; i++) { const r = await (await fetch(K + `/historical/markets?series_ticker=KXAAAGASD${st}&limit=1000${cur ? '&cursor=' + cur : ''}`)).json().catch(() => null); if (!r) break; const ms = r.markets || []; n += ms.length; if (ms.length) { first ??= ms[0].close_time; last = ms.at(-1).close_time; } cur = r.cursor; if (!cur || !ms.length) break; }
    console.log('historical', st, 'markets', n, 'from', first, 'to', last);
  }
  // also the national daily and any older series names
  for (const t of gas.map(x => x.ticker)) { const r = await (await fetch(K + `/historical/markets?series_ticker=${t}&limit=1`)).json().catch(() => null); const r2 = await (await fetch(K + `/events?series_ticker=${t}&status=settled&limit=1`)).json().catch(() => null); console.log(t, 'hist', (r?.markets || []).length, r?.markets?.[0]?.close_time, 'live', (r2?.events || []).length, r2?.events?.[0]?.event_ticker); }
})();
