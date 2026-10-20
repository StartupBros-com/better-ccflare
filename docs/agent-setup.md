# Set up Router with an agent

For a coding agent with computer and terminal access, helping a human connect Claude Code to wstack Router. Use the linked instructions for the selected path; installation commands live in the [technical reference](reference.md), not here. Finish with a working client request and a usable dashboard, or name the human step still needed.

## 1. Choose the setup path

Inspect OS/architecture, installed tools, command locations, listening ports, and the intended Claude Code client. Check whether Router or better-ccflare already runs. Inspect configuration locations and relevant non-secret settings narrowly; do not dump environment variables, credential stores, account databases, or client configuration into chat.

- **Existing server:** confirm its owner, origin, and intended use with the human. Reuse it without starting another process against its database. Read [migration and rollback](wstack-router-migration.md#what-stays-the-same) before changing command selection. If its ownership or purpose is unclear, stop for clarification rather than taking it over.
- **New local setup:** use a separate installation and private state. Choose an unused loopback port. Keep existing executables, services, account data, client settings, and login intact.

Continue when the installation path, server origin, and client are known. Ask only for choices inspection cannot resolve. Autostart, shell-profile edits, system services, remote exposure, and existing-server changes require a separate decision.

## 2. Install without replacing anything

- **Linux x86_64:** follow [the verified 3.6.2 binary installation](reference.md#install-the-linux-x86_64-release). Check its pinned checksum before execution; offer [signed provenance verification](wstack-router-releases.md#optional-consumer-provenance-verification) before the first run. Stop on a failed download or verification. Existing paths are intentionally refused, not overwritten. [PATH aliases](reference.md#optional-add-commands-to-path) are optional; using the full executable path is enough.
- **Source build:** follow [Install from source](reference.md#install-from-source), including Git, Node.js, and pinned Bun 1.4.2. It uses a POSIX shell on Linux/macOS or WSL on Windows. Linux x86_64 is the tested source-install platform; don't claim other platforms were verified. Router has no native Windows/macOS/ARM binary or npm/container distribution. The manual's upstream recipes install upstream, not Router.
- **Existing server only:** skip installation unless a separate local executable is needed.

Record the selected executable's path and version. Keep the previous command path for rollback.

## 3. Open the right dashboard

For a new instance, create a fresh user-private state directory (mode `0700`) and choose absolute `BETTER_CCFLARE_CONFIG_PATH` and `BETTER_CCFLARE_DB_PATH` paths inside it. Use those same paths for every local CLI invocation and the server. A different port alone does not isolate account storage.

Launch from a clean nested working directory, with a controlled environment: retain only needed tool paths and explicit settings. Exclude ambient `DATABASE_URL`, provider credentials, and inherited Router overrides. Check for `.env` files in the working directory, `../../.env`, and executable directory without reading their contents; choose clean locations rather than modifying someone else's files. Bun source commands also need dotenv autoload disabled. This prevents an unrelated database or deployment configuration being selected.

Use [Start the local server](reference.md#start-the-local-server), adding the explicit private config/database paths and the selected unused port. Set `BETTER_CCFLARE_HOST=127.0.0.1`. Leave the process running for the human; record how to stop only this new process. Open `/dashboard` on that origin and confirm it is the intended instance. An empty account pool can report an unhealthy `/health`; a visible dashboard or health response alone is not completed setup.

For an existing server, open its confirmed dashboard instead. Use **one origin everywhere**: dashboard, client base URL, and CLI `--api-url` for routing/account review. The server defaults to `8080`, while management commands default to `8788`. `--api-url` accepts loopback origins without paths and applies only to routing/account review; local account operations still need matching state paths. For a remote server, use its authenticated dashboard rather than pointing local commands at an unrelated instance.

## 4. Let the human connect an account

In **Accounts > Add Account**, choose the intended provider and follow its authentication flow. Hand browser sign-in and MFA to the human. Have them enter credentials directly in the appropriate secure UI or interactive prompt, never in chat, captured logs, or command arguments.

For **OpenAI-Compatible**, enter the intended endpoint, have the human supply its credential if required, select **Discover models**, choose the **Sonnet Model** mapping, select **Review routing**, acknowledge **I reviewed these routing changes**, then **Create account**. Use the provider's own authentication steps for other account types. Review which accounts/models will be eligible before sending a request. Confirm whether the selected route costs money and get the human's approval before paid usage or overages; if pricing is unclear, pause the request.

For CLI account setup instead, read [First-time Setup](cli.md#first-time-setup) and the [provider modes](cli.md#account-management). Keep the explicit server origin and matching local storage settings. A failed post-create routing review does not undo creation or previously applied routing changes: retain the printed account ID and inspect it rather than create a duplicate.

**Router authentication is separate from provider credentials.** If the human chooses to protect this Router, use the dashboard's API Keys controls. The first active Router key must be an admin key; keep it private. The CLI alternative `--generate-api-key <name>` defaults the first key to admin, with `--admin` as its explicit flag, not `--role`. Key output is secret, so leave that interactive step to the human rather than capturing it. Later inference clients can use appropriately scoped Router keys. Do not expose an unprotected server beyond loopback.

Continue when the account exists and the intended routing review is complete. Waiting for sign-in is a legitimate pause, not a successful installation claim.

## 5. Connect Claude Code and prove the route

Read [Configure Claude SDK](reference.md#configure-claude-sdk) and select the authentication branch that matches the existing client and Router. Prefer a session-scoped `ANTHROPIC_BASE_URL` using the confirmed origin, leaving saved settings and login untouched.

An existing OAuth login and a new `ANTHROPIC_AUTH_TOKEN` conflict. Don't blindly execute the manual's logout alternative. For a protected Router, the client needs a valid **Router** key, not a provider credential: explain the API-key branch and have the human choose it before changing authentication. Have them supply the key privately in the client session. If that would displace a working login, pause for their decision and agree on how to restore it. For a deliberately selected Codex client, use [its separate configuration and restrictions](reference.md#codex-cli-as-a-client); it is not a substitute for testing Anthropic OAuth through Claude Code.

For Anthropic-backed accounts, ask the human to send a small request in a **real interactive Claude Code CLI session**. Only an explicitly operator-approved, bounded, managed gateway-routed headless Claude Code CLI check may substitute. Never probe Anthropic inference using raw curl or a diagnostic script, directly or through Router. Non-Anthropic local/synthetic checks can establish that route's behavior, but are not proof of Anthropic OAuth success.

Match the client request to the dashboard's **Requests** entry by time and request details. Confirm the intended account, actual model, successful status, and completed stream, not just HTTP 200. A health check, account listing, routing preview, or truncated stream is insufficient. If it failed, use [troubleshooting](troubleshooting.md) and report the observed failure without silently switching providers or enabling paid overages.

## 6. Hand back a usable setup

Show the dashboard URL and report:

- Executable path/version and the server origin.
- How to start the client again, stop the new server, and restore prior command/client selection.
- Which settings or files changed, including private state paths but no secrets.
- The account/model and request outcome actually verified, with any verification limits.
- Any remaining human action, such as sign-in or an interactive request.

A waiting human step stays open. Once the request and dashboard checks pass, the human should be able to launch the same setup without repeating installation.
