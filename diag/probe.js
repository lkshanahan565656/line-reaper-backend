const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const out=[];const P=(...a)=>{const s=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(s);out.push(s);};
async function get(u,h={},text=false){try{const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(20000)});const b=await r.text();if(!r.ok)return {status:r.status,body:b.slice(0,300)};return text?b:JSON.parse(b);}catch(e){return {err:e.message}}}
const K='https://api.elections.kalshi.com/trade-api/v2';
const H3={origin:'https://bo3.gg',referer:'https://bo3.gg/','User-Agent':'Mozilla/5.0 (LineReaper research)',Accept:'application/json'};
const LK={'x-api-key':'0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'};
(async()=>{
 for(const s of ['KXCS2MAP','KXLOLMAP','KXDOTA2MAP','KXVALORANTMAP','KXCS2GAME']){
  const d=await get(`${K}/events?series_ticker=${s}&status=open&with_nested_markets=true&limit=50`);
  const evs=d.events||[];P('KALSHI',s,'open events',evs.length);
  if(evs[0])P(JSON.stringify(evs[0]).slice(0,1500));
  const m=evs[0]?.markets?.[0];
  if(m){const ob=await get(`${K}/markets/${m.ticker}/orderbook?depth=10`);P('OB',m.ticker,JSON.stringify(ob).slice(0,800));}
  const st=await get(`${K}/markets?series_ticker=${s}&status=settled&limit=5`);
  const sm=st.markets?.[0];if(sm){P('SETTLED',JSON.stringify(sm).slice(0,900));
   const tr=await get(`${K}/markets/trades?ticker=${sm.ticker}&limit=1000`);P('TRADES',sm.ticker,(tr.trades||[]).length,JSON.stringify((tr.trades||[]).slice(0,3)),'cursor',!!tr.cursor, JSON.stringify(tr).slice(0,200));}
 }
 const ht=await get(`${K}/historical/trades?ticker=KXCS2MAP-26JUL101700BHELARGA-1&limit=5`);P('HIST TRADES',JSON.stringify(ht).slice(0,400));
 // lolesports
 const live=await get('https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US',LK);P('LOL LIVE',JSON.stringify(live).slice(0,1500));
 const sch=await get('https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US',LK);
 const ev=(sch?.data?.schedule?.events||[]).filter(e=>e.state==='completed'&&e.match).slice(-1)[0];
 P('LOL last completed',JSON.stringify(ev).slice(0,600));
 if(ev){const det=await get(`https://esports-api.lolesports.com/persisted/gw/getEventDetails?hl=en-US&id=${ev.match.id}`,LK);
  const games=det?.data?.event?.match?.games||[];P('LOL games',JSON.stringify(games).slice(0,800));
  const g=games.find(x=>x.state==='completed');
  if(g){const st=Date.parse(ev.startTime);
   for(const off of [0,20,40,60]){const t=new Date(Math.floor((st+off*60e3)/10e3)*10e3).toISOString();const w=await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}?startingTime=${t}`,{'User-Agent':'Mozilla/5.0'});
    const fr=w.frames||[];P('LOL window off',off,'frames',fr.length,JSON.stringify(fr[0]||w).slice(0,900),'last',fr.length?fr[fr.length-1].rfc460Timestamp:'');}
   const w2=await get(`https://feed.lolesports.com/livestats/v1/window/${g.id}`,{'User-Agent':'Mozilla/5.0'});P('LOL window nostart',JSON.stringify(w2).slice(0,300));
  }}
 // opendota
 const ol=await get('https://api.opendota.com/api/live');P('OD LIVE n',Array.isArray(ol)?ol.length:ol, JSON.stringify(Array.isArray(ol)?ol.find(x=>x.league_id>0)||ol[0]:ol).slice(0,1500));
 const pm=await get('https://api.opendota.com/api/proMatches');
 if(Array.isArray(pm)){const id=pm[3].match_id;const md=await get(`https://api.opendota.com/api/matches/${id}`);P('OD match keys',Object.keys(md).join(','));P('OD gold adv',JSON.stringify(md.radiant_gold_adv).slice(0,300),'start',md.start_time,'dur',md.duration,'obj',JSON.stringify((md.objectives||[]).slice(0,5)).slice(0,500));}
 // bo3.gg
 const bl=await get('https://api.bo3.gg/api/v1/matches?page[limit]=5&filter[matches.status][in]=current&filter[matches.discipline_id][eq]=1',H3);P('BO3 live',JSON.stringify(bl).slice(0,2000));
 const bf=await get('https://api.bo3.gg/api/v1/matches?page[limit]=3&sort=-start_date&filter[matches.status][in]=finished&filter[matches.discipline_id][eq]=1',H3);
 const fm=bf.results?.[0];P('BO3 fin',JSON.stringify(fm).slice(0,800));
 if(fm){const gs=await get(`https://api.bo3.gg/api/v1/games?filter[games.match_id][eq]=${fm.id}`,H3);const g=gs.results?.[0];P('BO3 game',JSON.stringify(g).slice(0,1500));
  if(g){for(const u of [`https://api.bo3.gg/api/v1/games/${g.id}`,`https://api.bo3.gg/api/v1/games/${g.id}/rounds`,`https://api.bo3.gg/api/v1/rounds?filter[rounds.game_id][eq]=${g.id}`,`https://api.bo3.gg/api/v1/games/${g.id}?with=rounds`,`https://api.bo3.gg/api/v2/games/${g.id}/rounds`,`https://api.bo3.gg/api/v1/game_rounds?filter[game_rounds.game_id][eq]=${g.id}`,`https://api.bo3.gg/api/v1/games/${g.id}/round_results`,`https://api.bo3.gg/api/v1/matches/${fm.slug}?with=games,teams`]){const r=await get(u,H3);P('BO3 try',u,JSON.stringify(r).slice(0,1200));}}}
 // vlr
 const vh=await get('https://www.vlr.gg/matches',{'User-Agent':'Mozilla/5.0'},true);P('VLR matches len',String(vh).length, (String(vh).match(/mod-live[\s\S]{0,400}/)||[''])[0].slice(0,400));
 fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/probe.txt',out.join('\n'));
})();
