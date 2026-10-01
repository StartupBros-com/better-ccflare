import { describe, expect, test } from "bun:test";
import {
	CodexCacheDiagnostics,
	reconcileCacheUsage,
} from "./cache-diagnostics";
import { sanitizeCacheFacts } from "./cache-telemetry";

const body = {
	model: "model",
	input: [{ role: "user", content: "PRIVATE-PREFIX" }],
	instructions: "PRIVATE-INSTRUCTIONS",
	tools: [],
	prompt_cache_key: "PRIVATE-KEY",
	reasoning: { effort: "high" },
};
const usage = {
	input_tokens: 1000,
	input_tokens_details: { cached_tokens: 900 },
	output_tokens: 10,
};
const context = {
	headers: new Headers({ "user-agent": "client/1" }),
	wireHeaders: new Headers({ "user-agent": "wire/1", version: "1" }),
	buildEpoch: "build-1",
	capabilityRevision: "codex-observation-v1",
	keyEpoch: "key-v1",
};
function harness() {
	let now = 100;
	const rows: Record<string, unknown>[] = [];
	const observer = new CodexCacheDiagnostics(
		(row) => rows.push(sanitizeCacheFacts(row)),
		() => now,
		(row) => rows.push(sanitizeCacheFacts(row)),
	);
	return {
		observer,
		rows,
		at(value: number) {
			now = value;
		},
		done(
			id: string,
			request = body,
			ctx = context,
			transport: "http" | "websocket" = "http",
		) {
			observer.prepare(id, "account", "session", request, ctx);
			observer.dispatched(id, transport);
			observer.finish(id, usage, true);
			const row = rows.at(-1);
			if (!row) throw new Error("missing terminal observation");
			return row;
		},
	};
}
describe("strict cache cohort qualification", () => {
	test("similar size without exact preserved prefix is excluded", () => {
		const h = harness();
		h.done("a");
		const row = h.done("b", {
			...body,
			input: [{ role: "user", content: "OTHER-PREFIX!" }],
		});
		expect(row).toMatchObject({
			cache_cohort_qualification: "excluded",
			cache_cohort_reason: "prefix_changed",
			strict_prior_support: 0,
		});
	});
	test.each([
		"tools",
		"instructions",
		"reasoning",
		"model",
		"prompt_cache_key",
	])("changed %s cannot qualify", (key) => {
		const h = harness();
		h.done("a");
		const changed = {
			...body,
			[key]:
				key === "tools"
					? [{ type: "function", name: "other" }]
					: key === "reasoning"
						? { effort: "low" }
						: "changed",
		};
		const row = h.done("b", changed);
		expect(row.cache_cohort_qualification).not.toBe("qualified");
	});
	test.each([
		"buildEpoch",
		"capabilityRevision",
		"keyEpoch",
	])("changed %s excludes exact-prefix cohorts", (key) => {
		const h = harness();
		h.done("a");
		expect(h.done("b", body, { ...context, [key]: "changed" })).toMatchObject({
			cache_cohort_qualification: "excluded",
			cache_cohort_reason: "changed_controls",
		});
	});
	test("missing dimensions and cross-observer digest epoch stay unknown", () => {
		const h = harness();
		h.done("a");
		expect(
			h.done("b", body, {
				...context,
				buildEpoch: undefined,
			} as typeof context),
		).toMatchObject({
			cache_cohort_qualification: "unknown",
			cache_cohort_reason: "missing_dimensions",
		});
		const other = harness();
		expect(other.done("c").cache_cohort_qualification).toBe("unknown");
		expect(h.rows.at(-1)?.digest_epoch_digest).not.toBe(
			other.rows.at(-1)?.digest_epoch_digest,
		);
	});
	test("prepared, dispatch, terminal, and completed-prior gaps are separate", () => {
		const h = harness();
		h.at(100);
		h.observer.prepare("a", "account", "session", body, context);
		h.at(200);
		h.observer.dispatched("a", "http");
		h.at(400);
		h.observer.finish("a", usage, true);
		h.at(500);
		h.observer.prepare("b", "account", "session", body, context);
		h.at(800);
		h.observer.dispatched("b", "http");
		h.at(900);
		h.observer.finish("b", usage, true);
		expect(h.rows.at(-1)).toMatchObject({
			prepared_at_ms: 500,
			dispatched_at_ms: 800,
			terminal_at_ms: 900,
			prepare_to_dispatch_ms: 300,
			dispatch_to_terminal_ms: 100,
			prior_completed_to_prepare_ms: 100,
			prior_completed_to_dispatch_ms: 400,
			cache_cohort_qualification: "qualified",
			strict_prior_support: 1,
			cache_write_tokens: null,
			upstream_cache_residency: "unknown",
			usage_input_semantics: "physical_inclusive",
		});
	});
	test("response SSE cannot be confused with native physical HTTP or WebSocket", () => {
		const h = harness();
		h.done("a");
		const row = h.done("b", body, context, "websocket");
		expect(row).toMatchObject({
			physical_transport: "websocket",
			cache_cohort_qualification: "excluded",
			cache_cohort_reason: "changed_controls",
		});
	});
	test("usage reconciles only exact one-attempt populations with additive logical fields", () => {
		const physical = {
			gateway_request_digest: "a".repeat(64),
			gateway_attempt_digest: "b".repeat(64),
			input_tokens: 1000,
			cached_tokens: 900,
		};
		const logical = {
			gateway_request_digest: "a".repeat(64),
			gateway_attempt_digest: "b".repeat(64),
			physical_attempt_count: 1,
			input_tokens: 100,
			cache_read_input_tokens: 900,
			cache_creation_input_tokens: 0,
		};
		expect(reconcileCacheUsage(physical, logical)).toBe("matched");
		expect(
			reconcileCacheUsage(physical, { ...logical, physical_attempt_count: 2 }),
		).toBe("unknown");
		expect(
			reconcileCacheUsage(physical, {
				...logical,
				gateway_attempt_digest: "c".repeat(64),
			}),
		).toBe("unknown");
		expect(
			reconcileCacheUsage(physical, { ...logical, input_tokens: 1000 }),
		).toBe("mismatch");
	});
	test("incomplete, missing-dispatch and native-continuation predecessors cannot qualify", () => {
		const h = harness();
		h.observer.prepare("incomplete", "account", "session", body, context);
		h.observer.dispatched("incomplete", "http");
		h.observer.finish("incomplete", usage, false);
		expect(h.done("next").cache_cohort_reason).toBe("no_prior");
		const noDispatch = harness();
		noDispatch.observer.prepare(
			"unobserved",
			"account",
			"session",
			body,
			context,
		);
		noDispatch.observer.finish("unobserved", usage, true);
		expect(noDispatch.done("following")).toMatchObject({
			cache_cohort_qualification: "unknown",
			cache_cohort_reason: "missing_dimensions",
		});
		const websocket = harness();
		websocket.done("ws1", body, context, "websocket");
		expect(websocket.done("ws2", body, context, "websocket")).toMatchObject({
			cache_cohort_qualification: "unknown",
			cache_cohort_reason: "physical_parameters_unobserved",
		});
	});

	test("observation callbacks and cyclic hashing never change body or escape", () => {
		const observer = new CodexCacheDiagnostics(
			() => {
				throw new Error("PRIVATE-FAILURE");
			},
			Date.now,
			() => {
				throw new Error("PRIVATE-FAILURE");
			},
		);
		const original = JSON.stringify(body);
		expect(() => {
			observer.prepare("a", "account", "session", body, context);
			observer.dispatched("a", "http");
			observer.finish("a", usage, true);
		}).not.toThrow();
		const cycle: Record<string, unknown> = { ...body };
		cycle.self = cycle;
		expect(() =>
			observer.prepare("b", "account", "session", cycle, context),
		).not.toThrow();
		expect(JSON.stringify(body)).toBe(original);
	});
	test("hashing and retention bounds give explicit unknown coverage", () => {
		const h = harness();
		const row = h.done("big", {
			...body,
			instructions: "x".repeat(8 * 1024 * 1024 + 1),
		});
		expect(row).toMatchObject({
			fingerprint_complete: false,
			cache_cohort_qualification: "unknown",
		});
		expect(h.rows.some((row) => row.gap_reason === "byte_limit")).toBe(true);
		for (let i = 0; i < 100; i++) h.done(`r${i}`);
		expect(h.rows.at(-1)?.history_count).toBe(64);
		h.at(1800001 + 100);
		expect(h.done("expired").cache_cohort_reason).toBe("no_prior");
		expect(JSON.stringify(h.rows)).not.toContain("PRIVATE-");
	});
});
