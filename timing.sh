U=https://line-reaper-backend-production.up.railway.app
curl -s "$U/api/status" | jq -c '{version, oddsScreen}'
curl -s "$U/api/odds-screen" | jq -c '{counts, venues: [.venues[].key], first: .games[0].id}' | tee /tmp/os.txt
curl -s "$U/api/odds-screen?state=TX" | jq -c '{tx: .counts}'
G=$(curl -s "$U/api/odds-screen" | jq -r '.games[0].id')
curl -s "$U/api/odds-screen/history/$G" | jq -c '{series: (.series|length), pts: ([.series[].pts|length]|add)}'
curl -s "$U/" | grep -c -i "pikkit\|850u\|24.9" ; echo "landing pikkit hits above"
curl -s "$U/calc.js" | grep -c pickemSlip; echo "calc pickem above"
for p in /calc.js /app /api/odds-screen; do curl -s -o /dev/null -w "$p %{http_code} %{time_total}s\n" "$U$p"; done
