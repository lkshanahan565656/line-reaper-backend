// One-off: grade the live site's B wallets under the old and the new closing-line rules.
const axios = require('axios');
const OLD = require('./tail-old'), NEW = require('./tail-new');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
const http = { async get(url, opts = {}) { const w = last + 300 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
  for (let i = 0; ; i++) { try { return await axios.get(url, { timeout: 30000, ...opts }); } catch (e) { if (e?.response?.status === 429 && i < 5) { await sleep(4000 * (i + 1)); continue; } throw e; } } } };
const out = (name, v) => console.log(`==== ${name}\n${JSON.stringify(v)}\n====`);
const r2 = x => x == null ? null : Math.round(x * 1000) / 1000;
const brief = tr => tr && ({ grade: tr.grade, via: tr.via, n: tr.n, roi: r2(tr.roi), z: r2(tr.z), clv: r2(tr.clv), clvN: tr.clvN, hit: r2(tr.clvHitRate),
  cats: Object.fromEntries(Object.entries(tr.categories || {}).filter(([, c]) => c.grade || c.via).map(([k, c]) => [k, `${c.grade}/${c.via}`])),
  whyNotA: (tr.failedA || []).join(','), samples: (tr.clvSamples || []).slice(0, 6).map(x => `${x.rule}:${r2(x.entry)}→${r2(x.close)}=${r2(x.clv)} ${String(x.title).slice(0, 40)}`) });
async function main() {
  const list = (await axios.get('https://line-reaper-backend-production.up.railway.app/api/tail/traders', { params: { grade: 'B', limit: 100 }, timeout: 30000 })).data?.traders || [];
  out('live', { n: list.length, wallets: list.map(t => `${t.name}|${t.via}|${t.wallet}`) });
  const pick = list.filter(t => /^0x[0-9a-f]{40}$/i.test(t.wallet || '')).slice(0, Number(process.env.N || 16));
  const tally = { old: {}, new: {} };
  for (const t of pick) {
    const row = { name: t.name };
    for (const [tag, T] of [['old', OLD], ['new', NEW]]) {
      try {
        const eng = T.createTailEngine({ http, opts: { scoreConcurrency: 1 }, log: { warn: () => {} } });
        eng.addCandidate(t.wallet, { name: t.name, sources: ['diag'] });
        await eng.scoreBatch(1);
        const tr = eng.trader(t.wallet);
        row[tag] = brief(tr);
        const g = tr?.grade || (Object.values(tr?.categories || {}).some(c => c.grade) ? 'cat' : 'none');
        tally[tag][`${g}/${tr?.via || '-'}`] = (tally[tag][`${g}/${tr?.via || '-'}`] || 0) + 1;
      } catch (e) { row[tag] = { error: e.message }; }
    }
    out(`w-${t.name}`, row);
  }
  out('tally', tally);
}
main().catch(e => out('fatal', { m: e.message, stack: e.stack }));
