# Technical reference

Manual installation, client configuration, and operating details for HoV Router. For agent-assisted setup, start with the [agent setup guide](agent-setup.md). Use `hov-router`; `wstack-router` and `better-ccflare` remain compatible commands.

- [Linux x86_64 release](#install-the-linux-x86_64-release) or [source build](#install-from-source)
- [Local server and account setup](#start-the-local-server)
- [Claude Code authentication](#configure-claude-sdk) and [Codex client](#codex-cli-as-a-client)
- [Environment variables](#environment-variables), [TLS](#sslhttps-configuration), and [database repair](#troubleshooting-database-issues)
- [Documentation index](index.md), [contributions](contributing.md), and [credits](acknowledgements.md)

## Capabilities

- **Account failover** - Distribute requests across available accounts; exhausted pools can still fail
- **🤖 Multi-Provider Support** - Claude OAuth, Claude API console, Vertex AI, AWS Bedrock, NanoGPT, z.ai, Minimax, DeepSeek, OpenRouter, Kilo, Codex (OpenAI OAuth), xAI/Grok, Meta Model API (`meta`; legacy `muse-spark` HTTP ingress compatibility), Anthropic-compatible, and OpenAI-compatible providers
- **🔒 OAuth Token Health** - Real-time monitoring of OAuth token status with automatic refresh and health indicators
- **🔗 Custom API Endpoints** - Configure custom endpoints for Anthropic accounts for enterprise deployments
- **☁️ OpenAI-Compatible Support** - Use OpenAI-compatible providers like OpenRouter, Together AI, and more with Claude API format
- **🧩 Codex / Responses API Compatibility** - `POST /v1/responses` and `POST /v1/responses/compact` are translated to Anthropic `/v1/messages`
- **🔄 Smart Auto-Fallback** - Automatically switch back to preferred accounts when their rate limits reset
- **⚡ Auto-Refresh** - Automatically start new usage windows when rate limits reset with 30-minute buffer
- **📊 Request-Level Analytics** - Track latency, token usage, and costs in real-time with optimized batch processing
- **🔍 Deep Debugging** - Full request/response logging and error traces
- **🔐 API Authentication** - Optional API key authentication with secure key management
- **🛡️ Security Hardened** - Critical security fixes for authentication bypass, command injection, and credential leakage
- **💸 Free & Open Source** - Run it yourself, modify it, own your infrastructure

### Background and compatibility

This project builds upon the foundation of [snipeship/ccflare](https://github.com/snipeship/ccflare) with these additions:

**🎯 Core Improvements (v3.0.0):**
- **Enhanced Security** - Critical fixes for authentication bypass, command injection, and PKCE implementation
- **OAuth Token Health Monitoring** - Real-time status indicators and automatic token refresh with 30-minute buffer
- **Extended Provider Support** - AWS Bedrock, NanoGPT (with dynamic pricing), Minimax, DeepSeek, OpenRouter, Kilo, Codex (OpenAI OAuth), xAI/Grok, Meta Model API (`meta`; legacy `muse-spark` HTTP ingress compatibility), Anthropic-compatible, and OpenAI-compatible providers
- **Simplified Load Balancing** - Removed tier system for O(1) priority-based selection
- **Real-time Analytics Dashboard** - Web UI with fixed request history (no disappearing requests)
- **Source Installation** - Build the current fork locally; upstream distribution recipes below install upstream, not HoV Router

**🛠️ Developer Experience:**
- **Powerful CLI** - Complete command-line interface for account management and configuration
- **REST API** - Complete API for automation and integration
- **Claude Code `/model` Route Profiles** - Discover operator-defined exact-account or capability-pool routes in Claude Code's native picker and pin one authenticated session tree when caller/session identity is available, without changing other sessions. See [configuration](configuration.md#claude-code-model-route-profiles) and [routing semantics](routing-architecture.md#claude-code-model-route-profiles)
- **Standalone Linux x86_64 Binary** - Router 3.6.2 runs without Node.js or Bun; other platforms use the source-build path
- **Comprehensive Logging** - Request/response tracking with searchable history
- **Alert Webhooks** - With an empty `ALERT_WEBHOOK_TYPES` list, Discord keeps cache-efficiency observations (including recovery) and unknown-model catalog observations in alert history and the dashboard stream without sending a notification. Authentication failures, capacity warnings, actual stale-policy model rewrites, and cache telemetry gaps (including recovery) remain eligible. A nonempty list admits exactly the named types, including these observations. Generic webhooks retain their legacy admission and `{type, alert}` body. Discord presents the affected thing, observation, impact, action, and where to find evidence; raw messages remain in history. Persistence is not a delivery receipt: failed sends are logged, and the existing engine can record an opening that never arrived and later send its recovery.
- **Database Integration** - SQLite (default) or PostgreSQL for persistent storage and analytics, supporting Kubernetes multi-pod deployments

**Distribution & Updates:**
- **Local Source Build** - Install the built artifact as `hov-router`, `wstack-router`, and `better-ccflare`
- **Manual Updates** - Fetch the current fork and rebuild; branded builds do not offer upstream auto-updates
- **Compatibility** - Package names, build filenames, environment variables, paths, ports, and headers retain their existing names

**🏢 Production Ready:**
- **Enterprise Features** - Custom API endpoints, session management, advanced analytics
- **Reliability** - Automatic error recovery, circuit breakers, and health monitoring
- **Anthropic Degraded-Mode Hardening (opt-in)** - Default-off, restart-scoped large-context replay protection; enforcement is supported only when all affected traffic shares one server runtime. See [configuration](configuration.md#anthropic-degraded-mode), [routing behavior](routing-architecture.md#anthropic-degraded-mode), and the [systemd rollout](systemd.md#anthropic-degraded-mode-rollout).
- **PostgreSQL Support** - Set `DATABASE_URL=postgresql://...` to use PostgreSQL for Kubernetes multi-pod deployments where SQLite file-sharing is not feasible

## Quick Start

**Choose before installing:** if a Router already serves your computers, follow [shared-client setup](agent-setup.md#shared-client-only). Use its owner-confirmed origin and authentication; do not install a local Router or repeat server/account setup. The installation sections below are for a **new host**, not each client. Client OS support does not depend on a matching Router server binary; private native test builds are not public releases.

### Install the Linux x86_64 release

[Release 3.6.2](https://github.com/StartupBros/hov-router/releases/tag/v3.6.2) contains one standalone Linux x86_64 binary; Node.js and Bun are not required to run it. For other platforms or a local build, use [Install from source](#install-from-source).

The public home is `StartupBros/hov-router`, renamed from `StartupBros/wstack-router` on 2026-10-21 with the same repository ID `1278801682`. Use the current download and clone URLs below. The historical 3.6.2 binary, manifest, tag, and signing identity stay unchanged; its version output is exactly `wstack Router v3.6.2`, including when invoked through `hov-router`. New source builds display `HoV Router` through all three command names.

Requires Bash on Linux x86_64, `curl`, and GNU coreutils (`sha256sum`, `mkdir`, `chmod`). No GitHub CLI, Node.js, or Bun is needed.

**1. Download and check.** Paste the whole block into Bash. It downloads one binary into a new version directory, checks its SHA-256, and only then makes it executable. It does not run it.

<!-- router-release-install -->
```bash
(
  set -eu
  umask 077
  version_dir="$HOME/.local/lib/wstack-router/3.6.2"
  mkdir -p "$HOME/.local/lib/wstack-router"
  mkdir "$version_dir"
  cd "$version_dir"
  curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --output wstack-router https://github.com/StartupBros/hov-router/releases/download/v3.6.2/better-ccflare-linux-amd64
  digest=b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7
  printf '%s  wstack-router\n' "$digest" | sha256sum --check --strict -
  chmod 755 wstack-router
)
```
<!-- /router-release-install -->

The checksum verifies the bytes against this trusted reference; it does not independently prove who built them. Before the first run, you can also [verify signed build provenance](wstack-router-releases.md#optional-consumer-provenance-verification). That optional check retrieves a bundle from the current repository location and verifies it against the exact historical repository, source commit, tag, workflow identity, signer commit, and hosted runner.

If any command fails, stop: do not run the binary. The block refuses any existing `3.6.2` path, including a symlink, and leaves partial downloads for inspection rather than deleting or overwriting them. Inspect the error and existing files before retrying.

**2. Run.** After the checksum (and optional provenance check) succeeds:

<!-- router-release-run -->
```bash
"$HOME/.local/lib/wstack-router/3.6.2/wstack-router" --help
```
<!-- /router-release-run -->

Continue at [Start the local server](#start-the-local-server), or add the optional aliases below. Existing service users should follow the [migration and rollback guide](wstack-router-migration.md) instead; this quickstart does not change running services.

#### Optional: add commands to PATH

After verification succeeds, create `hov-router`, `wstack-router`, and `better-ccflare` in `$HOME/.local/bin`, all pointing to the same verified binary. This checks all three names before creating any and refuses existing files, directories, or symlinks, including broken ones.

<!-- router-release-path -->
```bash
(
  set -eu
  binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"
  bin_dir="$HOME/.local/bin"
  test -x "$binary"
  mkdir -p "$bin_dir"
  for name in hov-router wstack-router better-ccflare; do
    if [ -e "$bin_dir/$name" ] || [ -L "$bin_dir/$name" ]; then
      printf 'Refusing existing command: %s\n' "$bin_dir/$name" >&2
      exit 1
    fi
  done
  for name in hov-router wstack-router better-ccflare; do
    ln -sT "$binary" "$bin_dir/$name"
  done
)
```
<!-- /router-release-path -->

After success, use `export PATH="$HOME/.local/bin:$PATH"` in each terminal where you want the short commands. Check `command -v hov-router`, `command -v wstack-router`, and `command -v better-ccflare`; all three should resolve there. To keep this PATH setting, add it to your shell configuration yourself. Nothing here edits shell profiles or uses `sudo`. Existing commands elsewhere remain untouched; PATH order determines which runs. If alias creation fails, inspect the error and any link already created rather than forcing replacement.

### Install from source

Requires Git, Node.js (used by the build), and Bun (this checkout pins Bun 1.4.2). These commands use a POSIX shell on Linux/macOS; on Windows use WSL. The public HTTPS clone below does not require a GitHub login.

```bash
git clone https://github.com/StartupBros/hov-router.git better-ccflare
cd better-ccflare
bun install --frozen-lockfile
bun run build
```

The build produces `apps/cli/dist/better-ccflare`. It does not install a command on your PATH. From the checkout root, copy that same artifact under all three names into a fresh user-owned directory. Each name runs the same version with the same provenance and configuration. The clone directory, build filename, `better-ccflare` configuration/database paths, and environment variables retain their existing names. This deliberately leaves any previous installation untouched.

<!-- source-install-local -->
```bash
mkdir -p "$HOME/.local"
install_dir=$(mktemp -d "$HOME/.local/wstack-router.XXXXXX")
for name in hov-router wstack-router better-ccflare; do
  install -m 755 apps/cli/dist/better-ccflare "$install_dir/$name"
done
export PATH="$install_dir:$PATH"
hov-router --version
wstack-router --version
better-ccflare --version
hov-router --help
printf 'Installed commands in %s\n' "$install_dir"
```
<!-- /source-install-local -->

The PATH change applies to this shell only. To keep it, add the printed directory (its literal path, not `$install_dir`) to your shell's PATH configuration, ahead of older installations. Use `command -v hov-router`, `command -v wstack-router`, and `command -v better-ccflare` to confirm which commands will run. Keep the prior executable and its location for rollback; do not overwrite a global install or change an existing service as part of this quickstart.

### Start the local server

The commands below assume you completed the optional [PATH setup](#optional-add-commands-to-path) or the source install. If you skipped PATH setup, replace `hov-router` (or either compatibility command) in these examples with `"$HOME/.local/lib/wstack-router/3.6.2/wstack-router"`.

For a new local setup, start the server and dashboard with:

```bash
BETTER_CCFLARE_HOST=127.0.0.1 hov-router --serve --port 8080
```

Leave the server running, then:

1. Open [the dashboard](http://127.0.0.1:8080/dashboard), select **Accounts > Add Account**, and choose your provider. Complete its credential setup and routing review before configuring a client. For **OpenAI-Compatible**, enter your provider endpoint and credential, select **Discover models**, set the **Sonnet Model** mapping, select **Review routing**, check **I reviewed these routing changes**, then select **Create account**. Other providers have their own authentication steps. For the CLI alternative and live routing verification against this same `http://127.0.0.1:8080` server, see [First-time Setup](cli.md#first-time-setup).
2. Follow [Configure Claude SDK](#configure-claude-sdk), using this server's origin. A provider credential belongs to the account you just added; a proxy API key, when required, authenticates your client to Router.
3. After your first client request, open the dashboard's **Requests** tab. Find that request and check its account and status to confirm which account handled it and whether it succeeded. An account appearing in **Accounts** alone does not prove a request routed successfully.

If port 8080 is occupied, choose an unused port and use it consistently for the server, dashboard, CLI routing commands, and client configuration. `wstack-router` and `better-ccflare` remain equivalent commands. This guide does not change a running service or move existing accounts.

See [manual updates, unchanged paths, and rollback](wstack-router-migration.md). Report fork issues at [StartupBros/hov-router/issues](https://github.com/StartupBros/hov-router/issues).

<a id="legacy-upstream-distributions-not-wstack-router"></a>

### Legacy upstream distributions (not HoV Router)

The recipes below are retained for upstream users. The `better-ccflare` registry package, `tombii` release downloads, and `ghcr.io/tombii` images install **upstream better-ccflare**, not this branded fork. Their availability and platform coverage are upstream's responsibility. Do not use them to install or update HoV Router.

<details>
<summary>Upstream npm, Bun, and release download recipes</summary>

### Install via npm (Linux x86_64)

```bash
npm install -g better-ccflare

# Start better-ccflare (Server + Dashboard)
better-ccflare
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).

**⚠️ Windows npm Installation Issue**: If you installed via npm on Windows and encounter a path error like `"C:\\Program Files\\nodejs\\\\node_modules\\better-ccflare\\dist\\better-ccflare" is either misspelled or could not be found`, this is a known [npm bug on Windows](https://github.com/npm/cli/issues/969) affecting how npm generates wrapper scripts. See [Windows Troubleshooting](#windows-troubleshooting) for workarounds.
### Install via bun

```bash
bun install -g better-ccflare

# Start better-ccflare (Server + Dashboard)
better-ccflare
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
### Install Pre-compiled Binary (All Architectures)

Download the appropriate binary for your platform from [GitHub Releases](https://github.com/tombii/better-ccflare/releases/latest):

#### Linux x86_64
```bash
wget https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-amd64
chmod +x better-ccflare-linux-amd64
./better-ccflare-linux-amd64
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
#### Linux ARM64 (Raspberry Pi 3/4/5, Oracle Cloud ARM, AWS Graviton)
```bash
wget https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-arm64
chmod +x better-ccflare-linux-arm64
./better-ccflare-linux-arm64
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
#### macOS Intel
```bash
curl -L -o better-ccflare-macos-x86_64 https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-macos-x86_64
chmod +x better-ccflare-macos-x86_64

# Remove quarantine attribute (required on macOS to run unsigned binaries)
xattr -d com.apple.quarantine better-ccflare-macos-x86_64

./better-ccflare-macos-x86_64
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
#### macOS Apple Silicon
```bash
curl -L -o better-ccflare-macos-arm64 https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-macos-arm64
chmod +x better-ccflare-macos-arm64

# Remove quarantine attribute (required on macOS to run unsigned binaries)
xattr -d com.apple.quarantine better-ccflare-macos-arm64

./better-ccflare-macos-arm64
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).

**macOS Gatekeeper Notice:** The upstream macOS binaries are not notarized by Apple as this requires a paid Apple Developer subscription. After downloading, you must remove the quarantine attribute using the `xattr` command shown above to run the binary. If you prefer not to run unsigned binaries, you can [install from source](#install-from-source) instead.

#### Windows x86_64
Download [`better-ccflare-windows-x64.exe`](https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-windows-x64.exe) and run it.
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
### Run without installation (npx/bunx)

```bash
# Run with npx (downloads and executes latest version)
npx better-ccflare@latest

# Run with bunx (faster for bun users)
bunx better-ccflare@latest
```
Continue to [Configure Claude SDK](https://github.com/tombii/better-ccflare#configure-claude-sdk).
</details>

The configuration reference below applies to HoV Router. Both compatibility commands work with the optional release aliases or the source installation.

### Environment Variables

HoV Router supports several environment variables for configuration. The most commonly used ones:

```bash
# Server Configuration
PORT=8080                              # Server port (default: 8080)
BETTER_CCFLARE_HOST=0.0.0.0           # Server binding host (default: 0.0.0.0, use 127.0.0.1 for localhost-only)
CLIENT_ID=your-client-id              # OAuth client ID
BETTER_CCFLARE_CONFIG_PATH=/path/to/config.json  # Custom config location
BETTER_CCFLARE_DB_PATH=/path/to/database.db  # Custom database path (default: ~/.config/better-ccflare/better-ccflare.db)
                                       # Use this for development/testing with a separate database

# Logging and Debugging
LOG_LEVEL=INFO                         # Log level (ERROR, WARN, INFO, DEBUG)
LOG_FORMAT=json                        # Log format (json or text)
better-ccflare_DEBUG=0                  # Enable debug mode (1 for enabled)

# SSL/TLS Configuration
SSL_KEY_PATH=/path/to/key.pem          # SSL private key path (for HTTPS)
SSL_CERT_PATH=/path/to/cert.pem        # SSL certificate path (for HTTPS)

# Load Balancing
LB_STRATEGY=session                    # Load balancing strategy (default: session)
SESSION_DURATION_MS=18000000           # Session duration in milliseconds (5 hours)

# Retry Configuration
RETRY_ATTEMPTS=3                       # Number of retry attempts
RETRY_DELAY_MS=1000                   # Initial retry delay in milliseconds
RETRY_BACKOFF=2                        # Retry backoff multiplier

# Storage
STORE_PAYLOADS=false                   # Disable storing request/response bodies (reduces DB size and memory usage)
                                       # Token counts, costs, model, status and timing are still recorded
```

**Security Notes**:
- Use `BETTER_CCFLARE_HOST=127.0.0.1` to bind only to localhost for better security
- Never commit `.env` files containing sensitive values to version control
- Use environment-specific configuration for production deployments

#### Optional private upstream trace context

`PRIVATE_AI_TRACE_ROUTES_JSON` opts exact account UUIDs into correlation headers
for exact initial HTTP origins, only for `openai-compatible` accounts:

```bash
PRIVATE_AI_TRACE_ROUTES_JSON='{"12345678-1234-4234-8234-123456789abc":"https://private.example:8443"}'
```

The example is a placeholder, not an enrolled account. Origins must use canonical
HTTP(S) origin spelling, with no trailing slash, path, credentials, query, or
fragment. Unset, empty, or invalid configuration disables this feature without
logging its values. Other providers and unmatched routes are unchanged.

Each physical HTTP attempt gets a fresh nonzero 16-hex `x-private-ai-attempt-id`,
also used as the outgoing W3C `traceparent` span ID. `x-private-ai-request-id`
retains HoV Router's canonical logical request UUID across retries. A valid incoming
`traceparent` supplies the trace ID and flags; its parent span ID is carried in
`x-private-ai-parent-span-id`. Otherwise, the trace ID is the canonical UUID
without hyphens, with flags `01`. Client-supplied `x-private-ai-*` values are
replaced on opted-in routes. Internal guard IDs and secrets remain stripped.

This propagates context only: HoV Router does not export a span or inspect bodies for
this feature. Matching gates the initial destination, not redirects; existing
redirect behavior is unchanged, so these opaque IDs can follow an upstream
redirect to another origin.

#### Optional public subscription value feed

`GET /api/public/subscription-value` is disabled (`404`) unless the server's
`BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS` environment variable explicitly enrolls
accounts. Its value is a JSON array of at most 16 mappings (16 KiB maximum):

```json
[{"accountId":"<internal-account-id>","accountCreatedAt":1234567890000,"id":"my-weekly-subscription","label":"My weekly subscription"}]
```

These are placeholders, not enrolled accounts. Each mapping must contain exactly
these four fields; duplicate JSON keys are rejected:

| Field | Constraints |
| --- | --- |
| `accountId` | Existing internal account ID; nonempty, no surrounding whitespace or Unicode control characters. Each account may appear once. |
| `accountCreatedAt` | Exact `accounts.created_at` value: a nonnegative safe integer in epoch milliseconds. |
| `id` | Unique public ID, 1–64 ASCII letters, digits, `_` or `-`, starting with a letter or digit. Neither it nor `accountId` may contain the other, ignoring case. Choose it independently; never use an account ID or its hash. |
| `label` | Explicit plain text, 1–80 Unicode code points, no surrounding whitespace, `<`, `>`, Unicode controls, format characters, or line/paragraph separators. Do not copy an account name or infer a plan. |

Read account creation timestamps from the default SQLite database:

```bash
sqlite3 ~/.config/better-ccflare/better-ccflare.db 'SELECT id, created_at FROM accounts;'
```

For PostgreSQL, run the equivalent SQL against the configured database:

```sql
SELECT id, created_at FROM accounts;
```

##### Dashboard-managed roster

Instead of a JSON array, set `BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS=accounts`
once (exactly that string). That environment change needs a server restart.
After it, manage the roster from the dashboard Accounts page with no further
restarts: switch **Public value** on for an account, enter its public label,
and save. Turning the switch off unpublishes it (the label is kept); the edit
action next to a published account changes its label.

- Labels are public and shown on the House of Vibe site. They must follow the
  `label` rules above, must not contain the account name or ID, and must be
  unique among published accounts (case-insensitive).
- At most 16 accounts can be published; a 17th is refused.
- The public `id` is generated (`sub-` plus 16 hex characters), never derived
  from the account name or ID, and stays stable across relabels and
  unpublish/republish.
- Renaming a published account to a name its public label contains is refused
  (`400`); change the label or unpublish first. The feed also fails closed
  (`503`) if a stored label ever contains the account name.
- A replaced account (deleted and re-added, even under the same name) starts
  unpublished and must be published again.
- Publishing and unpublishing take effect on the next request in the process
  that handled the write, and within 5 seconds in any other process sharing the
  database (which the single-instance-per-database deployment model does not
  support anyway). The 16-account cap and label uniqueness are enforced by the
  database write itself. A publish, unpublish, relabel or delete made directly
  in the database is also picked up within 5 seconds.
- Zero published accounts returns `200` with an empty list. The feed response
  shape is unchanged.

The JSON array form above remains supported and unchanged.

In JSON array mode, a replacement account with the same ID is unavailable after the cached response
expires until explicitly enrolled again with its new creation timestamp. Invalid,
duplicate, or missing-generation mappings fail closed. Publication is
all-or-nothing: any failing mapping makes the whole feed return a generic `503`,
with the reason in the server log. An empty array publishes an empty list.

| Status | Meaning |
| --- | --- |
| `200` | Valid, available feed (including an explicitly configured empty list). |
| `404` | Feed disabled, or any other `/api/public` path. |
| `405` | A method other than `GET` on this endpoint; includes `Allow: GET`. |
| `503` | Invalid configuration or unavailable data; the server log records the reason. |

The fixed version-1 projection contains only `schemaVersion`, `valueBasis`,
`windowKey`, `generatedAt`, and `subscriptions`. Each subscription exposes its
public `id` and `label`, `sourceObservedAt`, one `current` window (or null), and up
to eight newest `completed` windows. Window fields are only `startedAt`,
`resetsAt`, `closedAt`, `valueUsd`, `pricingCoverage`, and
`partialFirstObservation`. Timestamps are epoch milliseconds. Account IDs,
providers, token counts, models, utilization, and credentials are never published.
Query parameters cannot select accounts or history; admin routes retain their
authentication requirements.

Values reuse the window ledger's API-equivalent USD pricing, with completed
values persisted and current values calculated at the window's grant-time prices.
This is a counterfactual list-price value, not savings, ROI, subscription cost,
actual bills, or plan capacity. Coverage includes only captured plan-billed
`/v1/messages` traffic. First-observation windows and unpriced traffic make values
partial or lower bounds; zero remains meaningful and missing valuation stays null.
`pricingCoverage: "unknown"` with a numeric `valueUsd` identifies a legacy window
whose unpriced usage was not recorded.
Expired unclosed rows are omitted from `current`, never relabeled completed.
Because historical ledger rows have no account-generation field, rows starting
before the enrolled account's creation are conservatively omitted; this can also
omit a legitimate first-observation window that spans account creation.

`generatedAt` is valuation generation time, not source freshness.
`sourceObservedAt` is the latest usable persisted quota/window observation, or
null; observations up to five seconds ahead of the server clock are tolerated.
Codex observations can arrive through free `wham/usage` introspection polling
(which consumes no model quota) as well as real traffic. An observation's age
alone does not establish an ingestion outage. The server coalesces concurrent
reads and caches the response for up to 60 seconds or until a current window's
reset, whichever is sooner. Within that interval, account, observation, and ledger
changes may not be reflected. A failed refresh returns `503` and never falls back
to an earlier response. Configuration is read from the server environment, so
configuration changes apply on restart.

Codex window values also count Codex CLI, Desktop, and cloud usage that bypasses
the proxy once external Codex sources are configured; see
[External Codex Usage](configuration.md#external-codex-usage) for attribution
rules and exclusions.

At ingress, forward only the exact `GET /api/public/subscription-value` route and
nothing else. Enable API-key authentication before exposing the server: with no
active API key, every admin route is open to anything that reaches it. The server
already serves a cached body for up to 60 seconds, so an edge cache adds nothing.
All responses carry `Cache-Control: no-store`; forward them unchanged.

#### Claude Code background merge policy

This server-owned policy is **off by default**. An operator can enable it with
`CCFLARE_CLAUDE_CODE_BACKGROUND_MERGE_POLICY=true` (or `1`), or the boolean
`"claude_code_background_merge_policy_enabled": true` in the existing server
configuration file. A present environment value takes precedence; every value
other than exactly `true` or `1` disables it. Request headers, message content,
and `metadata.user_id` cannot enable the setting.

For native Claude Code `POST /v1/messages` requests, the gateway recognizes one
complete captured `# Background Session` section in top-level `system`
instructions, including the introduction, scratch-directory guidance, worktree
isolation, Git policy and closing report guidance. Claude Code 2.1.301 renders
that section in standard or lean prose (chosen per model) and in one of three
isolation modes: enter a worktree, configured `isolation: worktree`, or work in
place. All six renders are recognized. Work-in-place renders carry no Git
guidance and so no merge ban; they are forwarded unchanged, with nothing
injected. Only the absolute POSIX
scratch-path slot ending in `.claude/jobs/<job-id>/tmp` may vary, with plain
ASCII path components and no whitespace, control characters or traversal.
Other host templates require an explicit compatibility update. The section
ends at the next genuine top-level heading or EOF, not a nested or quoted
heading. Only its sentence `Never push to main/master, force-push, or merge.`
is replaced with:

> Never push directly to main/master or force-push. You may merge an operator-authorized pull request only after its required checks and review requirements are satisfied. A review-governor stop requires an explicit operator decision; never set operator-only override flags. Any separate session-specific or loop-authority prohibition on merging still applies.

This runs before agent interception and provider dispatch, so native Anthropic,
Codex/Responses, and OpenAI conversion receive the same policy on every attempt.
It preserves the rest of the prompt, text-block metadata, messages, roles, and
tool content. The policy itself leaves disabled and nonmatching requests' raw
bytes intact; ordinary provider conversion still applies. Trusted synthetic
Responses ingress is excluded using the existing internal adapter proof.
Authenticated internal keepalives retain their already-normalized instructions;
a public keepalive header alone cannot grant that exemption. Context admission
recounts the expanded prompt before deciding capacity, without relaxing its
existing activation or estimate-confidence rules.
Foreground/non-Claude requests and isolated occurrences of the sentence are
unchanged. Quoted examples, fenced code, and XML-wrapped content are not edited.

Recognizable background-template drift, duplicate sections/paragraphs, and
templates split across blocks fail before provider dispatch with HTTP **409**,
`error.type: "invalid_request_error"`, and
`error.code: "claude_code_background_merge_policy_incompatible"`. This also applies
to streaming ingress; the rejection is JSON. The error contains no prompt text
or credentials, and the policy adds no prompt logging. Claude Code shows it as
`API Error: 409 The Claude Code background template is incompatible with the
configured merge policy`, and the session keeps failing on every retry until
the gateway recognizes its template. An operator must review
the changed host template and update the recognized fixtures before re-enabling
compatibility; the gateway does not strip instructions or silently fall back to
the conflicting directive.

Enable this only for a gateway whose clients' top-level system instructions you
trust. The Claude Code user-agent identifies the client format, not authenticated
host provenance. There is no independent background-session marker: if a future
host removes every recognizable section/paragraph marker, the gateway cannot
distinguish it from foreground instructions. This policy neither grants merge
authorization nor changes repository hooks, review gates, or session authority.
Offline payload tests establish delivery and preservation, not model compliance.
The [2026-10-03 rollout](https://github.com/StartupBros-com/better-ccflare/pull/414)
also verified the live compatibility rejection and a fresh, no-tool,
Codex-routed background session reporting that authorized PR merges were
conditionally permitted. These smoke checks did not execute a merge and do not
establish general model compliance or coverage for traffic bypassing the gateway.

#### Server-tool admission and replay key file (Linux operators)

Hosted web-search requests are always classified and admitted through exact typed capability proofs; there is no activation flag or permissive passthrough mode. Invalid requirements, incapable providers, and unavailable request-private replay fail locally before provider I/O. Requests without server tools retain the ordinary routing path and do not access replay storage. `CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE` prepares the replay codec required by capable server-tool candidates; it does **not** broaden provider capability. On Linux, set it to a normalized absolute path whose components are not symlinks. The loader pins each path component by descriptor, while the target must be a regular, single-link file owned by the service process UID with mode `0400` or `0600`; group/world-readable files fail closed. Ancestor ownership is not used as an authorization signal, so use an administrator-controlled directory even though the final-inode checks remain the enforcement boundary. Put only the path in the environment, never key material.

The file is versioned JSON with exactly one `active` record matching `activeKeyId`. `retained` records remain decrypt-only readers during normal rotation, while a `revoked` record names a deliberately unusable key and omits its material. Usable keys are exactly 32 bytes encoded as canonical, unpadded base64url (43 characters). IDs must be stable, unique, and match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; decoded key material must also be unique across usable records. Array order never selects the writer because `activeKeyId` does. Duplicate JSON member names fail closed. This template contains fake placeholders and will be rejected until they are replaced with independently generated keys:

```json
{
  "version": 1,
  "activeKeyId": "key-2026-08",
  "keys": [
    {
      "id": "key-2026-08",
      "status": "active",
      "key": "<fake-43-character-unpadded-base64url-key>"
    },
    {
      "id": "key-2026-07",
      "status": "retained",
      "key": "<fake-43-character-unpadded-base64url-key>"
    },
    { "id": "key-compromised", "status": "revoked" }
  ]
}
```

Protect the live file and make a protected backup without printing either file. Restore the backup to a separate regular file, then inspect every path component and verify ownership, mode, link count, and byte equality:

```bash
replay_file=/etc/better-ccflare/server-tool-replay-keys.json
backup_file=/secure/offline-backups/server-tool-replay-keys.v1.json
restore_file=/etc/better-ccflare/server-tool-replay-keys.restore-test.json

sudo chown <service-user>:<service-group> "$replay_file"
sudo chmod 0600 "$replay_file"
sudo namei -l "$replay_file"
sudo stat -Lc 'owner=%U mode=%a links=%h type=%F' "$replay_file"
sudo install -o root -g root -m 0600 "$replay_file" "$backup_file"
sudo install -o <service-user> -g <service-group> -m 0600 "$backup_file" "$restore_file"
sudo namei -l "$restore_file"
sudo stat -Lc 'owner=%U mode=%a links=%h type=%F' "$restore_file"
sudo cmp --silent "$replay_file" "$restore_file"
```

The reader wire contract is the six-segment `bccf2.A256GCM.<kid>.<sloc>.<nonce>.<ciphertext-and-tag>` format. The opaque 16-byte/22-character `<sloc>` is the truncated HMAC-SHA256 of canonical common source identity, using a separately HKDF-derived locator key. Its inputs are protocol/suite, tool, audience, lineage, call, query digest, result state, source ordinal, and ordered source URL/title/nullable page age; citation text/linkage/ordinal, provider/model/fidelity, time, nonce, and wire key ID are excluded so a source and its citations share one locator. History maps `(kid, sloc)` to one exact prior source before its single AES decrypt, including when URL/title values repeat; full authenticated data still binds envelope kind (`source` or `citation`) and exact context, ordering, linkage, and visible evidence. Every old or unknown `bccf*` token is locally invalid and is never forwarded as native Anthropic state. The earlier `bccf1` draft never shipped and writer admission never existed, so carrying a compatibility reader would add ambiguity without preserving any production history.

Before any writer can be enabled, deploy decoder-compatible readers and the identical keyring everywhere with admission off. U2 installs only these readers and keeps writer admission disabled until the later fixture, automated, rollout, and canary gates pass. Validate the restored file in a clean reader, including decoding a pre-rotation envelope. For normal rotation, write and protect a complete new file, atomically rename it into place, and restart; never rewrite the live inode in place. Make the new ID explicitly active, retain the prior key through the documented conversation drain, and keep both old and new decoders during deployment. First rollback disables new admission but leaves replay/history readers and required retained keys in place; never roll back below that decoder-compatible floor. Compromised-key revocation is a separate incident action that may intentionally break affected history.

Writers remain unavailable without trustworthy aggregate, per-key-material fleet issuance telemetry. Key identity and its counter are independent of wire version, so changing the protocol cannot reset the budget for reused AES key bytes. Rotate and stop issuance at `2^31` envelopes per key material and keep the hard operational budget below `2^32`. These are operational limits for probabilistic nonce uniqueness, not an atomic cross-process guarantee.

📖 **See [docs/configuration.md](configuration.md) for the complete list** — overload/rate-limit retry tuning, health endpoint detail, agent discovery, payload encryption at rest, model catalog refresh, PostgreSQL pooling, Codex prompt-cache keys, and more.

### Using .env Files

HoV Router automatically supports `.env` files for easy configuration management. You can create a `.env` file in your project directory:

```bash
# Copy the example .env file
cp .env.example .env
# Edit with your configuration
nano .env
```

**Supported across all deployment methods**:
- **CLI Binary**: Automatically loads `.env` from current working directory
- **Docker Compose**: Automatically loads `.env` from the same directory as `docker-compose.yml`
- **Docker**: Mount your `.env` file or pass variables directly

**Example `.env` file**:
```bash
# Server Configuration
PORT=8080

# SSL/TLS Configuration (optional)
SSL_KEY_PATH=/path/to/ssl/key.pem
SSL_CERT_PATH=/path/to/ssl/cert.pem

# Load Balancing
LB_STRATEGY=session

# Logging and Debugging
LOG_LEVEL=INFO
LOG_FORMAT=pretty

# Database configuration
DATA_RETENTION_DAYS=3
REQUEST_RETENTION_DAYS=90

# Storage (set to false to skip storing request/response bodies, reducing DB size and memory pressure)
STORE_PAYLOADS=true
```

**Usage with different deployment methods**:
```bash
# CLI (binary or local development)
hov-router --serve

# Docker Compose (place .env alongside docker-compose.yml)
docker-compose up

# Docker (mount .env file)
docker run -v $(pwd)/.env:/app/.env:ro -p 8080:8080 ghcr.io/tombii/better-ccflare:latest
```

<a id="docker-legacy-upstream-images-not-wstack-router"></a>

### Docker (legacy upstream images, not HoV Router)

All `ghcr.io/tombii/better-ccflare` recipes here, including the `.env` and Traefik examples, run upstream images. The checked-in Docker Compose behavior is unchanged; no branded image is available from this change.

```bash
# Quick start with docker-compose
curl -O https://raw.githubusercontent.com/tombii/better-ccflare/main/docker-compose.yml

# Optional: Create and configure .env file
cp .env.example .env
# Edit .env with your settings (SSL, port, etc.)
nano .env

# Start with docker-compose (automatically loads .env file)
docker-compose up -d

# Or use docker run with environment variables
docker run -d \
  --name better-ccflare \
  -p 8080:8080 \
  -v better-ccflare-data:/data \
  -e SSL_KEY_PATH=/path/to/ssl/key.pem \
  -e SSL_CERT_PATH=/path/to/ssl/cert.pem \
  ghcr.io/tombii/better-ccflare:latest

# View logs
docker logs -f better-ccflare
```

Once the container is running, **open http://localhost:8080 in your browser** to add and manage accounts through the Web UI. This is the recommended way — using `docker exec` to run CLI commands inside the container won't work for OAuth-based account modes since the container has no browser.

**🆕 Environment Variable Support**: Docker Compose now automatically loads `.env` files from the same directory as `docker-compose.yml`. Simply create a `.env` file alongside your `docker-compose.yml` file and the container will use those settings.

**Available Docker tags:**
- `latest` - Latest stable release
- `main` - Latest build from main branch
- `1.2.28`, `1.2`, `1` - Specific version tags
- `sha-abc123` - Commit-specific tags

See [DOCKER.md](../DOCKER.md) for detailed Docker documentation.

### Systemd Deployment

For running HoV Router as a native systemd service on Linux (without Docker), see the [Systemd Deployment Guide](systemd.md). It covers unit file configuration, memory management with `--smol`, restart policies, and a preflight script that prevents `BUN_JSC_*` environment variable crashes. Existing service and executable paths keep their names.

## Configure Claude SDK

**Connecting to an existing Router?** Begin with [shared-client setup](agent-setup.md#shared-client-only), including the owner-confirmed origin, private reachability, and authentication requirements. Substitute that origin for localhost in the examples below. Shared clients do not install Router, create accounts, log in to providers, or change routing/server lifecycle. Tailnet membership is not Router authentication. Keep saved settings and the current Claude Code login intact unless the human explicitly chooses an authentication change; prefer session-scoped configuration. If dashboard access requires admin privileges, ask the owner to verify the request rather than distribute an admin key to an inference client.

### Option 1: Using Claude CLI with OAuth (Recommended if you have Claude Pro/Team)

If you have a Claude Pro or Team subscription and are logged into Claude CLI, this preserves that login for a Router without API-key authentication. It does **not** bypass a protected Router's key requirement; use Option 2 only after agreeing on any client authentication change.

```bash
# Set only the base URL - no API key needed!
export ANTHROPIC_BASE_URL=http://localhost:8080

# New hosts: configure accounts in the dashboard; shared clients reuse existing routing

# Start Claude CLI (uses your existing login)
claude
```

**Important:** When using Claude CLI with an active OAuth login, do **NOT** set `ANTHROPIC_AUTH_TOKEN`. Setting both will trigger a warning from Claude CLI about conflicting authentication methods.

### Option 2: Using API Key Authentication

If you're NOT using Claude CLI's OAuth login, or explicitly choose API key authentication:

**Before logout:** this changes a working login. Agree with the human on the switch and restoration first; do not run the logout step blindly. For a shared Router, obtain an inference-scoped Router key privately from its owner; do not generate one in a local database. Provider credentials are not Router keys. Never paste actual keys into chat or captured logs; the token below is a placeholder, not an invitation to record a real secret in shell history. Unprotected access is for an isolated local setup, not a shared-server recommendation.

```bash
# Only after agreeing to switch; skip if already logged out
claude /logout

# Then set both the base URL and API key
export ANTHROPIC_BASE_URL=http://localhost:8080

# If Router has NO API keys configured (open access):
export ANTHROPIC_AUTH_TOKEN=dummy-key

# If Router HAS API keys configured (protected):
# New-host owner only: hov-router --generate-api-key "My VPS"
# Shared clients: obtain an inference key privately from the existing owner
export ANTHROPIC_AUTH_TOKEN=btr-abcdef1234567890...  # Use your real Router API key

# New hosts: configure accounts in the dashboard; shared clients reuse existing routing

# Start Claude CLI
claude
```

### Option 3: Remote/Headless VPS Setup (Secure Proxy)

Use HoV Router on a trusted server to keep provider OAuth credentials off temporary clients. If that server already exists, follow [shared-client setup](agent-setup.md#shared-client-only) and **skip the server commands below**. Use the owner-approved Tailscale origin or other private endpoint; do not discover servers by scanning or change their exposure. The client still holds a sensitive Router credential, so untrusted machines can steal it.

**On a new trusted host only, by its owner:** use isolated state and the same paths for all commands as described in [agent setup](agent-setup.md#3-open-the-right-dashboard). Before remote exposure, establish Router authentication and approved private network access. The first active key is admin: keep it with the owner and create a separate inference-scoped key for clients using the dashboard's API Keys controls. Do not share the first admin key as a client credential.

The following are server-owner operations, not instructions to run on each client:

```bash
# Add your Claude account with OAuth
hov-router --add-account myaccount --mode claude-oauth --priority 0

# Bootstrap authentication privately; the first key is admin and stays with the owner
hov-router --generate-api-key "Server owner"

# Start privately; remote binding/exposure is a separate owner-approved step
BETTER_CCFLARE_HOST=127.0.0.1 hov-router --serve
```

**On the client/VPS:** first apply Option 2's authentication-conflict and secret-handling precautions. Preserve any existing login until the human chooses the change. Replace the sample origin with the owner's confirmed origin and supply the inference key privately; do not run account or server commands here.

```bash
# Set the confirmed Router URL and API key
export ANTHROPIC_BASE_URL=https://your-server.com:8080
export ANTHROPIC_AUTH_TOKEN=btr-abcdef1234567890...  # Your Router API key

# Start Claude CLI with the agreed Router authentication
claude
```

**How it works:**
- Claude Code CLI sends requests with your Router API key
- HoV Router validates the API key and proxies requests using its stored OAuth credentials
- Your OAuth credentials stay secure on your trusted server
- Clients hold a Router key, not the server's provider OAuth credentials; protect that key too

Verify with a real interactive Claude Code request and a matching **Requests** entry, following [request verification](agent-setup.md#5-connect-claude-code-and-prove-the-route). If dashboard access is restricted, get owner-assisted evidence; until then route verification is pending. Do not issue admin keys merely for this check or use raw scripted Anthropic inference.

### Which method should I use?

- **Already have a shared Router?** Use [shared-client setup](agent-setup.md#shared-client-only) before choosing client authentication; skip server setup
- **Have Claude Pro/Team and an isolated local Router without API-key authentication?** Use Option 1 to preserve OAuth login
- **Working on a temporary client?** Use Option 3, keeping the Router key private and provider credentials on the server
- **Router requires a key, or choosing API-key authentication?** Use Option 2 after agreeing on any login change
- **Getting auth conflict warnings?** You have both methods active - choose one and follow its steps above

### Codex CLI as a Client

HoV Router supports [Codex CLI](https://github.com/openai/codex) as a client. Codex speaks the OpenAI Responses API; HoV Router intercepts requests to `/v1/responses` and `/v1/responses/compact` and translates them to Anthropic `POST /v1/messages` internally, routing through your configured account pool.

Configure Codex CLI to point at HoV Router in `~/.codex/config.toml`:

```toml
openai_base_url = "http://127.0.0.1:8080/v1"
```

Note: use `127.0.0.1` instead of `localhost` — Codex CLI has a known issue where `localhost` resolves to IPv6 first and causes connection failures. The `/v1` suffix is required; Codex appends `/responses` to the base URL.

Or via environment variables:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy-key
```

Codex CLI requires an API key to start — use `dummy-key` if Router API key authentication is not enabled, or your real Router API key if it is.

Known limitations:

- `previous_response_id` is accepted but ignored — Codex uses this only over WebSocket; for regular HTTP requests it always sends the full conversation history in `input`
- Built-in tool types (`web_search_preview`, `code_interpreter`, `file_search`) are silently skipped; only `type: "function"` tools are forwarded to Anthropic
- Claude OAuth accounts (Claude Pro/Team, `provider=anthropic` with OAuth tokens) are automatically excluded from Codex CLI traffic — Anthropic bans these when used outside Claude CLI. Anthropic API key accounts are fine and will be used normally.

### SSL/HTTPS Configuration

To enable HTTPS with HoV Router, you'll need SSL certificates. Here are your options:

#### Option 1: Generate Self-Signed Certificates (Development/Local Use)

```bash
# Generate a self-signed certificate on the Router host
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=yourhostname"

# Start HoV Router with SSL
export SSL_KEY_PATH=/path/to/key.pem
export SSL_CERT_PATH=/path/to/cert.pem
hov-router

# Or use command line flags
hov-router --ssl-key /path/to/key.pem --ssl-cert /path/to/cert.pem
```

**Trust the self-signed certificate on client machines:**

For self-signed certificates, you need to add the certificate to your system's trusted certificates:

- **Linux (Ubuntu/Debian):**
  ```bash
  # Copy cert.pem from the Router host to your client machine
  sudo cp cert.pem /usr/local/share/ca-certificates/better-ccflare.crt
  sudo update-ca-certificates
  ```

- **Linux (Arch/Manjaro):**
  ```bash
  # Copy cert.pem from the Router host to your client machine
  sudo cp cert.pem /etc/ca-certificates/trust-source/anchors/better-ccflare.crt
  sudo trust extract-compat
  ```

- **macOS:**
  ```bash
  # Copy cert.pem from the Router host to your client machine
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain cert.pem
  ```

- **Windows (PowerShell as Administrator):**
  ```powershell
  # Copy cert.pem from the Router host to your client machine
  Import-Certificate -FilePath cert.pem -CertStoreLocation Cert:\LocalMachine\Root
  ```

**Configure Claude Code to use the trusted certificate:**

After adding the certificate to your system's trusted store, configure your environment:

```bash
# Add to your ~/.bashrc or ~/.zshrc
export NODE_OPTIONS="--use-system-ca"
export ANTHROPIC_BASE_URL=https://yourhostname:8080
```

The `NODE_OPTIONS="--use-system-ca"` is **required** for Claude Code and other Node.js-based clients to use the system certificate store. Without this, Node.js will not trust your self-signed certificate even if it's in the system store.

#### Option 2: Use Production Certificates (Production/Remote Access)

If you're running HoV Router on a server with a domain name, use Let's Encrypt or your certificate provider:

```bash
# Using Let's Encrypt certificates
export SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
export SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
hov-router

# Set the base URL to use HTTPS
export ANTHROPIC_BASE_URL=https://yourdomain.com:8080
```

With production certificates from trusted CAs, you don't need `NODE_OPTIONS="--use-system-ca"` as they are already trusted.

#### Option 3: Docker with Traefik (Recommended for Production)

For Docker deployments, we recommend using [Traefik](https://traefik.io/) as a reverse proxy to handle TLS automatically with Let's Encrypt:

```yaml
# docker-compose.yml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.myresolver.acme.tlschallenge=true"
      - "--certificatesresolvers.myresolver.acme.email=your-email@example.com"
      - "--certificatesresolvers.myresolver.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    restart: unless-stopped

  better-ccflare:
    image: ghcr.io/tombii/better-ccflare:latest
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.ccflare.rule=Host(`your-domain.com`)"
      - "traefik.http.routers.ccflare.entrypoints=websecure"
      - "traefik.http.routers.ccflare.tls.certresolver=myresolver"
      - "traefik.http.services.ccflare.loadbalancer.server.port=8080"
    volumes:
      - ~/.config/better-ccflare:/root/.config/better-ccflare
    restart: unless-stopped
```

**Benefits:**
- Automatic TLS certificate generation and renewal via Let's Encrypt
- No need to manually manage SSL certificates
- Built-in HTTP to HTTPS redirection
- Dashboard for monitoring (port 8080 on Traefik)

**Client Configuration:**
```bash
export ANTHROPIC_BASE_URL=https://your-domain.com
```

No `NODE_OPTIONS` needed - Traefik provides trusted certificates automatically!

#### Troubleshooting SSL Issues

**Problem:** "Unable to connect to API due to poor internet connection" error even with `ANTHROPIC_BASE_URL` set

**Solutions:**
1. Verify the environment variable is set in the same shell/session:
   ```bash
   echo $ANTHROPIC_BASE_URL
   echo $NODE_OPTIONS
   ```

2. Test the SSL connection manually:
   ```bash
   # Should succeed without errors
   curl https://yourhostname:8080/health

   # If you see certificate errors, the cert isn't trusted yet
   curl -k https://yourhostname:8080/health  # -k bypasses cert check for testing
   ```

3. Verify the certificate is in the system store:
   ```bash
   # Linux
   ls -la /etc/ssl/certs/ | grep better-ccflare

   # macOS
   security find-certificate -a -c yourhostname -p /Library/Keychains/System.keychain
   ```

4. Ensure the hostname resolves correctly:
   ```bash
   ping yourhostname
   ```

5. Check that the server is actually running:
   ```bash
   curl -k https://yourhostname:8080/health
   ```

## Windows Troubleshooting

These workarounds concern the legacy upstream npm package and release binaries, not a HoV Router distribution. For this fork, use the source quickstart in WSL; native Windows installation has not been verified here.

### Issue: "Command is misspelled or could not be found" after npm install

If you installed better-ccflare via npm on Windows and encounter an error like:

```
The command "C:\Program Files\nodejs\\node_modules\better-ccflare\dist\better-ccflare" is either
misspelled or could not be found.
```

This is a **known npm bug on Windows** (see [npm/cli#969](https://github.com/npm/cli/issues/969) and [nodejs/node#39010](https://github.com/nodejs/node/issues/39010)) affecting how npm generates wrapper scripts with double backslashes in paths.

### Workarounds

**Option 1: Use `npx` (Recommended)**

```powershell
npx better-ccflare
```

This bypasses the npm wrapper script entirely and runs better-ccflare directly.

**Option 2: Use the Pre-compiled Binary**

Download the standalone Windows executable from [GitHub Releases](https://github.com/tombii/better-ccflare/releases/latest):

```powershell
# Download better-ccflare-windows-x64.exe and run it directly
.\better-ccflare-windows-x64.exe
```

**Option 3: Update npm**

Sometimes updating to the latest npm version fixes the issue:

```powershell
npm install -g npm@latest
npm install -g better-ccflare
```

**Option 4: Direct Execution**

If you need to use the npm-installed version, you can execute the binary directly:

```powershell
node "%APPDATA%\npm\node_modules\better-ccflare\dist\better-ccflare"
```

**Option 5: Use Bun Package Manager**

Bun doesn't have this bug and works correctly on Windows:

```powershell
# Install bun from https://bun.sh
bun install -g better-ccflare
better-ccflare
```

### Root Cause

This issue is caused by a bug in npm's wrapper script generation on Windows, where it incorrectly constructs paths with double backslashes (`\\nodejs\\\\node_modules`). This is a longstanding npm bug that affects many CLI packages, not just better-ccflare.

The issue is being tracked in:
- [npm/cli#969](https://github.com/npm/cli/issues/969) - Generated .cmd script bugs
- [nodejs/node#39010](https://github.com/nodejs/node/issues/39010) - Double slashes in Windows paths

We recommend using one of the workarounds above until the npm bug is fixed.

## Features

### Intelligent Load Balancing
- **Session-based** - Maintain conversation context for Claude OAuth accounts (5hr usage windows), pay-as-you-go for other providers
- **Auto-fallback** - Automatically switch back to higher priority Claude OAuth accounts when their usage windows reset
- **Auto-refresh** - Automatically start new usage windows when they reset
- **Usage Window Alignment** - Sessions automatically align with Claude OAuth usage window resets for optimal resource utilization
- **Usage Throttling** - Configurable monthly token/cost limits per account with peak-hours auto-pause for Zai accounts
- **503 on Pool Exhaustion** - Returns HTTP 503 when all accounts are rate-limited or paused, enabling client-side retry logic
- **Rate Limit Audit Trail** - Tracks when and why each account became rate-limited (`rate_limited_reason`, `rate_limited_at`)

### Combos — Managed Family Routing
- **Four Independent Families** - Assign one combo to Fable, Opus, Sonnet, or Haiku without changing the other families
- **Manual and Managed Membership** - Keep precise account/model slots, or safely enroll compatible accounts by provider and route class without mixing billing lanes
- **Priority-Aware Balancing** - Manual slots retain their persisted tier; Managed members use global account priority, with same-tier pressure and session/cache affinity
- **Safe Precedence** - Manual overrides and account exclusions win over Managed rules, while unknown or unsupported capabilities fail closed
- **Operational Resilience** - Paused, limited, exhausted, or reauth-required accounts remain members but are skipped until available
- **Reviewable Changes** - Server-owned preview/apply shows exact member deltas, rejects zero-candidate Managed routes, and supports non-destructive rollback to Manual
- **Dashboard and CLI Parity** - Inspect the same authoritative effective route from the dashboard, live-server CLI workflow, or management API

See [Combos and Managed Family Routing](combos.md) for routing semantics and rollout guidance, and [CLI documentation](cli.md#managed-routing-live-server) for command-line operations.

The shipped live-server CLI surface is:

```bash
hov-router routing list [--api-url <loopback-url>] [--json]
hov-router routing detail <account-id> [--api-url <loopback-url>] [--json]
hov-router routing preview <family> [--managed-model <model>] [--api-url <loopback-url>] [--json]
hov-router routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes [--api-url <loopback-url>] [--json]
hov-router routing manual <family> --yes [--api-url <loopback-url>] [--json]
```

Interactive apply can preview, show exact deltas, require an explicit proposal selection, and confirm before writing. Unattended or JSON apply requires the complete displayed tuple plus `--yes`; Manual rollback requires `--yes`. The admin key is accepted only through `BETTER_CCFLARE_ADMIN_API_KEY`. Interactive account creation reviews routing by the persisted immutable account ID, then freshly previews, displays, confirms, and applies each selected family in sequence. Missing or materially changed proposals fail closed, and any already-applied family results are reported as partial rather than hidden or rolled back. `--add-account --json` is rejected before creation; non-TTY text creation prints the immutable ID and follow-up commands without previewing or changing routing. Routing commands continue to support `--json`.

### Real-Time Analytics
- Token usage tracking per request with optimized batch processing
- Response time monitoring with intelligent caching
- Rate limit detection and warnings
- Cost estimation and budgeting
- Request deduplication for improved performance
- Lazy-loaded analytics components for faster initial load
- Advanced filtering by accounts, models, API keys, and request status
- API key performance tracking and detailed analytics

### Service-Lifetime Cohort Seal

- **Opt-in cache evidence** - Eligible official-xAI cache-flight observations can carry privacy-safe provenance for the service/profile occurrence and its concurrent serving-account plus route/model partition
- **Descriptive operator reports** - Human and JSON recorder reports show cohort boundaries, blockers, contributors, and safe within-cohort subsets without changing routing, native cache, keepalive, or provider behavior

See [Service-Lifetime Cohort Seal configuration and operator guidance](configuration.md#service-lifetime-cohort-seal) for activation, report and health commands, retention, privacy, and the mandatory pre-transport runtime-safety gate.

### Developer Tools
- CLI (`hov-router`, with `wstack-router` and `better-ccflare` compatibility)
- Web dashboard (`http://localhost:8080/dashboard`)
- CLI for account management
- REST API for automation
- `--doctor` command for database integrity checks and telemetry
- Reasoning effort compatibility layer for OpenAI/Codex routes (downgrade mapping, `count_tokens` support)
- `/health` endpoint with three-state pool status (`healthy`/`degraded`/`unhealthy`), 503 on degraded/unhealthy, optional `?detail=1` behind `HEALTH_DETAIL_ENABLED`

### Production Ready
- Automatic failover between accounts
- OAuth token refresh handling
- SQLite database for persistence
- Configurable retry logic
- Custom endpoint support for enterprise deployments
- Enhanced performance with request batching and caching
- Outbound forward proxy support (`BETTER_CCFLARE_OUTBOUND_PROXY`) for enterprise TLS-intercepting egress gateways, with loopback destinations always exempt

### Multi-Provider Support
- **Claude OAuth** - Anthropic OAuth accounts with 5-hour usage windows and session tracking (rate limit window based)
- **Claude Console API** - Anthropic API key accounts with pay-as-you-go model (no session tracking)
- **AWS Bedrock** - Native AWS Bedrock integration with SigV4 authentication, inference profile support (geographic/global/regional), and automatic credential chain resolution via AWS CLI profiles
- **Vertex AI** - Google Cloud Vertex AI integration with service account authentication
- **z.ai** - API key based provider with pay-as-you-go model
- **Minimax** - API key based provider with pay-as-you-go model and Token Plan usage polling (utilization tracking for `general` model-class quota)
- **DeepSeek** - Native Anthropic-compatible API at `https://api.deepseek.com`, using API-key authentication. Claude request model IDs pass through for DeepSeek's server-side family remapping; `deepseek-v4-flash` is a response usage/cost-attribution fallback when DeepSeek omits the response model; it does not rewrite outbound request model.
- **OpenRouter** - OpenRouter integration with native API support and model mapping
- **xAI/Grok** - Native Grok CLI OAuth import/refresh with per-request token accounting and Grok Build credits usage polling via grok.com gRPC-web
- **Kilo** - Kilo API integration with usage tracking
- **Meta Model API (`meta`; legacy `muse-spark` HTTP ingress compatibility)** - Meta's Muse Spark models (1M-token context) over the Anthropic Messages API at `https://api.meta.ai`, with bearer-token auth, automatic model mapping to `muse-spark-1.2`, and request normalization for Meta's strict field validation
- **Anthropic-Compatible** - Custom Anthropic-compatible providers with pay-as-you-go model
- **Ollama** - Local Ollama instance (v0.14.0+) via native Anthropic-compatible API at `/v1/messages`, no API key required
- **OpenAI-Compatible** - OpenAI-compatible providers (Together AI, etc.) with Claude API format
- **Universal API Format** - Use OpenAI-compatible providers with Claude API format
- **Automatic Format Conversion** - Seamless conversion between Anthropic and OpenAI request/response formats
- **Model Mapping** - Map Claude models (Opus, Sonnet, Haiku) to equivalent OpenAI models
- **Model Fallbacks** - Automatically retry with a fallback model when the requested model is unavailable (e.g., fallback from Opus to Sonnet on Pro subscriptions)
- **Streaming Support** - Full support for streaming responses from OpenAI-compatible providers
- **API Key Authentication** - Secure API key management for OpenAI-compatible providers
- **Cost Tracking** - Automatic cost calculation for usage monitoring and budgeting

### Codex Messages-Lane Continuation (Opt-In, Off by Default)
Lets the Codex provider retain server-owned Responses continuation (`previous_response_id`) while serving Anthropic `/v1/messages` clients, instead of replaying the full translated conversation history on every turn.
- **Off by default** — set `CCFLARE_CODEX_MESSAGES_CONTINUATION=1` to enable. Unset, behavior is unchanged from full-history replay.
- **Optional model allowlist** — `CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS` restricts the bridge to an exact, comma-separated list of resolved model names; unset enables all models (when the switch above is on), an empty string enables none.
- **Gated on real continuity evidence** — only admitted when the request carries an authenticated API key, a selected account, and a nonempty prompt cache key; state is partitioned by account, model, authenticated caller, session, and protocol, so a Messages-lane checkpoint can never leak into native `/v1/responses` traffic (or vice versa) even for an identical account/model/caller/session.
- **Fails safe, not silent** — an ambiguous, failed, expired, or cancelled turn never creates or reuses a checkpoint; a suspended chain (30-minute TTL) or a rejected `previous_response_id` (upstream `previous_response_not_found` / `invalid_previous_response_id`) triggers a one-time repair that drains the rejected response, retires the checkpoint, and resends full history on the same account and model rather than looping.
- **Never changes routing** — the switch only affects whether Codex replays full history or extends a continuation chain; it never changes model selection, fallback policy, or `store:false` semantics.

See [Environment Variables](configuration.md#additional-environment-variables) for the exact env var reference.

## Troubleshooting Database Issues

If you encounter "All accounts failed" errors, the database runs integrity checks automatically on startup and will guide you to repair if needed. You can also manually run:

```bash
bun run cli --repair-db
```

This will check integrity, fix NULL values, validate constraints, and optimize the database. See the [Troubleshooting Guide](troubleshooting.md#database-corruption-or-integrity-errors) for more details.

## Documentation

Full documentation available in [the documentation index](index.md):
- [Getting Started](index.md)
- [CLI Commands](cli.md)
- [Troubleshooting](troubleshooting.md)
- [Architecture](architecture.md)
- [API Reference](api-http.md)
- [Configuration](configuration.md)
- [Account Routing Architecture](routing-architecture.md)
- [Load Balancing Strategies](load-balancing.md)
- [Auto-Fallback Guide](auto-fallback.md)
- [Auto-Refresh Guide](auto-refresh.md)
- [OpenAI-Compatible Providers](providers.md)
- [Combos — Fallback Chains](combos.md)

## Screenshots

<table>
  <tr>
    <td><img src="../apps/lander/src/screenshot-dashboard.png" alt="Dashboard"/></td>
    <td><img src="../apps/lander/src/screenshot-logs.png" alt="Logs"/></td>
  </tr>
  <tr>
    <td align="center"><b>Real-time Dashboard</b></td>
    <td align="center"><b>Request Logs</b></td>
  </tr>
  <tr>
    <td colspan="2"><img src="../apps/lander/src/screenshot-analytics.png" alt="Analytics"/></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><b>Analytics & Usage Tracking</b></td>
  </tr>
</table>

## Requirements

**For HoV Router installation:** use the [Linux x86_64 release prerequisites](#install-the-linux-x86_64-release) or the [source-build requirements](#install-from-source). No Router npm package or container image is published.

**For the retained legacy upstream installation recipes:**
- **npm** or **bun** package manager (for npm/bun installation)
- **Node.js** >= 18.0.0 (when installed via npm)
- **Bun** >= 1.2.8 (when installed via bun or running from source)
- **Or download pre-compiled binary** - No runtime dependencies required!

**For usage:**
- Claude API accounts (Free, Pro, or Team), z.ai code plan accounts, or Minimax accounts

## Platform Support

The historical wstack Router 3.6.2 release provides a **Linux x86_64 binary only**. No Router Linux ARM64, macOS, or native Windows binary is published. The [source-build path](#install-from-source) remains available; its acceptance check runs on Linux x86_64, not macOS or native Windows.

The table and device list below describe the retained **upstream distribution** recipes, not HoV Router artifacts.

| Platform | Architecture | Status |
|----------|-------------|--------|
| Linux | x86_64 | ✅ Supported (npm + binary) |
| Linux | ARM64 (aarch64) | ✅ Supported (binary only) |
| macOS | Intel (x64) | ✅ Supported (npm + binary) |
| macOS | Apple Silicon (ARM64) | ✅ Supported (binary only) |
| Windows | x86_64 | ✅ Supported (binary only) |

**Upstream device coverage:**
- Oracle Cloud ARM instances (Ampere Altra)
- AWS Graviton instances
- Raspberry Pi 3/4/5 (with 64-bit OS)
- Any x86_64 or ARM64 Linux/macOS/Windows system

**Not supported:**
- ARM32 devices (Raspberry Pi Zero, Pi 1, Pi 2, or 32-bit OS)


## Source checkout reference

The following commands run from the repository root.

### Project Structure

```
better-ccflare/
├── apps/               # Application packages
│   ├── server/        # Main proxy server
│   ├── cli/           # CLI application
│   └── lander/        # Landing page
├── packages/          # Core packages
│   ├── core/          # Core business logic
│   ├── cli-commands/  # CLI command implementations
│   ├── database/      # SQLite database layer
│   ├── dashboard-web/ # Web dashboard UI
│   ├── http-api/      # REST API handlers
│   ├── load-balancer/ # Load balancing strategies
│   ├── logger/        # Logging utilities
│   ├── providers/     # OAuth provider system
│   └── proxy/         # HTTP proxy implementation
└── docs/              # Documentation

```

## Scripts Reference

```bash
# Main commands
bun run cli            # Start CLI (builds dashboard first)
bun run server         # Start server only
bun run start          # Alias for bun run server

# Development
bun run dev            # Start CLI in development mode
bun run dev:server     # Server with hot reload
bun run dev:dashboard  # Dashboard development

# Build & Quality
bun run build          # Build dashboard and CLI
bun run build:dashboard # Build web dashboard
bun run build:cli      # Build CLI
bun run build:lander   # Build landing page
bun run typecheck      # Check TypeScript types
bun run lint           # Fix linting issues
bun run format         # Format code
```

## CLI Commands

The HoV Router CLI provides a command-line interface for management and monitoring:

```bash
# If running without global install, use the full path:
bun run apps/cli/src/main.ts [command]

# Account management
bun run apps/cli/src/main.ts --add-account <name> --mode <ACCOUNT_MODE> --priority <number> --api-url http://127.0.0.1:8080  # Add account; modes: see CLI Commands
bun run apps/cli/src/main.ts --list                   # List accounts
bun run apps/cli/src/main.ts --remove <name>          # Remove account
bun run apps/cli/src/main.ts --pause <name>           # Pause account
bun run apps/cli/src/main.ts --resume <name>          # Resume account
bun run apps/cli/src/main.ts --set-priority <name> <priority>  # Set account priority

# Server management
bun run apps/cli/src/main.ts --serve                  # Start server
bun run apps/cli/src/main.ts --serve --port 8081    # Start on specific port
bun run apps/cli/src/main.ts --logs [N]               # Stream logs
bun run apps/cli/src/main.ts --stats                  # Show statistics (JSON)

# Maintenance
bun run apps/cli/src/main.ts --reset-stats            # Reset statistics
bun run apps/cli/src/main.ts --clear-history          # Clear request history
bun run apps/cli/src/main.ts --analyze                # Analyze database performance

# Configuration
bun run apps/cli/src/main.ts --get-model               # Show current model
bun run apps/cli/src/main.ts --set-model <model>       # Set default model
bun run apps/cli/src/main.ts --help                   # Show help
```

For more detailed CLI documentation, see [CLI Commands](./cli.md).

## Environment Variables

```bash
# Server Configuration
PORT=8080                        # Server port (default: 8080)
LB_STRATEGY=session             # Load balancing strategy: session, least-used, session-affinity, or session-drain-soonest
SESSION_DURATION_MS=18000000    # Session duration in ms (default: 5 hours)

# OAuth Configuration
CLIENT_ID=<your-client-id>      # Custom OAuth client ID (optional)

# Retry Configuration
RETRY_ATTEMPTS=3                # Number of retry attempts (default: 3)
RETRY_DELAY_MS=1000            # Initial retry delay in ms (default: 1000)
RETRY_BACKOFF=2                # Exponential backoff multiplier (default: 2)

# Development
LOG_LEVEL=info                  # Logging level (debug|info|warn|error)
NODE_ENV=production            # Environment mode
```


### Strategy selection notes

- **Four supported strategies**: `session` (the default), `least-used`, `session-affinity`, and the opt-in `session-drain-soonest`
- **OAuth stickiness**: `session` keeps an account-level session for providers with session windows (including Anthropic OAuth and Codex OAuth); `session-affinity` keeps each client or lane on its own account for prompt-cache locality
- **Drain-soonest is opt-in**: `session-drain-soonest` orders fresh assignments and failover by weekly pace band, then the earliest known future all-model weekly reset; besides normal failover, an existing affinity owner also moves when a same-tier account reaches a higher pace band (Codex owners stay; Anthropic owners get a bounded warm-cache hold), and missing or stale telemetry falls back to ordinary affinity ordering ([Drain ordering](./load-balancing.md#drain-ordering))
- **Provider-aware safety**: `least-used` spreads requests by utilization and does not preserve OAuth stickiness, so reserve it for providers and credentials where per-request spreading is safe


## Contributing


We welcome contributions! See [CONTRIBUTING.md](contributing.md) for guidelines.

### Code Review Process

This repository includes an automated Claude code review system:
- **Automatic Review**: Runs automatically when a new pull request is opened
- **Manual Review**: Can be manually triggered by contributors by commenting `/claude-review` on the PR


## License

MIT - See [LICENSE](../LICENSE) for details.
