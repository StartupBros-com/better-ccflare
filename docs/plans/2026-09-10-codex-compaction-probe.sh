#!/usr/bin/env bash
# DISPOSABLE PROBE SCRIPT -- answers ONE question with evidence: does the
# ChatGPT Codex backend (https://chatgpt.com/backend-api/codex/responses)
# honor, ignore, or reject a `context_management` / `compact_threshold`
# field on the outbound Codex request?
#
# See docs/plans/2026-09-10-codex-server-side-compaction-spec.md (§5, §10)
# for why this is an open question: the reference Codex CLI does NOT send
# this field (it uses a ContextCompaction turn item instead), so neither
# outcome may be assumed.
#
# Safety:
#   - Starts ccflare on port 8081 ONLY. Never touches production (8788/8789).
#   - Sends EXACTLY ONE request, force-routed to a codex-provider account
#     via x-better-ccflare-account-id -- never an Anthropic-backed account.
#   - Tears down only the server process THIS script started.
#   - Safe to re-run (fresh scratch dir every run) and safe to Ctrl-C at any
#     point (cleanup runs on EXIT/INT/TERM either way).
#
# This script does not implement the probe mechanism itself -- that lives in
# packages/providers/src/providers/codex/provider.ts, gated behind
# CCFLARE_CODEX_COMPACTION_PROBE_THRESHOLD (attach) and
# CCFLARE_CODEX_COMPACTION_PROBE_CAPTURE (raw upstream tee). Both are inert
# unless set, which this script sets only for the one child process it
# starts.

set -euo pipefail

REPO_DIR="/home/will/SITES/better-ccflare/.claude/worktrees/plan-upstream-v3-5-78"
PORT=8081
DB_PATH="${BETTER_CCFLARE_DB_PATH:-$HOME/.config/better-ccflare/better-ccflare.db}"
COMPACTION_THRESHOLD=3000

SCRATCH_DIR="$(mktemp -d /tmp/codex-compaction-probe.XXXXXX)"
CAPTURE_FILE="$SCRATCH_DIR/raw-upstream-capture.txt"
TRACE_DIR="$SCRATCH_DIR/trace"
SERVER_LOG="$SCRATCH_DIR/server.log"
RESPONSE_BODY_FILE="$SCRATCH_DIR/curl-response-body.txt"
PID_FILE="$SCRATCH_DIR/server.pid"

mkdir -p "$TRACE_DIR"
: > "$CAPTURE_FILE"

echo "== Codex server-side compaction probe =="
echo "Scratch dir: $SCRATCH_DIR"
echo "Repo:        $REPO_DIR"
echo "Port:        $PORT (production 8788/8789 untouched)"
echo "DB:          $DB_PATH (read-only lookups only)"
echo

SERVER_PID=""
CLEANED_UP=0

cleanup() {
	if [ "$CLEANED_UP" -eq 1 ]; then
		return
	fi
	CLEANED_UP=1
	echo
	echo "== Cleanup =="
	if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "Stopping ccflare test server (pid $SERVER_PID) on port $PORT..."
		kill "$SERVER_PID" 2>/dev/null || true
		for _ in $(seq 1 20); do
			if ! kill -0 "$SERVER_PID" 2>/dev/null; then
				break
			fi
			sleep 0.5
		done
		if kill -0 "$SERVER_PID" 2>/dev/null; then
			echo "Server still alive after graceful stop, sending SIGKILL..."
			kill -9 "$SERVER_PID" 2>/dev/null || true
		fi
	fi
	echo "Scratch dir preserved for inspection: $SCRATCH_DIR"
}
trap cleanup EXIT INT TERM

cd "$REPO_DIR"

echo "== Step 1: verify pinned Bun (1.4.2, not the shadowed 1.3.11) =="
BUN_VERSION="$(mise exec bun@1.4.2 -- bun --version)"
echo "bun --version (via mise exec bun@1.4.2): $BUN_VERSION"
if [ "$BUN_VERSION" != "1.4.2" ]; then
	echo "ABORT: expected bun 1.4.2, got $BUN_VERSION" >&2
	exit 1
fi

echo
echo "== Step 2: build inline workers if needed (bun run build:cli) =="
NEED_BUILD=0
for f in \
	packages/database/src/inline-vacuum-worker.ts \
	packages/database/src/inline-integrity-check-worker.ts \
	packages/database/src/inline-incremental-vacuum-worker.ts
do
	if [ ! -s "$f" ]; then
		NEED_BUILD=1
	fi
done
if [ "$NEED_BUILD" -eq 1 ]; then
	echo "Inline worker file(s) missing/empty -- building (this compiles the CLI, may take a while)..."
	mise exec bun@1.4.2 -- bun run build:cli
else
	echo "Inline worker files already present -- skipping build."
fi

echo
echo "== Step 3: guard port $PORT, refuse to touch anything else =="
EXISTING_PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$EXISTING_PID" ]; then
	EXISTING_CMD="$(ps -o cmd= -p "$EXISTING_PID" 2>/dev/null || true)"
	echo "Port $PORT is already in use by pid $EXISTING_PID: $EXISTING_CMD"
	case "$EXISTING_CMD" in
		*apps/server/src/server.ts*)
			echo "Looks like a leftover ccflare test server from a prior probe run -- stopping it."
			kill "$EXISTING_PID" 2>/dev/null || true
			sleep 2
			if kill -0 "$EXISTING_PID" 2>/dev/null; then
				kill -9 "$EXISTING_PID" 2>/dev/null || true
			fi
			;;
		*)
			echo "ABORT: port $PORT is occupied by something this script does not recognize as its own leftover server. Refusing to kill it. Free the port manually and re-run." >&2
			exit 1
			;;
	esac
fi

echo
echo "== Step 4: resolve a codex-provider account id (read-only) =="
ACCOUNT_ID="$(sqlite3 -readonly "$DB_PATH" "
SELECT id FROM accounts
WHERE provider = 'codex'
  AND paused = 0
  AND requires_reauth = 0
  AND (rate_limited_until IS NULL OR rate_limited_until < CAST(strftime('%s','now') AS INTEGER) * 1000)
ORDER BY priority ASC
LIMIT 1;
")"
if [ -z "$ACCOUNT_ID" ]; then
	echo "ABORT: no eligible codex-provider account found in $DB_PATH (all paused/reauth-needed/rate-limited?)." >&2
	exit 1
fi
echo "Force-routing to codex account: $ACCOUNT_ID"

echo
echo "== Step 4b: build a MINIMAL probe DB (schema + accounts only) =="
# The production DB is ~2.3 GB, almost all of it request history. Copying it
# whole made server startup outrun the health poll (and burned 4 GB of /tmp).
# ccflare only needs the schema and the accounts rows to serve one request, so
# copy exactly that. Production is never opened by the probe server, and the
# Codex access tokens were verified fresh, so no refresh/rotation can fire.
PROBE_DB="$SCRATCH_DIR/probe-min.db"
sqlite3 -readonly "$DB_PATH" ".schema" 2>/dev/null | grep -v '^CREATE TABLE sqlite_' | sqlite3 "$PROBE_DB"
sqlite3 "$PROBE_DB" "ATTACH DATABASE '$DB_PATH' AS prod; INSERT INTO accounts SELECT * FROM prod.accounts; DETACH DATABASE prod;"
ACCT_COUNT="$(sqlite3 "$PROBE_DB" 'SELECT COUNT(*) FROM accounts;' 2>/dev/null || echo 0)"
if [ "$ACCT_COUNT" -lt 1 ]; then echo "ABORT: minimal probe DB has no accounts" >&2; exit 1; fi
echo "Minimal probe DB: $PROBE_DB ($(stat -c%s "$PROBE_DB") bytes, $ACCT_COUNT accounts)"
export BETTER_CCFLARE_DB_PATH="$PROBE_DB"

echo "== Step 5: start ccflare test server on port $PORT =="
echo "  CCFLARE_CODEX_COMPACTION_PROBE_THRESHOLD=$COMPACTION_THRESHOLD"
echo "  CCFLARE_CODEX_COMPACTION_PROBE_CAPTURE=$CAPTURE_FILE"
CCFLARE_CODEX_COMPACTION_PROBE_THRESHOLD="$COMPACTION_THRESHOLD" \
CCFLARE_CODEX_COMPACTION_PROBE_CAPTURE="$CAPTURE_FILE" \
CCFLARE_CODEX_TRACE_DIR="$TRACE_DIR" \
CCFLARE_CODEX_TRACE_FULL=1 \
	mise exec bun@1.4.2 -- bun run apps/server/src/server.ts --port "$PORT" \
	> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
echo "Server pid: $SERVER_PID (log: $SERVER_LOG)"

echo
echo "== Step 6: wait for startup by watching the server LOG, not by sending HTTP =="
# Do NOT poll an HTTP path here. ccflare forwards unknown paths to the generic
# proxy, which attempts to route them across real accounts -- including
# Anthropic-backed ones. An earlier version polled /api/health and generated
# spurious proxy attempts (they failed closed at buildUrl validation, so nothing
# left the machine, but it must not happen at all). Readiness is read from the
# startup banner in the log instead: zero requests until the single real probe.
READY=0
for _ in $(seq 1 120); do
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "ABORT: server process died during startup. Log follows:" >&2
		tail -40 "$SERVER_LOG" >&2
		exit 1
	fi
	if grep -q "Ready to proxy requests" "$SERVER_LOG" 2>/dev/null; then
		READY=1
		break
	fi
	sleep 1
done
if [ "$READY" -ne 1 ]; then
	echo "ABORT: server never printed its ready banner on port $PORT. Log follows:" >&2
	tail -40 "$SERVER_LOG" >&2
	exit 1
fi
echo "Server ready on port $PORT (banner observed in log; no HTTP probe sent)."

echo
echo "== Step 7: build the one probe request (benign filler, no secrets) =="
SENTENCE="The quick brown fox jumps over the lazy dog. This sentence is benign, repeated filler used only to exceed the compaction probe's token threshold; it contains no secrets and no real content. "
FILLER=""
for _ in $(seq 1 300); do
	FILLER="$FILLER$SENTENCE"
done
FILLER="$FILLER Reply with exactly one word: OK."
FILLER_CHARS=${#FILLER}
echo "Filler prompt size: $FILLER_CHARS characters (~$((FILLER_CHARS / 4)) tokens, comfortably above the $COMPACTION_THRESHOLD-token probe threshold, small in absolute terms)."

PAYLOAD="$(jq -n \
	--arg model "gpt-5.6-sol" \
	--arg text "$FILLER" \
	'{model: $model, max_tokens: 16, stream: true, messages: [{role: "user", content: $text}]}')"

echo
echo "== Step 8: send EXACTLY ONE request, force-routed to codex account $ACCOUNT_ID =="
HTTP_STATUS="$(curl -s -o "$RESPONSE_BODY_FILE" -w '%{http_code}' -m 120 \
	-X POST "http://127.0.0.1:$PORT/v1/messages" \
	-H "Content-Type: application/json" \
	-H "anthropic-version: 2023-06-01" \
	-H "Authorization: Bearer test" \
	-H "x-better-ccflare-account-id: $ACCOUNT_ID" \
	-d "$PAYLOAD")"
echo "Client-facing (translated) HTTP status: $HTTP_STATUS"

# Give the fire-and-forget async error-body capture write (see
# provider.ts's processResponse probe block) a moment to flush before we
# read the capture file.
sleep 2

echo
echo "== Step 9: verify the field was actually attached on the wire (trace) =="
TRACE_FILE="$(find "$TRACE_DIR" -maxdepth 1 -name 'codex-trace-*.jsonl' 2>/dev/null | head -1 || true)"
ATTACH_EVIDENCE="(no trace file found -- CCFLARE_CODEX_TRACE_FULL capture did not produce output)"
if [ -n "$TRACE_FILE" ] && grep -q "context_management" "$TRACE_FILE" 2>/dev/null; then
	ATTACH_EVIDENCE="$(grep -o '"context_management":[^]]*\]' "$TRACE_FILE" | head -1)"
fi
echo "Outbound context_management as recorded in trace: $ATTACH_EVIDENCE"

echo
echo "== VERDICT =="
CAPTURE_META="$(grep '\[\[codex-compaction-probe\]\]' "$CAPTURE_FILE" 2>/dev/null | tail -1 || true)"
UPSTREAM_STATUS="$(printf '%s' "$CAPTURE_META" | grep -o 'status=[0-9]*' | head -1 | cut -d= -f2 || true)"

if [ -n "$UPSTREAM_STATUS" ] && { [ "$UPSTREAM_STATUS" -lt 200 ] || [ "$UPSTREAM_STATUS" -ge 300 ]; }; then
	echo "REJECTED"
	echo "Upstream Codex backend returned a non-2xx status for context_management."
	echo "Evidence (capture status line):"
	echo "  $CAPTURE_META"
	echo "Evidence (full upstream error body):"
	awk '/\[\[codex-compaction-probe:error-body\]\]/{flag=1;next}/\[\[\/codex-compaction-probe:error-body\]\]/{flag=0}flag' "$CAPTURE_FILE" | sed 's/^/  /'
elif grep -q '"type"[[:space:]]*:[[:space:]]*"compaction"' "$CAPTURE_FILE" 2>/dev/null; then
	echo "HONORED"
	echo "A compaction-typed output item appeared in the raw upstream SSE stream."
	echo "Evidence (matching raw upstream line(s)):"
	grep -n '"type"[[:space:]]*:[[:space:]]*"compaction"' "$CAPTURE_FILE" | sed 's/^/  /'
elif [ -n "$UPSTREAM_STATUS" ]; then
	echo "IGNORED"
	echo "Upstream returned $UPSTREAM_STATUS (normal stream), and no compaction-typed output item"
	echo "appeared anywhere in the raw captured upstream bytes -- context_management was silently"
	echo "accepted-and-ignored on the wire."
	echo "Evidence (capture status line):"
	echo "  $CAPTURE_META"
	echo "Evidence (raw capture tail, last 20 lines):"
	tail -20 "$CAPTURE_FILE" | sed 's/^/  /'
else
	echo "INCONCLUSIVE"
	echo "No status line was captured at all -- the request likely never reached processResponse's"
	echo "probe-flagged path (e.g. attempt became response-id-owned, or account lookup routed"
	echo "elsewhere). Inspect $SERVER_LOG, $CAPTURE_FILE, and $RESPONSE_BODY_FILE directly."
fi

echo
echo "== Supporting artifacts (preserved in $SCRATCH_DIR) =="
echo "  Raw upstream capture: $CAPTURE_FILE"
echo "  Client-facing response body: $RESPONSE_BODY_FILE"
echo "  Server log: $SERVER_LOG"
echo "  Codex trace (proves outbound attachment): $TRACE_FILE"
