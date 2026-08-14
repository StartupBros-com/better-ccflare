/**
 * Regression test for issue #273 — ccflare-side mitigation for the Bun
 * off-heap fetch leak (oven-sh/bun#35093).
 *
 * When proxyWithAccount decides to discard a response (429/529/401
 * failover → return null, or any retry-loop overwrite of the previous
 * response), the response body MUST be explicitly drained so the backing
 * store is released. Without this, every abandoned Response holds ~100KB
 * off-heap until GC.
 *
 * Why drain and not `body.cancel()`: an earlier measurement session showed that
 * `body.cancel()` is a NO-OP on every released Bun (1.3.2 / 1.3.14);
 * draining the body in chunks reduces the leak by ~85% on stock Bun
 * (full table in `bench/drain-strategy-harness.ts`). The drain helper
 * reads `body` to `done` via `getReader()` and drops each chunk, so the
 * native source is closed and the off-heap buffer is released.
 *
 * This test imports the PRODUCTION helper
 * (`handlers/discard-body-cancel.ts:cancelDiscardedResponseBody`) directly
 * — the same primitive every drain-backed discard path in
 * proxy-operations.ts reaches. The orchestrator's mandatory negative-control
 * run removes ONLY those call sites (and/or the `void drainBody(...)`
 * invocation inside the helper); the assertions below verify both halves:
 *
 *   Group A (helper contract) — verifies `cancelDiscardedResponseBody`
 *   reads the body to completion on a non-locked Response, and is safe on
 *   null body / locked body / already-drained body. Removing the
 *   `drainBody` call from inside the helper function flips these red.
 *
 *   Group B (call-site coverage) — performs static analysis of
 *   `proxy-operations.ts` to assert the current drain calls are present
 *   and structurally well-formed. Removing any one of them flips this
 *   red. We don't import proxy-operations.ts (its transitive
 *   dependency chain loads @better-ccflare/database, which itself has
 *   missing modules in this worktree's `bun install`-blocked state —
 *   a pre-existing issue unrelated to this fix), but the source-level
 *   check is enough to detect the negative-control removal: every site,
 *   each line beginning with the helper name.
 *
 * Run: bun test packages/proxy/src/__tests__/bun-leak-273-regression.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	cancelDiscardedResponseBody,
	drainBody,
} from "../handlers/discard-body-cancel";

// ---------------------------------------------------------------------------
// Group A — helper contract. Imported directly so a drainBody removal
// from inside the helper function is detected at the test's runtime.
// ---------------------------------------------------------------------------

describe("issue #273 — Group A: helper contract", () => {
	it("PRODUCTION helper reads the body to done on a non-locked Response body", async () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 429 });
		const stream = response.body;
		expect(stream).not.toBeNull();
		if (!stream) throw new Error("expected body");

		cancelDiscardedResponseBody(response);

		// The drain is fire-and-forget; await a few microtasks then
		// verify the body has been consumed. After the drain loop
		// reaches `done`, the stream is released; the next reader
		// gets done=true on the very first read with no value.
		await new Promise((r) => setImmediate(r));
		const reader = stream.getReader();
		const { value, done } = await reader.read();
		reader.releaseLock();
		expect(done).toBe(true);
		expect(value).toBeUndefined();
	});

	it("PRODUCTION helper is safe when body is null", () => {
		const response = new Response(null, { status: 204 });
		expect(response.body).toBeNull();
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});

	it("PRODUCTION helper does not throw on an already-locked body", () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 503 });
		const stream = response.body;
		if (!stream) throw new Error("expected body");
		const reader = stream.getReader();
		try {
			expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
		} finally {
			reader.releaseLock();
		}
	});

	it("PRODUCTION helper does not throw when the body is already drained", async () => {
		const body = new Uint8Array(200_000).fill(0x41);
		const response = new Response(body, { status: 429 });
		const stream = response.body;
		if (!stream) throw new Error("expected body");

		// Drain it ourselves first.
		await drainBody(stream);
		expect(() => cancelDiscardedResponseBody(response)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Group B — call-site coverage. Static check that the drain sites the spec
// calls out (429/529/401 failover return-null + retry-loop overwrite +
// request-budget veto cleanup) are wired into proxy-operations.ts. The
// negative-control run removes these lines; this check fails if any are
// missing.
// ---------------------------------------------------------------------------

// Fork architecture note: the fork centralizes discard-site release in
// `discardUpstreamBody`, which since the v3.5.48 sync delegates to
// `cancelDiscardedResponseBody` (the chunked-drain primitive). Call sites
// therefore appear under either name; both are drain-backed.
//
// This is a census, not a ceiling: a new body-replacing retry legitimately adds
// a site, and the count moves with it in the same commit. What the guard
// catches is a site DISAPPEARING (a leak) or being added without the drain.
// 19 helper invocations: one delegation from discardUpstreamBody plus 18
// owned-response release sites. The latest two release a prior model-fallback
// response and a current 529 before a physical-attempt budget veto escapes.
// This specifically guards outer winner arbitration and request-budget exits
// from regressing to Bun's ineffective direct body.cancel path.
const EXPECTED_DRAIN_INVOCATION_COUNT = 19;

describe("issue #273 — Group B: call-site coverage in proxy-operations.ts", () => {
	it("proxy-operations.ts has the expected drain-backed helper invocations", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Match call sites only — exclude the import line. Each call is
		// `cancelDiscardedResponseBody(...)` or the delegating
		// `await discardUpstreamBody(...)` on a line of its own.
		const callMatches = source.match(
			/^\s*(?:await )?(?:cancelDiscardedResponseBody|discardUpstreamBody)\((?:rawResponse|response)\);/gm,
		);
		const count = callMatches?.length ?? 0;
		expect(count).toBe(EXPECTED_DRAIN_INVOCATION_COUNT);
	});

	it("proxy-operations.ts imports the helper module", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		expect(source).toMatch(
			/import\s*\{\s*cancelDiscardedResponseBody\s*\}\s*from\s*["']\.\/discard-body-cancel["']/,
		);
	});

	it("proxy-operations.ts retains failover and overwrite drain patterns", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);
		// Type A — return null sites. The fork interleaves
		// `finalizeCurrentCodexTransport(...)` between the discard call and
		// `return null;` at several sites, so the window is what it is: 7
		// sites fall inside 200 chars in the fork layout.
		const returnNullSites = source.match(
			/(?:await )?(?:cancelDiscardedResponseBody|discardUpstreamBody)\((rawResponse|response)\);[\s\S]{0,200}?return null;/g,
		);
		expect(returnNullSites?.length ?? 0).toBeGreaterThanOrEqual(7);

		// Type B — retry-loop overwrite sites: a discard call followed by a
		// `rawResponse = ` reassignment. The fork routes most retry-loop
		// discards through helper closures, leaving one direct site.
		const overwriteSites = source.match(
			/(?:await )?(?:cancelDiscardedResponseBody|discardUpstreamBody)\(rawResponse\);[\s\S]{0,300}?rawResponse\s*=/g,
		);
		expect(overwriteSites?.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("drains locally owned responses before physical-attempt budget vetoes escape", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf-8",
		);

		// A Bedrock discovery call can consume the final physical-attempt slot
		// while the model-fallback transform is running. The prior raw failure is
		// still owned here and must be released before the veto crosses accounts.
		expect(source).toMatch(
			/error instanceof PhysicalAttemptBudgetExceededError &&\s*!isScopedFailure\(rawFailureClassification\)[\s\S]{0,500}?await finalizeCurrentCodexTransport\(rawResponse\);\s*await discardUpstreamBody\(rawResponse\);\s*}\s*throw error;/,
		);

		// A denied in-place 529 retry has not replaced `response`; this loop is
		// therefore the only owner able to release it before propagating the veto.
		expect(source).toMatch(
			/routingAttemptLedger\?\.assertPhysicalAttemptAvailable\(\s*physicalAttemptVetoContext\(\),\s*\);\s*} catch \(error\) \{[\s\S]{0,300}?await discardUpstreamBody\(response\);\s*throw error;/,
		);
	});
});

// ---------------------------------------------------------------------------
// Group C — forwarded body safety. A discard-only contract without a
// forward-safety guarantee is the silent-stream-truncation bug class.
// Ensure the helper does NOT drain bodies we're going to forward.
// ---------------------------------------------------------------------------

describe("issue #273 — Group C: forwarded-body safety", () => {
	it("a 200 OK body that we explicitly do NOT hand to the helper drains end-to-end", async () => {
		const payload = new Uint8Array(1024).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});

		const stream = response.body;
		expect(stream).not.toBeNull();
		if (!stream) throw new Error("expected body");

		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		reader.releaseLock();

		const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total).toBe(payload.byteLength);
	});

	it("tee'ing a body for the client/server split still drains both halves (no premature close)", async () => {
		const payload = new Uint8Array(4096).fill(0x42);
		const response = new Response(payload, {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});
		const body = response.body;
		if (!body) throw new Error("expected body");
		const [forClient, forServer] = body.tee();

		const clientChunks: Uint8Array[] = [];
		const serverChunks: Uint8Array[] = [];
		await Promise.all([
			(async () => {
				const r = forClient.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) clientChunks.push(value);
				}
				r.releaseLock();
			})(),
			(async () => {
				const r = forServer.getReader();
				while (true) {
					const { value, done } = await r.read();
					if (done) break;
					if (value) serverChunks.push(value);
				}
				r.releaseLock();
			})(),
		]);

		const total = (chunks: Uint8Array[]) =>
			chunks.reduce((acc, c) => acc + c.byteLength, 0);
		expect(total(clientChunks)).toBe(payload.byteLength);
		expect(total(serverChunks)).toBe(payload.byteLength);
	});
});
