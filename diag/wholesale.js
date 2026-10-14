const fs=require('fs');fs.mkdirSync('data',{recursive:true});
(async()=>{for(const [n,u] of [
 ['yahoo-rb','https://query1.finance.yahoo.com/v8/finance/chart/RB=F?range=2y&interval=1d'],
 ['yahoo-cl','https://query1.finance.yahoo.com/v8/finance/chart/CL=F?range=2y&interval=1d'],
 ['stooq-rb','https://stooq.com/q/d/l/?s=rb.f&i=d'],
 ['eia-nyh','https://www.eia.gov/dnav/pet/hist_xls/EER_EPMRU_PF4_Y35NY_DPGd.xls'],
 ['eia-gulf','https://www.eia.gov/dnav/pet/hist_xls/EER_EPMRU_PF4_RGC_DPGd.xls'],
 ['eia-la','https://www.eia.gov/dnav/pet/hist_xls/EER_EPMRR_PF4_Y05LA_DPGd.xls'],
]){try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(60000)});const b=Buffer.from(await r.arrayBuffer());fs.writeFileSync('data/'+n+(u.endsWith('.xls')?'.xls':'.txt'),b);console.log(n,r.status,b.length,b.slice(0,200).toString().replace(/\s+/g,' '));}catch(e){console.log(n,'err',String(e))}}})();
