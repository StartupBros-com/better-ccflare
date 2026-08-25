import { afterEach, describe, expect, it } from "bun:test";
import {
	type ResolvedDistributionProvenance,
	resolveBuildProvenance,
} from "@better-ccflare/core";
import {
	createUpdateStatusService,
	createVersionCheckHandler,
} from "./version";

const sha = "abcdef1234567890abcdef1234567890abcdef12";

function provenance(
	overrides: Partial<ResolvedDistributionProvenance> = {},
): ResolvedDistributionProvenance {
	return {
		raw: "v1:tombii-npm-package",
		schemaVersion: "v1",
		identity: "v1:tombii-npm-package",
		producer: "tombii",
		artifactMode: "package",
		updateChannel: "npm",
		source_sha: sha,
		source_ref: "refs/tags/v1.0.0",
		proven: true,
		actionable: true,
		reason: "proven_actionable",
		...overrides,
	};
}

describe("update status service", () => {
	it("does not call an adapter or expose an action for managed and unproven provenance", async () => {
		let calls = 0;
		const service = createUpdateStatusService({
			currentVersion: () => "1.0.0",
			readProvenance: () =>
				provenance({
					actionable: false,
					updateChannel: null,
					reason: "proven_non_actionable",
				}),
			adapters: {
				npm: async () => {
					calls += 1;
					return "1.1.0";
				},
			},
		});

		const managed = await service.check();
		expect(managed.availability).toBe("unavailable");
		expect(managed.action).toBeNull();
		expect(calls).toBe(0);

		const forged = await createUpdateStatusService({
			currentVersion: () => "1.0.0",
			readProvenance: () =>
				provenance({
					proven: false,
					actionable: false,
					updateChannel: null,
					reason: "invalid_source_sha",
				}),
			adapters: {
				npm: async () => {
					calls += 1;
					return "1.1.0";
				},
			},
		}).check();
		expect(forged.reason).toBe("invalid_source_sha");
		expect(forged.action).toBeNull();
		expect(calls).toBe(0);
	});

	it("uses only the validated channel adapter and isolates cache cohorts", async () => {
		let npmCalls = 0;
		let ghcrCalls = 0;
		let current: ResolvedDistributionProvenance = provenance();
		const service = createUpdateStatusService({
			currentVersion: () => "1.0.0",
			readProvenance: () => current,
			adapters: {
				npm: async () => {
					npmCalls += 1;
					return "1.1.0";
				},
				ghcr: async () => {
					ghcrCalls += 1;
					return "1.2.0";
				},
			},
		});
		const npmFirst = await service.check();
		const npmSecond = await service.check();
		expect(npmFirst.action?.value).toBe("npm install -g better-ccflare@latest");
		expect(npmSecond.cache).toBe("hit");
		expect(npmCalls).toBe(1);
		expect(ghcrCalls).toBe(0);

		current = provenance({
			raw: "v1:tombii-ghcr-docker",
			identity: "v1:tombii-ghcr-docker",
			artifactMode: "docker",
			updateChannel: "ghcr",
			source_ref: "refs/tags/v1.0.0",
		});
		const image = await service.check();
		expect(image.action?.value).toBe(
			"docker pull ghcr.io/tombii/better-ccflare:latest",
		);
		expect(image.cache).toBe("miss");
		expect(ghcrCalls).toBe(1);
	});

	it("fails closed for every forged, unproven, and non-actionable facade", async () => {
		let calls = 0;
		for (const override of [
			{ proven: false, actionable: false, reason: "invalid_source_sha" },
			{
				raw: "forged",
				identity: null,
				producer: null,
				artifactMode: null,
				updateChannel: null,
				actionable: false,
				proven: false,
				reason: "unknown_distribution",
			},
			{ producer: "startupbros" as const },
			{ artifactMode: "binary" as const },
			{ updateChannel: "ghcr" as const },
			{ source_sha: sha.toUpperCase() },
			{ source_ref: "refs/tags/v1.0.1" },
			{
				raw: "v1:startupbros-docker-image",
				identity: "v1:startupbros-docker-image" as const,
				producer: "startupbros" as const,
				artifactMode: "docker" as const,
				updateChannel: null,
				actionable: false,
				reason: "proven_non_actionable",
			},
		]) {
			const result = await createUpdateStatusService({
				currentVersion: () => "1.0.0",
				readProvenance: () => provenance(override),
				adapters: {
					npm: async () => {
						calls += 1;
						return "2.0.0";
					},
				},
			}).check();
			expect(result.availability).toBe("unavailable");
			expect(result.action).toBeNull();
		}
		expect(calls).toBe(0);
	});

	it("does no lookup for every resolved managed or malformed provenance shape", async () => {
		let calls = 0;
		const managed = {
			CCFLARE_DISTRIBUTION: "v1:startupbros-managed-source",
			CCFLARE_GIT_SHA: sha,
			CCFLARE_GIT_REF: "refs/heads/main",
			CCFLARE_SOURCE_SHA: sha,
			CCFLARE_SOURCE_REF: "refs/heads/main",
			CCFLARE_PRODUCER: "startupbros",
			CCFLARE_ARTIFACT_MODE: "managed-source",
		} as const;
		for (const env of [
			managed,
			{},
			{ ...managed, CCFLARE_DISTRIBUTION: "v1:arbitrary:tuple" },
			{ ...managed, CCFLARE_DISTRIBUTION: " v1:startupbros-managed-source" },
			{ ...managed, CCFLARE_GIT_SHA: "short" },
			{ ...managed, CCFLARE_GIT_SHA: sha.toUpperCase() },
			{ ...managed, CCFLARE_GIT_REF: "refs/tags/v1.0.0" },
			{ ...managed, CCFLARE_SOURCE_SHA: "forged" },
			{ ...managed, CCFLARE_UPDATE_CHANNEL: "" },
			{ ...managed, CCFLARE_PRODUCER: "tombii" },
			{
				CCFLARE_DISTRIBUTION: "v1:startupbros-docker-image",
				CCFLARE_GIT_SHA: sha,
				CCFLARE_GIT_REF: "refs/heads/main",
			},
		] as const) {
			const result = await createUpdateStatusService({
				currentVersion: () => "1.0.0",
				readProvenance: () => resolveBuildProvenance(env),
				adapters: {
					npm: async () => {
						calls += 1;
						return "2.0.0";
					},
				},
			}).check();
			expect(result.availability).toBe("unavailable");
			expect(result.action).toBeNull();
		}
		expect(calls).toBe(0);
	});

	it("reports lookup failures separately without an action", async () => {
		const result = await createUpdateStatusService({
			currentVersion: () => "1.0.0",
			readProvenance: () => provenance(),
			adapters: {
				npm: async () => {
					throw new Error("fixture outage");
				},
			},
		}).check();
		expect(result).toMatchObject({
			availability: "unavailable",
			action: null,
			reason: "lookup_failed:fixture outage",
		});
	});

	it("fails closed when a trusted adapter returns a non-stable version", async () => {
		for (const latest of [
			"1.0.1-rc.1",
			"1.0.1+build.7",
			"1.0.1-rc..1",
			"01.0.1",
			"1.00.1",
			"1.0.01",
			"1.0",
			"v1.0.1",
			"unknown",
		]) {
			const result = await createUpdateStatusService({
				currentVersion: () => "1.0.0",
				readProvenance: () => provenance(),
				adapters: { npm: async () => latest },
			}).check();
			expect(result).toMatchObject({
				availability: "unavailable",
				latestVersion: null,
				action: null,
				cache: "not-applicable",
			});
			expect(result.reason).toStartWith("lookup_failed:");
		}
	});

	it("returns an atomic handler result without a generic npm fallback", async () => {
		let calls = 0;
		const handler = createVersionCheckHandler({
			currentVersion: () => "1.0.0",
			readProvenance: () =>
				provenance({
					raw: "forged",
					identity: null,
					producer: null,
					artifactMode: null,
					proven: false,
					actionable: false,
					updateChannel: null,
					reason: "unknown_distribution",
				}),
			adapters: {
				npm: async () => {
					calls += 1;
					return "2.0.0";
				},
			},
		});
		const response = await handler();
		const body = (await response.json()) as {
			availability: string;
			currentVersion: string;
			latestVersion: string | null;
			action: unknown;
			cache: string;
			reason: string;
			provenance: { reason: string };
		};
		expect(body).toEqual({
			provenance: expect.objectContaining({ reason: "unknown_distribution" }),
			currentVersion: "1.0.0",
			availability: "unavailable",
			latestVersion: null,
			action: null,
			cache: "not-applicable",
			reason: "unknown_distribution",
		});
		expect(calls).toBe(0);
	});
});

const originalFetch = globalThis.fetch;
const ghcrTagsUrl = "https://ghcr.io/v2/tombii/better-ccflare/tags/list";
const ghcrTokenUrl =
	"https://ghcr.io/token?service=ghcr.io&scope=repository%3Atombii%2Fbetter-ccflare%3Apull";

function ghcrService() {
	return createUpdateStatusService({
		currentVersion: () => "1.0.0",
		readProvenance: () =>
			provenance({
				raw: "v1:tombii-ghcr-docker",
				identity: "v1:tombii-ghcr-docker",
				artifactMode: "docker",
				updateChannel: "ghcr",
			}),
	});
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, init);
}

function installFetchFixture(
	responses: Array<Response | ((url: string, init?: RequestInit) => Response)>,
	requests: Array<{ url: string; init?: RequestInit }>,
): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });
		const next = responses.shift();
		if (!next) throw new Error(`unexpected fetch: ${url}`);
		return typeof next === "function" ? next(url, init) : next;
	}) as typeof fetch;
}

function expectLookupFailure(
	result: Awaited<ReturnType<ReturnType<typeof ghcrService>["check"]>>,
) {
	expect(result.availability).toBe("unavailable");
	expect(result.latestVersion).toBeNull();
	expect(result.action).toBeNull();
	expect(result.cache).toBe("not-applicable");
	expect(result.reason).toStartWith("lookup_failed:");
}

describe("fixed GHCR update adapter", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("acquires a public pull token and selects the latest stable tag across pages", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture(
			[
				jsonResponse({ token: "public-pull-token" }),
				jsonResponse(
					{ tags: ["latest", "v1.2.0", "v9.9.9-beta"] },
					{
						headers: {
							Link: `<${ghcrTagsUrl}?last=v1.2.0>; rel="next"`,
						},
					},
				),
				jsonResponse({ tags: ["v1.3.0", "v1.2.1", "v09.9.9"] }),
			],
			requests,
		);

		const result = await ghcrService().check();

		expect(result).toMatchObject({
			availability: "available",
			latestVersion: "1.3.0",
			action: {
				kind: "command",
				value: "docker pull ghcr.io/tombii/better-ccflare:latest",
			},
		});
		expect(requests.map((request) => request.url)).toEqual([
			ghcrTokenUrl,
			ghcrTagsUrl,
			`${ghcrTagsUrl}?last=v1.2.0`,
		]);
		expect(requests[0]?.init).toEqual({ redirect: "error" });
		expect(requests.slice(1).map((request) => request.init)).toEqual([
			{
				redirect: "error",
				headers: { Authorization: "Bearer public-pull-token" },
			},
			{
				redirect: "error",
				headers: { Authorization: "Bearer public-pull-token" },
			},
		]);
	});

	it("selects stable tags above Number.MAX_SAFE_INTEGER precisely", async () => {
		for (const [older, newer] of [
			["9007199254740992.0.0", "9007199254740993.0.0"],
			["1.0.9007199254740992", "1.0.9007199254740993"],
		]) {
			const requests: Array<{ url: string; init?: RequestInit }> = [];
			installFetchFixture(
				[
					jsonResponse({ token: "public-pull-token" }),
					jsonResponse({ tags: [`v${older}`, `v${newer}`] }),
				],
				requests,
			);

			const result = await ghcrService().check();

			expect(result).toMatchObject({
				availability: "available",
				latestVersion: newer,
			});
		}
	});

	it("fails closed for a malformed public token without requesting tags", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture([jsonResponse({ token: 42 })], requests);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests.map((request) => request.url)).toEqual([ghcrTokenUrl]);
	});

	it("fails closed when the authenticated registry request fails", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture(
			[
				jsonResponse({ access_token: "public-pull-token" }),
				jsonResponse({ errors: [] }, { status: 503 }),
			],
			requests,
		);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.init?.headers).toEqual({
			Authorization: "Bearer public-pull-token",
		});
	});

	it("fails closed instead of following an unsafe pagination link", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture(
			[
				jsonResponse({ token: "public-pull-token" }),
				jsonResponse(
					{ tags: ["v1.2.0"] },
					{ headers: { Link: '<https://attacker.invalid/tags>; rel="next"' } },
				),
			],
			requests,
		);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests).toHaveLength(2);
	});

	it("fails closed when a pagination link cycles", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture(
			[
				jsonResponse({ token: "public-pull-token" }),
				jsonResponse(
					{ tags: ["v1.2.0"] },
					{ headers: { Link: `<${ghcrTagsUrl}>; rel="next"` } },
				),
			],
			requests,
		);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests).toHaveLength(2);
	});

	it("fails closed when pagination exceeds the page limit", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const pages = Array.from({ length: 101 }, (_, index) =>
			jsonResponse(
				{ tags: [`v1.2.${index}`] },
				{
					headers: {
						Link: `<${ghcrTagsUrl}?page=${index + 1}>; rel="next"`,
					},
				},
			),
		);
		installFetchFixture(
			[jsonResponse({ token: "public-pull-token" }), ...pages],
			requests,
		);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests).toHaveLength(101);
	});

	it("fails closed for a malformed tags page", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		installFetchFixture(
			[
				jsonResponse({ token: "public-pull-token" }),
				jsonResponse({ tags: ["v1.2.0", 42] }),
			],
			requests,
		);

		const result = await ghcrService().check();

		expectLookupFailure(result);
		expect(requests).toHaveLength(2);
	});
});
