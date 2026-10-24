set -e
rm -rf /tmp/pub && mkdir -p /tmp/pub && cp -r out /tmp/pub/ && cd /tmp/pub && rm -f out/server.log
gzip -9 -f out/h/*.json 2>/dev/null || true
git init -q && git config user.name diag-bot && git config user.email diag-bot@users.noreply.github.com
git checkout -q --orphan diag-cbrec-out && git add -A && git commit -qm "combo rec $(date -u +%FT%TZ)"
git push -qf "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" diag-cbrec-out
