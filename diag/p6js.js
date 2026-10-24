const fs = require('fs'); const axios = require('axios');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };
(async () => {
  fs.mkdirSync('out/js', { recursive: true });
  const html = (await axios.get('https://pick6.draftkings.com/?sport=NBA', { headers: H })).data;
  const urls = new Set([...html.matchAll(/"(\/assets\/[^"]+\.js)"/g)].map(m => m[1]));
  const out = [];
  const seen = new Set();
  const queue = [...urls];
  while (queue.length && seen.size < 400) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    try {
      const js = (await axios.get('https://pick6.draftkings.com' + u, { headers: H, responseType: 'text', transformResponse: x => x })).data;
      for (const m of js.matchAll(/["'(\/]\.?\/?([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js)/g)) queue.push('/assets/' + m[1]);
      for (const m of js.matchAll(/.{0,160}(pickCategory|category=|PickCategory|filterKey).{0,160}/g)) out.push(`${u}: ${m[0]}`);
      if (/pickCategory|filterKey/.test(js)) fs.writeFileSync('out/js/' + u.split('/').pop(), js);
    } catch (e) { out.push(`${u}: ERR ${e.message}`); }
  }
  fs.writeFileSync('out/report.txt', `files ${seen.size}\n` + out.join('\n'));
})();
