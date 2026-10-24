const fs = require('fs'); const axios = require('axios'); const { decodeTurboStream, pick6Home, parsePick6Board } = require('../pickem');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: '*/*', Referer: 'https://pick6.draftkings.com/' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
const get = async params => { const r = await axios.get('https://pick6.draftkings.com/_root.data', { params, headers: H, responseType: 'text', transformResponse: x => x, timeout: 20000 }); return pick6Home(decodeTurboStream(r.data)); };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const base = await get({ sport: 'NBA' });
  const g = base.pickGroups[0].pickGroupId;
  const tries = [['pickCategory', 17], ['pickCategoryId', 17], ['category', 17], ['categoryId', 17], ['category', 'rebs'], ['filter', 'rebs'], ['pickCategoryFilter', 'rebs'], ['stat', 'rebs'], ['statId', 17], ['cat', 17], ['tab', 'rebs'], ['pc', 17]];
  for (const [k, v] of tries) {
    try {
      const h = await get({ sport: 'NBA', pickGroup: g, [k]: v });
      const pc = h.pickCardsResponse || {};
      const lines = parsePick6Board(h, 'NBA');
      say(`${k}=${v}: category ${pc.pickCategoryId} cards ${Object.keys(pc.pickCardByPickableId || {}).length} lines ${lines.length} markets ${[...new Set(lines.map(l => l.market))].join('|')}`);
    } catch (e) { say(`${k}=${v}: error ${e.response?.status} ${e.message}`); }
    await wait(1500);
  }
  try { const r = await axios.get('https://pick6.draftkings.com/?sport=NBA', { headers: { ...H, Accept: 'text/html' }, timeout: 20000 }); const m = [...new Set((r.data.match(/[?&][a-zA-Z]+=[^"&' ]+/g) || []))].slice(0, 80); say('html params: ' + m.join(' ')); fs.writeFileSync('out/page.html', r.data); } catch (e) { say('html ' + e.message); }
})();
