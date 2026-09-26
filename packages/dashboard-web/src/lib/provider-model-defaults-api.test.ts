import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpError } from "@better-ccflare/errors";
import { api } from "../api";
import {
	fetchProviderModelDefaults,
	fetchProviderModelDefaultsResponse,
	saveProviderModelDefaultOverrides,
} from "./provider-model-defaults-api";

/**
 * Covers finding #1: `fetchProviderModelDefaultsResponse` and its normalizers
 * had no tests, so a server/client shape mismatch would render the
 * Automatic-vs-Pinned accounts panel empty with nothing catching it.
 *
 * The happy-path fixture mirrors the wire shape assembled by
 * `getProviderModelDefaults` in packages/http-api/src/handlers/config.ts
 * (providers/fields), `resolveCodexAccountFamilyDefault` and
 * `describeCodexAccountCatalog` in
 * packages/http-api/src/services/codex-effective-defaults.ts (accounts/
 * families/catalog), and `resolveCodexClientIdentity` in
 * packages/providers/src/providers/codex/client-identity.ts
 * (codexClientIdentity) — specifically the "verified but stale" branch,
 * which is the one real combination that emits `source`, `fresh`,
 * `verifiedAt`, AND `error` together.
 *
 * Follows the fetch-mocking pattern of ./../api.test.ts: replace
 * `api.request` (not `globalThis.fetch`) and restore it in afterEach.
 */

const originalRequest = api.request;
let requestMock: ReturnType<typeof mock>;

function mockResponse(body: unknown) {
	requestMock = mock(async () => body);
	api.request = requestMock as typeof api.request;
}

function mockRejection(error: unknown) {
	requestMock = mock(async () => {
		throw error;
	});
	api.request = requestMock as typeof api.request;
}

afterEach(() => {
	api.request = originalRequest;
});

const HAPPY_BODY = {
	providers: [
		{
			provider: "codex",
			fields: [
				{
					family: "opus",
					factory: "gpt-5.6-sol",
					override: null,
					effective: "gpt-5.6-sol",
				},
				{
					family: "fable",
					factory: "gpt-5.6-terra",
					override: "gpt-6-custom",
					effective: "gpt-6-custom",
				},
			],
		},
		{
			provider: "xai",
			fields: [
				{
					family: "sonnet",
					factory: "grok-4.7",
					override: null,
					effective: "grok-4.7",
				},
			],
		},
	],
	accounts: [
		{
			accountId: "acc-1",
			accountName: "Acme Codex",
			paused: false,
			catalog: { source: "own", fetchedAt: 1_700_000_000_000, stale: false },
			families: [
				{
					family: "opus",
					effectiveModel: "gpt-5.6-sol",
					source: "account_catalog",
					pinned: false,
				},
				{
					family: "fable",
					effectiveModel: "gpt-6-custom",
					source: "account_mapping_pin",
					pinned: true,
				},
				{
					family: "sonnet",
					effectiveModel: "grok-4.7",
					source: "global_provider_override",
					pinned: true,
					globalOverridePinsUnmappedAccount: true,
				},
			],
		},
		{
			accountId: "acc-2",
			accountName: "Borrowed Codex",
			paused: true,
			catalog: {
				source: "borrowed",
				fetchedAt: 1_700_000_100_000,
				stale: true,
				borrowedFrom: "acc-1",
			},
			families: [
				{
					family: "haiku",
					effectiveModel: "gpt-5.6-luna",
					source: "provider_catalog_borrowed",
					pinned: false,
				},
			],
		},
	],
	codexClientIdentity: {
		version: "0.156.0",
		source: "verified",
		fresh: false,
		verifiedAt: "2026-08-20T00:00:00.000Z",
		error: "stale_record",
	},
};

describe("fetchProviderModelDefaultsResponse", () => {
	it("round-trips every field the UI reads on the happy path", async () => {
		mockResponse(HAPPY_BODY);

		const result = await fetchProviderModelDefaultsResponse();

		expect(requestMock.mock.calls[0]?.[0]).toBe(
			"/api/config/provider-model-defaults",
		);
		expect(result).toEqual(HAPPY_BODY);
	});

	it("fetchProviderModelDefaults returns only the providers list", async () => {
		mockResponse(HAPPY_BODY);
		expect(await fetchProviderModelDefaults()).toEqual(HAPPY_BODY.providers);
	});

	describe("normalizeProvider / normalizeField rejection paths", () => {
		it("drops a provider entry with a missing or wrong-typed provider name, keeping good siblings", async () => {
			mockResponse({
				providers: [
					{ fields: [] }, // missing provider -> dropped
					{ provider: 42, fields: [] }, // wrong type -> dropped
					{ provider: "codex", fields: [] }, // good sibling -> kept
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.providers).toEqual([{ provider: "codex", fields: [] }]);
		});

		it("drops a field entry with a missing or wrong-typed family, keeping good siblings", async () => {
			mockResponse({
				providers: [
					{
						provider: "codex",
						fields: [
							{ factory: "gpt-x", override: null, effective: "gpt-x" }, // missing family -> dropped
							{ family: 7, factory: "gpt-x" }, // wrong type -> dropped
							{
								family: "opus",
								factory: "gpt-5.6-sol",
								override: null,
								effective: "gpt-5.6-sol",
							},
						],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.providers).toEqual([
				{
					provider: "codex",
					fields: [
						{
							family: "opus",
							factory: "gpt-5.6-sol",
							override: null,
							effective: "gpt-5.6-sol",
						},
					],
				},
			]);
		});

		it("tolerates a non-array `fields` by treating the provider as having none", async () => {
			mockResponse({
				providers: [{ provider: "codex", fields: "not-an-array" }],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.providers).toEqual([{ provider: "codex", fields: [] }]);
		});

		it("falls back effective to override, then factory, when the server omits it", async () => {
			mockResponse({
				providers: [
					{
						provider: "codex",
						fields: [
							{
								family: "opus",
								factory: "gpt-factory",
								override: "gpt-override",
							},
							{ family: "haiku", factory: "gpt-factory-only" },
						],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.providers[0].fields).toEqual([
				{
					family: "opus",
					factory: "gpt-factory",
					override: "gpt-override",
					effective: "gpt-override",
				},
				{
					family: "haiku",
					factory: "gpt-factory-only",
					override: null,
					effective: "gpt-factory-only",
				},
			]);
		});
	});

	describe("normalizeAccountEffectiveDefaults / normalizeFamilyDefault rejection paths", () => {
		it("drops an account entry with a missing accountId, keeping good siblings", async () => {
			mockResponse({
				providers: [],
				accounts: [
					{ accountName: "No id", families: [] }, // missing accountId -> dropped
					{
						accountId: "acc-1",
						accountName: "Has id",
						paused: false,
						catalog: { source: "none", fetchedAt: null, stale: false },
						families: [],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.accounts).toEqual([
				{
					accountId: "acc-1",
					accountName: "Has id",
					paused: false,
					catalog: { source: "none", fetchedAt: null, stale: false },
					families: [],
				},
			]);
		});

		it("falls back accountName to accountId when the server omits it", async () => {
			mockResponse({
				providers: [],
				accounts: [
					{
						accountId: "acc-1",
						families: [],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.accounts?.[0]).toMatchObject({
				accountId: "acc-1",
				accountName: "acc-1",
			});
		});

		it("drops a family entry with a missing family, keeping good siblings", async () => {
			mockResponse({
				providers: [],
				accounts: [
					{
						accountId: "acc-1",
						accountName: "Acc 1",
						paused: false,
						catalog: { source: "own", fetchedAt: 1, stale: false },
						families: [
							{
								effectiveModel: "gpt-x",
								source: "account_catalog",
								pinned: false,
							}, // missing family -> dropped
							{
								family: "opus",
								effectiveModel: "gpt-5.6-sol",
								source: "account_catalog",
								pinned: false,
							},
						],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.accounts?.[0].families).toEqual([
				{
					family: "opus",
					effectiveModel: "gpt-5.6-sol",
					source: "account_catalog",
					pinned: false,
				},
			]);
		});

		it("tolerates a non-array `families` and a missing `catalog` by defaulting both", async () => {
			mockResponse({
				providers: [],
				accounts: [{ accountId: "acc-1", families: "not-an-array" }],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.accounts).toEqual([
				{
					accountId: "acc-1",
					accountName: "acc-1",
					paused: false,
					catalog: { source: "none", fetchedAt: null, stale: false },
					families: [],
				},
			]);
		});

		it("keeps an unrecognized `source` label verbatim instead of dropping the entry (tolerant-by-design union)", async () => {
			mockResponse({
				providers: [],
				accounts: [
					{
						accountId: "acc-1",
						families: [
							{
								family: "opus",
								effectiveModel: "gpt-future",
								source: "future_source_v2",
								pinned: true,
							},
						],
					},
				],
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result.accounts?.[0].families[0].source).toBe("future_source_v2");
		});

		it("omits accounts entirely when the server does not send an array", async () => {
			mockResponse({ providers: [], accounts: { not: "an array" } });
			const result = await fetchProviderModelDefaultsResponse();
			expect(result).not.toHaveProperty("accounts");
		});
	});

	describe("normalizeCodexClientIdentity rejection paths", () => {
		it("drops the whole identity when version is missing, without affecting providers/accounts", async () => {
			mockResponse({
				providers: [{ provider: "codex", fields: [] }],
				codexClientIdentity: { source: "verified", fresh: true },
			});
			const result = await fetchProviderModelDefaultsResponse();
			expect(result).not.toHaveProperty("codexClientIdentity");
			expect(result.providers).toEqual([{ provider: "codex", fields: [] }]);
		});

		it("omits codexClientIdentity entirely when the server does not send the field", async () => {
			mockResponse({ providers: [] });
			const result = await fetchProviderModelDefaultsResponse();
			expect(result).not.toHaveProperty("codexClientIdentity");
		});
	});

	describe("transport behavior", () => {
		it("propagates a non-OK HTTP response as a thrown error, same as the rest of the dashboard API layer", async () => {
			mockRejection(new HttpError(503, "Service unavailable"));
			await expect(fetchProviderModelDefaultsResponse()).rejects.toThrow(
				"Service unavailable",
			);
		});

		// Current behavior, asserted rather than changed per the review brief:
		// unlike most of the dashboard API layer (which trusts the response
		// shape via a TS cast and lets a malformed value crash wherever it is
		// first used), this fetcher actively normalizes a non-object body to an
		// empty result. That is a real finding worth flagging in the report —
		// see "non-object body swallows the shape mismatch" below — but it is
		// not something this test suite should silently fix.
		it("normalizes a non-object body to an empty result instead of throwing", async () => {
			mockResponse(null);
			const result = await fetchProviderModelDefaultsResponse();
			expect(result).toEqual({ providers: [] });
		});

		it("normalizes a string body to an empty result instead of throwing", async () => {
			mockResponse("not-json-shaped");
			const result = await fetchProviderModelDefaultsResponse();
			expect(result).toEqual({ providers: [] });
		});
	});
});

describe("saveProviderModelDefaultOverrides", () => {
	it("POSTs the overrides array verbatim to the provider-model-defaults endpoint", async () => {
		mockResponse({ success: true });
		await saveProviderModelDefaultOverrides([
			{ provider: "codex", family: "opus", model: "gpt-6-wide" },
			{ provider: "codex", family: "fable", model: "" },
		]);

		const [url, options] = requestMock.mock.calls[0] as [
			string,
			{ method?: string; body?: string },
		];
		expect(url).toBe("/api/config/provider-model-defaults");
		expect(options.method).toBe("POST");
		expect(JSON.parse(options.body as string)).toEqual({
			overrides: [
				{ provider: "codex", family: "opus", model: "gpt-6-wide" },
				{ provider: "codex", family: "fable", model: "" },
			],
		});
	});
});
