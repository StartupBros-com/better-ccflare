import { describe, expect, it, mock, spyOn } from "bun:test";
import { convertFamilyPolicyAliasesViaLocalControl } from "../src/main";

describe("--convert-family-policy-aliases local control", () => {
	it("uses the persisted-secret header for preview then applies all reviewed candidates", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const fetch = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/preview")) {
				return Response.json({
					success: true,
					data: {
						revision: 4,
						candidates: [
							{
								identity: { kind: "family_assignment", family: "opus" },
								family: "opus",
								current_value: "claude-opus-5",
								alias: "opus",
								latest_target: "claude-opus-5",
							},
						],
					},
				});
			}
			expect(init?.headers).toMatchObject({
				"x-better-ccflare-local-control-secret": "local-secret",
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				expected_revision: 4,
				selections: [
					{
						identity: { kind: "family_assignment", family: "opus" },
						family: "opus",
						expected_old_value: "claude-opus-5",
					},
				],
			});
			return Response.json({
				success: true,
				data: { revision: 5, converted: 1 },
			});
		});
		try {
			expect(
				await convertFamilyPolicyAliasesViaLocalControl({
					baseUrl: "http://127.0.0.1:8788",
					localControlSecret: "local-secret",
					all: true,
					yes: true,
					interactive: false,
					fetch,
				}),
			).toEqual({ revision: 5, converted: 1 });
			expect(fetch).toHaveBeenCalledTimes(2);
		} finally {
			log.mockRestore();
		}
	});

	it("rejects a non-loopback target before sending the secret", async () => {
		const fetch = mock();
		await expect(
			convertFamilyPolicyAliasesViaLocalControl({
				baseUrl: "https://example.com",
				localControlSecret: "local-secret",
				all: true,
				yes: true,
				interactive: false,
				fetch,
			}),
		).rejects.toThrow("loopback");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects redirects before a second host can receive the local-control secret", async () => {
		const fetch = mock(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.2:8788/redirected" },
				}),
		);
		await expect(
			convertFamilyPolicyAliasesViaLocalControl({
				baseUrl: "http://127.0.0.1:8788",
				localControlSecret: "local-secret",
				all: true,
				yes: true,
				interactive: false,
				fetch,
			}),
		).rejects.toThrow("Local conversion failed");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0].toString()).toContain("127.0.0.1");
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
	});

	it("sends exact family-scoped stale-pin preview and apply bodies", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const fetch = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/preview")) {
				expect(JSON.parse(String(init?.body))).toEqual({
					include_pinned_family: "fable",
				});
				return Response.json({
					success: true,
					data: {
						revision: 9,
						candidates: [
							{
								identity: { kind: "family_assignment", family: "fable" },
								family: "fable",
								current_value: "claude-fable-5-1",
								alias: "fable",
								latest_target: "claude-fable-5-1",
							},
						],
						pinned_candidates: [
							{
								identity: { kind: "combo_slot", slot_id: "fable-pin" },
								family: "fable",
								current_value: "claude-fable-5",
								alias: "fable",
								latest_target: "claude-fable-5-1",
								candidate_kind: "stale_pinned_family_value",
								reason: "same_family_stale_pin",
							},
						],
						skipped: [],
					},
				});
			}
			expect(JSON.parse(String(init?.body))).toEqual({
				expected_revision: 9,
				include_pinned_family: "fable",
				selections: [
					{
						identity: { kind: "family_assignment", family: "fable" },
						family: "fable",
						expected_old_value: "claude-fable-5-1",
					},
					{
						identity: { kind: "combo_slot", slot_id: "fable-pin" },
						family: "fable",
						expected_old_value: "claude-fable-5",
					},
				],
			});
			return Response.json({
				success: true,
				data: { revision: 10, converted: 2 },
			});
		});
		try {
			expect(
				await convertFamilyPolicyAliasesViaLocalControl({
					baseUrl: "http://127.0.0.1:8788",
					localControlSecret: "local-secret",
					all: false,
					family: "fable",
					includePins: true,
					yes: true,
					interactive: false,
					fetch,
				}),
			).toEqual({ revision: 10, converted: 2 });
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("stale pinned candidate"),
			);
		} finally {
			log.mockRestore();
		}
	});

	it("rejects every invalid family option combination before fetching", async () => {
		for (const options of [
			{ all: true, family: "fable", includePins: true, yes: true },
			{ all: false, includePins: true, yes: true },
			{ all: false, family: "fable", includePins: true, yes: false },
			{ all: true, family: "fable", includePins: false, yes: true },
			{ all: false, family: "fable", includePins: false, yes: true },
			{ all: false, family: "fabl", includePins: true, yes: true },
			{
				all: false,
				family: "fable",
				familyProvided: true,
				familyCount: 2,
				includePins: true,
				yes: true,
			},
		]) {
			const fetch = mock();
			await expect(
				convertFamilyPolicyAliasesViaLocalControl({
					baseUrl: "http://127.0.0.1:8788",
					localControlSecret: "local-secret",
					interactive: false,
					fetch,
					...options,
				}),
			).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		}
	});

	it("interactively confirms displayed stale pins without requiring --yes", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const confirm = mock(async () => true);
		const fetch = mock(async (input: URL | RequestInfo) => {
			if (new URL(String(input)).pathname.endsWith("/preview")) {
				return Response.json({
					success: true,
					data: {
						revision: 1,
						candidates: [],
						pinned_candidates: [
							{
								identity: { kind: "family_assignment", family: "fable" },
								family: "fable",
								current_value: "claude-fable-5",
								alias: "fable",
								latest_target: "claude-fable-5-1",
								candidate_kind: "stale_pinned_family_value",
								reason: "same_family_stale_pin",
							},
						],
						skipped: [],
					},
				});
			}
			return Response.json({
				success: true,
				data: { revision: 2, converted: 1 },
			});
		});
		try {
			await convertFamilyPolicyAliasesViaLocalControl({
				baseUrl: "http://127.0.0.1:8788",
				localControlSecret: "local-secret",
				all: false,
				family: "fable",
				includePins: true,
				yes: false,
				interactive: true,
				confirm,
				fetch,
			});
			expect(confirm).toHaveBeenCalledWith(
				expect.stringContaining("stale pinned"),
			);
		} finally {
			log.mockRestore();
		}
	});
});
