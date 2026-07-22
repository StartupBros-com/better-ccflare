# better-ccflare CLI Documentation

The better-ccflare CLI provides a command-line interface for managing OAuth accounts, monitoring usage statistics, and controlling the load balancer.

## Table of Contents

- [Installation and Setup](#installation-and-setup)
- [Global Options and Help](#global-options-and-help)
- [Command Reference](#command-reference)
  - [Account Management](#account-management)
  - [Account Priorities](#account-priorities)
  - [Managed Routing (Live Server)](#managed-routing-live-server)
  - [Statistics and History](#statistics-and-history)
  - [System Commands](#system-commands)
  - [Server and Monitoring](#server-and-monitoring)
- [Usage Examples](#usage-examples)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Installation and Setup

### Prerequisites

- Bun runtime (>= 1.2.8)
- Node.js compatible system

### Installation

1. Clone the repository:
```bash
git clone https://github.com/tombii/better-ccflare.git
cd better-ccflare
```

2. Install dependencies:
```bash
bun install
```

3. Build the CLI:
```bash
bun run build
```

4. Run the CLI:
```bash
bun run cli [command]
# or if globally installed:
better-ccflare [command]
```

### First-time Setup

1. Add your first OAuth account:
```bash
bun run cli --add-account myaccount --mode claude-oauth --priority 0
```

2. Start the load balancer server:
```bash
bun run cli --serve
# or just:
bun start
```

## Global Options and Help

### Getting Help

Display all available commands and options:

```bash
bun run cli --help
```

Or use the short form:

```bash
bun run cli -h
```

### Help Output Format

```
🎯 better-ccflare - Load Balancer for Claude

Usage: better-ccflare [options]

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <claude-oauth|console>  Account mode (default: claude-oauth)
    --priority <number>    Account priority (0-100, default: 0)
  --list               List all accounts
  --remove <name>      Remove an account
  --force-reset-rate-limit <name> Force-clear stale rate-limit lock fields for an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --set-priority <name> <priority> Set account priority (0-100)
  --analyze            Analyze database performance
  --repair-db          Check and repair database integrity
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --help, -h           Show this help message

Default Mode:
  bun run cli             Start server (default behavior)
```

## Command Reference

### Account Management

#### `--add-account <name>`

Add a new OAuth account to the load balancer pool.

**Syntax:**
```bash
bun run cli --add-account <name> --mode <claude-oauth|console|codex|qwen|xai|zai|minimax|anthropic-compatible|openai-compatible> --priority <number>
```

**Note:** All flags must be provided explicitly as the CLI requires explicit parameters.

**Required Options:**
- `--mode`: Account type (required)
  - `claude-oauth`: Claude CLI OAuth account
  - `console`: Claude API account
  - `codex`: Codex/OpenAI account (OAuth)
  - `qwen`: Qwen account (OAuth device code)
  - `xai`: xAI/Grok account (imports local Grok CLI OAuth credentials from `~/.grok/auth.json`; token values are never displayed). xAI refresh tokens may rotate, so if you keep using Grok CLI separately, re-authenticate or refresh Grok CLI after importing so each tool has a fresh token chain. Per-request token usage is recorded from responses, and Grok Build credits usage is polled via grok.com gRPC-web for dashboard bars.
  - `zai`: z.ai account (API key)
  - `openai-compatible`: OpenAI-compatible provider (API key)
- `--priority`: Account priority (optional, defaults to 0)
  - Range: 0-100
  - Lower numbers indicate higher priority in load balancing

**Account Setup Process:**
1. Execute command with all required flags
2. For OAuth accounts (claude-oauth/console), opens browser for authentication
3. Waits for OAuth callback on localhost:7856
4. For xAI/Grok accounts, imports existing Grok CLI OAuth credentials from `~/.grok/auth.json` without printing token values
5. For API key accounts (zai/openai-compatible), prompts for API key
6. Stores account credentials securely in the database

#### `--list`

Display all configured accounts with their current status.

**Syntax:**
```bash
bun run cli --list
```

**Output Format:**
```
Accounts:
  - account1 (claude-oauth mode, priority 10)
  - account2 (console mode, priority 5)
```

#### `--remove <name>`

Remove an account from the configuration.

**Syntax:**
```bash
bun run cli --remove <name>
```

**Behavior:**
- Removes account from database immediately
- Cleans up associated session data
- Account removal is immediate with no confirmation prompts

#### `--pause <name>`

Temporarily exclude an account from the load balancer rotation.

**Syntax:**
```bash
bun run cli --pause <name>
```

**Use Cases:**
- Account experiencing issues
- Manual rate limit management
- Maintenance or debugging

#### `--force-reset-rate-limit <name>`

Force-clear a potentially stale account rate-limit lock.

**Syntax:**
```bash
bun run cli --force-reset-rate-limit <name>
```

**What it does:**
- Clears `rate_limited_until`
- Clears `rate_limit_reset`
- Clears `rate_limit_status`
- Clears `rate_limit_remaining`
- Attempts to trigger immediate usage polling on running local servers

#### `--resume <name>`

Re-enable a paused account for load balancing.

**Syntax:**
```bash
bun run cli --resume <name>
```

### Account Priorities

#### `--set-priority <name> <priority>`

Set or update the priority of an account. Accounts with lower priority numbers are preferred in the load balancing algorithm.

**Syntax:**
```bash
bun run cli --set-priority <name> <priority>
```

**Parameters:**
- `name`: Account name to update
- `priority`: Priority value (0-100, where lower numbers indicate higher priority)

**How Priorities Work:**
- Accounts with lower priority numbers are selected first
- Default priority is 0 if not specified
- Priority affects both primary account selection and fallback order
- Changes take effect immediately without restarting the server
- In a Managed family route, global account priority becomes that virtual member's tier only after a matching enabled provider/route-class rule admits the account
- Global priority alone never grants combo membership and never rewrites the persisted tier of a Manual combo slot

**Example:**
```bash
# Set account to high priority (low number)
bun run cli --set-priority production-account 10

# Set account to medium priority
bun run cli --set-priority development-account 50

# Set account to low priority (high number)
bun run cli --set-priority backup-account 90
```

### Managed Routing (Live Server)

The managed-routing CLI controls the same authoritative live-server policy used by the dashboard and proxy.

#### Exact command surface

```bash
better-ccflare routing list [--api-url <loopback-url>] [--json]
better-ccflare routing detail <account-id> [--api-url <loopback-url>] [--json]
better-ccflare routing preview <family> [--managed-model <model>] [--api-url <loopback-url>] [--json]
better-ccflare routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes [--api-url <loopback-url>] [--json]
better-ccflare routing manual <family> --yes [--api-url <loopback-url>] [--json]
```

`<family>` must be `fable`, `opus`, `sonnet`, or `haiku`. Unattended or JSON apply requires the complete displayed tuple plus `--yes`; unattended or JSON Manual rollback requires `--yes`. In an interactive TTY, `routing apply` may omit the tuple and `--yes`, and `routing manual` may omit `--yes`; the CLI then performs the review and confirmation flow described below.

The CLI calls the running management API instead of opening the local database or reimplementing capability and precedence rules. The API origin resolves in this order:

1. `--api-url <loopback-url>`;
2. `BETTER_CCFLARE_API_URL`;
3. `http://127.0.0.1:8788`.

Only an HTTP or HTTPS loopback origin is accepted. A URL with a non-loopback host, credentials, path, query, or fragment is rejected. `--api-url` is valid only with a `routing` command or the packaged `--add-account` post-create workflow.

If API authentication is configured, set `BETTER_CCFLARE_ADMIN_API_KEY` in the process environment. There is deliberately no admin-key CLI flag. Use a better-ccflare admin key, not a provider credential or API-only key. The client sends it as `x-api-key`, redacts it from text/JSON/errors, and rejects redirects instead of forwarding a credentialed request.

#### Read and preview commands

| Command | Behavior |
| --- | --- |
| `routing list` | Merges live accounts with authoritative memberships, decisions, availability, and routing opportunities; accounts with no membership remain visible |
| `routing detail <account-id>` | Shows the same routing projection for one immutable account ID, never a display-name lookup |
| `routing preview <family>` | Returns the full server-owned family preview, proposals, confidence, route class, and exact member deltas without writing policy |

`routing preview` may use `--managed-model` to review a family-compatible model override. `routing apply` accepts that flag only as part of the complete unattended tuple, or by itself in an interactive run to constrain the preview that follows. `--json` selects the redacted JSON rendering; it does not change the server contract. List, detail, and preview never mutate routing.

#### Interactive and unattended mutations

Interactive `routing apply <family>` may omit the reviewed tuple. The CLI then:

1. fetches and prints the complete live family preview;
2. requires explicit selection of one proposal, even if the server marks one as the default;
3. asks for confirmation;
4. submits the exact `preview_id`, `proposal_id`, and `managed_model` that were reviewed.

If an interactive apply supplies the complete tuple, the CLI still asks for confirmation unless `--yes` is present. Interactive `routing manual <family>` likewise asks before returning the family to Manual mode unless `--yes` is present.

When stdin/stdout is not a TTY, or whenever `--json` is used, mutation commands do not prompt or auto-select:

- `routing apply` requires the complete `--preview-id`, `--proposal-id`, `--managed-model`, and `--yes` set.
- `routing manual` requires `--yes`.
- A partial tuple, missing confirmation, unknown option, or misplaced `routing` token is a usage error.

A rejected stale preview or zero-candidate Managed route is not retried, force-applied, or automatically rolled back. Request a fresh preview and review it again. Managed mode continues to fail closed for unsupported or unknown capability. Use the dashboard or management API for Managed exclusion and restore; those are not shipped routing subcommands.

#### Post-create routing review

The packaged `--add-account` flow persists the account first and returns its immutable created ID. Routing review always uses that persisted ID; it never guesses by display name or invents draft routing metadata.

`--add-account --json` is rejected before account creation because provider setup can emit interactive human output. This restriction applies only to account creation; every shipped `routing` command continues to support its documented `--json` form.

In a non-TTY text process, account creation can proceed. After persistence, the CLI reads and prints the authoritative effective-routing detail for the exact immutable created ID, followed by `routing detail <account-id>` and `routing preview <family>` guidance. This path never requests a routing preview and never sends a routing mutation. If the authoritative read cannot complete, the CLI preserves the printed created identity, reports that the post-create effective-routing result is incomplete, prints the same follow-up guidance, and exits nonzero.

In an interactive TTY, the CLI first:

1. asks the live server for account-scoped previews across the supported families;
2. prints the complete previews and exact deltas;
3. requires an explicit proposal-or-skip choice for every family that has proposals.

Selecting nothing sends no routing write. For each selected family, in review order, the CLI then completes a separate fresh-preview/review/confirmation/write cycle:

1. request a new account-and-family-scoped preview, because every prior policy write advances the global routing revision;
2. print the refreshed preview and exact delta;
3. verify that the selected proposal is still present and materially identical to what the operator selected initially;
4. ask for confirmation of that refreshed family proposal;
5. apply it using the refreshed `preview_id`, proposal, model, and immutable account ID before moving to the next family.

A missing or materially changed proposal, preview/review/confirmation failure, declined confirmation, unavailable live API, or apply failure stops the sequence without retry or automatic rollback. Before any family succeeds, the result is reported as declined or failed closed, as appropriate. After one or more families succeed, the CLI reports `partial`, including the successful family results and the exact family/reason where it stopped. The persisted account and any already-applied reviewed family changes remain visible; follow-up detail/preview guidance is printed when the outer review fails.

For complete Manual/Managed precedence, priority, exclusion, availability, and controlled-rollout behavior, see [Combos and Managed Family Routing](combos.md).

#### Rollback contract

Rollback must send a partial family-policy update equivalent to:

```json
{
  "membership_mode": "manual"
}
```

Do not send a replacement assignment or clear the combo, rules, Managed model, Manual slots, or exclusions. This makes rollback immediate and preserves the reviewed policy for diagnosis.

#### Safe automation

- Keep the server target on loopback; the managed-routing client rejects non-loopback hosts and credential-bearing URLs.
- Supply the admin key through `BETTER_CCFLARE_ADMIN_API_KEY`, never a command-line argument that can leak through process listings or shell history.
- Treat JSON as a redacted reporting format; it must not include credentials, model mappings containing secrets, or raw authentication material.
- Use `--json` with `routing` commands only; `--add-account --json` is rejected before creating an account.
- Automate list, detail, and preview freely, but require explicit reviewed identifiers and confirmation for apply.
- Never validate Managed routing by sending scripted inference to Anthropic or Codex. Use natural traffic and aggregate diagnostics for a live canary.

### Statistics and History

#### `--stats`

Display current statistics in JSON format.

**Syntax:**
```bash
bun run cli --stats
```

**Output:**
Returns JSON-formatted statistics including account usage, request counts, and performance metrics.

#### `--reset-stats`

Reset request counters for all accounts.

**Syntax:**
```bash
bun run cli --reset-stats
```

**Effects:**
- Resets request counts to 0
- Preserves account configuration
- Does not affect rate limit timers

#### `--clear-history`

Remove all request history records.

**Syntax:**
```bash
bun run cli --clear-history
```

**Effects:**
- Deletes request log entries
- Preserves account data
- Reports number of records cleared

### System Commands

#### `--analyze`

Analyze database performance and index usage.

**Syntax:**
```bash
bun run cli --analyze
```

**Output:**
- Database performance metrics
- Index usage statistics
- Query optimization suggestions

#### `--repair-db`

Check and repair database integrity issues.

**Syntax:**
```bash
bun run cli --repair-db
```

**What it does:**
- Runs `PRAGMA integrity_check` to verify database health
- Detects and fixes NULL values in numeric fields
- Validates foreign key constraints
- Vacuums database to reclaim space and rebuild structure
- Optimizes database with `ANALYZE` and `PRAGMA optimize`

**When to use:**
- After encountering "All accounts failed" errors
- When you suspect database corruption
- If you see database-related error messages
- As part of regular maintenance

**Example output:**
```
🔧 BETTER-CCFLARE DATABASE REPAIR
══════════════════════════════════════════════════

🔍 Checking database integrity...
✅ Database integrity check: PASSED

🔍 Checking for NULL values in account fields...
⚠️  Found NULL values in account fields:
   - request_count: 3
   - total_requests: 2
   - session_request_count: 1

🔧 Fixing NULL values...
✅ Fixed 3 account records with NULL values

✅ Database vacuumed successfully
✅ Database optimized successfully

DATABASE REPAIR SUMMARY
══════════════════════════════════════════════════
📊 Results:
   Integrity Check: ✅ PASSED
   NULL Values Fixed: 3
   Database Vacuumed: ✅ YES

✅ Database is healthy!
```

**Exit codes:**
- `0`: Success (database healthy or repaired)
- `1`: Critical errors require manual intervention

#### Default Behavior

When no command is specified, the CLI starts the server by default:

```bash
bun run cli
# Equivalent to:
bun run cli --serve
```

### Server and Monitoring

#### `--serve`

Start the API server with dashboard.

**Syntax:**
```bash
bun run cli --serve [--port <number>]
```

**Options:**
- `--port`: Server port (default: 8080, or PORT env var)

**Access:**
- API endpoint: `http://localhost:8080`
- Dashboard: `http://localhost:8080/dashboard`

#### `--logs [N]`

Stream request logs in real-time.

**Syntax:**
```bash
bun run cli --logs [N]
```

**Options:**
- `N`: Number of historical lines to display before streaming (optional)

**Examples:**
```bash
# Stream live logs only
bun run cli --logs

# Show last 50 lines then stream
bun run cli --logs 50
```

## Usage Examples

### Basic Account Setup

```bash
# Add a Claude CLI OAuth account with high priority (low number)
bun run cli --add-account work-account --mode claude-oauth --priority 10

# Add a Console account with medium priority
bun run cli --add-account personal-account --mode console --priority 50

# Add a backup account with low priority (high number)
bun run cli --add-account backup-account --mode claude-oauth --priority 90

# List all accounts
bun run cli --list

# Update account priority
bun run cli --set-priority backup-account 20

# View statistics
bun run cli --stats
```

### Server Operations

```bash
# Start server on default port
bun run cli --serve
# or simply:
bun start

# Start server on custom port
bun run cli --serve --port 3000

# Stream logs
bun run cli --logs

# View last 100 lines then stream
bun run cli --logs 100
```

### Managing Rate Limits

```bash
# Pause account hitting rate limits
bun run cli --pause work-account

# Force-clear stale rate-limit lock
bun run cli --force-reset-rate-limit work-account

# Resume after cooldown
bun run cli --resume work-account

# Reset statistics for fresh start
bun run cli --reset-stats
```

### Maintenance Operations

```bash
# Remove account
bun run cli --remove old-account

# Clear old request logs
bun run cli --clear-history

# Analyze database performance
bun run cli --analyze

# Repair database if you encounter errors
bun run cli --repair-db
```

### Automation Examples

```bash
# Add multiple accounts with different priorities
bun run cli --add-account "primary-account" --mode max --priority 10
bun run cli --add-account "secondary-account" --mode max --priority 50
bun run cli --add-account "backup-account" --mode max --priority 90

# Monitor account status
watch -n 5 'bun run cli --list'

# Automated cleanup
bun run cli --clear-history && bun run cli --reset-stats

# Export statistics for monitoring
bun run cli --stats > stats.json

# Prioritize specific account temporarily
bun run cli --set-priority primary-account 5
# ... run important workload ...
bun run cli --set-priority primary-account 10  # Restore normal priority
```

## Configuration

### Configuration File Location

better-ccflare stores its configuration in platform-specific directories:

#### macOS/Linux
```
~/.config/better-ccflare/better-ccflare.json
```

Or if `XDG_CONFIG_HOME` is set:
```
$XDG_CONFIG_HOME/better-ccflare/better-ccflare.json
```

#### Windows
```
%LOCALAPPDATA%\better-ccflare\better-ccflare.json
```

Or fallback to:
```
%APPDATA%\better-ccflare\better-ccflare.json
```

### Configuration Structure

```json
{
  "lb_strategy": "session",
  "client_id": "optional-custom-client-id",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

### Database Location

The SQLite database follows the same directory structure:
- **macOS/Linux**: `~/.config/better-ccflare/better-ccflare.db`
- **Windows**: `%LOCALAPPDATA%\better-ccflare\better-ccflare.db`

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `better-ccflare_CONFIG_PATH` | Override config file location | Platform default |
| `better-ccflare_DB_PATH` | Override database location | Platform default |
| `PORT` | Server port | 8080 |
| `CLIENT_ID` | OAuth client ID | 9d1c250a-e61b-44d9-88ed-5944d1962f5e |
| `BETTER_CCFLARE_API_URL` | Loopback origin for live managed-routing CLI operations | `http://127.0.0.1:8788` |
| `BETTER_CCFLARE_ADMIN_API_KEY` | Admin API key for live-server managed-routing CLI operations when authentication is enabled | Unset |

### Load Balancing

| Variable | Description | Default |
|----------|-------------|---------|
| `LB_STRATEGY` | Load balancing strategy (only 'session' is supported) | session |

### Retry Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RETRY_ATTEMPTS` | Number of retry attempts | 3 |
| `RETRY_DELAY_MS` | Initial retry delay (ms) | 1000 |
| `RETRY_BACKOFF` | Exponential backoff multiplier | 2 |

### Session Management

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_DURATION_MS` | OAuth session duration (ms) | 18000000 (5 hours) |

### Logging and Debugging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Log verbosity (DEBUG/INFO/WARN/ERROR) | INFO |
| `LOG_FORMAT` | Output format (pretty/json) | pretty |
| `better-ccflare_DEBUG` | Enable debug mode (1/0) - enables console output | 0 |

### Pricing and Features

| Variable | Description | Default |
|----------|-------------|---------|
| `CF_PRICING_REFRESH_HOURS` | Pricing cache duration | 24 |
| `CF_PRICING_OFFLINE` | Offline mode flag (1/0) | 0 |

## Troubleshooting

### Common Issues

#### OAuth Authentication Fails

**Problem**: Browser doesn't open or OAuth callback fails

**Solutions**:
1. Ensure default browser is configured
2. Check firewall settings for localhost:7856
3. Manually copy OAuth URL from terminal
4. Verify network connectivity

#### Account Shows as "Expired"

**Problem**: Token status shows expired

**Solutions**:
1. Remove and re-add the account
2. Check system time synchronization
3. Verify OAuth session hasn't exceeded 5-hour limit

#### Rate Limit Errors

**Problem**: Accounts hitting rate limits frequently

**Solutions**:
1. Add more accounts to the pool
2. Increase session duration for less frequent switching
3. Implement request throttling in client code
4. Monitor usage with `bun cli list`

#### Database Errors

**Problem**: "Database is locked" or corruption errors

**Solutions**:
1. Stop all better-ccflare processes
2. Check file permissions on database
3. Backup and recreate if corrupted:
   ```bash
   cp ~/.config/better-ccflare/better-ccflare.db ~/.config/better-ccflare/better-ccflare.db.backup
   rm ~/.config/better-ccflare/better-ccflare.db
   ```

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging
export BETTER_CCFLARE_DEBUG=1
export LOG_LEVEL=DEBUG

# Run with verbose output
bun run cli --list

# Stream debug logs
bun run cli --logs
```

### Getting Support

1. Check existing documentation in `/docs`
2. Review debug logs for detailed error messages
3. Ensure all dependencies are up to date
4. File an issue with reproduction steps

### Best Practices

1. **Regular Maintenance**
   - Clear history periodically to manage database size
   - Reset stats monthly for accurate metrics
   - Monitor account health with regular `bun run cli --list` commands
   - Use `bun run cli --analyze` to optimize database performance

2. **Account Management**
   - Use descriptive account names
   - Distribute load across multiple accounts
   - Use account priorities to control load distribution:
     - Set lower priority numbers for premium or preferred accounts
     - Use higher priority numbers for backup or development accounts
     - Adjust priorities temporarily for specific workloads
   - Pause accounts proactively when approaching rate limits

3. **Security**
   - Protect configuration directory permissions
   - Don't share OAuth tokens or session data
   - Rotate accounts periodically
   - Monitor logs with `bun run cli --logs` for suspicious activity

4. **Performance**
   - Use accounts with higher rate limits for heavy workloads
   - Implement client-side retry logic
   - Monitor rate limit patterns with `bun run cli --stats`
   - Run server with `bun run cli --serve` for production use
