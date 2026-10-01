import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { attachStreamEvidenceReader } from "@better-ccflare/providers/stream-evidence";
import { createAnthropicPreCommitRescueRouteContext } from "../anthropic-precommit-rescue";
import { gateAnthropicSsePreCommit } from "../anthropic-semantic-preflight";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";

const encoder = new TextEncoder();
const frame = (delta: object) =>
	encoder.encode(
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta })}\n\n`,
	);
afterEach(() => {
	spyOn(Date, "now").mockRestore();
});

function fixedRaw(visible = 0) {
	return {
		rawEventCounts: { encrypted_reasoning_done: 9, argument_delta: visible },
		rawVisibleEvents: visible,
		providerTerminal: null,
	};
}
function timedStream(chunks: Uint8Array[], times: number[]) {
	let now = 1000;
	spyOn(Date, "now").mockImplementation(() => now);
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(c) {
			if (i < chunks.length) {
				now = times[i] ?? now;
				c.enqueue(chunks[i++]);
			}
		},
		cancel() {},
	});
}

describe("bounded semantic stall evidence", () => {
	it.each([
		"signature_delta",
		"encrypted_content_delta",
		"future_encrypted_delta",
	])("%s refreshes protocol activity without extending the fourteen-minute deadline", async (type) => {
		const body = timedStream(
			Array.from({ length: 9 }, () =>
				frame({ type, signature: "private", encrypted_content: "private" }),
			),
			Array.from({ length: 9 }, (_, i) => 1000 + i * 105000),
		);
		const observations: unknown[] = [];
		const error = await gateAnthropicSsePreCommit(body, {
			semanticTimeoutMs: 120000,
			commitmentDeadlineAt: 841000,
			observe: (e) => observations.push(e),
		}).catch((e) => e);
		expect(error.reason).toBe("meaningful_progress_timeout");
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({
			meaningfulFrames: 0,
			protocolFrames: 9,
			diagnosis: "no_usable_output",
			remainingCommitmentMs: 0,
			cancellationOrigin: "semantic_deadline",
		});
		expect(JSON.stringify(observations)).not.toContain("private");
	});

	it("labels raw visible without transformed output only as a translation or gating candidate", async () => {
		const body = timedStream(
			[frame({ type: "signature_delta", signature: "private" })],
			[1010],
		);
		attachStreamEvidenceReader(body, () => fixedRaw(1));
		let observed: unknown;
		await gateAnthropicSsePreCommit(body, {
			semanticTimeoutMs: 1,
			commitmentDeadlineAt: 2000,
			observe: (e) => {
				observed = e;
			},
		}).catch(() => undefined);
		expect(observed).toMatchObject({
			meaningfulFrames: 0,
			rawVisibleEvents: 1,
			diagnosis: "translation_or_gating_candidate",
			rawEventCounts: { encrypted_reasoning_done: 9, argument_delta: 1 },
		});
	});

	it.each([
		[undefined, "downstream_abort"],
		["ACCEPTED_REQUEST_DEADLINE", "accepted_deadline"],
		["GUARD_RECYCLE_UNAVAILABLE", "maintenance"],
	])("retains the proven abort origin %s without claiming human intent", async (code, origin) => {
		const controller = new AbortController();
		const body = timedStream([], []);
		const error = Object.assign(new Error("private cancellation"), { code });
		controller.abort(error);
		let observed: unknown;
		await gateAnthropicSsePreCommit(body, {
			signal: controller.signal,
			observe: (e) => {
				observed = e;
			},
		}).catch(() => undefined);
		expect(observed).toMatchObject({
			cancellationOrigin: origin,
			meaningfulFrames: 0,
		});
		expect(JSON.stringify(observed)).not.toContain("private");
	});

	it("keeps provider cancellation distinct from downstream abort", async () => {
		const body = timedStream([], []);
		attachStreamEvidenceReader(body, () => ({
			...fixedRaw(),
			providerTerminal: "cancelled",
		}));
		let observed: unknown;
		await gateAnthropicSsePreCommit(body, {
			semanticTimeoutMs: 1,
			observe: (e) => {
				observed = e;
			},
		}).catch(() => undefined);
		expect(observed).toMatchObject({
			cancellationOrigin: "provider",
			providerTerminal: "cancelled",
		});
	});

	it("keeps the same shared deadline after the initial attempt and its thirty-second rescue", async () => {
		const context = createAnthropicPreCommitRescueRouteContext({
			activate() {},
			signal: new AbortController().signal,
			requestStartedAt: 1000,
			commitmentDeadlineMs: 840000,
		});
		const initialDeadline = context.getAttemptCommitmentDeadlineAt(false);
		expect(initialDeadline).toBe(811000);
		expect(context.getAttemptCommitmentDeadlineAt(true) - initialDeadline).toBe(
			30000,
		);
		const ledger = new RoutingAttemptLedger();
		for (const [accountId, deadline] of [
			["initial", initialDeadline],
			["rescue", context.commitmentDeadlineAt],
		] as const) {
			ledger.recordPhysicalAttempt({ accountId, provider: "codex" });
			const body = timedStream(
				[frame({ type: "signature_delta", signature: "private" })],
				[deadline],
			);
			await gateAnthropicSsePreCommit(body, {
				commitmentDeadlineAt: deadline,
				disableProtocolIdleTimeout: true,
				observe: (e) => ledger.observePhysicalStream(e),
			}).catch((e) => ledger.recordPhysicalOutcome(e.reason, "failed", e));
		}
		expect(context.commitmentDeadlineAt).toBe(841000);
		expect(context.getAttemptCommitmentDeadlineAt(true)).toBe(841000);
		const summary = ledger.terminalSummary({
			success: false,
			error: "route_unavailable",
			nativeStatus: 503,
			wireStatus: 200,
		});
		expect(summary?.attempts).toHaveLength(2);
		expect(
			summary?.attempts.every(
				(a) => a.streamEvidence?.remainingCommitmentMs === 0,
			),
		).toBe(true);
		expect(summary?.terminalCause).toBe("meaningful_progress_timeout");
	});

	it("preserves the cap as the selected terminal cause when cancellation arrives afterward", () => {
		const ledger = new RoutingAttemptLedger();
		ledger.recordPhysicalAttempt({ accountId: "first", provider: "codex" });
		ledger.recordPhysicalOutcome("buffer_limit");
		ledger.recordPhysicalOutcome("client_cancelled", "cancelled");
		expect(
			ledger.terminalSummary({
				success: false,
				error: "client_cancelled",
				nativeStatus: 200,
				wireStatus: 200,
			}),
		).toMatchObject({
			terminalCause: "buffer_limit",
			attempts: [{ cause: "buffer_limit" }],
		});
	});

	it("keeps a cap cause after late cancellation and retains the first attempt across rescue", async () => {
		const ledger = new RoutingAttemptLedger();
		ledger.recordPhysicalAttempt({
			accountId: "first",
			provider: "codex",
			logicalModel: "logical",
			physicalModel: "physical",
		});
		const body = timedStream(
			[frame({ type: "signature_delta", signature: "private" })],
			[1010],
		);
		await gateAnthropicSsePreCommit(body, {
			maxBufferedBytes: 1,
			observe: (streamEvidence) => ledger.observePhysicalStream(streamEvidence),
		}).catch((e) => ledger.recordPhysicalOutcome(e.reason, "failed", e));
		ledger.recordPhysicalOutcome("client_cancelled", "cancelled");
		ledger.recordPhysicalAttempt({ accountId: "rescue", provider: "codex" });
		ledger.observeOutputOrigin("rescue");
		const summary = ledger.terminalSummary({
			success: true,
			nativeStatus: 200,
			wireStatus: 200,
		});
		expect(summary?.attempts[0]).toMatchObject({
			cause: "buffer_limit",
			streamEvidence: { gateOutcome: "buffer_limit" },
		});
		expect(summary?.attempts[1]?.outcome).toBe("succeeded");
		expect(summary?.winnerOrdinal).toBe(2);
	});
});
