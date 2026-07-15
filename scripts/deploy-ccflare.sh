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
#      and chmod +x it.
#   4. Back up, then rewrite ONLY the CCFLARE_BIN= line in the systemd pin
#      (/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf),
#      preserving every other Environment= line in that drop-in.
#   5. `systemctl daemon-reload && systemctl restart ccflare-stack.service`.
#   6. Poll the guard's health endpoint (passed through to the real server)
#      until it responds, up to ~60s.
#   7. Verify the running binary reports the deployed git SHA via the
#      health endpoint's `git_sha` field; loudly warn on mismatch (the
#      restart may not have picked up the new pin).
#   8. Prune old binaries and pin backups, keeping a small safety margin.
#      Never removes the binary that is currently pinned.
#
# REQUIRES: git, node, bun, curl, sudo (for the systemd pin + restart).
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEST="/home/will/.config/better-ccflare"
PIN="/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf"
HEALTH_URL="http://127.0.0.1:8788/health"
HEALTH_WAIT_SECS=60
KEEP_BINARIES=5
KEEP_BACKUPS=3

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

# ---------------------------------------------------------------------------
# 2) Build
# ---------------------------------------------------------------------------
BIN_NAME="better-ccflare-v${VERSION}-${SHORT}"

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
echo "==> Installed $DEST_BIN"

# ---------------------------------------------------------------------------
# 4) Update the systemd pin, preserving every other Environment= line
# ---------------------------------------------------------------------------
echo "==> Updating systemd pin ($PIN)…"
PIN_BACKUP="${PIN}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp "$PIN" "$PIN_BACKUP"
sudo sed -i.bak "s#^Environment=CCFLARE_BIN=.*#Environment=CCFLARE_BIN=${DEST_BIN}#" "$PIN"

if ! grep -q "^Environment=CCFLARE_BIN=${DEST_BIN}$" "$PIN"; then
	echo "ERROR: failed to update CCFLARE_BIN in $PIN — restoring from backup." >&2
	sudo cp "$PIN_BACKUP" "$PIN"
	exit 1
fi
echo "==> Pin backed up to $PIN_BACKUP"

# ---------------------------------------------------------------------------
# 5) Restart
# ---------------------------------------------------------------------------
echo "==> Restarting ccflare-stack.service…"
sudo systemctl daemon-reload
sudo systemctl restart ccflare-stack.service

# ---------------------------------------------------------------------------
# 6) Wait for health
# ---------------------------------------------------------------------------
echo "==> Waiting for health at $HEALTH_URL…"
HEALTH_OK=0
for _ in $(seq 1 "$HEALTH_WAIT_SECS"); do
	if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
		HEALTH_OK=1
		break
	fi
	sleep 1
done

if [[ "$HEALTH_OK" == "1" ]]; then
	echo "==> Service is healthy."
else
	echo "WARNING: service did not respond healthy within ${HEALTH_WAIT_SECS}s at $HEALTH_URL" >&2
fi

# ---------------------------------------------------------------------------
# 7) Verify the running binary is actually the SHA we just deployed
# ---------------------------------------------------------------------------
REPORTED_SHA=""
if [[ "$HEALTH_OK" == "1" ]]; then
	REPORTED_SHA="$(curl -sf "$HEALTH_URL" 2>/dev/null | node -e '
		let d = "";
		process.stdin.on("data", (c) => { d += c; });
		process.stdin.on("end", () => {
			try {
				const body = JSON.parse(d);
				process.stdout.write(body.git_sha || "");
			} catch {
				process.stdout.write("");
			}
		});
	' 2>/dev/null || true)"
fi

if [[ "$REPORTED_SHA" == "$SHORT" ]]; then
	echo "==> Verified: running binary reports git_sha=$REPORTED_SHA (matches deployed $SHORT)."
else
	echo "WARNING: running binary reports git_sha='${REPORTED_SHA:-<empty>}', expected '${SHORT}'." >&2
	echo "WARNING: the restart may not have picked up the new pin — do not assume this deploy is live." >&2
fi

# ---------------------------------------------------------------------------
# 8) Prune old artifacts. Conservative: never touch the binary we just
#    pinned, and only remove things strictly beyond the keep window.
# ---------------------------------------------------------------------------
echo "==> Pruning old binaries and pin backups…"

mapfile -t OLD_BINS < <(
	find "$DEST" -maxdepth 1 -type f -name 'better-ccflare-v*' -printf '%T@ %p\n' 2>/dev/null \
		| sort -rn \
		| awk '{print $2}' \
		| tail -n "+$((KEEP_BINARIES + 1))"
)
for f in "${OLD_BINS[@]:-}"; do
	if [[ -n "$f" && -f "$f" && "$f" != "$DEST_BIN" ]]; then
		rm -f "$f"
		echo "    removed $f"
	fi
done

PIN_DIR="$(dirname "$PIN")"
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
echo "pin:           $PIN"
echo "  CCFLARE_BIN= $DEST_BIN"
echo "health:        $([[ "$HEALTH_OK" == "1" ]] && echo "OK" || echo "UNVERIFIED (see warning above)")"
echo "reported sha:  ${REPORTED_SHA:-<none>} $([[ "$REPORTED_SHA" == "$SHORT" ]] && echo "(match)" || echo "(MISMATCH — see warning above)")"
