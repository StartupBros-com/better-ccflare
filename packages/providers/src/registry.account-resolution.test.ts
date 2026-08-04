import { describe, expect, test } from "bun:test";

import {
	getProvider,
	registerProvider,
	registry,
	resolveProviderForAccount,
} from "./registry";
import type { Provider } from "./types";

function fixtureProvider(name: string): Provider {
	return {
		name,
		canHandle: () => true,
		refreshToken: async () => ({
			accessToken: "token",
			expiresAt: 1,
			refreshToken: "refresh",
		}),
		buildUrl: () => `https://${name}.invalid/v1/messages`,
		prepareHeaders: (headers) => new Headers(headers),
		parseRateLimit: () => ({ isRateLimited: false }),
		processResponse: async (response) => response,
	};
}

describe("resolveProviderForAccount", () => {
	test("uses one alias-aware identity for registered, aliased, and fallback providers", () => {
		const ordinaryName = "u4-ordinary-provider";
		const ordinary = fixtureProvider(ordinaryName);
		const anthropic = fixtureProvider("anthropic");
		const fallback = fixtureProvider("u4-fallback-provider");
		const previousOrdinary = getProvider(ordinaryName);
		const previousAnthropic = getProvider("anthropic");
		registerProvider(ordinary);
		registerProvider(anthropic);

		try {
			expect(resolveProviderForAccount(ordinaryName, fallback)).toBe(ordinary);
			expect(resolveProviderForAccount("claude-console-api", fallback)).toBe(
				anthropic,
			);
			expect(resolveProviderForAccount("u4-missing-provider", fallback)).toBe(
				fallback,
			);
			expect(resolveProviderForAccount("u4-missing-provider")).toBeUndefined();
		} finally {
			registry.unregisterProvider(ordinaryName);
			registry.unregisterProvider("anthropic");
			if (previousOrdinary) registerProvider(previousOrdinary);
			if (previousAnthropic) registerProvider(previousAnthropic);
		}
	});
});
