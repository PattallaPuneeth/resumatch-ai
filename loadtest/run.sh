#!/usr/bin/env bash
# Runs k6 scenarios against the load-test overlay and stores summaries in loadtest/results/.
# Usage: loadtest/run.sh <scenario> [label] [extra k6 args...]
#   loadtest/run.sh smoke
#   loadtest/run.sh ingestion baseline -e PEAK_RATE=2
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

scenario="$1"; label="${2:-run}"; shift $(( $# >= 2 ? 2 : 1 ))
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="loadtest/results/${stamp}_${scenario}_${label}"
compose=(docker compose -f docker-compose.yml -f docker-compose.loadtest.yml)

{
  echo "scenario=$scenario label=$label started=$stamp"
  echo "commit=$(git rev-parse --short HEAD) dirty=$(git status --porcelain | wc -l)"
  echo "docker=$(docker info --format 'cpus={{.NCPU}} mem_bytes={{.MemTotal}} server={{.ServerVersion}}')"
  echo "k6_args=$*"
} > "${out}.meta.txt"

"${compose[@]}" run --rm -T k6 run --quiet \
  --summary-export "/${out}.json" "$@" "/loadtest/k6/scenarios/${scenario}.js" 2>&1 \
  | grep -v -E '^ ?(Container|Network|Volume) ' > "${out}.txt"
status=${PIPESTATUS[0]}

# RULE S4 ledger: any real provider hostname in service logs during the run is a failure.
"${compose[@]}" logs --since "$stamp" backend ml ml-worker 2>/dev/null \
  | grep -i -E 'generativelanguage\.googleapis|api\.groq\.com|openrouter\.ai|api\.firecrawl' \
  > "${out}.provider_ledger.txt" || true
echo "k6_exit=$status provider_hits=$(wc -l < "${out}.provider_ledger.txt")" >> "${out}.meta.txt"
echo "$out k6_exit=$status"
