#!/usr/bin/env bash
# ML memory matrix (SPEC §7.4, Phase 10B). Samples `docker stats` for ml-worker every ~0.5 s
# while it processes one fixture at a time, at a given container memory limit.
#
# Usage: loadtest/memory/measure.sh [limit]      e.g. 2g (default) or 1g
# Requires the load-test overlay to be up. Writes loadtest/results/<stamp>_memory_<limit>.csv/.md
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."

limit="${1:-2g}"
container="${CONTAINER_NAME:-$(docker compose ps -q ml-worker 2>/dev/null | head -n 1)}"
[ -z "$container" ] && container="resumatch-ml-worker"
compose=(docker compose -f docker-compose.yml -f docker-compose.loadtest.yml)
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
csv="loadtest/results/${stamp}_memory_${limit}.csv"
md="loadtest/results/${stamp}_memory_${limit}.md"

to_mib() { # "523.4MiB" / "1.2GiB" / "800KiB" -> MiB
  awk -v v="$1" 'BEGIN{n=v+0; if (v ~ /GiB/) n*=1024; else if (v ~ /KiB/) n/=1024; else if (v ~ /B$/ && v !~ /iB/) n/=1048576; printf "%.1f", n}'
}
sample() { to_mib "$(docker stats --no-stream --format '{{.MemUsage}}' "$container" | awk '{print $1}')"; }

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ] && return 0
    sleep 2
  done
  echo "worker not healthy" >&2; exit 1
}

echo "==> limit=$limit: recreating $container with a fresh process"
docker update --memory "$limit" --memory-swap "$limit" "$container" >/dev/null
docker restart "$container" >/dev/null
wait_healthy
sleep 5
idle_cold=$(sample)

echo "phase,fixture,peak_mib,after_mib,oom_killed,k6_exit" > "$csv"
echo "idle_cold,-,$idle_cold,$idle_cold,false,0" >> "$csv"

# text first: it also loads the embedding model, so later rows show steady state.
for fx in text docx scan1 scan5 heavy; do
  peak=0
  "${compose[@]}" run --rm -T k6 run --quiet -e FIXTURE="$fx" /loadtest/k6/scenarios/single_upload.js \
    > "loadtest/results/${stamp}_memory_${limit}_${fx}.txt" 2>&1 &
  k6pid=$!
  while kill -0 "$k6pid" 2>/dev/null; do
    m=$(sample); awk -v a="$m" -v b="$peak" 'BEGIN{exit !(a>b)}' && peak=$m
    sleep 0.5
  done
  wait "$k6pid"; rc=$?
  # Embedding runs after PARSED (and loads the model on first use), so keep sampling.
  window=$([ "$fx" = text ] && echo 45 || echo 12)
  end=$(( $(date +%s) + window ))
  while [ "$(date +%s)" -lt "$end" ]; do
    m=$(sample); awk -v a="$m" -v b="$peak" 'BEGIN{exit !(a>b)}' && peak=$m
    sleep 0.5
  done
  after=$(sample)
  oom=$(docker inspect -f '{{.State.OOMKilled}}' "$container")
  echo "process,$fx,$peak,$after,$oom,$rc" >> "$csv"
  echo "    $fx peak=${peak}MiB after=${after}MiB oom=$oom k6_exit=$rc"
  [ "$oom" = true ] && { docker start "$container" >/dev/null; wait_healthy; }
done

{
  echo "# ML worker memory, limit $limit ($stamp)"
  echo
  echo "Commit $(git rev-parse --short HEAD); $(docker info --format 'Docker {{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes VM RAM')."
  echo "Sampling: docker stats every ~0.5 s (short spikes between samples can be missed)."
  echo
  echo "| Phase | Fixture | Peak MiB | After MiB | OOM killed | k6 exit |"
  echo "|---|---|---|---|---|---|"
  tail -n +2 "$csv" | awk -F, '{printf "| %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6}'
} > "$md"
cat "$md"
