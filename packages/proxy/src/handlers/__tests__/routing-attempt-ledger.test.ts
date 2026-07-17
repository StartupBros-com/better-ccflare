import { describe, expect, it, mock } from "bun:test";
import { RoutingAttemptLedger } from "../routing-attempt-ledger";

describe("RoutingAttemptLedger", () => {
	it("claims each account and normalized concrete model only once", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", " Claude-Opus-4-8 ")).toBe(true);
		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(false);
		expect(ledger.claim("account-a", "claude-fable-5")).toBe(true);
		expect(ledger.claim("account-b", "claude-opus-4-8")).toBe(true);
		expect(ledger.attemptedCount).toBe(3);
	});

	it("uses a stable null lane when no concrete model is available", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", null)).toBe(true);
		expect(ledger.claim("account-a", undefined)).toBe(false);
		expect(ledger.claim("account-a", "   ")).toBe(false);
	});

	it("blocks every sibling model after an account-wide failure", () => {
		const ledger = new RoutingAttemptLedger();

		expect(ledger.claim("account-a", "claude-opus-4-8")).toBe(true);
		expect(ledger.claim("account-a", "claude-fable-5")).toBe(true);

		ledger.blockAccount("account-a");

		expect(ledger.claim("account-a", "claude-haiku-4-5")).toBe(false);
		expect(ledger.claim("account-b", "claude-haiku-4-5")).toBe(true);
		expect(ledger.attemptedCount).toBe(3);
	});

	it("transfers one retained terminal response and disposes replacements exactly once", async () => {
		const ledger = new RoutingAttemptLedger();
		const firstDiscard = mock(async () => undefined);
		const secondDiscard = mock(async () => undefined);
		const deliver = mock(
			async (failoverAttempts: number) =>
				new Response(String(failoverAttempts), { status: 529 }),
		);

		await ledger.retainTerminalResponse({
			deliver,
			discard: firstDiscard,
		});
		await ledger.retainTerminalResponse({
			deliver,
			discard: secondDiscard,
		});

		expect(firstDiscard).toHaveBeenCalledTimes(1);
		expect(secondDiscard).not.toHaveBeenCalled();
		const retained = ledger.takeTerminalResponse();
		expect(retained).not.toBeNull();
		const response = await retained?.deliver(3);
		expect(response?.status).toBe(529);
		expect(await response?.text()).toBe("3");
		expect(ledger.takeTerminalResponse()).toBeNull();
		expect(secondDiscard).not.toHaveBeenCalled();
	});

	it("discards retained terminal ownership idempotently", async () => {
		const ledger = new RoutingAttemptLedger();
		const discard = mock(async () => undefined);

		await ledger.retainTerminalResponse({
			deliver: async () => new Response(null, { status: 529 }),
			discard,
		});
		await ledger.discardTerminalResponse();
		await ledger.discardTerminalResponse();

		expect(discard).toHaveBeenCalledTimes(1);
	});
});
