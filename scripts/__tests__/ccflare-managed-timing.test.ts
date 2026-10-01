import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	createAcceptedTiming,
	monotonicNowNs,
	bootIdentity,
	signManagedTiming,
	verifyManagedTiming,
	claimManagedTiming,
	retirementBudgetMs,
	assertManagedWorkAvailable,
	bindManagedRequest,
	inheritManagedRequest,
	managedRemainingMs,
	registerManagedTerminal,
	publishManagedTerminal,
} from "../ccflare-managed-timing.mjs";
import { createGuard } from "../ccflare-guard.mjs";
import { resolveNodeExecutable } from "./node-runtime";
const nonce = "a".repeat(32),
	source = "b".repeat(40),
	secret = randomBytes(32);
const id = "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01";
const accepted = createAcceptedTiming(0n);
const binding = {
	bootId: bootIdentity(),
	ingressNonce: nonce,
	candidateNonce: nonce,
	generation: 1,
	backendSourceSha: source,
	requestId: id,
	attemptOrdinal: 1,
	method: "POST",
	path: "/v1/messages",
};
test("G3a declares the new finite default and preserves stage budgets", () => {
	expect(accepted).toEqual({
		acceptedAtMonoNs: "0",
		preResponseDeadlineMonoNs: "600000000000",
		workDeadlineMonoNs: "1440000000000",
		cleanupDeadlineMonoNs: "1470000000000",
		effectiveCapMs: 1470000,
		cleanupReserveMs: 30000,
	});
	expect(retirementBudgetMs(60000)).toBe(80000);
	expect(retirementBudgetMs(900000)).toBe(920000);
});
test("caller may narrow a relative cap but cannot extend it or inject absolute time", () => {
	expect(createAcceptedTiming(0n, "100000").workDeadlineMonoNs).toBe(
		"80000000000",
	);
	for (const input of ["1800000", "-1", "NaN", "Infinity", "100x", "0", "01"])
		expect(createAcceptedTiming(0n, input)).toEqual(accepted);
});
test("same-host native Node/Bun Linux boot-time clock transfers without wall time", () => {
	const before = monotonicNowNs();
	const output = JSON.parse(
		execFileSync(
			resolveNodeExecutable(),
			[
				"--input-type=module",
				"-e",
				`import { monotonicNowNs, bootIdentity } from ${JSON.stringify(new URL("../ccflare-managed-timing.mjs", import.meta.url).href)}; console.log(JSON.stringify({ now: String(monotonicNowNs()), boot: bootIdentity() }))`,
			],
			{ encoding: "utf8" },
		),
	);
	const after = monotonicNowNs();
	expect(BigInt(output.now) >= before && BigInt(output.now) <= after).toBe(
		true,
	);
	expect(output.boot).toBe(bootIdentity());
});
test("authenticated timing is canonical, bound to generation, path, origin and request", () => {
	const envelope = signManagedTiming(accepted, binding, secret);
	expect(verifyManagedTiming(envelope, binding, secret, 1n)).toEqual(accepted);
	for (const wrong of [
		{ generation: 2 },
		{ bootId: "c".repeat(36) },
		{ candidateNonce: "c".repeat(32) },
		{ path: "/v1/responses" },
		{ requestId: "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a02" },
	])
		expect(
			verifyManagedTiming(envelope, { ...binding, ...wrong }, secret, 1n),
		).toBeNull();
	expect(
		verifyManagedTiming(envelope, binding, randomBytes(32), 1n),
	).toBeNull();
	expect(verifyManagedTiming(envelope + "=", binding, secret, 1n)).toBeNull();
	expect(
		verifyManagedTiming(envelope, binding, secret, 1440000000000n),
	).toBeNull();
});
test("dispatch claims reject exact replay without renewing queue deadlines", () => {
	const claims = new Map();
	expect(claimManagedTiming(claims, accepted, binding, 1n, 2)).toBe(true);
	expect(claimManagedTiming(claims, accepted, binding, 2n, 2)).toBe(false);
	expect(
		claimManagedTiming(
			claims,
			accepted,
			{ ...binding, attemptOrdinal: 2 },
			599000000000n,
			2,
		),
	).toBe(true);
	expect(
		claimManagedTiming(
			claims,
			accepted,
			{ ...binding, attemptOrdinal: 3 },
			599000000000n,
			2,
		),
	).toBe(false);
	expect(
		claimManagedTiming(
			claims,
			accepted,
			{ ...binding, attemptOrdinal: 3 },
			1470000000000n,
			2,
		),
	).toBe(false);
});

test("Responses adaptation inherits one accepted budget and one terminal authority", () => {
	const original = new Request("http://local/v1/responses"),
		derived = new Request("http://local/v1/messages");
	bindManagedRequest(original, createAcceptedTiming(monotonicNowNs(), "1000"));
	inheritManagedRequest(original, derived);
	const causes: string[] = [];
	registerManagedTerminal(derived, (cause) => causes.push(cause));
	expect(managedRemainingMs(derived)).toBeLessThanOrEqual(800);
	expect(managedRemainingMs(derived)).toBeGreaterThan(750);
	publishManagedTerminal(original);
	publishManagedTerminal(derived);
	expect(causes).toEqual(["accepted_request_deadline"]);
});
test("wall jumps and additional chunks cannot renew accepted timing", () => {
	const previous = Date.now;
	const envelope = signManagedTiming(accepted, binding, secret);
	try {
		Date.now = () => 0;
		expect(
			verifyManagedTiming(envelope, binding, secret, 599000000000n),
		).toEqual(accepted);
		Date.now = () => Number.MAX_SAFE_INTEGER;
		expect(
			verifyManagedTiming(envelope, binding, secret, 1439999999999n),
		).toEqual(accepted);
		expect(
			verifyManagedTiming(envelope, binding, secret, 1440000000000n),
		).toBeNull();
	} finally {
		Date.now = previous;
	}
});

test("expired shared clock vetoes helper/HTTP/frame writes before timers run", () => {
	for (const lane of [
		"credential_acquisition",
		"helper",
		"http",
		"websocket",
	]) {
		const request = new Request("http://local/v1/messages"),
			order: string[] = [];
		bindManagedRequest(request, accepted, (error) => {
			order.push(error.code);
		});
		registerManagedTerminal(request, (cause) => order.push(cause));
		let sends = 0;
		expect(() => {
			assertManagedWorkAvailable(request, 1440000000000n);
			sends++;
		}).toThrow();
		expect(sends).toBe(0);
		expect(order).toEqual([
			"accepted_request_deadline",
			"ACCEPTED_REQUEST_DEADLINE",
		]);
	}
	expect(() =>
		assertManagedWorkAvailable(new Request("http://local")),
	).not.toThrow();
});

test("managed guard refuses missing ingress nonce before listening", () => {
	expect(() =>
		createGuard({
			env: {
				CCFLARE_MANAGED_TIMING: "1",
				CCFLARE_GUARD_CORRELATION_SECRET: secret.toString("base64url"),
				CCFLARE_MANAGED_CANDIDATE_NONCE: nonce,
				CCFLARE_SOURCE_SHA: source,
			},
			logger: () => {},
		}),
	).toThrow("managed guard requires");
});
