import {
	getConfiguredModelMapping,
	getModelFamily,
	getModelMappings,
	KNOWN_PATTERNS,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	ensureCodexModelDefaults,
	getKnownCodexModels,
} from "./codex-model-catalog";
import type { ProxyContext } from "./handlers/proxy-types";

const STOCK_CLAUDE_FAMILY_ALIASES = new Set<string>(KNOWN_PATTERNS);

export interface ImplicitCodexRouteOptions {
	ctx?: ProxyContext;
	/** Absolute account-selection deadline, in epoch milliseconds. */
	deadlineAt?: number;
	/** Selector rechecks use false; only request-time resolution may prime. */
	prime?: boolean;
	signal?: AbortSignal;
}

function selectionExpired(options: ImplicitCodexRouteOptions): boolean {
	return (
		options.signal?.aborted === true ||
		(options.deadlineAt !== undefined &&
			(!Number.isFinite(options.deadlineAt) ||
				Date.now() >= options.deadlineAt))
	);
}

/** Bound this request's wait while preserving the catalog's shared ensure. */
async function primeBeforeDeadline(
	account: Account,
	ctx: ProxyContext,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const finish = (completed: boolean) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		const onAbort = () => finish(false);
		const timeout = setTimeout(
			() => finish(false),
			Math.max(0, deadlineAt - Date.now()),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted || Date.now() >= deadlineAt) {
			finish(false);
			return;
		}
		void ensureCodexModelDefaults(account, ctx).then(
			() => finish(true),
			() => finish(false),
		);
	});
}

/** Read only the adapter's physical-model carrier, never the translated model. */
export function getCodexPassthroughPhysicalModel(
	parsedBody: unknown,
): string | null {
	if (
		!parsedBody ||
		typeof parsedBody !== "object" ||
		Array.isArray(parsedBody)
	) {
		return null;
	}
	const passthrough = (parsedBody as Record<string, unknown>)
		.__better_ccflare_codex_passthrough;
	if (
		!passthrough ||
		typeof passthrough !== "object" ||
		Array.isArray(passthrough)
	) {
		return null;
	}
	const model = (passthrough as Record<string, unknown>).model;
	if (typeof model !== "string") return null;
	const id = model.trim();
	return id &&
		getModelFamily(id) === null &&
		!STOCK_CLAUDE_FAMILY_ALIASES.has(id.toLowerCase())
		? id
		: null;
}

/** Account-local capability proof; provider-wide derived defaults are advisory. */
export async function accountServesPhysicalModel(
	account: Account,
	id: string,
	options: ImplicitCodexRouteOptions = {},
): Promise<boolean> {
	if (account.provider !== "codex" || selectionExpired(options)) return false;
	const known = getKnownCodexModels(account.id);
	if (known) return known.models.some((model) => model.id === id);

	// Include exact Claude-id keys as well as bare families. These reads expose
	// only static configuration and never consult provider-derived defaults.
	const logicalModels = new Set<string>([
		...KNOWN_PATTERNS,
		...Object.keys(getModelMappings(account)).filter(
			(model) => getModelFamily(model) !== null,
		),
	]);
	for (const logicalModel of logicalModels) {
		const configured = getConfiguredModelMapping(logicalModel, account);
		if (configured?.models.some((candidate) => candidate.trim() === id)) {
			return true;
		}
	}
	if (
		options.prime === false ||
		!options.ctx ||
		options.deadlineAt === undefined
	) {
		return false;
	}
	const completed = await primeBeforeDeadline(
		account,
		options.ctx,
		options.deadlineAt,
		options.signal,
	);
	if (!completed || selectionExpired(options)) return false;
	return (
		getKnownCodexModels(account.id)?.models.some((model) => model.id === id) ??
		false
	);
}

/** Resolve request-time capability without registering a profile or session. */
export async function resolveImplicitCodexRoute(
	parsedBody: unknown,
	accounts: readonly Account[],
	options: ImplicitCodexRouteOptions = {},
): Promise<{ id: string; matchingAccounts: Account[] } | null> {
	const id = getCodexPassthroughPhysicalModel(parsedBody);
	if (!id) return null;
	const serves = await Promise.all(
		accounts.map((account) => accountServesPhysicalModel(account, id, options)),
	);
	if (selectionExpired(options)) return null;
	const matchingAccounts = accounts.filter((_account, index) => serves[index]);
	return matchingAccounts.length > 0 ? { id, matchingAccounts } : null;
}
