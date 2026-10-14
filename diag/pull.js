// Pull free NWS data for Kalshi temperature stations from the Iowa Environmental Mesonet:
// CLI daily highs/lows, NBM text (NBS) forecasts, ASOS hourly obs. Polite: one request at a time.
const fs=require('fs'),zlib=require('zlib');
const K='https://api.elections.kalshi.com/trade-api/v2';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let last=0;
async function get(u,{iem=true}={}){for(let i=0;i<8;i++){if(iem){const w=last+2500-Date.now();if(w>0)await sleep(w);last=Date.now();}
 try{const r=await fetch(u,{signal:AbortSignal.timeout(180000)});if(r.status===429||r.status>=500){console.log('retry',r.status,u.slice(0,120));await sleep(15000*(i+1));continue;}const t=await r.text();return {s:r.status,t};}catch(e){console.log('err',String(e).slice(0,100));await sleep(10000*(i+1));}}return {s:-1,t:''};}
const ST={AUS:'KAUS',CHI:'KMDW',DEN:'KDEN',LAX:'KLAX',MIA:'KMIA',NY:'KNYC',NYC:'KNYC',PHIL:'KPHL',DAL:'KDFW',DC:'KDCA',SFO:'KSFO',PHX:'KPHX',NOLA:'KMSY',TTN:'KTTN',MIN:'KMSP',ATL:'KATL',LV:'KLAS',OKC:'KOKC',SEA:'KSEA',SDF:'KSDF',SATX:'KSAT',BOS:'KBOS',HOU:'KHOU',EWR:'KEWR',SAN:'KSAN'};
(async()=>{
 fs.mkdirSync('cache',{recursive:true});
 const d=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/cw.json.gz')));
 const ser=[...new Set(d.filter(r=>/^KX(HIGH|LOWT)/.test(r.s)).map(r=>r.s))];
 // rules text: which station each series settles on
 if(!fs.existsSync('cache/rules.json')){const rules={};for(const s of ser){const t=d.find(r=>r.s===s).t;const r=await get(`${K}/markets/${t}`,{iem:false});try{const m=JSON.parse(r.t).market;rules[s]={p:m.rules_primary,s:m.rules_secondary};}catch(e){rules[s]={err:r.s}}}
  fs.writeFileSync('cache/rules.json',JSON.stringify(rules,null,1));}
 const rules=JSON.parse(fs.readFileSync('cache/rules.json'));for(const s of ser.slice(0,3))console.log(s,JSON.stringify(rules[s]).slice(0,700));
 const stations=[...new Set(Object.values(ST))];
 // CLI
 for(const st of stations)for(const y of [2024,2025,2026]){const f=`cache/cli-${st}-${y}.json`;if(fs.existsSync(f))continue;const r=await get(`https://mesonet.agron.iastate.edu/json/cli.py?station=${st}&year=${y}`);
  if(r.s===200){try{const j=JSON.parse(r.t).results.map(x=>({d:x.valid,hi:x.high,lo:x.low,ht:x.high_time,lt:x.low_time,p:x.product}));fs.writeFileSync(f,JSON.stringify(j));}catch(e){console.log('cli parse',st,y)}}else console.log('cli',st,y,r.s);}
 console.log('cli done');
 // ASOS hourly obs Aug 2025 - now
 for(const st of stations){const f=`cache/asos-${st}.csv.gz`;if(fs.existsSync(f))continue;const s3=st.slice(1);
  const r=await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${s3}&data=tmpf&data=max_temp_6hr_c&year1=2025&month1=8&day1=1&year2=2026&month2=10&day2=15&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&report_type=3&report_type=4`);
  if(r.s===200)fs.writeFileSync(f,zlib.gzipSync(r.t));console.log('asos',st,r.s,r.t.length);}
 // NBS: probe runtimes
 {const r=await get('https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KNYC&model=NBS&sts=2026-09-18T00:00Z&ets=2026-09-19T00:00Z&format=csv');const rt=new Set(r.t.split('\n').slice(1).map(l=>l.split(',')[0]));console.log('NBS runtimes in a day',[...rt].join(' '),'bytes',r.t.length);}
 const months=[];for(const [y,m] of [[2025,8],[2025,9],[2025,10],[2025,11],[2026,4],[2026,5],[2026,6],[2026,7],[2026,8],[2026,9],[2026,10]])months.push([y,m]);
 const KEEP=['runtime','ftime','tmp','txn','xnd','tsd'];
 for(const st of stations)for(const [y,m] of months){const f=`cache/nbs-${st}-${y}-${m}.json.gz`;if(fs.existsSync(f))continue;
  const sts=`${y}-${String(m).padStart(2,'0')}-01T00:00Z`,e=new Date(Date.UTC(y,m,1)).toISOString().slice(0,16)+'Z';
  const r=await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${st}&model=NBS&sts=${sts}&ets=${e}&format=csv`);
  if(r.s!==200){console.log('nbs',st,y,m,r.s);continue;}
  const L=r.t.trim().split('\n'),h=L[0].split(','),ix=KEEP.map(k=>h.indexOf(k));const rows=[];
  for(const l of L.slice(1)){const c=l.split(',');const rt=c[ix[0]];if(!/ (00|06|12|18):00/.test(rt))continue;rows.push(ix.map(i=>c[i]));}
  fs.writeFileSync(f,zlib.gzipSync(JSON.stringify(rows)));console.log('nbs',st,y,m,L.length,rows.length);}
 console.log('all done');
})();
