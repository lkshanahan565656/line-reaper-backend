const fs = require('fs');
fs.mkdirSync('out/raw4', { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = async url => { try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' }, signal: AbortSignal.timeout(25000) }); return { status: r.status, t: await r.text() }; } catch (e) { return { status: 0, t: String(e.message) }; } };
(async () => {
  const sum = {};
  for (const [lg, page] of [['nfl', 'passing-yards'], ['ncaaf', 'passing-yards'], ['nba', 'points'], ['nhl', 'shots-on-goal'], ['mlb', 'strikeouts'], ['wnba', 'points']]) {
    const r = await get(`https://www.actionnetwork.com/${lg}/props/${page}`);
    const types = [...new Set((r.t.match(/core_bet_type_\d+_[a-z0-9_]+/g) || []))];
    const slugs = [...new Set((r.t.match(new RegExp(`/${lg}/props/[a-z0-9-]+`, 'g')) || []))];
    sum[lg] = { status: r.status, len: r.t.length, types, slugs };
    fs.writeFileSync(`out/raw4/${lg}.html`, r.t.slice(0, 2e6));
  }
  fs.writeFileSync('out/summary4.json', JSON.stringify(sum, null, 1));
})();
