const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
(async () => {
  const b = await (await fetch('https://picks.betr.app/betr-app.bundle.js', { headers: { 'user-agent': UA } })).text();
  const ctx = (pat, n, w) => [...b.matchAll(new RegExp(pat, 'g'))].slice(0, n).map(m => b.slice(Math.max(0, m.index - w), m.index + w));
  const out = { feed: ctx('\\.FEED_URL', 8, 900), setContext: ctx('setContext\\(', 6, 900), bearer: ctx('Bearer ', 10, 500), guest: ctx('[Gg]uest[A-Z][a-zA-Z]*', 10, 300), xheaders: [...new Set([...b.matchAll(/["']((?:x|X)-[a-zA-Z-]{3,40})["']/g)].map(m => m[1]))] };
  fs.writeFileSync('out/betr2.json', JSON.stringify(out, null, 1));
})();
