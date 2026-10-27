# NBA official injury reports (every 15-minute slot) 2026-10-21..10-25 ET, raw text per report,
# plus ESPN's injury list and NBA news feed now (their fields), for the injury-stale lane.
import json,urllib.request,os,time,io,subprocess,sys,concurrent.futures as cf
import pdfplumber
def get(u,t=40):
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=t).read()
        except Exception as e:
            if getattr(e,'code',0) in (403,404): return None
            time.sleep(2)
    return None
os.makedirs('out/pdf',exist_ok=True)
slots=[]
for d in ['2026-10-25','2026-10-26']:
    for h in list(range(9,12))+[12]+list(range(1,12)):
        ap='AM' if h in (9,10,11) else 'PM'
        for m in ('00','15','30','45'):
            slots.append((d,f"{h:02d}_{m}{ap}"))
            if m=='00': slots.append((d,f"{h:02d}{ap}"))
def one(s):
    d,tag=s
    u=f"https://ak-static.cms.nba.com/referee/injury/Injury-Report_{d}_{tag}.pdf"
    b=get(u)
    if not b: return None
    try:
        with pdfplumber.open(io.BytesIO(b)) as pdf: txt='\n'.join((p.extract_text() or '') for p in pdf.pages)
    except Exception as e: txt='ERR '+str(e)
    open(f"out/pdf/{d}_{tag}.txt",'w').write(txt)
    return f"{d}_{tag}"
with cf.ThreadPoolExecutor(8) as ex: found=[x for x in ex.map(one,slots) if x]
print('slots',len(slots),'found',len(found),sorted(found),flush=True)
for name,u in [('espn-injuries','https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries'),
               ('espn-news','https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50'),
               ('espn-scoreboard','https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261025')]:
    b=get(u); open(f'out/{name}.json','wb').write(b or b'null'); print(name,len(b or b''))

L='https://line-reaper-backend-production.up.railway.app'
for name,u in [('live-injury',L+'/api/props/injury'),('live-ops',L+'/api/ops'),('live-record',L+'/api/props/record')]:
    b=get(u,60); open(f'out/{name}.json','wb').write(b or b'null'); print(name,len(b or b''))
