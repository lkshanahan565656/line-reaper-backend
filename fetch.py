# probe: 30 CBB games whose propBets answered 500; one try each, every page size; print codes and a sample
import json,urllib.request,urllib.error
ids=open('retry-ids.txt').read().split()[::50][:30]
def get(u):
    try: return 200,urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=30).read()
    except urllib.error.HTTPError as e: return e.code,e.read()[:300]
    except Exception as e: return str(e),b''
for i in ids:
    base=f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/{i}/competitions/{i}/odds"
    for pid in ('58','59'):
        for lim in (1000,100,10):
            c,b=get(f"{base}/{pid}/propBets?limit={lim}")
            n=None
            if c==200:
                j=json.loads(b);n=(j.get('count'),len(j.get('items',[])));
                if j.get('items'): print('SAMPLE',json.dumps(j['items'][0])[:800])
            print(i,pid,lim,c,n,b[:120] if c!=200 else '',flush=True)
            if c==200: break
