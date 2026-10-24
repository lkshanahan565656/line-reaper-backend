const fs = require('fs'); const axios = require('axios'); const { decodeTurboStream, pick6Home, parsePick6Board } = require('../pickem');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json', Referer: 'https://pick6.draftkings.com/', Origin: 'https://pick6.draftkings.com' };
const out = []; const say = s => { out.push(s); console.log(s); fs.writeFileSync('out/report.txt', out.join('\n')); };
(async () => {
  fs.mkdirSync('out', { recursive: true });
  const r = await axios.get('https://pick6.draftkings.com/_root.data', { params: { sport: 'NBA' }, headers: H, responseType: 'text', transformResponse: x => x });
  const home = pick6Home(decodeTurboStream(r.data)); const g = home.pickGroups[0].pickGroupId;
  const html = (await axios.get('https://pick6.draftkings.com/?sport=NBA', { headers: { ...H, Accept: 'text/html' } })).data;
  say('hosts in html: ' + [...new Set(html.match(/https?:\/\/[a-z0-9.-]*draftkings[a-z0-9.-]*/g) || [])].join(' '));
  say('dkPublic: ' + (html.match(/.{0,80}PublicApi.{0,120}/gi) || []).slice(0, 4).join(' || '));
  for (const host of ['https://api.draftkings.com', 'https://pick6.draftkings.com', 'https://pick6.draftkings.com/api', 'https://gaming-us-nj.draftkings.com', 'https://api.pick6.draftkings.com']) {
    for (const cat of [127, 17]) {
      const u = `${host}/pick6/v1/pickgroups/${g}/category/${cat}/pickcards`;
      try {
        const x = await axios.get(u, { headers: H, timeout: 15000 });
        const d = x.data; const pc = d.pickCardsResponse || d;
        const lines = parsePick6Board({ pickCardsResponse: pc }, 'NBA');
        say(`${u}: ${x.status} keys ${Object.keys(d).slice(0, 12).join(',')} lines ${lines.length} ${[...new Set(lines.map(l => l.market))].join('|')}`);
        if (lines.length) fs.writeFileSync(`out/cat-${cat}.json`, JSON.stringify(d));
      } catch (e) { say(`${u}: ${e.response?.status} ${e.message}`); }
    }
  }
})();
