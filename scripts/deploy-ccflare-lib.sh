#!/usr/bin/env bash

# Pure helpers for deploy-ccflare.sh. Keep these functions free of sudo,
# systemd, and host-specific mutation so deployment contracts can be tested
# against temporary files.

render_systemd_pin() {
	if [[ "$#" -ne 7 ]]; then
		echo "render_systemd_pin requires: input output binary runner guard source-id policy-id" >&2
		return 2
	fi

	local input="$1"
	local output="$2"
	local binary="$3"
	local runner="$4"
	local guard_script="$5"
	local source_id="$6"
	local policy_id="$7"

	awk \
		-v binary="$binary" \
		-v runner="$runner" \
		-v guard_script="$guard_script" \
		-v source_id="$source_id" \
		-v policy_id="$policy_id" '
		function emit(key, value) {
			print "Environment=" key "=" value
		}
		/^Environment=CCFLARE_BIN=/ {
			if (!seen_binary++) emit("CCFLARE_BIN", binary)
			next
		}
		/^Environment=GUARD_SCRIPT=/ {
			if (!seen_guard++) emit("GUARD_SCRIPT", guard_script)
			next
		}
		/^Environment=GUARD_SOURCE_ID=/ {
			if (!seen_source++) emit("GUARD_SOURCE_ID", source_id)
			next
		}
		/^Environment=GUARD_POLICY_ID=/ {
			if (!seen_policy++) emit("GUARD_POLICY_ID", policy_id)
			next
		}
		/^ExecStart=/ { next }
		{ print }
		END {
			if (!seen_binary) emit("CCFLARE_BIN", binary)
			if (!seen_guard) emit("GUARD_SCRIPT", guard_script)
			if (!seen_source) emit("GUARD_SOURCE_ID", source_id)
			if (!seen_policy) emit("GUARD_POLICY_ID", policy_id)
			print "ExecStart="
			print "ExecStart=" runner
		}
	' "$input" >"$output"
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
