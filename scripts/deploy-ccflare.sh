#!/usr/bin/env bash
#
# deploy-ccflare.sh — deploy better-ccflare to the production systemd stack
# from a local checkout.
#
# WHY THIS SCRIPT EXISTS
#   Production has historically been deployed by hand: build whatever branch
#   happens to be checked out, hand-type a short hash into the binary
#   filename, hand-edit the root-owned systemd pin, restart. Nothing forced
#   deployed code to actually be on `main` — see the pile of hand-named
#   binaries (better-ccflare-v*-drill-*, -logfix-*, -progate-*, ...) in
#   /home/will/.config/better-ccflare. This script replaces that process
#   with one command, and — the actual point — it REFUSES to build/deploy
#   any commit that is not an ancestor of origin/main. Production may only
#   ever run code that has landed on main.
#
# USAGE
#   scripts/deploy-ccflare.sh            Build, deploy, restart, verify.
#   scripts/deploy-ccflare.sh --check    Run ONLY the main-ancestry gate,
#                                        print OK/refuse, and exit. Builds
#                                        and deploys nothing. Safe to run
#                                        any time, from any branch, to test
#                                        the gate itself.
#
# WHAT A FULL RUN DOES
#   1. `git fetch origin` (quiet), then refuse unless HEAD is an ancestor
#      of origin/main, the working tree is clean, and package versions are not
#      behind the highest v* tag already contained in HEAD.
#   2. `bun run build` -> apps/cli/dist/better-ccflare.
#   3. Copy the binary to
#      /home/will/.config/better-ccflare/better-ccflare-v<version>-<short-sha>
#      and install the source-controlled guard + policy as an immutable pair
#      under guards/<full-sha>/.
#   4. Back up, then atomically upsert the binary and guard identity lines in
#      the systemd pin
#      (/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf),
#      preserving every other Environment= line in that drop-in.
#   5. `systemctl daemon-reload && systemctl restart ccflare-stack.service`.
#   6. Poll both proxy and guard health endpoints until they respond.
#   7. Require exact binary SHA, guard source ID, and guard policy ID matches.
#      Any failure after the pin backup restores the old pin and restarts it.
#   8. Prune old binaries, guard pairs, and pin backups conservatively. Never
#      removes the artifacts that are newly deployed or currently pinned.
#
# REQUIRES: git, node, bun, curl, systemctl, systemd-analyze, and sudo
# (for the systemd pin + restart).
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=deploy-ccflare-lib.sh
source "$REPO_ROOT/scripts/deploy-ccflare-lib.sh"

DEST="/home/will/.config/better-ccflare"
PIN="/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf"
HEALTH_URL="http://127.0.0.1:8788/health"
GUARD_HEALTH_URL="http://127.0.0.1:8788/_guard/health"
HEALTH_WAIT_SECS=60
KEEP_BINARIES=5
KEEP_GUARDS=5
KEEP_RUNNERS=5
KEEP_BACKUPS=3
GUARD_POLICY_ID="pool-exhaustion-finite-recovery-v1"
ROLLBACK_HARD_FAILURE=70

PIN_BACKUP=""
PIN_RENDERED=""
PIN_STAGED=""
PIN_ROLLBACK_ARMED=0
SERVICE_RESTART_ATTEMPTED=0
GUARD_STAGE_DIR=""
RUNNER_STAGE_DIR=""
PRIOR_PROXY_HEALTH_JSON=""
PRIOR_GUARD_HEALTH_JSON=""
PROXY_HEALTH_JSON=""
GUARD_HEALTH_JSON=""

poll_stack_health() {
	PROXY_HEALTH_JSON=""
	GUARD_HEALTH_JSON=""
	for _ in $(seq 1 "$HEALTH_WAIT_SECS"); do
		PROXY_HEALTH_JSON="$(curl -sf "$HEALTH_URL" 2>/dev/null || true)"
		GUARD_HEALTH_JSON="$(curl -sf "$GUARD_HEALTH_URL" 2>/dev/null || true)"
		if [[ -n "$PROXY_HEALTH_JSON" && -n "$GUARD_HEALTH_JSON" ]]; then
			return 0
		fi
		sleep 1
	done
	return 1
}

verify_service_process_identity() {
	if [[ "$#" -ne 2 ]]; then
		return 2
	fi
	local guard_json="$1" expected_runner="$2" main_pid health_runner_pid
	main_pid="$(systemctl show ccflare-stack.service --property MainPID --value)" || return 1
	health_runner_pid="$(
		node -e '
			try {
				const value = JSON.parse(process.argv[1])?.runtime?.process?.runnerPid;
				if (!Number.isSafeInteger(value)) process.exit(1);
				process.stdout.write(String(value));
			} catch { process.exit(1); }
		' "$guard_json"
	)" || return 1
	[[ "$main_pid" == "$health_runner_pid" ]] || return 1
	verify_process_start_identity "$main_pid" "$expected_runner" || return 1
	printf '%s\n' "$main_pid"
}

rollback_on_failure() {
	local status="$1"
	trap - EXIT
	set +e

	[[ -n "$PIN_RENDERED" && -f "$PIN_RENDERED" ]] && rm -f "$PIN_RENDERED"
	if [[ -n "$GUARD_STAGE_DIR" && -d "$GUARD_STAGE_DIR" ]]; then
		rm -f \
			"$GUARD_STAGE_DIR/ccflare-guard.mjs" \
			"$GUARD_STAGE_DIR/ccflare-guard-policy.mjs"
		rmdir "$GUARD_STAGE_DIR" 2>/dev/null
	fi
	if [[ -n "$RUNNER_STAGE_DIR" && -d "$RUNNER_STAGE_DIR" ]]; then
		rm -f "$RUNNER_STAGE_DIR/run-ccflare-stack.sh"
		rmdir "$RUNNER_STAGE_DIR" 2>/dev/null
	fi

	if [[ "$status" -ne 0 && "$PIN_ROLLBACK_ARMED" == "1" ]]; then
		echo "ERROR: deployment failed; restoring systemd pin from $PIN_BACKUP" >&2
		local rollback_stage="${PIN}.rollback-$$"
		local restored_runner_path="" restored_main_pid=""
		if ! sudo cp --preserve=all "$PIN_BACKUP" "$rollback_stage" \
			|| ! sudo mv -f "$rollback_stage" "$PIN" \
			|| ! sudo systemctl daemon-reload; then
			echo "HARD FAILURE: systemd pin restoration failed" >&2
			sudo rm -f "$rollback_stage" 2>/dev/null
			exit "$ROLLBACK_HARD_FAILURE"
		fi
		if [[ "$SERVICE_RESTART_ATTEMPTED" == "0" ]]; then
			echo "==> Restored prior pin before any service restart; live process was left untouched." >&2
		elif ! sudo systemctl restart ccflare-stack.service \
			|| ! poll_stack_health \
			|| ! restored_runner_path="$(
				node -e '
					try {
						const value = JSON.parse(process.argv[1])?.runtime?.artifacts?.runner?.path;
						if (typeof value !== "string" || value.length === 0) process.exit(1);
						process.stdout.write(value);
					} catch { process.exit(1); }
				' "$GUARD_HEALTH_JSON"
			)" \
			|| ! restored_main_pid="$(verify_service_process_identity "$GUARD_HEALTH_JSON" "$restored_runner_path")" \
			|| ! validate_rollback_health \
				"$PRIOR_PROXY_HEALTH_JSON" \
				"$PRIOR_GUARD_HEALTH_JSON" \
				"$PROXY_HEALTH_JSON" \
				"$GUARD_HEALTH_JSON"; then
			echo "HARD FAILURE: restored binary/runner/guard/policy identity could not be proven" >&2
			sudo rm -f "$rollback_stage" 2>/dev/null
			exit "$ROLLBACK_HARD_FAILURE"
		else
			echo "==> Rollback identity verified against captured prior runtime." >&2
		fi
	fi

	[[ -n "$PIN_STAGED" ]] && sudo rm -f "$PIN_STAGED" 2>/dev/null
	exit "$status"
}

trap 'rollback_on_failure $?' EXIT

CHECK_ONLY=0
for arg in "$@"; do
	case "$arg" in
		--check) CHECK_ONLY=1 ;;
		-h|--help) sed -n '2,42p' "$0"; exit 0 ;;
		*) echo "Unknown arg: $arg" >&2; exit 2 ;;
	esac
done

# ---------------------------------------------------------------------------
# 1) Ancestry gate — the actual guardrail. Everything else is convenience.
# ---------------------------------------------------------------------------
echo "==> Fetching origin…"
git fetch origin --quiet

HEAD_SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"

ANCESTRY_OK=0
if git merge-base --is-ancestor "$HEAD_SHA" origin/main; then
	ANCESTRY_OK=1
	echo "OK: $SHORT is an ancestor of origin/main."
else
	echo "refusing to deploy: $SHORT is not an ancestor of origin/main (deploy only code that is on main)" >&2
fi

# Clean-tree gate: the ancestry check verifies the committed HEAD, but the
# build compiles the working tree. Uncommitted changes would ship code that is
# NOT on the verified commit, silently bypassing the main-ancestry guarantee.
# (git status --porcelain ignores gitignored build artifacts, so generated
# inline workers / dist do not trip this.)
TREE_OK=0
if [[ -z "$(git status --porcelain)" ]]; then
	TREE_OK=1
else
	echo "refusing to deploy: working tree has uncommitted changes — commit or stash them so the built binary matches the verified commit" >&2
fi

# Version consistency gate: refuse to ship a binary whose package version is
# lower than the highest v* tag already contained in HEAD. Upstream merges can
# silently keep a fork's older package.json while absorbing a newer tagged
# release, and the binary name/health endpoint would then lie about the
# release lineage even though the code is present.
VERSION="$(node -p "require('./apps/cli/package.json').version")"
ROOT_VERSION="$(node -p "require('./package.json').version")"
VERSION_OK=0
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "refusing to deploy: apps/cli/package.json version '$VERSION' is not a plain semver x.y.z" >&2
elif [[ "$ROOT_VERSION" != "$VERSION" ]]; then
	echo "refusing to deploy: root package.json version '$ROOT_VERSION' does not match apps/cli version '$VERSION'" >&2
else
	LATEST_CONTAINED_VERSION="$(
		git tag --list 'v[0-9]*' --merged HEAD 2>/dev/null \
			| sed -n 's/^v//p' \
			| grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
			| sort -V \
			| tail -n 1
	)"
	if [[ -z "$LATEST_CONTAINED_VERSION" ]]; then
		VERSION_OK=1
		echo "OK: package version $VERSION (no merged v* tags to compare)."
	elif [[ "$VERSION" == "$LATEST_CONTAINED_VERSION" ]]; then
		VERSION_OK=1
		echo "OK: package version $VERSION matches highest contained tag v$LATEST_CONTAINED_VERSION."
	else
		HIGHER="$(printf '%s\n' "$VERSION" "$LATEST_CONTAINED_VERSION" | sort -V | tail -n 1)"
		if [[ "$HIGHER" == "$VERSION" ]]; then
			VERSION_OK=1
			echo "OK: package version $VERSION is ahead of highest contained tag v$LATEST_CONTAINED_VERSION."
		else
			echo "refusing to deploy: package version $VERSION is behind highest v* tag already in HEAD (v$LATEST_CONTAINED_VERSION). Sync package.json and apps/cli/package.json before shipping." >&2
		fi
	fi
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
	{ [[ "$ANCESTRY_OK" == "1" && "$TREE_OK" == "1" && "$VERSION_OK" == "1" ]]; } && exit 0 || exit 1
fi

if [[ "$ANCESTRY_OK" != "1" || "$TREE_OK" != "1" || "$VERSION_OK" != "1" ]]; then
	exit 1
fi

# The check path exits above without opening a lock or invoking sudo. A full
# deploy takes one non-blocking host lock before build or deployment mutation.
DEPLOY_LOCK="${XDG_RUNTIME_DIR:-/tmp}/better-ccflare-deploy-${UID}.lock"
exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
	echo "refusing to deploy: another better-ccflare deployment holds $DEPLOY_LOCK" >&2
	exit 75
fi

# ---------------------------------------------------------------------------
# 2) Build
# ---------------------------------------------------------------------------
BIN_NAME="better-ccflare-v${VERSION}-${SHORT}"
GUARDS_ROOT="${DEST}/guards"
GUARD_DIR="${GUARDS_ROOT}/${HEAD_SHA}"
GUARD_SCRIPT="${GUARD_DIR}/ccflare-guard.mjs"
GUARD_POLICY="${GUARD_DIR}/ccflare-guard-policy.mjs"
RUNNERS_ROOT="${DEST}/runners"
RUNNER_DIR="${RUNNERS_ROOT}/${HEAD_SHA}"
RUNNER_SCRIPT="${RUNNER_DIR}/run-ccflare-stack.sh"
GUARD_SOURCE_ID="$HEAD_SHA"
SOURCE_GUARD="$REPO_ROOT/scripts/ccflare-guard.mjs"
SOURCE_GUARD_POLICY="$REPO_ROOT/scripts/ccflare-guard-policy.mjs"
SOURCE_RUNNER="$REPO_ROOT/scripts/run-ccflare-stack.sh"

echo "==> Building better-ccflare v${VERSION} (${SHORT})…"
bun run build

BUILT_BIN="apps/cli/dist/better-ccflare"
if [[ ! -f "$BUILT_BIN" ]]; then
	echo "ERROR: build did not produce $BUILT_BIN" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# 3) Install the binary
# ---------------------------------------------------------------------------
mkdir -p "$DEST"
DEST_BIN="${DEST}/${BIN_NAME}"
cp "$BUILT_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"
BUILT_BIN_SHA256="$(sha256_file "$BUILT_BIN")"
DEST_BIN_SHA256="$(sha256_file "$DEST_BIN")"
if [[ "$BUILT_BIN_SHA256" != "$DEST_BIN_SHA256" ]]; then
	echo "ERROR: installed binary digest differs from build output" >&2
	exit 1
fi
echo "==> Installed $DEST_BIN"

# Install the guard and its policy together under a commit-addressed
# directory. An existing directory at this SHA is immutable: reuse it only if
# both files exactly match the checkout, otherwise refuse the deployment.
if [[ ! -f "$SOURCE_GUARD" || ! -f "$SOURCE_GUARD_POLICY" || ! -f "$SOURCE_RUNNER" ]]; then
	echo "ERROR: source-controlled runner/guard artifacts are missing" >&2
	exit 1
fi

mkdir -p "$GUARDS_ROOT"
if [[ -d "$GUARD_DIR" ]]; then
	if ! cmp -s "$SOURCE_GUARD" "$GUARD_SCRIPT" \
		|| ! cmp -s "$SOURCE_GUARD_POLICY" "$GUARD_POLICY"; then
		echo "ERROR: immutable guard directory $GUARD_DIR does not match deployed source" >&2
		exit 1
	fi
	echo "==> Reusing verified guard pair $GUARD_DIR"
else
	GUARD_STAGE_DIR="${GUARD_DIR}.tmp-$$"
	mkdir "$GUARD_STAGE_DIR"
	cp "$SOURCE_GUARD" "$GUARD_STAGE_DIR/ccflare-guard.mjs"
	cp "$SOURCE_GUARD_POLICY" "$GUARD_STAGE_DIR/ccflare-guard-policy.mjs"
	chmod 0555 "$GUARD_STAGE_DIR/ccflare-guard.mjs"
	chmod 0444 "$GUARD_STAGE_DIR/ccflare-guard-policy.mjs"
	mv "$GUARD_STAGE_DIR" "$GUARD_DIR"
	GUARD_STAGE_DIR=""
	echo "==> Installed immutable guard pair $GUARD_DIR"
fi

mkdir -p "$RUNNERS_ROOT"
if [[ -d "$RUNNER_DIR" ]]; then
	if ! cmp -s "$SOURCE_RUNNER" "$RUNNER_SCRIPT"; then
		echo "ERROR: immutable runner directory $RUNNER_DIR does not match deployed source" >&2
		exit 1
	fi
	echo "==> Reusing verified runner $RUNNER_DIR"
else
	RUNNER_STAGE_DIR="${RUNNER_DIR}.tmp-$$"
	mkdir "$RUNNER_STAGE_DIR"
	cp "$SOURCE_RUNNER" "$RUNNER_STAGE_DIR/run-ccflare-stack.sh"
	chmod 0555 "$RUNNER_STAGE_DIR/run-ccflare-stack.sh"
	mv "$RUNNER_STAGE_DIR" "$RUNNER_DIR"
	RUNNER_STAGE_DIR=""
	echo "==> Installed immutable runner $RUNNER_DIR"
fi

RUNNER_SHA256="$(sha256_file "$RUNNER_SCRIPT")"
GUARD_SHA256="$(sha256_file "$GUARD_SCRIPT")"
POLICY_SHA256="$(sha256_file "$GUARD_POLICY")"
for digest_pair in \
	"$(sha256_file "$SOURCE_RUNNER"):$RUNNER_SHA256:runner" \
	"$(sha256_file "$SOURCE_GUARD"):$GUARD_SHA256:guard" \
	"$(sha256_file "$SOURCE_GUARD_POLICY"):$POLICY_SHA256:policy"; do
	IFS=: read -r source_digest installed_digest artifact_name <<<"$digest_pair"
	if [[ "$source_digest" != "$installed_digest" ]]; then
		echo "ERROR: installed $artifact_name digest differs from source" >&2
		exit 1
	fi
done

# ---------------------------------------------------------------------------
# 4) Update the systemd pin atomically, preserving every other line
# ---------------------------------------------------------------------------
echo "==> Updating systemd pin ($PIN)…"
# Capture the pre-deploy runtime before arming rollback. A legacy first
# migration may not expose complete runtime identity; deployment can proceed,
# but any later rollback will hard-fail rather than claim an unproven restore.
PRIOR_PROXY_HEALTH_JSON="$(curl -sf "$HEALTH_URL" 2>/dev/null || true)"
PRIOR_GUARD_HEALTH_JSON="$(curl -sf "$GUARD_HEALTH_URL" 2>/dev/null || true)"
PIN_BACKUP="${PIN}.bak-$(date -u +%Y%m%dT%H%M%SZ)-${SHORT}"
sudo cp --preserve=all "$PIN" "$PIN_BACKUP"

PIN_RENDERED="$(mktemp)"
render_systemd_pin \
	"$PIN" \
	"$PIN_RENDERED" \
	"$DEST_BIN" \
	"$RUNNER_SCRIPT" \
	"$GUARD_SCRIPT" \
	"$GUARD_SOURCE_ID" \
	"$GUARD_POLICY_ID" \
	"$GUARD_POLICY"

if ! CONFIGURED_DEPLOYMENT_TIMING="$(
	validate_deployment_timing "$PIN_RENDERED"
)"; then
	echo "ERROR: rendered systemd pin has an unsafe guard deadline or stop policy" >&2
	exit 1
fi
read -r \
	CONFIGURED_GUARD_TOTAL_DEADLINE_MS \
	CONFIGURED_GUARD_SHUTDOWN_GRACE_MS \
	CONFIGURED_STOP_TIMEOUT_MS <<<"$CONFIGURED_DEPLOYMENT_TIMING"

PIN_STAGED="${PIN}.new-${SHORT}-$$"
sudo cp --preserve=all "$PIN" "$PIN_STAGED"
sudo tee "$PIN_STAGED" <"$PIN_RENDERED" >/dev/null
PIN_ROLLBACK_ARMED=1
sudo mv -f "$PIN_STAGED" "$PIN"
PIN_STAGED=""
rm -f "$PIN_RENDERED"
PIN_RENDERED=""

for expected_line in \
	"Environment=CCFLARE_BIN=${DEST_BIN}" \
	"Environment=GUARD_SCRIPT=${GUARD_SCRIPT}" \
	"Environment=GUARD_SOURCE_ID=${GUARD_SOURCE_ID}" \
	"Environment=GUARD_POLICY_ID=${GUARD_POLICY_ID}" \
	"Environment=GUARD_SHA256=${GUARD_SHA256}" \
	"Environment=GUARD_POLICY_SHA256=${POLICY_SHA256}" \
	"Environment=RUNNER_SHA256=${RUNNER_SHA256}" \
	"ExecStart=" \
	"ExecStart=${RUNNER_SCRIPT}"; do
	if [[ "$(grep -Fxc "$expected_line" "$PIN")" -lt 1 ]]; then
		echo "ERROR: failed to atomically upsert '$expected_line' in $PIN" >&2
		exit 1
	fi
done
echo "==> Pin backed up to $PIN_BACKUP"

# ---------------------------------------------------------------------------
# 5) Reload and validate the effective unit before restarting. A later drop-in
#    can override the rendered 50-pin, so the merged systemd policy is the
#    authority. Validation failure restores the old pin and reloads it without
#    touching the still-running service.
# ---------------------------------------------------------------------------
PRE_RESTART_POLICY_STATUS=0
EFFECTIVE_DEPLOYMENT_TIMING="$(
	reload_validate_or_restore_systemd_policy \
		"$PIN" \
		"$PIN_BACKUP" \
		ccflare-stack.service
)" \
	|| PRE_RESTART_POLICY_STATUS="$?"
if [[ "$PRE_RESTART_POLICY_STATUS" -ne 0 ]]; then
	if [[ "$PRE_RESTART_POLICY_STATUS" == "1" ]]; then
		PIN_ROLLBACK_ARMED=0
	fi
	exit "$PRE_RESTART_POLICY_STATUS"
fi
read -r \
	CONFIGURED_GUARD_TOTAL_DEADLINE_MS \
	CONFIGURED_GUARD_SHUTDOWN_GRACE_MS \
	CONFIGURED_STOP_TIMEOUT_MS <<<"$EFFECTIVE_DEPLOYMENT_TIMING"

echo "==> Restarting ccflare-stack.service…"
SERVICE_RESTART_ATTEMPTED=1
sudo systemctl restart ccflare-stack.service

# ---------------------------------------------------------------------------
# 6) Wait for proxy and guard health
# ---------------------------------------------------------------------------
echo "==> Waiting for health at $HEALTH_URL and $GUARD_HEALTH_URL…"
if poll_stack_health; then
	echo "==> Proxy and guard health endpoints are responding."
else
	echo "ERROR: proxy and guard did not both respond within ${HEALTH_WAIT_SECS}s" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# 7) Verify exact binary and guard deployment identities
# ---------------------------------------------------------------------------
if ! MAIN_PID="$(verify_service_process_identity "$GUARD_HEALTH_JSON" "$RUNNER_SCRIPT")"; then
	echo "ERROR: systemd MainPID=$MAIN_PID was not started from $RUNNER_SCRIPT" >&2
	exit 1
fi

EXPECTED_IDENTITY_JSON="$(
	node - \
		"$SHORT" \
		"$GUARD_SOURCE_ID" \
		"$GUARD_POLICY_ID" \
		"$MAIN_PID" \
		"$CONFIGURED_GUARD_TOTAL_DEADLINE_MS" \
		"$CONFIGURED_GUARD_SHUTDOWN_GRACE_MS" \
		"$(readlink -f "$DEST_BIN")" "$DEST_BIN_SHA256" \
		"$(readlink -f "$RUNNER_SCRIPT")" "$RUNNER_SHA256" \
		"$(readlink -f "$GUARD_SCRIPT")" "$GUARD_SHA256" \
		"$(readlink -f "$GUARD_POLICY")" "$POLICY_SHA256" <<'NODE'
const [
	proxyGitSha,
	sourceId,
	policyId,
	runnerPid,
	guardTotalDeadlineMs,
	guardShutdownGraceMs,
	binaryPath,
	binarySha256,
	runnerPath,
	runnerSha256,
	guardPath,
	guardSha256,
	policyPath,
	policySha256,
] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
	proxyGitSha,
	sourceId,
	policyId,
	runnerPid: Number(runnerPid),
	artifacts: {
		binary: { path: binaryPath, sha256: binarySha256 },
		runner: { path: runnerPath, sha256: runnerSha256 },
		guard: { path: guardPath, sha256: guardSha256 },
		policy: { path: policyPath, sha256: policySha256 },
	},
	limits: {
		totalDeadlineMs: Number(guardTotalDeadlineMs),
		shutdownGraceMs: Number(guardShutdownGraceMs),
		maxAttempts: 3,
		jitterMs: 2000,
		maxInspectionBytes: 65536,
	},
}));
NODE
)"
if ! validate_deploy_health \
	"$PROXY_HEALTH_JSON" \
	"$GUARD_HEALTH_JSON" \
	"$EXPECTED_IDENTITY_JSON"; then
	echo "ERROR: deployment health identity verification failed" >&2
	exit 1
fi
echo "==> Verified binary, runner, guard, policy, process start, and effective guard limits."

# ---------------------------------------------------------------------------
# 8) Prune old artifacts. Conservative: never touch the binary we just
#    pinned, and only remove things strictly beyond the keep window.
# ---------------------------------------------------------------------------
echo "==> Pruning old binaries, guard pairs, and pin backups…"

PIN_DIR="$(dirname "$PIN")"
mapfile -t PIN_REFERENCE_FILES < <(
	find "$PIN_DIR" -maxdepth 1 -type f \
		\( -name '50-pinned-build.conf' -o -name '50-pinned-build.conf.bak-*' \) \
		-print 2>/dev/null
)
PROTECTED_BINARIES=("$DEST_BIN")
PROTECTED_GUARD_DIRS=("$GUARD_DIR")
PROTECTED_RUNNER_DIRS=("$RUNNER_DIR")
for reference_pin in "${PIN_REFERENCE_FILES[@]:-}"; do
	while IFS= read -r referenced_binary; do
		[[ -n "$referenced_binary" ]] && PROTECTED_BINARIES+=("$referenced_binary")
	done < <(sed -n 's/^Environment=CCFLARE_BIN=//p' "$reference_pin")
	while IFS= read -r referenced_guard; do
		[[ -n "$referenced_guard" ]] && PROTECTED_GUARD_DIRS+=("$(dirname "$referenced_guard")")
	done < <(sed -n 's/^Environment=GUARD_SCRIPT=//p' "$reference_pin")
	while IFS= read -r referenced_runner; do
		[[ -n "$referenced_runner" ]] && PROTECTED_RUNNER_DIRS+=("$(dirname "$referenced_runner")")
	done < <(sed -n 's/^ExecStart=\([^[:space:]].*run-ccflare-stack\.sh\)$/\1/p' "$reference_pin")
done

mapfile -t OLD_BINS < <(
	find "$DEST" -maxdepth 1 -type f -name 'better-ccflare-v*' -printf '%T@ %p\n' 2>/dev/null \
		| sort -rn \
		| awk '{print $2}' \
		| tail -n "+$((KEEP_BINARIES + 1))"
)
for f in "${OLD_BINS[@]:-}"; do
	[[ -n "$f" && -f "$f" ]] || continue
	for protected_binary in "${PROTECTED_BINARIES[@]}"; do
		[[ "$f" == "$protected_binary" ]] && continue 2
	done
	rm -f "$f"
	echo "    removed $f"
done

mapfile -t OLD_GUARD_DIRS < <(
	artifact_prune_candidates "$GUARDS_ROOT" "$KEEP_GUARDS" "${PROTECTED_GUARD_DIRS[@]}"
)
for guard_dir in "${OLD_GUARD_DIRS[@]:-}"; do
	[[ -n "$guard_dir" ]] || continue
	if [[ "$guard_dir" != "$GUARDS_ROOT/"* \
		|| ! -f "$guard_dir/ccflare-guard.mjs" \
		|| ! -f "$guard_dir/ccflare-guard-policy.mjs" \
		|| "$(find "$guard_dir" -mindepth 1 -maxdepth 1 | wc -l)" -ne 2 ]]; then
		echo "    skipped non-standard guard directory $guard_dir" >&2
		continue
	fi
	rm -f \
		"$guard_dir/ccflare-guard.mjs" \
		"$guard_dir/ccflare-guard-policy.mjs"
	rmdir "$guard_dir"
	echo "    removed $guard_dir"
done

mapfile -t OLD_RUNNER_DIRS < <(
	artifact_prune_candidates "$RUNNERS_ROOT" "$KEEP_RUNNERS" "${PROTECTED_RUNNER_DIRS[@]}"
)
for runner_dir in "${OLD_RUNNER_DIRS[@]:-}"; do
	[[ -n "$runner_dir" ]] || continue
	if [[ "$runner_dir" != "$RUNNERS_ROOT/"* \
		|| ! -f "$runner_dir/run-ccflare-stack.sh" \
		|| "$(find "$runner_dir" -mindepth 1 -maxdepth 1 | wc -l)" -ne 1 ]]; then
		echo "    skipped non-standard runner directory $runner_dir" >&2
		continue
	fi
	rm -f "$runner_dir/run-ccflare-stack.sh"
	rmdir "$runner_dir"
	echo "    removed $runner_dir"
done

mapfile -t OLD_PIN_BAKS < <(
	find "$PIN_DIR" -maxdepth 1 -type f -name '50-pinned-build.conf.bak-*' -printf '%T@ %p\n' 2>/dev/null \
		| sort -rn \
		| awk '{print $2}' \
		| tail -n "+$((KEEP_BACKUPS + 1))"
)
for f in "${OLD_PIN_BAKS[@]:-}"; do
	[[ -n "$f" ]] && sudo rm -f "$f" && echo "    removed $f"
done

mapfile -t OLD_RECOVERY_BAKS < <(
	find "$PIN_DIR" -maxdepth 1 -type f -name '50-pinned-build.conf.bak-recovery-*' -printf '%T@ %p\n' 2>/dev/null \
		| sort -rn \
		| awk '{print $2}' \
		| tail -n "+$((KEEP_BACKUPS + 1))"
)
for f in "${OLD_RECOVERY_BAKS[@]:-}"; do
	[[ -n "$f" ]] && sudo rm -f "$f" && echo "    removed $f"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "=== Deploy summary ==="
echo "deployed sha:  $SHORT"
echo "version:       $VERSION"
echo "binary:        $DEST_BIN"
echo "runner:        $RUNNER_SCRIPT"
echo "guard:         $GUARD_SCRIPT"
echo "pin:           $PIN"
echo "  CCFLARE_BIN= $DEST_BIN"
echo "  ExecStart=   $RUNNER_SCRIPT"
echo "  GUARD_SCRIPT=$GUARD_SCRIPT"
echo "source id:     $GUARD_SOURCE_ID"
echo "policy id:     $GUARD_POLICY_ID"
echo "sha256:        binary=$DEST_BIN_SHA256 runner=$RUNNER_SHA256 guard=$GUARD_SHA256 policy=$POLICY_SHA256"
echo "health:        VERIFIED"
