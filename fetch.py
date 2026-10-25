# Pre-game game lines (spread, total) for every ESPN FBS game 2023-2025 from the core API odds providers
import json,urllib.request,os,time,concurrent.futures as cf
def get(u,t=40):
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            if getattr(e,'code',0) in (404,400): return None
            time.sleep(2+3*i)
    return None
S='https://site.api.espn.com/apis/site/v2/sports/football/college-football'
C='https://sports.core.api.espn.com/v2/sports/football/leagues/college-football'
jobs=[(y,2,w) for y in (2023,2024,2025) for w in range(1,17)]+[(y,3,1) for y in (2023,2024,2025)]
def sb(j):
    y,st,w=j
    d=get(f"{S}/scoreboard?groups=80&dates={y}&seasontype={st}&week={w}&limit=300")
    return [e['id'] for e in json.loads(d).get('events',[])] if d else []
ids=[]
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(sb,jobs): ids+=r
ids=sorted(set(ids)); print('events',len(ids),flush=True)
def lines(eid):
    base=f"{C}/events/{eid}/competitions/{eid}/odds"
    d=get(base)
    if not d: return eid,[]
    out=[]
    for it in json.loads(d).get('items',[])[:6]:
        ref=it.get('$ref')
        if not ref: continue
        x=get(ref.replace('http://','https://'))
        if not x: continue
        j=json.loads(x)
        ho,ao=j.get('homeTeamOdds') or {},j.get('awayTeamOdds') or {}
        out.append({'provider':(j.get('provider') or {}).get('name'),'pid':(j.get('provider') or {}).get('id'),'details':j.get('details'),'spread':j.get('spread'),'overUnder':j.get('overUnder'),
          'homeFav':ho.get('favorite'),'awayFav':ao.get('favorite'),
          'open':{'spread':((ho.get('open') or {}).get('pointSpread') or {}).get('american'),'total':((j.get('open') or {}).get('total') or {}).get('american') if isinstance(j.get('open'),dict) else None}})
    return eid,out
res={}
with cf.ThreadPoolExecutor(12) as ex:
    for eid,o in ex.map(lines,ids): res[eid]=o
os.makedirs('out',exist_ok=True)
json.dump(res,open('out/lines.json','w'))
print('with lines',sum(1 for v in res.values() if v),flush=True)
