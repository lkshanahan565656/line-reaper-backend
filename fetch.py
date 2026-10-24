import json,urllib.request,gzip,os,sys,datetime,time,concurrent.futures as cf
S,A,B=sys.argv[1],sys.argv[2],sys.argv[3]
L={'NBA':'basketball/nba','NFL':'football/nfl','CFB':'football/college-football','NHL':'hockey/nhl','MLB':'baseball/mlb'}
def get(u,t=40):
    err=None
    for i in range(5):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e: err=e; time.sleep(2+4*i)
    print('ERR',u,err,flush=True); return None
d=datetime.date.fromisoformat(A); b=datetime.date.fromisoformat(B); days=[]
while d<=b: days.append(d.strftime('%Y%m%d')); d+=datetime.timedelta(days=1)
def sb(ds):
    u=f"https://site.api.espn.com/apis/site/v2/sports/{L[S]}/scoreboard?dates={ds}&limit=400"+('&groups=80' if S=='CFB' else '')
    r=get(u); out=[]
    if not r: return out
    for e in json.loads(r).get('events',[]):
        c=e['competitions'][0]
        if not c['status']['type'].get('completed'): continue
        out.append(dict(id=e['id'],date=e['date'],season=e.get('season',{}),teams=[dict(id=t['team'].get('id'),abbr=t['team'].get('abbreviation'),ha=t.get('homeAway'),score=t.get('score')) for t in c['competitors']]))
    return out
idx=[]
with cf.ThreadPoolExecutor(6) as ex:
    for r in ex.map(sb,days): idx+=r
seen=set(); idx=[e for e in idx if not (e['id'] in seen or seen.add(e['id']))]
print('events',len(idx),flush=True)
def slim(j):
    cats={}
    for tm in j.get('boxscore',{}).get('players',[]):
        tid=tm.get('team',{}).get('id'); C={}
        for st in tm.get('statistics',[]):
            name=st.get('name') or st.get('text') or str(len(C))
            keys=st.get('keys') or st.get('labels') or []
            ath=[]
            for a in st.get('athletes',[]):
                at=a.get('athlete',{}) or {}
                extra={k:v for k,v in a.items() if k not in('athlete','stats','links') and not isinstance(v,(dict,list))}
                ath.append([at.get('id'),at.get('displayName'),(at.get('position') or {}).get('abbreviation'),extra,a.get('stats',[])])
            if name in C: name=name+'_'+str(len(C))
            C[name]={'keys':keys,'ath':ath}
        cats[tid]=C
    return cats
def bx(e):
    r=get(f"https://site.api.espn.com/apis/site/v2/sports/{L[S]}/summary?event={e['id']}")
    if not r: return None
    try: j=json.loads(r)
    except Exception: return None
    e=dict(e); e['box']=slim(j); return e
os.makedirs('out',exist_ok=True); n=0
with gzip.open(f'out/{S}-{A[:4]}.jsonl.gz','wt') as f, cf.ThreadPoolExecutor(10) as ex:
    for e in ex.map(bx,idx):
        if e and e['box']: f.write(json.dumps(e,separators=(',',':'))+'\n'); n+=1
print('boxes',n,flush=True)
