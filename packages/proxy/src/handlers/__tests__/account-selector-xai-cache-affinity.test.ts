import { describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { CacheAffinityOrderer } from "../../cache-affinity-orderer";
import {
	getXaiConvId,
	selectAccountsForRequest,
	setXaiConvId,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "xai",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
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
		requires_reauth: false,
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
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeAffinityMeta(key: string, overrides: Partial<RequestMeta> = {}) {
	return makeRequestMeta({
		cacheAffinityKey: key,
		xaiCacheNativeActive: true,
		...overrides,
	});
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeCtx(
	opts: {
		accounts?: Account[];
		activeCombo?: ComboWithSlots | null;
		orderer?: CacheAffinityOrderer;
	} = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((candidates: Account[], _meta: RequestMeta) => candidates),
		},
		cacheAffinityOrderer: opts.orderer ?? new CacheAffinityOrderer(60_000),
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

function recordServed(
	ctx: ProxyContext,
	meta: RequestMeta,
	account: Account,
	candidateId?: string,
): void {
	const resolvedCandidateId =
		candidateId ??
		meta.routingCandidates?.find((entry) => entry.accountId === account.id)
			?.candidateId;
	if (!resolvedCandidateId)
		throw new Error("expected routing candidate identity");
	ctx.cacheAffinityOrderer?.recordSuccess(
		meta,
		resolvedCandidateId,
		account.id,
	);
}

describe("setXaiConvId / getXaiConvId", () => {
	it("stores request-local transport identity without leaking across metadata", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setXaiConvId(meta1, "ccflare-xai-meta1");

		expect(getXaiConvId(meta1)).toBe("ccflare-xai-meta1");
		expect(getXaiConvId(meta2)).toBeNull();
	});
});

describe("selectAccountsForRequest — xAI cache-native affinity", () => {
	it("does not reorder or record ownership outside an active cache-native route", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const firstCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });

		expect(
			(await selectAccountsForRequest(makeRequestMeta(), firstCtx)).map(
				(account) => account.id,
			),
		).toEqual(["xai-a", "xai-b"]);

		const secondCtx = makeCtx({ accounts: [xaiB, xaiA], orderer });
		expect(
			(await selectAccountsForRequest(makeRequestMeta(), secondCtx)).map(
				(account) => account.id,
			),
		).toEqual(["xai-b", "xai-a"]);
	});

	it("keeps selection read-only until a candidate is confirmed to have served", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const firstCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const firstMeta = makeAffinityMeta("conv-first-use");

		expect(
			(await selectAccountsForRequest(firstMeta, firstCtx)).map(
				(account) => account.id,
			),
		).toEqual(["xai-a", "xai-b"]);

		const secondCtx = makeCtx({ accounts: [xaiB, xaiA], orderer });
		expect(
			(
				await selectAccountsForRequest(
					makeAffinityMeta("conv-first-use"),
					secondCtx,
				)
			).map((account) => account.id),
		).toEqual(["xai-b", "xai-a"]);
	});

	it("promotes the exact candidate confirmed on a prior request", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const firstCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const firstMeta = makeAffinityMeta("conv-owner-preferred");
		await selectAccountsForRequest(firstMeta, firstCtx);
		recordServed(firstCtx, firstMeta, xaiA);

		const secondCtx = makeCtx({ accounts: [xaiB, xaiA], orderer });
		const result = await selectAccountsForRequest(
			makeAffinityMeta("conv-owner-preferred"),
			secondCtx,
		);
		expect(result.map((account) => account.id)).toEqual(["xai-a", "xai-b"]);
	});

	it("does not let a failed presumptive leader steal ownership from the candidate that served", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const firstCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const firstMeta = makeAffinityMeta("conv-no-false-pin");
		const firstSelection = await selectAccountsForRequest(firstMeta, firstCtx);
		expect(firstSelection.map((account) => account.id)).toEqual([
			"xai-a",
			"xai-b",
		]);

		// xai-a failed; xai-b produced the accepted response.
		recordServed(firstCtx, firstMeta, xaiB);

		const secondCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const result = await selectAccountsForRequest(
			makeAffinityMeta("conv-no-false-pin"),
			secondCtx,
		);
		expect(result.map((account) => account.id)).toEqual(["xai-b", "xai-a"]);
	});

	it("does not transfer an absent equal-tier owner until the fallback succeeds", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const seedCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const seedMeta = makeAffinityMeta("conv-transfer");
		await selectAccountsForRequest(seedMeta, seedCtx);
		recordServed(seedCtx, seedMeta, xaiA);

		const fallbackCtx = makeCtx({ accounts: [xaiB], orderer });
		const fallbackMeta = makeAffinityMeta("conv-transfer");
		expect(
			(await selectAccountsForRequest(fallbackMeta, fallbackCtx)).map(
				(account) => account.id,
			),
		).toEqual(["xai-b"]);

		// Selection cleared the stale equal-tier owner but did not assign xai-b.
		const beforeSuccessCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		expect(
			(
				await selectAccountsForRequest(
					makeAffinityMeta("conv-transfer"),
					beforeSuccessCtx,
				)
			).map((account) => account.id),
		).toEqual(["xai-a", "xai-b"]);

		recordServed(fallbackCtx, fallbackMeta, xaiB);
		const afterSuccessCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		expect(
			(
				await selectAccountsForRequest(
					makeAffinityMeta("conv-transfer"),
					afterSuccessCtx,
				)
			).map((account) => account.id),
		).toEqual(["xai-b", "xai-a"]);
	});

	it("expires confirmed ownership and preserves conversation isolation", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(100);
		const realDateNow = Date.now;
		const startedAt = realDateNow();

		try {
			Date.now = () => startedAt;
			const aCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
			const aMeta = makeAffinityMeta("conv-a");
			await selectAccountsForRequest(aMeta, aCtx);
			recordServed(aCtx, aMeta, xaiA);

			const bCtx = makeCtx({ accounts: [xaiB, xaiA], orderer });
			const bMeta = makeAffinityMeta("conv-b");
			await selectAccountsForRequest(bMeta, bCtx);
			recordServed(bCtx, bMeta, xaiB);

			const aCheck = await selectAccountsForRequest(
				makeAffinityMeta("conv-a"),
				makeCtx({ accounts: [xaiB, xaiA], orderer }),
			);
			expect(aCheck.map((account) => account.id)).toEqual(["xai-a", "xai-b"]);

			Date.now = () => startedAt + 101;
			const expired = await selectAccountsForRequest(
				makeAffinityMeta("conv-a"),
				makeCtx({ accounts: [xaiB, xaiA], orderer }),
			);
			expect(expired.map((account) => account.id)).toEqual(["xai-b", "xai-a"]);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("reorders only eligible official-xAI positions in a mixed pool", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const anthropic = makeAccount({ id: "anthropic-1", provider: "anthropic" });
		const customXai = makeAccount({
			id: "xai-custom",
			custom_endpoint: "https://my-proxy.example.com/v1",
		});
		const orderer = new CacheAffinityOrderer(60_000);
		const seedCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const seedMeta = makeAffinityMeta("conv-mixed");
		await selectAccountsForRequest(seedMeta, seedCtx);
		recordServed(seedCtx, seedMeta, xaiB);

		const result = await selectAccountsForRequest(
			makeAffinityMeta("conv-mixed"),
			makeCtx({ accounts: [anthropic, xaiA, customXai, xaiB], orderer }),
		);
		expect(result.map((account) => account.id)).toEqual([
			"anthropic-1",
			"xai-b",
			"xai-custom",
			"xai-a",
		]);
	});

	it("does not affect an exact forced-account route", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const orderer = new CacheAffinityOrderer(60_000);
		const seedCtx = makeCtx({ accounts: [xaiA, xaiB], orderer });
		const seedMeta = makeAffinityMeta("conv-forced");
		await selectAccountsForRequest(seedMeta, seedCtx);
		recordServed(seedCtx, seedMeta, xaiA);

		const forcedMeta = makeAffinityMeta("conv-forced", {
			headers: new Headers({ "x-better-ccflare-account-id": "xai-b" }),
		});
		const result = await selectAccountsForRequest(
			forcedMeta,
			makeCtx({ accounts: [xaiA, xaiB], orderer }),
		);
		expect(result).toEqual([xaiB]);
		expect(forcedMeta.xaiCacheEligibleAccountIds).toEqual(new Set([xaiB.id]));
	});

	it("retains exact repeated-account combo-slot identity", async () => {
		const repeated = makeAccount({ id: "xai-repeated" });
		const combo = makeCombo([
			{
				id: "slot-opus",
				combo_id: "combo-1",
				account_id: repeated.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-fable",
				combo_id: "combo-1",
				account_id: repeated.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const orderer = new CacheAffinityOrderer(60_000);
		const firstCtx = makeCtx({
			accounts: [repeated],
			activeCombo: combo,
			orderer,
		});
		const firstMeta = makeAffinityMeta("conv-slots");
		await selectAccountsForRequest(firstMeta, firstCtx, "claude-opus-4-8");
		const fableCandidate = firstMeta.routingCandidates?.find(
			(entry) => entry.comboSlotId === "slot-fable",
		);
		if (!fableCandidate) throw new Error("expected Fable combo candidate");
		recordServed(firstCtx, firstMeta, repeated, fableCandidate.candidateId);

		const reversed = makeCombo([combo.slots[0], combo.slots[1]]);
		const secondCtx = makeCtx({
			accounts: [repeated],
			activeCombo: reversed,
			orderer,
		});
		const secondMeta = makeAffinityMeta("conv-slots");
		await selectAccountsForRequest(secondMeta, secondCtx, "claude-opus-4-8");

		expect(
			secondMeta.routingCandidates?.map((entry) => entry.comboSlotId),
		).toEqual(["slot-fable", "slot-opus"]);
	});
});
