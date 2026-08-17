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
AI_GATEWAY_SSH_BIN=${AI_GATEWAY_SSH_BIN:-ssh}
AI_GATEWAY_LOCAL_PORT=${AI_GATEWAY_LOCAL_PORT:-14000}
AI_GATEWAY_REMOTE_HOST=${AI_GATEWAY_REMOTE_HOST:-127.0.0.1}
AI_GATEWAY_REMOTE_PORT=${AI_GATEWAY_REMOTE_PORT:-4000}
AI_GATEWAY_TUNNEL_READY_ATTEMPTS=${AI_GATEWAY_TUNNEL_READY_ATTEMPTS:-40}
AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS=${AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS:-500}
AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS=${AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS:-10}
GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS:-600000}
GUARD_RETRY_ATTEMPT_HEADROOM_MS=${GUARD_RETRY_ATTEMPT_HEADROOM_MS:-30000}
GUARD_MAX_RECOVERY_SLEEP_MS=${GUARD_MAX_RECOVERY_SLEEP_MS:-120000}
GUARD_EFFECTIVE_MAX_ACTIVE=${CCFLARE_GUARD_MAX_ACTIVE:-${GUARD_MAX_ACTIVE:-12}}
GUARD_MAX_RECOVERY_WAITS=${GUARD_MAX_RECOVERY_WAITS:-$GUARD_EFFECTIVE_MAX_ACTIVE}
GUARD_SHUTDOWN_GRACE_MS=${GUARD_SHUTDOWN_GRACE_MS:-600000}
GUARD_SHUTDOWN_CUSHION_MS=${GUARD_SHUTDOWN_CUSHION_MS:-5000}
RUNNER_FAILURE_STOP_BUDGET_MS=${RUNNER_FAILURE_STOP_BUDGET_MS:-30000}
STOP_POLL_INTERVAL_MS=200
RUNNER_HEALTH_POLL_INTERVAL_MS=${RUNNER_HEALTH_POLL_INTERVAL_MS:-1000}
RUNNER_HEALTH_MAX_ATTEMPTS=${RUNNER_HEALTH_MAX_ATTEMPTS:-60}
RUNNER_HEALTH_STABILITY_DELAY_MS=${RUNNER_HEALTH_STABILITY_DELAY_MS:-200}
RUNNER_RESTART_BACKOFF_BASE_MS=${RUNNER_RESTART_BACKOFF_BASE_MS:-1000}
RUNNER_RESTART_BACKOFF_MAX_MS=${RUNNER_RESTART_BACKOFF_MAX_MS:-30000}
RUNNER_RESTART_MAX_FAILURES=${RUNNER_RESTART_MAX_FAILURES:-3}
RUNNER_RESTART_WINDOW_MS=${RUNNER_RESTART_WINDOW_MS:-300000}
RUNNER_RESTART_STABLE_MS=${RUNNER_RESTART_STABLE_MS:-60000}
# When the local breaker opens, a systemd-managed runner must exit so the
# service is not reported active while its stack children are down. The
# managed unit uses Restart=on-failure plus StartLimit* to own the outer
# restart budget. An explicit `true` remains available for operator-controlled
# one-shot fixtures; `auto` is always service-safe and exits with the distinct
# bounded status below.
RUNNER_CIRCUIT_HOLD=${RUNNER_CIRCUIT_HOLD:-auto}
RUNNER_CIRCUIT_EXIT_STATUS=75

upstream_pid=""
guard_pid=""
ai_gateway_tunnel_pid=""
cleanup_ran=0
shutdown_requested=0
fatal_startup=0
child_exit_name=""
child_exit_status=1
child_exit_class="failure"
restart_failure_count=0
restart_window_started_ms=0
stack_started_ms=0

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

validate_bounded_int() {
	local name="$1" value="$2" min="$3" max="$4"
	if [[ ! "$value" =~ ^(0|[1-9][0-9]{0,9})$ ]] || ((value < min || value > max)); then
		log "invalid ${name}=${value}; expected an integer from ${min} to ${max}"
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
validate_bounded_ms RUNNER_FAILURE_STOP_BUDGET_MS "$RUNNER_FAILURE_STOP_BUDGET_MS" 1 120000
validate_bounded_ms RUNNER_HEALTH_POLL_INTERVAL_MS "$RUNNER_HEALTH_POLL_INTERVAL_MS" 1 60000
validate_bounded_int RUNNER_HEALTH_MAX_ATTEMPTS "$RUNNER_HEALTH_MAX_ATTEMPTS" 1 1000000
validate_bounded_ms RUNNER_HEALTH_STABILITY_DELAY_MS "$RUNNER_HEALTH_STABILITY_DELAY_MS" 0 60000
validate_bounded_ms RUNNER_RESTART_BACKOFF_BASE_MS "$RUNNER_RESTART_BACKOFF_BASE_MS" 0 120000
validate_bounded_ms RUNNER_RESTART_BACKOFF_MAX_MS "$RUNNER_RESTART_BACKOFF_MAX_MS" 0 600000
validate_bounded_int RUNNER_RESTART_MAX_FAILURES "$RUNNER_RESTART_MAX_FAILURES" 1 100
validate_bounded_ms RUNNER_RESTART_WINDOW_MS "$RUNNER_RESTART_WINDOW_MS" 1 2147483647
validate_bounded_ms RUNNER_RESTART_STABLE_MS "$RUNNER_RESTART_STABLE_MS" 0 2147483647
validate_bounded_int AI_GATEWAY_TUNNEL_READY_ATTEMPTS "$AI_GATEWAY_TUNNEL_READY_ATTEMPTS" 1 10000
validate_bounded_ms AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS "$AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS" 1 60000
validate_bounded_int AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS "$AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS" 1 300
case "$RUNNER_CIRCUIT_HOLD" in
	0 | 1 | auto | AUTO | false | FALSE | true | TRUE | no | NO | yes | YES) ;;
	*)
		log "invalid RUNNER_CIRCUIT_HOLD=${RUNNER_CIRCUIT_HOLD}; expected auto, true, or false"
		exit 64
		;;
esac
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
if ((RUNNER_RESTART_BACKOFF_MAX_MS < RUNNER_RESTART_BACKOFF_BASE_MS)); then
	log "RUNNER_RESTART_BACKOFF_MAX_MS=${RUNNER_RESTART_BACKOFF_MAX_MS} must be at least RUNNER_RESTART_BACKOFF_BASE_MS=${RUNNER_RESTART_BACKOFF_BASE_MS}"
	exit 64
fi
GUARD_STOP_BUDGET_MS=$((GUARD_SHUTDOWN_GRACE_MS + GUARD_SHUTDOWN_CUSHION_MS))

log "runner stop budgets configured; failure_cleanup_budget_ms=${RUNNER_FAILURE_STOP_BUDGET_MS}; intentional_stop_budget_ms=${GUARD_STOP_BUDGET_MS}"

sleep_ms() {
	local remaining_ms="$1" slice_ms
	while ((remaining_ms > 0)); do
		if ((shutdown_requested)); then
			return 0
		fi
		slice_ms=$((remaining_ms < 100 ? remaining_ms : 100))
		# Short slices let the TERM/INT trap run promptly instead of waiting for
		# one long exponential-backoff sleep to return.
		sleep "$(printf '%d.%03d' "$((slice_ms / 1000))" "$((slice_ms % 1000))")" || true
		remaining_ms=$((remaining_ms - slice_ms))
	done
}

epoch_ms() {
	date +%s%3N
}

stop_child() {
	local name="$1" pid="$2" stop_budget_ms="$3"
	if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	log "stopping ${name} pid=${pid}"
	kill "$pid" 2>/dev/null || true
	local started_ms now_ms elapsed_ms remaining_ms poll_ms
	started_ms="$(epoch_ms)"
	while :; do
		if ! kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
		now_ms="$(epoch_ms)"
		elapsed_ms=$((now_ms - started_ms))
		if ((elapsed_ms >= stop_budget_ms)); then
			break
		fi
		remaining_ms=$((stop_budget_ms - elapsed_ms))
		poll_ms=$((remaining_ms < STOP_POLL_INTERVAL_MS ? remaining_ms : STOP_POLL_INTERVAL_MS))
		sleep "$(printf '%d.%03d' "$((poll_ms / 1000))" "$((poll_ms % 1000))")" || true
	done
	if ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi

	log "${name} pid=${pid} did not stop after ${stop_budget_ms}ms; sending SIGKILL"
	kill -KILL "$pid" 2>/dev/null || true
}

remaining_stop_budget() {
	local deadline_ms="$1" now_ms
	now_ms="$(epoch_ms)"
	if ((now_ms >= deadline_ms)); then
		printf '0\n'
	else
		printf '%s\n' "$((deadline_ms - now_ms))"
	fi
}

stop_stack_children() {
	if (($# == 0)); then
		# Intentional TERM/INT keeps the full guard drain grace and the existing
		# short child budgets. It is deliberately not an aggregate deadline.
		log "stopping stack children; cleanup_budget_ms=${GUARD_STOP_BUDGET_MS}; mode=intentional"
		stop_child "ccflare guard" "$guard_pid" "$GUARD_STOP_BUDGET_MS"
		stop_child "better-ccflare upstream" "$upstream_pid" 5000
		stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 5000
	else
		# Unexpected failures use one aggregate deadline so a stubborn child
		# cannot consume the entire guard grace before the restart circuit runs.
		local total_budget_ms="$1"
		local deadline_ms=$(( $(epoch_ms) + total_budget_ms ))
		local remaining_ms
		log "stopping stack children; cleanup_budget_ms=${total_budget_ms}; mode=failure"
		remaining_ms="$(remaining_stop_budget "$deadline_ms")"
		stop_child "ccflare guard" "$guard_pid" "$remaining_ms"
		remaining_ms="$(remaining_stop_budget "$deadline_ms")"
		stop_child "better-ccflare upstream" "$upstream_pid" "$remaining_ms"
		remaining_ms="$(remaining_stop_budget "$deadline_ms")"
		stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" "$remaining_ms"
	fi
	wait "${guard_pid:-0}" 2>/dev/null || true
	wait "${upstream_pid:-0}" 2>/dev/null || true
	wait "${ai_gateway_tunnel_pid:-0}" 2>/dev/null || true
	guard_pid=""
	upstream_pid=""
	ai_gateway_tunnel_pid=""
}

cleanup() {
	if ((cleanup_ran)); then
		return 0
	fi
	cleanup_ran=1
	trap - EXIT TERM INT
	log "stopping ccflare stack"
	stop_stack_children
}

terminate() {
	shutdown_requested=1
	log "shutdown requested; stopping stack without restart"
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
	for _ in $(seq 1 "$RUNNER_HEALTH_MAX_ATTEMPTS"); do
		if ! kill -0 "$pid" 2>/dev/null; then
			set +e
			wait "$pid" 2>/dev/null
			child_exit_status=$?
			set -e
			case "$name" in
				ccflare-guard) child_exit_name="ccflare guard" ;;
				better-ccflare) child_exit_name="better-ccflare upstream" ;;
				*) child_exit_name="$name" ;;
			esac
			classify_child_exit
			log "$name exited before ready; status=${child_exit_status}; class=${child_exit_class}"
			return 1
		fi
		if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
			sleep_ms "$RUNNER_HEALTH_STABILITY_DELAY_MS"
			if kill -0 "$pid" 2>/dev/null; then
				log "$name ready at $url"
				return 0
			fi
			set +e
			wait "$pid" 2>/dev/null
			child_exit_status=$?
			set -e
			case "$name" in
				ccflare-guard) child_exit_name="ccflare guard" ;;
				better-ccflare) child_exit_name="better-ccflare upstream" ;;
				*) child_exit_name="$name" ;;
			esac
			classify_child_exit
			log "$name exited after health check succeeded; status=${child_exit_status}; class=${child_exit_class}"
			return 1
		fi
		sleep_ms "$RUNNER_HEALTH_POLL_INTERVAL_MS"
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
	if ! command -v "$AI_GATEWAY_SSH_BIN" >/dev/null 2>&1; then
		log "${AI_GATEWAY_SSH_BIN} not found; cannot start ai-gateway tunnel"
		return 1
	fi

	log "starting ai-gateway tunnel 127.0.0.1:${AI_GATEWAY_LOCAL_PORT} -> ${AI_GATEWAY_SSH_HOST}:${AI_GATEWAY_REMOTE_HOST}:${AI_GATEWAY_REMOTE_PORT}"
	"$AI_GATEWAY_SSH_BIN" -N -T \
		-o BatchMode=yes \
		-o ExitOnForwardFailure=yes \
		-o ConnectTimeout="${AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS}" \
		-o ServerAliveInterval=30 \
		-o ServerAliveCountMax=3 \
		-o ControlMaster=no \
		-o ControlPath=none \
		-L "127.0.0.1:${AI_GATEWAY_LOCAL_PORT}:${AI_GATEWAY_REMOTE_HOST}:${AI_GATEWAY_REMOTE_PORT}" \
		-- "$AI_GATEWAY_SSH_HOST" &
	ai_gateway_tunnel_pid=$!

	for _ in $(seq 1 "$AI_GATEWAY_TUNNEL_READY_ATTEMPTS"); do
		if ! kill -0 "$ai_gateway_tunnel_pid" 2>/dev/null; then
			set +e
			wait "$ai_gateway_tunnel_pid" 2>/dev/null
			child_exit_status=$?
			set -e
			child_exit_name="ai-gateway ssh tunnel"
			classify_child_exit
			log "ai-gateway tunnel exited before ready; status=${child_exit_status}; class=${child_exit_class}"
			ai_gateway_tunnel_pid=""
			return 1
		fi
		if ai_gateway_tunnel_ready; then
			log "ai-gateway tunnel ready at 127.0.0.1:${AI_GATEWAY_LOCAL_PORT}"
			return 0
		fi
		sleep_ms "$AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS"
	done
	log "ai-gateway tunnel did not become ready at 127.0.0.1:${AI_GATEWAY_LOCAL_PORT}"
	stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 1000
	wait "$ai_gateway_tunnel_pid" 2>/dev/null || true
	ai_gateway_tunnel_pid=""
	return 1
}

require_file "$CCFLARE_BIN"
require_file "$NODE_BIN"
require_file "$GUARD_SCRIPT"

generate_guard_correlation_secret() {
	# One full-stack invocation owns one correlation credential. Keep it in this
	# runner's shell memory and pass it independently to each child environment;
	# never export it globally, persist it, or place it in argv. Generate a new
	# value for every supervised stack cycle so a child-only restart cannot retain
	# stale correlation authority.
	local secret
	secret="$(
		LC_ALL=C head -c 32 /dev/urandom \
			| base64 \
			| tr '+/' '-_' \
			| tr -d '=\n'
	)"
	if [[ ! "$secret" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
		log "failed to generate guard correlation credential"
		return 1
	fi
	guard_correlation_secret="$secret"
}

tunnel_is_required() {
	case "$AI_GATEWAY_TUNNEL_REQUIRED" in
		1 | true | TRUE | yes | YES) return 0 ;;
		*) return 1 ;;
	esac
}

classify_child_exit() {
	if ((shutdown_requested)); then
		child_exit_class="intentional"
	elif ((child_exit_status == 0)); then
		child_exit_class="clean"
	elif ((child_exit_status >= 128)); then
		child_exit_class="signal"
	else
		child_exit_class="failure"
	fi
}

child_name_for_pid() {
	local pid="$1"
	if [[ "$pid" == "$upstream_pid" ]]; then
		printf 'better-ccflare upstream'
	elif [[ "$pid" == "$guard_pid" ]]; then
		printf 'ccflare guard'
	elif [[ -n "$ai_gateway_tunnel_pid" && "$pid" == "$ai_gateway_tunnel_pid" ]]; then
		printf 'ai-gateway ssh tunnel'
	else
		printf 'unknown stack child'
	fi
}

run_stack_once() {
	fatal_startup=0
	child_exit_name=""
	child_exit_status=1
	child_exit_class="failure"
	stack_started_ms=0

	if ! generate_guard_correlation_secret; then
		fatal_startup=1
		return 1
	fi

	if ! start_ai_gateway_tunnel; then
		if tunnel_is_required; then
			# Preserve the operator-facing startup boundary while handing the
			# failure to the bounded supervisor instead of spinning a fatal loop.
			log "ai-gateway tunnel is required; exiting stack cycle"
			child_exit_name="ai-gateway ssh tunnel"
			child_exit_status=1
			child_exit_class="failure"
			return 1
		fi
		log "ai-gateway tunnel unavailable; continuing without last-resort fallback"
		# Optional startup failure is a degraded-but-usable path; do not let its
		# diagnostic identity mask a later upstream or guard failure in this cycle.
		child_exit_name=""
		child_exit_status=1
		child_exit_class="failure"
	fi

	log "starting better-ccflare upstream on 127.0.0.1:${UPSTREAM_PORT}"
	HOME="$HOME" \
		USER="$USER" \
		BETTER_CCFLARE_HOST=127.0.0.1 \
		PORT="$UPSTREAM_PORT" \
		STORE_PAYLOADS=false \
		LOG_LEVEL="${LOG_LEVEL:-warn}" \
		CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS=120000 \
		CCFLARE_GUARD_CORRELATION_SECRET="$guard_correlation_secret" \
		CCFLARE_DEBUG_ANTHROPIC_BOUNDARY="${CCFLARE_DEBUG_ANTHROPIC_BOUNDARY:-1}" \
		CCFLARE_DEBUG_CODEX_STREAM="${CCFLARE_DEBUG_CODEX_STREAM:-1}" \
		"$CCFLARE_BIN" --serve --port "$UPSTREAM_PORT" &
	upstream_pid=$!
	if ! wait_for_url better-ccflare "http://127.0.0.1:${UPSTREAM_PORT}/health" "$upstream_pid"; then
		if [[ -z "$child_exit_name" ]]; then
			child_exit_name="better-ccflare upstream"
			child_exit_status=1
			child_exit_class="failure"
		fi
		return 1
	fi

	log "starting ccflare guard on 127.0.0.1:${GUARD_PORT} -> 127.0.0.1:${UPSTREAM_PORT}; failure_cleanup_budget_ms=${RUNNER_FAILURE_STOP_BUDGET_MS}; intentional_stop_budget_ms=${GUARD_STOP_BUDGET_MS}"
	HOME="$HOME" \
		USER="$USER" \
		GUARD_HOST=127.0.0.1 \
		GUARD_PORT="$GUARD_PORT" \
		CCFLARE_UPSTREAM="http://127.0.0.1:${UPSTREAM_PORT}" \
		GUARD_UPSTREAM_PID="${upstream_pid}" \
		CCFLARE_GUARD_CORRELATION_SECRET="$guard_correlation_secret" \
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
	if ! wait_for_url ccflare-guard "http://127.0.0.1:${GUARD_PORT}/_guard/health" "$guard_pid"; then
		if [[ -z "$child_exit_name" ]]; then
			child_exit_name="ccflare guard"
			child_exit_status=1
			child_exit_class="failure"
		fi
		return 1
	fi

	stack_started_ms="$(epoch_ms)"
	log "ccflare stack ready; upstream_pid=${upstream_pid} guard_pid=${guard_pid}"
	local -a child_pids=("$upstream_pid" "$guard_pid")
	# Use Bash's PID-reporting form for deterministic child classification and
	# include a required or optional tunnel when one is owned by this cycle.
	# Once a tunnel process is owned by this runner, supervise it regardless of
	# whether the tunnel was required. Optional startup may continue without a
	# tunnel, but a later death of a successfully-started optional tunnel must
	# restart the coherent stack rather than silently leaving stale topology.
	if [[ -n "$ai_gateway_tunnel_pid" ]]; then
		child_pids+=("$ai_gateway_tunnel_pid")
	fi
	local exited_pid=""
	set +e
	wait -n -p exited_pid "${child_pids[@]}"
	child_exit_status=$?
	set -e
	child_exit_name="$(child_name_for_pid "$exited_pid")"
	classify_child_exit
	log "ccflare stack child exited; child=${child_exit_name}; status=${child_exit_status}; class=${child_exit_class}"
	if [[ "$child_exit_class" == "intentional" ]]; then
		return 0
	fi
	return 1
}

circuit_hold_enabled() {
	case "$RUNNER_CIRCUIT_HOLD" in
		1 | true | TRUE | yes | YES) [[ -z "${INVOCATION_ID:-}" ]] ;;
		0 | false | FALSE | no | NO) return 1 ;;
		auto | AUTO) return 1 ;;
		*) return 1 ;; # validation above makes this unreachable
	esac
}

circuit_open_exit_status() {
	case "$RUNNER_CIRCUIT_HOLD" in
		auto | AUTO) printf '%s\n' "$RUNNER_CIRCUIT_EXIT_STATUS" ;;
		1 | true | TRUE | yes | YES)
			if [[ -n "${INVOCATION_ID:-}" ]]; then
				printf '%s\n' "$RUNNER_CIRCUIT_EXIT_STATUS"
			else
				printf '1\n'
			fi
			;;
		*) printf '1\n' ;;
	esac
}

wait_for_operator() {
	# Explicit operator hold is intentionally opt-in. Production `auto` mode
	# exits through the service supervisor instead of leaving an active unit with
	# no stack children.
	while (( !shutdown_requested )); do
		sleep_ms 1000
	done
}

schedule_restart() {
	local now delay exponent
	now="$(epoch_ms)"
	if ((restart_window_started_ms == 0)); then
		restart_window_started_ms=$now
	elif ((now - restart_window_started_ms > RUNNER_RESTART_WINDOW_MS)); then
		restart_window_started_ms=$now
		restart_failure_count=0
	elif ((RUNNER_RESTART_STABLE_MS > 0 && stack_started_ms > 0 && now - stack_started_ms >= RUNNER_RESTART_STABLE_MS)); then
		restart_window_started_ms=$now
		restart_failure_count=0
	fi

	((restart_failure_count += 1))
	if ((restart_failure_count >= RUNNER_RESTART_MAX_FAILURES)); then
		if circuit_hold_enabled; then
			log "restart circuit open; supervisor paused until operator restart; child=${child_exit_name}; failures=${restart_failure_count}; cap=${RUNNER_RESTART_MAX_FAILURES}"
			wait_for_operator
			return 0
		fi
		local circuit_status
		circuit_status="$(circuit_open_exit_status)"
		log "restart circuit open; exiting for service supervisor; status=${circuit_status}; child=${child_exit_name}; failures=${restart_failure_count}; cap=${RUNNER_RESTART_MAX_FAILURES}"
		return "$circuit_status"
	fi

	delay=$RUNNER_RESTART_BACKOFF_BASE_MS
	exponent=$((restart_failure_count - 1))
	while ((exponent > 0)); do
		if ((delay == 0)); then
			break
		fi
		if ((delay >= RUNNER_RESTART_BACKOFF_MAX_MS || delay > RUNNER_RESTART_BACKOFF_MAX_MS / 2)); then
			delay=$RUNNER_RESTART_BACKOFF_MAX_MS
			break
		fi
		delay=$((delay * 2))
		exponent=$((exponent - 1))
	done
	if ((delay > RUNNER_RESTART_BACKOFF_MAX_MS)); then
		delay=$RUNNER_RESTART_BACKOFF_MAX_MS
	fi
	log "restarting stack via supervisor; child=${child_exit_name}; class=${child_exit_class}; failure_count=${restart_failure_count}; backoff_ms=${delay}"
	sleep_ms "$delay"
}

while :; do
	if run_stack_once; then
		stop_stack_children
		# The only successful run_stack_once result is an intentional runner
		# shutdown. A child exiting zero is returned as a supervised failure below
		# so it cannot bypass the bounded restart circuit.
		exit 143
	fi

	stop_stack_children "$RUNNER_FAILURE_STOP_BUDGET_MS"
	if ((shutdown_requested)); then
		exit 143
	fi
	if ((fatal_startup)); then
		exit "$child_exit_status"
	fi
	if schedule_restart; then
		:
	else
		schedule_status=$?
		exit "$schedule_status"
	fi
	if ((shutdown_requested)); then
		exit 143
	fi
done
