// plain public reads of Hard Rock's odds API (no browser, no login)
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://app.hardrock.bet/', Origin: 'https://app.hardrock.bet', 'x-version': '2' };
const get = async (name, url) => {
  try { const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) }); const t = await r.text(); fs.writeFileSync(`out/${name}.txt`, `${url}\n${r.status} ${r.headers.get('server')}\n\n${t.slice(0, 5e6)}`); return { status: r.status, text: t }; }
  catch (e) { fs.writeFileSync(`out/${name}.txt`, `${url}\nERR ${e.message}`); return { error: e.message }; }
};
(async () => {
  await get('hr-ladder', 'https://api.hardrocksportsbook.com/sportsbook/v1/api/getRootLadder');
  const tn = await get('hr-trend', 'https://api.hardrocksportsbook.com/java-graphql/trendingNow?channel=NEW_JERSEY_ONLINE&page=0&pageSize=20');
  try {
    const d = JSON.parse(tn.text);
    const nhl = d.tabs.find(t => /NHL/.test(t.title));
    const t2 = await get('hr-trend-nhl', `https://api.hardrocksportsbook.com/java-graphql/trendingNow?channel=NEW_JERSEY_ONLINE&page=0&pageSize=50&tabId=${nhl.tabId}`);
    const d2 = JSON.parse(t2.text);
    let i = 0;
    for (const p of d2.pills || []) { if (++i > 12) break; await get(`hr-trend-nhl-pill-${i}`, `https://api.hardrocksportsbook.com/java-graphql/trendingNow?channel=NEW_JERSEY_ONLINE&page=0&pageSize=50&tabId=${nhl.tabId}&pillId=${p.id}`); }
  } catch (e) { fs.writeFileSync('out/hr-err.txt', e.stack); }
})();
