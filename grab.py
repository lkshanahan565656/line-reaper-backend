# Reads one exchange catalogue the way the arb scan does (xarb.fetchKalshiEvents
# and fetchPolymarketEvents: 36 Kalshi pages of 200 events with nested markets,
# 15 Gamma pages of 100), one request a second.
import json, urllib.request, urllib.parse, time, os, gzip
os.makedirs('out', exist_ok=True)
def get(url, params, tries=4):
    q = url + '?' + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers={'accept': 'application/json', 'user-agent': 'line-reaper-diag'}), timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            print('retry', url, e); time.sleep(5 * (i + 1))
    return None
k, cursor = [], None
for n in range(36):
    p = {'status': 'open', 'with_nested_markets': 'true', 'limit': 200}
    if cursor: p['cursor'] = cursor
    d = get('https://api.elections.kalshi.com/trade-api/v2/events', p)
    if not d: break
    k.append(d.get('events') or []); cursor = d.get('cursor'); time.sleep(1)
    if not cursor or not k[-1]: break
print('kalshi pages', len(k), 'events', sum(map(len, k)))
pm = []
for n in range(15):
    d = get('https://gamma-api.polymarket.com/events', {'active': 'true', 'closed': 'false', 'order': 'volume24hr', 'ascending': 'false', 'limit': 100, 'offset': 100 * n})
    if d is None: break
    pm.append(d if isinstance(d, list) else d.get('events') or []); time.sleep(1)
    if len(pm[-1]) < 100: break
print('polymarket pages', len(pm), 'events', sum(map(len, pm)))
json.dump({'at': int(time.time() * 1000), 'kalshi': k, 'polymarket': pm}, gzip.open('out/catalog.json.gz', 'wt'))
