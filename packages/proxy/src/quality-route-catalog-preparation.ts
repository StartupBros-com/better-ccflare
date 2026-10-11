import { isAccountAvailable } from "@better-ccflare/core";
import type { QualityConversation } from "@better-ccflare/database";
import type {
	Account,
	QualityProvider,
	QualityRequestIntent,
	QualityRoutingPolicy,
} from "@better-ccflare/types";
import {
	type CodexCatalogAcquisitionScope,
	ensureCodexModelDefaults,
	getCodexAutoCatalogEvidence,
	getPendingCodexCatalogAcquisition,
	isCodexCatalogRefreshEligible,
	validateCodexAutoCatalogCredentials,
} from "./codex-model-catalog";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";
import {
	fetchLiveModels,
	getNativeAutoCatalogEvidence,
	getPendingNativeCatalogAcquisition,
	NativeCatalogObsoleteGenerationError,
	validateNativeAutoCatalogCredentials,
} from "./model-catalog";

/**
 * The single request-eligibility rule for Auto catalog preparation: the queue
 * snapshot filter, the ownership shortcut and every discovery fetch share it, so
 * an account that stops being eligible while queued receives no metadata traffic.
 */
export function isQualityCatalogRequestEligible(account: Account): boolean {
	return (
		account.provider === "anthropic" &&
		isAccountAvailable(account) &&
		!account.requires_reauth &&
		!account.custom_endpoint
	);
}

/**
 * The Codex counterpart: the heartbeat's own refresh predicate (provider, pause,
 * reauth, custom endpoint) plus availability, which the compiler labels
 * account-unavailable without consulting evidence, so no renewal is owed there.
 */
function isCodexCatalogRequestEligible(account: Account): boolean {
	return isCodexCatalogRefreshEligible(account) && isAccountAvailable(account);
}

/**
 * One provider's share of the queue: which enrollments and lines it covers and
 * the request-eligibility rule its accounts must pass to be queued at all.
 */
interface QualityCatalogSource {
	provider: QualityProvider;
	linePrefix: string;
	eligible: (account: Account) => boolean;
}
const NATIVE_CATALOG_SOURCE: QualityCatalogSource = {
	provider: "anthropic",
	linePrefix: "claude-",
	eligible: isQualityCatalogRequestEligible,
};
const CODEX_CATALOG_SOURCE: QualityCatalogSource = {
	provider: "codex",
	linePrefix: "gpt-",
	eligible: isCodexCatalogRequestEligible,
};

interface QualityCatalogQueueItem {
	accountId: string;
	provider: QualityProvider;
}

/**
 * Accounts to prepare, in the order the compiler will consider them: a valid
 * persisted home first (owned evidence is process-local and two stalled
 * higher-priority lookups must not starve it; mirrors the home conditions in
 * compileQualityCandidates), then lane, line, enrollment/account priority, ID.
 * Lines of a provider outside `sources` are skipped, so one call can queue
 * either provider alone or both in a single compile-order traversal.
 */
function queueQualityCatalogAccounts(
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	conversation: QualityConversation | null | undefined,
	sources: readonly QualityCatalogSource[],
): QualityCatalogQueueItem[] {
	const lanes =
		intent.kind === "main"
			? policy.mainLadders[intent.preference]
			: policy.workerLanes[intent.role];
	const seen = new Set<string>();
	const queue: QualityCatalogQueueItem[] = [];
	const home = conversation?.home;
	if (home && home.intentRevision === conversation?.revision) {
		const homeSource = sources.find((s) => s.provider === home.target.provider);
		const homeAccount = accounts.find(
			(a) =>
				a.id === home.target.accountId && a.provider === home.target.provider,
		);
		if (
			homeSource &&
			homeAccount &&
			homeSource.eligible(homeAccount) &&
			lanes.includes(home.target.lane) &&
			policy.lanes[home.target.lane].includes(home.target.line) &&
			policy.accounts.some(
				(a) =>
					a.accountId === homeAccount.id &&
					a.provider === homeAccount.provider &&
					a.lines.includes(home.target.line),
			)
		) {
			seen.add(homeAccount.id);
			queue.push({ accountId: homeAccount.id, provider: homeSource.provider });
		}
	}
	for (const lane of lanes) {
		for (const line of policy.lanes[lane]) {
			const source = sources.find((s) => line.startsWith(s.linePrefix));
			if (
				!source ||
				!policy.assignments.some((a) => a.line === line && a.lane === lane)
			)
				continue;
			const enrolled = policy.accounts
				.filter((e) => e.provider === source.provider && e.lines.includes(line))
				.flatMap((enrollment) => {
					const account = accounts.find(
						(a) =>
							a.id === enrollment.accountId &&
							a.provider === enrollment.provider,
					);
					return account && source.eligible(account)
						? [{ account, enrollment }]
						: [];
				})
				.sort(
					(a, b) =>
						a.enrollment.priority - b.enrollment.priority ||
						a.account.priority - b.account.priority ||
						a.account.id.localeCompare(b.account.id),
				);
			for (const { account } of enrolled) {
				if (!seen.has(account.id)) {
					seen.add(account.id);
					queue.push({ accountId: account.id, provider: source.provider });
				}
			}
		}
	}
	return queue;
}

/**
 * Runs `prepare` over the queue with two workers under one ten-second budget
 * that includes time spent in the queue, stopping on caller abort or a policy
 * change. The queue is built only once the request is known to be live, inside
 * the budget. Each account is raced against cancellation so uncancellable
 * awaits (account rows, tokens, a fetch that ignores its signal) cannot hold
 * the request; `prepare` never surfaces an error.
 */
async function runQualityCatalogPreparation(
	ctx: ProxyContext,
	policy: QualityRoutingPolicy,
	signal: AbortSignal,
	queue: () => readonly QualityCatalogQueueItem[],
	prepare: (
		item: QualityCatalogQueueItem,
		stopped: () => boolean,
		signal: AbortSignal,
	) => Promise<void>,
): Promise<void> {
	const policyCurrent = () =>
		ctx.config.getQualityRoutingPolicy?.()?.revision === policy.revision;
	if (signal.aborted || !policyCurrent()) return;

	const controller = new AbortController();
	const cancel = () => controller.abort();
	signal.addEventListener("abort", cancel, { once: true });
	// One budget for the entire preparation, including time spent in the queue.
	const deadline = Date.now() + 10_000;
	const timer = setTimeout(cancel, 10_000);
	const cancelled = new Promise<void>((resolve) => {
		controller.signal.addEventListener("abort", () => resolve(), {
			once: true,
		});
	});
	const stopped = () => {
		if (Date.now() >= deadline) cancel();
		return controller.signal.aborted || !policyCurrent();
	};
	try {
		const items = queue();
		let next = 0;
		const worker = async () => {
			while (next < items.length && !stopped()) {
				const item = items[next++];
				// Bound account/token preparation too, including uncancellable awaits.
				await Promise.race([
					prepare(item, stopped, controller.signal).catch(() => {}),
					cancelled,
				]);
			}
		};
		await Promise.all([worker(), worker()]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

/**
 * Native discovery for one queued account. Existing evidence is checked against
 * OUR resolved credential before any wait: freshness alone says nothing about
 * ownership, and an unrelated stuck lookup must not delay an account whose
 * evidence we already own.
 */
async function prepareNativeAccount(
	ctx: ProxyContext,
	accountId: string,
	stopped: () => boolean,
	signal: AbortSignal,
	allowOAuth: boolean,
): Promise<void> {
	const ownsEvidence = async (): Promise<boolean> => {
		const evidence = getNativeAutoCatalogEvidence(accountId);
		if (!evidence) return false;
		// Do not resolve (potentially refresh) OAuth tokens without permission.
		if (!allowOAuth) return true;
		const account = await ctx.dbOps.getAccount(accountId);
		if (
			stopped() ||
			!account ||
			account.id !== accountId ||
			!isQualityCatalogRequestEligible(account)
		)
			return true;
		const accessToken = await getValidAccessToken(account, ctx);
		if (stopped()) return true;
		return validateNativeAutoCatalogCredentials(evidence, {
			account,
			accessToken,
		});
	};
	// A pending acquisition is a wait signal only: another request's evidence is
	// never our authority; we recheck ownership against OUR resolved credential.
	const prepareOnce = async () => {
		if (await ownsEvidence()) return;
		const pending = getPendingNativeCatalogAcquisition(accountId);
		if (pending) {
			await pending;
			if (stopped()) return;
			if (await ownsEvidence()) return;
		}
		if (stopped()) return;
		// Discovery reloads the account and retains its generation/ownership fences.
		await fetchLiveModels(ctx, {
			accountId,
			allowOAuth,
			signal,
			accountEligible: isQualityCatalogRequestEligible,
		});
	};
	// A newer lookup for the same account superseded ours: wait for it and
	// recheck ownership instead of giving up. Bounded; other errors are final.
	for (let attempt = 0; attempt < 3 && !stopped(); attempt++) {
		try {
			await prepareOnce();
			return;
		} catch (error) {
			if (!(error instanceof NativeCatalogObsoleteGenerationError)) return;
		}
	}
}

/**
 * Codex renewal for one queued account. Owned Codex evidence expires one
 * refresh interval after acquisition while the heartbeat renews it only a full
 * interval (plus jitter) after its last cycle, so an accepted Auto request can
 * meet an owned-but-expired catalog that the compiler would reject as stale.
 * Renewal goes through the account's own ensure path, keeping its single-flight,
 * retry backoff, deletion-generation and credential-fingerprint fences; this
 * helper never reads a listing itself, never extends expiry, and never promotes
 * shared evidence. A failed or 401 renewal preserves the old expiry for
 * compilation to report only while the credential epoch is unchanged: a changed
 * fingerprint legitimately retires the old evidence before the GET (ensure's
 * fingerprint fence), and nothing here restores, borrows or promotes evidence
 * another credential or account owns. Only an authenticated, accepted Auto
 * request may call this: resolving the account's OAuth token is the one
 * permission it exercises.
 */
async function prepareCodexAccount(
	ctx: ProxyContext,
	accountId: string,
	stopped: () => boolean,
): Promise<void> {
	// The live row is reloaded at every step: deletion, a pause or a reauth
	// flag set while queued ends preparation without metadata traffic.
	const eligibleAccount = async (): Promise<Account | null> => {
		const account = await ctx.dbOps.getAccount(accountId);
		return !stopped() &&
			account &&
			account.id === accountId &&
			isCodexCatalogRequestEligible(account)
			? account
			: null;
	};
	// null: no current evidence (missing or expired). Otherwise whether the
	// current evidence is owned by OUR resolved credential; an ineligible or
	// stopped lookup counts as owned so no renewal is started for it.
	const ownership = async (): Promise<boolean | null> => {
		const evidence = getCodexAutoCatalogEvidence(accountId);
		if (!evidence) return null;
		const account = await eligibleAccount();
		if (!account) return true;
		const accessToken = await getValidAccessToken(account, ctx);
		if (stopped()) return true;
		return validateCodexAutoCatalogCredentials(evidence, {
			account,
			accessToken,
		});
	};
	// Ensure's own reload and token resolution are awaits this request cannot
	// see; the scope lets ensure apply the request's stop signal and the queue's
	// eligibility rule to the row it reloads itself, before any GET. A stopped or
	// ineligible lookup is reported as not attempted and records no failure.
	const scope: CodexCatalogAcquisitionScope = {
		stopped,
		accountEligible: isCodexCatalogRequestEligible,
	};
	// Two bounded rounds: an acquisition another caller starts while this
	// request's own eligibility reload is in flight is a wait signal like any
	// other, so the second round waits on it and rechecks ownership instead of
	// starting a duplicate. A second such arrival is left to ensure's single
	// flight; no waiter registry or refcount is kept.
	for (let round = 0; round < 2; round++) {
		let owned = await ownership();
		if (owned === true) return;
		// A pending acquisition is a wait signal only: its outcome is rechecked
		// against OUR resolved credential, never trusted.
		const pending = getPendingCodexCatalogAcquisition(accountId);
		if (pending) {
			await pending;
			if (stopped()) return;
			owned = await ownership();
			if (owned === true) return;
		}
		const account = await eligibleAccount();
		// Rechecked in the same turn as the call, like native discovery.
		if (!account || stopped()) return;
		if (round === 0 && getPendingCodexCatalogAcquisition(accountId)) continue;
		// Missing or expired evidence takes the ordinary ensure path, which its
		// retry backoff bounds. Current evidence that another credential epoch
		// owns is reacquired under ours, exactly as native preparation refetches
		// unowned evidence; ensure's fingerprint fence retires the old listing.
		await ensureCodexModelDefaults(
			account,
			ctx,
			Date.now,
			owned === false,
			scope,
		);
		// Warm callers return before the refresh finishes; the request waits.
		await getPendingCodexCatalogAcquisition(accountId);
		return;
	}
}

/**
 * One preparation over the given sources: a single compile-order queue, two
 * workers and one queue-inclusive budget, dispatching each account to its
 * provider's helper. OAuth permission applies to native discovery only; Codex
 * renewal resolves the account's token as its ensure path always has.
 */
async function prepareQualityCatalogSources(
	ctx: ProxyContext,
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	options: {
		signal: AbortSignal;
		allowOAuth?: boolean;
		conversation?: QualityConversation | null;
	},
	sources: readonly QualityCatalogSource[],
): Promise<void> {
	await runQualityCatalogPreparation(
		ctx,
		policy,
		options.signal,
		() =>
			queueQualityCatalogAccounts(
				policy,
				intent,
				accounts,
				options.conversation,
				sources,
			),
		(item, stopped, signal) =>
			item.provider === "codex"
				? prepareCodexAccount(ctx, item.accountId, stopped)
				: prepareNativeAccount(
						ctx,
						item.accountId,
						stopped,
						signal,
						options.allowOAuth ?? false,
					),
	);
}

/**
 * Best-effort preparation, not permission or dispatch authority. The caller owns
 * permission to invoke discovery and must recheck abort and policy after awaiting
 * this helper, before compiling/admitting a request. OAuth remains denied unless
 * the caller explicitly opts in; enrollment itself never grants that permission.
 *
 * Deduplication is request-local. A global promise cache would conflate contexts,
 * credential epochs and callers' cancellation/permission. Discovery retains its
 * existing fresh-account, generation and ownership fences; this helper never
 * manufactures evidence or serializes ownership. Failure/timeout leaves normal
 * compilation to report its existing bounded evidence reasons.
 */
export async function prepareNativeQualityCatalogs(
	ctx: ProxyContext,
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	options: {
		signal: AbortSignal;
		allowOAuth?: boolean;
		conversation?: QualityConversation | null;
	},
): Promise<void> {
	await prepareQualityCatalogSources(ctx, policy, intent, accounts, options, [
		NATIVE_CATALOG_SOURCE,
	]);
}

/**
 * The Codex counterpart of prepareNativeQualityCatalogs, with the same budget,
 * ordering and best-effort contract; see prepareCodexAccount for the renewal
 * rules and their fences.
 */
export async function prepareCodexQualityCatalogs(
	ctx: ProxyContext,
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	options: {
		signal: AbortSignal;
		conversation?: QualityConversation | null;
	},
): Promise<void> {
	await prepareQualityCatalogSources(ctx, policy, intent, accounts, options, [
		CODEX_CATALOG_SOURCE,
	]);
}

/**
 * Both providers in one preparation for an accepted Auto request: one queue in
 * compile order across native and Codex lines, one two-worker runner and one
 * ten-second budget covering queued work for either provider, so a stalled
 * lookup on one provider neither holds the other's accounts past the budget
 * nor earns them a budget of their own. Each provider keeps its own helper's
 * contract and fences unchanged.
 */
export async function prepareQualityCatalogs(
	ctx: ProxyContext,
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	options: {
		signal: AbortSignal;
		allowOAuth?: boolean;
		conversation?: QualityConversation | null;
	},
): Promise<void> {
	await prepareQualityCatalogSources(ctx, policy, intent, accounts, options, [
		NATIVE_CATALOG_SOURCE,
		CODEX_CATALOG_SOURCE,
	]);
}
