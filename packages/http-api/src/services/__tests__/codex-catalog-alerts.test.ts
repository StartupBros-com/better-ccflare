import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import {
	alertEvents,
	type CodexCatalogEvt,
	type CodexOwnCatalogPublishedEvt,
	codexCatalogEvents,
	setForceAccountModel,
} from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { setProviderModelDefaultOverrides } from "@better-ccflare/providers";
import {
	ALERT_TYPES,
	type AlertEvent,
	type AlertType,
	isAlertType,
} from "@better-ccflare/types";
import {
	AlertService,
	buildThresholdAlertId,
	isAlertTypeAllowedForWebhook,
} from "../alerts";

/**
 * Codex catalog, pin and client-identity alerts (issue #370 unit 6): the
 * proxy emits on the core codex catalog bus; AlertService classifies and
 * persists through the same dedup and delivery path as every other alert.
 */

const ACCOUNT_ID = "5f0c2a8e-codex-alerts";
const ACCOUNT_NAME = "Codex Primary";
const ACCESS_TOKEN = "codex-access-token-secret";
const REFRESH_TOKEN = "codex-refresh-token-secret";
const COOLDOWN_MINUTES = 60;
const BUCKET_MS = COOLDOWN_MINUTES * 60_000;

/** Types that existed before the Codex alerts; their delivery must not move. */
const PRE_EXISTING_TYPES: readonly AlertType[] = [
	"daily_spend",
	"tokens_per_hour",
	"request_tokens",
	"anomaly_token_outlier",
	"anomaly_output_blowup",
	"anomaly_runaway_loop",
	"anomaly_model_misrouting",
	"auth_failure",
	"model_routing_drift",
	"usage_window_threshold",
	"usage_window_exhaustion_projected",
	"usage_window_value_drop",
	"cache_efficiency_low",
	"cache_efficiency_critical",
	"cache_telemetry_gap",
	"cache_efficiency_recovered",
];

function makeConfig(
	overrides: Partial<{ webhookUrl: string; webhookTypes: AlertType[] }> = {},
): Config {
	const store = new Map<string, string | number | boolean>();
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertUsageWindowThresholdPercent: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 1440,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => COOLDOWN_MINUTES,
		getAlertWebhookUrl: () =>
			overrides.webhookUrl ?? "http://127.0.0.1:9/codex-alert-webhook",
		getAlertWebhookTypes: () => overrides.webhookTypes ?? [],
		get: (
			key: string,
			defaultValue?: string | number | boolean,
		): string | number | boolean | undefined => {
			if (store.has(key)) return store.get(key);
			if (defaultValue !== undefined) {
				store.set(key, defaultValue);
				return defaultValue;
			}
			return undefined;
		},
		set: (key: string, value: string | number | boolean): void => {
			store.set(key, value);
		},
	}) as unknown as Config;
}

function published(
	models: readonly string[],
	roleTargets: CodexOwnCatalogPublishedEvt["roleTargets"],
): CodexOwnCatalogPublishedEvt {
	return {
		type: "own_catalog_published",
		accountId: ACCOUNT_ID,
		accountName: ACCOUNT_NAME,
		models,
		roleTargets,
	};
}

const CURRENT_TARGETS = {
	fable: "gpt-7-nova",
	opus: "gpt-7-nova",
	sonnet: "gpt-7-sol",
	haiku: "gpt-7-luna",
} as const;
const CURRENT_MODELS = ["gpt-7-nova", "gpt-7-sol", "gpt-7-luna"] as const;

describe("AlertService Codex catalog alerts", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;
	let service: AlertService;
	let originalFetch: typeof globalThis.fetch;
	let fetchMock: ReturnType<typeof mock>;
	let emitted: AlertEvent[];
	let alertListener: (event: { type: string; payload: AlertEvent }) => void;

	async function insertAccount(
		overrides: Partial<{
			id: string;
			name: string;
			model_mappings: string | null;
			model_fallbacks: string | null;
			custom_endpoint: string | null;
		}> = {},
	): Promise<void> {
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at,
				created_at, model_mappings, model_fallbacks, custom_endpoint
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				overrides.id ?? ACCOUNT_ID,
				overrides.name ?? ACCOUNT_NAME,
				"codex",
				null,
				REFRESH_TOKEN,
				ACCESS_TOKEN,
				Date.now() + 3_600_000,
				1_700_000_000_000,
				overrides.model_mappings ?? null,
				overrides.model_fallbacks ?? null,
				overrides.custom_endpoint ?? null,
			],
		);
	}

	function useService(config: Config = makeConfig()): AlertService {
		service?.stop();
		service = new AlertService(adapter, config);
		return service;
	}

	function webhookTypes(): string[] {
		return fetchMock.mock.calls.map(([, init]) => {
			const body = JSON.parse(String((init as RequestInit).body));
			return body.alert.type as string;
		});
	}

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		originalFetch = globalThis.fetch;
		fetchMock = mock(async () => new Response(null, { status: 204 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		emitted = [];
		alertListener = (event) => {
			emitted.push(event.payload);
		};
		alertEvents.on("event", alertListener);
		service = new AlertService(adapter, makeConfig());
	});

	afterEach(() => {
		service.stop();
		alertEvents.off("event", alertListener);
		globalThis.fetch = originalFetch;
		setProviderModelDefaultOverrides({});
		setForceAccountModel(false);
		sqlite.close();
	});

	describe("automatic role-target changes", () => {
		it("records an info alert keyed by the new target, once per real change", async () => {
			await insertAccount();
			const change: CodexCatalogEvt = {
				type: "role_target_changed",
				accountId: ACCOUNT_ID,
				accountName: ACCOUNT_NAME,
				family: "opus",
				from: "gpt-6-astra",
				to: "gpt-7-nova",
			};

			await service.evaluateCodexCatalogEvent(change, 1_000);
			// A later bucket and a repeat of the same change: still one alert.
			await service.evaluateCodexCatalogEvent(change, 1_000 + 5 * BUCKET_MS);

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toMatchObject({
				id: `codex_role_target_changed:${ACCOUNT_ID}:opus:gpt-7-nova`,
				type: "codex_role_target_changed",
				severity: "info",
				account: ACCOUNT_NAME,
				model: "gpt-7-nova",
			});
			expect(alerts[0]?.message).toContain("gpt-6-astra");
			expect(emitted).toHaveLength(1);

			await service.evaluateCodexCatalogEvent(
				{ ...change, from: "gpt-7-nova", to: "gpt-7-sol" },
				2_000,
			);
			expect(await service.listAlerts()).toHaveLength(2);
		});
	});

	describe("pin classification on an own-catalog publication", () => {
		async function pinAlerts(): Promise<AlertEvent[]> {
			return (await service.listAlerts()).filter((alert) =>
				alert.type.startsWith("codex_pin_"),
			);
		}

		it("warns when a pinned model is absent from the fresh own catalog", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({ opus: "gpt-6-astra" }),
			});

			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);

			const alerts = await pinAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toMatchObject({
				id: `codex_pin_unavailable:${ACCOUNT_ID}:opus:gpt-6-astra`,
				type: "codex_pin_unavailable",
				severity: "warning",
				account: ACCOUNT_NAME,
				model: "gpt-6-astra",
			});
			expect(alerts[0]?.message).toContain("gpt-7-nova");
		});

		it("records info when a pinned model is still offered but is not the role target", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({ sonnet: "gpt-7-luna" }),
			});

			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);

			const alerts = await pinAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toMatchObject({
				type: "codex_pin_superseded",
				severity: "info",
				account: ACCOUNT_NAME,
				model: "gpt-7-luna",
			});
			expect(alerts[0]?.id.startsWith("codex_pin_superseded:")).toBe(true);
			expect(alerts[0]?.message).toContain("gpt-7-sol");
		});

		it("stays silent for a pin equal to the role target and for unpinned families", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({ opus: "gpt-7-nova" }),
			});

			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);

			expect(await service.listAlerts()).toEqual([]);
			expect(emitted).toEqual([]);
		});

		it("attributes legacy and custom-endpoint pins the same way routing does", async () => {
			await insertAccount({
				model_fallbacks: JSON.stringify({ haiku: "gpt-5.4-mini" }),
				custom_endpoint: JSON.stringify({
					endpoint: "https://example.test",
					modelMappings: { sonnet: "gpt-7-luna" },
				}),
			});

			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);

			const byType = Object.fromEntries(
				(await pinAlerts()).map((alert) => [alert.type, alert.model]),
			);
			expect(byType).toEqual({
				codex_pin_unavailable: "gpt-5.4-mini",
				codex_pin_superseded: "gpt-7-luna",
			});
		});

		it("dedupes a standing pin condition across republications", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({ opus: "gpt-6-astra" }),
			});
			const event = published(CURRENT_MODELS, CURRENT_TARGETS);

			await service.evaluateCodexCatalogEvent(event, 1_000);
			await service.evaluateCodexCatalogEvent(event, 1_000 + 3 * BUCKET_MS);

			expect(await pinAlerts()).toHaveLength(1);
			expect(emitted).toHaveLength(1);
		});

		it("ignores account pins in force-account-model mode, as routing does", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({ opus: "gpt-6-astra" }),
			});
			setForceAccountModel(true);

			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);
			expect(await service.listAlerts()).toEqual([]);

			// A provider-wide override still pins the family in force mode.
			setProviderModelDefaultOverrides({ codex: { opus: "gpt-6-astra" } });
			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);
			const alerts = await pinAlerts();
			expect(alerts.map((alert) => [alert.type, alert.model])).toEqual([
				["codex_pin_unavailable", "gpt-6-astra"],
			]);
		});

		it("skips an account that no longer exists", async () => {
			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);
			expect(await service.listAlerts()).toEqual([]);
		});
	});

	describe("time-bucketed conditions", () => {
		const cases: Array<{
			name: string;
			event: CodexCatalogEvt;
			type: AlertType;
			scope: string;
		}> = [
			{
				name: "a stale own catalog",
				event: {
					type: "catalog_stale",
					accountId: ACCOUNT_ID,
					accountName: ACCOUNT_NAME,
					ageMs: 75 * 60_000,
				},
				type: "codex_catalog_stale",
				scope: ACCOUNT_ID,
			},
			{
				name: "a fail-closed catalog-role profile",
				event: {
					type: "route_role_unavailable",
					profileId: "codex-opus",
					accountId: ACCOUNT_ID,
					reason: "catalog_role_mismatch",
				},
				type: "codex_route_role_unavailable",
				scope: "",
			},
			{
				name: "a stale verified Codex CLI version record",
				event: {
					type: "identity_record_stale",
					error: "stale_record",
					version: "0.190.0",
					verifiedAt: "2026-08-01T00:00:00.000Z",
				},
				type: "codex_identity_record_stale",
				scope: "stale_record",
			},
		];

		for (const { name, event, type, scope } of cases) {
			it(`records ${name} as a warning once per cooldown bucket`, async () => {
				await insertAccount();
				const t0 = 10 * BUCKET_MS + 1_000;

				await service.evaluateCodexCatalogEvent(event, t0);
				await service.evaluateCodexCatalogEvent(event, t0 + 60_000);

				let alerts = await service.listAlerts();
				expect(alerts).toHaveLength(1);
				expect(alerts[0]).toMatchObject({ type, severity: "warning" });
				if (scope) {
					expect(alerts[0]?.id).toBe(
						buildThresholdAlertId(type, scope, t0, COOLDOWN_MINUTES),
					);
				}

				await service.evaluateCodexCatalogEvent(event, t0 + BUCKET_MS);
				alerts = await service.listAlerts();
				expect(alerts).toHaveLength(2);
			});
		}

		it("names the account for an exact profile and the pool for a pool profile", async () => {
			await insertAccount();
			await service.evaluateCodexCatalogEvent({
				type: "route_role_unavailable",
				profileId: "codex-opus",
				accountId: ACCOUNT_ID,
				reason: "catalog_role_mismatch",
			});
			await service.evaluateCodexCatalogEvent({
				type: "route_role_unavailable",
				profileId: "codex-opus-pool",
				reason: "catalog_role_unavailable",
			});

			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(2);
			const exact = alerts.find((alert) => alert.account === ACCOUNT_NAME);
			const pool = alerts.find((alert) => alert.account === null);
			expect(exact?.message).toContain("codex-opus");
			expect(exact?.message).not.toContain("codex-opus-pool");
			expect(pool?.message).toContain("codex-opus-pool");
		});

		it("reports each unreadable-record condition distinctly", async () => {
			for (const error of [
				"stale_record",
				"unavailable_record",
				"invalid_record",
				"invalid_path",
			] as const) {
				await service.evaluateCodexCatalogEvent({
					type: "identity_record_stale",
					error,
					version: "0.156.0",
				});
			}
			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(4);
			expect(new Set(alerts.map((alert) => alert.type))).toEqual(
				new Set(["codex_identity_record_stale"]),
			);
		});
	});

	describe("webhook delivery", () => {
		const roleChange: CodexCatalogEvt = {
			type: "role_target_changed",
			accountId: ACCOUNT_ID,
			accountName: ACCOUNT_NAME,
			family: "sonnet",
			from: "gpt-6-sol",
			to: "gpt-7-sol",
		};

		it("keeps new info alerts in-app by default and delivers new warnings like existing ones", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({
					opus: "gpt-6-astra",
					sonnet: "gpt-7-luna",
				}),
			});

			await service.evaluateCodexCatalogEvent(roleChange);
			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);
			await service.evaluateCodexCatalogEvent({
				type: "catalog_stale",
				accountId: ACCOUNT_ID,
				accountName: ACCOUNT_NAME,
				ageMs: 90 * 60_000,
			});

			// Every alert is persisted and on the SSE stream...
			expect(
				new Set((await service.listAlerts()).map((alert) => alert.type)),
			).toEqual(
				new Set([
					"codex_role_target_changed",
					"codex_pin_unavailable",
					"codex_pin_superseded",
					"codex_catalog_stale",
				]),
			);
			expect(emitted).toHaveLength(4);
			// ...but only the warnings reach the webhook with no allowlist.
			expect(webhookTypes().sort()).toEqual([
				"codex_catalog_stale",
				"codex_pin_unavailable",
			]);
		});

		it("delivers an info type the operator lists, and only listed types", async () => {
			useService(makeConfig({ webhookTypes: ["codex_role_target_changed"] }));
			await insertAccount({
				model_mappings: JSON.stringify({ opus: "gpt-6-astra" }),
			});

			await service.evaluateCodexCatalogEvent(roleChange);
			await service.evaluateCodexCatalogEvent(
				published(CURRENT_MODELS, CURRENT_TARGETS),
			);

			expect(webhookTypes()).toEqual(["codex_role_target_changed"]);
		});

		it("leaves every pre-existing type's allowlist behavior unchanged", () => {
			for (const type of PRE_EXISTING_TYPES) {
				expect(isAlertTypeAllowedForWebhook(type, [])).toBe(true);
				expect(isAlertTypeAllowedForWebhook(type, [type])).toBe(true);
				expect(
					isAlertTypeAllowedForWebhook(
						type,
						PRE_EXISTING_TYPES.filter((other) => other !== type),
					),
				).toBe(false);
			}
		});

		it("gates only the new info types behind an explicit listing", () => {
			expect(
				isAlertTypeAllowedForWebhook("codex_role_target_changed", []),
			).toBe(false);
			expect(isAlertTypeAllowedForWebhook("codex_pin_superseded", [])).toBe(
				false,
			);
			for (const type of [
				"codex_pin_unavailable",
				"codex_catalog_stale",
				"codex_route_role_unavailable",
				"codex_identity_record_stale",
			] as const) {
				expect(isAlertTypeAllowedForWebhook(type, [])).toBe(true);
			}
			expect(
				isAlertTypeAllowedForWebhook("codex_pin_superseded", [
					"codex_pin_superseded",
				]),
			).toBe(true);
		});
	});

	describe("alert type registry", () => {
		it("registers every new type as a known, allowlistable alert type", () => {
			for (const type of [
				"codex_role_target_changed",
				"codex_pin_superseded",
				"codex_pin_unavailable",
				"codex_catalog_stale",
				"codex_route_role_unavailable",
				"codex_identity_record_stale",
			]) {
				expect(isAlertType(type)).toBe(true);
				expect(ALERT_TYPES).toContain(type as AlertType);
			}
			for (const type of PRE_EXISTING_TYPES) {
				expect(ALERT_TYPES).toContain(type);
			}
		});
	});

	describe("message safety", () => {
		it("never carries credentials, file paths or email addresses", async () => {
			await insertAccount({
				model_mappings: JSON.stringify({
					opus: "gpt-6-astra",
					sonnet: "gpt-7-luna",
				}),
			});
			const events: CodexCatalogEvt[] = [
				{
					type: "role_target_changed",
					accountId: ACCOUNT_ID,
					accountName: ACCOUNT_NAME,
					family: "opus",
					from: "gpt-6-astra",
					to: "gpt-7-nova",
				},
				published(CURRENT_MODELS, CURRENT_TARGETS),
				{
					type: "catalog_stale",
					accountId: ACCOUNT_ID,
					accountName: ACCOUNT_NAME,
					ageMs: 61 * 60_000,
				},
				{
					type: "route_role_unavailable",
					profileId: "codex-opus",
					accountId: ACCOUNT_ID,
					reason: "catalog_role_unavailable",
				},
				{
					type: "route_role_unavailable",
					profileId: "codex-opus-pool",
					reason: "catalog_role_mismatch",
				},
				...(
					[
						"stale_record",
						"unavailable_record",
						"invalid_record",
						"invalid_path",
					] as const
				).map(
					(error): CodexCatalogEvt => ({
						type: "identity_record_stale",
						error,
						version: "0.190.0",
						verifiedAt: "2026-08-01T00:00:00.000Z",
					}),
				),
			];
			for (const event of events) {
				await service.evaluateCodexCatalogEvent(event);
			}

			const alerts = await service.listAlerts();
			expect(alerts.length).toBeGreaterThanOrEqual(events.length);
			for (const alert of alerts) {
				const text = `${alert.title}\n${alert.message}\n${alert.account ?? ""}`;
				expect(text).not.toContain(ACCESS_TOKEN);
				expect(text).not.toContain(REFRESH_TOKEN);
				expect(text).not.toContain("@");
				expect(text).not.toContain("/");
				expect(text).not.toContain("CCFLARE_CODEX");
			}
		});
	});

	describe("event bus subscription", () => {
		async function waitFor(predicate: () => boolean): Promise<void> {
			for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
				await Bun.sleep(5);
			}
			expect(predicate()).toBe(true);
		}

		it("subscribes in start(), unsubscribes in stop(), and contains handler failures", async () => {
			const before = codexCatalogEvents.listenerCount("event");
			service.start();
			expect(codexCatalogEvents.listenerCount("event")).toBe(before + 1);
			service.start();
			expect(codexCatalogEvents.listenerCount("event")).toBe(before + 1);

			codexCatalogEvents.emit("event", {
				type: "catalog_stale",
				accountId: ACCOUNT_ID,
				accountName: ACCOUNT_NAME,
				ageMs: 70 * 60_000,
			} satisfies CodexCatalogEvt);
			await waitFor(() => emitted.length === 1);
			expect(emitted[0]?.type).toBe("codex_catalog_stale");

			// A handler failure never escapes the synchronous emitter.
			sqlite.close();
			expect(() =>
				codexCatalogEvents.emit("event", {
					type: "own_catalog_published",
					accountId: ACCOUNT_ID,
					accountName: ACCOUNT_NAME,
					models: [],
					roleTargets: {},
				} satisfies CodexCatalogEvt),
			).not.toThrow();
			sqlite = new Database(":memory:");

			service.stop();
			expect(codexCatalogEvents.listenerCount("event")).toBe(before);
		});
	});
});
