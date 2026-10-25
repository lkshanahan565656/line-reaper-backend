# NBA model data: every ESPN NBA game 2024-10-22 .. today (box, header, pickcenter, injuries),
# plus a probe of ESPN's core-API player prop odds for a few past games.
import json,urllib.request,gzip,os,datetime,time,concurrent.futures as cf,sys
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
D=datetime.date
R=[(D(2024,10,4),D(2025,6,25)),(D(2025,10,2),D(2026,6,25)),(D(2026,10,2),datetime.datetime.utcnow().date())]
os.makedirs('out/box',exist_ok=True)
days=[]
for a,b in R:
    d=a
    while d<=b: days.append(d.strftime('%Y%m%d')); d+=datetime.timedelta(days=1)
def sb(ds):
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={ds}&limit=100"); out=[]
    if not d: return out
    for e in json.loads(d).get('events',[]):
        c=e['competitions'][0]
        out.append(dict(id=e['id'],date=e['date'],stype=(e.get('season') or {}).get('type'),season=(e.get('season') or {}).get('year'),
          done=c['status']['type'].get('completed'),teams=[dict(id=t['team'].get('id'),abbr=t['team'].get('abbreviation'),name=t['team'].get('displayName'),ha=t.get('homeAway'),score=t.get('score')) for t in c['competitors']]))
    return out
idx=[]
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(sb,days): idx+=r
seen=set(); idx=[e for e in idx if not (e['id'] in seen or seen.add(e['id']))]
json.dump(idx,open('out/events.json','w')); print('events',len(idx),'done',sum(1 for e in idx if e['done']),flush=True)
def bx(e):
    f=f"out/box/{e['id']}.json.gz"
    if not e['done'] or os.path.exists(f): return 0
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={e['id']}")
    if not d: return 0
    j=json.loads(d)
    slim={'id':e['id'],'players':j.get('boxscore',{}).get('players',[]),'teams':j.get('boxscore',{}).get('teams',[]),
          'comp':(j.get('header',{}).get('competitions') or [{}])[0],'pickcenter':j.get('pickcenter'),'odds':j.get('odds'),
          'injuries':j.get('injuries'),'gameInfo':j.get('gameInfo')}
    open(f,'wb').write(gzip.compress(json.dumps(slim).encode())); return 1
with cf.ThreadPoolExecutor(10) as ex: n=sum(ex.map(bx,idx))
print('boxes',n,flush=True)
# Probe: ESPN core API player props on a few finished games each season
probe={}
done=[e for e in idx if e['done']]
pick=[done[50],done[600],done[1400],done[2000],done[-5],done[-30]] if len(done)>2100 else done[:3]
for e in pick:
    base=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{e['id']}/competitions/{e['id']}/odds"
    d=get(base,quiet=True); ent={'date':e['date'],'odds':None}
    if d:
        j=json.loads(d); ent['odds']=[it.get('$ref') for it in j.get('items',[])]
        for ref in ent['odds'][:6]:
            pid=ref.split('/odds/')[1].split('?')[0]
            pb=get(f"{base}/{pid}/propBets?limit=1000",quiet=True)
            ent[pid]=None if not pb else {'count':json.loads(pb).get('count'),'sample':json.loads(pb).get('items',[])[:3]}
    probe[e['id']]=ent
json.dump(probe,open('out/propprobe.json','w'),indent=1); print('probe done',flush=True)
