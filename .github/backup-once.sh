#!/usr/bin/env bash
# One results backup: fetch the live app's encrypted snapshot and keep it as the
# only commit on results-data, unless it lost records in bulk (backup-guard.jq).
# Used by results-backup.yml (each push to main) and results-backup-loop.yml
# (every 20 minutes). Needs APP_URL and GH_TOKEN; runs from the repo root.
set -u
root=$(pwd)
work=$(mktemp -d)
cd "$work"
code=$(curl -sS -o new.json -w '%{http_code}' --max-time 180 "$APP_URL/api/results/backup") || code=000
if [ "$code" != 200 ] || ! jq -e '.v == 1 and (.data | length > 0) and .keyId' new.json >/dev/null; then
  echo "::notice::No snapshot from the app (HTTP $code); nothing to keep this run."
  exit 0
fi
jq -c '{at, keyId, counts, other}' new.json
git init -q keep && cd keep
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
if git fetch -q --depth 1 origin results-data 2>/dev/null && git show FETCH_HEAD:results.json > ../old.json 2>/dev/null; then
  # same key: refuse only a snapshot that lost records in bulk (a container
  # that came up without its restore): fewer records in all, or one store
  # down by more than 20 records and 10%. A store that trims a few rows, or
  # was renamed or switched off, never blocks it (10-25: esportsMatchups
  # 9 -> 0 held the backup a day).
  lost=$(jq -n -f "$root/.github/backup-guard.jq" --slurpfile o ../old.json --slurpfile n ../new.json)
  if [ "$lost" != 0 ]; then
    echo "::warning::The new snapshot has fewer records than the kept one; keeping the old one."
    jq -c '{old: $o[0].counts, new: $n[0].counts}' -n --slurpfile o ../old.json --slurpfile n ../new.json
    exit 0
  fi
  # the same snapshot as the kept one (the app had not taken a new one): nothing to push
  if [ "$(jq -r .at ../old.json)" = "$(jq -r .at ../new.json)" ]; then echo "::notice::Same snapshot as the kept one."; exit 0; fi
fi
cp ../new.json results.json
git add results.json
git -c user.name='line-reaper-backup' -c user.email='actions@users.noreply.github.com' commit -qm "Results backup $(jq -r .at results.json)"
git push -qf origin HEAD:refs/heads/results-data
