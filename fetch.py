# Every graded Pick6 leg on the live record (each p6 kind and the research kinds), and each game's ESPN box score
import json, urllib.request, urllib.parse, os, gzip, time
B='https://line-reaper-backend-production.up.railway.app'
def get(u):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent':'diag'}), timeout=90) as r: return json.loads(r.read())
        except Exception as e: print('retry', u, e); time.sleep(5)
    return None
os.makedirs('out/box', exist_ok=True)
legs={}
for kind in ['p6-sharp','p6-ev','p6-gap','p6-sharp3','p6-book-fair','p6-book-fair-single','p6-book-consensus','p6-stale','p6-stale-single','gap-odd','gap-stale']:
    before=None
    for page in range(30):
        q={'kind':kind,'status':'graded','limit':1000}
        if before: q['before']=before
        d=get(B+'/api/props/record/picks?'+urllib.parse.urlencode(q))
        ps=(d or {}).get('picks') or []
        for p in ps: legs[p['id']+'|'+p['kind']]=p
        if len(ps)<1000: break
        before=ps[-1]['signalAt']
    print(kind, sum(1 for v in legs.values() if v['kind']==kind))
json.dump(list(legs.values()), open('out/legs.json','w'))
L={'NFL':'football/nfl','CFB':'football/college-football','NBA':'basketball/nba','WNBA':'basketball/wnba','NHL':'hockey/nhl','MLB':'baseball/mlb'}
ev={(l['sport'],l.get('eventId')) for l in legs.values() if l.get('eventId') and l['sport'] in L and (l['book']=='pick6' or l['kind'].startswith('p6-'))}
print('boxes', len(ev))
for s,e in ev:
    d=get(f'https://site.api.espn.com/apis/site/v2/sports/{L[s]}/summary?event={e}')
    if d: open(f'out/box/{s}-{e}.json.gz','wb').write(gzip.compress(json.dumps({'boxscore':d.get('boxscore')}).encode()))
st=get(B+'/api/status'); print('version', (st or {}).get('version'))
