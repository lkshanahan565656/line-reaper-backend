# Stale-at-Pinnacle's-number recorder (v3.151.0 on). Every 2 min: for each open
# or locked stale leg (PP, UD, Sleeper, Pick6) starting within 90 min (or
# started under 10 min ago) save the site's Pinnacle line history for its
# subject, an outside copy of the raw close. Every 30 min: the site's daily
# check (/api/props/stale-exact) and the engine's lag table. Run 1 also lists
# which Pinnacle soccer leagues post player props.
import json, time, urllib.parse, datetime as D, urllib.request, os, sys
B = 'https://line-reaper-backend-production.up.railway.app'
PIN = 'https://guest.api.arcadia.pinnacle.com/0.1'
END = time.time() + float(sys.argv[1]) * 60
RUN = sys.argv[2] if len(sys.argv) > 2 else '1'
def get(u, t=120, base=B, h=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(base + u, headers=h or {'User-Agent': 'diag'}), timeout=t) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
P = lambda s: D.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
dayOf = lambda s: D.datetime.utcfromtimestamp(P(s) - 6 * 3600).strftime('%Y-%m-%d')
stamp = lambda: D.datetime.utcnow().strftime('%Y%m%dT%H%M%S')
os.makedirs('out/h', exist_ok=True); os.makedirs('out/check', exist_ok=True)
if RUN == '1':
    ph = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
    soccer = {}
    for lg in (1980, 2196, 1842, 2436, 2036, 2663, 2242, 2627, 2630):
        mu = get(f'/leagues/{lg}/matchups', 60, PIN, ph)
        cats = {}
        for m in mu if isinstance(mu, list) else []:
            if m.get('type') == 'special':
                c = (m.get('special') or {}).get('category'); cats[c] = cats.get(c, 0) + 1
                if c and 'player' in c.lower() and len(cats.get('_ex', [])) < 5: cats.setdefault('_ex', []).append((m.get('special') or {}).get('description'))
        soccer[lg] = cats if isinstance(mu, list) else mu
    json.dump(soccer, open('out/pinnacle-soccer-specials.json', 'w'), indent=1)
lastCheck = 0
def tick(now):
    global lastCheck
    legs = []
    for st in ('open', 'locked'):
        r = get(f'/api/props/record/picks?status={st}&limit=1000')
        legs += [p for p in (r.get('picks') or [] if isinstance(r, dict) else []) if isinstance(p, dict) if p.get('kind') in ('stale', 'stale-single', 'p6-stale', 'p6-stale-single')]
    keys = {}
    for p in legs:
        s = P(p['start'])
        if -600 < s - now < 90 * 60:
            sp, canon, mkey = p['id'].split('|')[:3]
            keys[f'{sp}|{canon}|{mkey}|{dayOf(p["start"])}'] = p['id']
    at = stamp()
    out = {'at': at, 'legs': [p['id'] for p in legs], 'hist': {}}
    for k in keys: out['hist'][k] = get('/api/stale/history?key=' + urllib.parse.quote(k), 60)
    if keys: json.dump(out, open(f'out/h/{at}.json', 'w'))
    json.dump(legs, open('out/legs-latest.json', 'w'))
    if now - lastCheck > 1800:
        lastCheck = now
        json.dump(get('/api/props/stale-exact', 180), open(f'out/check/{at}.json', 'w'))
        st = get('/api/status', 120)
        json.dump(st if isinstance(st, dict) else {'raw': str(st)[:500]}, open(f'out/check/status-{at}.json', 'w'))
    print(at, len(legs), len(keys), flush=True)
while time.time() < END:
    now = time.time()
    try: tick(now)
    except Exception as e: print('tick failed', repr(e), flush=True)
    time.sleep(max(5, 120 - (time.time() - now)))
