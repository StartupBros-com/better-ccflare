# wstack Router Documentation

wstack Router is the maintained fork at [StartupBros/wstack-router](https://github.com/StartupBros/wstack-router), built on upstream better-ccflare. The `better-ccflare` command and `BETTER_CCFLARE_*` configuration names remain supported.

## Track Every Request. Go Low-Level. Never Hit Rate Limits Again.

![License](https://img.shields.io/badge/license-MIT-green)
[Bun requirements](../README.md#install-from-source)

## Overview

better-ccflare is the ultimate Claude API proxy with intelligent load balancing across multiple accounts. Built with TypeScript and Bun runtime, it provides full visibility into every request, response, and rate limit, ensuring your AI applications never experience downtime due to rate limiting.

### Why better-ccflare?

When working with Claude API at scale, rate limits can become a significant bottleneck. better-ccflare solves this by:

- **🚀 Zero Rate Limit Errors**: Automatically distributes requests across multiple accounts with intelligent failover
- **📊 Request-Level Analytics**: Track latency, token usage, and costs in real-time with <10ms overhead
- **🔍 Deep Debugging**: Full request/response logging and error traces for complete visibility
- **💸 Session-Based Routing**: Default 5-hour sessions for providers with session windows maximize prompt-cache efficiency, reducing costs
- **⚡ Production Ready**: Built for scale with SQLite persistence, OAuth token refresh, and configurable retry logic

## Key Features

### 🎯 Intelligent Load Balancing
- **Four supported strategies**: `session` (the default), `least-used`, `session-affinity`, and the opt-in `session-drain-soonest`
- **OAuth stickiness**: `session` keeps an account-level session for providers with session windows (including Anthropic OAuth and Codex OAuth); `session-affinity` keeps each client or lane on its own account for prompt-cache locality
- **Drain-soonest is opt-in**: `session-drain-soonest` orders fresh assignments and failover by weekly pace band, then the earliest known future all-model weekly reset; besides normal failover, an existing affinity owner also moves when a same-tier account reaches a higher pace band (Codex owners stay; Anthropic owners get a bounded warm-cache hold), and missing or stale telemetry falls back to ordinary affinity ordering ([Drain ordering](./load-balancing.md#drain-ordering))
- **Provider-aware safety**: `least-used` spreads requests by utilization and does not preserve OAuth stickiness, so reserve it for providers and credentials where per-request spreading is safe

### 📈 Real-Time Monitoring & Analytics
- **Web Dashboard**: Interactive UI at `/dashboard` with live metrics
- **Powerful CLI**: Comprehensive command-line interface for management and monitoring
- **Request Tracking**: Complete history with token usage and costs
- **Advanced Filtering**: Filter requests and analytics by accounts, models, API keys, and status
- **Performance Metrics**: Response times, success rates, and error tracking

### 🛠️ Developer Experience
- **Zero Config Proxy**: Drop-in replacement for Claude API
- **CLI Management**: Add, remove, and manage accounts easily
- **Automatic Failover**: Seamless switching on rate limits
- **OAuth Token Refresh**: Handles authentication automatically

### 🏗️ Production Ready
- **SQLite Persistence**: Reliable data storage with migrations
- **Configurable Retry Logic**: Smart exponential backoff
- **Account Priority System**: Support for priority-based load balancing
- **Extensible Architecture**: Provider-based design for future AI services

## Documentation

### Getting Started
- [Configuration Guide](./configuration.md) - Environment variables and configuration options
- [Architecture Overview](./architecture.md) - System components and design principles
- [Data Flow](./data-flow.md) - Request lifecycle through the system

### Core Features
- [Load Balancing Strategies](./load-balancing.md) - Choose among session, least-used, session-affinity, and session-drain-soonest
- [Provider System](./providers.md) - Provider abstraction and OAuth implementation
- [Database Schema](./database.md) - SQLite structure, migrations, and maintenance
- [Model Mappings](./models.md) - Claude AI model definitions and constants

### User Interfaces
- [HTTP API Reference](./api-http.md) - Complete REST API documentation, including `/v1/messages`, `/v1/responses`, and `/v1/responses/compact`
- [CLI Commands](./cli.md) - Comprehensive command-line interface reference

### Operations
- [Migration Guide: v2 to v3](./migration-v2-to-v3.md) - Upgrading from version 2.x to 3.x
- [Deployment Guide](./deployment.md) - Production deployment with Docker, systemd, PM2, and Kubernetes
- [Security Considerations](./security.md) - Authentication, encryption, and best practices
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Contributing](./contributing.md) - Development setup and contribution guidelines
- [Acknowledgements](./acknowledgements.md) - Full details on community contributions

### API Reference
- [Anthropic API Changelog](./anthropic-api-changelog.md) - Track changes to Anthropic's usage API responses

## Quick Start

### 1. Install wstack Router

Use the root [Linux x86_64 release installation](../README.md#install-the-linux-x86_64-release) for Router 3.6.2: download one binary, check its pinned SHA-256, then run it. [Signed provenance verification](./wstack-router-releases.md#optional-consumer-provenance-verification) is optional and available before the first run. For other platforms or local builds, use [Install from source](../README.md#install-from-source). Router npm packages, container images, and other-platform binaries are not published; upstream better-ccflare distributions are not Router builds.

The commands below assume you completed the optional [PATH setup](../README.md#optional-add-commands-to-path) or the source install. Without PATH setup, replace `wstack-router` (or `better-ccflare`) with `"$HOME/.local/lib/wstack-router/3.6.2/wstack-router"`.

### 2. Start the Server

```bash
BETTER_CCFLARE_HOST=127.0.0.1 wstack-router --serve --port 8080
```

Leave the server running. `better-ccflare` remains an equivalent command; source-checkout commands are listed below. If you choose a different port, use it consistently in the following commands and client configuration.

### 3. Add Your Claude Accounts

In another terminal with the same installed command on PATH and the same local user/database configuration:

```bash
wstack-router --add-account work-account --mode claude-oauth --priority 0 --api-url http://127.0.0.1:8080
wstack-router routing list --api-url http://127.0.0.1:8080
```

Use `claude-oauth` for Claude OAuth. `max` remains a deprecated compatibility alias: the CLI warns and normalizes it to `claude-oauth`. Account creation persists locally before reviewing routing on the live server. Pass the explicit origin because the routing client otherwise defaults to port 8788 unless `BETTER_CCFLARE_API_URL` is set. If review fails after a created account ID is printed, do not recreate the account: follow [First-time Setup](./cli.md#first-time-setup) to inspect that ID and configure management API authentication when needed.

### 4. Configure Your Claude Client

Follow [Configure Claude SDK](../README.md#configure-claude-sdk) for client setup and authentication, using the same server port.

### 5. Monitor Your Usage

- **Web Dashboard**: Open [http://127.0.0.1:8080/dashboard](http://127.0.0.1:8080/dashboard) for real-time analytics
- **CLI**: Check status with `wstack-router --list`
- **Stats**: View detailed statistics with `wstack-router --stats`

## Project Structure

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

The better-ccflare CLI provides comprehensive command-line interface for management and monitoring:

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

## Related Resources

### External Links
- [Claude API Documentation](https://docs.anthropic.com/claude/docs) - Official Anthropic API docs
- [Bun Documentation](https://bun.sh/docs) - Bun runtime documentation
- [SQLite Documentation](https://www.sqlite.org/docs.html) - SQLite database docs

### Support
- [GitHub Repository](https://github.com/StartupBros/wstack-router) - Router source code and issues
- [Contributing](./contributing.md) - How to contribute to better-ccflare

## License

better-ccflare is open source software licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

<div align="center">
  <p>Built with ❤️ for developers who ship</p>
  <p>
    <a href="#quick-start">Get Started</a> •
    <a href="./architecture.md">Learn More</a> •
    <a href="./contributing.md">Contribute</a>
  </p>
</div>
