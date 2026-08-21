import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isOfficialXaiEndpoint, resolveXaiContextWindow } from "./xai";

describe("resolveXaiContextWindow", () => {
	it("resolves grok-4.5 and grok-4.6 at the official 500k window", () => {
		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
		expect(resolveXaiContextWindow("grok-4.5")).toEqual({
			family: "grok-4.5",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("resolves dated or suffixed grok-4.6 variants by the longest family prefix", () => {
		expect(resolveXaiContextWindow("grok-4.6-beta")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "prefix",
		});
	});

	it("does not treat original grok-4 as a 500k model", () => {
		expect(resolveXaiContextWindow("grok-4")).toBeUndefined();
		expect(resolveXaiContextWindow("grok-4-0709")).toBeUndefined();
	});

	it("returns undefined for empty or unrelated model ids", () => {
		expect(resolveXaiContextWindow("")).toBeUndefined();
		expect(resolveXaiContextWindow("gpt-5.6-sol")).toBeUndefined();
		expect(resolveXaiContextWindow("claude-fable-5")).toBeUndefined();
	});
});

describe("isOfficialXaiEndpoint", () => {
	const xaiAccount = (overrides: Partial<Account> = {}): Account =>
		({
			id: "xai-1",
			name: "xai-test",
			provider: "xai",
			custom_endpoint: null,
			...overrides,
		}) as Account;

	it("returns true for an xAI account with no custom endpoint (default is official)", () => {
		expect(isOfficialXaiEndpoint(xaiAccount())).toBe(true);
	});

	it("returns true for an xAI account with the official endpoint", () => {
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({ custom_endpoint: "https://api.x.ai/v1" }),
			),
		).toBe(true);
	});

	it("returns false for an xAI account with a non-official endpoint", () => {
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({ custom_endpoint: "https://proxy.example.com/v1" }),
			),
		).toBe(false);
	});

	it("returns false for an xAI account with a malformed endpoint (does not throw)", () => {
		expect(
			isOfficialXaiEndpoint(xaiAccount({ custom_endpoint: "not-a-valid-url" })),
		).toBe(false);
	});

	it("returns true for an xAI account with a JSON blob missing the endpoint field (falls back to official default)", () => {
		expect(
			isOfficialXaiEndpoint(
				xaiAccount({
					custom_endpoint: JSON.stringify({
						modelMappings: { opus: "grok-4.5" },
					}),
				}),
			),
		).toBe(true);
	});

	it("returns false for a non-xAI account", () => {
		expect(
			isOfficialXaiEndpoint(xaiAccount({ provider: "openai-compatible" })),
		).toBe(false);
	});

	it("returns true when no account is provided (defaults to official xAI)", () => {
		expect(isOfficialXaiEndpoint(undefined)).toBe(true);
		expect(isOfficialXaiEndpoint(null)).toBe(true);
	});
});
