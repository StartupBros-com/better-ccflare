import { describe, expect, it, mock } from "bun:test";
import type {
	AnthropicDegradedPermit,
	AnthropicDegradedPermitOutcome,
} from "../anthropic-degraded-mode";
import { AnthropicDegradedResponseLifecycle } from "../anthropic-degraded-response-lifecycle";

interface FakePermit extends AnthropicDegradedPermit {
	completeCalls: Array<{
		outcome: AnthropicDegradedPermitOutcome;
		retryAfter: unknown;
	}>;
	expireCalls: number;
}

function makePermit(
	kind: AnthropicDegradedPermit["kind"],
	leaseExpiresAt: number | null,
	order: string[] = [],
): FakePermit {
	const permit: FakePermit = {
		kind,
		leaseExpiresAt,
		completeCalls: [],
		expireCalls: 0,
		commit: () => true,
		cancel: () => true,
		complete(outcome, retryAfter) {
			order.push(`complete:${outcome}`);
			permit.completeCalls.push({ outcome, retryAfter });
			return true;
		},
		expire() {
			order.push("expire");
			permit.expireCalls += 1;
			return true;
		},
	};
	return permit;
}

describe("AnthropicDegradedResponseLifecycle", () => {
	it("aborts transport before expiring an enforced probe and fences late completion", () => {
		let now = 1_000;
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		const order: string[] = [];
		const permit = makePermit("probe", 1_100, order);
		const lifecycle = new AnthropicDegradedResponseLifecycle({
			permit,
			accountId: "account-a",
			cohortKey: "cohort-a" as never,
			enforced: true,
			now: () => now,
			setTimer(callback, delayMs) {
				const handle = { callback, delayMs };
				scheduled.push(handle);
				return handle as never;
			},
			clearTimer() {},
			onSettled: (outcome) => {
				order.push(`telemetry:${outcome}`);
			},
		});
		lifecycle.transportSignal.addEventListener("abort", () => {
			order.push("abort");
		});

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0].delayMs).toBe(100);

		now = 1_050;
		scheduled[0].callback();
		expect(permit.expireCalls).toBe(0);
		expect(scheduled).toHaveLength(2);
		expect(scheduled[1].delayMs).toBe(50);

		now = 1_100;
		scheduled[1].callback();
		expect(order).toEqual(["abort", "expire", "telemetry:timeout"]);
		expect(lifecycle.transportSignal.aborted).toBe(true);
		expect(lifecycle.isSettled).toBe(true);
		expect(lifecycle.settle("success")).toBe(false);
		expect(permit.completeCalls).toEqual([]);
	});

	it("does not arm a watchdog for observe shadow permits or recovery sends", () => {
		const setTimer = mock(() => ({}) as never);
		const observeProbe = new AnthropicDegradedResponseLifecycle({
			permit: makePermit("probe", Date.now() + 10_000),
			accountId: "account-a",
			cohortKey: "cohort-a" as never,
			enforced: false,
			setTimer,
		});
		const recoverySend = new AnthropicDegradedResponseLifecycle({
			permit: makePermit("recovery_send", null),
			accountId: "account-b",
			cohortKey: "cohort-b" as never,
			enforced: true,
			setTimer,
		});

		expect(setTimer).not.toHaveBeenCalled();
		expect(observeProbe.transportSignal.aborted).toBe(false);
		expect(recoverySend.transportSignal.aborted).toBe(false);
		expect(observeProbe.settle("success")).toBe(true);
		expect(recoverySend.settle("overloaded", "12")).toBe(true);
	});

	it("transfers and settles exactly once", () => {
		const permit = makePermit("probe", Date.now() + 10_000);
		const onSuccess = mock(() => undefined);
		const onSettled = mock(() => {
			throw new Error("telemetry failure");
		});
		const clearTimer = mock(() => undefined);
		const lifecycle = new AnthropicDegradedResponseLifecycle({
			permit,
			accountId: "account-a",
			cohortKey: "cohort-a" as never,
			enforced: true,
			onSuccess,
			onSettled,
			clearTimer,
		});

		expect(lifecycle.transferToResponse()).toBe(true);
		expect(lifecycle.transferToResponse()).toBe(false);
		expect(lifecycle.settle("success")).toBe(true);
		expect(lifecycle.settle("failed")).toBe(false);
		expect(permit.completeCalls).toEqual([
			{ outcome: "success", retryAfter: undefined },
		]);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(clearTimer).toHaveBeenCalledTimes(1);
	});
});
