# wstack Router

Use your AI accounts from one place, and see which account handled each request. wstack Router connects Claude Code to your chosen providers, routes requests across available accounts, and shows usage, costs, and errors in a local dashboard.

## Send this to your AI agent

Copy this into **Claude Code or another coding agent with access to your computer and terminal**. A chat-only assistant can explain the steps, but can't install Router for you.

```text
Help me set up wstack Router for Claude Code.

Read https://github.com/StartupBros/wstack-router/blob/main/docs/agent-setup.md
and follow the setup path that fits my computer. First inspect my operating
system, available tools, and existing Router/Claude Code setup. Preserve my
current settings and login; don't replace a running service or overwrite an
installation. Ask before paid usage. Explain any choice you need me to make.

Do the installation and configuration work you can. Hand browser sign-in,
MFA, and private credentials back to me without putting secrets in chat.
Then verify a real client request went through the intended account and
model, show me the dashboard, and tell me how to launch and undo this setup.
If anything still needs my input, say what remains instead of calling it done.
```

Your agent handles the technical steps; you choose the account and complete its sign-in. This uses Router's existing dashboard and CLI, not a separate installer. Prefer to do it yourself? Open the [manual installation instructions](docs/reference.md#install-the-linux-x86_64-release).

## What it looks like

Say you have two accounts available for coding. You add them to Router and review their routing order. Claude Code sends a request to Router, which picks an eligible account. If that account becomes unavailable, Router can try another eligible account under your routing settings. In **Requests**, you can check the account, model, and outcome rather than guess where the request went.

Router doesn't create more quota or make a paid provider free. If every eligible account is unavailable, the request can still fail. Provider access, billing, and usage rules still apply.

![Router dashboard showing account usage and request activity](apps/lander/src/screenshot-dashboard.png)

[Watch the dashboard walkthrough](https://github.com/user-attachments/assets/c859872f-ca5e-4f8b-b6a0-7cc7461fe62a).

## Will it run on my computer?

- **Linux x86_64:** [Router 3.6.2](https://github.com/StartupBros/wstack-router/releases/tag/v3.6.2) has a standalone binary with a pinned checksum. It doesn't need Node.js or Bun to run.
- **Source builds:** instructions use a POSIX shell on Linux/macOS, or WSL on Windows, with Git, Node.js, and Bun 1.4.2. The source-install acceptance check runs on Linux x86_64; macOS and native Windows installation have not been verified here.
- **Other distributions:** Router does not publish npm packages, container images, or binaries for other platforms. The upstream better-ccflare packages and downloads are a different distribution.

Already running better-ccflare? Use the [migration and rollback guide](docs/wstack-router-migration.md). `better-ccflare` remains a compatible command; existing storage and configuration names stay unchanged.

## Help and contributions

Start with [troubleshooting](docs/troubleshooting.md) or the [documentation index](docs/index.md) for configuration, providers, routing, and deployment. Report Router problems at [StartupBros/wstack-router/issues](https://github.com/StartupBros/wstack-router/issues). Include your platform, version, and the failing step; remove credentials and private request content.

Issues and pull requests are welcome. For non-trivial changes, open an issue first to agree on the approach. See the [contribution guide](docs/contributing.md).

## Acknowledgements

A House of Vibe project from StartupBros, continuing [tombii/better-ccflare](https://github.com/tombii/better-ccflare) and its ancestor [snipeship/ccflare](https://github.com/snipeship/ccflare). Their work and the community's contributions remain credited in the [full acknowledgements](docs/acknowledgements.md), including upstream sponsors.

MIT - See [LICENSE](LICENSE) for details.
