import { describe, expect, it, mock } from "bun:test";
import type {
	AccountResponse,
	AccountRoutingOverview,
	ComboFamilyAssignment,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import {
	createManagedRoutingClient,
	ManagedRoutingHttpError,
} from "../managed-routing-client";

function effectiveView(
	family: "opus" | "fable" = "opus",
): EffectiveComboRoutingView {
	return {
		family,
		policy: {
			assignment: {
				family,
				combo_id: `combo-${family}`,
				enabled: true,
				membership_mode: "managed",
				managed_model: `claude-${family}-managed`,
			},
			combo: {
				id: `combo-${family}`,
				name: `${family} route`,
				description: null,
				enabled: true,
				created_at: 1,
				updated_at: 1,
			},
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family,
			combo_id: `combo-${family}`,
			active: true,
			reason: "included",
			members: [],
			decisions: [],
		},
	};
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(data, { status, headers });
}

function recordingFetch(...responses: Response[]) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetch = mock(
		async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			const response = responses.shift();
			if (!response) throw new Error("unexpected fetch");
			return response;
		},
	);
	return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("managed routing live HTTP client", () => {
	it("reads the API URL and optional admin header only from the managed environment", async () => {
		const { calls, fetch } = recordingFetch(json([]));
		const client = createManagedRoutingClient({
			env: {
				BETTER_CCFLARE_API_URL: "http://localhost:9191/",
				BETTER_CCFLARE_ADMIN_API_KEY: "admin-secret",
			},
			fetch,
		});

		await client.getAccounts();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://localhost:9191/api/accounts");
		expect(calls[0]?.init?.method).toBe("GET");
		expect(new Headers(calls[0]?.init?.headers).get("x-api-key")).toBe(
			"admin-secret",
		);
		expect(
			new Headers(calls[0]?.init?.headers).get("authorization"),
		).toBeNull();
		expect(calls[0]?.init?.redirect).toBe("manual");
	});

	it("allows an injected loopback base URL but rejects remote or credential-bearing URLs", async () => {
		const fetch = mock(async () =>
			json([]),
		) as unknown as typeof globalThis.fetch;
		const client = createManagedRoutingClient({
			baseUrl: "http://127.0.0.1:8788",
			env: {},
			fetch,
		});
		await client.getAccounts();
		expect(fetch).toHaveBeenCalledTimes(1);

		expect(() =>
			createManagedRoutingClient({
				baseUrl: "https://example.com",
				env: {},
				fetch,
			}),
		).toThrow(/loopback/i);
		expect(() =>
			createManagedRoutingClient({
				baseUrl: "http://user:pass@localhost:8788",
				env: {},
				fetch,
			}),
		).toThrow(/credentials/i);
	});

	it("uses the exact read endpoints for accounts, account routing, and effective family routing", async () => {
		const accounts = [{ id: "account-a" }] as AccountResponse[];
		const overview = {
			effective: [],
			opportunities: [],
		} as AccountRoutingOverview;
		const view = effectiveView();
		const { calls, fetch } = recordingFetch(
			json(accounts),
			json({ success: true, data: overview }),
			json({ success: true, data: [view] }),
			json({ success: true, data: view }),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://127.0.0.1:8788",
			env: {},
			fetch,
		});

		expect(await client.getAccounts()).toEqual(accounts);
		expect(await client.getAccountRoutingOverview()).toEqual(overview);
		expect(await client.listEffectiveRouting()).toEqual([view]);
		expect(await client.getEffectiveRouting("opus")).toEqual(view);
		expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
			"/api/accounts",
			"/api/routing/accounts",
			"/api/routing/effective",
			"/api/routing/effective/opus",
		]);
	});

	it("sends the exact family preview and apply paths and bodies", async () => {
		const preview = {
			preview_id: "preview-1",
			family: "opus",
			managed_model: "claude-opus-4-8",
			proposals: [],
			effective: effectiveView(),
		};
		const view = effectiveView();
		const { calls, fetch } = recordingFetch(
			json({ success: true, data: preview }),
			json({ success: true, data: view }),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://localhost:8788",
			env: {},
			fetch,
		});

		await client.previewFamilyRouting({
			family: "opus",
			managedModel: "claude-opus-4-8",
		});
		await client.applyFamilyRoutingProposal({
			family: "opus",
			previewId: "preview-1",
			proposalId: "proposal-1",
			managedModel: "claude-opus-4-8",
		});

		expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/routing/preview");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			scope: "family",
			family: "opus",
			managed_model: "claude-opus-4-8",
		});
		expect(new URL(calls[1]?.url ?? "").pathname).toBe(
			"/api/routing/apply/opus",
		);
		expect(calls[1]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			scope: "family",
			preview_id: "preview-1",
			proposal_id: "proposal-1",
			managed_model: "claude-opus-4-8",
		});
	});

	it("uses persisted account scope and immutable account identity for post-create review", async () => {
		const accountPreview = { families: [previewResult()] };
		const familyPreview = previewResult();
		const view = effectiveView();
		const { calls, fetch } = recordingFetch(
			json({ success: true, data: accountPreview }),
			json({ success: true, data: familyPreview }),
			json({ success: true, data: view }),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://localhost:8788",
			env: {},
			fetch,
		});

		expect(
			await client.previewAccountRouting({ accountId: "account/created" }),
		).toEqual(accountPreview);
		expect(
			await client.previewAccountRouting({
				accountId: "account/created",
				family: "opus",
				managedModel: "claude-opus-4-8",
			}),
		).toEqual(familyPreview);
		await client.applyAccountRoutingProposal({
			family: "opus",
			accountId: "account/created",
			previewId: "preview-1",
			proposalId: "proposal-1",
			managedModel: "claude-opus-4-8",
		});

		expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
			"/api/routing/preview",
			"/api/routing/preview",
			"/api/routing/apply/opus",
		]);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			scope: "account",
			account_id: "account/created",
		});
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			scope: "account",
			account_id: "account/created",
			family: "opus",
			managed_model: "claude-opus-4-8",
		});
		expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
			scope: "account",
			preview_id: "preview-1",
			proposal_id: "proposal-1",
			managed_model: "claude-opus-4-8",
			subject: { account_id: "account/created" },
		});
	});

	it("rolls back with a single mode-only request", async () => {
		const assignment: ComboFamilyAssignment = {
			family: "opus",
			combo_id: "combo-opus",
			enabled: true,
			membership_mode: "manual",
			managed_model: "claude-opus-4-8",
		};
		const { calls, fetch } = recordingFetch(
			json({ success: true, data: assignment }),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://localhost:8788",
			env: {},
			fetch,
		});

		expect(await client.rollbackFamilyToManual("opus")).toEqual(assignment);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/families/opus");
		expect(calls[0]?.init?.method).toBe("PUT");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			membership_mode: "manual",
		});
	});

	it("rejects credentialed redirects without forwarding the admin key", async () => {
		const { calls, fetch } = recordingFetch(
			new Response(null, {
				status: 307,
				headers: { location: "https://attacker.invalid/capture" },
			}),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://localhost:8788",
			env: { BETTER_CCFLARE_ADMIN_API_KEY: "admin-secret" },
			fetch,
		});

		await expect(client.getAccounts()).rejects.toMatchObject({
			name: "ManagedRoutingHttpError",
			code: "redirect_rejected",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.redirect).toBe("manual");
	});

	it("never retries a failed mutation and preserves safe stale/empty error codes", async () => {
		for (const [status, code] of [
			[409, "stale_routing_preview"],
			[422, "managed_route_empty"],
		] as const) {
			const { calls, fetch } = recordingFetch(
				json({ error: "unsafe server detail", details: { code } }, status),
			);
			const client = createManagedRoutingClient({
				baseUrl: "http://localhost:8788",
				env: {},
				fetch,
			});

			try {
				await client.applyFamilyRoutingProposal({
					family: "opus",
					previewId: "preview-1",
					proposalId: "proposal-1",
					managedModel: "claude-opus-4-8",
				});
				throw new Error("expected managed routing error");
			} catch (error) {
				expect(error).toBeInstanceOf(ManagedRoutingHttpError);
				expect((error as ManagedRoutingHttpError).code).toBe(code);
			}
			expect(calls).toHaveLength(1);
		}
	});

	it("does not expose server payloads or the admin credential in thrown errors", async () => {
		const secret = "admin-secret-never-print";
		const { fetch } = recordingFetch(
			json(
				{
					error: `leaked ${secret}`,
					details: { api_key: secret, token: secret },
				},
				500,
			),
		);
		const client = createManagedRoutingClient({
			baseUrl: "http://localhost:8788",
			env: { BETTER_CCFLARE_ADMIN_API_KEY: secret },
			fetch,
		});

		try {
			await client.rollbackFamilyToManual("opus");
			throw new Error("expected managed routing error");
		} catch (error) {
			const rendered = `${String(error)} ${JSON.stringify(error)}`;
			expect(rendered).not.toContain(secret);
			expect(rendered).not.toContain("api_key");
			expect(rendered).not.toContain("token");
		}
	});
});

function previewResult() {
	return {
		preview_id: "preview-1",
		scope: "account" as const,
		family: "opus" as const,
		managed_model: "claude-opus-4-8",
		proposals: [],
		effective: effectiveView(),
	};
}
