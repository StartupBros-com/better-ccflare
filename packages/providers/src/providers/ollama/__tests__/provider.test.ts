import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@better-ccflare/types";
import { OllamaProvider } from "../provider";

const SKILL_MARKER = "Base directory for this skill: ";

/** Build marker-bearing text of exactly `totalLength` characters. */
function makeSkillText(dir: string, totalLength: number): string {
	const header = `${SKILL_MARKER}${dir}\n`;
	const body = "x".repeat(Math.max(0, totalLength - header.length));
	return header + body;
}

describe("OllamaProvider", () => {
	const provider = new OllamaProvider();

	const makeAccount = (custom_endpoint: string | null): Account => ({
		id: "ollama-1",
		name: "ollama-test",
		provider: "ollama",
		api_key: null,
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint,
	});

	describe("constructor", () => {
		it("instantiates without errors", () => {
			expect(() => new OllamaProvider()).not.toThrow();
		});
	});

	describe("name", () => {
		it('should be "ollama"', () => {
			expect(provider.name).toBe("ollama");
		});
	});

	describe("getEndpoint", () => {
		it("returns the default Ollama endpoint", () => {
			expect(provider.getEndpoint()).toBe("http://localhost:11434");
		});
	});

	describe("buildUrl", () => {
		it("uses default endpoint when account is missing", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true");
			expect(url).toBe("http://localhost:11434/v1/messages?stream=true");
		});

		it("uses account.custom_endpoint when present", () => {
			const account = makeAccount("http://127.0.0.1:11434");
			const url = provider.buildUrl("/v1/models", "", account);
			expect(url).toBe("http://127.0.0.1:11434/v1/models");
		});

		it("trims trailing slash from custom endpoint", () => {
			const account = makeAccount("http://127.0.0.1:11434/");
			const url = provider.buildUrl("/v1/models", "", account);
			expect(url).toBe("http://127.0.0.1:11434/v1/models");
		});

		it("deduplicates overlapping base path prefix", () => {
			const account = makeAccount("http://localhost:11434/v1");
			const url = provider.buildUrl("/v1/messages", "", account);
			expect(url).toBe("http://localhost:11434/v1/messages");
		});

		it("appends query string", () => {
			const account = makeAccount("http://localhost:11434");
			const url = provider.buildUrl("/v1/messages", "?foo=bar&n=1", account);
			expect(url).toBe("http://localhost:11434/v1/messages?foo=bar&n=1");
		});
	});

	describe("transformRequestBody", () => {
		it("should map model via account.model_mappings exact match", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings: '{"claude-sonnet-4-5":"llama3.1"}',
			};

			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("llama3.1");
		});

		it("should pass through unmapped models unchanged", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings: '{"claude-sonnet-4-5":"llama3.1"}',
			};

			const body = JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("claude-opus-4-6");
		});

		it("should pass through unchanged when request has no model field", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings: '{"claude-sonnet-4-5":"llama3.1"}',
			};

			const body = JSON.stringify({
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBeUndefined();
		});

		it("should apply family-level pattern fallback", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings: '{"sonnet":"llama3.1","opus":"qwen3"}',
			};

			const body = JSON.stringify({
				model: "claude-sonnet-4-5-20250929",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("llama3.1");
		});

		it("should apply family-level fallback for opus models", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings: '{"opus":"qwen3"}',
			};

			const body = JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("qwen3");
		});

		it("should not transform when no account is provided", async () => {
			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(
				request,
				undefined,
			);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("claude-sonnet-4-5");
		});

		it("should not transform when account has no model_mappings", async () => {
			const account = makeAccount(null);

			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("claude-sonnet-4-5");
		});

		it("should prefer exact match over family match", async () => {
			const account: Account = {
				...makeAccount(null),
				model_mappings:
					'{"claude-sonnet-4-5":"llama3.1","claude-opus-4-6":"qwen3","sonnet":"gemma3"}',
			};

			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as { model?: string };

			expect(result.model).toBe("llama3.1");
		});
	});

	describe("skill elision", () => {
		let tmpDir: string;
		const originalConfigPath = process.env.BETTER_CCFLARE_CONFIG_PATH;
		const originalBlocked = process.env.CCFLARE_SKILL_ELISION_BLOCKED;

		beforeEach(() => {
			tmpDir = mkdtempSync(
				join(tmpdir(), "better-ccflare-skill-elision-ollama-"),
			);
			process.env.BETTER_CCFLARE_CONFIG_PATH = join(tmpDir, "config.json");
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
			if (originalConfigPath === undefined) {
				delete process.env.BETTER_CCFLARE_CONFIG_PATH;
			} else {
				process.env.BETTER_CCFLARE_CONFIG_PATH = originalConfigPath;
			}
			if (originalBlocked === undefined) {
				delete process.env.CCFLARE_SKILL_ELISION_BLOCKED;
			} else {
				process.env.CCFLARE_SKILL_ELISION_BLOCKED = originalBlocked;
			}
		});

		it("replaces a blocked skill bundle with the elision stub", async () => {
			process.env.CCFLARE_SKILL_ELISION_BLOCKED = "some-skill";
			const bundleText = makeSkillText("some-skill", 12_000);
			const account = makeAccount(null);
			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [
					{ role: "user", content: [{ type: "text", text: bundleText }] },
				],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as {
				messages: Array<{ content: Array<{ type: string; text: string }> }>;
			};
			const text = result.messages[0].content[0].text;

			expect(text).toContain("[better-ccflare]");
			expect(text).not.toContain(bundleText);
		});

		it("leaves a bundle for a skill not in the blocklist unchanged", async () => {
			process.env.CCFLARE_SKILL_ELISION_BLOCKED = "other-skill";
			const bundleText = makeSkillText("some-skill", 12_000);
			const account = makeAccount(null);
			const body = JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [
					{ role: "user", content: [{ type: "text", text: bundleText }] },
				],
			});
			const request = new Request("http://localhost:8080/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const result = (await transformed.json()) as {
				messages: Array<{ content: Array<{ type: string; text: string }> }>;
			};

			expect(result.messages[0].content[0].text).toBe(bundleText);
		});
	});
});
