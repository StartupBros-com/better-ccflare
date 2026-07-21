#!/usr/bin/env bash
set -Eeuo pipefail

export HOME=${HOME:-/home/will}
export USER=${USER:-will}
export PATH=/home/will/.local/share/mise/shims:/home/will/.local/share/mise/installs/node/24.13.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

: "${CCFLARE_BIN:?CCFLARE_BIN must name the pinned better-ccflare binary}"
: "${GUARD_SCRIPT:?GUARD_SCRIPT must name the pinned guard script}"
NODE_BIN=${NODE_BIN:-/home/will/.local/share/mise/shims/node}
UPSTREAM_PORT=${CCFLARE_UPSTREAM_PORT:-8789}
GUARD_PORT=${GUARD_PORT:-8788}
AI_GATEWAY_TUNNEL_ENABLED=${AI_GATEWAY_TUNNEL_ENABLED:-1}
AI_GATEWAY_TUNNEL_REQUIRED=${AI_GATEWAY_TUNNEL_REQUIRED:-1}
AI_GATEWAY_SSH_HOST=${AI_GATEWAY_SSH_HOST:-root@100.121.216.26}
AI_GATEWAY_LOCAL_PORT=${AI_GATEWAY_LOCAL_PORT:-14000}
AI_GATEWAY_REMOTE_HOST=${AI_GATEWAY_REMOTE_HOST:-127.0.0.1}
AI_GATEWAY_REMOTE_PORT=${AI_GATEWAY_REMOTE_PORT:-4000}
GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS:-600000}
GUARD_RETRY_ATTEMPT_HEADROOM_MS=${GUARD_RETRY_ATTEMPT_HEADROOM_MS:-30000}
GUARD_MAX_RECOVERY_SLEEP_MS=${GUARD_MAX_RECOVERY_SLEEP_MS:-120000}
GUARD_EFFECTIVE_MAX_ACTIVE=${CCFLARE_GUARD_MAX_ACTIVE:-${GUARD_MAX_ACTIVE:-12}}
GUARD_MAX_RECOVERY_WAITS=${GUARD_MAX_RECOVERY_WAITS:-$GUARD_EFFECTIVE_MAX_ACTIVE}
GUARD_SHUTDOWN_GRACE_MS=${GUARD_SHUTDOWN_GRACE_MS:-600000}
GUARD_SHUTDOWN_CUSHION_MS=${GUARD_SHUTDOWN_CUSHION_MS:-5000}
STOP_POLL_INTERVAL_MS=200

upstream_pid=""
guard_pid=""
ai_gateway_tunnel_pid=""
cleanup_ran=0

log() {
	printf '[%s] %s\n' "$(date -Is)" "$*"
}

validate_bounded_ms() {
	local name="$1" value="$2" min="$3" max="$4"
	if [[ ! "$value" =~ ^(0|[1-9][0-9]{0,9})$ ]] || ((value < min || value > max)); then
		log "invalid ${name}=${value}; expected an integer from ${min} to ${max} milliseconds"
		exit 64
	fi
}

validate_bounded_ms GUARD_TOTAL_DEADLINE_MS "$GUARD_TOTAL_DEADLINE_MS" 1 2147483647
validate_bounded_ms GUARD_RETRY_ATTEMPT_HEADROOM_MS "$GUARD_RETRY_ATTEMPT_HEADROOM_MS" 1 2147483647
validate_bounded_ms GUARD_MAX_RECOVERY_SLEEP_MS "$GUARD_MAX_RECOVERY_SLEEP_MS" 1 120000
validate_bounded_ms GUARD_EFFECTIVE_MAX_ACTIVE "$GUARD_EFFECTIVE_MAX_ACTIVE" 1 1000000
validate_bounded_ms GUARD_MAX_RECOVERY_WAITS "$GUARD_MAX_RECOVERY_WAITS" 1 1000000
validate_bounded_ms GUARD_SHUTDOWN_GRACE_MS "$GUARD_SHUTDOWN_GRACE_MS" 0 2147483647
validate_bounded_ms GUARD_SHUTDOWN_CUSHION_MS "$GUARD_SHUTDOWN_CUSHION_MS" 0 60000
if ((GUARD_SHUTDOWN_GRACE_MS < GUARD_TOTAL_DEADLINE_MS)); then
	log "GUARD_SHUTDOWN_GRACE_MS=${GUARD_SHUTDOWN_GRACE_MS} must be at least GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS}"
	exit 64
fi
if ((GUARD_RETRY_ATTEMPT_HEADROOM_MS >= GUARD_TOTAL_DEADLINE_MS)); then
	log "GUARD_RETRY_ATTEMPT_HEADROOM_MS=${GUARD_RETRY_ATTEMPT_HEADROOM_MS} must be less than GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS}"
	exit 64
fi
if ((GUARD_MAX_RECOVERY_SLEEP_MS > GUARD_TOTAL_DEADLINE_MS - GUARD_RETRY_ATTEMPT_HEADROOM_MS)); then
	log "GUARD_MAX_RECOVERY_SLEEP_MS=${GUARD_MAX_RECOVERY_SLEEP_MS} must fit within GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS} after GUARD_RETRY_ATTEMPT_HEADROOM_MS=${GUARD_RETRY_ATTEMPT_HEADROOM_MS}"
	exit 64
fi
GUARD_STOP_BUDGET_MS=$((GUARD_SHUTDOWN_GRACE_MS + GUARD_SHUTDOWN_CUSHION_MS))

stop_child() {
	local name="$1" pid="$2" stop_budget_ms="$3"
	if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	log "stopping ${name} pid=${pid}"
	kill "$pid" 2>/dev/null || true
	local elapsed_ms=0
	while ((elapsed_ms < stop_budget_ms)); do
		if ! kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
		sleep 0.2
		elapsed_ms=$((elapsed_ms + STOP_POLL_INTERVAL_MS))
	done
	if ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	log "${name} pid=${pid} did not stop after ${stop_budget_ms}ms; sending SIGKILL"
	kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
	if ((cleanup_ran)); then
		return 0
	fi
	cleanup_ran=1
	trap - EXIT TERM INT
	log "stopping ccflare stack"
	stop_child "ccflare guard" "$guard_pid" "$GUARD_STOP_BUDGET_MS"
	stop_child "better-ccflare upstream" "$upstream_pid" 5000
	stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 5000
	wait "${guard_pid:-0}" 2>/dev/null || true
	wait "${upstream_pid:-0}" 2>/dev/null || true
	wait "${ai_gateway_tunnel_pid:-0}" 2>/dev/null || true
}

terminate() {
	cleanup
	exit 143
}

trap cleanup EXIT
trap terminate TERM INT

require_file() {
	if [[ ! -x "$1" ]]; then
		log "required executable missing: $1"
		exit 127
	fi
}

wait_for_url() {
	local name="$1" url="$2" pid="$3"
	for _ in $(seq 1 60); do
		if ! kill -0 "$pid" 2>/dev/null; then
			log "$name exited before ready"
			return 1
		fi
		if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
			sleep 0.2
			if kill -0 "$pid" 2>/dev/null; then
				log "$name ready at $url"
				return 0
			fi
			log "$name exited after health check succeeded"
			return 1
		fi
		sleep 1
	done
	log "$name did not become ready at $url"
	return 1
}

ai_gateway_tunnel_ready() {
	local http_status
	if ! http_status=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${AI_GATEWAY_LOCAL_PORT}/health" 2>/dev/null); then
		return 1
	fi
	case "$http_status" in
		2[0-9][0-9] | 401) return 0 ;;
		*) return 1 ;;
	esac
}

start_ai_gateway_tunnel() {
	case "$AI_GATEWAY_TUNNEL_ENABLED" in
		1 | true | TRUE | yes | YES) ;;
		*)
			log "ai-gateway tunnel disabled"
			return 0
			;;
	esac

	if ai_gateway_tunnel_ready; then
		log "ai-gateway tunnel already ready at 127.0.0.1:${AI_GATEWAY_LOCAL_PORT}"
		return 0
	fi
	if ! command -v ssh >/dev/null 2>&1; then
		log "ssh not found; cannot start ai-gateway tunnel"
		return 1
	fi

	log "starting ai-gateway tunnel 127.0.0.1:${AI_GATEWAY_LOCAL_PORT} -> ${AI_GATEWAY_SSH_HOST}:${AI_GATEWAY_REMOTE_HOST}:${AI_GATEWAY_REMOTE_PORT}"
	ssh -N -T \
		-o BatchMode=yes \
		-o ExitOnForwardFailure=yes \
		-o ServerAliveInterval=30 \
		-o ServerAliveCountMax=3 \
		-o ControlMaster=no \
		-o ControlPath=none \
		-L "127.0.0.1:${AI_GATEWAY_LOCAL_PORT}:${AI_GATEWAY_REMOTE_HOST}:${AI_GATEWAY_REMOTE_PORT}" \
		"$AI_GATEWAY_SSH_HOST" &
	ai_gateway_tunnel_pid=$!

	for _ in $(seq 1 40); do
		if ! kill -0 "$ai_gateway_tunnel_pid" 2>/dev/null; then
			log "ai-gateway tunnel exited before ready"
			return 1
		fi
		if ai_gateway_tunnel_ready; then
			log "ai-gateway tunnel ready at 127.0.0.1:${AI_GATEWAY_LOCAL_PORT}"
			return 0
		fi
		sleep 0.5
	done
	log "ai-gateway tunnel did not become ready at 127.0.0.1:${AI_GATEWAY_LOCAL_PORT}"
	return 1
}

require_file "$CCFLARE_BIN"
require_file "$NODE_BIN"
require_file "$GUARD_SCRIPT"

if ! start_ai_gateway_tunnel; then
	if [[ "$AI_GATEWAY_TUNNEL_REQUIRED" == "1" || "$AI_GATEWAY_TUNNEL_REQUIRED" == "true" ]]; then
		log "ai-gateway tunnel is required; exiting"
		exit 1
	fi
	log "ai-gateway tunnel unavailable; continuing without last-resort fallback"
fi

log "starting better-ccflare upstream on 127.0.0.1:${UPSTREAM_PORT}"
env \
	HOME="$HOME" \
	USER="$USER" \
	BETTER_CCFLARE_HOST=127.0.0.1 \
	PORT="$UPSTREAM_PORT" \
	STORE_PAYLOADS=false \
	LOG_LEVEL=warn \
	CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS=120000 \
	CCFLARE_DEBUG_ANTHROPIC_BOUNDARY="${CCFLARE_DEBUG_ANTHROPIC_BOUNDARY:-1}" \
	CCFLARE_DEBUG_CODEX_STREAM="${CCFLARE_DEBUG_CODEX_STREAM:-1}" \
	"$CCFLARE_BIN" --serve --port "$UPSTREAM_PORT" &
upstream_pid=$!
wait_for_url better-ccflare "http://127.0.0.1:${UPSTREAM_PORT}/health" "$upstream_pid"

log "starting ccflare guard on 127.0.0.1:${GUARD_PORT} -> 127.0.0.1:${UPSTREAM_PORT}"
env \
	HOME="$HOME" \
	USER="$USER" \
	GUARD_HOST=127.0.0.1 \
	GUARD_PORT="$GUARD_PORT" \
	CCFLARE_UPSTREAM="http://127.0.0.1:${UPSTREAM_PORT}" \
	GUARD_UPSTREAM_PID="${upstream_pid}" \
	GUARD_MAX_ACTIVE="$GUARD_EFFECTIVE_MAX_ACTIVE" \
	GUARD_MAX_QUEUE="${CCFLARE_GUARD_MAX_QUEUE:-${GUARD_MAX_QUEUE:-500}}" \
	GUARD_MAX_RECOVERY_WAITS="$GUARD_MAX_RECOVERY_WAITS" \
	GUARD_TOTAL_DEADLINE_MS="$GUARD_TOTAL_DEADLINE_MS" \
	GUARD_RETRY_ATTEMPT_HEADROOM_MS="$GUARD_RETRY_ATTEMPT_HEADROOM_MS" \
	GUARD_MAX_RECOVERY_SLEEP_MS="$GUARD_MAX_RECOVERY_SLEEP_MS" \
	GUARD_MAX_ATTEMPTS=3 \
	GUARD_RETRY_JITTER_MS=2000 \
	GUARD_MAX_INSPECTION_BYTES=65536 \
	GUARD_SHUTDOWN_GRACE_MS="$GUARD_SHUTDOWN_GRACE_MS" \
	"$NODE_BIN" "$GUARD_SCRIPT" &
guard_pid=$!
wait_for_url ccflare-guard "http://127.0.0.1:${GUARD_PORT}/_guard/health" "$guard_pid"

log "ccflare stack ready; upstream_pid=${upstream_pid} guard_pid=${guard_pid}"
set +e
wait -n "$upstream_pid" "$guard_pid" ${ai_gateway_tunnel_pid:+"$ai_gateway_tunnel_pid"}
status=$?
set -e
log "ccflare stack child exited; status=${status}; restarting via supervisor"
exit "$status"
