#!/bin/bash
# boot the app with live feeds and empty stores, let it run, then snapshot the heap
cd app
PORT=3999 LR_DATA_DIR=/tmp/lrdata node --max-old-space-size=4000 --heapsnapshot-signal=SIGUSR2 server.js > /tmp/server.log 2>&1 &
PID=$!
for i in $(seq 1 ${MINUTES:-10}); do sleep 60; echo "min $i: $(curl -s -m 20 localhost:3999/api/ops | python3 -c "import json,sys; j=json.load(sys.stdin); print(j['memory'], j['uptimeS'])" 2>/dev/null)"; done
kill -USR2 $PID
for i in $(seq 1 60); do sleep 5; f=$(ls *.heapsnapshot 2>/dev/null | head -1); [ -n "$f" ] && sz1=$(stat -c %s "$f") && sleep 5 && [ "$sz1" = "$(stat -c %s "$f")" ] && break; done
ls -la *.heapsnapshot
kill $PID
grep -iE "error|warn" /tmp/server.log | sort | uniq -c | sort -rn | head -15
node --max-old-space-size=12000 ../snap.js "$(ls *.heapsnapshot | head -1)"
