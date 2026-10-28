# Reads the live site's record inputs and outputs for the stack rehearsal.
import json, urllib.request, urllib.parse, time, os
U = 'https://line-reaper-backend-production.up.railway.app'
os.makedirs('out', exist_ok=True)
def get(p, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(U + p, headers={'accept': 'application/json'}), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            print('retry', p, e); time.sleep(3 * (i + 1))
    raise SystemExit(f'failed {p}')
def save(name, v): json.dump(v, open(f'out/{name}.json', 'w'))
from datetime import datetime, timedelta, timezone
def plus1ms(iso):
    d = datetime.fromisoformat(iso.replace('Z', '+00:00')) + timedelta(milliseconds=1)
    return d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'
def page(path, key, tcol, extra=''):
    rows, seen, before = [], set(), None
    lim = 500 if 'ev/' in path else 1000
    for n in range(3000):
        got = get(f'{path}?limit={lim}{extra}' + (f'&before={urllib.parse.quote(before)}' if before else ''))[key]
        new = [r for r in got if r['id'] not in seen]
        for r in new: seen.add(r['id']); rows.append(r)
        if len(got) < lim or not new: break
        # the oldest time on the page plus 1 ms: rows sharing it come again and are deduped
        before = plus1ms(min(r[tcol] for r in got))
    print(path, extra, len(rows), 'pages', n + 1); return rows
t0 = time.time()
save('health', get('/api/health'))
for name, extra in [('ev', ''), ('alt', '&alt=1'), ('stale', '&stale=1'), ('es', '&es=1'), ('leadlag', '&leadlag=1')]:
    save(f'rows-{name}', page('/api/ev/record/bets', 'bets', 'flaggedAt', extra))
save('rows-props', page('/api/props/record/picks', 'picks', 'signalAt'))
save('rows-bigmoney', get('/api/big-money/record'))
save('out-scoreboard', get('/api/ev/scoreboard'))
save('out-scoreboard-tx', get('/api/ev/scoreboard?state=TX'))
save('out-claims', get('/api/claims'))
save('out-record', get('/api/record'))
save('out-alerts', get('/api/alerts/history'))
save('out-records', get('/api/records'))
save('out-leaderboard', get('/api/leaderboard'))
save('out-mapunders', get('/api/esports/map-unders?limit=2000'))
save('health-after', get('/api/health'))
print('done in', round(time.time() - t0), 's')
