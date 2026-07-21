#!/usr/bin/env bash

# Helpers for deploy-ccflare.sh. File rendering and validation stay deterministic;
# the one pre-restart activation helper isolates its sudo/systemd mutation so the
# exact reload, effective-policy check, and no-restart rollback can be mocked.

validate_main_deploy_source() {
	if [[ "$#" -ne 3 ]]; then
		echo "validate_main_deploy_source requires: checkout-ref HEAD-SHA origin-main-SHA" >&2
		return 2
	fi

	local checkout_ref="$1" head_sha="$2" origin_main_sha="$3"
	if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ || ! "$origin_main_sha" =~ ^[0-9a-f]{40}$ ]]; then
		echo "validate_main_deploy_source requires full lowercase Git SHAs" >&2
		return 2
	fi

	if [[ -z "$checkout_ref" ]]; then
		echo "refusing to deploy: checkout has detached HEAD; checkout must be refs/heads/main" >&2
		return 1
	fi
	if [[ "$checkout_ref" != "refs/heads/main" ]]; then
		echo "refusing to deploy: checkout is $checkout_ref; checkout must be refs/heads/main" >&2
		return 1
	fi
	if [[ "$head_sha" != "$origin_main_sha" ]]; then
		echo "refusing to deploy: refs/heads/main at ${head_sha:0:12} does not exactly match refs/remotes/origin/main at ${origin_main_sha:0:12}" >&2
		return 1
	fi

	echo "OK: ${head_sha:0:12} is refs/heads/main at refs/remotes/origin/main."
}

create_verified_source_snapshot() {
	if [[ "$#" -ne 3 ]]; then
		echo "create_verified_source_snapshot requires: repository snapshot-path HEAD-SHA" >&2
		return 2
	fi

	local repository="$1" snapshot_path="$2" head_sha="$3"
	local snapshot_head snapshot_ref
	if [[ ! -d "$repository" || ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
		echo "create_verified_source_snapshot requires a Git repository and full lowercase HEAD SHA" >&2
		return 2
	fi
	if [[ -e "$snapshot_path" ]]; then
		echo "refusing to create verified source snapshot over existing path $snapshot_path" >&2
		return 2
	fi

	git -C "$repository" worktree add --detach --quiet "$snapshot_path" "$head_sha" \
		|| return 1
	snapshot_head="$(git -C "$snapshot_path" rev-parse HEAD 2>/dev/null || true)"
	snapshot_ref="$(git -C "$snapshot_path" symbolic-ref -q HEAD 2>/dev/null || true)"
	if [[ "$snapshot_head" != "$head_sha" || -n "$snapshot_ref" ]]; then
		echo "verified source snapshot did not resolve to detached $head_sha" >&2
		git -C "$repository" worktree remove --force "$snapshot_path" 2>/dev/null || true
		return 1
	fi
}

remove_verified_source_snapshot() {
	if [[ "$#" -ne 2 ]]; then
		echo "remove_verified_source_snapshot requires: repository snapshot-path" >&2
		return 2
	fi

	local repository="$1" snapshot_path="$2" registered_path
	if [[ ! -d "$repository" || -z "$snapshot_path" ]]; then
		echo "remove_verified_source_snapshot requires a Git repository and snapshot path" >&2
		return 2
	fi
	registered_path="$(
		git -C "$repository" worktree list --porcelain 2>/dev/null \
			| awk -v target="$snapshot_path" '$0 == "worktree " target { print target; exit }'
	)"
	if [[ -z "$registered_path" ]]; then
		if [[ -e "$snapshot_path" ]]; then
			echo "refusing to remove unregistered source snapshot path $snapshot_path" >&2
			return 1
		fi
		return 0
	fi

	git -C "$repository" worktree remove --force "$registered_path"
}

validate_deploy_owned_systemd_pin() {
	if [[ "$#" -ne 1 || ! -f "$1" ]]; then
		echo "validate_deploy_owned_systemd_pin requires an existing systemd drop-in" >&2
		return 2
	fi

	local input="$1"
	local managed_begin="# BEGIN better-ccflare managed deployment"
	local managed_end="# END better-ccflare managed deployment"
	awk \
		-v input="$input" \
		-v begin="$managed_begin" \
		-v end="$managed_end" '
		function guidance() {
			print "Migrate operator policy to a later drop-in such as /etc/systemd/system/ccflare-stack.service.d/90-operator-policy.conf, then leave 50-pinned-build.conf deploy-owned." > "/dev/stderr"
		}
		function fail(message) {
			print message > "/dev/stderr"
			guidance()
			failed = 1
			exit 1
		}
		$0 == begin {
			if (managed || blocks > 0) {
				fail("refusing to deploy: " input " has invalid managed marker structure at line " NR ".")
			}
			managed = 1
			blocks += 1
			next
		}
		$0 == end {
			if (!managed) {
				fail("refusing to deploy: " input " has invalid managed marker structure at line " NR ".")
			}
			managed = 0
			next
		}
		!managed && $0 !~ /^[[:space:]]*([#;].*)?$/ {
			fail("refusing to deploy: " input " contains unmanaged systemd configuration outside \047" begin "\047 and \047" end "\047 (line " NR ": " $0 ").")
		}
		END {
			if (!failed && managed) {
				fail("refusing to deploy: " input " has invalid managed marker structure: missing \047" end "\047.")
			}
		}
	' "$input"
}

render_systemd_pin() {
	if [[ "$#" -ne 8 ]]; then
		echo "render_systemd_pin requires: input output binary runner guard source-id policy-id guard-policy-script" >&2
		return 2
	fi

	local input="$1" output="$2" binary="$3" runner="$4"
	local guard_script="$5" source_id="$6" policy_id="$7" guard_policy_script="$8"
	local deadline_ms=600000 retry_attempt_headroom_ms=30000 max_recovery_sleep_ms=120000 shutdown_grace_ms=600000 max_recovery_waits=12
	local kill_mode=mixed stop_timeout=720s
	local managed_begin="# BEGIN better-ccflare managed deployment"
	local managed_end="# END better-ccflare managed deployment"

	# This drop-in is a deploy-owned identity document. Operator policy belongs
	# in a later drop-in, where systemd can merge it explicitly without leaving
	# stale artifact identity or ExecStart lines beside this managed block.
	validate_deploy_owned_systemd_pin "$input" || return "$?"

	# Digests are computed at render time from the staged files (guard,
	# policy, runner) so the pin itself records the identity of what it
	# points at, alongside the existing GUARD_SOURCE_ID. This requires those
	# three paths to already be real, existing files when this function runs
	# — true in the real deploy flow, where they are staged before the pin is
	# rendered.
	local guard_sha256 guard_policy_sha256 runner_sha256
	guard_sha256="$(sha256_file "$guard_script")" || return 2
	guard_policy_sha256="$(sha256_file "$guard_policy_script")" || return 2
	runner_sha256="$(sha256_file "$runner")" || return 2

	{
		printf '%s\n' "$managed_begin"
		printf '%s\n' "[Service]"
		printf 'Environment=%s\n' "CCFLARE_BIN=$binary"
		printf 'Environment=%s\n' "GUARD_SCRIPT=$guard_script"
		printf 'Environment=%s\n' "GUARD_SOURCE_ID=$source_id"
		printf 'Environment=%s\n' "GUARD_POLICY_ID=$policy_id"
		printf 'Environment=%s\n' "GUARD_SHA256=$guard_sha256"
		printf 'Environment=%s\n' "GUARD_POLICY_SHA256=$guard_policy_sha256"
		printf 'Environment=%s\n' "RUNNER_SHA256=$runner_sha256"
		printf 'Environment=%s\n' "GUARD_TOTAL_DEADLINE_MS=$deadline_ms"
		printf 'Environment=%s\n' "GUARD_RETRY_ATTEMPT_HEADROOM_MS=$retry_attempt_headroom_ms"
		printf 'Environment=%s\n' "GUARD_MAX_RECOVERY_SLEEP_MS=$max_recovery_sleep_ms"
		printf 'Environment=%s\n' "GUARD_MAX_RECOVERY_WAITS=$max_recovery_waits"
		printf 'Environment=%s\n' "GUARD_SHUTDOWN_GRACE_MS=$shutdown_grace_ms"
		printf 'KillMode=%s\n' "$kill_mode"
		printf 'TimeoutStopSec=%s\n' "$stop_timeout"
		printf '%s\n' "ExecStart="
		printf 'ExecStart=%s\n' "$runner"
		printf '%s\n' "$managed_end"
	} >"$output"
}

replace_systemd_pin_if_snapshot_current() {
	if [[ "$#" -ne 4 || ! -f "$1" || ! -f "$2" || ! -f "$3" ]]; then
		echo "replace_systemd_pin_if_snapshot_current requires: pin backup rendered staged" >&2
		return 2
	fi

	local pin="$1" backup="$2" rendered="$3" staged="$4"
	if ! sudo cp --preserve=all "$backup" "$staged" \
		|| ! sudo tee "$staged" <"$rendered" >/dev/null; then
		echo "ERROR: failed to stage the rendered systemd pin" >&2
		sudo rm -f "$staged" 2>/dev/null || true
		return 1
	fi

	# The deploy lock serializes deployers, not operators. Treat the backup as
	# a compare-and-swap snapshot: if the live file changed while artifacts
	# were being rendered/staged, preserve that edit instead of overwriting it.
	# Keep this comparison directly adjacent to the atomic rename so there is
	# no intervening deployment work in the check/use window.
	if ! sudo cmp -s "$pin" "$backup"; then
		echo "ERROR: $pin changed after the deployment snapshot was captured; preserving the concurrent operator edit" >&2
		sudo rm -f "$staged" 2>/dev/null || true
		return 1
	fi
	# Arm rollback before the rename: if the shell is interrupted while mv is
	# in flight, the exit trap must treat the live pin as potentially replaced.
	PIN_ROLLBACK_ARMED=1
	if ! sudo mv -f "$staged" "$pin"; then
		echo "ERROR: failed to atomically install the rendered systemd pin" >&2
		sudo rm -f "$staged" 2>/dev/null || true
		return 1
	fi
}

_configured_systemd_value() {
	if [[ "$#" -ne 3 || ! -f "$1" ]]; then
		return 2
	fi
	node - "$1" "$2" "$3" <<'NODE'
const fs = require("node:fs");
const [file, kind, key] = process.argv.slice(2);
if (!["environment", "directive"].includes(kind)) process.exit(2);
if (kind === "environment" && !/^[A-Z_][A-Z0-9_]*$/.test(key)) process.exit(2);
if (kind === "directive" && !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) process.exit(2);

let text;
try {
	text = fs.readFileSync(file, "utf8");
} catch {
	process.exit(2);
}

const logicalLines = [];
let continued = "";
for (const physical of text.split(/\r?\n/)) {
	const current = continued + physical;
	let slashCount = 0;
	for (let i = current.length - 1; i >= 0 && current[i] === "\\"; i -= 1) {
		slashCount += 1;
	}
	if (slashCount % 2 === 1) {
		continued = current.slice(0, -1) + " ";
		continue;
	}
	logicalLines.push(current);
	continued = "";
}
if (continued.length > 0) logicalLines.push(continued);

const splitWords = (input) => {
	const words = [];
	let word = "";
	let quote = null;
	let started = false;
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (quote !== null) {
			if (char === quote) {
				quote = null;
			} else if (char === "\\" && quote === '"' && i + 1 < input.length) {
				word += input[++i];
			} else {
				word += char;
			}
			started = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) {
				words.push(word);
				word = "";
				started = false;
			}
		} else if (char === "\\" && i + 1 < input.length) {
			word += input[++i];
			started = true;
		} else {
			word += char;
			started = true;
		}
	}
	if (quote !== null) throw new Error("unterminated quote");
	if (started) words.push(word);
	return words;
};

let section = "";
const environment = new Map();
let directiveFound = false;
let directiveValue = "";
try {
	for (const line of logicalLines) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) {
			continue;
		}
		const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			section = sectionMatch[1];
			continue;
		}
		if (section !== "Service") continue;
		const assignment = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=(.*)$/);
		if (!assignment) continue;
		const [, name, raw] = assignment;
		if (kind === "environment" && name === "Environment") {
			if (raw.trim().length === 0) {
				environment.clear();
				continue;
			}
			for (const item of splitWords(raw)) {
				const equals = item.indexOf("=");
				if (equals <= 0) continue;
				const name = item.slice(0, equals);
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
				environment.set(name, item.slice(equals + 1));
			}
		} else if (kind === "directive" && name === key) {
			directiveValue = splitWords(raw).join(" ");
			directiveFound = true;
		}
	}
} catch (error) {
	console.error("invalid systemd drop-in syntax: " + error.message);
	process.exit(2);
}

if (kind === "environment") {
	if (!environment.has(key)) process.exit(1);
	process.stdout.write(environment.get(key) + "\n");
} else {
	if (!directiveFound) process.exit(1);
	process.stdout.write(directiveValue + "\n");
}
NODE
}

configured_systemd_environment_value() {
	if [[ "$#" -ne 2 ]]; then
		echo "configured_systemd_environment_value requires: existing-pin ENV_NAME" >&2
		return 2
	fi
	_configured_systemd_value "$1" environment "$2"
}

configured_systemd_directive_value() {
	if [[ "$#" -ne 2 ]]; then
		echo "configured_systemd_directive_value requires: existing-pin DirectiveName" >&2
		return 2
	fi
	_configured_systemd_value "$1" directive "$2"
}

systemd_duration_to_microseconds() {
	if [[ "$#" -ne 1 || -z "$1" ]]; then
		return 1
	fi
	local parsed usec
	parsed="$(LC_ALL=C systemd-analyze timespan -- "$1" 2>/dev/null)" || return 1
	usec="$(printf '%s\n' "$parsed" | awk 'NR == 2 { print $2 }')"
	if [[ ! "$usec" =~ ^[0-9]{1,16}$ ]]; then
		return 1
	fi
	printf '%s\n' "$usec"
}

systemd_duration_to_milliseconds() {
	local usec
	usec="$(systemd_duration_to_microseconds "$1")" || return 1
	printf '%s\n' "$((usec / 1000))"
}

validate_guard_timing_values() {
	if [[ "$#" -ne 6 ]]; then
		echo "validate_guard_timing_values requires: deadline headroom recovery-silence grace recovery-waits label" >&2
		return 2
	fi
	local deadline_ms="$1" retry_attempt_headroom_ms="$2" max_recovery_sleep_ms="$3"
	local shutdown_grace_ms="$4" max_recovery_waits="$5" label="$6" value
	for value in "$deadline_ms" "$shutdown_grace_ms"; do
		if [[ ! "$value" =~ ^[1-9][0-9]{0,9}$ ]] \
			|| ((value < 600000 || value > 2147483647)); then
			echo "unsafe ${label}guard timing value ${value}; expected 600000..2147483647ms" >&2
			return 1
		fi
	done
	if [[ ! "$retry_attempt_headroom_ms" =~ ^[1-9][0-9]{0,9}$ ]] \
		|| ((retry_attempt_headroom_ms >= deadline_ms)); then
		echo "unsafe ${label}retry-attempt headroom ${retry_attempt_headroom_ms}ms" >&2
		return 1
	fi
	if [[ ! "$max_recovery_sleep_ms" =~ ^[1-9][0-9]{0,9}$ ]] \
		|| ((max_recovery_sleep_ms > 120000)) \
		|| ((max_recovery_sleep_ms > deadline_ms - retry_attempt_headroom_ms)); then
		echo "unsafe ${label}max recovery silence ${max_recovery_sleep_ms}ms; expected 1..120000ms within deadline headroom" >&2
		return 1
	fi
	if [[ ! "$max_recovery_waits" =~ ^[1-9][0-9]{0,6}$ ]] \
		|| ((max_recovery_waits > 1000000)); then
		echo "unsafe ${label}max recovery waits ${max_recovery_waits}; expected 1..1000000" >&2
		return 1
	fi
	if ((shutdown_grace_ms < deadline_ms)); then
		echo "unsafe ${label}shutdown grace ${shutdown_grace_ms}ms; expected at least deadline ${deadline_ms}ms" >&2
		return 1
	fi
}

emit_deployment_timing() {
	if [[ "$#" -ne 6 ]]; then return 2; fi
	printf 'guard_total_deadline_ms=%s\n' "$1"
	printf 'guard_retry_attempt_headroom_ms=%s\n' "$2"
	printf 'guard_max_recovery_sleep_ms=%s\n' "$3"
	printf 'guard_shutdown_grace_ms=%s\n' "$4"
	printf 'guard_max_recovery_waits=%s\n' "$5"
	printf 'stop_timeout_ms=%s\n' "$6"
}

deployment_timing_value() {
	if [[ "$#" -ne 2 || ! "$2" =~ ^[a-z_]+$ ]]; then return 2; fi
	printf '%s\n' "$1" | awk -F= -v key="$2" '
		$1 == key { value = substr($0, length(key) + 2); count += 1 }
		END { if (count != 1 || value == "") exit 1; print value }
	'
}

validate_deployment_timing() {
	if [[ "$#" -ne 1 || ! -f "$1" ]]; then
		echo "validate_deployment_timing requires one existing systemd pin" >&2
		return 2
	fi

	local pin="$1" deadline_ms retry_attempt_headroom_ms max_recovery_sleep_ms shutdown_grace_ms max_recovery_waits kill_mode stop_timeout
	local stop_timeout_usec stop_timeout_ms minimum_stop_timeout_usec
	deadline_ms="$(
		configured_systemd_environment_value "$pin" GUARD_TOTAL_DEADLINE_MS
	)" || {
		echo "systemd pin is missing GUARD_TOTAL_DEADLINE_MS" >&2
		return 1
	}
	retry_attempt_headroom_ms="$(
		configured_systemd_environment_value "$pin" GUARD_RETRY_ATTEMPT_HEADROOM_MS
	)" || {
		echo "systemd pin is missing GUARD_RETRY_ATTEMPT_HEADROOM_MS" >&2
		return 1
	}
	max_recovery_sleep_ms="$(
		configured_systemd_environment_value "$pin" GUARD_MAX_RECOVERY_SLEEP_MS
	)" || {
		echo "systemd pin is missing GUARD_MAX_RECOVERY_SLEEP_MS" >&2
		return 1
	}
	max_recovery_waits="$(
		configured_systemd_environment_value "$pin" GUARD_MAX_RECOVERY_WAITS
	)" || {
		echo "systemd pin is missing GUARD_MAX_RECOVERY_WAITS" >&2
		return 1
	}
	shutdown_grace_ms="$(
		configured_systemd_environment_value "$pin" GUARD_SHUTDOWN_GRACE_MS
	)" || {
		echo "systemd pin is missing GUARD_SHUTDOWN_GRACE_MS" >&2
		return 1
	}
	kill_mode="$(configured_systemd_directive_value "$pin" KillMode)" || {
		echo "systemd pin is missing KillMode" >&2
		return 1
	}
	stop_timeout="$(configured_systemd_directive_value "$pin" TimeoutStopSec)" || {
		echo "systemd pin is missing TimeoutStopSec" >&2
		return 1
	}

	validate_guard_timing_values \
		"$deadline_ms" \
		"$retry_attempt_headroom_ms" \
		"$max_recovery_sleep_ms" \
		"$shutdown_grace_ms" \
		"$max_recovery_waits" \
		"" || return 1
	if [[ "$kill_mode" != "mixed" ]]; then
		echo "unsafe KillMode=${kill_mode}; expected mixed" >&2
		return 1
	fi
	stop_timeout_usec="$(systemd_duration_to_microseconds "$stop_timeout")" || {
		echo "unsupported TimeoutStopSec=${stop_timeout}" >&2
		return 1
	}
	minimum_stop_timeout_usec=$(((shutdown_grace_ms + 120000) * 1000))
	if ((stop_timeout_usec < minimum_stop_timeout_usec)); then
		echo "unsafe TimeoutStopSec=${stop_timeout}; expected at least ${minimum_stop_timeout_usec}us" >&2
		return 1
	fi
	stop_timeout_ms=$((stop_timeout_usec / 1000))

	emit_deployment_timing \
		"$deadline_ms" \
		"$retry_attempt_headroom_ms" \
		"$max_recovery_sleep_ms" \
		"$shutdown_grace_ms" \
		"$max_recovery_waits" \
		"$stop_timeout_ms"
}

systemd_environment_text_value() {
	if [[ "$#" -ne 2 || ! "$2" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
		return 2
	fi
	node - "$1" "$2" <<'NODE'
const [input, key] = process.argv.slice(2);
const words = [];
let word = "";
let quote = null;
let started = false;
for (let i = 0; i < input.length; i += 1) {
	const char = input[i];
	if (quote !== null) {
		if (char === quote) {
			quote = null;
		} else if (char === "\\" && quote === '"' && i + 1 < input.length) {
			word += input[++i];
		} else {
			word += char;
		}
		started = true;
	} else if (char === "'" || char === '"') {
		quote = char;
		started = true;
	} else if (/\s/.test(char)) {
		if (started) {
			words.push(word);
			word = "";
			started = false;
		}
	} else if (char === "\\" && i + 1 < input.length) {
		word += input[++i];
		started = true;
	} else {
		word += char;
		started = true;
	}
}
if (quote !== null) process.exit(2);
if (started) words.push(word);
let value;
for (const item of words) {
	const equals = item.indexOf("=");
	if (item.slice(0, equals) === key) value = item.slice(equals + 1);
}
if (value === undefined) process.exit(1);
process.stdout.write(value);
NODE
}

validate_effective_systemd_policy() {
	if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
		echo "validate_effective_systemd_policy requires: service [allow-missing-new-guard-limits]" >&2
		return 2
	fi
	local service="$1" allow_missing_new_guard_limits=0
	local kill_mode stop_timeout effective_environment effective_deadline_ms
	local effective_retry_attempt_headroom_ms effective_max_recovery_sleep_ms effective_shutdown_grace_ms effective_max_recovery_waits
	local stop_timeout_usec stop_timeout_ms
	local minimum_stop_timeout_usec
	if [[ "$#" -eq 2 ]]; then
		allow_missing_new_guard_limits="$2"
	fi
	if [[ "$allow_missing_new_guard_limits" != "0" && "$allow_missing_new_guard_limits" != "1" ]]; then
		echo "allow-missing-new-guard-limits must be 0 or 1" >&2
		return 2
	fi

	kill_mode="$(systemctl show "$service" --property=KillMode --value)" || return 1
	stop_timeout="$(systemctl show "$service" --property=TimeoutStopUSec --value)" || return 1
	effective_environment="$(systemctl show "$service" --property=Environment --value)" || return 1
	effective_deadline_ms="$(
		systemd_environment_text_value "$effective_environment" GUARD_TOTAL_DEADLINE_MS
	)" || {
		echo "effective systemd environment is missing GUARD_TOTAL_DEADLINE_MS" >&2
		return 1
	}
	if ! effective_retry_attempt_headroom_ms="$(
		systemd_environment_text_value "$effective_environment" GUARD_RETRY_ATTEMPT_HEADROOM_MS
	)"; then
		if [[ "$allow_missing_new_guard_limits" == "1" ]]; then
			# Rollback compatibility: a pin installed before retry headroom existed
			# cannot publish this environment key. Use the new guard's safe default
			# only to validate the restored timing tuple; strict pre-restart
			# validation of the newly rendered pin still requires the explicit key.
			effective_retry_attempt_headroom_ms=30000
		else
			echo "effective systemd environment is missing GUARD_RETRY_ATTEMPT_HEADROOM_MS" >&2
			return 1
		fi
	fi
	if ! effective_max_recovery_sleep_ms="$(
		systemd_environment_text_value "$effective_environment" GUARD_MAX_RECOVERY_SLEEP_MS
	)"; then
		if [[ "$allow_missing_new_guard_limits" == "1" ]]; then
			# Rollback compatibility for pins installed before the sleep cap was
			# explicit. Strict validation of a newly rendered pin still requires it.
			effective_max_recovery_sleep_ms=120000
		else
			echo "effective systemd environment is missing GUARD_MAX_RECOVERY_SLEEP_MS" >&2
			return 1
		fi
	fi
	if ! effective_max_recovery_waits="$(
		systemd_environment_text_value "$effective_environment" GUARD_MAX_RECOVERY_WAITS
	)"; then
		if [[ "$allow_missing_new_guard_limits" == "1" ]]; then
			# Rollback compatibility for pins installed before bounded recovery
			# admission was explicit. New rendered pins always require this key.
			effective_max_recovery_waits=12
		else
			echo "effective systemd environment is missing GUARD_MAX_RECOVERY_WAITS" >&2
			return 1
		fi
	fi
	effective_shutdown_grace_ms="$(
		systemd_environment_text_value "$effective_environment" GUARD_SHUTDOWN_GRACE_MS
	)" || {
		echo "effective systemd environment is missing GUARD_SHUTDOWN_GRACE_MS" >&2
		return 1
	}

	if [[ "$kill_mode" != "mixed" ]]; then
		echo "effective KillMode=${kill_mode}; expected mixed" >&2
		return 1
	fi
	validate_guard_timing_values \
		"$effective_deadline_ms" \
		"$effective_retry_attempt_headroom_ms" \
		"$effective_max_recovery_sleep_ms" \
		"$effective_shutdown_grace_ms" \
		"$effective_max_recovery_waits" \
		"effective " || return 1
	stop_timeout_usec="$(systemd_duration_to_microseconds "$stop_timeout")" || {
		echo "unsupported effective TimeoutStopUSec=${stop_timeout}" >&2
		return 1
	}
	minimum_stop_timeout_usec=$(((effective_shutdown_grace_ms + 120000) * 1000))
	if ((stop_timeout_usec < minimum_stop_timeout_usec)); then
		echo "effective TimeoutStopUSec=${stop_timeout}; expected at least ${minimum_stop_timeout_usec}us" >&2
		return 1
	fi
	stop_timeout_ms=$((stop_timeout_usec / 1000))
	emit_deployment_timing \
		"$effective_deadline_ms" \
		"$effective_retry_attempt_headroom_ms" \
		"$effective_max_recovery_sleep_ms" \
		"$effective_shutdown_grace_ms" \
		"$effective_max_recovery_waits" \
		"$stop_timeout_ms"
}

reload_validate_or_restore_systemd_policy() {
	if [[ "$#" -ne 3 || ! -f "$1" || ! -f "$2" ]]; then
		echo "reload_validate_or_restore_systemd_policy requires: pin backup service" >&2
		return 2
	fi
	local pin="$1" backup="$2" service="$3"
	local rollback_stage="${pin}.pre-restart-rollback-$$"

	if sudo systemctl daemon-reload \
		&& validate_effective_systemd_policy "$service"; then
		return 0
	fi

	echo "ERROR: effective systemd policy is unsafe; restoring the prior pin before restart" >&2
	if ! sudo cp --preserve=all "$backup" "$rollback_stage" \
		|| ! sudo mv -f "$rollback_stage" "$pin" \
		|| ! sudo systemctl daemon-reload; then
		echo "HARD FAILURE: pre-restart systemd pin restoration failed" >&2
		sudo rm -f "$rollback_stage" 2>/dev/null || true
		return 70
	fi
	if ! validate_effective_systemd_policy "$service" 1 >/dev/null; then
		echo "HARD FAILURE: operator drop-ins still produce an unsafe effective systemd policy after restoring the prior deploy pin" >&2
		echo "Correct the later operator drop-ins (for example /etc/systemd/system/ccflare-stack.service.d/90-operator-policy.conf) before restarting the service." >&2
		return 70
	fi
	return 1
}

validate_deploy_health() {
	if [[ "$#" -ne 3 ]]; then
		echo "validate_deploy_health requires: proxy-json guard-json expected-json" >&2
		return 2
	fi

	node - "$1" "$2" "$3" <<'NODE'
const [proxyText, guardText, expectedText] = process.argv.slice(2);

let proxy;
let guard;
let expected;
try {
	proxy = JSON.parse(proxyText);
	guard = JSON.parse(guardText);
	expected = JSON.parse(expectedText);
} catch (error) {
	console.error(`deployment health response was not valid JSON: ${error.message}`);
	process.exit(1);
}

const mismatches = [];
const compare = (label, actual, wanted) => {
	if (actual !== wanted) {
		mismatches.push(`${label}=${JSON.stringify(actual)} expected ${JSON.stringify(wanted)}`);
	}
};
compare("proxy git_sha", proxy?.git_sha, expected?.proxyGitSha);
compare("guard sourceId", guard?.sourceId, expected?.sourceId);
compare("guard policyId", guard?.policyId, expected?.policyId);
compare("runner pid", guard?.runtime?.process?.runnerPid, expected?.runnerPid);
for (const name of ["binary", "runner", "guard", "policy"]) {
	compare(
		`${name} path`,
		guard?.runtime?.artifacts?.[name]?.path,
		expected?.artifacts?.[name]?.path,
	);
	compare(
		`${name} sha256`,
		guard?.runtime?.artifacts?.[name]?.sha256,
		expected?.artifacts?.[name]?.sha256,
	);
}
for (const name of [
	"totalDeadlineMs",
	"retryAttemptHeadroomMs",
	"maxRecoverySleepMs",
	"maxRecoveryWaits",
	"shutdownGraceMs",
	"maxAttempts",
	"jitterMs",
	"maxInspectionBytes",
]) {
	compare(
		`limit ${name}`,
		guard?.runtime?.limits?.[name],
		expected?.limits?.[name],
	);
}

for (const [label, value] of [
	["actual", guard?.runtime?.limits?.maxRecoverySleepMs],
	["expected", expected?.limits?.maxRecoverySleepMs],
]) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 120000) {
		mismatches.push(`${label} maxRecoverySleepMs=${JSON.stringify(value)} outside hard range 1..120000`);
	}
}

for (const [label, value] of [
	["actual", guard?.runtime?.limits?.maxRecoveryWaits],
	["expected", expected?.limits?.maxRecoveryWaits],
]) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) {
		mismatches.push(`${label} maxRecoveryWaits=${JSON.stringify(value)} outside hard range 1..1000000`);
	}
}

if (mismatches.length > 0) {
	console.error(`deployment identity mismatch: ${mismatches.join("; ")}`);
	process.exit(1);
}
NODE
}

validate_rollback_health() {
	if [[ "$#" -ne 4 ]]; then
		echo "validate_rollback_health requires: prior-proxy prior-guard current-proxy current-guard" >&2
		return 2
	fi

	node - "$1" "$2" "$3" "$4" <<'NODE'
const texts = process.argv.slice(2);
let priorProxy;
let priorGuard;
let currentProxy;
let currentGuard;
try {
	[priorProxy, priorGuard, currentProxy, currentGuard] = texts.map(JSON.parse);
} catch (error) {
	console.error(`rollback identity proof is not valid JSON: ${error.message}`);
	process.exit(70);
}

const stableGuardIdentity = (guard) => ({
	sourceId: guard?.sourceId,
	policyId: guard?.policyId,
	artifacts: Object.fromEntries(
		["binary", "runner", "guard", "policy"].map((name) => [
			name,
			{
				path: guard?.runtime?.artifacts?.[name]?.path,
				sha256: guard?.runtime?.artifacts?.[name]?.sha256,
			},
		]),
	),
	limits: guard?.runtime?.limits,
});
const prior = stableGuardIdentity(priorGuard);
const limitNames = [
	"totalDeadlineMs",
	"maxAttempts",
	"jitterMs",
	"maxInspectionBytes",
];
const complete =
	typeof priorProxy?.git_sha === "string" &&
	typeof prior.sourceId === "string" &&
	typeof prior.policyId === "string" &&
	prior.limits &&
	limitNames.every((name) => Number.isFinite(prior.limits[name])) &&
	Object.values(prior.artifacts).every(
		(value) => typeof value.path === "string" && typeof value.sha256 === "string",
	);
if (!complete) {
	console.error("prior deployment identity is incomplete; rollback cannot be proven");
	process.exit(70);
}
if (
	currentProxy?.git_sha !== priorProxy.git_sha ||
	JSON.stringify(stableGuardIdentity(currentGuard)) !== JSON.stringify(prior)
) {
	console.error("restored deployment identity does not match the captured prior identity");
	process.exit(70);
}
NODE
}

sha256_file() {
	if [[ "$#" -ne 1 || ! -f "$1" ]]; then
		echo "sha256_file requires one existing file" >&2
		return 2
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

verify_process_start_identity() {
	if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
		echo "verify_process_start_identity requires: pid expected-runner [proc-root]" >&2
		return 2
	fi
	local pid="$1" expected="$2" proc_root="${3:-/proc}"
	[[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && -r "$proc_root/$pid/cmdline" ]] || return 1
	local expected_real candidate candidate_real
	expected_real="$(readlink -f "$expected")" || return 1
	while IFS= read -r -d '' candidate; do
		candidate_real="$(readlink -f "$candidate" 2>/dev/null || true)"
		if [[ -n "$candidate_real" && "$candidate_real" == "$expected_real" ]]; then
			return 0
		fi
	done <"$proc_root/$pid/cmdline"
	return 1
}

artifact_prune_candidates() {
	if [[ "$#" -lt 2 ]]; then
		echo "artifact_prune_candidates requires: root keep-count [protected-dir ...]" >&2
		return 2
	fi
	local root="$1" keep_count="$2"
	shift 2
	[[ "$keep_count" =~ ^[0-9]+$ ]] || return 2
	local rank=0 timestamp path base protected
	while IFS=$'\t' read -r timestamp path; do
		[[ -n "$timestamp" && -n "$path" ]] || continue
		base="$(basename "$path")"
		[[ "$base" =~ ^[0-9a-f]{7,40}$ ]] || continue
		rank=$((rank + 1))
		((rank <= keep_count)) && continue
		for protected in "$@"; do
			[[ -n "$protected" && "$path" == "$protected" ]] && continue 2
		done
		printf '%s\n' "$path"
	done < <(
		find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\n' 2>/dev/null \
			| sort -t $'\t' -k1,1nr
	)
}

guard_prune_candidates() {
	if [[ "$#" -ne 4 ]]; then
		echo "guard_prune_candidates requires: guards-root deployed-dir pinned-dir keep-count" >&2
		return 2
	fi

	artifact_prune_candidates "$1" "$4" "$2" "$3"
}
