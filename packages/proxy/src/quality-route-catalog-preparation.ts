import { isAccountAvailable } from "@better-ccflare/core";
import type {
	Account,
	QualityRequestIntent,
	QualityRoutingPolicy,
} from "@better-ccflare/types";
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
	options: { signal: AbortSignal; allowOAuth?: boolean },
): Promise<void> {
	const policyCurrent = () =>
		ctx.config.getQualityRoutingPolicy?.()?.revision === policy.revision;
	if (options.signal.aborted || !policyCurrent()) return;

	const controller = new AbortController();
	const cancel = () => controller.abort();
	options.signal.addEventListener("abort", cancel, { once: true });
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
		const lanes =
			intent.kind === "main"
				? policy.mainLadders[intent.preference]
				: policy.workerLanes[intent.role];
		const seen = new Set<string>();
		const queue: string[] = [];
		// Match compiler ordering: lane, line, enrollment/account priority, ID.
		for (const lane of lanes) {
			for (const line of policy.lanes[lane]) {
				if (
					!line.startsWith("claude-") ||
					!policy.assignments.some((a) => a.line === line && a.lane === lane)
				)
					continue;
				const enrolled = policy.accounts
					.filter((e) => e.provider === "anthropic" && e.lines.includes(line))
					.flatMap((enrollment) => {
						const account = accounts.find(
							(a) =>
								a.id === enrollment.accountId &&
								a.provider === enrollment.provider,
						);
						return account && isQualityCatalogRequestEligible(account)
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
		// A pending acquisition is a wait signal only: another request's evidence is
		// never our authority; we recheck ownership against OUR resolved credential.
		const prepareOnce = async (accountId: string) => {
			const pending = getPendingNativeCatalogAcquisition(accountId);
			if (pending) {
				await pending;
				if (stopped()) return;
			}
			const evidence = getNativeAutoCatalogEvidence(accountId);
			if (evidence) {
				// Freshness alone says nothing about credential/incarnation ownership.
				// Do not resolve (potentially refresh) OAuth tokens without permission.
				if (!options.allowOAuth) return;
				const account = await ctx.dbOps.getAccount(accountId);
				if (
					stopped() ||
					!account ||
					account.id !== accountId ||
					!isQualityCatalogRequestEligible(account)
				)
					return;
				const accessToken = await getValidAccessToken(account, ctx);
				if (stopped()) return;
				if (
					validateNativeAutoCatalogCredentials(evidence, {
						account,
						accessToken,
					})
				)
					return;
			}
			if (stopped()) return;
			// Discovery reloads the account and retains its generation/ownership fences.
			await fetchLiveModels(ctx, {
				accountId,
				allowOAuth: options.allowOAuth ?? false,
				signal: controller.signal,
				accountEligible: isQualityCatalogRequestEligible,
			});
		};
		// A newer lookup for the same account superseded ours: wait for it and
		// recheck ownership instead of giving up. Bounded; other errors are final.
		const prepare = async (accountId: string) => {
			for (let attempt = 0; attempt < 3 && !stopped(); attempt++) {
				try {
					await prepareOnce(accountId);
					return;
				} catch (error) {
					if (!(error instanceof NativeCatalogObsoleteGenerationError)) return;
				}
			}
		};
		let next = 0;
		const worker = async () => {
			while (next < queue.length && !stopped()) {
				const accountId = queue[next++];
				// Bound account/token preparation too, including uncancellable awaits.
				await Promise.race([prepare(accountId).catch(() => {}), cancelled]);
			}
		};
		await Promise.all([worker(), worker()]);
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", cancel);
	}
}
