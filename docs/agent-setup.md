# Set up Router with an agent

For a coding agent with computer and terminal access, helping a human connect Claude Code to HoV Router. Choose client-only or new-host setup **before installing anything**. Installation commands live in the [technical reference](reference.md), not here. Finish with a working client request and matching dashboard evidence, directly or with the owner's help; otherwise name the evidence or human step still needed.

Use `hov-router` for current builds; `wstack-router` and `better-ccflare` remain compatible commands. The public home is `StartupBros/hov-router`, renamed from `StartupBros/wstack-router` on 2026-10-21 with the same repository ID `1278801682`. Use the current home in guide, clone, download, and support URLs. Keep the local clone directory `better-ccflare`. Published 3.6.2 still reports `wstack Router v3.6.2` through every alias; preserve its historical verification pins. HoV Router and hovstack are independent House of Vibe projects; no hovstack installation is needed.

## 1. Choose the setup path

Inspect the intended Claude Code client, its OS, and relevant non-secret settings narrowly. Determine the intended server's owner, origin (scheme, hostname, port), and purpose from known configuration or the human. Do not scan the LAN or tailnet for servers, enumerate credential stores, or dump environment variables, account databases, or client configuration into chat. If ownership or purpose is unclear, stop for clarification rather than taking over a server.

- **Existing local or shared server:** use [Shared client only](#shared-client-only). One central Router can serve many clients over Tailscale. Do not assume this computer needs to host another instance.
- **New local host:** inspect server OS/architecture, installed tools, command locations, and local listening ports. Use a separate installation and private state with an unused loopback port. Keep existing executables, services, account data, client settings, and login intact. Continue at [Install without replacing anything](#2-install-without-replacing-anything).

Ask only for choices inspection cannot resolve. Autostart, shell-profile edits, system services, remote exposure, and existing-server changes require a separate decision. Read [migration and rollback](wstack-router-migration.md#what-stays-the-same) before changing an existing command selection.

### Shared client only

1. Confirm the existing Router origin and approved use with its owner. For a remote Router, use the supplied private Tailscale name/address, not localhost or a guessed port; for an existing local Router, retain its confirmed loopback origin. Confirm this client can reach that origin over the intended private connection; if not, report the reachability blocker without changing the server, firewall, or tailnet policy. Tailscale membership is network access, not Router authentication.
2. Confirm the owner's authentication requirements and intended account/model route. Reuse an already-working configured Router authentication arrangement; do not request disclosure, replacement, or rotation of an existing key. Only if a key is missing or needed for a protected Router, have the owner supply an inference-scoped Router key privately, not a provider credential or admin key. Never put it in chat or captured logs. The owner retains provider sign-in, account creation, routing changes, and server administration. If access or the route needs changing, stop for that separate owner action.
3. Skip sections 2–4 entirely. Do not install a Router executable, create local Router state or a database, log in to a provider, create accounts, change routing, or start/stop/restart any Router process. Client OS compatibility is separate from server distribution support; neither a macOS nor a Windows client needs a matching Router binary. Private native test builds do not establish public release availability.
4. Continue at [Connect Claude Code and prove the route](#5-connect-claude-code-and-prove-the-route), preserving saved settings and any working OAuth login. Use the confirmed origin for the client and `/dashboard`. Remote dashboard data may require admin privileges: do not give an inference client an admin key merely to open it. Ask the owner to check the matching request instead, and report verification as pending until that evidence arrives.
5. [Hand back the setup](#6-hand-back-a-usable-setup) with client launch and rollback instructions only. Disconnecting a client must not stop or reconfigure the shared server.

## 2. Install without replacing anything

**New hosts only.** Shared clients skip directly to [client configuration](#5-connect-claude-code-and-prove-the-route).

- **Linux x86_64:** follow [the verified 3.6.2 binary installation](reference.md#install-the-linux-x86_64-release). Check its pinned checksum before execution; offer [signed provenance verification](wstack-router-releases.md#optional-consumer-provenance-verification) before the first run. Stop on a failed download or verification. Existing paths are intentionally refused, not overwritten. [PATH aliases](reference.md#optional-add-commands-to-path) are optional; using the full executable path is enough.
- **Source build:** follow [Install from source](reference.md#install-from-source), including Git, Node.js, and pinned Bun 1.4.2. It uses a POSIX shell on Linux/macOS or WSL on Windows. Linux x86_64 is the tested source-install platform; don't claim other platforms were verified. Router has no native Windows/macOS/ARM binary or npm/container distribution. The manual's upstream recipes install upstream, not Router.

Record the selected executable's path and version. Keep the previous command path for rollback.

## 3. Open the right dashboard

For a new instance, create a fresh user-private state directory (mode `0700`) and choose absolute `BETTER_CCFLARE_CONFIG_PATH` and `BETTER_CCFLARE_DB_PATH` paths inside it. Use those same paths for every local CLI invocation and the server. A different port alone does not isolate account storage.

Launch from a clean nested working directory, with a controlled environment: retain only needed tool paths and explicit settings. Exclude ambient `DATABASE_URL`, provider credentials, and inherited Router overrides. Check for `.env` files in the working directory, `../../.env`, and executable directory without reading their contents; choose clean locations rather than modifying someone else's files. Bun source commands also need dotenv autoload disabled. This prevents an unrelated database or deployment configuration being selected.

Use [Start the local server](reference.md#start-the-local-server), adding the explicit private config/database paths and the selected unused port. Set `BETTER_CCFLARE_HOST=127.0.0.1`. Leave the process running for the human; record how to stop only this new process. Open `/dashboard` on that origin and confirm it is the intended instance. An empty account pool can report an unhealthy `/health`; a visible dashboard or health response alone is not completed setup.

For this new host, use **one origin everywhere**: dashboard, client base URL, and CLI `--api-url` for routing/account review. The server defaults to `8080`, while management commands default to `8788`. `--api-url` accepts loopback origins without paths and applies only to routing/account review; local account operations still need matching state paths. Shared clients must not use these local management commands against an unrelated instance.

## 4. Let the human connect an account

**New hosts only.** Shared clients use the owner's existing accounts and routing; they do not repeat provider setup.

In **Accounts > Add Account**, choose the intended provider and follow its authentication flow. Hand browser sign-in and MFA to the human. Have them enter credentials directly in the appropriate secure UI or interactive prompt, never in chat, captured logs, or command arguments.

For **OpenAI-Compatible**, enter the intended endpoint, have the human supply its credential if required, select **Discover models**, choose the **Sonnet Model** mapping, select **Review routing**, acknowledge **I reviewed these routing changes**, then **Create account**. Use the provider's own authentication steps for other account types. Review which accounts/models will be eligible before sending a request. Confirm whether the selected route costs money and get the human's approval before paid usage or overages; if pricing is unclear, pause the request.

For CLI account setup instead, read [First-time Setup](cli.md#first-time-setup) and the [provider modes](cli.md#account-management). Keep the explicit server origin and matching local storage settings. A failed post-create routing review does not undo creation or previously applied routing changes: retain the printed account ID and inspect it rather than create a duplicate.

**Router authentication is separate from provider credentials.** If the human chooses to protect this Router, use the dashboard's API Keys controls. The first active Router key must be an admin key; keep it private. The CLI alternative `--generate-api-key <name>` defaults the first key to admin, with `--admin` as its explicit flag, not `--role`. Key output is secret, so leave that interactive step to the human rather than capturing it. Later inference clients can use appropriately scoped Router keys. Do not expose an unprotected server beyond loopback.

Continue when the account exists and the intended routing review is complete. Waiting for sign-in is a legitimate pause, not a successful installation claim.

## 5. Connect Claude Code and prove the route

Read [Configure Claude SDK](reference.md#configure-claude-sdk) and select the authentication branch that matches the existing client and Router. Prefer a session-scoped `ANTHROPIC_BASE_URL` using the confirmed origin, leaving saved settings and login untouched.

An existing OAuth login and a new `ANTHROPIC_AUTH_TOKEN` conflict. Don't blindly execute the manual's logout alternative. For a protected Router, the client needs a valid **Router** key, not a provider credential: explain the API-key branch and have the human choose it before changing authentication. Reuse working Router authentication; only if a key is needed, have them supply it privately in the client session. If that would displace a working login, pause for their decision and agree on how to restore it. For a deliberately selected Codex client, use [its separate configuration and restrictions](reference.md#codex-cli-as-a-client); it is not a substitute for testing Anthropic OAuth through Claude Code.

Before sending, confirm the selected route's cost and get approval for paid usage or overages; if pricing is unclear, pause.

For Anthropic-backed accounts, ask the human to send a small request in a **real interactive Claude Code CLI session**. Only an explicitly operator-approved, bounded, managed gateway-routed headless Claude Code CLI check may substitute. Never probe Anthropic inference using raw curl or a diagnostic script, directly or through Router. Non-Anthropic local/synthetic checks can establish that route's behavior, but are not proof of Anthropic OAuth success.

Match the client request to the dashboard's **Requests** entry by time and request details, with owner assistance if access is restricted. Confirm the intended account, actual model, successful status, and completed stream, not just HTTP 200. If the client succeeds but the owner has not supplied matching evidence, report client success with route verification pending. A health check, account listing, routing preview, or truncated stream is insufficient. If it failed, use [troubleshooting](troubleshooting.md) and report the observed failure without silently switching providers or enabling paid overages.

## 6. Hand back a usable setup

Show the dashboard URL and report:

- Setup type (shared client or new host), client launch command, and confirmed server origin/owner. Record the Router executable path/version only for a new host; client-only setup adds no local Router installation.
- How to start the client again and restore prior client settings/login. Only for a new host, include how to stop the process you started and restore prior Router command selection; never stop the shared server.
- Which settings or files changed, including private state paths for a new host but no secrets. For client-only setup, confirm no local Router state or server configuration was changed.
- The account/model and request outcome actually verified, with any verification limits.
- Any remaining human action, such as sign-in or an interactive request.

A waiting human step stays open. Once the request and dashboard checks pass, the human should be able to launch the same setup without repeating installation.
