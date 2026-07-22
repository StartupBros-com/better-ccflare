import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { accountCreatedResponse } from "../../utils/account-created-response";

const CREATE_HANDLERS = [
	"createAccountAddHandler",
	"createZaiAccountAddHandler",
	"createOpenAIAccountAddHandler",
	"createVertexAIAccountAddHandler",
	"createMinimaxAccountAddHandler",
	"createNanoGPTAccountAddHandler",
	"createAnthropicCompatibleAccountAddHandler",
	"createOllamaAccountAddHandler",
	"createOllamaCloudAccountAddHandler",
	"createBedrockAccountAddHandler",
	"createKiloAccountAddHandler",
	"createAlibabaCodingPlanAccountAddHandler",
	"createOpenRouterAccountAddHandler",
] as const;

describe("direct account creation response contract", () => {
	it("preserves legacy payload fields and adds the immutable top-level identity", async () => {
		const response = accountCreatedResponse("account-immutable-id", {
			success: false,
			accountId: "payload-cannot-override-id",
			message: "created",
			account: { id: "account-immutable-id", name: "safe-name" },
		});
		expect(await response.json()).toEqual({
			success: true,
			accountId: "account-immutable-id",
			message: "created",
			account: { id: "account-immutable-id", name: "safe-name" },
		});
	});

	it("keeps every supported direct-create handler on the shared identity helper", () => {
		const source = readFileSync(
			new URL("../accounts.ts", import.meta.url),
			"utf8",
		);
		for (const [index, handler] of CREATE_HANDLERS.entries()) {
			const start = source.indexOf(`export function ${handler}`);
			const nextHandler = CREATE_HANDLERS[index + 1];
			const end = nextHandler
				? source.indexOf(`export function ${nextHandler}`)
				: source.indexOf("export function createAccountRefreshUsageHandler");
			expect(start).toBeGreaterThanOrEqual(0);
			expect(source.slice(start, end)).toContain(
				"accountCreatedResponse(accountId, {",
			);
		}
	});

	it("keeps endpoint, cloud credential, and physical model fields out of creation logs", () => {
		const source = readFileSync(
			new URL("../accounts.ts", import.meta.url),
			"utf8",
		);
		for (const unsafeLogFragment of [
			"(Endpoint: $" + "{customEndpoint}",
			"(Project: $" + "{projectId}",
			"(Profile: $" + "{profile}",
			"CustomModel: $" + "{customModel}",
		]) {
			expect(source).not.toContain(unsafeLogFragment);
		}
	});
});
