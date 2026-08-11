import { describe, expect, it, spyOn } from "bun:test";
import type { ServerToolReplayKeysState } from "@better-ccflare/config";
import type {
	ServerToolReplayEnvelopeBinding,
	ServerToolReplayEnvelopePayload,
	ServerToolReplayIssuanceClaim,
} from "@better-ccflare/providers";

const {
	createServerToolReplayEnvelopeCodec,
	getServerToolReplayEnvelopeCounterIdentity,
} = await import("@better-ccflare/providers");
const {
	bindRequestPrivateServerToolReplay,
	createDurableServerToolReplayWriterAdmission,
	createServerToolReplayRuntime,
	resolveRequestPrivateServerToolReplay,
	SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
} = await import("./server-tool-replay-runtime");
const { opaqueRuntimeId } = await import("./opaque-runtime-id");

const ACTIVE_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const RETAINED_BYTES = Uint8Array.from(
	{ length: 32 },
	(_, index) => 255 - index,
);
const REVOKED_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 80 + index);

const BINDING: ServerToolReplayEnvelopeBinding = Object.freeze({
	envelopeKind: "source",
	toolType: "web_search_20250305",
	audience: "claude-code",
	lineage: "session-lineage",
	callId: "server-tool-call",
	visibleQuery: "bounded visible query",
	resultState: "result",
	ordinal: 0,
	linkage: null,
	visibleEvidence: Object.freeze([]),
});

const PAYLOAD: ServerToolReplayEnvelopePayload = Object.freeze({
	provider: "codex",
	model: "fixture-model",
	fidelity: "fixture-proven",
});

function enabledCodec(id: string, key: Uint8Array) {
	let issued = 0;
	return createServerToolReplayEnvelopeCodec({
		activeKey: { id, key },
		writerAdmission: {
			enabled: true,
			claimIssuance: async () => {
				issued += 1;
				return issued;
			},
		},
	});
}

function enabledLeaseAdmission(
	onClaim?: (claim: ServerToolReplayIssuanceClaim, count: number) => number,
) {
	return Object.freeze({
		enabled: true as const,
		acquireIssuanceLease: async (input: { counterIdentity: string }) => {
			let issuanceCount = 0;
			return Object.freeze({
				enabled: true as const,
				claimIssuance: async (claim: ServerToolReplayIssuanceClaim) => {
					if (claim.counterIdentity !== input.counterIdentity) return undefined;
					issuanceCount += 1;
					return onClaim?.(claim, issuanceCount) ?? issuanceCount;
				},
			});
		},
	});
}

function readyState(
	activeKeyId: string,
	keys: Extract<ServerToolReplayKeysState, { status: "ready" }>["keys"],
): ServerToolReplayKeysState {
	return { status: "ready", activeKeyId, keys };
}

function expectDeeplyFrozen(
	value: unknown,
	seen = new WeakSet<object>(),
): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const nested of Object.values(value)) expectDeeplyFrozen(nested, seen);
}

type ZeroedKeyCopiesCapture<T> = Readonly<{
	result: T;
	createdCopies: readonly Uint8Array[];
	zeroedCopies: readonly Uint8Array[];
	valuesBeforeZeroing: readonly (readonly number[])[];
}>;

function captureZeroedKeyCopies<T>(run: () => T): ZeroedKeyCopiesCapture<T> {
	const createdCopies: Uint8Array[] = [];
	const zeroedCopies: Uint8Array[] = [];
	const valuesBeforeZeroing: number[][] = [];
	const originalFrom = Uint8Array.from;
	const originalFill = Uint8Array.prototype.fill;
	const fromSpy = spyOn(Uint8Array, "from").mockImplementation(((
		...args: unknown[]
	) => {
		const copy = Reflect.apply(originalFrom, Uint8Array, args) as Uint8Array;
		if (copy.byteLength === 32) createdCopies.push(copy);
		return copy;
	}) as typeof Uint8Array.from);
	const fillSpy = spyOn(Uint8Array.prototype, "fill").mockImplementation(
		function (this: Uint8Array, value: number, start?: number, end?: number) {
			if (value === 0 && createdCopies.includes(this)) {
				zeroedCopies.push(this);
				valuesBeforeZeroing.push([...this]);
			}
			return originalFill.call(this, value, start, end);
		},
	);

	let result: T;
	try {
		result = run();
	} finally {
		fillSpy.mockRestore();
		fromSpy.mockRestore();
	}
	return { result, createdCopies, zeroedCopies, valuesBeforeZeroing };
}

function expectKeyCopiesZeroedExactlyOnce<T>(
	capture: ZeroedKeyCopiesCapture<T>,
	expectedValues: readonly Uint8Array[],
): void {
	expect(capture.valuesBeforeZeroing).toEqual(
		expectedValues.map((value) => [...value]),
	);
	expect(capture.createdCopies).toHaveLength(expectedValues.length);
	expect(capture.zeroedCopies).toHaveLength(expectedValues.length);
	expect(new Set(capture.zeroedCopies).size).toBe(expectedValues.length);
	for (const [index, copy] of capture.zeroedCopies.entries()) {
		expect(copy).toBe(capture.createdCopies[index]);
		expect(copy).toEqual(new Uint8Array(32));
	}
}

describe("durable server-tool replay writer admission", () => {
	it("acquires one exclusive full-lifecycle lease with no rollover store call", async () => {
		let durableCount = 0;
		const reservations: unknown[] = [];
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservations.push(input);
				const firstIssuanceCount = durableCount + 1;
				durableCount += input.reservationSize;
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount,
					lastIssuanceCount: durableCount,
				};
			},
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}

		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});
		const claims = [];
		for (let index = 0; index < 512; index += 1) {
			claims.push(
				await lease.claimIssuance({
					counterIdentity: "opaque-counter-identity",
					issuedAtMs: 1_786_000_000_123 + index,
				}),
			);
		}

		expect(SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE).toBe(512);
		expect(claims).toEqual(
			Array.from({ length: 512 }, (_, index) => index + 1),
		);
		await expect(
			lease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 1_786_000_000_123 + 512,
			}),
		).resolves.toBeUndefined();
		expect(reservations).toEqual([
			{
				counterIdentity: "opaque-counter-identity",
				reservationSize: 512,
			},
		]);
	});

	it("gives concurrent requests disjoint request-private leases", async () => {
		let durableCount = 0;
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservationCalls += 1;
				const firstIssuanceCount = durableCount + 1;
				durableCount += input.reservationSize;
				const lastIssuanceCount = durableCount;
				await Promise.resolve();
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount,
					lastIssuanceCount,
				};
			},
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}

		const [firstLease, secondLease] = await Promise.all([
			admission.writerAdmission.acquireIssuanceLease({
				counterIdentity: "opaque-counter-identity",
			}),
			admission.writerAdmission.acquireIssuanceLease({
				counterIdentity: "opaque-counter-identity",
			}),
		]);
		const [firstClaim, secondClaim] = await Promise.all([
			firstLease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 1,
			}),
			secondLease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 2,
			}),
		]);

		expect(reservationCalls).toBe(2);
		expect(new Set([firstClaim, secondClaim])).toEqual(new Set([1, 513]));
	});

	it("serves many claims from one conservative durable range reservation", async () => {
		const reservations: unknown[] = [];
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservations.push(input);
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount: 1,
					lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
				};
			},
		});

		expect(admission.status).toBe("ready");
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		expect(Object.isFrozen(admission)).toBe(true);
		expect(Object.isFrozen(admission.writerAdmission)).toBe(true);
		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});
		const claims = [];
		for (let index = 0; index < 64; index += 1) {
			claims.push(
				await lease.claimIssuance({
					counterIdentity: "opaque-counter-identity",
					issuedAtMs: 1_786_000_000_123 + index,
				}),
			);
		}
		expect(claims).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
		expect(reservations).toEqual([
			{
				counterIdentity: "opaque-counter-identity",
				reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
			},
		]);
	});

	it("assigns unique counts to concurrent in-memory claims in one lease", async () => {
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservationCalls += 1;
				await Promise.resolve();
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount: 1,
					lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
				};
			},
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});

		const claims = await Promise.all(
			Array.from({ length: 128 }, (_, index) =>
				lease.claimIssuance({
					counterIdentity: "opaque-counter-identity",
					issuedAtMs: 1_786_000_000_123 + index,
				}),
			),
		);

		expect(reservationCalls).toBe(1);
		expect([...claims].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
			Array.from({ length: 128 }, (_, index) => index + 1),
		);
	});

	it("fails a request lease closed instead of rolling over after its final slot", async () => {
		let durableCount = 0;
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservationCalls += 1;
				const firstIssuanceCount = durableCount + 1;
				durableCount += input.reservationSize;
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount,
					lastIssuanceCount: durableCount,
				};
			},
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});

		const claims = [];
		for (
			let index = 0;
			index <= SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE;
			index += 1
		) {
			claims.push(
				await lease.claimIssuance({
					counterIdentity: "opaque-counter-identity",
					issuedAtMs: index,
				}),
			);
		}

		expect(reservationCalls).toBe(1);
		expect(claims.at(-1)).toBeUndefined();
	});

	it("conservatively burns unused slots across admission restart", async () => {
		let durableCount = 0;
		const store = {
			reserveReplayIssuanceRange: async (input: {
				counterIdentity: string;
				reservationSize: number;
			}) => {
				const firstIssuanceCount = durableCount + 1;
				durableCount += input.reservationSize;
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount,
					lastIssuanceCount: durableCount,
				};
			},
		};
		const firstProcess = createDurableServerToolReplayWriterAdmission(store);
		if (firstProcess.status !== "ready") {
			throw new Error("first durable writer admission was not ready");
		}
		const firstLease = await firstProcess.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});
		await expect(
			firstLease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 1,
			}),
		).resolves.toBe(1);

		const restartedProcess =
			createDurableServerToolReplayWriterAdmission(store);
		if (restartedProcess.status !== "ready") {
			throw new Error("restarted durable writer admission was not ready");
		}
		const restartedLease =
			await restartedProcess.writerAdmission.acquireIssuanceLease({
				counterIdentity: "opaque-counter-identity",
			});
		await expect(
			restartedLease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 2,
			}),
		).resolves.toBe(SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE + 1);
		expect(durableCount).toBe(SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE * 2);
	});

	it("snapshots and binds the original range reservation method once", async () => {
		const originalReservations: unknown[] = [];
		let replacementCalls = 0;
		let originalReceiver: unknown;
		class MutableStore {
			async reserveReplayIssuanceRange(input: {
				counterIdentity: string;
				reservationSize: number;
			}) {
				originalReceiver = this;
				originalReservations.push(input);
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount: 23,
					lastIssuanceCount: 23 + SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE - 1,
				};
			}
		}
		const store = new MutableStore();
		const admission = createDurableServerToolReplayWriterAdmission(store);
		store.reserveReplayIssuanceRange = async (input) => {
			replacementCalls += 1;
			return {
				counterIdentity: input.counterIdentity,
				firstIssuanceCount: 99,
				lastIssuanceCount: 99 + input.reservationSize - 1,
			};
		};

		expect(admission.status).toBe("ready");
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});
		await expect(
			lease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: 1_786_000_000_123,
			}),
		).resolves.toBe(23);
		expect(originalReceiver).toBe(store);
		expect(originalReservations).toHaveLength(1);
		expect(replacementCalls).toBe(0);
	});

	it.each([
		null,
		{},
		{ reserveReplayIssuanceRange: null },
	] as const)("fails closed for invalid issuance store %p", (store) => {
		const admission = createDurableServerToolReplayWriterAdmission(
			store as unknown as Parameters<
				typeof createDurableServerToolReplayWriterAdmission
			>[0],
		);

		expect(admission).toEqual({
			status: "unavailable",
			reason: "invalid_store",
			writerAdmission: { enabled: false },
		});
	});

	it("rejects accessor-backed reservation methods without invoking them", () => {
		let accessorCalls = 0;
		const store = Object.defineProperty({}, "reserveReplayIssuanceRange", {
			get() {
				accessorCalls += 1;
				return async () => ({
					counterIdentity: "opaque-counter-identity",
					firstIssuanceCount: 1,
					lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
				});
			},
		});
		const admission = createDurableServerToolReplayWriterAdmission(
			store as Parameters<
				typeof createDurableServerToolReplayWriterAdmission
			>[0],
		);

		expect(admission).toMatchObject({
			status: "unavailable",
			reason: "invalid_store",
			writerAdmission: { enabled: false },
		});
		expect(accessorCalls).toBe(0);
	});

	it("propagates repository failures without retry or fallback", async () => {
		const repositoryFailure = new Error("durable issuance unavailable");
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async () => {
				reservationCalls += 1;
				throw repositoryFailure;
			},
		});

		expect(admission.status).toBe("ready");
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		await expect(
			admission.writerAdmission.acquireIssuanceLease({
				counterIdentity: "opaque-counter-identity",
			}),
		).rejects.toBe(repositoryFailure);
		expect(reservationCalls).toBe(1);
	});

	it("fails closed when storage returns a malformed or mismatched range", async () => {
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async () => ({
				counterIdentity: "different-counter",
				firstIssuanceCount: 1,
				lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
			}),
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}

		await expect(
			admission.writerAdmission.acquireIssuanceLease({
				counterIdentity: "opaque-counter-identity",
			}),
		).rejects.toThrow("Server-tool replay issuance range is invalid");
	});

	it("does not reserve a replacement range after a request lease is exhausted", async () => {
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => {
				reservationCalls += 1;
				return {
					counterIdentity: input.counterIdentity,
					firstIssuanceCount: 1,
					lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
				};
			},
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const lease = await admission.writerAdmission.acquireIssuanceLease({
			counterIdentity: "opaque-counter-identity",
		});
		for (
			let index = 0;
			index < SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE;
			index += 1
		) {
			await lease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: index,
			});
		}

		await expect(
			lease.claimIssuance({
				counterIdentity: "opaque-counter-identity",
				issuedAtMs: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
			}),
		).resolves.toBeUndefined();
		expect(reservationCalls).toBe(1);
	});
});

describe("server-tool replay runtime", () => {
	it("fails closed for an unregistered structural runtime", async () => {
		const runtime = Object.freeze({
			status: "ready" as const,
			codec: enabledCodec("structural-only", ACTIVE_BYTES),
		});
		const owner = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});

		expect(
			await bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId("model-route-caller", credential),
				lineage: "session-lineage",
			}),
		).toBe(false);
		expect(
			resolveRequestPrivateServerToolReplay(owner, {
				request,
				apiKeyId: null,
				lineage: "session-lineage",
			}),
		).toBeNull();
	});

	it("fails binding before authority publication when the first lease reservation fails", async () => {
		let leaseCalls = 0;
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{
				writerAdmission: {
					enabled: true,
					acquireIssuanceLease: async () => {
						leaseCalls += 1;
						throw new Error("durable issuance unavailable");
					},
				},
			},
		);
		const owner = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});

		await expect(
			bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId("model-route-caller", credential),
				lineage: "session-lineage",
			}),
		).resolves.toBe(false);
		expect(leaseCalls).toBe(1);
		expect(
			resolveRequestPrivateServerToolReplay(owner, {
				request,
				apiKeyId: null,
				lineage: "session-lineage",
			}),
		).toBeNull();
	});

	it("fails malformed request lease ranges before authority publication", async () => {
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async (input) => ({
				counterIdentity: input.counterIdentity,
				firstIssuanceCount: 1,
				lastIssuanceCount: 511,
			}),
		});
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{ writerAdmission: admission.writerAdmission },
		);
		const owner = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});

		await expect(
			bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId("model-route-caller", credential),
				lineage: "session-lineage",
			}),
		).resolves.toBe(false);
		expect(
			resolveRequestPrivateServerToolReplay(owner, {
				request,
				apiKeyId: null,
				lineage: "session-lineage",
			}),
		).toBeNull();
	});

	it("binds only frozen projector and issuer closures to one private request identity", async () => {
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{
				writerAdmission: enabledLeaseAdmission(),
			},
		);
		const requestMeta = { id: "request-private-owner" };
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});
		const audience = opaqueRuntimeId("model-route-caller", credential);

		await expect(
			bindRequestPrivateServerToolReplay(requestMeta, runtime, {
				request,
				apiKeyId: null,
				audience,
				lineage: "session-lineage",
			}),
		).resolves.toBe(true);
		const authority = resolveRequestPrivateServerToolReplay(requestMeta, {
			request,
			apiKeyId: null,
			lineage: "session-lineage",
		});

		expect(authority).not.toBeNull();
		expect(Object.isFrozen(authority)).toBe(true);
		expect(Object.isFrozen(authority?.serverToolHistoryProjector)).toBe(true);
		expect(Object.isFrozen(authority?.serverToolReplayIssuer)).toBe(true);
		expect(Object.keys(authority ?? {})).toEqual([
			"serverToolHistoryProjector",
			"serverToolReplayIssuer",
		]);
		expect(JSON.stringify(requestMeta)).toBe('{"id":"request-private-owner"}');
		expect(JSON.stringify(authority)).toBe("{}");
	});

	it("snapshots projector and issuer inputs while overriding forged authority", async () => {
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{ writerAdmission: enabledLeaseAdmission() },
		);
		const requestMeta = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});
		const audience = opaqueRuntimeId("model-route-caller", credential);
		await expect(
			bindRequestPrivateServerToolReplay(requestMeta, runtime, {
				request,
				apiKeyId: null,
				audience,
				lineage: "session-lineage",
			}),
		).resolves.toBe(true);
		const authority = resolveRequestPrivateServerToolReplay(requestMeta, {
			request,
			apiKeyId: null,
			lineage: "session-lineage",
		});
		if (!authority) throw new Error("request-private replay was not bound");

		const snapshotSourceBinding = {
			envelopeKind: "source" as const,
			toolType: "web_search_20250305",
			callId: "srvtoolu_snapshot",
			visibleQuery: "original query",
			resultState: "result" as const,
			ordinal: 0,
			linkage: null,
			visibleEvidence: [
				{
					url: "https://example.com/source",
					title: "Snapshot source",
					citedText: "",
					pageAge: null,
				},
			],
		};
		const snapshotToken = await authority.serverToolReplayIssuer(
			snapshotSourceBinding,
			PAYLOAD,
		);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "server_tool_use",
						id: "srvtoolu_snapshot",
						name: "web_search",
						input: { query: "original query" },
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_snapshot",
						content: [
							{
								type: "web_search_result",
								url: "https://example.com/source",
								title: "Snapshot source",
								encrypted_content: snapshotToken,
							},
						],
					},
				],
			},
		];
		const projectionPromise = authority.serverToolHistoryProjector(messages);
		const mutableToolUse = messages[0]?.content[0];
		if (!mutableToolUse || !("input" in mutableToolUse)) {
			throw new Error("missing mutable server-tool use fixture");
		}
		mutableToolUse.input.query = "mutated query";
		const projection = await projectionPromise;
		expect(projection.replacements.length).toBeGreaterThan(0);
		const replacementText = projection.replacements
			.map((replacement) => replacement.text)
			.join("\n");
		expect(replacementText).toContain("original query");
		expect(replacementText).not.toContain("mutated query");

		const mutableBinding = {
			...BINDING,
			audience: "forged-audience",
			lineage: "forged-lineage",
			visibleQuery: "original query",
		};
		const mutablePayload = { ...PAYLOAD };
		const tokenPromise = authority.serverToolReplayIssuer(
			mutableBinding,
			mutablePayload,
		);
		mutableBinding.visibleQuery = "mutated query";
		mutablePayload.model = "mutated-model";
		const token = await tokenPromise;
		const trustedBinding = {
			...BINDING,
			audience,
			lineage: "session-lineage",
			visibleQuery: "original query",
		};
		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		await expect(
			runtime.codec.decode(token, trustedBinding),
		).resolves.toMatchObject({
			model: PAYLOAD.model,
			audience,
			lineage: "session-lineage",
		});
		await expect(
			runtime.codec.decode(token, {
				...trustedBinding,
				audience: "forged-audience",
			}),
		).rejects.toMatchObject({ code: "invalid_server_tool_replay_envelope" });
	});

	it("rejects missing, ambiguous, rebound, and rematerialized request identities", async () => {
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{ writerAdmission: enabledLeaseAdmission() },
		);
		const owner = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});
		const audience = opaqueRuntimeId("model-route-caller", credential);

		expect(
			await bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience,
				lineage: "session-lineage",
			}),
		).toBe(true);
		expect(
			await bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience,
				lineage: "session-lineage",
			}),
		).toBe(false);
		expect(
			resolveRequestPrivateServerToolReplay(
				{},
				{
					request,
					apiKeyId: null,
					lineage: "session-lineage",
				},
			),
		).toBeNull();
		expect(
			resolveRequestPrivateServerToolReplay(owner, {
				request: new Request("https://proxy.local/v1/messages", {
					headers: {
						authorization: "Bearer different-client",
						"x-claude-code-session-id": "session-lineage",
					},
				}),
				apiKeyId: null,
				lineage: "session-lineage",
			}),
		).toBeNull();
		expect(
			resolveRequestPrivateServerToolReplay(owner, {
				request,
				apiKeyId: null,
				lineage: "different-lineage",
			}),
		).toBeNull();

		const ambiguous = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-api-key": "second-credential",
				"x-claude-code-session-id": "session-lineage",
			},
		});
		expect(
			await bindRequestPrivateServerToolReplay({}, runtime, {
				request: ambiguous,
				apiKeyId: null,
				audience,
				lineage: "session-lineage",
			}),
		).toBe(false);
		expect(
			await bindRequestPrivateServerToolReplay({}, runtime, {
				request: new Request("https://proxy.local/v1/messages"),
				apiKeyId: null,
				audience: null,
				lineage: null,
			}),
		).toBe(false);
	});

	it("waits for every key import and fails initialization closed", async () => {
		const subtle = globalThis.crypto.subtle;
		const originalImportKey = subtle.importKey.bind(subtle);
		let importCalls = 0;
		let releaseFinalImport = (): void => {};
		const finalImportGate = new Promise<void>((resolve) => {
			releaseFinalImport = resolve;
		});
		const importKeySpy = spyOn(subtle, "importKey").mockImplementation((async (
			...args: Parameters<SubtleCrypto["importKey"]>
		) => {
			importCalls += 1;
			if (importCalls === 2) {
				throw new Error("forced replay-key import failure");
			}
			if (importCalls === 6) await finalImportGate;
			return Reflect.apply(
				originalImportKey,
				subtle,
				args,
			) as Promise<CryptoKey>;
		}) as SubtleCrypto["importKey"]);

		try {
			const runtimePromise = createServerToolReplayRuntime(
				readyState("next-active", [
					{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
					{
						id: "old-retained",
						status: "retained",
						key: [...RETAINED_BYTES],
					},
				]),
			);
			let initializationSettled = false;
			void runtimePromise.then(() => {
				initializationSettled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(importCalls).toBe(6);
			expect(initializationSettled).toBe(false);

			releaseFinalImport();
			const runtime = await runtimePromise;

			expect(runtime).toEqual({
				status: "unavailable",
				code: "invalid_replay_key_config",
			});
		} finally {
			importKeySpy.mockRestore();
		}
	});

	it("returns canonical deeply frozen disabled and unavailable states", async () => {
		const disabled = await createServerToolReplayRuntime({
			status: "disabled",
		});
		const unavailable = await createServerToolReplayRuntime({
			status: "unavailable",
			code: "invalid_replay_key_config",
		});

		expect(disabled).toEqual({ status: "disabled" });
		expect(unavailable).toEqual({
			status: "unavailable",
			code: "invalid_replay_key_config",
		});
		expectDeeplyFrozen(disabled);
		expectDeeplyFrozen(unavailable);
	});

	it.each([
		readyState("missing", [
			{ id: "current", status: "active", key: [...ACTIVE_BYTES] },
		]),
		readyState("current", [
			{ id: "current", status: "retained", key: [...ACTIVE_BYTES] },
			{ id: "other", status: "active", key: [...RETAINED_BYTES] },
		]),
		readyState("current", [
			{ id: "current", status: "active", key: [...ACTIVE_BYTES] },
			{ id: "current", status: "retained", key: [...RETAINED_BYTES] },
		]),
		readyState("current", [
			{ id: "current", status: "active", key: [...ACTIVE_BYTES].slice(1) },
		]),
		readyState("current", [
			{ id: "current", status: "active", key: Array(32) },
		]),
		readyState("_current", [
			{ id: "_current", status: "active", key: [...ACTIVE_BYTES] },
		]),
		readyState("a".repeat(65), [
			{ id: "a".repeat(65), status: "active", key: [...ACTIVE_BYTES] },
		]),
		{
			status: "ready",
			activeKeyId: "current",
			keys: [{ id: "current", status: "unknown", key: [...ACTIVE_BYTES] }],
		} as unknown as ServerToolReplayKeysState,
	])("sanitizes malformed or mismatched ready input", async (state) => {
		const runtime = await createServerToolReplayRuntime(state);

		expect(runtime).toEqual({
			status: "unavailable",
			code: "invalid_replay_key_config",
		});
		expect(Object.keys(runtime)).toEqual(["status", "code"]);
		expectDeeplyFrozen(runtime);
	});

	it("selects the explicit active record independently of key-array order", async () => {
		const activeWriter = enabledCodec("next-active", ACTIVE_BYTES);
		const token = await activeWriter.encode(BINDING, PAYLOAD);
		const records = [
			{
				id: "old-retained",
				status: "retained" as const,
				key: [...RETAINED_BYTES],
			},
			{ id: "revoked-key", status: "revoked" as const },
			{ id: "next-active", status: "active" as const, key: [...ACTIVE_BYTES] },
		];

		for (const keys of [records, [...records].reverse()]) {
			const runtime = await createServerToolReplayRuntime(
				readyState("next-active", keys),
			);
			expect(runtime.status).toBe("ready");
			if (runtime.status !== "ready") throw new Error("runtime was not ready");
			await expect(runtime.codec.decode(token, BINDING)).resolves.toMatchObject(
				PAYLOAD,
			);
		}
	});

	it("retains old-key decoding after rotation", async () => {
		const oldWriter = enabledCodec("old-retained", RETAINED_BYTES);
		const oldToken = await oldWriter.encode(BINDING, PAYLOAD);
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
				{
					id: "old-retained",
					status: "retained",
					key: [...RETAINED_BYTES],
				},
			]),
		);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		await expect(
			runtime.codec.decode(oldToken, BINDING),
		).resolves.toMatchObject(PAYLOAD);
	});

	it("excludes revoked keys from the codec reader set", async () => {
		const revokedWriter = enabledCodec("revoked-key", REVOKED_BYTES);
		const revokedToken = await revokedWriter.encode(BINDING, PAYLOAD);
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "revoked-key", status: "revoked" },
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
		);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		await expect(
			runtime.codec.decode(revokedToken, BINDING),
		).rejects.toMatchObject({ code: "invalid_server_tool_replay_envelope" });
	});

	it("keeps readers ready while writer admission remains disabled", async () => {
		const writer = enabledCodec("next-active", ACTIVE_BYTES);
		const token = await writer.encode(BINDING, PAYLOAD);
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
		);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		expect(runtime.codec.getWriterReadiness()).toEqual({ status: "disabled" });
		await expect(runtime.codec.decode(token, BINDING)).resolves.toMatchObject(
			PAYLOAD,
		);
		await expect(runtime.codec.encode(BINDING, PAYLOAD)).rejects.toMatchObject({
			code: "server_tool_replay_admission_error",
		});
	});

	it("enables a request-private writer lease only when explicitly injected", async () => {
		const claims: Array<
			Readonly<{ counterIdentity: string; issuedAtMs: number }>
		> = [];
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{
				writerAdmission: enabledLeaseAdmission((claim, count) => {
					claims.push(claim);
					return count;
				}),
			},
		);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		expect(runtime.codec.getWriterReadiness()).toEqual({ status: "ready" });
		const owner = {};
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});
		expect(
			await bindRequestPrivateServerToolReplay(owner, runtime, {
				request,
				apiKeyId: null,
				audience: opaqueRuntimeId("model-route-caller", credential),
				lineage: "session-lineage",
			}),
		).toBe(true);
		const authority = resolveRequestPrivateServerToolReplay(owner, {
			request,
			apiKeyId: null,
			lineage: "session-lineage",
		});
		if (!authority) throw new Error("request-private replay was not bound");
		await expect(
			authority.serverToolReplayIssuer(BINDING, PAYLOAD),
		).resolves.toBeString();
		expect(claims).toHaveLength(1);
		expect(claims[0]?.counterIdentity).toBe(
			getServerToolReplayEnvelopeCounterIdentity(runtime.codec),
		);
		expect(claims[0]?.counterIdentity).toMatch(
			/^better-ccflare\.aes-256-gcm\.keyfp\.v1\.[A-Za-z0-9_-]{43}$/u,
		);
	});

	it("makes a durable repository failure sticky while retaining reader support", async () => {
		const readerToken = await enabledCodec("next-active", ACTIVE_BYTES).encode(
			BINDING,
			PAYLOAD,
		);
		let reservationCalls = 0;
		const admission = createDurableServerToolReplayWriterAdmission({
			reserveReplayIssuanceRange: async () => {
				reservationCalls += 1;
				throw new Error("durable issuance unavailable");
			},
		});
		expect(admission.status).toBe("ready");
		if (admission.status !== "ready") {
			throw new Error("durable writer admission was not ready");
		}
		const runtime = await createServerToolReplayRuntime(
			readyState("next-active", [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
			]),
			{ writerAdmission: admission.writerAdmission },
		);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		const credential = "Bearer replay-client";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": "session-lineage",
			},
		});
		for (const owner of [{}, {}]) {
			expect(
				await bindRequestPrivateServerToolReplay(owner, runtime, {
					request,
					apiKeyId: null,
					audience: opaqueRuntimeId("model-route-caller", credential),
					lineage: "session-lineage",
				}),
			).toBe(false);
		}
		expect(runtime.codec.getWriterReadiness()).toEqual({ status: "ready" });
		expect(reservationCalls).toBe(1);
		await expect(
			runtime.codec.decode(readerToken, BINDING),
		).resolves.toMatchObject(PAYLOAD);
	});

	it("copies caller key bytes and exposes no key bytes or IDs", async () => {
		const active = [...ACTIVE_BYTES];
		const retained = [...RETAINED_BYTES];
		const activeToken = await enabledCodec(
			"active-id-sentinel",
			ACTIVE_BYTES,
		).encode(BINDING, PAYLOAD);
		const retainedToken = await enabledCodec(
			"retained-id-sentinel",
			RETAINED_BYTES,
		).encode(BINDING, PAYLOAD);
		const runtime = await createServerToolReplayRuntime(
			readyState("active-id-sentinel", [
				{ id: "active-id-sentinel", status: "active", key: active },
				{ id: "retained-id-sentinel", status: "retained", key: retained },
			]),
		);

		active.fill(0);
		retained.fill(0);

		expect(runtime.status).toBe("ready");
		if (runtime.status !== "ready") throw new Error("runtime was not ready");
		await expect(
			runtime.codec.decode(activeToken, BINDING),
		).resolves.toMatchObject(PAYLOAD);
		await expect(
			runtime.codec.decode(retainedToken, BINDING),
		).resolves.toMatchObject(PAYLOAD);
		const serialized = JSON.stringify(runtime);
		expect(serialized).toBe('{"status":"ready","codec":{}}');
		expect(serialized).not.toContain("active-id-sentinel");
		expect(serialized).not.toContain("retained-id-sentinel");
		expectDeeplyFrozen(runtime);
	});

	it("zeroes every temporary key copy exactly once after successful construction", async () => {
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(
				readyState("next-active", [
					{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
					{
						id: "old-retained",
						status: "retained",
						key: [...RETAINED_BYTES],
					},
				]),
			),
		);

		expect((await capture.result).status).toBe("ready");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES, RETAINED_BYTES]);
	});

	it("zeroes earlier copies after a late invalid record", async () => {
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(
				readyState("next-active", [
					{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
					{
						id: "old-retained",
						status: "retained",
						key: [...RETAINED_BYTES],
					},
					{
						id: "late-revoked",
						status: "revoked",
						key: [...REVOKED_BYTES],
					} as unknown as Extract<
						ServerToolReplayKeysState,
						{ status: "ready" }
					>["keys"][number],
				]),
			),
		);

		expect((await capture.result).status).toBe("unavailable");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES, RETAINED_BYTES]);
	});

	it("zeroes earlier copies when a later record getter throws", async () => {
		const throwingRecord = new Proxy<Record<string, unknown>>(
			{},
			{
				get() {
					throw new Error("hostile record getter");
				},
			},
		);
		const state = {
			status: "ready",
			activeKeyId: "next-active",
			keys: [
				{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
				throwingRecord,
			],
		} as unknown as ServerToolReplayKeysState;
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(state),
		);

		expect((await capture.result).status).toBe("unavailable");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES]);
	});

	it("zeroes a copied active key after an active-key ID mismatch", async () => {
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(
				readyState("missing", [
					{ id: "current", status: "active", key: [...ACTIVE_BYTES] },
				]),
			),
		);

		expect((await capture.result).status).toBe("unavailable");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES]);
	});

	it("zeroes selected and non-selected active copies after a count mismatch", async () => {
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(
				readyState("current", [
					{ id: "current", status: "active", key: [...ACTIVE_BYTES] },
					{ id: "other", status: "active", key: [...RETAINED_BYTES] },
				]),
			),
		);

		expect((await capture.result).status).toBe("unavailable");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES, RETAINED_BYTES]);
	});

	it("zeroes all temporary copies when codec construction rejects key material", async () => {
		const capture = captureZeroedKeyCopies(() =>
			createServerToolReplayRuntime(
				readyState("next-active", [
					{ id: "next-active", status: "active", key: [...ACTIVE_BYTES] },
					{
						id: "old-retained",
						status: "retained",
						key: [...ACTIVE_BYTES],
					},
				]),
			),
		);

		expect((await capture.result).status).toBe("unavailable");
		expectKeyCopiesZeroedExactlyOnce(capture, [ACTIVE_BYTES, ACTIVE_BYTES]);
	});
});
