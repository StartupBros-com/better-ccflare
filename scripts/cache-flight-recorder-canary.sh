#!/usr/bin/env bash
# Operator-run live canary for the Grok Cache Flight Recorder (AE11).
#
# Fixtures in packages/proxy/src/__tests__/cache-flight-recorder-matrix.test.ts
# are the merge gate. This script is optional and must never target Anthropic
# or the `claude` account.
#
# Prerequisites:
#   - better-ccflare listening on CCFLARE_LIVE_XAI_BASE_URL (default :8081)
#   - Official xAI account already configured in that process
#   - Process env includes:
#         CCFLARE_CACHE_FLIGHT_RECORDER=1
#         CCFLARE_XAI_CACHE_NATIVE=1
#
# Usage:
#   CCFLARE_LIVE_XAI_CANARY=1 \
#   CCFLARE_LIVE_XAI_ACCOUNT_ID=<official-xai-account-id> \
#   CCFLARE_LIVE_XAI_BASE_URL=http://127.0.0.1:8081 \
#   CCFLARE_LIVE_XAI_AUTH_TOKEN=test \
#   CCFLARE_LIVE_XAI_DB_PATH=~/.config/better-ccflare/better-ccflare.db \
#   ./scripts/cache-flight-recorder-canary.sh
#
# Or via bun tests (same env vars):
#   bun test packages/proxy/src/__tests__/cache-flight-recorder-matrix.test.ts

set -euo pipefail

if [[ "${CCFLARE_LIVE_XAI_CANARY:-}" != "1" ]]; then
  echo "Set CCFLARE_LIVE_XAI_CANARY=1 to run the live official-xAI canary." >&2
  echo "Fixtures remain the merge gate when this path is skipped." >&2
  exit 0
fi

ACCOUNT_ID="${CCFLARE_LIVE_XAI_ACCOUNT_ID:-}"
BASE_URL="${CCFLARE_LIVE_XAI_BASE_URL:-http://127.0.0.1:8081}"
AUTH_TOKEN="${CCFLARE_LIVE_XAI_AUTH_TOKEN:-test}"

if [[ -z "${ACCOUNT_ID}" ]]; then
  echo "CCFLARE_LIVE_XAI_ACCOUNT_ID is required for the live canary." >&2
  exit 2
fi

if [[ "${ACCOUNT_ID}" == "claude" ]]; then
  echo "Refusing to force-route the claude/Anthropic account." >&2
  exit 2
fi

SESSION_ID="11111111-1111-4111-8111-111111111111"
SYSTEM="cache flight recorder live canary system seed"
FIRST_USER="cache flight recorder live canary turn one"
SECOND_USER="cache flight recorder live canary turn two"

post_turn() {
  local body="$1"
  curl -sS -D /tmp/cfr-canary-headers.txt -o /tmp/cfr-canary-body.txt \
    -X POST "${BASE_URL}/v1/messages" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${AUTH_TOKEN}" \
    -H "x-better-ccflare-account-id: ${ACCOUNT_ID}" \
    -d "${body}"
}

post_turn "$(cat <<EOF
{
  "model": "grok-4",
  "max_tokens": 16,
  "system": "${SYSTEM}",
  "metadata": { "user_id": "{\"session_id\":\"${SESSION_ID}\"}" },
  "messages": [{ "role": "user", "content": "${FIRST_USER}" }]
}
EOF
)"

RECORDER_ID="$(awk -F': ' 'tolower($1)=="x-better-ccflare-cache-flight-recorder-id" {gsub(/\r/,"",$2); print $2}' /tmp/cfr-canary-headers.txt | tail -n1)"
if [[ -z "${RECORDER_ID}" ]]; then
  echo "Missing x-better-ccflare-cache-flight-recorder-id response header." >&2
  echo "Confirm CCFLARE_CACHE_FLIGHT_RECORDER=1 and official-xAI force-route." >&2
  exit 1
fi

post_turn "$(cat <<EOF
{
  "model": "grok-4",
  "max_tokens": 16,
  "system": "${SYSTEM}",
  "metadata": { "user_id": "{\"session_id\":\"${SESSION_ID}\"}" },
  "messages": [
    { "role": "user", "content": "${FIRST_USER}" },
    { "role": "assistant", "content": "ack" },
    { "role": "user", "content": "${SECOND_USER}" }
  ]
}
EOF
)"

RECORDER_ID_2="$(awk -F': ' 'tolower($1)=="x-better-ccflare-cache-flight-recorder-id" {gsub(/\r/,"",$2); print $2}' /tmp/cfr-canary-headers.txt | tail -n1)"
if [[ "${RECORDER_ID_2}" != "${RECORDER_ID}" ]]; then
  echo "Recorder ID changed across multi-turn conversation: ${RECORDER_ID} -> ${RECORDER_ID_2}" >&2
  exit 1
fi

echo "Stable recorder ID: ${RECORDER_ID}"
echo "Next: bun run cli -- --cache-flight-recorder-report ${RECORDER_ID}"
echo "JSON: bun run cli -- --cache-flight-recorder-report ${RECORDER_ID} --json"
echo "Health: bun run cli -- --cache-flight-recorder-health --json"

if command -v bun >/dev/null 2>&1; then
  bun run cli -- --cache-flight-recorder-report "${RECORDER_ID}" || true
  bun run cli -- --cache-flight-recorder-report "${RECORDER_ID}" --json || true
fi
