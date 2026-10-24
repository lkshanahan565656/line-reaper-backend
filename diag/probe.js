const g = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); const t = await r.text(); return [r.status, t]; } catch (e) { return [0, e.message]; } };
(async () => {
  const [s1, sp] = await g('https://gamma-api.polymarket.com/sports'); console.log('sports', s1, sp.slice(0, 1500));
  const [s2, ev] = await g('https://gamma-api.polymarket.com/events?series_id=10310&closed=true&limit=2&order=startDate&ascending=false'); console.log('events', s2, ev.slice(0, 3000));
  let e; try { e = JSON.parse(ev)[0]; } catch {}
  const m = e?.markets?.[0]; const tok = m && JSON.parse(m.clobTokenIds)[0]; const st = Math.floor(Date.parse(e?.startTime || m?.gameStartTime) / 1000);
  console.log('market', m?.question, m?.sportsMarketType, e?.startTime, m?.gameStartTime, tok);
  for (const u of [`https://clob.polymarket.com/prices-history?market=${tok}&startTs=${st - 7200}&endTs=${st + 600}&fidelity=1`, `https://clob.polymarket.com/prices-history?market=${tok}&interval=max&fidelity=60`, `https://data-api.polymarket.com/v2/prices-history?token_id=${tok}&bucket_seconds=60&start=${st - 7200}&end=${st + 600}&limit=1000`]) { const [s, t] = await g(u); console.log('hist', s, u.slice(0, 80), t.slice(0, 600)); }
  const [s3, k] = await g('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXCS2TOTALMAPS&status=settled&limit=3'); console.log('ktot', s3, k.slice(0, 2500));
  const [s4, k2] = await g('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXCS2SPREAD&status=settled&limit=3'); console.log('kspr', s4, k2.slice(0, 2500));
  const [s5, ev2] = await g('https://gamma-api.polymarket.com/events?series_id=10310&closed=true&limit=100&offset=3000&order=startDate&ascending=false'); try { const a = JSON.parse(ev2); console.log('offset3000', s5, a.length, a[0]?.startTime, a.slice(-1)[0]?.startTime); } catch { console.log('offset3000', s5, ev2.slice(0, 300)); }
})();
