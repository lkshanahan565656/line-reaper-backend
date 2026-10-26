import fs from 'fs';
const A='https://api.gemini.com'; const out={};
const qs=['status=settled&limit=50','status=settled&sport=american_football&limit=5','status=settled&sport=american_football&sports_market_type=moneyline&limit=20','status=settled&category=Sports&limit=50','status=settled&search=NFL&limit=50','status=settled&sport=american_football&sports_market_type=moneyline&sports_market_scope=full_contest&limit=20&offset=0'];
for (const q of qs) { const r=await fetch(`${A}/v1/prediction-markets/events?${q}`); const t=await r.text(); let j=null; try{j=JSON.parse(t)}catch{}; out[q]={status:r.status, n:j?.data?.length, pag:j?.pagination, tickers:(j?.data||[]).map(e=>e.ticker+' '+e.startTime).slice(0,50), txt:j?null:t.slice(0,300)}; await new Promise(r=>setTimeout(r,800)); }
fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/probe2.json',JSON.stringify(out,null,1)); console.log(JSON.stringify(out).slice(0,4000));
