#!/usr/bin/env bash
# Reports the verdict of the Bun Latest Canary workflow (#321) to a single
# tracking issue, identified by MARKER in its body.
#
# Called as the final step of .github/workflows/bun-latest-canary.yml, after
# the managed-routing gate has run (or been skipped) against the resolved Bun
# version. The canary itself never floats .bun-version -- an upgrade stays a
# deliberate one-line edit (docs/contributing.md, "Bumping the Bun
# toolchain"); this script only files or updates the evidence trail.
#
# Behavior:
#   - outcome=failure, no open tracking issue          -> files one (label: bug).
#   - outcome=failure, open issue already reporting this
#     exact state (resolved version + outcome)         -> no writes.
#   - outcome=failure, open issue reporting a different
#     state                                             -> comments with the new state.
#   - outcome=success, tracking issue's last state is a
#     failure or a different resolved version          -> comments that it now passes.
#   - outcome=success, tracking issue already at this
#     state, or no open issue at all                   -> no writes (a ::notice:: when
#                                                          there is no issue to update).
#   - Never closes, edits, or labels an existing issue: closing the tracking
#     issue is a human decision, made once the pin moves past the failing
#     version.
#
# Env contract (all required unless noted; missing -> ::error:: + exit 2):
#   GH_TOKEN               token consumed by `gh`
#   GITHUB_REPOSITORY      "owner/repo" to search/file/comment in
#   CANARY_RUN_URL         URL of the workflow run being reported
#   CANARY_RESOLVED_BUN    `bun --version` output for the canaried install
#   CANARY_PINNED_BUN      contents of .bun-version (trimmed)
#   CANARY_GATE_OUTCOME    `success` | `failure` handled; anything else
#                          (`skipped`, `cancelled`, ...) -> ::warning:: + exit 0
#   CANARY_REQUESTED_BUN   optional, default "latest" -- the requested channel
#                          (e.g. "latest", "1.5.x") before setup-bun resolved it
#   CANARY_ACTOR_LOGIN     optional, default "github-actions[bot]" -- the
#                          identity secrets.GITHUB_TOKEN writes as. Only the
#                          open issue and comments authored by this login are
#                          considered when locating the tracking issue and its
#                          dedupe history, so an issue or comment from anyone
#                          else can neither hijack the tracking issue nor
#                          suppress a real report.
#
# Usage (as run by the workflow; GH_TOKEN normally comes from
# secrets.GITHUB_TOKEN and GITHUB_REPOSITORY from the runner environment):
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo \
#   CANARY_RUN_URL=https://github.com/owner/repo/actions/runs/123 \
#   CANARY_RESOLVED_BUN=1.4.3 CANARY_PINNED_BUN=1.4.2 \
#   CANARY_GATE_OUTCOME=failure CANARY_REQUESTED_BUN=latest \
#   ./scripts/bun-latest-canary-report.sh

set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "::error::${name} is required" >&2
    exit 2
  fi
}

for var in GH_TOKEN GITHUB_REPOSITORY CANARY_RUN_URL CANARY_RESOLVED_BUN CANARY_PINNED_BUN CANARY_GATE_OUTCOME; do
  require_env "${var}"
done

CANARY_REQUESTED_BUN="${CANARY_REQUESTED_BUN:-latest}"
CANARY_ACTOR_LOGIN="${CANARY_ACTOR_LOGIN:-github-actions[bot]}"

case "${CANARY_GATE_OUTCOME}" in
  success | failure) ;;
  *)
    echo "::warning::nothing to report (gate outcome: ${CANARY_GATE_OUTCOME})"
    exit 0
    ;;
esac

# gh_capture runs gh "$@", returning its combined stdout+stderr as this
# function's stdout on success. Any gh failure (read or write) is reported
# through ::error:: and exits the whole script with 1 -- there is no
# best-effort/fail-soft path here, unlike the upstream-cache-capability-watch
# workflow this superficially resembles.
gh_capture() {
  local output
  if ! output="$(gh "$@" 2>&1)"; then
    echo "::error::gh $* failed: ${output}" >&2
    exit 1
  fi
  printf '%s' "${output}"
}

MARKER='<!-- bun-latest-canary -->'
STATE_MARKER="<!-- bun-latest-canary:state resolved=${CANARY_RESOLVED_BUN} outcome=${CANARY_GATE_OUTCOME} -->"
STATE_MARKER_REGEX='<!-- bun-latest-canary:state resolved=[^[:space:]]+ outcome=(success|failure) -->'

TMP_DIR="${RUNNER_TEMP:-$(mktemp -d)}"
mkdir -p "${TMP_DIR}"

# The REST issues list includes pull requests (each carries a `pull_request`
# key) and every open issue regardless of author, so both are filtered out
# below rather than trusted from the query string alone. --paginate follows
# every page; --slurp collects the pages as an array of per-page arrays,
# which `flatten(1)` merges into one flat array of issues.
ISSUES_JSON="$(gh_capture api --paginate --slurp "repos/${GITHUB_REPOSITORY}/issues?state=open&per_page=100")"
ISSUES_JSON="$(printf '%s' "${ISSUES_JSON}" | jq 'flatten(1)')"

# Lowest-numbered open issue authored by CANARY_ACTOR_LOGIN whose body
# carries MARKER; empty if none. A decoy open issue without the marker, an
# issue authored by someone else, or an open pull request must never be
# picked up here -- only the workflow's own identity can hijack or suppress
# the tracking issue via a crafted issue/comment.
ISSUE="$(printf '%s' "${ISSUES_JSON}" | jq -r --arg marker "${MARKER}" --arg actor "${CANARY_ACTOR_LOGIN}" '
  [.[]
    | select(.pull_request == null)
    | select((.user.login // "") == $actor)
    | select((.body // "") | contains($marker))]
  | sort_by(.number)
  | (.[0].number // empty)
')"

LAST_STATE_MARKER=""
if [[ -n "${ISSUE}" ]]; then
  COMMENTS_JSON="$(gh_capture api --paginate --slurp "repos/${GITHUB_REPOSITORY}/issues/${ISSUE}/comments?per_page=100")"
  COMMENTS_JSON="$(printf '%s' "${COMMENTS_JSON}" | jq 'flatten(1)')"
  ISSUE_BODY="$(printf '%s' "${ISSUES_JSON}" | jq -r --argjson num "${ISSUE}" '
    .[] | select(.number == $num) | (.body // "")
  ')"
  # Only comments authored by CANARY_ACTOR_LOGIN count towards dedupe state;
  # a comment from anyone else must not suppress (or fake) a report.
  COMMENTS_TEXT="$(printf '%s' "${COMMENTS_JSON}" | jq -r --arg actor "${CANARY_ACTOR_LOGIN}" '
    [.[] | select((.user.login // "") == $actor)]
    | sort_by(.created_at) | map(.body // "") | join("\n")
  ')"
  # History in chronological order: the issue body first, then comments.
  # The last state marker found across that history is the last verdict
  # reported on this issue, regardless of which resolved version it names.
  LAST_STATE_MARKER="$(
    { printf '%s\n' "${ISSUE_BODY}"; printf '%s\n' "${COMMENTS_TEXT}"; } \
      | grep -oE "${STATE_MARKER_REGEX}" | tail -n1 || true
  )"
fi

if [[ "${CANARY_GATE_OUTCOME}" == "failure" ]]; then
  if [[ -z "${ISSUE}" ]]; then
    TITLE="ci: Bun ${CANARY_RESOLVED_BUN} (${CANARY_REQUESTED_BUN}) fails the managed-routing gate; .bun-version stays at ${CANARY_PINNED_BUN}"
    BODY_FILE="$(mktemp "${TMP_DIR}/bun-canary-issue-body.XXXXXX")"
    cat >"${BODY_FILE}" <<EOF
${MARKER}
${STATE_MARKER}

Filed by the Bun Latest Canary workflow: ${CANARY_RUN_URL}.

| | |
|---|---|
| Requested channel | \`${CANARY_REQUESTED_BUN}\` |
| Resolved version | \`${CANARY_RESOLVED_BUN}\` |
| Pinned version (\`.bun-version\`) | \`${CANARY_PINNED_BUN}\` |

What to do:

1. Reproduce with the gate's per-file loop under both versions; see \`docs/solutions/workflow-issues/bun-1-4-stream-cancel-and-net-close-semantics.md\` §6 "Bun version bumps".
2. Fix the suites and/or production code. Never restore \`bun-version: latest\`.
3. Bump \`.bun-version\` in a PR once the gate is green on the new version (\`docs/contributing.md\`, "Bumping the Bun toolchain").

The canary updates this issue once per new verdict and never closes it (repository policy); close it after the pin moves past this version.
EOF
    CREATE_OUTPUT="$(gh_capture issue create --repo "${GITHUB_REPOSITORY}" --label bug --title "${TITLE}" --body-file "${BODY_FILE}")"
    printf '%s\n' "${CREATE_OUTPUT}"
  elif [[ "${LAST_STATE_MARKER}" == "${STATE_MARKER}" ]]; then
    echo "Bun ${CANARY_RESOLVED_BUN} (${CANARY_GATE_OUTCOME}) already reported on issue #${ISSUE}; nothing to do."
  else
    COMMENT_BODY_FILE="$(mktemp "${TMP_DIR}/bun-canary-comment.XXXXXX")"
    cat >"${COMMENT_BODY_FILE}" <<EOF
${STATE_MARKER}

Bun ${CANARY_RESOLVED_BUN} (${CANARY_REQUESTED_BUN}) still fails the managed-routing gate: ${CANARY_RUN_URL}. \`.bun-version\` stays at ${CANARY_PINNED_BUN}.
EOF
    gh_capture issue comment "${ISSUE}" --repo "${GITHUB_REPOSITORY}" --body-file "${COMMENT_BODY_FILE}" >/dev/null
  fi
else
  if [[ -z "${ISSUE}" ]]; then
    echo "::notice::Bun ${CANARY_RESOLVED_BUN} passes the managed-routing gate; .bun-version stays at ${CANARY_PINNED_BUN} until bumped deliberately."
  elif [[ "${LAST_STATE_MARKER}" == "${STATE_MARKER}" ]]; then
    echo "Bun ${CANARY_RESOLVED_BUN} (${CANARY_GATE_OUTCOME}) already reported on issue #${ISSUE}; nothing to do."
  else
    COMMENT_BODY_FILE="$(mktemp "${TMP_DIR}/bun-canary-comment.XXXXXX")"
    cat >"${COMMENT_BODY_FILE}" <<EOF
${STATE_MARKER}

Bun ${CANARY_RESOLVED_BUN} (${CANARY_REQUESTED_BUN}) passes the full managed-routing gate: ${CANARY_RUN_URL}. \`.bun-version\` (${CANARY_PINNED_BUN}) can be bumped deliberately; close this issue once the pin moves past the failing version.
EOF
    gh_capture issue comment "${ISSUE}" --repo "${GITHUB_REPOSITORY}" --body-file "${COMMENT_BODY_FILE}" >/dev/null
  fi
fi
