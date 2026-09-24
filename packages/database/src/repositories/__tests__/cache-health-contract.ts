import { expect } from "bun:test";
import {
	type AlertEvent,
	type CacheHealthState,
	cacheHealthScopeKey,
} from "@better-ccflare/types";
import type { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { CacheHealthRepository } from "../cache-health.repository";

export const CACHE_TEST_TIME = 1_800_000_000_000;

export async function seedCacheAccount(
	adapter: BunSqlAdapter,
	id = "cache-a",
	generation = 1,
) {
	await adapter.run(
		"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
		[id, id, "codex", generation],
	);
}

export async function seedCacheRequest(
	adapter: BunSqlAdapter,
	id: string,
	overrides: Record<string, unknown> = {},
) {
	const row = {
		id,
		timestamp: CACHE_TEST_TIME,
		method: "POST",
		path: "/v1/messages",
		account_used: "cache-a",
		status_code: 200,
		success: true,
		response_time_ms: 1,
		model: "observed",
		applied_model: "rewrite",
		routed_model: "route-target",
		routed_provider: "codex",
		account_generation: 1,
		cache_health_native: 1,
		internal_origin: 0,
		input_tokens: 1000,
		cache_read_input_tokens: 9000,
		cache_creation_input_tokens: 0,
		prompt_tokens: 10_000,
		...overrides,
	};
	await adapter.run(
		`INSERT INTO requests (${Object.keys(row).join(", ")}) VALUES (${Object.keys(
			row,
		)
			.map(() => "?")
			.join(", ")})`,
		Object.values(row),
	);
}

export function cacheTestState(): CacheHealthState {
	return {
		version: 1,
		scope: {
			kind: "account",
			provider: "codex",
			model: "observed",
			accountId: "cache-a",
			accountGeneration: 1,
		},
		revision: 1,
		lastBucketEnd: CACHE_TEST_TIME + 600_000,
		policyFingerprint: "test",
		enrolled: true,
		healthyEnds: [],
		reportingEnd: null,
		contributors: [{ accountId: "cache-a", accountGeneration: 1 }],
		reuse: {
			sequence: 1,
			incident: {
				sequence: 1,
				severity: "warning",
				lastNotificationAt: CACHE_TEST_TIME,
			},
			bad: null,
			recovery: null,
		},
		telemetry: { sequence: 0, incident: null, bad: null, recovery: null },
	};
}

export function cacheTestAlert(id = "cache-test-alert"): AlertEvent {
	return {
		id,
		timestamp: CACHE_TEST_TIME,
		type: "cache_efficiency_low",
		severity: "warning",
		title: "Recorded cache reuse",
		message: "Fixture",
		value: 80,
		threshold: 90,
		account: "cache-a",
		model: "observed",
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

/** Same observable contract runs on real SQLite and the disposable PG schema. */
export async function cacheHealthRepositoryContract(adapter: BunSqlAdapter) {
	const repo = new CacheHealthRepository(adapter);
	await seedCacheAccount(adapter);
	for (const [index, path] of [
		"/v1/messages",
		"/v1/responses",
		"/v1/chat/completions",
	].entries()) {
		await seedCacheRequest(adapter, `path-${index}`, {
			path,
			cache_creation_input_tokens: null,
		});
	}
	await seedCacheRequest(adapter, "missing", {
		input_tokens: null,
		cache_read_input_tokens: null,
		cache_creation_input_tokens: null,
		prompt_tokens: null,
	});
	await seedCacheRequest(adapter, "invalid", { input_tokens: -1 });
	await seedCacheRequest(adapter, "zero", {
		input_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		prompt_tokens: 0,
	});
	await seedCacheRequest(adapter, "known-zero-missing", {
		input_tokens: null,
		cache_read_input_tokens: null,
		cache_creation_input_tokens: null,
		prompt_tokens: 0,
	});
	await seedCacheRequest(adapter, "miss", {
		input_tokens: 10_000,
		cache_read_input_tokens: 0,
	});
	await seedCacheRequest(adapter, "inclusive", {
		input_tokens: null,
		prompt_tokens: 10_000,
		cache_read_input_tokens: 9000,
		cache_creation_input_tokens: null,
	});
	for (const state of ["error", "truncated", "client_cancelled", "recovered"]) {
		await seedCacheRequest(adapter, state, { stream_terminal_state: state });
	}
	await seedCacheRequest(adapter, "failed", {
		success: false,
		status_code: 500,
	});
	await seedCacheRequest(adapter, "internal", { internal_origin: 1 });
	await seedCacheRequest(adapter, "outside", {
		timestamp: CACHE_TEST_TIME + 600_000,
	});
	await seedCacheRequest(adapter, "count-tokens", {
		path: "/v1/messages/count_tokens",
	});
	const buckets = await repo.fetchBuckets(
		CACHE_TEST_TIME,
		CACHE_TEST_TIME + 600_000,
	);
	expect(buckets).toHaveLength(1);
	expect(buckets[0]).toMatchObject({
		scope: {
			provider: "codex",
			model: "observed",
			accountId: "cache-a",
			accountGeneration: 1,
		},
		eligible: 7,
		measured: 5,
		missing: 1,
		invalid: 1,
		zeroInput: 2,
		failed: 5,
		internal: 1,
		zeroHit: 1,
		inputTokens: 14_000,
		cacheReadTokens: 36_000,
		cacheWriteTokens: 0,
		totalsValid: true,
	});
	const state = cacheTestState();
	expect(await repo.commit(1, { ...state, revision: 2 }, [])).toBe(false);
	const winners = await Promise.all([
		repo.commit(0, state, [cacheTestAlert()]),
		repo.commit(0, state, [cacheTestAlert()]),
	]);
	expect(winners.sort()).toEqual([false, true]);
	expect(await repo.loadStates(CACHE_TEST_TIME)).toEqual([state]);
	await adapter.run("UPDATE alerts SET acknowledged = 1 WHERE id = ?", [
		cacheTestAlert().id,
	]);
	expect(
		(await repo.loadStates(CACHE_TEST_TIME))[0].reuse.incident,
	).not.toBeNull();
	expect(
		Number(
			(await adapter.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts"))?.n,
		),
	).toBe(1);
	const next = {
		...state,
		revision: 2,
		lastBucketEnd: state.lastBucketEnd + 600_000,
	};
	// Alert id collision rolls the state change back as well.
	expect(await repo.commit(1, next, [cacheTestAlert()])).toBe(false);
	expect(await repo.loadStates(CACHE_TEST_TIME)).toEqual([state]);
	expect(await repo.commit(1, next, [cacheTestAlert("cache-next")])).toBe(true);
	await adapter.run("UPDATE accounts SET created_at = ? WHERE id = ?", [
		2,
		"cache-a",
	]);
	expect(
		await repo.commit(
			2,
			{ ...next, revision: 3, lastBucketEnd: next.lastBucketEnd + 600_000 },
			[cacheTestAlert("stale-generation")],
		),
	).toBe(false);
	expect(await repo.loadStates(CACHE_TEST_TIME)).toEqual([]);
	expect(
		await repo.fetchBuckets(CACHE_TEST_TIME, CACHE_TEST_TIME + 600_000),
	).toEqual([]);
	await adapter.run("DELETE FROM accounts WHERE id = ?", ["cache-a"]);
	await seedCacheAccount(adapter, "cache-a", 3);
	expect(
		await repo.commit(
			0,
			{
				...cacheTestState(),
				scope: { ...state.scope, accountGeneration: 3 },
				contributors: [{ accountId: "cache-a", accountGeneration: 3 }],
			},
			[cacheTestAlert("new-generation")],
		),
	).toBe(true);
	await seedCacheAccount(adapter, "cache-b", 7);
	const providerState: CacheHealthState = {
		...cacheTestState(),
		scope: {
			kind: "provider",
			provider: "codex",
			model: "observed",
			accountId: null,
			accountGeneration: null,
		},
		contributors: [
			{ accountId: "cache-a", accountGeneration: 3 },
			{ accountId: "cache-b", accountGeneration: 7 },
		],
		telemetry: {
			sequence: 1,
			incident: {
				sequence: 1,
				severity: "warning",
				lastNotificationAt: CACHE_TEST_TIME,
			},
			bad: null,
			recovery: null,
		},
	};
	expect(
		await repo.commit(0, providerState, [
			{ ...cacheTestAlert("provider"), account: null },
		]),
	).toBe(true);
	expect(
		(await repo.loadStates(CACHE_TEST_TIME)).find(
			(s) => s.scope.kind === "provider",
		),
	).toEqual(providerState);
	await adapter.run("DELETE FROM accounts WHERE id = ?", ["cache-b"]);
	expect(
		await repo.commit(
			1,
			{
				...providerState,
				revision: 2,
				lastBucketEnd: providerState.lastBucketEnd + 600_000,
			},
			[cacheTestAlert("deleted-contributor")],
		),
	).toBe(false);
	await cacheHealthRetentionContract(adapter);
}

/** Retention is the same on fresh, upgraded and repeatedly migrated SQLite/PG. */
export async function cacheHealthRetentionContract(adapter: BunSqlAdapter) {
	const repo = new CacheHealthRepository(adapter);
	await seedCacheAccount(adapter, "cache-retained", 11);
	const enrolled = cacheTestState();
	enrolled.scope = {
		...enrolled.scope,
		provider: "openai-compatible",
		accountId: "cache-retained",
		accountGeneration: 11,
	};
	enrolled.contributors = [
		{ accountId: "cache-retained", accountGeneration: 11 },
	];
	enrolled.healthyEnds = [CACHE_TEST_TIME, enrolled.lastBucketEnd];
	enrolled.reportingEnd = enrolled.lastBucketEnd;
	enrolled.reuse = {
		sequence: 7,
		incident: null,
		recovery: null,
		bad: {
			buckets: 2,
			evidence: {
				startMs: CACHE_TEST_TIME - 600_000,
				endMs: enrolled.lastBucketEnd,
				eligible: 20,
				measured: 20,
				missing: 0,
				invalid: 0,
				zeroInput: 0,
				failed: 0,
				internal: 0,
				zeroHit: 20,
				inputTokens: 200_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalsValid: true,
				contributors: enrolled.contributors,
			},
		},
	};
	enrolled.telemetry = {
		sequence: 3,
		incident: null,
		bad: enrolled.reuse.bad,
		recovery: enrolled.reuse.bad,
	};
	const provider: CacheHealthState = {
		...structuredClone(enrolled),
		scope: {
			...enrolled.scope,
			kind: "provider",
			accountId: null,
			accountGeneration: null,
		},
	};
	const unknown = structuredClone(enrolled);
	unknown.scope.model = "never-positive";
	unknown.enrolled = false;
	unknown.healthyEnds = [];
	unknown.reportingEnd = null;
	unknown.reuse = { sequence: 0, incident: null, bad: null, recovery: null };
	unknown.telemetry = {
		sequence: 0,
		incident: null,
		bad: null,
		recovery: null,
	};
	const sequenceOnly = structuredClone(unknown);
	sequenceOnly.scope.model = "native-incident-history";
	sequenceOnly.telemetry.sequence = 2;
	const active = structuredClone(enrolled);
	active.scope.model = "active";
	active.reuse.incident = {
		sequence: 7,
		severity: "warning",
		lastNotificationAt: CACHE_TEST_TIME,
	};
	active.telemetry.incident = {
		sequence: 3,
		severity: "warning",
		lastNotificationAt: CACHE_TEST_TIME,
	};
	const oldAlert = {
		...cacheTestAlert("retained-old-incident"),
		account: "cache-retained",
		model: "active",
	};
	for (const state of [enrolled, provider, unknown, sequenceOnly, active]) {
		expect(
			await repo.commit(0, state, state === active ? [oldAlert] : []),
		).toBe(true);
	}
	await adapter.run("UPDATE alerts SET acknowledged = 1 WHERE id = ?", [
		oldAlert.id,
	]);
	const later = enrolled.lastBucketEnd + 48 * 60 * 60_000;
	expect(await repo.pruneStates(later)).toBe(1); // only the unclassified route expires
	const restored = await repo.loadStates(later);
	for (const original of [enrolled, provider, sequenceOnly, active]) {
		const state = restored.find(
			(s) =>
				cacheHealthScopeKey(s.scope) === cacheHealthScopeKey(original.scope),
		);
		expect(state).toMatchObject({
			scope: original.scope,
			enrolled: original.enrolled,
			revision: original.revision,
			lastBucketEnd: original.lastBucketEnd,
			contributors: original.contributors,
			healthyEnds: [],
			reportingEnd: null,
			reuse: {
				sequence: original.reuse.sequence,
				incident: original.reuse.incident,
				bad: null,
				recovery: null,
			},
			telemetry: {
				sequence: original.telemetry.sequence,
				incident: original.telemetry.incident,
				bad: null,
				recovery: null,
			},
		});
		const stored = await adapter.get<{ snapshot: string }>(
			"SELECT snapshot FROM cache_health_state WHERE scope_key = ?",
			[cacheHealthScopeKey(original.scope)],
		);
		expect(JSON.parse(stored?.snapshot)).toEqual(state);
	}
	expect(restored.some((s) => s.scope.model === "never-positive")).toBe(false);
	expect(await repo.pruneStates(later)).toBe(0);
	expect(await repo.loadStates(later)).toEqual(restored);
	const retained = restored.find(
		(s) =>
			s.scope.kind === "account" &&
			s.scope.model === "observed" &&
			s.scope.accountId === "cache-retained",
	)!;
	const next = {
		...retained,
		revision: retained.revision + 1,
		lastBucketEnd: later + 600_000,
	};
	// Retention preserves the existing primary key and CAS; no replacement state.
	expect(await repo.commit(0, { ...next, revision: 1 }, [])).toBe(false);
	expect(await repo.commit(retained.revision, next, [oldAlert])).toBe(false);
	expect(
		(await repo.loadStates(later)).find(
			(s) =>
				cacheHealthScopeKey(s.scope) === cacheHealthScopeKey(retained.scope),
		),
	).toEqual(retained);
	expect(
		await repo.commit(retained.revision, next, [
			cacheTestAlert("retained-next-incident"),
		]),
	).toBe(true);
	await adapter.run("DELETE FROM accounts WHERE id = ?", ["cache-retained"]);
	await seedCacheAccount(adapter, "cache-retained", 12);
	expect(
		(await repo.loadStates(later)).some(
			(s) => s.scope.accountId === "cache-retained",
		),
	).toBe(false);
	expect(
		await repo.commit(
			next.revision,
			{
				...next,
				revision: next.revision + 1,
				lastBucketEnd: next.lastBucketEnd + 600_000,
			},
			[cacheTestAlert("retained-stale-generation")],
		),
	).toBe(false);
	expect(
		await adapter.get("SELECT id FROM alerts WHERE id = ?", [
			"retained-stale-generation",
		]),
	).toBeNull();
}
