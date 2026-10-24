const fs = require('fs'); const axios = require('axios'); const { decodeTurboStream, pick6Home, parsePick6Board } = require('../pickem');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: '*/*', Referer: 'https://pick6.draftkings.com/' };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const r = await axios.get('https://pick6.draftkings.com/_root.data', { params: { sport: 'NBA' }, headers: H, responseType: 'text', transformResponse: x => x });
  const home = pick6Home(decodeTurboStream(r.data)); const g = home.pickGroups[0].pickGroupId;
  for (const [u, params] of [[`/resources/pickCardsByCategory/${g}/127`, {}], [`/resources/pickCardsByCategory/${g}/127.data`, {}], [`/category/127.data`, { sport: 'NBA', pickGroup: g }], [`/category/17.data`, { sport: 'NBA', pickGroup: g }], [`/category/127`, { sport: 'NBA', pickGroup: g, _data: 'routes/_homeShared._pickExperience.category.$categoryId' }]]) {
    try {
      const x = await axios.get('https://pick6.draftkings.com' + u, { params, headers: H, responseType: 'text', transformResponse: x => x, timeout: 20000 });
      const t = String(x.data);
      say(`${u} ${x.status} ${x.headers['content-type']} len ${t.length}: ${t.slice(0, 300).replace(/\n/g, ' | ')}`);
      fs.writeFileSync('out/' + u.replace(/[^a-z0-9]/gi, '_') + '.txt', t);
      let d = null; try { d = JSON.parse(t); } catch (e) { d = decodeTurboStream(t); }
      const find = o => { if (!o || typeof o !== 'object') return null; if (o.pickCardByPickableId) return o; for (const v of Object.values(o)) { const f = find(v); if (f) return f; } return null; };
      const pc = find(d);
      if (pc) { const lines = parsePick6Board({ pickCardsResponse: pc }, 'NBA'); say(`  -> category ${pc.pickCategoryId} lines ${lines.length} ${[...new Set(lines.map(l => l.market))].join('|')}`); }
    } catch (e) { say(`${u}: ${e.response?.status} ${e.message}`); }
    await wait(1500);
  }
})();
