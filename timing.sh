U=https://line-reaper-backend-production.up.railway.app
for i in 1 2 3; do for p in /calc.js /bets.js /slips.js /api/results /api/big-money /api/esports/matches /api/best /api/status /app; do
  curl -s -o /tmp/b -w "$p %{http_code} %{time_total}s %{size_download}B\n" "$U$p"; done; sleep 20; done
