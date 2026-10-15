const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const pages = (process.env.PAGES || fs.readFileSync('diag/pages.txt', 'utf8')).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const log = [];
async function get(url, extra = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: extra.accept || '*/*', 'Accept-Language': 'en-US', ...(extra.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(20000), method: extra.method || 'GET', body: extra.body });
    const text = await r.text();
    return { url, final: r.url, status: r.status, ms: Date.now() - t0, len: text.length, ctype: r.headers.get('content-type'), server: r.headers.get('server'), text };
  } catch (e) { return { url, status: null, error: String(e.message).slice(0, 200), ms: Date.now() - t0 }; }
}
(async () => {
  let i = 0;
  for (const line of pages) {
    let [url, ...rest] = line.split(' ');
    const opts = rest.length ? JSON.parse(rest.join(' ')) : {};
    const r = await get(url, opts);
    i++;
    const name = `out/${String(i).padStart(2, '0')}.txt`;
    fs.writeFileSync(name, r.text ? r.text.slice(0, 3e6) : '');
    const entry = { i, url, final: r.final, status: r.status, len: r.len, ctype: r.ctype, server: r.server, error: r.error, head: r.text ? r.text.slice(0, 300) : undefined };
    if (r.text && /html/.test(r.ctype || '') && !opts.noscan) {
      const srcs = [...r.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => new URL(m[1], r.final).href);
      entry.scripts = srcs.slice(0, 40);
      const hosts = new Set();
      const apis = new Set();
      const scan = t => {
        for (const m of t.matchAll(/https?:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9_\-./{}]*)?/g)) { const u = m[0]; if (/api|graphql|gql|picks|pick6|projection|board|lines|chalk|betr/i.test(u) && !/\.(png|svg|jpg|css|woff2?)$/.test(u)) apis.add(u.slice(0, 160)); hosts.add(u.split('/')[2]); }
        for (const m of t.matchAll(/["'`](\/(?:api|v\d|graphql)[a-zA-Z0-9_\-./]{2,120})["'`]/g)) apis.add(m[1]);
      };
      scan(r.text);
      for (const s of srcs.slice(0, 30)) {
        const b = await get(s);
        if (b.text) scan(b.text);
      }
      entry.hosts = [...hosts].filter(h => !/google|facebook|segment|sentry|doubleclick|cloudflare|gstatic|w3\.org|schema\.org|reactjs|github|mozilla|apple\.com/.test(h)).slice(0, 80);
      entry.apis = [...apis].slice(0, 200);
    }
    log.push(entry);
    fs.writeFileSync('out/index.json', JSON.stringify(log, null, 1));
  }
})();
