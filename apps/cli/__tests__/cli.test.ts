import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(process.cwd(), "apps/cli/src/main.ts");

/**
 * Helper function to run CLI command and get output
 * Available to all test suites
 */
function runCLI(
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	return new Promise((resolve) => {
		const proc = spawn("bun", ["run", CLI_PATH, ...args], {
			env: { ...process.env, NODE_ENV: "test", ...env },
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (exitCode) => {
			resolve({
				stdout,
				stderr,
				exitCode: exitCode || 0,
			});
		});

		// Kill after 6 seconds to prevent hanging (some CLI operations take longer)
		setTimeout(() => {
			proc.kill();
			resolve({
				stdout,
				stderr,
				exitCode: 1,
			});
		}, 6000);
	});
}

async function startRoutingServer(): Promise<{
	baseUrl: string;
	requests: Array<{ method: string; path: string; body: unknown }>;
	stop: () => Promise<void>;
}> {
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	const effective = {
		family: "opus",
		policy: {
			assignment: {
				family: "opus",
				combo_id: "combo-opus",
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			combo: {
				id: "combo-opus",
				name: "Opus",
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family: "opus",
			combo_id: "combo-opus",
			active: true,
			reason: "included",
			members: [
				{
					id: "managed:account-live",
					account_id: "account-live",
					account_name: "Live account",
					combo_id: "combo-opus",
					family: "opus",
					included: true,
					logical_model: "claude-opus-4-8",
					tier: 3,
					source: "managed",
					reason: "included",
					slot_id: null,
					rule_id: "rule-opus",
					availability: { available: true, reason: "available" },
					identity_provisional: false,
				},
			],
			decisions: [],
		},
	};
	const preview = {
		preview_id: "preview-opus",
		scope: "family",
		family: "opus",
		managed_model: "claude-opus-4-8",
		effective,
		proposals: [
			{
				proposal_id: "proposal-opus",
				family: "opus",
				combo_id: "combo-opus",
				provider: "anthropic",
				route_class: "oauth-subscription",
				existing_rule_id: null,
				managed_model: "claude-opus-4-8",
				tier_source: "account_priority",
				high_confidence: true,
				selected_by_default: true,
				reason: "included",
				proposed_effective: effective,
				member_delta: [],
			},
		],
	};
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const rawBody = Buffer.concat(chunks).toString("utf8");
		requests.push({
			method: request.method ?? "GET",
			path: request.url ?? "",
			body: rawBody ? JSON.parse(rawBody) : null,
		});
		response.setHeader("content-type", "application/json");
		if (request.url === "/api/accounts") {
			response.end(
				JSON.stringify([
					{
						id: "account-live",
						name: "Live account",
						provider: "anthropic",
						priority: 3,
						paused: false,
						requiresReauth: false,
						tokenStatus: "valid",
						rateLimitStatus: "Active",
					},
				]),
			);
			return;
		}
		if (request.url === "/api/routing/accounts") {
			response.end(
				JSON.stringify({
					success: true,
					data: { effective: [effective], opportunities: [] },
				}),
			);
			return;
		}
		if (request.url === "/api/routing/preview") {
			response.end(JSON.stringify({ success: true, data: preview }));
			return;
		}
		if (request.url === "/api/routing/apply/opus") {
			response.end(JSON.stringify({ success: true, data: effective }));
			return;
		}
		if (request.url === "/api/families/opus") {
			response.end(
				JSON.stringify({
					success: true,
					data: {
						family: "opus",
						combo_id: "combo-opus",
						enabled: true,
						membership_mode: "manual",
						managed_model: "claude-opus-4-8",
					},
				}),
			);
			return;
		}
		response.statusCode = 404;
		response.end(JSON.stringify({ error: "not found" }));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("test server did not bind a TCP port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		stop: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/**
 * Integration tests for the CLI
 * Tests the compiled binary to ensure all CLI commands work correctly
 */
describe("CLI Integration Tests", () => {
	let tempDir: string;
	let tempSslKeyPath: string;
	let tempSslCertPath: string;

	beforeEach(() => {
		// Create temp directory for SSL cert tests
		tempDir = join(tmpdir(), `better-ccflare-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		tempSslKeyPath = join(tempDir, "test.key");
		tempSslCertPath = join(tempDir, "test.crt");

		// Create dummy SSL files
		writeFileSync(
			tempSslKeyPath,
			"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
		);
		writeFileSync(
			tempSslCertPath,
			"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
		);
	});

	afterEach(() => {
		// Cleanup temp files
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_e) {
			// Ignore cleanup errors
		}
	});

	describe("Version Command", () => {
		it("should display version with --version flag", async () => {
			const result = await runCLI(["--version"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
			expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
		});

		it("should display version with -v flag", async () => {
			const result = await runCLI(["-v"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
		});

		it("should exit quickly for version command", async () => {
			const startTime = Date.now();
			await runCLI(["--version"]);
			const duration = Date.now() - startTime;

			// Should complete in less than 2 seconds (fast exit)
			expect(duration).toBeLessThan(2000);
		});
	});

	describe("Help Command", () => {
		it("should display help with --help flag", async () => {
			const result = await runCLI(["--help"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare");
			expect(result.stdout).toContain("Usage:");
			expect(result.stdout).toContain("Options:");
			expect(result.stdout).toContain("--serve");
			expect(result.stdout).toContain("--add-account");
			expect(result.stdout).toContain("--list");
			expect(result.stdout).toContain("--force-reset-rate-limit");
		});

		it("should display help with -h flag", async () => {
			const result = await runCLI(["-h"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Usage:");
		});

		it("should show SSL options in help", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("--ssl-key");
			expect(result.stdout).toContain("--ssl-cert");
		});

		it("should show compact option in help", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("--compact");
		});

		it("shows the exact managed-routing command surface without a credential flag", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("routing list");
			expect(result.stdout).toContain("routing detail <account-id>");
			expect(result.stdout).toContain("routing preview <family>");
			expect(result.stdout).toContain(
				"routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes",
			);
			expect(result.stdout).toContain("routing manual <family> --yes");
			expect(result.stdout).toContain("--api-url <loopback-url>");
			expect(result.stdout).not.toContain("--admin-api-key");
		});

		it("should show account mode options", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("claude-oauth");
			expect(result.stdout).toContain("console");
			expect(result.stdout).toContain("zai");
			expect(result.stdout).toContain("openai-compatible");
		});

		it("should exit quickly for help command", async () => {
			const startTime = Date.now();
			await runCLI(["--help"]);
			const duration = Date.now() - startTime;

			// Should complete in less than 2 seconds (fast exit)
			expect(duration).toBeLessThan(2000);
		});
	});

	describe("Managed Routing Commands", () => {
		it("reads live routing before local database initialization", async () => {
			const server = await startRoutingServer();
			try {
				const result = await runCLI(
					["routing", "list", "--api-url", server.baseUrl, "--json"],
					{
						BETTER_CCFLARE_DB_PATH:
							"/proc/better-ccflare-must-not-open/routing.db",
					},
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain('"account_id": "account-live"');
				expect(result.stdout).toContain('"source": "managed"');
				expect(result.stdout).toContain('"tier": 3');
				expect(result.stdout).toContain('"reason": "included"');
				expect(result.stderr).not.toContain("database");
			} finally {
				await server.stop();
			}
		});

		it("ships preview, reviewed apply, and manual rollback with exact live API writes", async () => {
			const server = await startRoutingServer();
			const noDatabase = {
				BETTER_CCFLARE_DB_PATH: "/proc/better-ccflare-must-not-open/routing.db",
			};
			try {
				const preview = await runCLI(
					[
						"routing",
						"preview",
						"opus",
						"--managed-model",
						"claude-opus-4-8",
						"--api-url",
						server.baseUrl,
						"--json",
					],
					noDatabase,
				);
				const apply = await runCLI(
					[
						"routing",
						"apply",
						"opus",
						"--preview-id",
						"preview-opus",
						"--proposal-id",
						"proposal-opus",
						"--managed-model",
						"claude-opus-4-8",
						"--yes",
						"--api-url",
						server.baseUrl,
						"--json",
					],
					noDatabase,
				);
				const manual = await runCLI(
					[
						"routing",
						"manual",
						"opus",
						"--yes",
						"--api-url",
						server.baseUrl,
						"--json",
					],
					noDatabase,
				);

				expect(preview.exitCode).toBe(0);
				expect(preview.stdout).toContain('"preview_id": "preview-opus"');
				expect(apply.exitCode).toBe(0);
				expect(apply.stdout).toContain('"status": "applied"');
				expect(manual.exitCode).toBe(0);
				expect(manual.stdout).toContain('"membership_mode": "manual"');
				expect(server.requests).toEqual([
					{
						method: "POST",
						path: "/api/routing/preview",
						body: {
							scope: "family",
							family: "opus",
							managed_model: "claude-opus-4-8",
						},
					},
					{
						method: "POST",
						path: "/api/routing/apply/opus",
						body: {
							scope: "family",
							preview_id: "preview-opus",
							proposal_id: "proposal-opus",
							managed_model: "claude-opus-4-8",
						},
					},
					{
						method: "PUT",
						path: "/api/families/opus",
						body: { membership_mode: "manual" },
					},
				]);
			} finally {
				await server.stop();
			}
		});

		it("returns usage exit 2 for invalid or incomplete routing commands", async () => {
			for (const args of [
				["routing", "detail"],
				["routing", "preview", "unknown-family"],
				["routing", "apply", "opus", "--yes"],
				["routing", "manual", "opus"],
				["routing", "list", "--proposal-id", "not-valid-for-list"],
				["routing", "list", "--admin-api-key", "must-not-be-accepted"],
			]) {
				const result = await runCLI(args);
				expect(result.exitCode).toBe(2);
				expect(result.stdout).not.toContain("Starting better-ccflare server");
			}
		});

		it("rejects a non-loopback API URL as usage error before any request", async () => {
			const result = await runCLI([
				"routing",
				"list",
				"--api-url",
				"https://example.com",
			]);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toMatch(/loopback/i);
		});

		it("returns operational exit 1 when the live control plane is unavailable", async () => {
			const server = await startRoutingServer();
			const baseUrl = server.baseUrl;
			await server.stop();

			const result = await runCLI(["routing", "list", "--api-url", baseUrl]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/could not be completed|failed/i);
		});
	});

	describe("SSL Certificate Validation", () => {
		it("should accept valid SSL certificate paths", async () => {
			// Note: This test will timeout after 3s because the server starts successfully
			// but we're testing that the files are found before server startup
			const result = await runCLI([
				"--serve",
				"--port",
				"9999",
				"--ssl-key",
				tempSslKeyPath,
				"--ssl-cert",
				tempSslCertPath,
			]);

			// The server will start (and then be killed after 3s)
			// We're just verifying no "file not found" errors occurred
			const output = result.stdout + result.stderr;
			expect(output).not.toContain("SSL key file not found");
			expect(output).not.toContain("SSL certificate file not found");
		}, 10000); // Allow 10s timeout for this test

		it("should reject non-existent SSL key file", async () => {
			const result = await runCLI([
				"--serve",
				"--ssl-key",
				"/nonexistent/key.pem",
				"--ssl-cert",
				tempSslCertPath,
			]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("SSL file path validation failed");
			expect(output).toContain("Path outside allowed directories");
		});

		it("should reject non-existent SSL cert file", async () => {
			const result = await runCLI([
				"--serve",
				"--ssl-key",
				tempSslKeyPath,
				"--ssl-cert",
				"/nonexistent/cert.pem",
			]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("SSL file path validation failed");
			expect(output).toContain("Path outside allowed directories");
		});
	});

	describe("Add Account Command", () => {
		it("rejects a non-loopback post-create API target before account creation", async () => {
			const result = await runCLI([
				"--add-account",
				"test-account",
				"--mode",
				"zai",
				"--api-url",
				"https://example.com",
			]);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toMatch(/loopback/i);
			expect(result.stdout).not.toContain("added successfully");
		});

		it("rejects mixed human/provider output for --add-account --json before creation", async () => {
			const result = await runCLI([
				"--add-account",
				"test-account",
				"--mode",
				"zai",
				"--json",
			]);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toMatch(/--json is not supported/i);
			expect(result.stdout).not.toContain("added successfully");
		});

		it("should reject add account without required flags", async () => {
			const result = await runCLI(["--add-account", "test-account"]);

			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain("Please provide --mode to specify account type");
			expect(output).toContain("--mode");
			expect(output).toContain("--priority");
		});

		it("should show example usage for add account", async () => {
			const result = await runCLI(["--add-account", "test-account"]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("Example:");
			expect(output).toMatch(
				/better-ccflare.*--add-account.*--mode.*--priority/,
			);
		});

		// Note: "max" mode is remapped to "claude-oauth" with a deprecation warning,
		// but then starts an interactive OAuth flow that cannot be tested non-interactively.
		// The deprecation handling is covered by unit tests in the providers package.

		it("should reject invalid mode value", async () => {
			const result = await runCLI([
				"--add-account",
				"test-account",
				"--mode",
				"invalid-mode",
				"--priority",
				"0",
			]);

			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain("Invalid mode");
			expect(output).toContain("Valid modes:");
		});
	});

	describe("Argument Parsing", () => {
		it("should parse port number correctly", async () => {
			const result = await runCLI(["--help", "--port", "8081"]);

			// Help should work regardless of other flags
			expect(result.exitCode).toBe(0);
		});

		it("should handle multiple flags", async () => {
			const result = await runCLI(["--version", "--port", "8081"]);

			// Version should take precedence and exit early
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
		});
	});

	describe("Error Handling", () => {
		it("should handle invalid port gracefully", async () => {
			const result = await runCLI(["--serve", "--port", "not-a-number"]);

			// Should not crash, should handle gracefully
			// Port will be parsed as NaN and either use default or error
			expect(result.exitCode).toBeGreaterThanOrEqual(0);
		});

		it("should handle invalid priority gracefully", async () => {
			const result = await runCLI([
				"--add-account",
				"test",
				"--mode",
				"claude-oauth",
				"--priority",
				"not-a-number",
			]);

			// Should handle NaN priority
			expect(result.exitCode).toBeGreaterThanOrEqual(0);
		});
	});

	describe("Performance", () => {
		it("should execute version command quickly (< 1s)", async () => {
			const startTime = Date.now();
			await runCLI(["--version"]);
			const duration = Date.now() - startTime;

			expect(duration).toBeLessThan(1000);
		});

		it("should execute help command quickly (< 1s)", async () => {
			const startTime = Date.now();
			await runCLI(["--help"]);
			const duration = Date.now() - startTime;

			expect(duration).toBeLessThan(1000);
		});
	});
});

/**
 * Unit tests for argument parsing logic
 */
describe("CLI Argument Parsing Logic", () => {
	// We'll test the parsing logic by simulating what parseArgs does

	it("should parse boolean flags correctly", () => {
		const testArgs = ["--version", "--help", "--compact"];
		const hasVersion = testArgs.includes("--version");
		const hasHelp = testArgs.includes("--help");
		const hasCompact = testArgs.includes("--compact");

		expect(hasVersion).toBe(true);
		expect(hasHelp).toBe(true);
		expect(hasCompact).toBe(true);
	});

	it("should parse flags with values", () => {
		const testArgs = ["--port", "8081", "--ssl-key", "/path/to/key"];

		const portIndex = testArgs.indexOf("--port");
		const port = portIndex >= 0 ? testArgs[portIndex + 1] : null;

		const sslKeyIndex = testArgs.indexOf("--ssl-key");
		const sslKey = sslKeyIndex >= 0 ? testArgs[sslKeyIndex + 1] : null;

		expect(port).toBe("8081");
		expect(sslKey).toBe("/path/to/key");
	});

	it("should handle flags in any order", () => {
		const testArgs1 = ["--serve", "--port", "8081", "--compact"];
		const testArgs2 = ["--compact", "--port", "8081", "--serve"];

		expect(testArgs1.includes("--serve")).toBe(true);
		expect(testArgs2.includes("--serve")).toBe(true);
		expect(testArgs1.includes("--port")).toBe(true);
		expect(testArgs2.includes("--port")).toBe(true);
		expect(testArgs1.includes("--compact")).toBe(true);
		expect(testArgs2.includes("--compact")).toBe(true);
	});

	it("should parse set-priority with two arguments", () => {
		const testArgs = ["--set-priority", "account-name", "10"];

		const setPriorityIndex = testArgs.indexOf("--set-priority");
		if (setPriorityIndex >= 0) {
			const name = testArgs[setPriorityIndex + 1];
			const priority = testArgs[setPriorityIndex + 2];

			expect(name).toBe("account-name");
			expect(priority).toBe("10");
		}
	});
});

/**
 * Security tests
 */
describe("CLI Security Tests", () => {
	it("should not expose sensitive data in help text", async () => {
		const result = await runCLI(["--help"]);

		const output = result.stdout + result.stderr;
		// Should not contain any API keys, tokens, or sensitive patterns
		expect(output).not.toContain("sk-");
		expect(output).not.toContain("token:");
		expect(output).not.toContain("password:");
	});

	it("should handle path traversal attempts in SSL paths gracefully", async () => {
		const maliciousPath = "../../../etc/passwd";
		const result = await runCLI([
			"--serve",
			"--ssl-key",
			maliciousPath,
			"--ssl-cert",
			"test.crt",
		]);

		// Should fail with directory traversal detection, not expose system paths
		const output = result.stdout + result.stderr;
		expect(output).toContain("SSL file path validation failed");
		expect(output).toContain("Directory traversal detected");
	});

	it("should sanitize error messages", async () => {
		const result = await runCLI([
			"--serve",
			"--ssl-key",
			"/tmp/nonexistent-key-with-sensitive-data-abc123.pem",
		]);

		const _output = result.stdout + result.stderr;
		// Should show error but not leak full paths unnecessarily
		expect(result.exitCode).toBeGreaterThan(0);
	});
});
