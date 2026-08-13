# Load Balancing in better-ccflare

## Table of Contents
1. [Overview](#overview)
2. [Available Strategies](#available-strategies)
3. [Session-Based Strategy](#session-based-strategy)
4. [Account Priorities](#account-priorities)
5. [Configuration](#configuration)
6. [Account Selection Process](#account-selection-process)
7. [Performance Considerations](#performance-considerations)
8. [Strategy Selection and OAuth Safety](#strategy-selection-and-oauth-safety)

## Overview

better-ccflare supports four load-balancing strategies for distributing requests across compatible accounts: `session` (the default), `least-used`, `session-affinity`, and the opt-in `session-drain-soonest`. Session-based strategies preserve account or client stickiness where prompt-cache locality and provider safety matter; `least-used` is available when per-request spreading is appropriate.

### Key Features
- **Account Health Monitoring**: Automatically filters out rate-limited or paused accounts
- **Failover Support**: Returns ordered lists of accounts for automatic failover
- **Session Persistence**: Maintains configurable sessions on specific accounts
- **Account Priorities**: Supports prioritized account selection for better control over load distribution
- **Auto-Fallback**: Automatically switches back to higher priority accounts when their usage windows reset
- **Usage Window Alignment**: Sessions automatically align with Anthropic OAuth 5-hour usage window resets for optimal resource utilization
- **Real-time Configuration**: Change settings without restarting the server
- **Provider Filtering**: Accounts are filtered by provider compatibility

## Available Strategies

The strategy is selected with `LB_STRATEGY`, the `lb_strategy` configuration key, or the HTTP configuration endpoint. All four values are valid:

| Strategy | Routing behavior | OAuth and provider guidance |
|----------|------------------|-----------------------------|
| `session` (default) | Maintains one account-level session and returns ordered fallbacks. Session duration is configurable (5 hours by default). | Preserves stickiness for providers that require session-window tracking, including Anthropic OAuth and Codex OAuth. Anthropic OAuth sessions also reset when a known `rate_limit_reset` has passed. |
| `least-used` | Orders available accounts by priority and utilization, with a short recency penalty to spread bursts. Each request can select a different account. | Does not preserve OAuth stickiness. Use for API-key or compatible-provider pools where per-request spreading is explicitly safe. |
| `session-affinity` | Maps each client session or affinity lane to a sticky account, while retaining automatic failover and expiry. New clients are spread across the pool. | Recommended when multiple concurrent clients need cache-local routing without one global account owner. |
| `session-drain-soonest` (opt-in) | Extends `session-affinity`. Existing owners remain in place; only a fresh assignment or account failover ranks candidates by the earliest known future all-model weekly reset, then priority/utilization. | Unknown, malformed, or past reset telemetry is treated as unavailable and falls back to ordinary affinity ordering. Enable deliberately for pools where draining expiring weekly capacity is useful. |

For Anthropic OAuth accounts, prefer `session`, `session-affinity`, or the opt-in `session-drain-soonest`. These preserve natural account stickiness. `least-used` intentionally spreads requests and may trigger provider anti-abuse controls when used with OAuth credentials.

## Session-Based Strategy

**Description**: Maintains one sticky session with an individual account for a configurable duration (default: 5 hours). This is the default strategy and is designed to minimize account switching and reduce the likelihood of hitting rate limits.

**Use Case**: Optimal for production environments where minimizing rate limits is crucial. Particularly effective for applications with sustained user sessions.

**Implementation Details**:
```typescript
export class SessionStrategy implements LoadBalancingStrategy {
    private sessionDurationMs: number;
    private store: StrategyStore | null = null;
    private log = new Logger("SessionStrategy");

    constructor(sessionDurationMs: number = TIME_CONSTANTS.SESSION_DURATION_DEFAULT) {
        this.sessionDurationMs = sessionDurationMs;
    }

    initialize(store: StrategyStore): void {
        this.store = store;
    }

    select(accounts: Account[], _meta: RequestMeta): Account[] {
        const now = Date.now();
        
        // Find account with most recent active session
        let activeAccount: Account | null = null;
        let mostRecentSessionStart = 0;
        
        for (const account of accounts) {
            if (account.session_start && 
                now - account.session_start < this.sessionDurationMs &&
                account.session_start > mostRecentSessionStart) {
                activeAccount = account;
                mostRecentSessionStart = account.session_start;
            }
        }
        
        // Use active account if available
        if (activeAccount && isAccountAvailable(activeAccount, now)) {
            const others = accounts.filter(
                a => a.id !== activeAccount.id && isAccountAvailable(a, now)
            );
            return [activeAccount, ...others]; // Active account first, others as fallback
        }
        
        // No active session - start new one with first available account
        const available = accounts.filter(a => isAccountAvailable(a, now));
        if (available.length === 0) return [];
        
        const chosenAccount = available[0];
        this.resetSessionIfExpired(chosenAccount);
        
        const others = available.filter(a => a.id !== chosenAccount.id);
        return [chosenAccount, ...others];
    }
}
```

**Characteristics**:
- ✅ **Excellent Rate Limit Avoidance**: Minimizes account switching
- ✅ **Predictable Behavior**: Consistent account usage patterns
- ✅ **Good for Long Sessions**: Ideal for extended AI conversations
- ⚠️ **Uneven Load Distribution**: May concentrate load on fewer accounts
- ⚠️ **Session Dependency**: Performance tied to specific account availability

## Usage Window Alignment for Anthropic OAuth

**Description**: Session duration tracking is provider-specific. Anthropic OAuth has a 5-hour usage window and additionally resets a session when the API's `rate_limit_reset` has passed. Codex OAuth and Zai are also configured for session-window tracking; API-key and other pay-as-you-go providers generally do not use fixed-duration session stickiness.

**How It Works**:

The system implements provider-specific session reset logic:

1. **Provider Check**: First determines if the account's provider requires session duration tracking (for example, Anthropic OAuth, Codex OAuth, and Zai)
2. **Fixed Duration Check**: For providers that require session duration tracking (such as Anthropic OAuth, Codex OAuth, and Zai), sessions reset after the configured duration (default: 5 hours)
3. **Usage Window Reset Check**: For Anthropic OAuth accounts, sessions also reset when the API's usage window expires (based on the `rate_limit_reset` timestamp)

```typescript
// Provider-specific session duration tracking
const needsSessionTracking = requiresSessionDurationTracking(account.provider);

const fixedDurationExpired = needsSessionTracking &&
    ( !account.session_start ||
    now - account.session_start >= this.sessionDurationMs );

const rateLimitWindowReset = !fixedDurationExpired &&
    account.provider === "anthropic" &&
    account.rate_limit_reset &&
    account.rate_limit_reset < now;

if (fixedDurationExpired || rateLimitWindowReset) {
    // Reset session for optimal resource utilization
    this.store.resetAccountSession(account.id, now);
}
```

**Benefits**:

- **Optimal Resource Utilization**: Sessions align perfectly with Anthropic's actual usage windows
- **Reduced Waste**: No premature session resets when usage windows are still active
- **Performance Optimized**: Rate limit checks only occur when needed (when fixed duration hasn't expired)

**Provider Compatibility**:

- ✅ **Anthropic OAuth**: Full usage window alignment support with 5-hour session tracking and `rate_limit_reset` checks
- ✅ **Codex OAuth and Zai**: Provider configuration enables fixed-duration session tracking
- ✅ **Other Providers** (API-key-based, OpenAI-compatible, etc.): No fixed-duration session tracking - operate on a pay-as-you-go basis
- ✅ **Mixed Environments**: Works seamlessly with accounts from different providers

**Race Condition Prevention**: The implementation uses strict `<` comparisons instead of `<=` to prevent race conditions where sessions might reset prematurely at the exact moment the usage window resets.

### Future Extensibility for API-Based Providers

**Current Implementation**: The usage window alignment is currently optimized for Anthropic OAuth accounts, which provide explicit `rate_limit_reset` timestamps via their API. Other providers (API-key-based, OpenAI-compatible, etc.) operate on a pay-as-you-go basis without fixed-duration session tracking.

**Current Extensible Architecture**: The system includes a provider-specific configuration system that allows easy extension for future providers with usage windows:

```typescript
// Current implementation in types/constants.ts
const PROVIDER_SESSION_TRACKING_CONFIG: Record<ProviderName, boolean> = {
    [PROVIDER_NAMES.ANTHROPIC]: true,   // Anthropic has 5-hour usage windows
    [PROVIDER_NAMES.ZAI]: false,        // Zai is typically pay-as-you-go
    [PROVIDER_NAMES.OPENAI_COMPATIBLE]: false, // OpenAI-compatible is typically pay-as-you-go
} as const;

// Function to check if a provider requires session duration tracking
export function requiresSessionDurationTracking(provider: string): boolean {
    const providerName = provider as ProviderName;
    if (providerName in PROVIDER_SESSION_TRACKING_CONFIG) {
        return PROVIDER_SESSION_TRACKING_CONFIG[providerName];
    }
    // For unknown providers, default to false (no session duration tracking)
    return false;
}
```

**Future Enhancement Path**: For API-based providers that implement their own usage windows (5-hour, daily, or custom intervals), you can simply update the configuration:

```typescript
// Example: Adding support for a new provider with usage windows
const PROVIDER_SESSION_TRACKING_CONFIG: Record<ProviderName, boolean> = {
    [PROVIDER_NAMES.ANTHROPIC]: true,           // Anthropic has 5-hour usage windows
    [PROVIDER_NAMES.ZAI]: false,                // Zai is typically pay-as-you-go
    [PROVIDER_NAMES.OPENAI_COMPATIBLE]: false,  // OpenAI-compatible is typically pay-as-you-go
    [PROVIDER_NAMES.NEW_PROVIDER]: true,        // New provider has usage windows
} as const;
```

**Implementation Benefits**:
1. **Simple Extension**: New providers can be added by updating the configuration
2. **Backward Compatibility**: Existing providers continue working as expected
3. **Provider-Specific Logic**: Each provider can have tailored session handling
4. **Future-Proof**: Ready for any new providers with usage window systems

## Account Priorities

Account priorities allow you to control which accounts are preferred when multiple accounts are available. This feature gives you fine-grained control over load distribution and account selection.

### How Priorities Work

- **Priority Range**: Accounts can have a priority value from 0-100 (default: 0)
- **Lower Value = Higher Priority**: Accounts with lower priority values are selected first
- **Optional Parameter**: Priority is optional when adding accounts and defaults to 0 (highest priority)
- **Affects Both Primary and Fallback Selection**: Priorities determine both the primary account and the order of fallback accounts
- **Real-time Updates**: Priority changes take effect immediately without restarting the server
- **Usage-Balanced Tiebreaking**: When multiple accounts share the same priority, new sessions start on the account with the most remaining capacity. "Most remaining capacity" is the inverse of the maximum utilization across all usage windows — so an account at 90% on its 7-day window and 20% on its 5-hour window is considered 90% utilized (the 7-day window is the binding constraint). Accounts with no usage data available are treated as 0% utilized (fresh, maximum remaining capacity) and sort first within their priority tier.

### Setting Account Priorities

Priorities can be set when adding an account or updated later:

```bash
# Add account with priority
better-ccflare --add-account myaccount --mode claude-oauth --priority 10

# Update account priority
better-ccflare set-priority myaccount 20
```

### Priority in Load Balancing

The SessionStrategy considers priorities when selecting accounts:

1. **Active Session Check**: First looks for an account with an active session
2. **Priority Sorting**: If no active session or the active account is unavailable, available accounts are sorted by priority (descending)
3. **Fallback Order**: Remaining accounts are also ordered by priority for failover scenarios

```typescript
// From load-balancer/src/strategies/index.ts
// Filter available accounts and sort by priority (lower value = higher priority)
const available = accounts
    .filter((a) => isAccountAvailable(a, now))
    .sort((a, b) => a.priority - b.priority); // Ascending sort
```

### Use Cases for Priorities

1. **Primary/Backup Setup**: Assign higher priorities to preferred accounts
2. **Cost Management**: Prioritize free or lower-cost accounts
3. **Performance Optimization**: Prioritize accounts with better performance characteristics
4. **Tiered Access**: Create hierarchical access patterns based on account capabilities

## Auto-Fallback Feature

The auto-fallback feature provides intelligent automatic switching back to higher priority accounts when their usage windows reset, allowing you to automatically take advantage of preferred accounts as soon as they become available again.

### How Auto-Fallback Works

Auto-fallback operates at the account level and uses the API's rate limit reset information to determine when accounts become available:

1. **Supported window providers**: Auto-fallback is available for `anthropic`, `codex`, and `zai` accounts, which expose the reset telemetry used by the scheduler
2. **Per-Account Setting**: Each supported account can have auto-fallback enabled or disabled independently
3. **Priority-Based Selection**: When multiple accounts have auto-fallback enabled and become available, the system selects the one with the highest priority (lowest priority number)
4. **API Reset Detection**: Uses the provider's `rate_limit_reset` timestamp to detect when a usage window has reset
5. **Automatic Switching**: Before processing each request, the system checks for higher priority accounts with auto-fallback enabled that have become available

### Auto-Fallback Logic

```typescript
// Simplified logic from load-balancer/src/strategies/index.ts
private checkForAutoFallbackAccounts(accounts: Account[], now: number): Account[] {
    const resetAccounts = accounts.filter((account) => {
        if (!account.auto_fallback_enabled) return false;
        if (account.paused) return false;

        // Check if the API usage window has reset
        const windowReset = account.rate_limit_reset && account.rate_limit_reset <= now;

        // Check if the account is not currently rate limited by our system
        const notRateLimited = !account.rate_limited_until || account.rate_limited_until <= now;

        return windowReset && notRateLimited;
    });

    // Sort by priority (lower number = higher priority)
    return resetAccounts.sort((a, b) => a.priority - b.priority);
}
```

### Enabling Auto-Fallback

Auto-fallback can be configured via the HTTP API:

```bash
# Enable auto-fallback for an account
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Disable auto-fallback for an account
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'
```

### Auto-Fallback Behavior

1. **Request Processing**: Before each request, the strategy checks for auto-fallback candidates
2. **Priority Consideration**: Only considers accounts with higher priority than the current active account
3. **Session Reset**: When switching to an auto-fallback account, the session is reset for the new account
4. **Logging**: The system logs when auto-fallback is triggered for transparency

### Use Cases for Auto-Fallback

1. **Primary Account Recovery**: Automatically switch back to your main account as soon as its rate limit window resets
2. **Cost Optimization**: Prioritize lower-cost accounts when they become available
3. **Performance Preference**: Automatically use higher-performance accounts when they're ready
4. **Tiered Access Management**: Ensure priority accounts get used first when available

### Example Scenario

```
Initial State:
- Account A (priority: 0): Rate limited, auto-fallback enabled
- Account B (priority: 10): Currently being used
- Account C (priority: 20): Available as fallback

When Account A's usage window resets:
1. System detects Account A is available again (rate_limit_reset passed)
2. Auto-fallback triggers because Account A has higher priority and auto-fallback enabled
3. System switches to Account A for the next request
4. Log: "Auto-fallback triggered to account A (priority: 0, auto-fallback enabled)"
```

### Configuration

Auto-fallback is configured per-account via the API and stored in the database:

```sql
-- Database field
ALTER TABLE accounts ADD COLUMN auto_fallback_enabled INTEGER DEFAULT 0;
```

The setting defaults to `disabled` (0) for all existing accounts to maintain backward compatibility.

## Configuration

better-ccflare uses a hierarchical configuration system where environment variables take precedence over configuration file settings.

### Configuration Precedence (highest to lowest)
1. Environment variables
2. Configuration file (`~/.better-ccflare/config.json`)
3. Default values

### Environment Variables

```bash
# Load balancing strategy: session (default), least-used, session-affinity, or
# session-drain-soonest (opt-in)
LB_STRATEGY=session

# Session duration in milliseconds (default: 18000000ms = 5 hours)
SESSION_DURATION_MS=18000000

# Server port (default: 8080)
PORT=8080

# Client ID for OAuth (default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e)
CLIENT_ID=your-client-id

# Retry configuration
RETRY_ATTEMPTS=3
RETRY_DELAY_MS=1000
RETRY_BACKOFF=2
```

### Configuration File

The configuration file is automatically created at `~/.better-ccflare/config.json` on first run:

```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000,
    "port": 8080,
    "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "retry_attempts": 3,
    "retry_delay_ms": 1000,
    "retry_backoff": 2
}
```

### Time Constants

The following time constants are used throughout the system:
- `SESSION_DURATION_DEFAULT`: 18000000ms (5 hours)
- `SESSION_DURATION_FALLBACK`: 3600000ms (1 hour) - used if configuration is invalid

### Dynamic Configuration

The strategy configuration can be changed at runtime via the HTTP API:

```bash
# Get current strategy
curl http://localhost:8080/api/config/strategy

# Update strategy (all four values are valid; session-drain-soonest is opt-in)
curl -X PUT http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "session"}'

# Get all configuration settings
curl http://localhost:8080/api/config

# Get available strategies
curl http://localhost:8080/api/config/strategies
```

## Account Selection Process

The load balancer follows a specific process when selecting accounts for requests:

### 1. Auto-Fallback Check (New)
Before checking for active sessions, the system first checks for auto-fallback candidates:
```typescript
// Check for higher priority accounts that have become available due to rate limit reset
const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
if (fallbackCandidates.length > 0) {
    // Use the highest priority auto-fallback account
    return [chosenFallback, ...otherAccounts];
}
```

### 2. Account Filtering
```typescript
// From proxy/handlers/account-selector.ts
const providerAccounts = allAccounts.filter(
    (account) => account.provider === ctx.provider.name || account.provider === null
);
```
- Accounts are first filtered by provider compatibility
- Only accounts matching the current provider or with null provider are considered

### 2. Availability Check
```typescript
// From core/strategy.ts
export function isAccountAvailable(account: Account, now = Date.now()): boolean {
    return (
        !account.paused &&
        (!account.rate_limited_until || account.rate_limited_until < now)
    );
}
```
- Paused accounts are excluded
- Rate-limited accounts are excluded if their rate limit hasn't expired

### 3. Session Management
The active strategy then applies its routing semantics:

- `session` finds the most recent active account-level session, keeps it while
  it remains available and in the best routing class, and returns ordered
  fallbacks. A new session starts with the highest-priority available account,
  using utilization as a same-priority tiebreaker.
- `session-affinity` keys ownership by the request's client session or affinity
  lane. Each client/lane stays on its owner until expiry; a temporary fallback
  can serve while the preferred owner is unavailable without deleting the
  preferred mapping.
- `session-drain-soonest` uses the same sticky-owner lifecycle as
  `session-affinity`. It changes only fresh-assignment and account-failover
  ordering, preferring the earliest known future all-model weekly reset within
  the same structural route class. Unknown or stale reset telemetry fails open
  to ordinary affinity ordering.
- `least-used` has no sticky owner. It orders available accounts by priority and
  utilization for each request and uses a bounded recency penalty to spread
  concurrent bursts.

For the account-level `session` strategy, the detailed process is:

1. **Active Session Search**: Finds the account with the most recent active session
2. **Session Validation**: Checks if the session is within the configured duration
3. **Account Ordering**: Returns accounts in priority order:
   - Active session account (if available) comes first
   - Other available accounts are sorted by priority (lower values first) as fallback options
4. **No Active Session — Utilization Tiebreaking**: When no active session exists, accounts with the same priority value are further sorted by ascending utilization (lowest first = most remaining capacity). This ensures new sessions start on the account with the most headroom, draining usage evenly across same-priority accounts. Accounts without available usage data are treated as 0% utilized and sort first (most remaining capacity) within their priority tier.

### 4. Session Reset
Sessions are reset when:
- No active session exists
- The current session has expired
- A new account needs to be selected

```typescript
private resetSessionIfExpired(account: Account): void {
    const now = Date.now();
    
    if (!account.session_start || 
        now - account.session_start >= this.sessionDurationMs) {
        // Reset session via StrategyStore
        this.store.resetAccountSession(account.id, now);
        account.session_start = now;
        account.session_request_count = 0;
    }
}
```

### 5. Database Updates
The StrategyStore interface provides methods for session management:
- `resetAccountSession(accountId, timestamp)`: Resets session start time and request count
- `updateAccountRequestCount(accountId, count)`: Updates request count for an account
- `getAccount(accountId)`: Retrieves account information

## Performance Considerations

### Session-Based Performance

The session strategy provides excellent rate limit avoidance at the cost of potentially uneven load distribution:

- **Rate Limit Avoidance**: By maintaining sessions with individual accounts for extended periods, the strategy minimizes the risk of hitting rate limits due to rapid account switching.
- **Load Distribution**: Load may concentrate on fewer accounts during a session window. This is acceptable for most use cases but should be monitored.
- **Failover**: If the active session account becomes unavailable, the system automatically fails over to the next available account.

### Session Storage

Session information is stored directly in the database with the following fields:
- `session_start`: Timestamp when the current session began
- `session_request_count`: Number of requests in the current session
- `rate_limited_until`: Timestamp when rate limiting expires (if applicable)

These fields are updated synchronously to ensure consistency in account selection.

### Monitoring

Monitor these key metrics:
- Account usage distribution
- Rate limit occurrences
- Session duration effectiveness
- Failover frequency

## Strategy Selection and OAuth Safety

All four built-in strategies are supported. The right choice depends on whether
the provider and credential type benefit from account stickiness:

### Account and client stickiness

- `session` is the default account-level strategy. Providers configured for
  session duration tracking (including Anthropic OAuth and Codex OAuth) keep an
  active account session for the configured duration; Anthropic OAuth also
  honors a known `rate_limit_reset` when starting the next session.
- `session-affinity` keeps a separate sticky owner for each client session or
  affinity lane. This spreads concurrent clients across healthy accounts while
  preserving prompt-cache locality within each client.
- `session-drain-soonest` is deliberately opt-in. It inherits the
  `session-affinity` owner lifecycle, so it never displaces an existing owner
  just because another account has an earlier reset. On a fresh assignment or
  account-level failover only, a known future all-model weekly reset is used to
  order candidates within the same structural route class, followed by normal
  priority and utilization tie-breakers. Missing, malformed, or past reset
  telemetry is unknown and fails open to ordinary affinity ordering.

### Per-request spreading

`least-used` orders available accounts by priority and utilization on every
request, with a bounded recency penalty to prevent concurrent bursts from
converging on one account. It intentionally does not preserve OAuth stickiness.
Use it for API-key or compatible-provider pools where per-request spreading is
safe and prompt-cache reuse is less important.

### Anti-abuse guidance

Rapidly switching among Anthropic OAuth accounts can look unlike normal user
behavior and may trigger provider anti-abuse controls. For Anthropic OAuth,
prefer `session`, `session-affinity`, or the opt-in `session-drain-soonest` and
monitor account health and rate-limit telemetry. `least-used` is not unsafe by
definition, but should be reserved for credentials and providers where that
traffic pattern is explicitly acceptable.

If you need to tune the default account-level behavior, adjust
`session_duration_ms` rather than inventing a custom strategy:

```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000  // 5 hours (recommended default)
}
```

## LoadBalancingStrategy Interface

For reference, here's the interface that all load balancing strategies must implement:

```typescript
// From types/context.ts
export interface LoadBalancingStrategy {
    /**
     * Return a filtered & ordered list of candidate accounts.
     * Accounts that are rate-limited should be filtered out.
     * The first account in the list should be tried first.
     */
    select(accounts: Account[], meta: RequestMeta): Account[];

    /**
     * Optional initialization method to inject dependencies
     * Used for strategies that need access to a StrategyStore
     */
    initialize?(store: StrategyStore): void;
}
```

The `RequestMeta` object contains:
- `id`: Unique request identifier
- `method`: HTTP method
- `path`: Request path
- `timestamp`: Request timestamp
- `agentUsed`: Optional agent identifier

The built-in implementations are `SessionStrategy`, `LeastUsedStrategy`,
`SessionAffinityStrategy`, and `SessionDrainSoonestStrategy` under
`/packages/load-balancer/src/strategies/`. The latter is selected only when
`LB_STRATEGY=session-drain-soonest` (or the equivalent config/API value) is
explicitly set.

## Migration Notes

When upgrading to this version, session duration tracking remains provider-specific:
Anthropic OAuth, Codex OAuth, and Zai accounts retain the configured session-window
behavior, while Minimax, OpenAI-compatible, and Claude console API accounts operate
without fixed-duration session stickiness. Existing Claude console accounts will be
automatically migrated to the new `claude-console-api` provider type. No manual
configuration changes are required.
