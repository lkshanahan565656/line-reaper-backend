const fs=require('fs'),zlib=require('zlib');
const K='https://api.elections.kalshi.com/trade-api/v2';
const j=async(u,t)=>{try{const r=await fetch(u,{signal:AbortSignal.timeout(60000)});const x=await r.text();return {s:r.status,x}}catch(e){return {s:-1,x:String(e)}}};
(async()=>{
  const d=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/cw.json.gz')));
  const ser=[...new Set(d.filter(r=>/^KX(HIGH|LOWT)/.test(r.s)).map(r=>r.s))];
  const meta={};
  for(const s of ser){const r=await j(`${K}/series/${s}`);try{const o=JSON.parse(r.x).series;meta[s]={title:o.title,src:o.settlement_sources,ft:o.fee_type,fm:o.fee_multiplier,contract:o.contract_url};}catch(e){meta[s]={err:r.s}}}
  fs.writeFileSync('out/series.json',JSON.stringify(meta,null,1));
  console.log(JSON.stringify(meta[ser[0]]));
  for(const u of [
   'https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KAUS&model=NBS&sts=2026-09-18T00:00Z&ets=2026-09-18T13:00Z&format=csv',
   'https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KAUS&model=GFS&sts=2026-09-18T00:00Z&ets=2026-09-18T13:00Z&format=csv',
   'https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KAUS&model=NBE&sts=2026-09-18T00:00Z&ets=2026-09-18T13:00Z&format=csv',
   'https://mesonet.agron.iastate.edu/json/cli.py?station=KAUS&year=2026',
   'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=AUS&data=tmpf&data=max_temp_6hr_c&year1=2026&month1=9&day1=18&year2=2026&month2=9&day2=19&tz=Etc/UTC&format=onlycomma&latlon=no&report_type=3&report_type=4',
   'https://mesonet.agron.iastate.edu/api/1/mos.json?station=KAUS&model=NBS&runtime=2026-09-18T12:00Z',
  ]){const r=await j(u);console.log('\n==',u,r.s,r.x.length);console.log(r.x.slice(0,1500));}
  // live depth on open KXHIGH markets
  const ev=await j(`${K}/events?series_ticker=KXHIGHNY&status=open&with_nested_markets=true`);
  try{const es=JSON.parse(ev.x).events;for(const e of es.slice(0,2))for(const m of e.markets){const ob=await j(`${K}/markets/${m.ticker}/orderbook?depth=10`);console.log(m.ticker,m.yes_ask,m.yes_bid,ob.x.slice(0,400));}}catch(e){console.log('ob err',e,ev.x.slice(0,300))}
})();
