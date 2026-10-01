// Copied beside immutable managed guard/runner artifacts. No workspace imports.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
export const MANAGED_TIMING_VERSION = "v1";
export const MANAGED_TIMING_HEADER = "x-better-ccflare-managed-timing";
export const CLIENT_TIMEOUT_HEADER = "x-better-ccflare-timeout-ms";
export const DEFAULT_ACCEPTED_CAP_MS = 1_470_000;
export const DEFAULT_CLEANUP_RESERVE_MS = 30_000;
const DOMAIN = "better-ccflare/managed-timing/v1";
const NS_PER_MS = 1_000_000n;
let boot;
// Bun 1.4.2 hrtime is process-relative, unlike Node. /proc/uptime is the
// Linux CLOCK_BOOTTIME value shared by both runtimes, published at 10 ms
// precision. Budgets deliberately use that declared precision, not wall time.
export function monotonicNowNs() {
	const value = readFileSync("/proc/uptime", "utf8").split(" ", 1)[0];
	const match = /^(\d+)\.(\d{2})$/.exec(value);
	if (!match) throw new Error("managed timing requires Linux boot-time clock");
	return BigInt(match[1]) * 1_000_000_000n + BigInt(match[2]) * 10_000_000n;
}
export function bootIdentity() {
	boot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	if (!/^[0-9a-f-]{36}$/.test(boot))
		throw new Error("managed timing requires Linux boot identity");
	return boot;
}
export function retirementBudgetMs(appDrainMs) {
	if (
		!Number.isSafeInteger(appDrainMs) ||
		appDrainMs < 0 ||
		appDrainMs > 2_147_403_647
	)
		throw new RangeError("invalid application drain budget");
	return appDrainMs + 15_000 + 5_000;
}
export function createAcceptedTiming(
	acceptedAt,
	requested,
	policyCapMs = DEFAULT_ACCEPTED_CAP_MS,
	responseStartMs = 600_000,
) {
	if (
		typeof acceptedAt !== "bigint" ||
		acceptedAt < 0n ||
		!Number.isSafeInteger(policyCapMs) ||
		policyCapMs < 1 ||
		policyCapMs > DEFAULT_ACCEPTED_CAP_MS
	)
		throw new RangeError("invalid accepted timing policy");
	let effectiveCapMs = policyCapMs;
	if (typeof requested === "string" && /^[1-9]\d{0,6}$/.test(requested))
		effectiveCapMs = Math.min(effectiveCapMs, Number(requested));
	const cleanupReserveMs = Math.min(
		DEFAULT_CLEANUP_RESERVE_MS,
		Math.floor(effectiveCapMs / 5),
	);
	const cleanup = acceptedAt + BigInt(effectiveCapMs) * NS_PER_MS;
	const work = cleanup - BigInt(cleanupReserveMs) * NS_PER_MS;
	return {
		acceptedAtMonoNs: String(acceptedAt),
		preResponseDeadlineMonoNs: String(
			acceptedAt +
				BigInt(Math.min(responseStartMs, effectiveCapMs - cleanupReserveMs)) *
					NS_PER_MS,
		),
		workDeadlineMonoNs: String(work),
		cleanupDeadlineMonoNs: String(cleanup),
		effectiveCapMs,
		cleanupReserveMs,
	};
}
function canonicalTiming(timing) {
	if (
		!timing ||
		Object.keys(timing).sort().join() !==
			[
				"acceptedAtMonoNs",
				"preResponseDeadlineMonoNs",
				"workDeadlineMonoNs",
				"cleanupDeadlineMonoNs",
				"effectiveCapMs",
				"cleanupReserveMs",
			]
				.sort()
				.join()
	)
		return false;
	for (const key of [
		"acceptedAtMonoNs",
		"preResponseDeadlineMonoNs",
		"workDeadlineMonoNs",
		"cleanupDeadlineMonoNs",
	])
		if (!/^(0|[1-9]\d{0,18})$/.test(timing[key])) return false;
	const a = BigInt(timing.acceptedAtMonoNs),
		h = BigInt(timing.preResponseDeadlineMonoNs),
		w = BigInt(timing.workDeadlineMonoNs),
		c = BigInt(timing.cleanupDeadlineMonoNs);
	return (
		Number.isSafeInteger(timing.effectiveCapMs) &&
		timing.effectiveCapMs >= 1 &&
		timing.effectiveCapMs <= DEFAULT_ACCEPTED_CAP_MS &&
		timing.cleanupReserveMs ===
			Math.min(30_000, Math.floor(timing.effectiveCapMs / 5)) &&
		c === a + BigInt(timing.effectiveCapMs) * NS_PER_MS &&
		w === c - BigInt(timing.cleanupReserveMs) * NS_PER_MS &&
		a < h &&
		h <= w &&
		h <= a + 600_000n * NS_PER_MS
	);
}
function validBinding(b) {
	return (
		b &&
		/^[0-9a-f-]{36}$/.test(b.bootId) &&
		/^[0-9a-f]{32}$/.test(b.ingressNonce) &&
		/^[0-9a-f]{32}$/.test(b.candidateNonce) &&
		/^[0-9a-f]{40}$/.test(b.backendSourceSha) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			b.requestId,
		) &&
		Number.isSafeInteger(b.generation) &&
		b.generation > 0 &&
		Number.isSafeInteger(b.attemptOrdinal) &&
		b.attemptOrdinal > 0 &&
		b.attemptOrdinal <= 1_000_000 &&
		/^[A-Z]{3,10}$/.test(b.method) &&
		typeof b.path === "string" &&
		b.path.startsWith("/") &&
		b.path.length <= 2048 &&
		!/[\r\n]/.test(b.path)
	);
}
function payload(t, b) {
	return [
		MANAGED_TIMING_VERSION,
		"linux-boottime-10ms",
		b.bootId,
		b.ingressNonce,
		b.candidateNonce,
		b.generation,
		b.backendSourceSha,
		b.requestId,
		b.attemptOrdinal,
		b.method,
		b.path,
		t.acceptedAtMonoNs,
		t.preResponseDeadlineMonoNs,
		t.workDeadlineMonoNs,
		t.cleanupDeadlineMonoNs,
		t.effectiveCapMs,
		t.cleanupReserveMs,
	];
}
export function signManagedTiming(t, b, secret) {
	if (!canonicalTiming(t) || !validBinding(b) || secret?.byteLength !== 32)
		throw new Error("invalid managed timing envelope");
	const encoded = Buffer.from(JSON.stringify(payload(t, b))).toString(
		"base64url",
	);
	const signature = createHmac("sha256", secret)
		.update(`${DOMAIN}\n${encoded}`)
		.digest("base64url");
	return `${encoded}.${signature}`;
}
export function verifyManagedTiming(
	envelope,
	b,
	secret,
	now = monotonicNowNs(),
) {
	if (
		typeof envelope !== "string" ||
		envelope.length > 4096 ||
		!validBinding(b) ||
		secret?.byteLength !== 32
	)
		return null;
	try {
		const [encoded, signature, extra] = envelope.split(".");
		if (
			extra !== undefined ||
			!/^[A-Za-z0-9_-]+$/.test(encoded) ||
			!/^[A-Za-z0-9_-]{43}$/.test(signature)
		)
			return null;
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.toString("base64url") !== encoded) return null;
		const actual = Buffer.from(signature, "base64url"),
			expected = createHmac("sha256", secret)
				.update(`${DOMAIN}\n${encoded}`)
				.digest();
		if (
			actual.length !== 32 ||
			actual.toString("base64url") !== signature ||
			!timingSafeEqual(actual, expected)
		)
			return null;
		const parts = JSON.parse(decoded.toString());
		if (!Array.isArray(parts) || parts.length !== 17) return null;
		const t = {
			acceptedAtMonoNs: parts[11],
			preResponseDeadlineMonoNs: parts[12],
			workDeadlineMonoNs: parts[13],
			cleanupDeadlineMonoNs: parts[14],
			effectiveCapMs: parts[15],
			cleanupReserveMs: parts[16],
		};
		if (
			!canonicalTiming(t) ||
			JSON.stringify(parts) !== JSON.stringify(payload(t, b)) ||
			BigInt(t.acceptedAtMonoNs) > now ||
			BigInt(t.workDeadlineMonoNs) <= now
		)
			return null;
		return t;
	} catch {
		return null;
	}
}
export function claimManagedTiming(
	claims,
	t,
	b,
	now = monotonicNowNs(),
	limit = 4096,
) {
	if (
		!canonicalTiming(t) ||
		!validBinding(b) ||
		now >= BigInt(t.workDeadlineMonoNs)
	)
		return false;
	for (const [key, deadline] of claims) if (deadline <= now) claims.delete(key);
	const key = `${b.generation}:${b.requestId}:${b.attemptOrdinal}`;
	if (claims.has(key) || claims.size >= limit) return false;
	claims.set(key, BigInt(t.cleanupDeadlineMonoNs));
	return true;
}
export function managedTimingBinding(envelope) {
	// Untrusted lookup only. The full envelope must still authenticate against
	// configured generation/nonce/source before any work or duplicate claim.
	try {
		if (typeof envelope !== "string" || envelope.length > 4096) return {};
		const p = JSON.parse(
			Buffer.from(envelope.split(".")[0], "base64url").toString(),
		);
		return { requestId: p[7], attemptOrdinal: p[8], ingressNonce: p[3] };
	} catch {
		return {};
	}
}

const requestTimings = new WeakMap();
export function bindManagedRequest(request, timing, abort) {
	requestTimings.set(request, { timing, abort, recorders: new Set() });
}
export function inheritManagedRequest(original, derived) {
	const state = requestTimings.get(original);
	if (state) requestTimings.set(derived, state);
}
export function managedRemainingMs(request) {
	const state = requestTimings.get(request);
	return state
		? Math.max(
				0,
				Number(BigInt(state.timing.workDeadlineMonoNs) - monotonicNowNs()) /
					1_000_000 -
					10,
			)
		: null;
}
export function registerManagedTerminal(request, recorder) {
	const state = requestTimings.get(request);
	if (!state) return;
	state.recorders.add(recorder);
	if (state.published) {
		try {
			recorder("accepted_request_deadline");
		} catch {
			/* preserve selected terminal */
		}
	}
}
export function publishManagedTerminal(request) {
	const state = requestTimings.get(request);
	if (!state || state.published) return;
	state.published = true;
	for (const recorder of state.recorders) {
		try {
			recorder("accepted_request_deadline");
		} catch {
			/* observation cannot block owned abort */
		}
	}
}

export function assertManagedWorkAvailable(request, now) {
	const state = requestTimings.get(request);
	if (!state) return;
	now ??= monotonicNowNs();
	if (now < BigInt(state.timing.workDeadlineMonoNs) - 10_000_000n) return;
	publishManagedTerminal(request);
	const error = Object.assign(new Error("Accepted request deadline expired"), {
		code: "ACCEPTED_REQUEST_DEADLINE",
	});
	state.abort?.(error);
	throw error;
}
