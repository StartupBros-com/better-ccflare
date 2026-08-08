import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	CODEX_WHAM_USAGE_ENDPOINT,
	CODEX_WHAM_USAGE_FALLBACK_ENDPOINT,
	extractChatGptAccountId,
	fetchCodexUsageData,
	resetCodexUsageEndpointForTest,
} from "./api-usage";

function base64url(input: string): string {
	return Buffer.from(input, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function makeAccessToken(claims: Record<string, unknown>): string {
	const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
	const payload = base64url(JSON.stringify(claims));
	return `${header}.${payload}.signature`;
}

const ACCOUNT_TOKEN = makeAccessToken({
	"https://api.openai.com/auth": {
		chatgpt_account_id: "acct-123",
	},
});
const NO_CLAIM_TOKEN = makeAccessToken({ sub: "user-1" });

describe("extractChatGptAccountId", () => {
	it("extracts the chatgpt_account_id claim from a valid JWT", () => {
		expect(extractChatGptAccountId(ACCOUNT_TOKEN)).toBe("acct-123");
	});

	it("returns null when the JWT has no matching claim", () => {
		expect(extractChatGptAccountId(NO_CLAIM_TOKEN)).toBeNull();
	});

	it("returns null for non-JWT garbage", () => {
		expect(extractChatGptAccountId("not-a-jwt")).toBeNull();
		expect(extractChatGptAccountId("a.b")).toBeNull();
		expect(extractChatGptAccountId("a.b.c.d")).toBeNull();
		expect(extractChatGptAccountId("a.!!!not-base64!!!.c")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(extractChatGptAccountId("")).toBeNull();
	});
});

describe("fetchCodexUsageData", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetCodexUsageEndpointForTest();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetCodexUsageEndpointForTest();
	});

	it("maps a paid plan's primary + secondary windows to five_hour / seven_day", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 12.3,
						reset_at: 1712345678,
						limit_window_seconds: 18000,
					},
					secondary_window: {
						used_percent: 4,
						reset_at: 1712945678,
						limit_window_seconds: 604800,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.retryAfterMs).toBeNull();
		expect(result.data?.five_hour).toEqual({
			utilization: 12.3,
			resets_at: new Date(1712345678 * 1000).toISOString(),
		});
		expect(result.data?.seven_day).toEqual({
			utilization: 4,
			resets_at: new Date(1712945678 * 1000).toISOString(),
		});
	});

	it("maps a free plan's primary-only window to seven_day", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "Free",
				rate_limit: {
					primary_window: {
						used_percent: 50,
						reset_at: 1712345678,
						limit_window_seconds: 18000,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.seven_day).toEqual({
			utilization: 50,
			resets_at: new Date(1712345678 * 1000).toISOString(),
		});
		expect(result.data?.five_hour).toEqual({ utilization: 0, resets_at: null });
	});

	it("maps a non-free primary-only window with a short window to five_hour", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 33,
						reset_at: 1712345678,
						limit_window_seconds: 18000,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.five_hour).toEqual({
			utilization: 33,
			resets_at: new Date(1712345678 * 1000).toISOString(),
		});
		expect(result.data?.seven_day).toEqual({ utilization: 0, resets_at: null });
	});

	it("maps a non-free primary-only window with a >=7d window to seven_day", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 33,
						reset_at: 1712345678,
						limit_window_seconds: 604800,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.seven_day).toEqual({
			utilization: 33,
			resets_at: new Date(1712345678 * 1000).toISOString(),
		});
		expect(result.data?.five_hour).toEqual({ utilization: 0, resets_at: null });
	});

	it("maps a zero reset_at to a null resets_at", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 10,
						reset_at: 0,
						limit_window_seconds: 18000,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.five_hour).toEqual({
			utilization: 10,
			resets_at: null,
		});
	});

	it("attaches credits_balance as a number", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: 0 },
				},
				credits: { balance: 1.23 },
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.credits_balance).toBe(1.23);
	});

	it("attaches credits_balance parsed from a numeric string", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: 0 },
				},
				credits: { balance: "4.56" },
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.credits_balance).toBe(4.56);
	});

	it("attaches credits_balance as null when the balance is null or invalid", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: 0 },
				},
				credits: { balance: null },
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.credits_balance).toBeNull();
	});

	it("attaches code-review usage as flat scalars, never a window-shaped object", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: 0 },
				},
				code_review_rate_limit: {
					primary_window: { used_percent: 7, reset_at: 1712345678 },
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.code_review_used_percent).toBe(7);
		expect(result.data?.code_review_resets_at).toBe(
			new Date(1712345678 * 1000).toISOString(),
		);
		// A window-shaped `code_review` property would be folded into
		// getRepresentativeUtilization/-Window and misread a maxed code-review
		// quota as account-level chat exhaustion.
		expect(result.data?.code_review).toBeUndefined();
	});

	it("returns null data when no windows are present at all", async () => {
		const fetchMock = mock(async () => Response.json({ plan_type: "plus" }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data).toBeNull();
		expect(result.retryAfterMs).toBeNull();
	});

	it("retries at the flipped path on a 404 and succeeds within the same call", async () => {
		const calls: string[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url === CODEX_WHAM_USAGE_ENDPOINT) {
				return new Response("not found", { status: 404 });
			}
			expect(url).toBe(CODEX_WHAM_USAGE_FALLBACK_ENDPOINT);
			return Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 20, reset_at: 0 },
				},
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(calls).toEqual([
			CODEX_WHAM_USAGE_ENDPOINT,
			CODEX_WHAM_USAGE_FALLBACK_ENDPOINT,
		]);
		expect(result.data?.five_hour?.utilization).toBe(20);
	});

	it("goes straight to the remembered URL on subsequent calls after a flip", async () => {
		const calls: string[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url === CODEX_WHAM_USAGE_ENDPOINT) {
				return new Response("not found", { status: 404 });
			}
			return Response.json({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 20, reset_at: 0 },
				},
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodexUsageData(ACCOUNT_TOKEN);
		calls.length = 0;
		const second = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(calls).toEqual([CODEX_WHAM_USAGE_FALLBACK_ENDPOINT]);
		expect(second.data?.five_hour?.utilization).toBe(20);
	});

	it("flips back to the primary URL when the remembered fallback later 404s", async () => {
		// First call: primary 404s, fallback works -> fallback remembered.
		let fallbackDead = false;
		const calls: string[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			const isPrimary = url === CODEX_WHAM_USAGE_ENDPOINT;
			const dead = isPrimary ? !fallbackDead : fallbackDead;
			if (dead) {
				return new Response("not found", { status: 404 });
			}
			return Response.json({
				rate_limit: { primary_window: { used_percent: 33, reset_at: 0 } },
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodexUsageData(ACCOUNT_TOKEN);
		// Now the endpoint migrates back: fallback dies, primary works again.
		fallbackDead = true;
		calls.length = 0;
		const recovered = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(calls).toEqual([
			CODEX_WHAM_USAGE_FALLBACK_ENDPOINT,
			CODEX_WHAM_USAGE_ENDPOINT,
		]);
		expect(recovered.data?.five_hour?.utilization).toBe(33);

		// And the recovery is remembered for the next call.
		calls.length = 0;
		await fetchCodexUsageData(ACCOUNT_TOKEN);
		expect(calls).toEqual([CODEX_WHAM_USAGE_ENDPOINT]);
	});

	it("maps a lone secondary window to seven_day regardless of its length", async () => {
		const fetchMock = mock(async () =>
			Response.json({
				plan_type: "plus",
				rate_limit: {
					// Short limit_window_seconds would heuristically look like 5h,
					// but a secondary window is the weekly quota by definition.
					secondary_window: {
						used_percent: 55,
						reset_at: 1712345678,
						limit_window_seconds: 18000,
					},
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data?.seven_day?.utilization).toBe(55);
		expect(result.data?.five_hour).toEqual({
			utilization: 0,
			resets_at: null,
		});
	});

	it("returns null data instead of hanging when the body read fails", async () => {
		// fetch resolves at headers; a stalled/failing body must not wedge the
		// call — the deadline stays armed through json() and failures return.
		const fetchMock = mock(async () => {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				json: async () => {
					throw new Error("body stream aborted");
				},
			} as unknown as Response;
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result).toEqual({ data: null, retryAfterMs: null });
	});

	it("returns no data and no retryAfterMs on a 401", async () => {
		const fetchMock = mock(
			async () => new Response("unauthorized", { status: 401 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result).toEqual({ data: null, retryAfterMs: null });
	});

	it("reads retry-after (seconds) into retryAfterMs on a 429", async () => {
		const fetchMock = mock(
			async () =>
				new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "60" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(result.data).toBeNull();
		expect(result.retryAfterMs).toBe(60_000);
	});

	it("sends an Authorization bearer header and a chatgpt-account-id header when the JWT carries the claim", async () => {
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBe(`Bearer ${ACCOUNT_TOKEN}`);
				expect(headers["chatgpt-account-id"]).toBe("acct-123");
				expect(headers["X-Account-Id"]).toBe("acct-123");
				return Response.json({
					rate_limit: { primary_window: { used_percent: 1, reset_at: 0 } },
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodexUsageData(ACCOUNT_TOKEN);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("omits the chatgpt-account-id header when the JWT carries no claim", async () => {
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBe(`Bearer ${NO_CLAIM_TOKEN}`);
				expect(headers["chatgpt-account-id"]).toBeUndefined();
				expect(headers["X-Account-Id"]).toBeUndefined();
				return Response.json({
					rate_limit: { primary_window: { used_percent: 1, reset_at: 0 } },
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodexUsageData(NO_CLAIM_TOKEN);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
