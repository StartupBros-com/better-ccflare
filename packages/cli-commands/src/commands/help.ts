/**
 * Exact managed-routing surface shared with the packaged CLI help.
 */
export function getManagedRoutingHelpText(): string {
	return `Managed routing (live server; admin key is read only from BETTER_CCFLARE_ADMIN_API_KEY):
  routing list [--api-url <loopback-url>] [--json]
  routing detail <account-id> [--api-url <loopback-url>] [--json]
  routing preview <family> [--managed-model <model>] [--api-url <loopback-url>] [--json]
  routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes [--api-url <loopback-url>] [--json]
  routing manual <family> --yes [--api-url <loopback-url>] [--json]

  Families: fable, opus, sonnet, haiku
  Interactive apply may omit the reviewed tuple to preview, review exact deltas,
  select a proposal explicitly, and confirm. JSON and non-interactive mutations
  require every displayed identifier/model plus --yes.
  After interactive account creation, each selected family is freshly previewed,
  reviewed, and confirmed before its account-scoped write. Non-interactive account
  creation prints the immutable account ID and follow-up commands without routing writes.`;
}

/**
 * Get help text for CLI commands
 */
export function getHelpText(): string {
	return `
Usage: better-ccflare <command> [options]

Commands:
  add <name> [--mode <claude-oauth|console|codex|qwen|xai|zai|minimax|anthropic-compatible|openai-compatible|nanogpt|kilo|openrouter|ollama|ollama-cloud>] [--priority <number>] [--modelMappings <JSON>] [--api-url <loopback-url>]
    Add a new account using OAuth or API key
    --mode: Account type (optional, will prompt if not provided)
      claude-oauth: Claude CLI OAuth account (OAuth)
      console: Claude API account (OAuth)
      codex: Codex/OpenAI account (OAuth)
      qwen: Qwen account (OAuth device code)
      xai: xAI/Grok account (imports local Grok CLI OAuth credentials)
      zai: z.ai account (API key)
      minimax: Minimax account (API key)
      anthropic-compatible: Anthropic-compatible provider (API key)
      openai-compatible: OpenAI-compatible provider (API key)
      nanogpt: NanoGPT provider (API key)
      kilo: Kilo Gateway provider (API key)
      openrouter: OpenRouter provider (API key)
      ollama: Ollama local provider (v0.14.0+, no API key required)
      ollama-cloud: Ollama Cloud provider (ollama.com, API key required)
    --priority: Account priority (0-100, default 0, lower numbers = higher priority)
    --modelMappings: Model mappings as JSON string (e.g., '{"opus":"my-opus-model","sonnet":"my-sonnet-model"}')
    --api-url: Optional loopback live-server target for post-create routing review

  list
    List all accounts with their details

  remove <name> [--force]
    Remove an account
    --force: Skip confirmation prompt

  pause <name>
    Pause an account to exclude it from load balancing

  resume <name>
    Resume a paused account to include it in load balancing

  set-priority <name> <priority>
    Set the priority of an account
    --priority: Account priority (0-100, lower numbers = higher priority)

  reset-stats
    Reset request counts for all accounts

  clear-history
    Clear request history

  analyze
    Analyze database performance and index usage

  token-health
    Check OAuth token health and expiration status
    Shows detailed information about access tokens and refresh tokens

  reauth-needed
    Quick check for accounts that need re-authentication
    Shows only accounts that require immediate attention

${getManagedRoutingHelpText()}

  --cache-flight-recorder-report <id> [--json]
    Report a retained cache flight recorder timeline by opaque recorder ID

  --cache-flight-recorder-health [--json]
    Show recorder enabled state, retention, counts, and persistence health

  help
    Show this help message

Examples:
  better-ccflare add myaccount --mode claude-oauth --priority 10
  better-ccflare add grok --mode xai --priority 50
  better-ccflare add anthropic-account --mode anthropic-compatible --priority 5 --modelMappings '{"opus":"claude-3-opus","sonnet":"claude-3-sonnet"}'
  better-ccflare add "My Account" --mode claude-oauth --priority 10  # Account names with spaces must be quoted
  better-ccflare list
  better-ccflare remove myaccount
  better-ccflare pause "My Account"  # Use quotes for names with spaces
  better-ccflare resume myaccount
  better-ccflare set-priority myaccount 20
  better-ccflare token-health
  better-ccflare reauth-needed

Note: Account names can contain letters, numbers, spaces, hyphens, and underscores.
      When using names with spaces, wrap them in quotes (e.g., "My Account").
`;
}
