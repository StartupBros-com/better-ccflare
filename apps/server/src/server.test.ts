import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunSqlAdapter } from "@better-ccflare/database";
import { Logger, logBus } from "@better-ccflare/logger";
import { CODEX_DEFAULT_ENDPOINT } from "@better-ccflare/providers";
import type { LogEvent } from "@better-ccflare/types";
import {
	accountSupportsRefreshBackedUsagePolling,
	bootstrapMinimaxUsagePolling,
	persistForwardOnlyCodexRateLimitReset,
	registerMinimaxUsagePolling,
	resolveDashboardRoute,
	supportsRefreshBackedUsagePolling,
	type UsageCacheRegistrar,
} from "./server";

describe("persistForwardOnlyCodexRateLimitReset", () => {
	it("only advances the reset and preserves a newer concurrent value", async () => {
		const sqlite = new Database(":memory:");
		const db = new BunSqlAdapter(sqlite);
		sqlite.run(
			"CREATE TABLE accounts (id TEXT PRIMARY KEY, rate_limit_reset INTEGER)",
		);
		sqlite.run("INSERT INTO accounts (id, rate_limit_reset) VALUES (?, ?)", [
			"acct-forward",
			null,
		]);

		await persistForwardOnlyCodexRateLimitReset(db, "acct-forward", 2_000);
		expect(
			(
				await db.get<{ rate_limit_reset: number }>(
					"SELECT rate_limit_reset FROM accounts WHERE id = ?",
					["acct-forward"],
				)
			)?.rate_limit_reset,
		).toBe(2_000);

		sqlite.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
			5_000,
			"acct-forward",
		]);
		await persistForwardOnlyCodexRateLimitReset(db, "acct-forward", 3_000);
		expect(
			(
				await db.get<{ rate_limit_reset: number }>(
					"SELECT rate_limit_reset FROM accounts WHERE id = ?",
					["acct-forward"],
				)
			)?.rate_limit_reset,
		).toBe(5_000);

		await persistForwardOnlyCodexRateLimitReset(db, "acct-forward", 6_000);
		expect(
			(
				await db.get<{ rate_limit_reset: number }>(
					"SELECT rate_limit_reset FROM accounts WHERE id = ?",
					["acct-forward"],
				)
			)?.rate_limit_reset,
		).toBe(6_000);
		sqlite.close();
	});
});

describe("supportsRefreshBackedUsagePolling", () => {
	it("includes pollable OAuth providers that need token refresh", () => {
		expect(supportsRefreshBackedUsagePolling("anthropic")).toBe(true);
		expect(supportsRefreshBackedUsagePolling("xai")).toBe(true);
		expect(supportsRefreshBackedUsagePolling("codex")).toBe(true);
	});

	it("does not include providers whose usage is not polled through this path", () => {
		expect(supportsRefreshBackedUsagePolling("qwen")).toBe(false);
		expect(supportsRefreshBackedUsagePolling("nanogpt")).toBe(false);
		expect(supportsRefreshBackedUsagePolling(null)).toBe(false);
	});
});

describe("accountSupportsRefreshBackedUsagePolling", () => {
	it("allows codex accounts with no custom endpoint (defaults to the subscription backend)", () => {
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "codex",
				custom_endpoint: null,
			}),
		).toBe(true);
	});

	it("allows codex accounts explicitly pointed at the subscription backend", () => {
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "codex",
				custom_endpoint: CODEX_DEFAULT_ENDPOINT,
			}),
		).toBe(true);
	});

	it("excludes codex accounts pointed at a custom OpenAI-compatible endpoint", () => {
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "codex",
				custom_endpoint: "https://api.openai.com/v1/responses",
			}),
		).toBe(false);
	});

	it("allows anthropic accounts regardless of custom_endpoint", () => {
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "anthropic",
				custom_endpoint: "https://example.com/whatever",
			}),
		).toBe(true);
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "anthropic",
				custom_endpoint: null,
			}),
		).toBe(true);
	});

	it("excludes providers that don't support refresh-backed usage polling at all", () => {
		expect(
			accountSupportsRefreshBackedUsagePolling({
				provider: "qwen",
				custom_endpoint: null,
			}),
		).toBe(false);
	});
});

describe("registerMinimaxUsagePolling", () => {
	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "minimax-account-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof registerMinimaxUsagePolling>[0];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	it("registers polling for a Minimax account with an API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount(),
			registrar,
			30_000,
		);

		expect(result).toBe(true);
		expect(startPolling).toHaveBeenCalledTimes(1);
		const call = startPolling.mock.calls[0];
		expect(call?.[0]).toBe("acc-1");
		expect(call?.[2]).toBe("minimax");
		expect(call?.[3]).toBe(30_000);
		expect(typeof call?.[1]).toBe("function");
	});

	it("the registered token provider returns the account's API key", async () => {
		const { registrar, startPolling } = makeRegistrar();
		registerMinimaxUsagePolling(
			makeAccount({ api_key: "secret-key" }),
			registrar,
			30_000,
		);

		const tokenProvider = startPolling.mock.calls[0]?.[1];
		expect(await tokenProvider()).toBe("secret-key");
	});

	it("does not register polling for non-Minimax accounts", () => {
		const { registrar, startPolling } = makeRegistrar();
		// The block calls registerMinimaxUsagePolling only for accounts where
		// accounts.filter((a) => a.provider === "minimax") matched, so the
		// helper itself is the load-bearing gate. If the filter goes away and
		// this helper is called for every provider, the false return here is
		// what keeps the wrong accounts from being polled.
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "zai", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "nanogpt", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(
			registerMinimaxUsagePolling(
				makeAccount({ provider: "anthropic", api_key: "k" }),
				registrar,
				30_000,
			),
		).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has no API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: null }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("does not register polling when a Minimax account has an empty API key", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: "" }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});
});

// Greptile #350 P2: when a Minimax account has a null/empty api_key, the
// caller MUST emit a WARN naming the account, so the operator is told the
// real reason ("missing credential") and not the misleading "no Minimax
// accounts found" that the inline bootstrap summary used to print. These
// tests pin the warning emission AND assert that no API key material
// (value, prefix, suffix, full string) leaks into any log output — the
// only account identifier in the message is `account.name` (or `id`).
describe("registerMinimaxUsagePolling — warns on missing API key (Greptile #350 P2)", () => {
	let captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		captured.push(event);
	};

	beforeEach(() => {
		captured = [];
		logBus.on("log", handler);
	});

	afterEach(() => {
		logBus.off("log", handler);
	});

	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "minimax-account-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof registerMinimaxUsagePolling>[0];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	function findWarn(messages: string[]): string | undefined {
		return captured
			.filter((e) => e.level === "WARN")
			.map((e) => e.msg)
			.find((m) => messages.some((needle) => m.includes(needle)));
	}

	it("emits a WARN naming the account when the API key is null", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const result = registerMinimaxUsagePolling(
			makeAccount({ name: "primary", api_key: null }),
			registrar,
			30_000,
			logger,
		);

		expect(result).toBe(false);
		const warn = findWarn(["primary", "no API key"]);
		expect(warn).toBeDefined();
		expect(warn).toMatch(/Minimax account primary has no API key/);
	});

	it("emits a WARN naming the account when the API key is an empty string", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const result = registerMinimaxUsagePolling(
			makeAccount({ name: "secondary", api_key: "" }),
			registrar,
			30_000,
			logger,
		);

		expect(result).toBe(false);
		const warn = findWarn(["secondary", "no API key"]);
		expect(warn).toBeDefined();
		expect(warn).toMatch(/Minimax account secondary has no API key/);
	});

	it("does NOT emit any WARN when a Minimax account has a usable API key", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: "real-key" }),
			registrar,
			30_000,
			logger,
		);

		expect(result).toBe(true);
		const warnings = captured.filter((e) => e.level === "WARN");
		expect(warnings.length).toBe(0);
	});

	it("does NOT emit any WARN when a non-Minimax account is filtered out", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const result = registerMinimaxUsagePolling(
			makeAccount({ name: "zai-row", provider: "zai", api_key: "k" }),
			registrar,
			30_000,
			logger,
		);

		expect(result).toBe(false);
		const warnings = captured.filter((e) => e.level === "WARN");
		expect(warnings.length).toBe(0);
	});

	it("never includes the API key value (or any substring) in any log line", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		// Use a distinctive marker so a substring leak would be unambiguous.
		const MARKER = "SECRET-MARKER-7c1a9f";
		registerMinimaxUsagePolling(
			makeAccount({ name: "leak-check", api_key: null }),
			registrar,
			30_000,
			logger,
		);
		// Re-register with a marker in the key — must NOT appear in any log.
		registerMinimaxUsagePolling(
			makeAccount({ id: "acc-2", name: "with-key", api_key: MARKER }),
			registrar,
			30_000,
			logger,
		);

		const allMessages = captured.map((e) => e.msg).join("\n");
		const allData = JSON.stringify(captured.map((e) => e.data ?? null));
		expect(allMessages).not.toContain(MARKER);
		expect(allData).not.toContain(MARKER);
	});

	it("falls back to account.id when account.name is null/undefined", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const result = registerMinimaxUsagePolling(
			makeAccount({
				id: "id-only-42",
				name: undefined as unknown as string,
				api_key: null,
			}),
			registrar,
			30_000,
			logger,
		);

		expect(result).toBe(false);
		const warn = findWarn(["id-only-42", "no API key"]);
		expect(warn).toBeDefined();
		expect(warn).toMatch(/Minimax account id-only-42 has no API key/);
	});

	it("remains a no-op when no logger is provided (back-compat for existing callers)", () => {
		const { registrar, startPolling } = makeRegistrar();
		const result = registerMinimaxUsagePolling(
			makeAccount({ api_key: null }),
			registrar,
			30_000,
		);

		expect(result).toBe(false);
		expect(startPolling).toHaveBeenCalledTimes(0);
		// No crash, no warning emitted — caller's responsibility to surface.
	});
});

describe("bootstrapMinimaxUsagePolling", () => {
	let captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		captured.push(event);
	};

	beforeEach(() => {
		captured = [];
		logBus.on("log", handler);
	});

	afterEach(() => {
		logBus.off("log", handler);
	});

	function makeAccount(
		overrides: Partial<{
			id: string;
			name: string;
			provider: string;
			api_key: string | null;
		}> = {},
	) {
		return {
			id: "acc-1",
			name: "acc-1",
			provider: "minimax",
			api_key: "test-key",
			...overrides,
		} as unknown as Parameters<typeof bootstrapMinimaxUsagePolling>[0][number];
	}

	function makeRegistrar() {
		const startPolling = mock(
			(
				_accountId: string,
				_tokenProvider: () => Promise<string>,
				_provider: string,
				_intervalMs: number,
			) => {},
		);
		return {
			registrar: { startPolling } as unknown as UsageCacheRegistrar,
			startPolling,
		};
	}

	// This is the regression test for PR #347. The inline bootstrap block in
	// startServer() (around line 1637 pre-refactor) filtered `accounts` for
	// provider === "minimax" and called `registerMinimaxUsagePolling` for each
	// match. The original PR landed a working fetcher + helper but never
	// exercised the wiring path that actually invokes it at startup — mirroring
	// PR #346's "shipped a working fetcher that nothing called" bug. This test
	// pins the wiring: given a realistic mixed-provider account list (the same
	// shape `startServer()` passes), it must register polling for Minimax
	// accounts and nothing else. If the inline bootstrap block in startServer()
	// is removed (and this helper is also removed, since nothing else imports
	// it), the import below fails and every test in this file goes RED.

	it("registers polling for Minimax accounts and ignores other providers", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({ id: "zai-1", name: "zai-1", provider: "zai" }),
			makeAccount({
				id: "minimax-1",
				name: "minimax-1",
				provider: "minimax",
				api_key: "minimax-key-1",
			}),
			makeAccount({ id: "nanogpt-1", name: "nanogpt-1", provider: "nanogpt" }),
			makeAccount({
				id: "minimax-2",
				name: "minimax-2",
				provider: "minimax",
				api_key: "minimax-key-2",
			}),
			makeAccount({
				id: "anthropic-1",
				name: "anthropic-1",
				provider: "anthropic",
			}),
		];

		const registered = bootstrapMinimaxUsagePolling(
			accounts,
			registrar,
			30_000,
		);

		// Only the two Minimax accounts should appear in the registered list,
		// proving the filter on `provider === "minimax"` is actually applied
		// to the full account list, not just whatever the helper receives.
		expect(registered).toEqual(["minimax-1", "minimax-2"]);
		// And the registrar must have been driven exactly twice — once per
		// Minimax account, never for the zai/nanogpt/anthropic rows that are
		// sitting in the same array.
		expect(startPolling).toHaveBeenCalledTimes(2);
		const calledIds = startPolling.mock.calls.map((c) => c[0]);
		expect(calledIds).toEqual(["minimax-1", "minimax-2"]);
	});

	it("does not register polling when the account list has no Minimax accounts", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({ id: "zai-1", provider: "zai" }),
			makeAccount({ id: "nanogpt-1", provider: "nanogpt" }),
			makeAccount({ id: "anthropic-1", provider: "anthropic" }),
		];

		const registered = bootstrapMinimaxUsagePolling(
			accounts,
			registrar,
			30_000,
		);

		expect(registered).toEqual([]);
		expect(startPolling).toHaveBeenCalledTimes(0);
	});

	it("registers polling only for Minimax accounts with API keys and skips the rest", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-no-key",
				name: "no-key",
				provider: "minimax",
				api_key: null,
			}),
			makeAccount({
				id: "minimax-empty-key",
				name: "empty-key",
				provider: "minimax",
				api_key: "",
			}),
			makeAccount({
				id: "minimax-good",
				name: "good",
				provider: "minimax",
				api_key: "real-key",
			}),
		];

		const registered = bootstrapMinimaxUsagePolling(
			accounts,
			registrar,
			30_000,
		);

		expect(registered).toEqual(["minimax-good"]);
		expect(startPolling).toHaveBeenCalledTimes(1);
		expect(startPolling.mock.calls[0]?.[0]).toBe("minimax-good");
	});

	it("forwards the configured interval to every registered Minimax account", () => {
		const { registrar, startPolling } = makeRegistrar();
		const accounts = [
			makeAccount({
				id: "minimax-a",
				name: "a",
				provider: "minimax",
				api_key: "k1",
			}),
			makeAccount({
				id: "minimax-b",
				name: "b",
				provider: "minimax",
				api_key: "k2",
			}),
		];

		bootstrapMinimaxUsagePolling(accounts, registrar, 12_345);

		expect(startPolling).toHaveBeenCalledTimes(2);
		for (const call of startPolling.mock.calls) {
			expect(call[3]).toBe(12_345);
		}
	});

	// Greptile #350 P2 (companion to the registerMinimaxUsagePolling suite):
	// the helper must propagate the logger so per-account WARNs surface from
	// the bootstrap path used by startServer(). Same key-leak guarantee.
	it("emits one WARN per Minimax account missing an API key, naming each account", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const accounts = [
			makeAccount({
				id: "minimax-null",
				name: "alpha",
				provider: "minimax",
				api_key: null,
			}),
			makeAccount({
				id: "minimax-empty",
				name: "beta",
				provider: "minimax",
				api_key: "",
			}),
			makeAccount({
				id: "minimax-good",
				name: "gamma",
				provider: "minimax",
				api_key: "real-key",
			}),
		];

		const registered = bootstrapMinimaxUsagePolling(
			accounts,
			registrar,
			30_000,
			logger,
		);

		expect(registered).toEqual(["minimax-good"]);
		const warnings = captured.filter((e) => e.level === "WARN");
		expect(warnings.length).toBe(2);
		const warningMsgs = warnings.map((e) => e.msg);
		expect(
			warningMsgs.some((m) => m.includes("alpha") && m.includes("no API key")),
		).toBe(true);
		expect(
			warningMsgs.some((m) => m.includes("beta") && m.includes("no API key")),
		).toBe(true);
		expect(warningMsgs.some((m) => m.includes("gamma"))).toBe(false);
	});

	it("does not WARN when no Minimax accounts are present at all", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const accounts = [
			makeAccount({ id: "zai-1", provider: "zai" }),
			makeAccount({ id: "nanogpt-1", provider: "nanogpt" }),
		];

		const registered = bootstrapMinimaxUsagePolling(
			accounts,
			registrar,
			30_000,
			logger,
		);

		expect(registered).toEqual([]);
		const warnings = captured.filter((e) => e.level === "WARN");
		expect(warnings.length).toBe(0);
	});

	it("never leaks the API key value through bootstrap-level WARN emissions", () => {
		const { registrar } = makeRegistrar();
		const logger = new Logger("MinimaxPollingTest");
		const MARKER = "BOOTSTRAP-MARKER-deadbeef";
		const accounts = [
			makeAccount({
				id: "leak-1",
				name: "leak-1",
				provider: "minimax",
				api_key: null,
			}),
			makeAccount({
				id: "leak-2",
				name: "leak-2",
				provider: "minimax",
				api_key: MARKER, // must NOT appear anywhere in any log
			}),
		];

		bootstrapMinimaxUsagePolling(accounts, registrar, 30_000, logger);

		const allMessages = captured.map((e) => e.msg).join("\n");
		const allData = JSON.stringify(captured.map((e) => e.data ?? null));
		expect(allMessages).not.toContain(MARKER);
		expect(allData).not.toContain(MARKER);
	});
});

describe("readShutdownDrainMs", () => {
	const { readShutdownDrainMs, SHUTDOWN_DRAIN_MS_ENV } = require("./server");

	it("defaults to 60s and parses overrides", () => {
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
		expect(readShutdownDrainMs()).toBe(60_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "5000";
		expect(readShutdownDrainMs()).toBe(5_000);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "0";
		expect(readShutdownDrainMs()).toBe(0);
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "nonsense";
		expect(readShutdownDrainMs()).toBe(60_000);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});

	it("rejects numeric prefixes and clamps oversized values", () => {
		const { MAX_SHUTDOWN_DRAIN_MS } = require("./server");
		// parseInt would read "1abc" as a 1ms drain; treat it as invalid.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "1abc";
		expect(readShutdownDrainMs()).toBe(60_000);
		// Values beyond the clamp would overflow setTimeout's 32-bit delay and
		// make the watchdog fire immediately.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "99999999999";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		// Beyond MAX_SAFE_INTEGER must still clamp, not fall back to 60s.
		process.env[SHUTDOWN_DRAIN_MS_ENV] = "9007199254740992";
		expect(readShutdownDrainMs()).toBe(MAX_SHUTDOWN_DRAIN_MS);
		delete process.env[SHUTDOWN_DRAIN_MS_ENV];
	});
});

describe("trackStreamForShutdown", () => {
	const {
		trackStreamForShutdown,
		abortInflightStreams,
		waitForForceCloseSettlement,
		FORCE_CLOSE_SETTLEMENT_BUDGET_MS,
	} = require("./server");

	const endlessResponse = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					controller.enqueue(new TextEncoder().encode("tick\n"));
					await new Promise((r) => setTimeout(r, 20));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);

	it("errors tracked never-ending streams on abort", async () => {
		const wrapped = trackStreamForShutdown(endlessResponse());
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read(); // stream is live
		const first = abortInflightStreams();
		expect(first.aborted).toBe(1);
		await first.settled;
		await expect(
			(async () => {
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
			})(),
		).rejects.toThrow(/drain deadline/);
		// Registry is drained; a second sweep has nothing to abort.
		const second = abortInflightStreams();
		expect(second.aborted).toBe(0);
		await second.settled;
	});

	it("unregisters streams that complete normally", async () => {
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("done"));
						controller.close();
					},
				}),
			),
		);
		expect(await wrapped.text()).toBe("done");
		const result = abortInflightStreams();
		expect(result.aborted).toBe(0);
		await result.settled;
	});

	it("passes non-stream responses through untouched", () => {
		const plain = new Response(null, { status: 204 });
		expect(trackStreamForShutdown(plain)).toBe(plain);
	});

	it("settles aborts after source cancellation instead of a fixed sleep", async () => {
		let cancelResolved = false;
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						controller.enqueue(new TextEncoder().encode("tick\n"));
						await new Promise((resolve) => setTimeout(resolve, 20));
					},
					async cancel() {
						await new Promise((resolve) => setTimeout(resolve, 30));
						cancelResolved = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
		);
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read();

		const { aborted, settled } = abortInflightStreams();
		expect(aborted).toBe(1);
		expect(cancelResolved).toBe(false);
		await settled;
		expect(cancelResolved).toBe(true);
		void reader.cancel().catch(() => {});
	});

	it("waits for cancellation that settles after the graceful drain expires", async () => {
		let cancelResolved = false;
		let pendingRequests = 1;
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode("tick\n"));
					},
					async cancel() {
						await new Promise((resolve) => setTimeout(resolve, 30));
						cancelResolved = true;
						pendingRequests = 0;
					},
				}),
			),
		);
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read();

		const { settled } = abortInflightStreams();
		await waitForForceCloseSettlement(settled, () => pendingRequests, 100);

		expect(cancelResolved).toBe(true);
		expect(pendingRequests).toBe(0);
	});

	it("bounds a hung cancellation by the explicit settlement budget", async () => {
		expect(FORCE_CLOSE_SETTLEMENT_BUDGET_MS).toBe(1_000);
		const neverSettles = new Promise<void>(() => {});
		const startedAt = performance.now();

		await waitForForceCloseSettlement(neverSettles, () => 1, 30);

		const elapsedMs = performance.now() - startedAt;
		expect(elapsedMs).toBeGreaterThanOrEqual(25);
		expect(elapsedMs).toBeLessThan(250);
	});

	it("settles aborts even when source cancellation rejects", async () => {
		const wrapped = trackStreamForShutdown(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode("tick\n"));
					},
					cancel() {
						throw new Error("source cancel failed");
					},
				}),
			),
		);
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("wrapped response lost its body");
		await reader.read();

		const result = abortInflightStreams();
		expect(result.aborted).toBe(1);
		await expect(result.settled).resolves.toBeUndefined();
		await expect(reader.read()).rejects.toThrow(/drain deadline/);
	});
});

describe("resolveDashboardRoute", () => {
	// Extracted from the fetch() handler so the "never shadow an API route,
	// the health endpoint, or a proxy request" invariant is unit testable
	// without booting the server. Dashboard SPA/static serving must happen
	// BEFORE the authentication-gated API router (audit hole #2): exempting
	// these paths inside the shared authenticateRequest() path instead let
	// arbitrary paths reach the proxy unauthenticated when the dashboard was
	// disabled or unavailable.

	it("serves a real bundled asset regardless of method", () => {
		expect(resolveDashboardRoute("/assets/index-abc123.js", "GET", true)).toBe(
			"static-asset",
		);
		expect(resolveDashboardRoute("/assets/index-abc123.js", "POST", true)).toBe(
			"static-asset",
		);
	});

	it("falls back to the SPA index for GET/HEAD dashboard navigations", () => {
		expect(resolveDashboardRoute("/", "GET", false)).toBe("spa-index");
		expect(resolveDashboardRoute("/dashboard", "GET", false)).toBe("spa-index");
		expect(resolveDashboardRoute("/dashboard/accounts", "HEAD", false)).toBe(
			"spa-index",
		);
	});

	it("never shadows /api, /v1, /messages, or /health", () => {
		for (const pathname of [
			"/api/stats",
			"/api",
			"/v1/messages",
			"/messages",
			"/health",
		]) {
			expect(resolveDashboardRoute(pathname, "GET", false)).toBe(
				"pass-through",
			);
		}
	});

	it("passes through non-navigation methods on unknown paths", () => {
		// POST/PUT/DELETE to an arbitrary path must stay authenticated (fall
		// through to the router/proxy) rather than being treated as a
		// dashboard SPA navigation.
		expect(resolveDashboardRoute("/foo", "POST", false)).toBe("pass-through");
		expect(resolveDashboardRoute("/anything/else", "DELETE", false)).toBe(
			"pass-through",
		);
	});
});

// Structural guard: assert that startServer() actually invokes
// bootstrapMinimaxUsagePolling in its source. This is the negative control
// for PR #347 — the previous unit-test guard only failed when the EXPORTED
// HELPER was removed, not when the call site was deleted. The realistic
// regression is someone removing the inline bootstrap block in startServer()
// while the helper still sits in the module unused. With this guard, the
// test goes RED the moment the call site disappears, even if the helper
// stays intact.
//
// Why this is structural and not behavioral: startServer() is a full
// process lifecycle (DB init, network bind, signal handlers, dashboard
// wiring, TLS). It is not realistic to invoke it in a unit test without
// dragging in the whole runtime, so this test reads the source file off
// disk and verifies the invocation is present inside startServer()'s body.
// Brittle to renames of either `startServer` or `bootstrapMinimaxUsagePolling`,
// which is by design — if either name changes, the engineer must update
// this guard and confirm the wiring is still in place.
describe("startServer() wiring guards", () => {
	function readStartServerBody(): string {
		const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
		const match = src.match(
			/export\s+default\s+async\s+function\s+startServer\b/,
		);
		if (!match || match.index === undefined) {
			throw new Error(
				"startServer default export not found in server.ts — update the wiring guard string",
			);
		}
		// startServer's signature is `startServer(options?: { ... }) {`.
		// Skip past the parameter list by tracking paren depth so we don't
		// latch onto the inline type-literal `{` that opens `options?:`.
		let parenDepth = 0;
		let pastParens = -1;
		for (let i = match.index; i < src.length; i++) {
			const ch = src[i];
			if (ch === "(") parenDepth++;
			else if (ch === ")") {
				parenDepth--;
				if (parenDepth === 0) {
					pastParens = i;
					break;
				}
			}
		}
		if (pastParens < 0) {
			throw new Error("startServer parameter list never closed");
		}
		const openIdx = src.indexOf("{", pastParens);
		if (openIdx < 0) {
			throw new Error("startServer body opening brace not found");
		}
		// Balance braces to find the matching close. Template strings,
		// regex literals, and comments can carry unbalanced braces, but
		// server.ts is well-formed enough that a depth counter is reliable
		// for this function — it does not contain raw `{` inside a template
		// that would fool the simple counter.
		let depth = 0;
		for (let i = openIdx; i < src.length; i++) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					return src.slice(openIdx, i + 1);
				}
			}
		}
		throw new Error("startServer body closing brace not found");
	}

	// The regression we are guarding: PR #347 shipped a working fetcher and
	// a working helper, but the inline bootstrap block in startServer() —
	// the actual production wiring — was the thing missing test coverage.
	// Removing that block (lines ~1670-1688 in server.ts) and keeping the
	// helper exported would not have failed the unit tests in this file
	// before this guard landed. With this guard, deleting that block while
	// leaving the helper intact goes RED.
	it("invokes bootstrapMinimaxUsagePolling inside startServer()", () => {
		const body = readStartServerBody();
		// Match an actual call: `<identifier> (`. Just matching the bare
		// identifier would also pass if someone left a stale comment naming
		// the helper, so we require the opening paren.
		expect(body).toMatch(/bootstrapMinimaxUsagePolling\s*\(/);
	});

	it("passes accounts, usageCache, and the configured poll interval to bootstrapMinimaxUsagePolling", () => {
		const body = readStartServerBody();
		// Check that the call site carries the same arguments the surrounding
		// zai/kilo blocks pass. This catches the regression where someone
		// replaces the full call with a stub like `bootstrapMinimaxUsagePolling()`
		// that compiles and lints but never actually wires the cache.
		const call = body.match(/bootstrapMinimaxUsagePolling\s*\(([\s\S]*?)\)/);
		expect(call).not.toBeNull();
		const args = call?.[1] ?? "";
		// Trim and split on top-level commas (no nested parens expected
		// inside the 3-arg call, but be conservative).
		const argList = args
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		expect(argList.length).toBe(3);
		// First two arguments must be the live runtime objects, not the
		// string literals "accounts" / "usageCache".
		expect(argList[0]).toBe("accounts");
		expect(argList[1]).toBe("usageCache");
		// Third argument must flow through the configured poll interval —
		// i.e. not a hardcoded numeric literal.
		expect(argList[2]).not.toMatch(/^\d+$/);
	});
});
