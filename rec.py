# Raw Pinnacle close recorder for the apps' stale legs: every 4 min, for each
# open/locked stale leg starting within 80 min (or started under 10 min ago),
# save the site's Pinnacle line history for its subject (Pinnacle's own number
# and no-vig chance at each read, plus each app's line).
import json, time, urllib.parse, datetime as D, urllib.request, os, sys
B = 'https://line-reaper-backend-production.up.railway.app'
END = time.time() + float(sys.argv[1]) * 60
def get(u, t=120):
    try:
        with urllib.request.urlopen(urllib.request.Request(B + u, headers={'User-Agent': 'diag'}), timeout=t) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
P = lambda s: D.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
dayOf = lambda s: D.datetime.utcfromtimestamp(P(s) - 6 * 3600).strftime('%Y-%m-%d')
os.makedirs('out/h', exist_ok=True)
while time.time() < END:
    now = time.time(); legs = []
    for st in ('open', 'locked'):
        legs += [p for p in get(f'/api/props/record/picks?status={st}&limit=1000').get('picks', []) if p.get('kind') in ('stale', 'stale-single', 'p6-stale', 'p6-stale-single')]
    keys = {}
    for p in legs:
        s = P(p['start'])
        if -600 < s - now < 80 * 60:
            sp, canon, mkey = p['id'].split('|')[:3]
            keys[f'{sp}|{canon}|{mkey}|{dayOf(p["start"])}'] = p['id']
    stamp = D.datetime.utcnow().strftime('%Y%m%dT%H%M%S')
    out = {'at': stamp, 'legs': [p['id'] for p in legs], 'hist': {}}
    for k in keys: out['hist'][k] = get('/api/stale/history?key=' + urllib.parse.quote(k), 60)
    json.dump(out, open(f'out/h/{stamp}.json', 'w'))
    json.dump(legs, open('out/legs-latest.json', 'w'))
    print(stamp, len(legs), len(keys), flush=True)
    time.sleep(max(5, 240 - (time.time() - now)))
