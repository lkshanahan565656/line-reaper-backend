# CBB model data: every ESPN men's D1 game 2023-24..2025-26 (slim box with
# position, starter, DNP reason, pickcenter) and, for 2024-25 and 2025-26,
# the player props ESPN's core API keeps (ESPN BET 58, DraftKings 100).
# One short run, no recorder. PART=box or PART=props.
import json,urllib.request,gzip,os,datetime,time,sys,collections,concurrent.futures as cf
PART=os.environ.get('PART','box')
def get(u,t=40):
    err=None
    for i in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            err=e
            if getattr(e,'code',0) in (404,400): return None
            time.sleep(2+3*i)
    print('ERR',u,err,flush=True); return None
D=datetime.date
SEASONS={2024:(D(2023,11,1),D(2024,4,10)),2025:(D(2024,11,1),D(2025,4,10)),2026:(D(2025,11,1),D(2026,4,10))}
if PART=='props': SEASONS={k:v for k,v in SEASONS.items() if k>=2025}
SB='https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball'
def sb(arg):
    season,ds=arg
    d=get(f"{SB}/scoreboard?dates={ds}&groups=50&limit=500"); out=[]
    if not d: return out
    for e in json.loads(d).get('events',[]):
        c=e['competitions'][0]
        out.append(dict(id=e['id'],date=e['date'],season=season,stype=(e.get('season') or {}).get('type'),done=c['status']['type'].get('completed'),
          teams=[{'id':(x.get('team') or {}).get('id'),'abbr':(x.get('team') or {}).get('abbreviation'),'name':(x.get('team') or {}).get('displayName'),'ha':x.get('homeAway'),'score':x.get('score')} for x in c.get('competitors',[])],
          neutral=c.get('neutralSite'),conf=c.get('conferenceCompetition'),odds=[{k:o.get(k) for k in ('details','overUnder','spread')} for o in (c.get('odds') or [])]))
    return out
days=[]
for s,(a,b) in SEASONS.items():
    d=a
    while d<=b: days.append((s,d.strftime('%Y%m%d'))); d+=datetime.timedelta(days=1)
idx=[]
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(sb,days): idx+=r
seen=set(); idx=[e for e in idx if not (e['id'] in seen or seen.add(e['id']))]
os.makedirs('out',exist_ok=True)
json.dump(idx,open('out/events.json','w')); print('events',len(idx),'done',sum(1 for e in idx if e['done']),collections.Counter(e['season'] for e in idx),flush=True)
done=[e for e in idx if e['done']]
def slimath(a):
    at=a.get('athlete') or {}
    return {'athlete':{'id':at.get('id'),'displayName':at.get('displayName'),'pos':(at.get('position') or {}).get('abbreviation')},
            'starter':a.get('starter'),'didNotPlay':a.get('didNotPlay'),'reason':a.get('reason'),'ejected':a.get('ejected'),'stats':a.get('stats')}
def bx(e):
    d=get(f"{SB}/summary?event={e['id']}")
    if not d: return None
    j=json.loads(d)
    pl=[]
    for t in j.get('boxscore',{}).get('players',[]):
        tm=t.get('team') or {}
        pl.append({'team':{'abbreviation':tm.get('abbreviation'),'id':tm.get('id')},'statistics':[{'keys':g.get('keys'),'athletes':[slimath(a) for a in g.get('athletes',[])]} for g in t.get('statistics',[])]})
    comp=(j.get('header',{}).get('competitions') or [{}])[0]
    comp={'id':comp.get('id'),'date':comp.get('date'),'neutralSite':comp.get('neutralSite'),'competitors':[{'homeAway':c.get('homeAway'),'score':c.get('score'),'team':{'abbreviation':(c.get('team') or {}).get('abbreviation'),'id':(c.get('team') or {}).get('id')}} for c in comp.get('competitors',[])]}
    pc=[{k:p.get(k) for k in ('details','overUnder','spread')}|{'homeTeamOdds':{'favorite':(p.get('homeTeamOdds') or {}).get('favorite')},'awayTeamOdds':{'favorite':(p.get('awayTeamOdds') or {}).get('favorite')}} for p in (j.get('pickcenter') or [])]
    return {'id':e['id'],'season':e['season'],'stype':e.get('stype'),'players':pl,'comp':comp,'pickcenter':pc}
census=collections.Counter()
def pr(e):
    base=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/{e['id']}/competitions/{e['id']}/odds"
    d=get(base)
    if not d: census['no-odds']+=1; return None
    provs=[it['$ref'].split('/odds/')[1].split('?')[0] for it in json.loads(d).get('items',[])]
    for p in provs: census['prov:'+p]+=1
    out={'id':e['id'],'date':e['date'],'season':e['season'],'providers':{},'game':{}}
    for pid in provs:
        gl=get(f"{base}/{pid}")
        if gl:
            g=json.loads(gl); out['game'][pid]={'details':g.get('details'),'spread':g.get('spread'),'overUnder':g.get('overUnder'),
              'homeFav':(g.get('homeTeamOdds') or {}).get('favorite'),'awayFav':(g.get('awayTeamOdds') or {}).get('favorite')}
        if pid not in ('58','100'): continue
        items=[];page=1
        while True:
            pb=get(f"{base}/{pid}/propBets?limit=1000&page={page}")
            if not pb: break
            j=json.loads(pb); items+=j.get('items',[])
            if page>=j.get('pageCount',1): break
            page+=1
        rows=[]
        for i,it in enumerate(items):
            a=(it.get('athlete') or {}).get('$ref')
            if not a: continue
            cu=it.get('current') or {}; op=it.get('open') or {}
            side='over' if 'over' in cu else 'under' if 'under' in cu else ('over' if 'over' in op else 'under' if 'under' in op else None)
            rows.append([i,a.split('/athletes/')[1].split('?')[0],(it.get('type') or {}).get('name'),side,
              (cu.get(side) or {}).get('decimal') if side else None,(cu.get('target') or {}).get('value'),
              (op.get(side) or {}).get('decimal') if side else None,(op.get('target') or {}).get('value'),it.get('lastUpdated')])
        out['providers'][pid]={'n':len(items),'rows':rows}
        census[f"{pid}:{e['season']}:{'props' if rows else 'none'}"]+=1
    return out
fn=bx if PART=='box' else pr
res=collections.defaultdict(list)
with cf.ThreadPoolExecutor(10) as ex:
    for e,r in zip(done,ex.map(fn,done)):
        if r: res[e['season']].append(r)
for s,rs in res.items():
    open(f"out/{PART}-{s}.jsonl.gz",'wb').write(gzip.compress('\n'.join(json.dumps(r) for r in rs).encode()))
    print(PART,s,len(rs),flush=True)
print(dict(census),flush=True)
