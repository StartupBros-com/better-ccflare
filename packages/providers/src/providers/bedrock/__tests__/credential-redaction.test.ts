import { afterAll, describe, expect, it, mock } from "bun:test";
import { Logger, logBus } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";

// Synthetic SDK credential failure: never read real AWS profiles or send traffic.
const privatePath = "/private/aws/token-file-credential-canary";
const sdkFailure = new Error("Credential resolution failed", {
	cause: new Error(privatePath),
});
sdkFailure.name = "ExpiredTokenException";
sdkFailure.stack = `ExpiredTokenException at ${privatePath}`;
const originalCredentials = { ...(await import("../credentials")) };
afterAll(() => mock.module("../credentials", () => originalCredentials));
mock.module("../credentials", () => ({
	...originalCredentials,
	createBedrockCredentialChain: () => async () => {
		throw sdkFailure;
	},
}));

const { BedrockProvider } = await import("../provider");

describe("Bedrock credential error projection", () => {
	it.each([
		"ExpiredTokenException",
		"CredentialsProviderError",
	])("keeps %s causes and paths out of dashboard log events", async (name) => {
		sdkFailure.name = name;
		const events: unknown[] = [];
		const collect = (event: unknown) => events.push(event);
		logBus.on("log", collect);
		try {
			const account = {
				id: "credential-redaction-fixture",
				name: "fixture",
				provider: "bedrock",
				custom_endpoint: "bedrock:fixture:us-east-1",
			} as Account;
			let caught: unknown;
			try {
				await new BedrockProvider().refreshToken(account, "unused");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toContain(
				"Bedrock credential validation failed for fixture:",
			);
			new Logger("credential-redaction-test").error(
				"Token refresh failed",
				caught,
			);
			expect(events.length).toBeGreaterThan(0);
			expect(JSON.stringify(events)).toContain("Token refresh failed");
			expect(JSON.stringify(events)).not.toContain(privatePath);
			expect(caught).not.toHaveProperty("cause");
		} finally {
			logBus.off("log", collect);
		}
	});
});
