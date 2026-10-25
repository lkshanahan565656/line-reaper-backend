# retry ESPN core CBB propBets that answered 500 at limit=1000: smaller pages, providers 58 and 59
import json,urllib.request,gzip,os,time,collections,concurrent.futures as cf
def get(u,t=40):
    err=None
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read(),None
        except Exception as e:
            err=e
            if getattr(e,'code',0) in (404,400): break
            time.sleep(2+2*i)
    return None,getattr(err,'code',str(err))
ids=open('retry-ids.txt').read().split()
ev={e['id']:e for e in json.load(open('events.json'))}
census=collections.Counter()
def one(i):
    base=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/{i}/competitions/{i}/odds"
    out={'id':i,'date':ev.get(i,{}).get('date'),'season':ev.get(i,{}).get('season'),'providers':{}}
    for pid in ('58','59'):
        items=[];page=1;bad=None
        for lim in (100,25):
            items=[];page=1;bad=None
            while True:
                d,e=get(f"{base}/{pid}/propBets?limit={lim}&page={page}")
                if not d: bad=e; break
                j=json.loads(d); items+=j.get('items',[])
                if page>=j.get('pageCount',1): break
                page+=1
            if not bad: break
        census[f"{pid}:{'err '+str(bad) if bad else ('items' if items else 'empty')}"]+=1
        rows=[]
        for k,it in enumerate(items):
            a=(it.get('athlete') or {}).get('$ref')
            if not a: continue
            cu=it.get('current') or {}; op=it.get('open') or {}
            side='over' if 'over' in cu else 'under' if 'under' in cu else ('over' if 'over' in op else 'under' if 'under' in op else None)
            rows.append([k,a.split('/athletes/')[1].split('?')[0],(it.get('type') or {}).get('name'),side,
              (cu.get(side) or {}).get('decimal') if side else None,(cu.get('target') or {}).get('value'),
              (op.get(side) or {}).get('decimal') if side else None,(op.get('target') or {}).get('value'),it.get('lastUpdated')])
        if items and len(out['providers'])==0 and census['raw']<2:
            census['raw']+=1; open(f"out/raw-{i}-{pid}.json",'w').write(json.dumps(items[:5]))
        out['providers'][pid]={'n':len(items),'rows':rows}
    return out
os.makedirs('out',exist_ok=True)
with cf.ThreadPoolExecutor(8) as ex: res=list(ex.map(one,ids))
open('out/props-retry.jsonl.gz','wb').write(gzip.compress('\n'.join(json.dumps(r) for r in res).encode()))
print(dict(census),flush=True)
