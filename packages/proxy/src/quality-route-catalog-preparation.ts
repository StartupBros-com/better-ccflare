import { isAccountAvailable } from "@better-ccflare/core";
import type { QualityConversation } from "@better-ccflare/database";
import type {
	Account,
	QualityProvider,
	QualityRequestIntent,
	QualityRoutingPolicy,
} from "@better-ccflare/types";
import {
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
 * Account IDs to prepare, in the order the compiler will consider them: a valid
 * persisted home first (owned evidence is process-local and two stalled
 * higher-priority lookups must not starve it; mirrors the home conditions in
 * compileQualityCandidates), then lane, line, enrollment/account priority, ID.
 */
function queueQualityCatalogAccounts(
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	conversation: QualityConversation | null | undefined,
	source: {
		provider: QualityProvider;
		linePrefix: string;
		eligible: (account: Account) => boolean;
	},
): string[] {
	const lanes =
		intent.kind === "main"
			? policy.mainLadders[intent.preference]
			: policy.workerLanes[intent.role];
	const seen = new Set<string>();
	const queue: string[] = [];
	const home = conversation?.home;
	if (home && home.intentRevision === conversation?.revision) {
		const homeAccount = accounts.find(
			(a) =>
				a.id === home.target.accountId && a.provider === home.target.provider,
		);
		if (
			homeAccount &&
			source.eligible(homeAccount) &&
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
			queue.push(homeAccount.id);
		}
	}
	for (const lane of lanes) {
		for (const line of policy.lanes[lane]) {
			if (
				!line.startsWith(source.linePrefix) ||
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
					queue.push(account.id);
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
	queue: () => readonly string[],
	prepare: (
		accountId: string,
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
		const accountIds = queue();
		let next = 0;
		const worker = async () => {
			while (next < accountIds.length && !stopped()) {
				const accountId = accountIds[next++];
				// Bound account/token preparation too, including uncancellable awaits.
				await Promise.race([
					prepare(accountId, stopped, controller.signal).catch(() => {}),
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
				{
					provider: "anthropic",
					linePrefix: "claude-",
					eligible: isQualityCatalogRequestEligible,
				},
			),
		async (accountId, stopped, signal) => {
			// Existing evidence is checked against OUR resolved credential before any
			// wait: freshness alone says nothing about ownership, and an unrelated stuck
			// lookup must not delay an account whose evidence we already own.
			const ownsEvidence = async (): Promise<boolean> => {
				const evidence = getNativeAutoCatalogEvidence(accountId);
				if (!evidence) return false;
				// Do not resolve (potentially refresh) OAuth tokens without permission.
				if (!options.allowOAuth) return true;
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
					allowOAuth: options.allowOAuth ?? false,
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
		},
	);
}

/**
 * The Codex counterpart of prepareNativeQualityCatalogs, with the same budget,
 * ordering and best-effort contract. Owned Codex evidence expires one refresh
 * interval after acquisition while the heartbeat renews it only a full interval
 * (plus jitter) after its last cycle, so an accepted Auto request can meet an
 * owned-but-expired catalog that the compiler would reject as stale. Renewal
 * goes through the account's own ensure path, keeping its single-flight,
 * retry backoff, deletion-generation and credential-fingerprint fences; this
 * helper never reads a listing itself, never extends expiry, and never promotes
 * shared evidence. A failed renewal leaves the old expiry for compilation to
 * report. Only an authenticated, accepted Auto request may call this: resolving
 * the account's OAuth token is the one permission it exercises.
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
				{
					provider: "codex",
					linePrefix: "gpt-",
					eligible: isCodexCatalogRequestEligible,
				},
			),
		async (accountId, stopped) => {
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
			// Missing or expired evidence takes the ordinary ensure path, which its
			// retry backoff bounds. Current evidence that another credential epoch
			// owns is reacquired under ours, exactly as native preparation refetches
			// unowned evidence; ensure's fingerprint fence retires the old listing.
			await ensureCodexModelDefaults(account, ctx, Date.now, owned === false);
			// Warm callers return before the refresh finishes; the request waits.
			await getPendingCodexCatalogAcquisition(accountId);
		},
	);
}
