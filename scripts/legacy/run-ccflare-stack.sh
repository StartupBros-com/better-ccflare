#!/usr/bin/env bash
set -Eeuo pipefail

export HOME=/home/will
export USER=will
export PATH=/home/will/.local/share/mise/shims:/home/will/.local/share/mise/installs/node/24.13.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CCFLARE_BIN=${CCFLARE_BIN:-/home/will/.config/better-ccflare/better-ccflare-v3.5.34-drain-5dcbde36}
NODE_BIN=${NODE_BIN:-/home/will/.local/share/mise/shims/node}
GUARD_SCRIPT=${GUARD_SCRIPT:-/home/will/.config/better-ccflare/ccflare-guard.mjs}
UPSTREAM_PORT=${CCFLARE_UPSTREAM_PORT:-8789}
GUARD_PORT=${GUARD_PORT:-8788}
AI_GATEWAY_TUNNEL_ENABLED=${AI_GATEWAY_TUNNEL_ENABLED:-1}
AI_GATEWAY_TUNNEL_REQUIRED=${AI_GATEWAY_TUNNEL_REQUIRED:-1}
AI_GATEWAY_SSH_HOST=${AI_GATEWAY_SSH_HOST:-root@100.121.216.26}
AI_GATEWAY_LOCAL_PORT=${AI_GATEWAY_LOCAL_PORT:-14000}
AI_GATEWAY_REMOTE_HOST=${AI_GATEWAY_REMOTE_HOST:-127.0.0.1}
AI_GATEWAY_REMOTE_PORT=${AI_GATEWAY_REMOTE_PORT:-4000}

upstream_pid=""
guard_pid=""
ai_gateway_tunnel_pid=""
cleanup_ran=0

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

stop_child() {
  local name="$1" pid="$2"
  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  log "stopping ${name} pid=${pid}"
  kill "${pid}" 2>/dev/null || true
  for _ in $(seq 1 25); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  log "${name} pid=${pid} did not stop after SIGTERM; sending SIGKILL"
  kill -KILL "${pid}" 2>/dev/null || true
}

cleanup() {
  if (( cleanup_ran )); then
    return 0
  fi
  cleanup_ran=1
  trap - EXIT TERM INT
  log "stopping ccflare stack"
  stop_child "ccflare guard" "${guard_pid}"
  stop_child "better-ccflare upstream" "${upstream_pid}"
  stop_child "ai-gateway ssh tunnel" "${ai_gateway_tunnel_pid}"
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
  curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:${AI_GATEWAY_LOCAL_PORT}/health" >/dev/null 2>&1
}

start_ai_gateway_tunnel() {
  case "${AI_GATEWAY_TUNNEL_ENABLED}" in
    1|true|TRUE|yes|YES) ;;
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
    "${AI_GATEWAY_SSH_HOST}" &
  ai_gateway_tunnel_pid=$!

  for _ in $(seq 1 40); do
    if ! kill -0 "${ai_gateway_tunnel_pid}" 2>/dev/null; then
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
  if [[ "${AI_GATEWAY_TUNNEL_REQUIRED}" == "1" || "${AI_GATEWAY_TUNNEL_REQUIRED}" == "true" ]]; then
    log "ai-gateway tunnel is required; exiting"
    exit 1
  fi
  log "ai-gateway tunnel unavailable; continuing without last-resort fallback"
fi

log "starting better-ccflare upstream on 127.0.0.1:${UPSTREAM_PORT}"
env \
  HOME=/home/will \
  USER=will \
  BETTER_CCFLARE_HOST=127.0.0.1 \
  PORT="${UPSTREAM_PORT}" \
  STORE_PAYLOADS=false \
  LOG_LEVEL=warn \
  CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS=120000 \
  CCFLARE_DEBUG_ANTHROPIC_BOUNDARY="${CCFLARE_DEBUG_ANTHROPIC_BOUNDARY:-1}" \
  CCFLARE_DEBUG_CODEX_STREAM="${CCFLARE_DEBUG_CODEX_STREAM:-1}" \
  "$CCFLARE_BIN" --serve --port "${UPSTREAM_PORT}" &
upstream_pid=$!
wait_for_url better-ccflare "http://127.0.0.1:${UPSTREAM_PORT}/health" "$upstream_pid"

log "starting ccflare guard on 127.0.0.1:${GUARD_PORT} -> 127.0.0.1:${UPSTREAM_PORT}"
env \
  HOME=/home/will \
  USER=will \
  GUARD_HOST=127.0.0.1 \
  GUARD_PORT="${GUARD_PORT}" \
  CCFLARE_UPSTREAM="http://127.0.0.1:${UPSTREAM_PORT}" \
  GUARD_MAX_ACTIVE="${CCFLARE_GUARD_MAX_ACTIVE:-${GUARD_MAX_ACTIVE:-12}}" \
  GUARD_MAX_QUEUE="${CCFLARE_GUARD_MAX_QUEUE:-${GUARD_MAX_QUEUE:-500}}" \
  GUARD_MAX_WAIT_MS="${CCFLARE_GUARD_MAX_WAIT_MS:-${GUARD_MAX_WAIT_MS:-1800000}}" \
  GUARD_RETRY_JITTER_MS="${CCFLARE_GUARD_RETRY_JITTER_MS:-${GUARD_RETRY_JITTER_MS:-15000}}" \
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
