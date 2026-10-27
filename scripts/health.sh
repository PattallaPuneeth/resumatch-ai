#!/usr/bin/env bash
# Prints each compose container's state and health (SPEC section 7.2). Exits 1 if any
# running service with a healthcheck is not healthy.
set -euo pipefail

cd "$(dirname "$0")/.."

status=0
while IFS='|' read -r name state health; do
  [ -z "$name" ] && continue
  printf '%-28s %-10s %s\n' "$name" "$state" "${health:-no healthcheck}"
  if [ "$state" = "running" ] && [ -n "$health" ] && [ "$health" != "healthy" ]; then
    status=1
  fi
done < <(docker compose ps --all --format '{{.Name}}|{{.State}}|{{.Health}}')

exit "$status"
