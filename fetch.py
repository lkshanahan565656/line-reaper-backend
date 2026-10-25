# CFB model data: every ESPN FBS game 2024, 2025, 2026 to date (box, header, pickcenter),
# plus ESPN core-API player prop lines (propBets) kept per game.
import json,urllib.request,gzip,os,time,concurrent.futures as cf
def get(u,t=40,quiet=False):
    err=None
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            err=e
            if getattr(e,'code',0) in (404,400): break
            time.sleep(2+3*i)
    if not quiet: print('ERR',u,err,flush=True)
    return None
os.makedirs('out/box',exist_ok=True); os.makedirs('out/props',exist_ok=True)
S='https://site.api.espn.com/apis/site/v2/sports/football/college-football'
C='https://sports.core.api.espn.com/v2/sports/football/leagues/college-football'
jobs=[(y,2,w) for y in (2024,2025,2026) for w in range(1,17)]+[(y,3,1) for y in (2024,2025)]
def sb(j):
    y,st,w=j
    d=get(f"{S}/scoreboard?groups=80&dates={y}&seasontype={st}&week={w}&limit=300"); out=[]
    if not d: return out
    for e in json.loads(d).get('events',[]):
        c=e['competitions'][0]
        out.append(dict(id=e['id'],date=e['date'],season=y,stype=st,week=w,done=c['status']['type'].get('completed'),neutral=c.get('neutralSite'),
          teams=[dict(id=t['team'].get('id'),abbr=t['team'].get('abbreviation'),name=t['team'].get('displayName'),ha=t.get('homeAway'),score=t.get('score')) for t in c['competitors']]))
    return out
idx=[]
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(sb,jobs): idx+=r
seen=set(); idx=[e for e in idx if not (e['id'] in seen or seen.add(e['id']))]
json.dump(idx,open('out/events.json','w')); print('events',len(idx),'done',sum(1 for e in idx if e['done']),flush=True)
def bx(e):
    f=f"out/box/{e['id']}.json.gz"
    if not e['done'] or os.path.exists(f): return 0
    d=get(f"{S}/summary?event={e['id']}")
    if not d: return 0
    j=json.loads(d)
    slim={'id':e['id'],'players':j.get('boxscore',{}).get('players',[]),'teams':j.get('boxscore',{}).get('teams',[]),
          'comp':(j.get('header',{}).get('competitions') or [{}])[0],'pickcenter':j.get('pickcenter'),'odds':j.get('odds'),
          'againstTheSpread':j.get('againstTheSpread')}
    open(f,'wb').write(gzip.compress(json.dumps(slim).encode())); return 1
with cf.ThreadPoolExecutor(10) as ex: n=sum(ex.map(bx,idx))
print('boxes',n,flush=True)
def slim(it):
    o=it.get('odds') or {}
    return [it.get('athlete',{}).get('$ref','').split('/athletes/')[-1].split('?')[0], (it.get('type') or {}).get('name'),
            (o.get('american') or {}).get('value'),(o.get('american') or {}).get('open'),(o.get('total') or {}).get('value'),(o.get('total') or {}).get('open'),
            ((it.get('current') or {}).get('target') or {}).get('value'), it.get('lastUpdated')]
def props(e):
    f=f"out/props/{e['id']}.json.gz"
    if os.path.exists(f): return 0
    base=f"{C}/events/{e['id']}/competitions/{e['id']}/odds"
    d=get(base,quiet=True)
    if not d: return 0
    refs=[it.get('$ref') for it in json.loads(d).get('items',[])]
    ent={}
    for ref in refs:
        pid=ref.split('/odds/')[1].split('?')[0]; items=[]; page=1
        while True:
            pb=get(f"{base}/{pid}/propBets?limit=1000&page={page}",quiet=True)
            if not pb: break
            j=json.loads(pb); items+= [slim(x) for x in j.get('items',[])]
            if page>=(j.get('pageCount') or 1): break
            page+=1
        if items: ent[pid]=items
    open(f,'wb').write(gzip.compress(json.dumps(ent).encode())); return 1 if ent else 0
with cf.ThreadPoolExecutor(10) as ex: n=sum(ex.map(props,[e for e in idx if e['done']]))
print('props games',n,flush=True)
