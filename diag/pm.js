const G='https://gateway.polymarket.us';
const out={at:new Date().toISOString(),leagues:{}};
(async()=>{
 for(const lg of ['lol','cs2','valorant']){
  try{const r=await fetch(`${G}/v2/leagues/${lg}/events?limit=50&offset=0`,{headers:{'User-Agent':'Mozilla/5.0'}});
   const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
   const ev=j&&Array.isArray(j.events)?j.events:[];
   out.leagues[lg]={status:r.status,n:ev.length,keys:j?Object.keys(j):null,sample:ev.slice(0,2),types:[...new Set(ev.flatMap(e=>(e.markets||[]).map(m=>m.sportsMarketType)))],titles:ev.slice(0,30).map(e=>[e.slug,e.title,e.startTime||e.startDate,e.closed,e.active,(e.markets||[]).length]),raw:j?null:t.slice(0,500)};
  }catch(e){out.leagues[lg]={error:String(e)}}
 }
 process.stdout.write(JSON.stringify(out));
})();
