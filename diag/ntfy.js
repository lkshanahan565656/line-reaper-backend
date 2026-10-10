// One-off: post a test alert to a throwaway ntfy topic and read it back.
const axios = require('axios');
const { createWebhook } = require('./webhook');
const topic = `lr-diag-${Math.random().toString(36).slice(2, 12)}`;
(async () => {
  const hook = createWebhook({ urls: `https://ntfy.sh/${topic}` });
  const ok = await hook.send('🐋 Test: B-grade sharp bought Matheus Camilo at 63¢ · 1u at Kalshi: YES 64¢ <https://kalshi.com/markets/kxufcfight>', 'Diag');
  console.log('sent', ok, JSON.stringify(hook.stats()));
  await new Promise(r => setTimeout(r, 1500));
  const r = await axios.get(`https://ntfy.sh/${topic}/json`, { params: { poll: 1 }, timeout: 20000, responseType: 'text' });
  console.log(String(r.data).trim().split('\n').map(l => { const m = JSON.parse(l); return JSON.stringify({ event: m.event, title: m.title, message: m.message, click: m.click }); }).join('\n'));
})().catch(e => console.log('fatal', e.message));
