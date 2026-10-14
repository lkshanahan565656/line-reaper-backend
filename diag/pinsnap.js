// Pinnacle esports snapshot: per-map round ladders, for coverage.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const axios = require(path.resolve('node_modules/axios'));
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0', Accept: 'application/json' };
(async () => {
  const P = 'https://guest.api.arcadia.pinnacle.com/0.1/sports/12';
  const [mu, mk] = await Promise.all([axios.get(`${P}/matchups`, { headers: H }), axios.get(`${P}/markets/straight`, { headers: H })]);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/pin.json.gz', zlib.gzipSync(JSON.stringify({ at: new Date().toISOString(), matchups: mu.data, markets: mk.data })));
  console.log('pin', mu.data.length, mk.data.length);
})().catch(e => console.log('pin fail', e.message));
