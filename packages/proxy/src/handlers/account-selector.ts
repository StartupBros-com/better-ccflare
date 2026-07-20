import {
	getModelFamily,
	isAccountAvailable,
	isOfficialXaiEndpoint,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	canonicalizeBetaSignature,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	AccountQuotaPressure,
	ComboFamily,
	ComboSlotInfo,
	RequestMeta,
	RoutingCandidateMetadata,
} from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";
import {
	evaluateHardCapacity,
	getWeeklyQuotaPressure,
	type HardCapacityExclusion,
} from "./usage-throttling";

const log = new Logger("AccountSelector");

const PRESSURE_RANK = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
} as const;

/** Higher comparable pressure is consumed first; incomparable lanes stay stable. */
function compareCandidatePressure(
	a: AccountQuotaPressure | null,
	b: AccountQuotaPressure | null,
): number {
	if (
		!a ||
		!b ||
		a.comparisonKey === null ||
		b.comparisonKey === null ||
		a.comparisonKey !== b.comparisonKey
	) {
		return 0;
	}
	return PRESSURE_RANK[b.band] - PRESSURE_RANK[a.band];
}

function normalCandidateMetadata(
	account: Account,
	ordinal: number,
	model: string | null,
	quotaPressure: AccountQuotaPressure | null = null,
): RoutingCandidateMetadata {
	return {
		candidateId: `account:${account.id}`,
		accountId: account.id,
		tier: account.priority,
		ordinal,
		comboSlotId: null,
		modelOverride: model,
		quotaPressure,
	};
}

/** Thrown when an explicit one-account route cannot use its target. */
export class ForceRouteUnavailableError extends Error {
	readonly accountId: string;
	readonly reason: string;

	constructor(accountId: string, reason: string) {
		super(`Force-routed account unavailable: ${reason}`);
		this.name = "ForceRouteUnavailableError";
		this.accountId = accountId;
		this.reason = reason;
	}
}

// Module-level WeakMap to store combo slot info per RequestMeta
const comboSlotInfoMap = new WeakMap<RequestMeta, ComboSlotInfo>();

export interface RoutingCapacityBlocker {
	readonly source: "usage_snapshot" | "reactive_marker";
	readonly scope: "account" | "family" | "model";
	readonly window: string;
	readonly windowKind:
		| "session"
		| "weekly_all"
		| "weekly_scoped"
		| "reactive_model"
		| "reactive_family";
	readonly modelFamily: string | null;
	readonly utilization: number | null;
	readonly resetAtMs: number | null;
	readonly evidenceExpiresAt: number;
}

export interface RoutingCapacityCandidateExclusion {
	readonly accountId: string;
	readonly accountName: string;
	readonly model: string;
	readonly modelFamily: string | null;
	readonly source: "normal" | "force" | "combo";
	readonly comboSlotId: string | null;
	readonly comboSlotOrdinal: number | null;
	/** This candidate can be reconsidered only after all simultaneous blockers clear. */
	readonly blockedUntil: number | null;
	readonly exclusions: readonly RoutingCapacityBlocker[];
}

export interface RoutingCapacityContext {
	readonly effectiveModel: string | null;
	readonly effectiveModelFamily: string | null;
	readonly exclusions: readonly RoutingCapacityCandidateExclusion[];
	/** Earliest known recovery among capacity-excluded candidates. */
	readonly blockedUntil: number | null;
}

export interface AccountSelectionOptions {
	/** Bypass active combo lookup for the explicit post-combo normal fallback. */
	readonly skipCombo?: boolean;
}

/** Request-local capacity evidence retained for terminal classification. */
const routingCapacityContextMap = new WeakMap<
	RequestMeta,
	RoutingCapacityContext
>();

/** Retrieve request-local hard-capacity evidence (null before selection). */
export function getRoutingCapacityContext(
	meta: RequestMeta,
): RoutingCapacityContext | null {
	return routingCapacityContextMap.get(meta) ?? null;
}

/** Store combo slot info on a RequestMeta for downstream consumption */
export function setComboSlotInfo(meta: RequestMeta, info: ComboSlotInfo): void {
	comboSlotInfoMap.set(meta, info);
}

/** Retrieve combo slot info from a RequestMeta (null if not combo-routed) */
export function getComboSlotInfo(meta: RequestMeta): ComboSlotInfo | null {
	return comboSlotInfoMap.get(meta) ?? null;
}

/**
 * Resolves the model that should drive account routing: the agent
 * interceptor's applied (post-rewrite) model when it modified the request,
 * falling back to the original client-requested model otherwise. Routing
 * must see the model that will actually be sent upstream — combo routing
 * and family-based selection would otherwise match against a model the
 * outgoing request no longer carries.
 */
export function resolveEffectiveModel(
	appliedModel: string | null | undefined,
	requestModel: string | null | undefined,
): string | null {
	return appliedModel ?? requestModel ?? null;
}

function normalizePath(path: string): string {
	const withoutQuery = path.split("?", 1)[0]?.trim().toLowerCase() ?? "";
	if (!withoutQuery) return "/";
	return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function getProtocolFamily(path: string): string {
	if (path.endsWith("/responses")) return "responses";
	if (path.endsWith("/messages")) return "messages";
	if (path.endsWith("/chat/completions")) return "chat-completions";
	return "other";
}

/**
 * Construct the pre-selection owner lane. The client-visible beta signature is
 * canonicalized before inclusion so header ordering cannot split ownership.
 */
export function deriveAffinityLaneKey(
	meta: RequestMeta,
	effectiveModel: string | null,
): string | null {
	const session = meta.clientSessionId?.trim();
	const model = effectiveModel?.trim().toLowerCase();
	if (!session || !model) return null;
	const path = normalizePath(meta.path);
	const family = getModelFamily(model) ?? "unknown";
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	return JSON.stringify([
		"routing-lane-v1",
		session,
		getProtocolFamily(path),
		path,
		family,
		model,
		beta,
	]);
}

function getBillingClass(account: Account): string | null {
	const explicit = account.billing_type?.trim().toLowerCase();
	if (explicit) return explicit;
	// OAuth subscription accounts historically store NULL billing_type. Their
	// credential shape is stable enough to compare accounts from the same
	// provider without treating unknown API-key accounts as subscriptions.
	if (account.refresh_token?.trim() && !account.api_key) {
		return "oauth-subscription";
	}
	return null;
}

function snapshotBlocker(
	exclusion: HardCapacityExclusion,
): RoutingCapacityBlocker {
	return {
		source: "usage_snapshot",
		scope: exclusion.scope,
		window: exclusion.window,
		windowKind: exclusion.windowKind,
		modelFamily: exclusion.modelFamily,
		utilization: exclusion.utilization,
		resetAtMs: exclusion.resetAtMs,
		evidenceExpiresAt: exclusion.evidenceExpiresAt,
	};
}

/**
 * Look up exact model+client-beta direct failure evidence in one place. Family
 * markers can extend this helper without duplicating selector paths.
 */
export function getReactiveModelCapacityBlocker(
	accountId: string,
	model: string,
	betaSignature: string,
	now: number,
): RoutingCapacityBlocker | null {
	const marker = usageCache.getModelScopedExhaustion(
		accountId,
		model,
		betaSignature,
		now,
	);
	if (marker) {
		return {
			source: "reactive_marker",
			scope: "model",
			window: "reactive_model",
			windowKind: "reactive_model",
			modelFamily: getModelFamily(model),
			utilization: null,
			resetAtMs: marker.expiresAt,
			evidenceExpiresAt: marker.expiresAt,
		};
	}

	const familyMarker = usageCache.getFamilyScopedExhaustion(
		accountId,
		model,
		now,
	);
	if (!familyMarker) return null;
	return {
		source: "reactive_marker",
		scope: "family",
		window: "reactive_family",
		windowKind: "reactive_family",
		modelFamily: familyMarker.family,
		utilization: null,
		resetAtMs: familyMarker.expiresAt,
		evidenceExpiresAt: familyMarker.expiresAt,
	};
}

interface CandidateCapacityEvaluation {
	readonly blockers: readonly RoutingCapacityBlocker[];
	readonly blockedUntil: number | null;
	readonly quotaPressure: AccountQuotaPressure | null;
}

function evaluateCandidateCapacity(
	account: Account,
	model: string,
	betaSignature: string,
	now: number,
): CandidateCapacityEvaluation {
	const snapshot = usageCache.getSnapshot(account.id);
	const blockers: RoutingCapacityBlocker[] = [];
	let quotaPressure: AccountQuotaPressure | null = null;

	if (snapshot) {
		const hardCapacity = evaluateHardCapacity(snapshot.data, {
			requestModel: model,
			observedAt: snapshot.observedAt,
			provider: account.provider,
			now,
		});
		blockers.push(...hardCapacity.exclusions.map(snapshotBlocker));

		const pressure = getWeeklyQuotaPressure(snapshot.data, {
			requestModel: model,
			observedAt: snapshot.observedAt,
			provider: account.provider,
			billingClass: getBillingClass(account),
			now,
		});
		if (pressure) {
			const comparator = pressure.comparator;
			const comparisonKey =
				comparator.provider && comparator.billingClass
					? [
							"authoritative-usage-v1",
							comparator.provider,
							comparator.billingClass,
							comparator.windowKind,
							pressure.modelFamily ?? "all",
						].join(":")
					: null;
			quotaPressure = {
				band: pressure.band,
				comparisonKey,
			};
		}
	}

	const reactive = getReactiveModelCapacityBlocker(
		account.id,
		model,
		betaSignature,
		now,
	);
	if (reactive) blockers.push(reactive);

	return {
		blockers,
		blockedUntil:
			blockers.length === 0
				? null
				: Math.max(...blockers.map((blocker) => blocker.evidenceExpiresAt)),
		quotaPressure,
	};
}

function candidateExclusion(
	account: Account,
	model: string,
	evaluation: CandidateCapacityEvaluation,
	source: RoutingCapacityCandidateExclusion["source"],
	comboSlotId: string | null = null,
	comboSlotOrdinal: number | null = null,
): RoutingCapacityCandidateExclusion {
	return {
		accountId: account.id,
		accountName: account.name,
		model,
		modelFamily: getModelFamily(model),
		source,
		comboSlotId,
		comboSlotOrdinal,
		blockedUntil: evaluation.blockedUntil,
		exclusions: evaluation.blockers,
	};
}

function saveCapacityContext(
	meta: RequestMeta,
	effectiveModel: string | null,
	exclusions: readonly RoutingCapacityCandidateExclusion[],
): void {
	const futureRecoveries = exclusions
		.map((entry) => entry.blockedUntil)
		.filter(
			(value): value is number =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value > Date.now(),
		);
	routingCapacityContextMap.set(meta, {
		effectiveModel,
		effectiveModelFamily: effectiveModel
			? getModelFamily(effectiveModel)
			: null,
		exclusions,
		blockedUntil:
			futureRecoveries.length > 0 ? Math.min(...futureRecoveries) : null,
	});
}

function prepareNormalRoutingMetadata(
	meta: RequestMeta,
	accounts: Account[],
	effectiveModel: string | null,
): Account[] {
	meta.affinityLaneKey = deriveAffinityLaneKey(meta, effectiveModel);
	if (!effectiveModel) {
		meta.hardExcludedAccountIds = null;
		meta.quotaPressureByAccountId = null;
		meta.routingCandidateCatalog = accounts.map((account, ordinal) =>
			normalCandidateMetadata(account, ordinal, null),
		);
		meta.routingCandidates = meta.routingCandidateCatalog;
		saveCapacityContext(meta, null, []);
		return accounts;
	}

	const now = Date.now();
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	const excludedIds = new Set<string>();
	const quotaPressure = new Map<string, AccountQuotaPressure>();
	const exclusions: RoutingCapacityCandidateExclusion[] = [];
	for (const account of accounts) {
		const evaluation = evaluateCandidateCapacity(
			account,
			effectiveModel,
			beta,
			now,
		);
		if (evaluation.quotaPressure) {
			quotaPressure.set(account.id, evaluation.quotaPressure);
		}
		if (evaluation.blockers.length > 0) {
			excludedIds.add(account.id);
			exclusions.push(
				candidateExclusion(account, effectiveModel, evaluation, "normal"),
			);
		}
	}
	meta.hardExcludedAccountIds = excludedIds.size > 0 ? excludedIds : null;
	meta.quotaPressureByAccountId = quotaPressure.size > 0 ? quotaPressure : null;
	meta.routingCandidateCatalog = accounts.map((account, ordinal) =>
		normalCandidateMetadata(
			account,
			ordinal,
			effectiveModel,
			quotaPressure.get(account.id) ?? null,
		),
	);
	meta.routingCandidates = meta.routingCandidateCatalog.filter(
		(candidate) => !excludedIds.has(candidate.accountId),
	);
	saveCapacityContext(meta, effectiveModel, exclusions);
	return accounts.filter((account) => !excludedIds.has(account.id));
}

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
function setXaiCacheEligibleAccounts(
	meta: RequestMeta,
	accounts: Account[],
): void {
	if (!meta.xaiCacheNativeActive) return;
	meta.xaiCacheEligibleAccountIds = new Set(
		accounts
			.filter(
				(account) =>
					account.provider === "xai" && isOfficialXaiEndpoint(account),
			)
			.map((account) => account.id),
	);
}

function applyXaiCacheAffinity(
	accounts: Account[],
	meta: RequestMeta,
	ctx: ProxyContext,
): Account[] {
	return ctx.cacheAffinityOrderer?.order(accounts, meta) ?? accounts;
}

export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
	effectiveModel: string | null = null,
): Promise<Account[]> {
	try {
		const allAccounts = await ctx.dbOps.getAllAccounts();
		setXaiCacheEligibleAccounts(meta, allAccounts);
		const eligibleAccounts = prepareNormalRoutingMetadata(
			meta,
			allAccounts,
			effectiveModel,
		);
		const hardExcluded = meta.hardExcludedAccountIds;
		// Return all accounts - the provider will be determined dynamically per account.
		const ordered = (await ctx.strategy.select(eligibleAccounts, meta)).filter(
			(account) => !hardExcluded?.has(account.id),
		);
		const catalog = meta.routingCandidateCatalog ?? [];
		meta.routingCandidates = ordered
			.map((account) =>
				catalog.find((candidate) => candidate.accountId === account.id),
			)
			.filter(
				(candidate): candidate is RoutingCandidateMetadata =>
					candidate !== undefined,
			);
		return applyXaiCacheAffinity(ordered, meta, ctx);
	} catch (error) {
		log.error("Failed to get accounts from database:", error);
		console.error("\n❌ DATABASE ERROR DETECTED");
		console.error("═".repeat(50));
		console.error("The database encountered an error while loading accounts.");
		console.error(
			"This may indicate database corruption or integrity issues.\n",
		);
		console.error("To diagnose and repair the database, run:");
		console.error("  bun run cli --repair-db\n");
		console.error("The request will fall back to unauthenticated mode.");
		console.error(`${"═".repeat(50)}\n`);
		// Return empty array to gracefully handle database errors
		// This will cause the proxy to fall back to unauthenticated mode
		return [];
	}
}

/**
 * Selects accounts for a request based on the load balancing strategy.
 * When an active combo exists for the request's model family, returns
 * combo-ordered accounts filtered by availability. Falls back to normal
 * SessionStrategy when no combo is active or all slots are unavailable.
 *
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - Optional model string for combo family detection
 * @param options - Selection-mode controls for explicit fallback paths
 * @returns Array of selected accounts
 */
export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
	options: AccountSelectionOptions = {},
): Promise<Account[]> {
	comboSlotInfoMap.delete(meta);
	meta.comboName = null;
	meta.comboSlotIndex = null;
	const effectiveModel =
		model ?? resolveEffectiveModel(meta.appliedModel, meta.originalModel);
	meta.affinityLaneKey = deriveAffinityLaneKey(meta, effectiveModel);
	meta.hardExcludedAccountIds = null;
	meta.quotaPressureByAccountId = null;
	meta.routingCandidateCatalog = null;
	meta.routingCandidates = null;
	saveCapacityContext(meta, effectiveModel, []);

	// Check if a specific account is requested via special header
	if (meta.headers) {
		const forcedAccountId = meta.headers.get("x-better-ccflare-account-id");
		if (forcedAccountId) {
			try {
				const allAccounts = await ctx.dbOps.getAllAccounts();
				const forcedAccount = allAccounts.find(
					(acc) => acc.id === forcedAccountId,
				);
				if (!forcedAccount) {
					throw new ForceRouteUnavailableError(forcedAccountId, "not_found");
				}
				{
					// The auto-refresh scheduler sends authenticated internal probes
					// to intentionally refresh accounts that are paused due to auto_pause_on_overage,
					// or to probe accounts that are rate-limited (to detect when the window has reset).
					// For trusted probes we allow through an overage-paused or rate-limited account
					// so the scheduler can hit the real endpoint and trigger the window-reset + auto-resume logic.
					// Only an overage pause qualifies: a manual pause (pause_reason='manual') or a
					// failure-threshold / peak_hours pause must still win even when the overage feature
					// flag is enabled, because the auto-resume guard would never un-pause those accounts.
					// This mirrors the scheduler eligibility query and the sendDummyMessage resume guard
					// (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage')).
					const isAutoRefreshBypass = meta.trustedInternalAutoRefresh === true;
					const available = isAccountAvailable(forcedAccount);
					const isOveragePaused =
						forcedAccount.paused &&
						forcedAccount.auto_pause_on_overage_enabled &&
						(!forcedAccount.pause_reason ||
							forcedAccount.pause_reason === "overage");
					const isRateLimited =
						!available &&
						!forcedAccount.paused &&
						!!forcedAccount.rate_limited_until;
					// Fail closed for every provider: a client that explicitly
					// force-routes to a specific account id must never be silently
					// redirected to a *different* account it did not ask for, and must
					// never be silently downgraded into normal pool selection. This
					// used to be scoped to the xAI cache-native official-endpoint
					// carve-out only (meta.xaiCacheNativeActive && provider === "xai"
					// && isOfficialXaiEndpoint); it now applies unconditionally to any
					// unavailable or capacity-exhausted forced account, regardless of
					// provider, custom-endpoint status, or the xaiCacheNativeActive flag.
					const mayProbeUnavailableAccount =
						isAutoRefreshBypass && (isOveragePaused || isRateLimited);
					if (!available && !mayProbeUnavailableAccount) {
						throw new ForceRouteUnavailableError(
							forcedAccountId,
							forcedAccount.paused ? "paused" : "rate_limited_or_unavailable",
						);
					}

					if (effectiveModel) {
						const now = Date.now();
						const evaluation = evaluateCandidateCapacity(
							forcedAccount,
							effectiveModel,
							canonicalizeBetaSignature(meta.headers.get("anthropic-beta")),
							now,
						);
						meta.quotaPressureByAccountId = evaluation.quotaPressure
							? new Map([[forcedAccount.id, evaluation.quotaPressure]])
							: null;
						if (evaluation.blockers.length > 0) {
							meta.hardExcludedAccountIds = new Set([forcedAccount.id]);
							const exclusion = candidateExclusion(
								forcedAccount,
								effectiveModel,
								evaluation,
								"force",
							);
							saveCapacityContext(meta, effectiveModel, [exclusion]);
							const accountWide = evaluation.blockers.some(
								(blocker) => blocker.scope === "account",
							);
							throw new ForceRouteUnavailableError(
								forcedAccountId,
								accountWide
									? "account_capacity_exhausted"
									: "model_capacity_exhausted",
							);
						}
						meta.hardExcludedAccountIds = null;
						saveCapacityContext(meta, effectiveModel, []);
					} else {
						meta.hardExcludedAccountIds = null;
						meta.quotaPressureByAccountId = null;
						saveCapacityContext(meta, null, []);
					}
					return [forcedAccount];
				}
				// Forced account id does not exist in the database at all. Fail
				// closed here too instead of silently falling back to normal
				// selection, which would route the request to an account the
				// caller never asked for. (Handled above via the `!forcedAccount`
				// early throw before this try block's inner logic runs.)
			} catch (error) {
				if (error instanceof ForceRouteUnavailableError) throw error;
				log.error(
					"Failed to get accounts from database for forced account lookup:",
					error,
				);
				console.error("\n❌ DATABASE ERROR DETECTED");
				console.error("═".repeat(50));
				console.error(
					"The database encountered an error while looking up the requested account.",
				);
				console.error(
					"This may indicate database corruption or integrity issues.\n",
				);
				console.error("To diagnose and repair the database, run:");
				console.error("  bun run cli --repair-db\n");
				console.error("The explicit route will fail closed.");
				console.error(`${"═".repeat(50)}\n`);
				throw new ForceRouteUnavailableError(forcedAccountId, "lookup_failed");
			}
		}
	}

	// Filter out excluded providers (e.g. claude-oauth excluded by the responses adapter)
	const excludeProviders =
		meta.headers
			?.get("x-better-ccflare-exclude-providers")
			?.split(",")
			.map((p) => p.trim())
			.filter(Boolean) ?? [];
	const isProviderExcluded = (account: Account): boolean => {
		for (const ex of excludeProviders) {
			// "anthropic-oauth" targets only Anthropic OAuth accounts
			// (refresh_token present), leaving API-key accounts eligible.
			if (ex === "anthropic-oauth") {
				if (account.provider === "anthropic" && account.refresh_token != null) {
					return true;
				}
			} else if (account.provider === ex) {
				return true;
			}
		}
		return false;
	};

	const applyExclusions = (accounts: Account[]): Account[] => {
		if (excludeProviders.length === 0) return accounts;
		const filtered = accounts.filter((account) => !isProviderExcluded(account));
		const skipped = accounts.length - filtered.length;
		if (skipped > 0) {
			log.warn(
				`Skipping ${skipped} account(s) excluded for this request type (Codex CLI traffic must not use Anthropic OAuth accounts)`,
			);
		}
		return filtered;
	};

	// Try combo-aware routing if a concrete effective model is available.
	if (effectiveModel && !options.skipCombo) {
		const family = getModelFamily(effectiveModel);
		if (family) {
			const validFamilies: readonly string[] = [
				"fable",
				"opus",
				"sonnet",
				"haiku",
			];
			if (!validFamilies.includes(family)) {
				log.warn(`Unknown model family "${family}", skipping combo lookup`);
			} else {
				const combo = await ctx.dbOps.getActiveComboForFamily(
					family as ComboFamily,
				);
				if (combo) {
					log.info(
						`Combo routing active: ${combo.name} for family ${family} (${combo.slots.length} slots)`,
					);

					const allAccounts = await ctx.dbOps.getAllAccounts();
					const accountMap = new Map<string, Account>();
					for (const account of allAccounts) {
						accountMap.set(account.id, account);
					}

					const eligibleEntries: Array<{
						slotId: string;
						account: Account;
						modelOverride: string;
						tier: number;
						ordinal: number;
						quotaPressure: AccountQuotaPressure | null;
						routing: RoutingCandidateMetadata;
					}> = [];
					const candidateCatalog: RoutingCandidateMetadata[] = [];
					const capacityExclusions: RoutingCapacityCandidateExclusion[] = [];
					const candidateCountsByAccount = new Map<string, number>();
					const eligibleCountsByAccount = new Map<string, number>();
					const now = Date.now();
					const beta = canonicalizeBetaSignature(
						meta.headers?.get("anthropic-beta"),
					);

					// Treat every slot as one account/model candidate. The repository's
					// slot order is retained as the stable within-tier ordinal.
					for (const [ordinal, slot] of combo.slots.entries()) {
						if (!slot.enabled) continue;

						const account = accountMap.get(slot.account_id);
						if (!account) {
							log.warn(
								`Combo slot references unknown account ${slot.account_id}`,
							);
							continue;
						}

						if (isProviderExcluded(account)) continue;
						const routing: RoutingCandidateMetadata = {
							candidateId: `combo:${combo.id}:slot:${slot.id}`,
							accountId: account.id,
							tier: slot.priority,
							ordinal,
							comboSlotId: slot.id,
							modelOverride: slot.model,
							quotaPressure: null,
						};
						candidateCatalog.push(routing);

						if (!isAccountAvailable(account)) {
							continue;
						}

						candidateCountsByAccount.set(
							account.id,
							(candidateCountsByAccount.get(account.id) ?? 0) + 1,
						);
						const evaluation = evaluateCandidateCapacity(
							account,
							slot.model,
							beta,
							now,
						);
						routing.quotaPressure = evaluation.quotaPressure;
						if (evaluation.blockers.length > 0) {
							capacityExclusions.push(
								candidateExclusion(
									account,
									slot.model,
									evaluation,
									"combo",
									slot.id,
									ordinal,
								),
							);
							continue;
						}

						eligibleCountsByAccount.set(
							account.id,
							(eligibleCountsByAccount.get(account.id) ?? 0) + 1,
						);
						eligibleEntries.push({
							slotId: slot.id,
							account,
							modelOverride: slot.model,
							tier: slot.priority,
							ordinal,
							quotaPressure: evaluation.quotaPressure,
							routing,
						});
					}

					setXaiCacheEligibleAccounts(meta, allAccounts);
					const fullyExcludedAccountIds = new Set<string>();
					for (const [accountId, count] of candidateCountsByAccount) {
						if (
							count > 0 &&
							(eligibleCountsByAccount.get(accountId) ?? 0) === 0
						) {
							fullyExcludedAccountIds.add(accountId);
						}
					}
					meta.hardExcludedAccountIds =
						fullyExcludedAccountIds.size > 0 ? fullyExcludedAccountIds : null;
					// Combo pressure is candidate-local because one account may appear in
					// multiple concrete model lanes. Never collapse it into an account map.
					meta.quotaPressureByAccountId = null;
					meta.routingCandidateCatalog = candidateCatalog;
					saveCapacityContext(meta, effectiveModel, capacityExclusions);

					if (eligibleEntries.length > 0) {
						eligibleEntries.sort(
							(a, b) =>
								a.tier - b.tier ||
								compareCandidatePressure(a.quotaPressure, b.quotaPressure) ||
								a.ordinal - b.ordinal,
						);
						meta.routingCandidates = eligibleEntries.map(
							(entry) => entry.routing,
						);
						const entryByCandidateId = new Map(
							eligibleEntries.map((entry) => [
								entry.routing.candidateId,
								entry,
							]),
						);
						const reconcileEntries = (
							orderedAccounts: Account[],
							routingSidecar: readonly RoutingCandidateMetadata[] | null,
						): typeof eligibleEntries => {
							if (
								routingSidecar?.length === orderedAccounts.length &&
								routingSidecar.every(
									(candidate, index) =>
										candidate.accountId === orderedAccounts[index]?.id &&
										entryByCandidateId.has(candidate.candidateId),
								)
							) {
								const seen = new Set<string>();
								const aligned = routingSidecar
									.map((candidate) => {
										if (seen.has(candidate.candidateId)) return undefined;
										seen.add(candidate.candidateId);
										return entryByCandidateId.get(candidate.candidateId);
									})
									.filter(
										(entry): entry is (typeof eligibleEntries)[number] =>
											entry !== undefined,
									);
								if (aligned.length === orderedAccounts.length) return aligned;
							}

							// Account-only custom strategies cannot express which repeated slot
							// moved. Reconcile each returned occurrence to the next unused source
							// candidate for that account, preserving as much identity as possible.
							const used = new Set<string>();
							return orderedAccounts
								.map((account) => {
									const entry = eligibleEntries.find(
										(candidate) =>
											candidate.account.id === account.id &&
											!used.has(candidate.routing.candidateId),
									);
									if (entry) used.add(entry.routing.candidateId);
									return entry;
								})
								.filter(
									(entry): entry is (typeof eligibleEntries)[number] =>
										entry !== undefined,
								);
						};

						const strategyAccounts = await ctx.strategy.select(
							eligibleEntries.map((entry) => entry.account),
							meta,
						);
						let orderedEntries = reconcileEntries(
							strategyAccounts,
							meta.routingCandidates ?? null,
						);
						meta.routingCandidates = orderedEntries.map(
							(entry) => entry.routing,
						);
						const affinityAccounts = applyXaiCacheAffinity(
							orderedEntries.map((entry) => entry.account),
							meta,
							ctx,
						);
						orderedEntries = reconcileEntries(
							affinityAccounts,
							meta.routingCandidates ?? null,
						);
						meta.routingCandidates = orderedEntries.map(
							(entry) => entry.routing,
						);
						if (orderedEntries.length > 0) {
							const slotInfo: ComboSlotInfo = {
								comboName: combo.name,
								slots: orderedEntries.map((entry) => ({
									accountId: entry.account.id,
									modelOverride: entry.modelOverride,
								})),
							};
							setComboSlotInfo(meta, slotInfo);
							meta.comboName = combo.name;
							return orderedEntries.map((entry) => entry.account);
						}
					}

					// All slots unavailable — fall back to normal routing
					log.warn(
						`All ${combo.slots.length} combo slots unavailable for ${combo.name}, falling back to SessionStrategy`,
					);
				}
			}
		}
	}

	return applyExclusions(await getOrderedAccounts(meta, ctx, effectiveModel));
}
