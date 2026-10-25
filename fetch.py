# Player prop odds ESPN's core API keeps per NBA game (ESPN BET 58/59 in 2024-25, DraftKings 100 later):
# every finished game 2024-10 .. now, compacted to athlete props only.
import json,urllib.request,gzip,os,time,concurrent.futures as cf,collections
def get(u,t=60):
    err=None
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            err=e
            if getattr(e,'code',0) in (404,400): return None
            time.sleep(2+3*i)
    print('ERR',u,err,flush=True); return None
ev=json.load(open('events.json'))
ev=[e for e in ev if e['done']]
os.makedirs('out/props',exist_ok=True)
census=collections.Counter(); raw_saved=[0]
def one(e):
    f=f"out/props/{e['id']}.json.gz"
    if os.path.exists(f): return
    base=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{e['id']}/competitions/{e['id']}/odds"
    d=get(base)
    if not d: census['no-odds']+=1; return
    provs=[it['$ref'].split('/odds/')[1].split('?')[0] for it in json.loads(d).get('items',[])]
    out={'id':e['id'],'date':e['date'],'providers':{}}
    for pid in provs:
        if pid not in ('58','100'): continue
        gl=get(f"{base}/{pid}")
        if gl:
            g=json.loads(gl); out.setdefault('game',{})[pid]={'details':g.get('details'),'spread':g.get('spread'),'overUnder':g.get('overUnder'),
              'homeFav':(g.get('homeTeamOdds') or {}).get('favorite'),'awayFav':(g.get('awayTeamOdds') or {}).get('favorite')}
        items=[];page=1
        while True:
            pb=get(f"{base}/{pid}/propBets?limit=1000&page={page}")
            if not pb: break
            j=json.loads(pb); items+=j.get('items',[])
            if page>=j.get('pageCount',1): break
            page+=1
        if False and items and raw_saved[0]<3 and any('athlete' in it for it in items):
            raw_saved[0]+=1; open(f"out/raw-{e['id']}-{pid}.json",'w').write(json.dumps(items))
        rows=[]
        for i,it in enumerate(items):
            a=it.get('athlete',{}).get('$ref')
            if not a: continue
            o=it.get('odds',{})
            cu=it.get('current') or {}; op=it.get('open') or {}
            side='over' if 'over' in cu else 'under' if 'under' in cu else ('over' if 'over' in op else 'under' if 'under' in op else None)
            rows.append([i,a.split('/athletes/')[1].split('?')[0],it.get('type',{}).get('name'),side,
              (cu.get(side) or {}).get('decimal') if side else None,(cu.get('target') or {}).get('value'),
              (op.get(side) or {}).get('decimal') if side else None,(op.get('target') or {}).get('value'),it.get('lastUpdated')])
        out['providers'][pid]={'n':len(items),'rows':rows}
        census[f"{pid}:{'props' if rows else 'none'}"]+=1
    open(f,'wb').write(gzip.compress(json.dumps(out).encode()))
with cf.ThreadPoolExecutor(10) as ex: list(ex.map(one,ev))
print(dict(census),flush=True)
