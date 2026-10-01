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
CCFLARE_SERVER_DRAIN_MS=${CCFLARE_SERVER_DRAIN_MS:-60000}
UPSTREAM_STOP_BUDGET_MS=$((CCFLARE_SERVER_DRAIN_MS + 20000))
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
rss_policy_keys=(RUNNER_RSS_THRESHOLD_BYTES RUNNER_RSS_POLL_INTERVAL_MS RUNNER_RSS_MIN_UPTIME_MS RUNNER_RSS_CONSECUTIVE_SAMPLES RUNNER_RSS_RECYCLE_COOLDOWN_MS RUNNER_RSS_MAX_RECYCLES RUNNER_RSS_RECYCLE_WINDOW_MS)
rss_policy_present=0
for rss_key in "${rss_policy_keys[@]}"; do
	[[ -v "$rss_key" ]] && ((rss_policy_present += 1))
done
if ((rss_policy_present != 0 && rss_policy_present != ${#rss_policy_keys[@]})); then
	printf 'invalid runner RSS policy: all seven values must be configured together\n' >&2
	exit 64
fi
RUNNER_RSS_THRESHOLD_BYTES=${RUNNER_RSS_THRESHOLD_BYTES:-0}
RUNNER_RSS_POLL_INTERVAL_MS=${RUNNER_RSS_POLL_INTERVAL_MS:-60000}
RUNNER_RSS_MIN_UPTIME_MS=${RUNNER_RSS_MIN_UPTIME_MS:-0}
RUNNER_RSS_CONSECUTIVE_SAMPLES=${RUNNER_RSS_CONSECUTIVE_SAMPLES:-1}
RUNNER_RSS_RECYCLE_COOLDOWN_MS=${RUNNER_RSS_RECYCLE_COOLDOWN_MS:-0}
RUNNER_RSS_MAX_RECYCLES=${RUNNER_RSS_MAX_RECYCLES:-0}
RUNNER_RSS_RECYCLE_WINDOW_MS=${RUNNER_RSS_RECYCLE_WINDOW_MS:-86400000}
RUNNER_PROC_ROOT=${RUNNER_PROC_ROOT:-/proc}
# When the local breaker opens, a systemd-managed runner must exit so the
# service is not reported active while its stack children are down. The
# managed unit uses Restart=on-failure plus StartLimit* to own the outer
# restart budget. An explicit `true` remains available for operator-controlled
# one-shot fixtures; `auto` is always service-safe and exits with the distinct
# bounded status below.
RUNNER_CIRCUIT_HOLD=${RUNNER_CIRCUIT_HOLD:-auto}
RUNNER_CIRCUIT_EXIT_STATUS=75
RUNNER_PERSISTENT_GUARD=${RUNNER_PERSISTENT_GUARD:-1}
case "$RUNNER_PERSISTENT_GUARD" in 0 | 1) ;; *) printf 'invalid RUNNER_PERSISTENT_GUARD\n' >&2; exit 64 ;; esac
TRANSACTION_MODULE="$(dirname "${BASH_SOURCE[0]}")/ccflare-deployment-transaction.mjs"
TRANSACTION_DIR=${CCFLARE_TRANSACTION_DIR:-$HOME/.config/better-ccflare/handoff}
deployment_pid=""
pending_deployment=0
pending_rollback=0
transaction_enabled=0
if [[ "${CCFLARE_SCHEMA_DIGEST:-}" =~ ^[0-9a-f]{64}$ && -n "${CCFLARE_PIN_PATH:-}" && -f "$TRANSACTION_MODULE" ]]; then transaction_enabled=1; fi
if ((transaction_enabled)); then "$NODE_BIN" "$TRANSACTION_MODULE" recover "$TRANSACTION_DIR" >/dev/null || { printf "unfinished backend transaction requires operator recovery\n" >&2; exit 70; }; fi
control_dir=""
control_pid=""
guard_control_secret=""
upstream_generation=1
pending_replacement=0

upstream_pid=""
guard_pid=""
ai_gateway_tunnel_pid=""
watchdog_pid=""
cleanup_ran=0
shutdown_requested=0
fatal_startup=0
child_exit_name=""
child_exit_status=1
child_exit_class="failure"
restart_failure_count=0
restart_window_started_ms=0
stack_started_ms=0
rss_recycle_count=0
rss_recycle_window_started_ms=0
rss_last_recycle_ms=0

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

validate_bounded_ms CCFLARE_SERVER_DRAIN_MS "$CCFLARE_SERVER_DRAIN_MS" 0 2147403647
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
validate_bounded_ms RUNNER_RSS_POLL_INTERVAL_MS "$RUNNER_RSS_POLL_INTERVAL_MS" 1 2147483647
validate_bounded_ms RUNNER_RSS_MIN_UPTIME_MS "$RUNNER_RSS_MIN_UPTIME_MS" 0 2147483647
validate_bounded_int RUNNER_RSS_CONSECUTIVE_SAMPLES "$RUNNER_RSS_CONSECUTIVE_SAMPLES" 1 1000000
validate_bounded_ms RUNNER_RSS_RECYCLE_COOLDOWN_MS "$RUNNER_RSS_RECYCLE_COOLDOWN_MS" 0 2147483647
validate_bounded_int RUNNER_RSS_MAX_RECYCLES "$RUNNER_RSS_MAX_RECYCLES" 0 1000000
validate_bounded_ms RUNNER_RSS_RECYCLE_WINDOW_MS "$RUNNER_RSS_RECYCLE_WINDOW_MS" 1 2147483647
if [[ ! "$RUNNER_RSS_THRESHOLD_BYTES" =~ ^(0|[1-9][0-9]{0,15})$ ]] || ((RUNNER_RSS_THRESHOLD_BYTES > 9007199254740991)); then
	log "invalid RUNNER_RSS_THRESHOLD_BYTES=${RUNNER_RSS_THRESHOLD_BYTES}; expected 0..9007199254740991"
	exit 64
fi
if ((RUNNER_RSS_THRESHOLD_BYTES > 0 && RUNNER_RSS_MAX_RECYCLES < 1)); then
	log "invalid runner RSS policy: enabled threshold requires at least one recycle"
	exit 64
fi
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

deployment_field() {
 "$NODE_BIN" - "$TRANSACTION_DIR/intent.json" "$1" <<'NODE'
const fs=require("node:fs");const [path,key]=process.argv.slice(2);const t=JSON.parse(fs.readFileSync(path));const value=key.split(".").reduce((v,k)=>v?.[k],t);if(value==null)process.exit(1);process.stdout.write(String(value));
NODE
}
transaction_advance() { "$NODE_BIN" "$TRANSACTION_MODULE" advance "$TRANSACTION_DIR" "$@" >/dev/null; }
start_deployment_listener() {
 local initial="$TRANSACTION_DIR/runtime-input.json"
 mkdir -p "$TRANSACTION_DIR"; chmod 700 "$TRANSACTION_DIR"
 CCFLARE_ACTIVE_PID="$upstream_pid" CCFLARE_ACTIVE_START="$(proc_start_time "$upstream_pid" /proc)" CCFLARE_ACTIVE_GENERATION="$upstream_generation" CCFLARE_ACTIVE_CONTROL="$control_dir" CCFLARE_ACTIVE_BIN="$CCFLARE_BIN" CCFLARE_ACTIVE_RUNNER="${BASH_SOURCE[0]}" CCFLARE_ACTIVE_GUARD="$GUARD_SCRIPT" "$NODE_BIN" - "$initial" <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");const e=process.env;const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");const r={generation:Number(e.CCFLARE_ACTIVE_GENERATION),oldPid:Number(e.CCFLARE_ACTIVE_PID),oldStartTime:e.CCFLARE_ACTIVE_START,binary:fs.realpathSync(e.CCFLARE_ACTIVE_BIN),binaryHash:hash(e.CCFLARE_ACTIVE_BIN),backendSourceSha:e.CCFLARE_SOURCE_SHA,schemaDigest:e.CCFLARE_SCHEMA_DIGEST,ingress:{runner:hash(e.CCFLARE_ACTIVE_RUNNER),guard:hash(e.CCFLARE_ACTIVE_GUARD),policy:hash(path.join(path.dirname(e.CCFLARE_ACTIVE_GUARD),"ccflare-guard-policy.mjs")),timing:hash(path.join(path.dirname(e.CCFLARE_ACTIVE_GUARD),"ccflare-managed-timing.mjs")),transaction:hash(path.join(path.dirname(e.CCFLARE_ACTIVE_RUNNER),"ccflare-deployment-transaction.mjs"))},pinPath:e.CCFLARE_PIN_PATH,pinHash:hash(e.CCFLARE_PIN_PATH),controlDir:e.CCFLARE_ACTIVE_CONTROL};fs.writeFileSync(process.argv[2],JSON.stringify(r),{mode:0o600});
NODE
 "$NODE_BIN" "$TRANSACTION_MODULE" serve "$TRANSACTION_DIR" "$initial" &
 deployment_pid=$!
}
stop_stack_children() {
 if [[ -n "$deployment_pid" ]]; then kill "$deployment_pid" 2>/dev/null || true; wait "$deployment_pid" 2>/dev/null || true; deployment_pid=""; fi
	if (($# == 0)); then
		# Intentional TERM/INT keeps the full guard drain grace and the existing
		# short child budgets. It is deliberately not an aggregate deadline.
		log "stopping stack children; cleanup_budget_ms=${GUARD_STOP_BUDGET_MS}; mode=intentional"
		stop_child "ccflare guard" "$guard_pid" "$GUARD_STOP_BUDGET_MS"
		stop_child "better-ccflare upstream" "$upstream_pid" "$UPSTREAM_STOP_BUDGET_MS"
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
	if [[ -n "$watchdog_pid" ]]; then
		kill "$watchdog_pid" 2>/dev/null || true
		wait "$watchdog_pid" 2>/dev/null || true
	fi
	guard_pid=""
	upstream_pid=""
	ai_gateway_tunnel_pid=""
	watchdog_pid=""
}

proc_start_time() {
	local line rest
	IFS= read -r line <"${2:-$RUNNER_PROC_ROOT}/$1/stat" || return 1
	rest="${line##*) }"
	set -- $rest
	[[ "${20}" =~ ^[0-9]+$ ]] || return 1
	printf '%s\n' "${20}"
}

# Total committed anonymous memory for a pid: VmRSS + VmSwap, in bytes.
#
# VmRSS alone is not a containment signal. When the host comes under memory
# pressure the kernel evicts the leaking process's pages to swap, which
# *lowers* its VmRSS -- so an RSS-only threshold goes blind exactly when
# containment is needed. Observed 2026-09-09 in production: the upstream held
# 0.69 GiB VmRSS against 10.66 GiB VmSwap -- 2.8x the 4 GiB threshold -- while
# the watchdog sampled 17% of it, reset its streak every poll, and never fired.
# Refs #277.
#
# VmSwap is absent on kernels built without swap support; treat a missing field
# as zero rather than failing the sample, so swapless hosts keep the previous
# RSS-only behavior instead of silently losing containment altogether.
#
# Prints "<total_bytes> <rss_bytes> <swap_bytes>" so the caller can log the
# breakdown that made this failure invisible in the first place.
proc_mem_bytes() {
	local key kib unit extra rss="" swap=0
	while read -r key kib unit extra; do
		case "$key" in
		VmRSS: | VmSwap:)
			[[ "$kib" =~ ^[0-9]+$ && "$unit" == "kB" && -z "${extra:-}" ]] || return 1
			((kib <= 8796093022207)) || return 1
			if [[ "$key" == "VmRSS:" ]]; then rss="$kib"; else swap="$kib"; fi
			;;
		esac
	done <"$RUNNER_PROC_ROOT/$1/status"
	[[ -n "$rss" ]] || return 1
	((rss + swap <= 8796093022207)) || return 1
	printf '%s %s %s\n' "$(((rss + swap) * 1024))" "$((rss * 1024))" "$((swap * 1024))"
	return 0
}

wait_watchdog_interval() {
	local interval_ms="$1" sleep_pid status
	sleep "$(printf '%d.%03d' "$((interval_ms / 1000))" "$((interval_ms % 1000))")" &
	sleep_pid=$!
	trap 'kill "$sleep_pid" 2>/dev/null || true' TERM INT EXIT
	set +e
	wait "$sleep_pid"
	status=$?
	set -e
	trap - TERM INT EXIT
	return "$status"
}

rss_watchdog() {
	local pid="$1" identity="$2" generation_started_ms="$3" streak=0 now sample mem rss swap current_identity
	while :; do
		wait_watchdog_interval "$RUNNER_RSS_POLL_INTERVAL_MS" || return 0
		current_identity="$(proc_start_time "$pid" 2>/dev/null)" || continue
		[[ "$current_identity" == "$identity" ]] || continue
		kill -0 "$pid" 2>/dev/null || continue
		now="$(epoch_ms)"
		((now - generation_started_ms >= RUNNER_RSS_MIN_UPTIME_MS)) || continue
		((rss_last_recycle_ms == 0 || now - rss_last_recycle_ms >= RUNNER_RSS_RECYCLE_COOLDOWN_MS)) || continue
		sample="$(proc_mem_bytes "$pid" 2>/dev/null)" || continue
		read -r mem rss swap <<<"$sample" || true
		# Re-check the start-time identity after the memory read: the two reads
		# are not atomic, so a PID that was replaced in between would otherwise be
		# charged with another process's memory. Discard the sample instead.
		current_identity="$(proc_start_time "$pid" 2>/dev/null)" || continue
		[[ "$current_identity" == "$identity" ]] || continue
		if ((mem >= RUNNER_RSS_THRESHOLD_BYTES)); then
			((streak += 1))
		else
			streak=0
		fi
		if ((streak >= RUNNER_RSS_CONSECUTIVE_SAMPLES)); then
			if ((rss_recycle_count >= RUNNER_RSS_MAX_RECYCLES && rss_recycle_window_started_ms > 0 && now - rss_recycle_window_started_ms < RUNNER_RSS_RECYCLE_WINDOW_MS)); then
				log "RSS recycle suppressed; cap exhausted; recycles=${rss_recycle_count}; window_ms=${RUNNER_RSS_RECYCLE_WINDOW_MS}"
				streak=0
				continue
			fi
			log "RSS recycle trigger; upstream_pid=${pid}; mem_bytes=${mem}; rss_bytes=${rss}; swap_bytes=${swap}; threshold_bytes=${RUNNER_RSS_THRESHOLD_BYTES}; samples=${streak}"
			return 66
		fi
	done
}

stop_guard_for_memory_recycle() {
	local pid="$1" stop_budget_ms="$2" started_ms now_ms elapsed_ms remaining_ms poll_ms status enforcer_pid
	log "stopping ccflare guard pid=${pid} for memory recycle; stop_budget_ms=${stop_budget_ms}"
	kill "$pid" 2>/dev/null || true
	(
		started_ms="$(epoch_ms)"
		while kill -0 "$pid" 2>/dev/null; do
			now_ms="$(epoch_ms)"
			elapsed_ms=$((now_ms - started_ms))
			if ((elapsed_ms >= stop_budget_ms)); then
				log "ccflare guard pid=${pid} did not stop after ${stop_budget_ms}ms during memory recycle; sending SIGKILL"
				kill -KILL "$pid" 2>/dev/null || true
				exit 0
			fi
			remaining_ms=$((stop_budget_ms - elapsed_ms))
			poll_ms=$((remaining_ms < STOP_POLL_INTERVAL_MS ? remaining_ms : STOP_POLL_INTERVAL_MS))
			sleep "$(printf '%d.%03d' "$((poll_ms / 1000))" "$((poll_ms % 1000))")" || true
		done
	) &
	enforcer_pid=$!
	set +e
	wait "$pid"
	status=$?
	kill "$enforcer_pid" 2>/dev/null
	wait "$enforcer_pid" 2>/dev/null
	set -e
	return "$status"
}

stop_stack_for_memory_recycle() {
	local guard_status=1
	log "memory recycle drain starting; ordering=guard,upstream,tunnel; grace_ms=${GUARD_SHUTDOWN_GRACE_MS}"
	if [[ -n "$guard_pid" ]] && kill -0 "$guard_pid" 2>/dev/null; then
		if stop_guard_for_memory_recycle "$guard_pid" "$GUARD_STOP_BUDGET_MS"; then
			guard_status=0
		else
			guard_status=$?
		fi
	fi
	case "$guard_status" in
		0) log "memory recycle guard drain outcome=natural status=0" ;;
		70) log "memory recycle guard drain outcome=forced status=70" ;;
		*) log "memory recycle failed: unknown guard drain status=${guard_status}"; return 1 ;;
	esac
	guard_pid=""
	stop_child "better-ccflare upstream" "$upstream_pid" "$UPSTREAM_STOP_BUDGET_MS"
	stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 5000
	[[ -n "$watchdog_pid" ]] && { kill "$watchdog_pid" 2>/dev/null || true; wait "$watchdog_pid" 2>/dev/null || true; }
	wait "${upstream_pid:-0}" 2>/dev/null || true
	wait "${ai_gateway_tunnel_pid:-0}" 2>/dev/null || true
	upstream_pid=""; ai_gateway_tunnel_pid=""; watchdog_pid=""
}

cleanup() {
	if ((cleanup_ran)); then
		return 0
	fi
	cleanup_ran=1
	trap - EXIT TERM INT
	if [[ -n "$control_pid" ]]; then kill "$control_pid" 2>/dev/null || true; wait "$control_pid" 2>/dev/null || true; control_pid=""; fi
	log "stopping ccflare stack"
	stop_stack_children
	if [[ -n "$control_dir" ]]; then rm -f -- "$control_dir/control.sock" "$control_dir/deploy.sock" "$control_dir/deploy-credential"; rmdir -- "$control_dir" 2>/dev/null || true; fi
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

# The socket directory is private and per runner lifetime; credentials never
# enter argv, logs, or persistent files. The client is an owned child so TERM
# interrupts a pending drain instead of waiting for a long synchronous command.
guard_control() {
	local command="$1" target_generation="$2" candidate_pid="${3:-0}" candidate_start="${4:-0}" status
	GUARD_CONTROL_SECRET="$guard_control_secret" CCFLARE_GUARD_CORRELATION_SECRET="$guard_correlation_secret" CCFLARE_MANAGED_CANDIDATE_NONCE="${CCFLARE_MANAGED_CANDIDATE_NONCE:-}" CCFLARE_DEPLOYMENT_TRANSACTION_ID="${CCFLARE_DEPLOYMENT_TRANSACTION_ID:-}" CCFLARE_DEPLOYMENT_ROLLBACK="${CCFLARE_DEPLOYMENT_ROLLBACK:-0}" CCFLARE_DEPLOYMENT_INTENT_PATH="$TRANSACTION_DIR/intent.json" \
		"$NODE_BIN" - "$control_dir/control.sock" "$command" "$target_generation" "$candidate_pid" "$candidate_start" "$GUARD_STOP_BUDGET_MS" <<'NODE' &
const net = require("node:net");
const [path, command, generation, pid, startTime, budget] = process.argv.slice(2);
const socket = net.createConnection(path);
let output = "", settled = false;
const fail = () => { if (settled) return; settled = true; socket.destroy(); process.exitCode = 1; };
socket.setTimeout(Number(budget) + 3000, fail);
socket.on("error", fail);
socket.on("connect", () => socket.write(JSON.stringify({ command, generation: Number(generation), pid: Number(pid), startTime, secret: process.env.GUARD_CONTROL_SECRET, correlationSecret: process.env.CCFLARE_GUARD_CORRELATION_SECRET, candidateNonce: process.env.CCFLARE_MANAGED_CANDIDATE_NONCE, transactionId: process.env.CCFLARE_DEPLOYMENT_TRANSACTION_ID || undefined, rollback: process.env.CCFLARE_DEPLOYMENT_ROLLBACK === "1", manifest: command === "prepare" ? (()=>{const t=JSON.parse(require("node:fs").readFileSync(process.env.CCFLARE_DEPLOYMENT_INTENT_PATH));return {...t.manifest,intentPath:process.env.CCFLARE_DEPLOYMENT_INTENT_PATH,pinPath:t.previous.pinPath};})() : undefined }) + "\n"));
socket.on("data", chunk => { output += chunk.toString(); if (output.length > 4096) fail(); });
socket.on("end", () => {
 if (settled) return;
 try { const result = JSON.parse(output); if (!result.ok) { fail(); return; } settled = true; if (result.outcome) process.stdout.write(`guard recycle outcome=${result.outcome}\n`); }
 catch { fail(); }
});
NODE
	control_pid=$!
	if wait "$control_pid"; then status=0; else status=$?; fi
	control_pid=""
	return "$status"
}

begin_backend_deployment() {
 deployment_pid=""
 export CCFLARE_DEPLOYMENT_ROLLBACK=0
 export CCFLARE_DEPLOYMENT_TRANSACTION_ID="$(deployment_field manifest.transactionId)"
 export CCFLARE_MANAGED_CANDIDATE_NONCE="$(deployment_field manifest.candidateNonce)"
 guard_control prepare "$upstream_generation" || return 1
 transaction_advance prepared draining || return 1
 guard_control begin "$upstream_generation" || return 1
 [[ "$(proc_start_time "$upstream_pid" /proc)" == "$(deployment_field previous.oldStartTime)" ]] || return 1
 stop_child "better-ccflare upstream" "$upstream_pid" "$UPSTREAM_STOP_BUDGET_MS"
 wait "$upstream_pid" 2>/dev/null || true
 transaction_advance draining old_reaped || return 1
 upstream_pid=""
 if [[ -n "$watchdog_pid" ]]; then kill "$watchdog_pid" 2>/dev/null || true; wait "$watchdog_pid" 2>/dev/null || true; watchdog_pid=""; fi
 CCFLARE_BIN="$(deployment_field manifest.candidateBinary)"
 export CCFLARE_SOURCE_SHA="$(deployment_field manifest.candidateSourceSha)" CCFLARE_GIT_SHA="$(deployment_field manifest.candidateSourceSha)"
 ((upstream_generation+=1));pending_replacement=1;pending_deployment=1
}
verify_and_commit_backend_deployment() {
 local start="$(proc_start_time "$upstream_pid" /proc)" waited=0
 guard_control verify "$upstream_generation" "$upstream_pid" "$start" || return 1
 transaction_advance candidate_started candidate_verified || return 1
 while ((waited<600 && !shutdown_requested)); do
  if "$NODE_BIN" - "$TRANSACTION_DIR" <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto");try{const d=process.argv[2],t=JSON.parse(fs.readFileSync(d+"/intent.json")),r=JSON.parse(fs.readFileSync(d+"/commit.json")),hash=crypto.createHash("sha256").update(fs.readFileSync(t.previous.pinPath)).digest("hex");if(r.transactionId!==t.manifest.transactionId||r.pinHash!==t.manifest.candidatePinHash||hash!==r.pinHash)process.exit(1);}catch{process.exit(1);}
NODE
  then transaction_advance candidate_verified committed; return 0; fi
  sleep_ms 100;((waited+=1))
 done
 return 1
}
recycle_upstream_with_persistent_guard() {
	log "memory recycle drain starting; ordering=guard-barrier,upstream; grace_ms=${GUARD_SHUTDOWN_GRACE_MS}; guard_listener=retained"
	guard_control begin "$upstream_generation" || return 1
	# The guard has fenced all old dispatches. Reap the sole DB owner before
	# allowing a replacement to bind the same upstream port.
	stop_child "better-ccflare upstream" "$upstream_pid" "$UPSTREAM_STOP_BUDGET_MS"
	wait "$upstream_pid" 2>/dev/null || true
	upstream_pid=""
	[[ -n "$watchdog_pid" ]] && { wait "$watchdog_pid" 2>/dev/null || true; }
	watchdog_pid=""
	((upstream_generation += 1))
	pending_replacement=1
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

	if [[ -z "$guard_pid" ]] && ! start_ai_gateway_tunnel; then
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

	if [[ -z "$guard_pid" && "$RUNNER_PERSISTENT_GUARD" == "1" ]]; then
		if [[ -n "$control_dir" ]]; then rm -f -- "$control_dir/control.sock" "$control_dir/deploy.sock" "$control_dir/deploy-credential"; rmdir -- "$control_dir" 2>/dev/null || true; fi
		control_dir="$(mktemp -d "${TMPDIR:-/tmp}/ccflare-control.XXXXXX")"
		chmod 700 "$control_dir"
		guard_control_secret="$(LC_ALL=C head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
		[[ "$guard_control_secret" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 1
		upstream_generation=1
		pending_replacement=0
	fi

	CCFLARE_MANAGED_INGRESS_NONCE=${CCFLARE_MANAGED_INGRESS_NONCE:-$(LC_ALL=C head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}
	if ((pending_deployment || pending_rollback)); then CCFLARE_MANAGED_CANDIDATE_NONCE="$(deployment_field manifest.candidateNonce)"; else CCFLARE_MANAGED_CANDIDATE_NONCE=$(LC_ALL=C head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'); fi
	export CCFLARE_MANAGED_TIMING="${CCFLARE_MANAGED_TIMING:-0}" CCFLARE_MANAGED_INGRESS_NONCE CCFLARE_MANAGED_CANDIDATE_NONCE
	export CCFLARE_MANAGED_GENERATION="$upstream_generation"
	if ((transaction_enabled)); then "$NODE_BIN" "$TRANSACTION_MODULE" owner-spawning "$TRANSACTION_DIR" || return 1; fi
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
	if ((transaction_enabled)); then
		local candidate_start
		if ! candidate_start="$(proc_start_time "$upstream_pid" /proc)"; then
			if ((pending_deployment)); then transaction_advance old_reaped held '{"reason":"candidate_start_identity_unavailable"}' || true; fi
			log "backend start held: candidate_start_identity_unavailable"
			return 1
		fi
		"$NODE_BIN" "$TRANSACTION_MODULE" owner-started "$TRANSACTION_DIR" "$upstream_pid" "$candidate_start" || return 1
		if ((pending_deployment)); then transaction_advance old_reaped candidate_started "{\"candidatePid\":$upstream_pid,\"candidateStartTime\":\"$candidate_start\"}" || return 1; fi
	fi
	if ! wait_for_url better-ccflare "http://127.0.0.1:${UPSTREAM_PORT}/health" "$upstream_pid"; then
		if [[ -z "$child_exit_name" ]]; then
			child_exit_name="better-ccflare upstream"
			child_exit_status=1
			child_exit_class="failure"
		fi
		return 1
	fi

	if [[ -n "$guard_pid" ]]; then
		if ((pending_deployment)) && ! verify_and_commit_backend_deployment; then log "candidate failed before committed handoff"; return 1; fi
		if ! guard_control attach "$upstream_generation" "$upstream_pid" "$(proc_start_time "$upstream_pid" /proc)"; then
			log "replacement generation verification failed; admission remains fenced"
			return 1
		fi
		pending_replacement=0
		if ((pending_deployment)); then transaction_advance committed attached; pending_deployment=0; unset CCFLARE_DEPLOYMENT_TRANSACTION_ID; fi
		if ((pending_rollback)); then pending_rollback=0; unset CCFLARE_DEPLOYMENT_TRANSACTION_ID CCFLARE_DEPLOYMENT_ROLLBACK; fi
	else
	log "starting ccflare guard on 127.0.0.1:${GUARD_PORT} -> 127.0.0.1:${UPSTREAM_PORT}; failure_cleanup_budget_ms=${RUNNER_FAILURE_STOP_BUDGET_MS}; intentional_stop_budget_ms=${GUARD_STOP_BUDGET_MS}"
	HOME="$HOME" \
		USER="$USER" \
		GUARD_HOST=127.0.0.1 \
		GUARD_PORT="$GUARD_PORT" \
		CCFLARE_UPSTREAM="http://127.0.0.1:${UPSTREAM_PORT}" \
		GUARD_UPSTREAM_PID="${upstream_pid}" \
		GUARD_CONTROL_SOCKET="${control_dir:+$control_dir/control.sock}" \
		GUARD_CONTROL_SECRET="$guard_control_secret" \
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

	fi
	stack_started_ms="$(epoch_ms)"
	log "ccflare stack ready; upstream_pid=${upstream_pid} guard_pid=${guard_pid}"
	local -a child_pids=("$upstream_pid" "$guard_pid")
	if ((transaction_enabled)); then start_deployment_listener; child_pids+=("$deployment_pid"); fi
	# Use Bash's PID-reporting form for deterministic child classification and
	# include a required or optional tunnel when one is owned by this cycle.
	# Once a tunnel process is owned by this runner, supervise it regardless of
	# whether the tunnel was required. Optional startup may continue without a
	# tunnel, but a later death of a successfully-started optional tunnel must
	# restart the coherent stack rather than silently leaving stale topology.
	if [[ -n "$ai_gateway_tunnel_pid" ]]; then
		child_pids+=("$ai_gateway_tunnel_pid")
	fi
	if ((RUNNER_RSS_THRESHOLD_BYTES > 0)); then
		local upstream_identity
		upstream_identity="$(proc_start_time "$upstream_pid")" || { log "cannot capture upstream proc start-time identity"; fatal_startup=1; return 1; }
		rss_watchdog "$upstream_pid" "$upstream_identity" "$stack_started_ms" &
		watchdog_pid=$!
		child_pids+=("$watchdog_pid")
	fi
	local exited_pid=""
	set +e
	wait -n -p exited_pid "${child_pids[@]}"
	child_exit_status=$?
	set -e
	if [[ -n "$deployment_pid" && "$exited_pid" == "$deployment_pid" && "$child_exit_status" == "67" ]]; then
		child_exit_name="backend deployment"; child_exit_class="deployment"
	elif [[ -n "$watchdog_pid" && "$exited_pid" == "$watchdog_pid" && "$child_exit_status" == "66" ]]; then
		child_exit_name="RSS watchdog"
		child_exit_class="memory-recycle"
	else
	child_exit_name="$(child_name_for_pid "$exited_pid")"
	classify_child_exit
	fi
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

	if [[ "$child_exit_class" == "deployment" ]]; then
		if begin_backend_deployment; then continue; fi
		log "backend deployment failed; dispatch held for operator recovery"; wait_for_operator; exit 70
	fi
	if ((pending_deployment)); then
		stop_child "failed candidate" "$upstream_pid" "$UPSTREAM_STOP_BUDGET_MS"; wait "${upstream_pid:-0}" 2>/dev/null || true; upstream_pid=""
		phase="$(deployment_field phase)"
		if transaction_advance "$phase" rolled_back; then
			CCFLARE_BIN="$(deployment_field previous.binary)"; export CCFLARE_SOURCE_SHA="$(deployment_field previous.backendSourceSha)" CCFLARE_GIT_SHA="$(deployment_field previous.backendSourceSha)" CCFLARE_DEPLOYMENT_ROLLBACK=1
			pending_deployment=0;pending_rollback=1;continue
		fi
		log "backend deployment recovery held; pin or ownership ambiguity"; wait_for_operator; exit 70
	fi
	if [[ "$child_exit_class" == "memory-recycle" ]]; then
		if ((transaction_enabled)); then
			# Serialize mutable lifecycle intent: after the daemon is reaped it
			# cannot accept a stale-generation manifest during an RSS handoff.
			stop_child "backend deployment listener" "$deployment_pid" 5000
			wait "${deployment_pid:-0}" 2>/dev/null || true
			deployment_pid=""
			if [[ -f "$TRANSACTION_DIR/intent.json" && "$(deployment_field phase)" == "prepared" ]]; then
				if [[ "$(deployment_field manifest.expectedGeneration)" == "$upstream_generation" ]] && begin_backend_deployment; then
					log "prepared deployment superseded RSS recycle after listener retirement"
					continue
				fi
				log "RSS recycle held by incompatible prepared transaction"; wait_for_operator; exit 70
			fi
		fi
		now_ms="$(epoch_ms)"
		if ((rss_recycle_window_started_ms == 0 || now_ms - rss_recycle_window_started_ms >= RUNNER_RSS_RECYCLE_WINDOW_MS)); then
			rss_recycle_window_started_ms=$now_ms; rss_recycle_count=0
		fi
		if { [[ "$RUNNER_PERSISTENT_GUARD" == "1" ]] && recycle_upstream_with_persistent_guard; } || { [[ "$RUNNER_PERSISTENT_GUARD" == "0" ]] && stop_stack_for_memory_recycle; }; then
			((rss_recycle_count += 1)); rss_last_recycle_ms=$now_ms
			log "restarting stack after memory recycle; recycle_count=${rss_recycle_count}; no_failure_backoff=true"
			continue
		fi
	fi
	if ((pending_replacement)) && [[ -n "$guard_pid" ]] && kill -0 "$guard_pid" 2>/dev/null; then
		stop_child "failed replacement upstream" "$upstream_pid" "$RUNNER_FAILURE_STOP_BUDGET_MS"
		wait "${upstream_pid:-0}" 2>/dev/null || true
		upstream_pid=""
		log "replacement failed; guard remains available with bounded admission"
		if schedule_restart; then continue; else replacement_status=$?; fi
		# Exhausting the existing circuit is terminal; ordinary cleanup/systemd
		# owns recovery. Never leave an active unit with no viable upstream.
		stop_stack_children "$RUNNER_FAILURE_STOP_BUDGET_MS"
		exit "$replacement_status"
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
