import type { Account } from "@better-ccflare/types";
import { OpenRouterProvider } from "../provider";

describe("OpenRouterProvider", () => {
	let provider: OpenRouterProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new OpenRouterProvider();
		mockAccount = {
			id: "test-id",
			name: "test-openrouter-account",
			provider: "openrouter",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: "test-api-key",
			custom_endpoint: null,
			rate_limited_until: null,
			rate_limit_status: null,
			rate_limit_reset: null,
			rate_limit_remaining: null,
			created_at: Date.now(),
			last_used: null,
			request_count: 0,
			total_requests: 0,
			session_start: null,
			session_request_count: 0,
			paused: false,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
		};
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("openrouter");
		});
	});

	describe("buildUrl", () => {
		it("should join Claude Code /v1/messages onto OpenRouter's /api/v1 base without duplicating /v1", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://openrouter.ai/api/v1/messages");
		});

		it("should join /v1/messages/count_tokens without duplicating /v1", () => {
			const url = provider.buildUrl(
				"/v1/messages/count_tokens",
				"",
				mockAccount,
			);
			expect(url).toBe("https://openrouter.ai/api/v1/messages/count_tokens");
		});

		it("should include query string", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe("https://openrouter.ai/api/v1/messages?stream=true");
		});

		it("should dedupe /v1 when a custom endpoint already ends with /api/v1", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://openrouter.ai/api/v1",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe("https://openrouter.ai/api/v1/messages");
		});

		it("should strip a trailing slash from the custom endpoint before joining", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://openrouter.ai/api/v1/",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe("https://openrouter.ai/api/v1/messages");
		});

		it("should keep the incoming /v1 prefix when the custom endpoint has no version suffix", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://openrouter.example.com",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe("https://openrouter.example.com/v1/messages");
		});
	});
});
