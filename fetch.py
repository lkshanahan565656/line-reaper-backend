# NBA model v2 data: every ESPN NBA game 2024-10-01 .. today, slim box with
# position, starter, DNP reason; plus pickcenter. One short run, no recorder.
import json,urllib.request,gzip,os,datetime,time,concurrent.futures as cf
def get(u,t=40):
    err=None
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            err=e
            if getattr(e,'code',0) in (404,400): break
            time.sleep(2+3*i)
    print('ERR',u,err,flush=True); return None
D=datetime.date
days=[];d=D(2024,10,1);end=datetime.datetime.utcnow().date()
while d<=end:
    if d.month not in (7,8,9) or d>=D(2026,9,25): days.append(d.strftime('%Y%m%d'))
    d+=datetime.timedelta(days=1)
def sb(ds):
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={ds}&limit=100"); out=[]
    if not d: return out
    for e in json.loads(d).get('events',[]):
        c=e['competitions'][0]
        out.append(dict(id=e['id'],date=e['date'],stype=(e.get('season') or {}).get('type'),done=c['status']['type'].get('completed')))
    return out
idx=[]
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(sb,days): idx+=r
seen=set(); idx=[e for e in idx if not (e['id'] in seen or seen.add(e['id']))]
os.makedirs('out/box',exist_ok=True)
json.dump(idx,open('out/events.json','w')); print('events',len(idx),'done',sum(1 for e in idx if e['done']),flush=True)
def slimath(a):
    at=a.get('athlete') or {}
    return {'athlete':{'id':at.get('id'),'displayName':at.get('displayName'),'pos':(at.get('position') or {}).get('abbreviation')},
            'starter':a.get('starter'),'didNotPlay':a.get('didNotPlay'),'reason':a.get('reason'),'ejected':a.get('ejected'),'stats':a.get('stats')}
def bx(e):
    f=f"out/box/{e['id']}.json.gz"
    if not e['done'] or e.get('stype')==1: return 0
    d=get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={e['id']}")
    if not d: return 0
    j=json.loads(d)
    pl=[]
    for t in j.get('boxscore',{}).get('players',[]):
        pl.append({'team':{'abbreviation':(t.get('team') or {}).get('abbreviation')},'statistics':[{'keys':g.get('keys'),'athletes':[slimath(a) for a in g.get('athletes',[])]} for g in t.get('statistics',[])]})
    comp=(j.get('header',{}).get('competitions') or [{}])[0]
    comp={'id':comp.get('id'),'date':comp.get('date'),'competitors':[{'homeAway':c.get('homeAway'),'score':c.get('score'),'team':{'abbreviation':(c.get('team') or {}).get('abbreviation')}} for c in comp.get('competitors',[])]}
    slim={'id':e['id'],'stype':e.get('stype'),'players':pl,'comp':comp,'pickcenter':j.get('pickcenter')}
    open(f,'wb').write(gzip.compress(json.dumps(slim).encode())); return 1
with cf.ThreadPoolExecutor(10) as ex: n=sum(ex.map(bx,idx))
print('boxes',n,flush=True)
