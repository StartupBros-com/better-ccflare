import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ServerToolReplayKeysState } from "@better-ccflare/config";
import type {
	ServerToolReplayEnvelopeBinding,
	ServerToolReplayEnvelopePayload,
} from "@better-ccflare/providers";

// Focused source-worktree tests must not require generated database workers
// pulled in transitively by the providers package root.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { createServerToolReplayEnvelopeCodec } = await import(
	"@better-ccflare/providers"
);
const { createServerToolReplayRuntime } = await import(
	"./server-tool-replay-runtime"
);

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
			readFleetIssuedCount: () => issued,
			recordIssued: () => {
				issued += 1;
			},
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

describe("server-tool replay runtime", () => {
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
