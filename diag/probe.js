const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
const AK = 'FhMFpcPWXMeyZxOx';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'application/json' };
const K = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiusnj';
const fd = st => `https://sbapi.${st}.sportsbook.fanduel.com/api`;
const urls = {};
for (const st of ['nj', 'pa', 'ny', 'il', 'oh', 'az', 'co', 'mi', 'va'])
  urls[`page_${st}`] = `${fd(st)}/content-managed-page?page=CUSTOM&customPageId=oddsboosts&pbHorizontal=false&_ak=${AK}&timezone=America%2FNew_York`;
for (const id of [34118083, 34052664, 30861650, 31000705, 33952198, 32165213, 30391334])
  urls[`ev_${id}`] = `${fd('nj')}/event-page?_ak=${AK}&eventId=${id}`;
urls.k_house = `${K}/betoffer/event/1029303874.json?lang=en_US&market=US`;
(async () => {
  const summary = {};
  for (const [name, url] of Object.entries(urls)) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      fs.writeFileSync(`out/${name}.json`, text);
      summary[name] = { status: r.status, bytes: text.length };
    } catch (e) { summary[name] = { error: String(e) }; }
    await new Promise(r => setTimeout(r, 700));
  }
  fs.writeFileSync('out/summary.json', JSON.stringify(summary, null, 1));
})();
