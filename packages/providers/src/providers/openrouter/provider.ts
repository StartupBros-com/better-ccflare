import type { Account } from "@better-ccflare/types";
import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends AnthropicCompatibleProvider {
	constructor() {
		super({
			name: "openrouter",
			baseUrl: OPENROUTER_DEFAULT_ENDPOINT,
			authHeader: "Authorization",
			authType: "bearer",
			supportsStreaming: true,
		});
	}

	override getEndpoint(): string {
		return OPENROUTER_DEFAULT_ENDPOINT;
	}

	override buildUrl(
		pathname: string,
		search: string,
		account?: Account,
	): string {
		const baseUrl = (
			account?.custom_endpoint || OPENROUTER_DEFAULT_ENDPOINT
		).replace(/\/$/, "");

		// OpenRouter's documented Anthropic endpoint is /api/v1/messages.
		// Claude Code sends /v1/messages; concatenating that onto a base that
		// already ends in /v1 produced /api/v1/v1/messages and a 404.
		let path = pathname;
		if (/\/v1$/.test(baseUrl) && (path === "/v1" || path.startsWith("/v1/"))) {
			path = path.slice(3) || "/";
		}

		return `${baseUrl}${path}${search}`;
	}
}
