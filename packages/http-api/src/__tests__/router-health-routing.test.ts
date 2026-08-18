/**
 * Router-level test for the routing block on GET /health (#197).
 *
 * The unit tests in handlers/__tests__/health-runtime.test.ts call the
 * health handler directly with a hand-built `getRoutingHealth` callback, so
 * they cover the handler's own merge logic but not the actual bridge that
 * wires it in production: APIRouter reads `context.getStrategy` and passes
 * `() => getStrategy?.()?.getRoutingHealth?.()` into createHealthHandler
 * (see router.ts's registerHandlers()). This test constructs the real
 * router with a live SessionAffinityStrategy in the context and drives an
 * actual at-home-protection transition through it, then asserts GET /health
 * — served end-to-end through router.handleRequest() — reports the
 * strategy's real counters, not a stub.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	HealthResponse,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function metaFor(clientSessionId: string): RequestMeta {
	return {
		id: "req",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId,
	} as unknown as RequestMeta;
}

function makeStrategyStore(): StrategyStore {
	return {
		resetAccountSession() {},
		async resumeAccount() {
			return { resumed: true, pauseReason: null };
		},
		getAccountUtilization() {
			return null;
		},
		getAccountWeeklyReset() {
			return null;
		},
	} as unknown as StrategyStore;
}

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

describe("APIRouter — GET /health routing block (#197)", () => {
	it("serves the live strategy's real routing counters end-to-end, not a handler-level stub", async () => {
		const db = makeDb();
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
			// One routable account so /health resolves "ok" (200) rather than
			// the empty-pool "unhealthy" (503) — the routing block's presence
			// is what this test cares about, not pool status.
			getAllAccounts: async () => [
				{ name: "acc1", paused: false, rate_limited_until: null },
			],
		} as unknown as DatabaseOperations;
		const config = {
			getStrategy: () => "session-affinity",
			getHealthDetailEnabled: () => false,
		} as unknown as Config;
		const alertService = {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		};

		const strategy = new SessionAffinityStrategy();
		strategy.initialize(makeStrategyStore());

		// Drive one real at-home protection through the strategy's own select()
		// path — the same transition the load-balancer suite pins in
		// strategies/__tests__/session-affinity.test.ts — before the router
		// ever sees it, proving the router reads live state rather than a
		// snapshot taken at construction time.
		const owner = makeAccount({ id: "owner", priority: 5 });
		const laneMeta = {
			...metaFor("router-health-client"),
			affinityLaneKey: "router-health-client:anthropic:opus",
		} as RequestMeta;
		expect((await strategy.select([owner], laneMeta))[0].id).toBe("owner");
		const better = makeAccount({ id: "better", priority: 0 });
		expect((await strategy.select([owner, better], laneMeta))[0].id).toBe(
			"owner",
		);

		const context = {
			db: adapter,
			config,
			dbOps,
			alertService,
			getStrategy: () => strategy,
		} as unknown as APIContext;
		const router = new APIRouter(context);

		const url = new URL("http://localhost/health");
		const res = await router.handleRequest(url, new Request(url));
		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as HealthResponse;

		expect(body.routing).toEqual({
			affinityEntries: 1,
			routeSuppressionEntries: 0,
			// gcStaleRouteFailureStates() throttles itself to once per interval
			// (see session-affinity.ts), so the two closely-spaced select()
			// calls above register as a single GC sweep.
			routeSuppressionGcSweeps: 1,
			transitions: {
				atHomeProtections: 1,
				outclassRemaps: { crossTier: 0, sameTier: 0 },
				failoverRemaps: 0,
				snapbackPreservations: 0,
			},
		});

		db.close();
	});

	it("omits the routing block when no strategy is wired into the context", async () => {
		const db = makeDb();
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
			getAllAccounts: async () => [],
		} as unknown as DatabaseOperations;
		const config = {
			getStrategy: () => "session-affinity",
			getHealthDetailEnabled: () => false,
		} as unknown as Config;
		const alertService = {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		};
		const context = {
			db: adapter,
			config,
			dbOps,
			alertService,
			// No getStrategy at all — mirrors a context built before the
			// strategy is constructed (see server.ts's currentStrategy getter
			// comment: the router is built eagerly).
		} as unknown as APIContext;
		const router = new APIRouter(context);

		const url = new URL("http://localhost/health");
		const res = await router.handleRequest(url, new Request(url));
		const body = (await res?.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("routing");

		db.close();
	});
});
