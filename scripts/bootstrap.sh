#!/usr/bin/env bash
# One-time local setup: creates .env from .env.example with freshly generated secrets.
# Provider keys (Gemini, Groq, OpenRouter, Firecrawl) stay empty, so the stack runs LLM-off
# and match scores come from the ML pipeline only.
#
# Usage: scripts/bootstrap.sh            # then: docker compose up --build
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists; leaving it untouched."
  echo "Delete it first if you want fresh secrets."
  exit 0
fi

random_hex() {
  # 32 random bytes as 64 hex chars from the OS CSPRNG
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

jwt_secret="$(random_hex)"
internal_token="$(random_hex)"

sed \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" \
  -e "s|^INTERNAL_API_TOKEN=.*|INTERNAL_API_TOKEN=${internal_token}|" \
  .env.example > .env

echo "Created .env with a new JWT_SECRET and INTERNAL_API_TOKEN (LLM provider keys left empty)."
echo "Next: docker compose up --build"
