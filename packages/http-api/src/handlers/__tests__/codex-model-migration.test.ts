import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { parseModelMappings, setForceAccountModel } from "@better-ccflare/core";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	clearDerivedProviderModelDefaults,
	setDerivedAccountModelDefaults,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import { resolveCodexRequestModel } from "@better-ccflare/providers/codex";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
	parseModelRouteProfiles,
} from "@better-ccflare/proxy";
import { createAccountModelMappingsUpdateHandler } from "../accounts";
import {
	createCodexModelMigrationApplyHandler,
	createCodexModelMigrationPreviewHandler,
} from "../codex-model-migration";

// Every account, catalog and model name below is fictitious. NEXT_GENERATION
// stands in for a catalog generation newer than the pins being migrated.
const NEXT_GENERATION = ["gpt-7-nova", "gpt-7-sol", "gpt-7-luna"] as const;
const OLD_PINS = {
	opus: "gpt-6-astra",
	sonnet: "gpt-6-sol",
	haiku: "gpt-6-luna",
} as const;

interface FamilyEntry {
	family: string;
	currentModel: string;
	currentSource: string;
	accountPin: string | string[] | null;
	inheritedModel: string;
	inheritedSource: string;
	roleTarget: string | null;
	applicable: boolean;
	blockers: string[];
}

interface AccountEntry {
	accountId: string;
	accountName: string;
	expected_old_value: string | null;
	catalog: {
		source: "own" | "borrowed" | "none";
		fetchedAt: number | null;
		stale: boolean;
		borrowedFrom?: string;
	};
	families: FamilyEntry[];
}

interface PreviewData {
	revision: number;
	accounts: AccountEntry[];
	routeProfileAdvisories: Array<Record<string, unknown>>;
}

interface ApplyData {
	revision: number;
	applied: Array<{
		accountId: string;
		family: string;
		previousPin: string | string[];
	}>;
	recovery: Array<{
		accountId: string;
		model_mappings: string | null;
		modelMappings: Record<string, unknown>;
		exactRoundTrip: boolean;
	}>;
}

let dbOps: DatabaseOperations;
const originalEnvMappings = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;

beforeEach(() => {
	delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
	setProviderModelDefaultOverrides({});
	setForceAccountModel(false);
	if (originalEnvMappings === undefined) {
		delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
	} else {
		process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = originalEnvMappings;
	}
	await dbOps.close();
});

async function insertAccount(
	id: string,
	fields: {
		provider?: string;
		modelMappings?: string | null;
		customEndpoint?: string | null;
		modelFallbacks?: string | null;
	} = {},
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(
			"INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, model_mappings, custom_endpoint, model_fallbacks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				`name-${id}`,
				fields.provider ?? "codex",
				`refresh-${id}`,
				`access-${id}`,
				Date.now() + 10 * 60 * 60 * 1000,
				1,
				fields.modelMappings ?? null,
				fields.customEndpoint ?? null,
				fields.modelFallbacks ?? null,
			],
		);
}

async function rawMappings(id: string): Promise<string | null> {
	const row = await dbOps
		.getAdapter()
		.get<{ model_mappings: string | null }>(
			"SELECT model_mappings FROM accounts WHERE id = ?",
			[id],
		);
	return row?.model_mappings ?? null;
}

/** Publish one account's OWN listing through the real catalog path (fetch is local). */
async function publishOwnCatalog(
	accountId: string,
	models: readonly string[] = NEXT_GENERATION,
): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock(async () =>
		Response.json({
			models: models.map((slug, index) => ({
				slug,
				visibility: "list",
				priority: index + 1,
			})),
		}),
	) as unknown as typeof fetch;
	try {
		const listing = await getCodexModels(accountId, {
			dbOps,
		} as unknown as Parameters<typeof getCodexModels>[1]);
		expect(listing?.source).toBe("live");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function post(path: string, body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body:
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body),
	});
}

async function preview(
	body?: unknown,
	routeProfiles: ReturnType<typeof parseModelRouteProfiles> = [],
): Promise<Response> {
	return createCodexModelMigrationPreviewHandler(dbOps, { routeProfiles })(
		post("/api/codex/model-migration/preview", body),
	);
}

async function previewData(
	body?: unknown,
	routeProfiles: ReturnType<typeof parseModelRouteProfiles> = [],
): Promise<PreviewData> {
	const response = await preview(body, routeProfiles);
	expect(response.status).toBe(200);
	const json = (await response.json()) as {
		success: boolean;
		data: PreviewData;
	};
	expect(json.success).toBe(true);
	return json.data;
}

async function apply(body: unknown): Promise<Response> {
	return createCodexModelMigrationApplyHandler(dbOps)(
		post("/api/codex/model-migration/apply", body),
	);
}

function family(entry: AccountEntry | undefined, name: string): FamilyEntry {
	const found = entry?.families.find((item) => item.family === name);
	if (!found) throw new Error(`family ${name} missing from preview`);
	return found;
}

function account(data: PreviewData, id: string): AccountEntry {
	const found = data.accounts.find((item) => item.accountId === id);
	if (!found) throw new Error(`account ${id} missing from preview`);
	return found;
}

async function errorCode(response: Response): Promise<unknown> {
	const body = (await response.json()) as { details?: { code?: unknown } };
	return body.details?.code;
}

describe("POST /api/codex/model-migration/preview", () => {
	it("reports old pin, inherited own-catalog role target and resolved model per family, without writing", async () => {
		const stored = JSON.stringify({
			opus: OLD_PINS.opus,
			sonnet: ["gpt-6-sol", "gpt-6-sol-mini"],
			haiku: OLD_PINS.haiku,
			"claude-opus-4-8": OLD_PINS.opus,
		});
		await insertAccount("codex-alpha", { modelMappings: stored });
		await insertAccount("anthropic-other", {
			provider: "anthropic",
			modelMappings: JSON.stringify({ opus: "claude-opus-4-8" }),
		});
		await publishOwnCatalog("codex-alpha");
		const revisionBefore = await dbOps.getRoutingPolicyRevision();

		const data = await previewData();

		expect(data.revision).toBe(revisionBefore);
		expect(data.accounts.map((entry) => entry.accountId)).toEqual([
			"codex-alpha",
		]);
		const alpha = account(data, "codex-alpha");
		expect(alpha.accountName).toBe("name-codex-alpha");
		expect(alpha.expected_old_value).toBe(stored);
		expect(alpha.catalog.source).toBe("own");
		expect(typeof alpha.catalog.fetchedAt).toBe("number");
		expect(alpha.catalog.stale).toBe(false);

		const accountRow = await dbOps.getAccount("codex-alpha");
		if (!accountRow) throw new Error("fixture account missing");
		for (const entry of alpha.families) {
			// One resolver: the reported current model is exactly what routing uses.
			expect(entry.currentModel).toBe(
				resolveCodexRequestModel(entry.family, accountRow),
			);
		}

		expect(family(alpha, "opus")).toEqual({
			family: "opus",
			currentModel: OLD_PINS.opus,
			currentSource: "account_mapping_pin",
			accountPin: OLD_PINS.opus,
			inheritedModel: "gpt-7-nova",
			inheritedSource: "account_catalog",
			roleTarget: "gpt-7-nova",
			applicable: true,
			blockers: [],
		});
		// An ordered array pin is reported as stored, not collapsed to its head.
		expect(family(alpha, "sonnet")).toMatchObject({
			currentModel: "gpt-6-sol",
			accountPin: ["gpt-6-sol", "gpt-6-sol-mini"],
			inheritedModel: "gpt-7-sol",
			roleTarget: "gpt-7-sol",
			applicable: true,
		});
		expect(family(alpha, "haiku")).toMatchObject({
			accountPin: OLD_PINS.haiku,
			inheritedModel: "gpt-7-luna",
			roleTarget: "gpt-7-luna",
			applicable: true,
		});
		expect(family(alpha, "fable")).toEqual({
			family: "fable",
			currentModel: "gpt-7-nova",
			currentSource: "account_catalog",
			accountPin: null,
			inheritedModel: "gpt-7-nova",
			inheritedSource: "account_catalog",
			roleTarget: "gpt-7-nova",
			applicable: false,
			blockers: ["no_account_pin"],
		});

		expect(await rawMappings("codex-alpha")).toBe(stored);
		expect(await dbOps.getRoutingPolicyRevision()).toBe(revisionBefore);
	});

	it("reports a stored pin that already equals the role target instead of inferring it away", async () => {
		const stored = JSON.stringify({ opus: "gpt-7-nova" });
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");

		const opus = family(account(await previewData(), "codex-alpha"), "opus");
		expect(opus.accountPin).toBe("gpt-7-nova");
		expect(opus.currentSource).toBe("account_mapping_pin");
		expect(opus.applicable).toBe(true);
	});

	describe("blocker matrix", () => {
		const pinned = JSON.stringify({ opus: OLD_PINS.opus });

		it("custom_endpoint_mapping: a legacy endpoint mapping still pins the family", async () => {
			await insertAccount("codex-alpha", {
				modelMappings: pinned,
				customEndpoint: JSON.stringify({
					endpoint: "https://codex.example.test",
					modelMappings: { opus: "legacy-endpoint-opus" },
				}),
			});
			await publishOwnCatalog("codex-alpha");
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect(opus.currentSource).toBe("custom_endpoint_mapping");
			expect(opus.inheritedSource).toBe("custom_endpoint_mapping");
			expect(opus.inheritedModel).toBe("legacy-endpoint-opus");
			expect(opus.blockers).toEqual(["custom_endpoint_mapping"]);
			expect(opus.applicable).toBe(false);
		});

		it("environment_mapping: the process-wide env mapping would take over", async () => {
			await insertAccount("codex-alpha", { modelMappings: pinned });
			await publishOwnCatalog("codex-alpha");
			process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
				opus: "env-opus",
			});
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect(opus.inheritedSource).toBe("environment_mapping");
			expect(opus.inheritedModel).toBe("env-opus");
			expect(opus.blockers).toEqual(["environment_mapping"]);
			expect(opus.applicable).toBe(false);
		});

		it("model_fallbacks: the deprecated fallback would take over", async () => {
			await insertAccount("codex-alpha", {
				modelMappings: pinned,
				modelFallbacks: JSON.stringify({ opus: "fallback-opus" }),
			});
			await publishOwnCatalog("codex-alpha");
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect(opus.inheritedSource).toBe("model_fallbacks");
			expect(opus.inheritedModel).toBe("fallback-opus");
			expect(opus.blockers).toEqual(["model_fallbacks"]);
			expect(opus.applicable).toBe(false);
		});

		it("global_provider_override: a provider-wide override would pin the unmapped family", async () => {
			await insertAccount("codex-alpha", { modelMappings: pinned });
			await publishOwnCatalog("codex-alpha");
			setProviderModelDefaultOverrides({ codex: { opus: "override-opus" } });
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect(opus.inheritedSource).toBe("global_provider_override");
			expect(opus.inheritedModel).toBe("override-opus");
			expect(opus.blockers).toEqual(["global_provider_override"]);
			expect(opus.applicable).toBe(false);
		});

		it("no_own_catalog: nothing was ever read for the account", async () => {
			await insertAccount("codex-alpha", { modelMappings: pinned });
			const alpha = account(await previewData(), "codex-alpha");
			expect(alpha.catalog).toEqual({
				source: "none",
				fetchedAt: null,
				stale: false,
			});
			const opus = family(alpha, "opus");
			expect(opus.roleTarget).toBeNull();
			expect(opus.inheritedSource).toBe("compiled_default");
			expect(opus.blockers).toEqual(["no_own_catalog"]);
			expect(opus.applicable).toBe(false);
		});

		it("no_own_catalog: a listing borrowed from another account never names a target", async () => {
			await insertAccount("codex-lender");
			await insertAccount("codex-borrower", { modelMappings: pinned });
			await publishOwnCatalog("codex-lender");
			const borrower = account(await previewData(), "codex-borrower");
			expect(borrower.catalog).toMatchObject({
				source: "borrowed",
				borrowedFrom: "codex-lender",
			});
			const opus = family(borrower, "opus");
			expect(opus.roleTarget).toBeNull();
			expect(opus.inheritedSource).toBe("provider_catalog_borrowed");
			expect(opus.blockers).toEqual(["no_own_catalog"]);
			expect(opus.applicable).toBe(false);
		});

		it("force_account_model_mode: pins are not applied at all in this mode", async () => {
			await insertAccount("codex-alpha", { modelMappings: pinned });
			await publishOwnCatalog("codex-alpha");
			setForceAccountModel(true);
			try {
				const opus = family(
					account(await previewData(), "codex-alpha"),
					"opus",
				);
				expect(opus.accountPin).toBe(OLD_PINS.opus);
				expect(opus.blockers).toContain("force_account_model_mode");
				expect(opus.applicable).toBe(false);
			} finally {
				setForceAccountModel(false);
			}
		});

		it("inherited_target_mismatch: inheritance would not land on the own-catalog role target", async () => {
			await insertAccount("codex-alpha", { modelMappings: pinned });
			await publishOwnCatalog("codex-alpha");
			setDerivedAccountModelDefaults("codex", "codex-alpha", {
				opus: "gpt-7-elsewhere",
			});
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect(opus.inheritedSource).toBe("account_catalog");
			expect(opus.inheritedModel).toBe("gpt-7-elsewhere");
			expect(opus.roleTarget).toBe("gpt-7-nova");
			expect(opus.blockers).toEqual(["inherited_target_mismatch"]);
			expect(opus.applicable).toBe(false);
		});

		it("lists every blocker that applies, not only the highest-precedence one", async () => {
			await insertAccount("codex-alpha", {
				modelMappings: pinned,
				modelFallbacks: JSON.stringify({ opus: "fallback-opus" }),
			});
			process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
				opus: "env-opus",
			});
			setProviderModelDefaultOverrides({ codex: { opus: "override-opus" } });
			const opus = family(account(await previewData(), "codex-alpha"), "opus");
			expect([...opus.blockers].sort()).toEqual(
				[
					"environment_mapping",
					"global_provider_override",
					"model_fallbacks",
					"no_own_catalog",
				].sort(),
			);
			expect(opus.applicable).toBe(false);
		});
	});

	it("scopes to requested Codex accounts and rejects unknown or non-Codex ids", async () => {
		await insertAccount("codex-alpha", {
			modelMappings: JSON.stringify(OLD_PINS),
		});
		await insertAccount("codex-beta", {
			modelMappings: JSON.stringify(OLD_PINS),
		});
		await insertAccount("anthropic-other", { provider: "anthropic" });

		const scoped = await previewData({ accountIds: ["codex-beta"] });
		expect(scoped.accounts.map((entry) => entry.accountId)).toEqual([
			"codex-beta",
		]);

		for (const accountIds of [["codex-missing"], ["anthropic-other"]]) {
			const response = await preview({ accountIds });
			expect(response.status).toBe(404);
		}
		for (const body of [
			"{",
			"[]",
			{ accountIds: "codex-alpha" },
			{ accountIds: [42] },
			{ accountIds: [""] },
		]) {
			const response = await preview(body);
			expect(response.status).toBe(400);
		}
		// An empty body means every Codex account.
		const all = await previewData();
		expect(all.accounts.map((entry) => entry.accountId).sort()).toEqual([
			"codex-alpha",
			"codex-beta",
		]);
	});

	it("advises on exact-policy route profiles that pin a previewed account's physical model", async () => {
		await insertAccount("codex-alpha", {
			modelMappings: JSON.stringify(OLD_PINS),
		});
		await insertAccount("codex-beta", {
			modelMappings: JSON.stringify(OLD_PINS),
		});
		const profiles = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "alpha-opus-exact",
					displayName: "Alpha Opus (exact)",
					accountId: "codex-alpha",
					logicalModel: "claude-opus-4-8",
					expectedProvider: "codex",
					expectedPhysicalModel: OLD_PINS.opus,
				},
				{
					id: "alpha-opus-role",
					displayName: "Alpha Opus (role)",
					accountId: "codex-alpha",
					logicalModel: "claude-opus-4-8",
					expectedProvider: "codex",
					physicalModelPolicy: "catalog-role",
				},
				{
					id: "beta-sonnet-exact",
					displayName: "Beta Sonnet (exact)",
					accountId: "codex-beta",
					logicalModel: "claude-sonnet-4-6",
					expectedProvider: "codex",
					expectedPhysicalModel: OLD_PINS.sonnet,
				},
				{
					id: "unrelated-exact",
					displayName: "Unrelated",
					accountId: "some-other-account",
					logicalModel: "claude-opus-4-8",
					expectedPhysicalModel: "gpt-6-astra",
				},
				{
					id: "codex-pool",
					displayName: "Codex pool",
					selection: "capability",
					logicalModel: "claude-opus-4-8",
					expectedProvider: "codex",
					expectedPhysicalModel: OLD_PINS.opus,
				},
			]),
		);

		const all = await previewData(undefined, profiles);
		expect(all.routeProfileAdvisories).toEqual([
			{
				profileId: "alpha-opus-exact",
				displayName: "Alpha Opus (exact)",
				accountId: "codex-alpha",
				logicalModel: "claude-opus-4-8",
				family: "opus",
				expectedPhysicalModel: OLD_PINS.opus,
			},
			{
				profileId: "beta-sonnet-exact",
				displayName: "Beta Sonnet (exact)",
				accountId: "codex-beta",
				logicalModel: "claude-sonnet-4-6",
				family: "sonnet",
				expectedPhysicalModel: OLD_PINS.sonnet,
			},
		]);

		const scoped = await previewData({ accountIds: ["codex-beta"] }, profiles);
		expect(
			scoped.routeProfileAdvisories.map((advisory) => advisory.profileId),
		).toEqual(["beta-sonnet-exact"]);
	});
});

describe("POST /api/codex/model-migration/apply", () => {
	it("removes only the selected family keys in one guarded write per account and keeps every other key", async () => {
		const stored = JSON.stringify({
			opus: OLD_PINS.opus,
			sonnet: ["gpt-6-sol", "gpt-6-sol-mini"],
			"claude-opus-4-8": OLD_PINS.opus,
			haiku: OLD_PINS.haiku,
			"claude-haiku-4-5": ["gpt-6-luna"],
		});
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		const writeBatches: unknown[] = [];
		const realWrite = dbOps.applyGuardedModelMappingsWrites.bind(dbOps);
		dbOps.applyGuardedModelMappingsWrites = async (input) => {
			writeBatches.push(structuredClone(input));
			return realWrite(input);
		};

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: stored,
				},
				{
					accountId: "codex-alpha",
					family: "haiku",
					expected_old_value: stored,
				},
			],
		});
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: ApplyData };

		const expected = JSON.stringify({
			sonnet: ["gpt-6-sol", "gpt-6-sol-mini"],
			"claude-opus-4-8": OLD_PINS.opus,
			"claude-haiku-4-5": ["gpt-6-luna"],
		});
		expect(await rawMappings("codex-alpha")).toBe(expected);
		expect(writeBatches).toEqual([
			{
				expected_revision: before.revision,
				writes: [
					{
						account_id: "codex-alpha",
						expected_old_value: stored,
						new_value: expected,
					},
				],
			},
		]);
		expect(data.revision).toBe(before.revision + 1);
		expect(await dbOps.getRoutingPolicyRevision()).toBe(before.revision + 1);
		expect(data.applied).toEqual([
			{ accountId: "codex-alpha", family: "opus", previousPin: OLD_PINS.opus },
			{
				accountId: "codex-alpha",
				family: "haiku",
				previousPin: OLD_PINS.haiku,
			},
		]);
		expect(data.recovery).toEqual([
			{
				accountId: "codex-alpha",
				model_mappings: stored,
				modelMappings: JSON.parse(stored),
				exactRoundTrip: false,
			},
		]);

		// The proxy reads accounts per request; a fresh read already routes to
		// the account's own catalog role for the migrated families.
		const after = account(await previewData(), "codex-alpha");
		expect(family(after, "opus")).toMatchObject({
			accountPin: null,
			currentModel: "gpt-7-nova",
			currentSource: "account_catalog",
		});
		expect(family(after, "haiku").currentModel).toBe("gpt-7-luna");
		expect(family(after, "sonnet").currentSource).toBe("account_mapping_pin");
	});

	it("writes NULL when the migration removes the last key", async () => {
		const stored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: stored,
				},
			],
		});
		expect(response.status).toBe(200);
		expect(await rawMappings("codex-alpha")).toBeNull();
	});

	it("rejects malformed and empty requests with 400 and no writes", async () => {
		const stored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const revision = await dbOps.getRoutingPolicyRevision();
		const selection = {
			accountId: "codex-alpha",
			family: "opus",
			expected_old_value: stored,
		};

		for (const body of [
			"{",
			"[]",
			{ selections: [selection] },
			{ expected_revision: -1, selections: [selection] },
			{ expected_revision: revision },
			{ expected_revision: revision, selections: [] },
			{ expected_revision: revision, selections: "all" },
			{
				expected_revision: revision,
				selections: [{ ...selection, family: "gpt" }],
			},
			{
				expected_revision: revision,
				selections: [{ ...selection, accountId: "" }],
			},
			{
				expected_revision: revision,
				selections: [{ ...selection, expected_old_value: 7 }],
			},
			{
				expected_revision: revision,
				selections: [{ accountId: "codex-alpha", family: "opus" }],
			},
			{ expected_revision: revision, selections: [selection, selection] },
		]) {
			const response = await apply(body);
			expect(response.status).toBe(400);
		}
		expect(await rawMappings("codex-alpha")).toBe(stored);
		expect(await dbOps.getRoutingPolicyRevision()).toBe(revision);
	});

	it("rejects the whole request with 409 when any selection is unknown or not applicable at apply time", async () => {
		const alphaStored = JSON.stringify({ opus: OLD_PINS.opus });
		const betaStored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: alphaStored });
		await insertAccount("codex-beta", { modelMappings: betaStored });
		await insertAccount("anthropic-other", {
			provider: "anthropic",
			modelMappings: alphaStored,
		});
		await publishOwnCatalog("codex-alpha");
		await publishOwnCatalog("codex-beta");
		const before = await previewData();
		expect(family(account(before, "codex-alpha"), "opus").applicable).toBe(
			true,
		);
		const valid = {
			accountId: "codex-alpha",
			family: "opus",
			expected_old_value: alphaStored,
		};

		for (const extra of [
			// unknown account
			{
				accountId: "codex-missing",
				family: "opus",
				expected_old_value: alphaStored,
			},
			// not a Codex account
			{
				accountId: "anthropic-other",
				family: "opus",
				expected_old_value: alphaStored,
			},
			// family with no pin to remove
			{
				accountId: "codex-beta",
				family: "sonnet",
				expected_old_value: betaStored,
			},
		]) {
			const response = await apply({
				expected_revision: before.revision,
				selections: [valid, extra],
			});
			expect(response.status).toBe(409);
			expect(await errorCode(response)).toBe(
				"codex_migration_selection_not_applicable",
			);
		}

		// Applicable at preview time, not at apply time: a provider-wide
		// override appeared in between.
		setProviderModelDefaultOverrides({ codex: { opus: "override-opus" } });
		const response = await apply({
			expected_revision: before.revision,
			selections: [valid],
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as {
			details: {
				code: string;
				selections: Array<{
					accountId: string;
					family: string;
					blockers: string[];
				}>;
			};
		};
		expect(body.details.code).toBe("codex_migration_selection_not_applicable");
		expect(body.details.selections).toEqual([
			{
				accountId: "codex-alpha",
				family: "opus",
				blockers: ["global_provider_override"],
			},
		]);

		expect(await rawMappings("codex-alpha")).toBe(alphaStored);
		expect(await rawMappings("codex-beta")).toBe(betaStored);
		expect(await dbOps.getRoutingPolicyRevision()).toBe(before.revision);
	});

	it("returns 409 stale_codex_migration_preview after a concurrent edit between preview and apply, writing nothing", async () => {
		const alphaStored = JSON.stringify({ opus: OLD_PINS.opus });
		const betaStored = JSON.stringify({ sonnet: OLD_PINS.sonnet });
		await insertAccount("codex-alpha", { modelMappings: alphaStored });
		await insertAccount("codex-beta", { modelMappings: betaStored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		// Another operator edits a DIFFERENT account through the existing endpoint.
		const concurrent = await createAccountModelMappingsUpdateHandler(dbOps)(
			post("/api/accounts/codex-beta/model-mappings", {
				modelMappings: { sonnet: "gpt-7-sol" },
			}),
			"codex-beta",
		);
		expect(concurrent.status).toBe(200);

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: alphaStored,
				},
			],
		});
		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("stale_codex_migration_preview");
		expect(await rawMappings("codex-alpha")).toBe(alphaStored);
		expect(await rawMappings("codex-beta")).toBe(
			JSON.stringify({ sonnet: "gpt-7-sol" }),
		);
	});

	it("returns 409 stale_codex_migration_preview when the selected row no longer holds the previewed value", async () => {
		const stored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: JSON.stringify({ opus: "something-else" }),
				},
			],
		});
		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("stale_codex_migration_preview");
		expect(await rawMappings("codex-alpha")).toBe(stored);
		expect(await dbOps.getRoutingPolicyRevision()).toBe(before.revision);
	});

	it("maps a write that races past re-verification to 409 through the batch guard, keeping the racing value", async () => {
		const stored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		const racing = JSON.stringify({ opus: "operator-choice" });
		const realWrite = dbOps.applyGuardedModelMappingsWrites.bind(dbOps);
		dbOps.applyGuardedModelMappingsWrites = async (input) => {
			// The concurrent edit lands after the service re-verified state but
			// before its batch runs.
			await createAccountModelMappingsUpdateHandler(dbOps)(
				post("/api/accounts/codex-alpha/model-mappings", {
					modelMappings: JSON.parse(racing),
				}),
				"codex-alpha",
			);
			return realWrite(input);
		};

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: stored,
				},
			],
		});
		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("stale_codex_migration_preview");
		expect(await rawMappings("codex-alpha")).toBe(racing);
	});

	it("returns a recovery snapshot that the existing model-mappings endpoint restores byte-for-byte", async () => {
		const alphaStored = JSON.stringify({
			fable: ["gpt-6-astra", "gpt-6-sol"],
			opus: OLD_PINS.opus,
			sonnet: OLD_PINS.sonnet,
			haiku: OLD_PINS.haiku,
			"claude-opus-4-8": "gpt-6-astra-exact",
		});
		const betaStored = JSON.stringify({ opus: OLD_PINS.opus });
		await insertAccount("codex-alpha", { modelMappings: alphaStored });
		await insertAccount("codex-beta", { modelMappings: betaStored });
		await publishOwnCatalog("codex-alpha");
		await publishOwnCatalog("codex-beta");
		const before = await previewData();

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: alphaStored,
				},
				{
					accountId: "codex-alpha",
					family: "sonnet",
					expected_old_value: alphaStored,
				},
				{
					accountId: "codex-beta",
					family: "opus",
					expected_old_value: betaStored,
				},
			],
		});
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: ApplyData };
		expect(await rawMappings("codex-alpha")).not.toBe(alphaStored);
		expect(await rawMappings("codex-beta")).toBeNull();
		expect(data.recovery.map((item) => item.accountId)).toEqual([
			"codex-alpha",
			"codex-beta",
		]);
		for (const item of data.recovery) {
			expect(item.exactRoundTrip).toBe(true);
		}

		// Re-POST each item unchanged to the existing endpoint.
		const restore = createAccountModelMappingsUpdateHandler(dbOps);
		for (const item of data.recovery) {
			const restored = await restore(
				post(`/api/accounts/${item.accountId}/model-mappings`, item),
				item.accountId,
			);
			expect(restored.status).toBe(200);
		}
		expect(await rawMappings("codex-alpha")).toBe(alphaStored);
		expect(await rawMappings("codex-beta")).toBe(betaStored);
	});

	it("flags a recovery item whose stored form the endpoint would re-serialize, and still restores it semantically", async () => {
		// A one-element array is valid storage, but the existing endpoint
		// normalizes it to a plain string on write.
		const stored = JSON.stringify({
			opus: OLD_PINS.opus,
			sonnet: [OLD_PINS.sonnet],
		});
		await insertAccount("codex-alpha", { modelMappings: stored });
		await publishOwnCatalog("codex-alpha");
		const before = await previewData();

		const response = await apply({
			expected_revision: before.revision,
			selections: [
				{
					accountId: "codex-alpha",
					family: "opus",
					expected_old_value: stored,
				},
			],
		});
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: ApplyData };
		// The unselected one-element array survives the migration as stored.
		expect(await rawMappings("codex-alpha")).toBe(
			JSON.stringify({ sonnet: [OLD_PINS.sonnet] }),
		);
		const [item] = data.recovery;
		expect(item?.exactRoundTrip).toBe(false);
		if (!item) throw new Error("recovery item missing");

		const restored = await createAccountModelMappingsUpdateHandler(dbOps)(
			post(`/api/accounts/${item.accountId}/model-mappings`, item),
			item.accountId,
		);
		expect(restored.status).toBe(200);
		expect(parseModelMappings(await rawMappings("codex-alpha"))).toEqual(
			parseModelMappings(stored),
		);
	});
});
