import {
	getModelFamily,
	isAccountAvailable,
	isFirstPartyAnthropicAccount,
} from "@better-ccflare/core";
import type {
	QualityConversation,
	QualityIngressTicket,
	QualityLease,
	QualityReplacementAuthority,
	QualitySettlement,
} from "@better-ccflare/database";
import { QualityRouteError } from "@better-ccflare/database";
import {
	type AutoModelTargetEvidence,
	type AutoRequestRequirements,
	captureAutoRequestRequirements,
	isAutoCatalogEvidenceCurrent,
	resolveAutoModelTargets,
	resolveProviderForAccount,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	QualityAdmissionDecision,
	QualityAdmissionReason,
	QualityLane,
	QualityPhysicalTarget,
	QualityRequestIntent,
	QualityRoutingPolicy,
	QualitySkippedLanes,
	QualityVerifiedSession,
	QualityWorkerRole,
	RequestMeta,
} from "@better-ccflare/types";
import {
	type QualityDecisionRecord,
	sanitizeQualityDecision,
} from "@better-ccflare/types/request";
import { classifyAnthropicReplayRisk } from "./anthropic-degraded-mode";
import { circuitKeyFor, shouldAllow } from "./circuit-breaker";
import {
	attributionSourceIdentifiesAgent,
	deriveClaudeCodeRouteLineage,
	isClaudeCodeSubagent,
} from "./claude-code-request";
import { getCodexAutoCatalogEvidence } from "./codex-model-catalog";
import {
	isAnthropicDegradedSendDenied,
	isPreparedProxyAccountResponse,
	proxyWithAccount,
} from "./handlers/proxy-operations";
import type { ProxyContext } from "./handlers/proxy-types";
import { evaluateQualityRouteAdmission } from "./handlers/quality-route-admission";
import { hasHardAnthropicAccountSignal } from "./handlers/rate-limit-scope";
import { RoutingAttemptLedger } from "./handlers/routing-attempt-ledger";
import { evaluateAutoCapacity } from "./handlers/usage-throttling";
import { getNativeAutoCatalogEvidence } from "./model-catalog";
import { opaqueRuntimeId } from "./opaque-runtime-id";
import { prepareNativeQualityCatalogs } from "./quality-route-catalog-preparation";
import type { RequestBodyContext } from "./request-body-context";
import { recordRoutingTerminalRequest } from "./routing-terminal-recorder";
import { bindRequestPrivateServerToolReplay } from "./server-tool-replay-runtime";
import {
	createNativeAnthropicToolRoutingError,
	createServerToolRoutingErrorResponse,
	ServerToolCandidateCapabilityError,
	type ServerToolRoutingError,
} from "./server-tool-routing-errors";
import { tryGetUsageCollector } from "./usage-collector";

export const QUALITY_MODEL_PREFIX = "claude-bccf-quality-";
const ingress = new WeakMap<Request, Promise<QualityIngressTicket | null>>();
function scopeFor(
	req: Request,
	apiKeyId?: string | null,
): QualityVerifiedSession | null {
	const sessionId = req.headers.get("x-claude-code-session-id");
	if (
		!apiKeyId ||
		!sessionId ||
		apiKeyId.length > 256 ||
		sessionId.length > 256 ||
		sessionId.trim() !== sessionId
	)
		return null;
	return { verified: true, principalId: apiKeyId, sessionId };
}
/** Called synchronously at ingress, before the first body/interceptor await. Rejections
 * are observed immediately; the body path subsequently fails closed on that ticket. */
export function reserveQualityIngress(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
): void {
	if (
		!ctx.qualityRouteService ||
		!ctx.config.getQualityRoutingPolicy?.() ||
		req.method !== "POST" ||
		url.pathname !== "/v1/messages" ||
		isClaudeCodeSubagent(req.headers)
	)
		return;
	const session = scopeFor(req, apiKeyId);
	if (!session) return;
	const pending = ctx.qualityRouteService.reserveIngress(session);
	ingress.set(req, pending);
	void pending.catch(() => {});
}
/** Every body rejection/throw/completed acceptance releases only its own reservation.
 * Failed persistence remains bounded by the provisional TTL, never by session TTL. */
export async function withdrawQualityIngress(
	req: Request,
	ctx: ProxyContext,
): Promise<void> {
	const pending = ingress.get(req);
	ingress.delete(req);
	if (!pending || !ctx.qualityRouteService) return;
	try {
		const ticket = await pending;
		if (ticket) await ctx.qualityRouteService.withdrawIngress(ticket);
	} catch {
		/* Failed reservations have no token; storage failures expire bounded ingress. */
	}
}
export class QualityAttemptRejected extends Error {
	constructor(readonly reason: string) {
		super(`Quality routing: ${reason}`);
	}
}
export interface QualityAttemptHooks {
	/** Attempt-bound U7 inputs; unlike RequestMeta these never move to a sibling. */
	readonly target: QualityPhysicalTarget;
	readonly policyRevision: QualityRoutingPolicy["revision"];
	readonly accounting: QualityAdmissionDecision["accounting"];
	/** Runs once on the final transformed HTTP envelope. Never triggers discovery. */
	beforeDispatch(request: Request, accessToken: string): Promise<void>;
	/** Synchronous last-mile admission after the durable fence and other awaits. */
	assertDispatch(): void;
	observeResponse(response: Response): void;
	complete(outcome: QualitySettlement): void;
}
export interface QualityRouteCandidate {
	readonly id: string;
	readonly target: QualityPhysicalTarget;
	readonly evidence: AutoModelTargetEvidence;
	readonly policyRevision: QualityRoutingPolicy["revision"];
}
function catalogFor(accountId: string, provider: string, includeStale = false) {
	return provider === "anthropic"
		? getNativeAutoCatalogEvidence(accountId, includeStale)
		: provider === "codex"
			? getCodexAutoCatalogEvidence(accountId, includeStale)
			: null;
}
/** One immutable exact-account/model authority. Distinct models on the same account
 * remain distinct candidates. Stored predecessors are resolved independently. */
export function compileQualityCandidates(
	policy: QualityRoutingPolicy,
	intent: QualityRequestIntent,
	accounts: readonly Account[],
	conversation?: QualityConversation | null,
): Readonly<{
	candidates: readonly QualityRouteCandidate[];
	skippedLanes: QualitySkippedLanes;
}> {
	const lanes =
		intent.kind === "main"
			? policy.mainLadders[intent.preference]
			: policy.workerLanes[intent.role];
	if (lanes.length > 3 || new Set(lanes).size !== lanes.length)
		throw new TypeError("Invalid quality lane ladder");
	const candidates: QualityRouteCandidate[] = [];
	const rejected = new Map<
		QualityLane,
		Partial<Record<QualityAdmissionReason, number>>
	>();
	const seenRejections = new Set<string>();
	const append = (
		account: Account,
		line: QualityPhysicalTarget["line"],
		lane: QualityPhysicalTarget["lane"],
		stored?: string,
	) => {
		const resolved = resolveAutoModelTargets(
			catalogFor(account.id, account.provider),
			line,
			stored,
		);
		const previous = conversation?.home?.target;
		const exactOnly =
			conversation?.home?.intentRevision === conversation?.revision &&
			previous?.accountId === account.id &&
			previous.line === line &&
			policy.assignments.find((assignment) => assignment.line === line)
				?.upgrade === "exact-only";
		const evidence = stored
			? resolved.stored
			: exactOnly
				? resolveAutoModelTargets(
						catalogFor(account.id, account.provider),
						line,
						previous.physicalModel,
					).stored
				: resolved.current;
		if (!evidence) {
			const catalog = catalogFor(account.id, account.provider, true);
			const reason: QualityAdmissionReason = !catalog
				? "evidence-missing"
				: !isAutoCatalogEvidenceCurrent(catalog)
					? "catalog-evidence-stale"
					: "model-unsupported";
			// A stored predecessor and current target must not double-count one
			// account/line evidence failure. Only bounded enums and counts survive.
			const key = JSON.stringify([account.id, line, reason]);
			if (!seenRejections.has(key)) {
				seenRejections.add(key);
				const reasons = rejected.get(lane) ?? {};
				reasons[reason] = Math.min(1_000_000, (reasons[reason] ?? 0) + 1);
				rejected.set(lane, reasons);
			}
			return;
		}
		const id = JSON.stringify([account.id, evidence.physicalModel, line]);
		if (candidates.some((c) => c.id === id)) return;
		const target = Object.freeze({
			accountId: account.id,
			provider: evidence.provider,
			line,
			lane,
			physicalModel: evidence.physicalModel,
			catalogRevision: evidence.catalogRevision,
			evidenceRef: evidence.evidenceRef,
		});
		candidates.push(
			Object.freeze({ id, target, evidence, policyRevision: policy.revision }),
		);
	};
	const home = conversation?.home;
	if (home && home.intentRevision === conversation?.revision) {
		const account = accounts.find(
			(a) =>
				a.id === home.target.accountId && a.provider === home.target.provider,
		);
		if (
			account &&
			lanes.includes(home.target.lane) &&
			policy.lanes[home.target.lane].includes(home.target.line) &&
			policy.accounts.some(
				(a) =>
					a.accountId === account.id &&
					a.provider === account.provider &&
					a.lines.includes(home.target.line),
			)
		)
			append(
				account,
				home.target.line,
				home.target.lane,
				home.target.physicalModel,
			);
	}
	for (const lane of lanes)
		for (const line of policy.lanes[lane]) {
			const enrolled = policy.accounts
				.filter((e) => e.lines.includes(line))
				.flatMap((enrollment) => {
					const account = accounts.find(
						(a) =>
							a.id === enrollment.accountId &&
							a.provider === enrollment.provider,
					);
					return account ? [{ account, enrollment }] : [];
				})
				.sort(
					(a, b) =>
						a.enrollment.priority - b.enrollment.priority ||
						a.account.priority - b.account.priority ||
						a.account.id.localeCompare(b.account.id),
				);
			for (const { account } of enrolled) append(account, line, lane);
		}
	return Object.freeze({
		candidates: Object.freeze(candidates),
		skippedLanes: Object.freeze(
			lanes.flatMap((lane) => {
				const reasons = rejected.get(lane);
				return reasons
					? [Object.freeze({ lane, reasons: Object.freeze(reasons) })]
					: [];
			}),
		) as QualitySkippedLanes,
	});
}
function unavailable(reason: string, status = 503): Response {
	return Response.json(
		{
			type: "error",
			error: {
				type: status === 400 ? "invalid_request_error" : "service_unavailable",
				code: "quality_route_unavailable",
				reason,
			},
		},
		{ status, headers: { "cache-control": "no-store" } },
	);
}
function workerRole(
	model: string | null,
	policy: QualityRoutingPolicy,
): QualityWorkerRole | null {
	if (!model) return null;
	// A picker id on a worker is the copied main-agent preference, not a role
	// request: workers stay standard instead of inheriting the parent's tier.
	if (model.startsWith(QUALITY_MODEL_PREFIX)) return "standard";
	for (const assignment of policy.assignments) {
		if (
			policy.accounts.some(
				(account) =>
					account.lines.includes(assignment.line) &&
					resolveAutoModelTargets(
						catalogFor(account.accountId, account.provider),
						assignment.line,
						model,
					).stored,
			)
		)
			return assignment.lane;
	}
	const family = getModelFamily(model);
	return family === "sonnet"
		? "standard"
		: family === "haiku"
			? "lightweight"
			: family === "fable"
				? "fable"
				: family === "opus"
					? "opus"
					: null;
}
function replacementFor(
	conversation: QualityConversation | null,
	policy: QualityRoutingPolicy,
	accounts: readonly Account[],
): QualityReplacementAuthority {
	const home = conversation?.home;
	if (!home || home.intentRevision !== conversation.revision) return null;
	const target = home.target;
	const account = accounts.find(
		(a) => a.id === target.accountId && a.provider === target.provider,
	);
	let unavailable =
		!account ||
		account.paused ||
		account.requires_reauth ||
		!policy.accounts.some(
			(a) =>
				a.accountId === target.accountId &&
				a.provider === target.provider &&
				a.lines.includes(target.line),
		) ||
		!policy.assignments.some(
			(a) => a.line === target.line && a.lane === target.lane,
		);
	const catalog = catalogFor(target.accountId, target.provider);
	if (
		isAutoCatalogEvidenceCurrent(catalog) &&
		!resolveAutoModelTargets(catalog, target.line, target.physicalModel).stored
	)
		unavailable = true;
	const usage = usageCache.getSnapshot(target.accountId);
	if (usage) {
		const capacity = evaluateAutoCapacity(usage.data, {
			accountId: target.accountId,
			provider: target.provider,
			line: target.line,
			requestModel: target.physicalModel,
			observedAt: usage.observedAt,
			spendGrants: policy.spendGrants,
		});
		if (capacity.status === "reject") unavailable = true;
	}
	return unavailable
		? { kind: "genuinely-unavailable", homeVersion: home.version }
		: null;
}
/** Returns null only for untouched ordinary routing. Local policy/state failures never
 * fall back to the legacy selector. Native discovery is bounded request preparation;
 * inference still uses the existing provider-attempt machinery. */
export async function routeQualityRequest(input: {
	req: Request;
	url: URL;
	ctx: ProxyContext;
	meta: RequestMeta;
	originalBody: unknown;
	body: RequestBodyContext;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	requirements?: AutoRequestRequirements;
	onRootAccepted?: () => void;
	serverToolQueryPresent: boolean;
}): Promise<Response | null> {
	const { req, url, ctx, meta, body, apiKeyId, apiKeyName } = input;
	const original = input.originalBody as { model?: unknown } | null;
	const model =
		typeof original?.model === "string" ? original.model.trim() : null;
	const effectiveModel = body.getModel()?.trim();
	if (
		effectiveModel?.startsWith(QUALITY_MODEL_PREFIX) &&
		effectiveModel !== model
	)
		return unavailable("conflicting-quality-id", 400);
	const reserved = model?.startsWith(QUALITY_MODEL_PREFIX) === true;
	const policy = ctx.config.getQualityRoutingPolicy?.();
	const service = ctx.qualityRouteService;
	const preference = policy?.choices.find(
		(c) => c.publicModelId === model,
	)?.preference;
	if (reserved && !preference)
		return unavailable("unknown-or-disabled-quality-id", 400);
	if (!policy || !service)
		return reserved ? unavailable("quality-service-unavailable") : null;
	if (url.pathname !== "/v1/messages" || req.method !== "POST")
		return reserved ? unavailable("unsupported-path", 400) : null;
	const session = scopeFor(req, apiKeyId);
	if (!session)
		return reserved ? unavailable("verified-session-required", 400) : null;
	try {
		const descendant =
			isClaudeCodeSubagent(req.headers) ||
			attributionSourceIdentifiesAgent(meta.agentAttributionSource);
		const status = await service.status(session);
		const lineage = deriveClaudeCodeRouteLineage(req.headers, {
			callerIdentity: apiKeyId,
			sessionId: session.sessionId,
		});
		const childKey = lineage.childHomeKey
			? `child:${lineage.childHomeKey}`
			: null;
		const existingChild = childKey
			? status?.conversations.find((c) => c.key === childKey)
			: null;
		const enrolledChild =
			descendant && (status?.preference != null || existingChild != null);
		if (!reserved && !enrolledChild) {
			// Let the legacy reserved-ID validator reject unknown profiles without
			// withdrawing an unrelated accepted quality intent.
			if (
				model?.startsWith("claude-bccf-route-") &&
				!ctx.modelRouteSessionRegistry?.hasPublicModelId(model)
			)
				return null;
			// Ordinary explicit root intent leaves Auto, but children never mutate roots.
			if (!descendant && model) {
				try {
					const ticket = await ingress.get(req);
					if (!ticket) return unavailable("ingress-unavailable");
					await service.acceptRoot(ticket, null);
				} catch (error) {
					if (!(error instanceof QualityRouteError)) throw error;
					const code = error.code;
					// Stale native requests still infer, but never mutate newer intent.
					// Only a refused *new* provisional row is unrelated to live state.
					if (code !== "stale" && !(code === "provisional-capacity" && !status))
						throw error;
				}
			}
			return null;
		}
		if (
			req.headers.has("x-better-ccflare-account-id") ||
			model?.startsWith("claude-bccf-route-") ||
			body.getModel()?.startsWith("claude-bccf-route-")
		)
			return unavailable("conflicting-hard-route", 400);
		let conversation: QualityConversation | null = null;
		let incarnation: string;
		let intent: QualityRequestIntent;
		if (descendant) {
			if (!status || (!status.preference && !existingChild))
				return unavailable("parent-not-enrolled", 400);
			const role = workerRole(effectiveModel ?? null, policy);
			if (!role) return unavailable("unresolved-worker-role", 400);
			incarnation = status.incarnation;
			conversation = await service.acceptChild(
				session,
				incarnation,
				lineage.childHomeKey
					? { trusted: true, conversationId: lineage.childHomeKey }
					: null,
				role,
				existingChild?.revision ?? null,
			);
			intent = { kind: "worker", role };
		} else {
			if (!preference) return unavailable("invalid-root-intent", 400);
			const ticket = await ingress.get(req);
			if (!ticket) return unavailable("ingress-unavailable");
			const accepted = await service.acceptRoot(ticket, preference);
			input.onRootAccepted?.();
			if (!accepted || accepted.incarnation !== ticket.incarnation)
				return unavailable("stale-intent");
			incarnation = accepted.incarnation;
			conversation =
				accepted.conversations.find((c) => c.key === "$root") ?? null;
			intent = { kind: "main", preference };
		}
		const requirements =
			input.requirements ?? captureAutoRequestRequirements(input.originalBody);
		let accounts = await ctx.dbOps.getAllAccounts();
		// Only an authenticated, accepted Auto request reaches this permission
		// boundary. Discovery/control/manual routes never authorize OAuth lookups.
		if (process.env.BETTER_CCFLARE_MODELS_OFFLINE !== "1") {
			await prepareNativeQualityCatalogs(ctx, policy, intent, accounts, {
				signal: req.signal,
				allowOAuth: true,
				conversation,
			});
			accounts = await ctx.dbOps.getAllAccounts();
		}
		if (req.signal.aborted) return unavailable("request-aborted");
		if (ctx.config.getQualityRoutingPolicy?.()?.revision !== policy.revision)
			return unavailable("changed-admission");
		// Lease acquisition and the final dispatch guard still fence accepted
		// intent, account incarnation, credentials and policy after these awaits.
		const compilation = compileQualityCandidates(
			policy,
			intent,
			accounts,
			conversation,
		);
		const { candidates } = compilation;
		const lanes =
			intent.kind === "main"
				? policy.mainLadders[intent.preference]
				: policy.workerLanes[intent.role];
		// The existing strategy retains eligibility and circuit veto authority, but
		// may neither reorder this quality ladder nor install a speculative home.
		meta.affinityLaneKey = opaqueRuntimeId(
			"quality-lane",
			session.principalId,
			session.sessionId,
			incarnation,
			conversation?.key ?? meta.id,
			String(conversation?.revision ?? 0),
		);
		const selectionMeta: RequestMeta = {
			...meta,
			routeLineage: { kind: "root", childHomeKey: null },
			affinityOwnerDirective: { kind: "defer-owner-assignment" },
			routingCandidates: candidates.map((candidate, ordinal) => ({
				candidateId: candidate.id,
				accountId: candidate.target.accountId,
				tier: ordinal,
				ordinal,
				comboSlotId: null,
				modelOverride: candidate.target.physicalModel,
				quotaPressure: null,
			})),
		};
		selectionMeta.routingCandidateCatalog = selectionMeta.routingCandidates;
		const selectionAccounts = candidates.flatMap((candidate) => {
			const account = accounts.find((a) => a.id === candidate.target.accountId);
			return account ? [account] : [];
		});
		const selected = await ctx.strategy.select(
			selectionAccounts,
			selectionMeta,
		);
		const selectedAccounts = new Set(selected.map((account) => account.id));
		const allowedCandidates = new Set(
			selectionMeta.routingCandidates
				?.filter((candidate) => selectedAccounts.has(candidate.accountId))
				.map((candidate) => candidate.candidateId),
		);
		meta.routingCandidates = selectionMeta.routingCandidates;
		meta.routingCandidateCatalog = selectionMeta.routingCandidateCatalog;
		// A proven hard-account no-work response is attempt-bound authority, unlike
		// mutable quota/account snapshots, which must be revalidated near dispatch.
		let hardReplacement: QualityReplacementAuthority = null;
		const skipped = new Map<
			QualityLane,
			Partial<Record<QualityAdmissionReason, number>>
		>();
		let lastAdmissionReason: QualityAdmissionReason = "lane-unavailable";
		const attemptedLanes = new Set<QualityLane>();
		const summaries = (through?: QualityLane): QualitySkippedLanes =>
			lanes
				.filter(
					(lane, index) =>
						through === undefined ||
						attemptedLanes.has(lane) ||
						index <= lanes.indexOf(through),
				)
				.flatMap((lane) => {
					const reasons = skipped.get(lane);
					return reasons ? [{ lane, reasons: { ...reasons } }] : [];
				}) as unknown as QualitySkippedLanes;
		const recordSkip = (
			lane: QualityLane,
			reason: QualityAdmissionReason,
			count = 1,
			compilationOnly = false,
		) => {
			if (!compilationOnly) attemptedLanes.add(lane);
			lastAdmissionReason = reason;
			const reasons = skipped.get(lane) ?? {};
			reasons[reason] = Math.min(1_000_000, (reasons[reason] ?? 0) + count);
			skipped.set(lane, reasons);
			meta.qualityDecision = {
				version: 1,
				policyRevision: policy.revision,
				requested: intent,
				selected: null,
				skippedLanes: summaries(),
			};
		};
		meta.originalModel = model;
		meta.qualityDecision = {
			version: 1,
			policyRevision: policy.revision,
			requested: intent,
			selected: null,
			skippedLanes: [],
		};
		for (const summary of compilation.skippedLanes)
			for (const [reason, count] of Object.entries(summary.reasons))
				recordSkip(summary.lane, reason as QualityAdmissionReason, count, true);

		const ledger = new RoutingAttemptLedger();
		const serverTools = body.finalizeServerToolRequirements();
		// Advisor is native-only, so Auto admits it per candidate (first-party
		// accounts) and refuses recoverably when only other candidates remain.
		const nativeRequirement = body.finalizeNativeAnthropicToolRequirement();
		meta.nativeAnthropicToolRequirement = nativeRequirement ?? null;
		const persistRejection = async () => {
			if (!conversation) return;
			try {
				await service.recordRejectedDecision(
					session,
					incarnation,
					conversation.key,
					conversation.revision,
					meta.id,
					meta.qualityDecision,
				);
			} catch {
				/* Explanation failure never triggers inference or changes routing. */
			}
		};
		const refuseServerTool = async (error: ServerToolRoutingError) => {
			await persistRejection();
			const response = createServerToolRoutingErrorResponse(error);
			void recordRoutingTerminalRequest({
				collector: tryGetUsageCollector(),
				requestMeta: meta,
				requestHeaders: req.headers,
				response,
				providerName: ctx.provider.name,
				terminalKind: `server_tool_${error.reason}`,
				upstreamAttempts: ledger.attemptedCount,
				apiKeyId,
				apiKeyName,
			});
			return response;
		};
		// Advisor beside a proxy-hosted tool, or an advisor_* type this proxy does
		// not know, cannot be served by any route. A request already invalid or
		// unsupported keeps its existing terminal below.
		if (
			nativeRequirement &&
			!serverTools?.invalid?.length &&
			!serverTools?.unsupported?.length &&
			(serverTools !== undefined ||
				nativeRequirement.unknownDeclaredTypes.length > 0)
		)
			return await refuseServerTool(
				createNativeAnthropicToolRoutingError(nativeRequirement),
			);
		if (serverTools) {
			if (serverTools.invalid?.length || serverTools.unsupported?.length)
				return unavailable("tools-unsupported");
			meta.serverToolRequirements = serverTools;
			meta.serverToolQueryPresent = input.serverToolQueryPresent;
			if (
				!(await bindRequestPrivateServerToolReplay(meta, ctx.serverToolReplay, {
					request: req,
					apiKeyId,
					audience: `api-key-id:${session.principalId.trim()}`,
					lineage: session.sessionId,
				}))
			)
				return unavailable("tool-replay-unavailable");
		}
		let advisorSkipped = false;
		const degraded = ctx.anthropicDegradedMode?.createRequestAdmission({
			cohortKey: null,
			risk: classifyAnthropicReplayRisk({
				body: new Uint8Array(body.getBuffer() ?? new ArrayBuffer(0)),
				config: ctx.anthropicDegradedMode.config,
			}),
		});
		for (const candidate of candidates) {
			if (!allowedCandidates.has(candidate.id)) {
				recordSkip(candidate.target.lane, "account-unavailable");
				continue;
			}
			const selectedAccount = await ctx.dbOps.getAccount(
				candidate.target.accountId,
			);
			if (
				!selectedAccount ||
				selectedAccount.requires_reauth ||
				!isAccountAvailable(selectedAccount)
			) {
				recordSkip(candidate.target.lane, "account-unavailable");
				continue;
			}
			// Credential preparation may mutate its local account view. Never let an
			// unrelated DB/cache object mutation rewrite the selected wire identity.
			const account = { ...selectedAccount };
			const capacity = usageCache.getSnapshot(account.id);
			const capacityDecision: QualityAdmissionDecision = capacity
				? evaluateAutoCapacity(capacity.data, {
						accountId: account.id,
						provider: candidate.target.provider,
						line: candidate.target.line,
						requestModel: candidate.target.physicalModel,
						observedAt: capacity.observedAt,
						spendGrants: policy.spendGrants,
					})
				: { status: "unknown", reason: "capacity-evidence-unknown" };
			if (capacityDecision.status !== "admit") {
				recordSkip(candidate.target.lane, capacityDecision.reason);
				continue;
			}
			// A candidate that passed availability and capacity but cannot run advisor
			// is skipped before any wire is built, so nothing reaches its upstream.
			if (nativeRequirement && !isFirstPartyAnthropicAccount(account)) {
				advisorSkipped = true;
				recordSkip(candidate.target.lane, "tools-unsupported");
				continue;
			}
			let lease: QualityLease | null = null;
			let fenced = false,
				dispatched = false,
				noWork = false;
			const provider = resolveProviderForAccount(
				account.provider,
				ctx.provider,
			);
			if (!provider) continue;
			let finalBody: unknown;
			let token = "";
			let latestAccount = account;
			const home = conversation?.home;
			const replacingHome =
				home?.intentRevision === conversation?.revision &&
				home != null &&
				(home.target.accountId !== candidate.target.accountId ||
					home.target.physicalModel !== candidate.target.physicalModel ||
					home.target.line !== candidate.target.line);
			let latestHomeAccount: Account | null = null;
			let dispatchReplacement: QualityReplacementAuthority = null;
			const refreshHomeAccount = async () => {
				if (replacingHome && !hardReplacement)
					latestHomeAccount = await ctx.dbOps.getAccount(home.target.accountId);
			};
			const currentReplacement = (currentPolicy: QualityRoutingPolicy) =>
				hardReplacement ??
				replacementFor(
					conversation,
					currentPolicy,
					latestHomeAccount ? [latestHomeAccount] : [],
				);
			let accounting: QualityAdmissionDecision["accounting"];
			const check = () => {
				const currentPolicy = ctx.config.getQualityRoutingPolicy?.();
				const usage = usageCache.getSnapshot(account.id);
				if (
					req.signal.aborted ||
					!currentPolicy ||
					currentPolicy.revision !== candidate.policyRevision ||
					!usage ||
					latestAccount.requires_reauth ||
					latestAccount.provider !== account.provider ||
					latestAccount.created_at !== account.created_at ||
					latestAccount.api_key !== account.api_key ||
					(!account.api_key && latestAccount.access_token !== token) ||
					latestAccount.custom_endpoint !== account.custom_endpoint ||
					!isAccountAvailable(latestAccount)
				)
					throw new QualityAttemptRejected("changed-admission");
				// installHome is already durable after beginDispatch. If mutable home
				// evidence recovered meanwhile, refuse before sending rather than settle
				// a successful fallback under stale replacement authority. Recheck usage
				// and catalog synchronously again in assertDispatch after all awaits.
				if (fenced && dispatchReplacement && !currentReplacement(currentPolicy))
					throw new QualityAttemptRejected("home-recovered");
				const decision = evaluateQualityRouteAdmission({
					account: latestAccount,
					policy: currentPolicy,
					selectedCredentials: { account, accessToken: token },
					usage: {
						...usage,
						accountId: account.id,
						provider: account.provider,
					},
					request: {
						requirements,
						target: candidate.evidence,
						catalog: catalogFor(account.id, account.provider),
						finalBody,
						hostedTools: serverTools
							? {
									provider,
									context: {
										candidateId: candidate.id,
										account,
										path: url.pathname,
										query: input.serverToolQueryPresent ? "present" : "",
									},
								}
							: undefined,
					},
				});
				if (decision.status !== "admit") {
					recordSkip(candidate.target.lane, decision.reason);
					throw new QualityAttemptRejected(decision.reason);
				}
				accounting = decision.accounting;
			};
			let attemptDecision: QualityDecisionRecord | null = null;
			let settlement: ReturnType<typeof service.reserveObservedSettlement> =
				null;
			const settle = async (outcome: QualitySettlement) => {
				if (!lease || !fenced) return true;
				return (
					settlement?.settle(outcome, {
						requestId: meta.id,
						decision: attemptDecision,
					}) ?? false
				);
			};
			const hooks: QualityAttemptHooks = {
				target: candidate.target,
				policyRevision: candidate.policyRevision,
				get accounting() {
					return accounting;
				},
				async beforeDispatch(wire, accessToken) {
					if (dispatched || fenced || settlement)
						throw new QualityAttemptRejected("replay-forbidden");
					settlement = service.reserveObservedSettlement();
					if (!settlement)
						throw new QualityAttemptRejected("settlement-capacity");
					token = accessToken;
					finalBody = await wire.clone().json();
					const currentAccount = await ctx.dbOps.getAccount(account.id);
					if (!currentAccount)
						throw new QualityAttemptRejected("account-unavailable");
					latestAccount = currentAccount;
					check();
					if (conversation) {
						lease = await service.acquireLease(
							session,
							incarnation,
							conversation.key,
							conversation.revision,
						);
						await refreshHomeAccount();
						check();
						dispatchReplacement = replacingHome
							? currentReplacement(policy)
							: null;
						await settlement.bind(lease);
						await service.beginDispatch(
							lease,
							candidate.target,
							dispatchReplacement,
						);
						fenced = true;
						const finalAccount = await ctx.dbOps.getAccount(account.id);
						if (!finalAccount)
							throw new QualityAttemptRejected("account-unavailable");
						latestAccount = finalAccount;
						const current = await service.status(session);
						const currentConversation = current?.conversations.find(
							(item) => item.key === conversation.key,
						);
						if (
							current?.incarnation !== incarnation ||
							currentConversation?.revision !== conversation.revision ||
							currentConversation.homeVersion !== lease.expectedHomeVersion ||
							(conversation.key === "$root" && current.preference === null)
						)
							throw new QualityAttemptRejected("stale-intent");
						// Account rows are snapshots: read the exact old home again after
						// the fence, selected-account read and session-status await.
						await refreshHomeAccount();
					} else {
						// Null child identity is a request-only dispatch slot, not a guessed home.
						// Parent revision binds admission and recovery across process restarts.
						if (!status)
							throw new QualityAttemptRejected("parent-not-enrolled");
						lease = await service.acquireLease(
							session,
							incarnation,
							null,
							status.intentRevision,
						);
						await settlement.bind(lease);
						await service.beginDispatch(lease, candidate.target, null);
						fenced = true;
						const finalAccount = await ctx.dbOps.getAccount(account.id);
						if (!finalAccount)
							throw new QualityAttemptRejected("account-unavailable");
						latestAccount = finalAccount;
						const current = await service.status(session);
						if (
							current?.incarnation !== incarnation ||
							current.intentRevision !== lease.revision ||
							current.preference === null
						)
							throw new QualityAttemptRejected("parent-not-enrolled");
					}
					check();
					meta.qualityDecision = {
						version: 1,
						policyRevision: candidate.policyRevision,
						requested: intent,
						selected: candidate.target,
						skippedLanes: summaries(candidate.target.lane),
					};
					meta.qualityAccounting = accounting;
					attemptDecision = sanitizeQualityDecision({
						...meta.qualityDecision,
						accounting,
					});
				},
				assertDispatch() {
					if (dispatched) throw new QualityAttemptRejected("replay-forbidden");
					check();
					if (!shouldAllow(circuitKeyFor(account)))
						throw new QualityAttemptRejected("circuit-open");
					dispatched = true;
				},
				observeResponse(response) {
					noWork =
						ledger.hostedDispatchState === "undispatched" &&
						candidate.target.provider === "anthropic" &&
						response.status === 429 &&
						hasHardAnthropicAccountSignal(response);
					// Replay permission alone cannot evict a healthy home. Bind the
					// hard-account evidence to the exact home attempted and its CAS version.
					const home = conversation?.home;
					if (
						noWork &&
						lease &&
						home &&
						home.intentRevision === conversation?.revision &&
						home.version === lease.expectedHomeVersion &&
						home.target.accountId === candidate.target.accountId &&
						home.target.provider === candidate.target.provider &&
						home.target.physicalModel === candidate.target.physicalModel &&
						home.target.line === candidate.target.line
					)
						hardReplacement = {
							kind: "genuinely-unavailable",
							homeVersion: home.version,
						};
				},
				complete(outcome) {
					// Proven no-work bodies are discarded by this controller, which
					// awaits the failed settlement before advancing to another candidate.
					if (!noWork) void settle(outcome);
				},
			};
			try {
				const result = await proxyWithAccount(
					req,
					url,
					account,
					meta,
					body.getBuffer(),
					() => undefined,
					ledger.attemptedCount,
					ctx,
					candidate.target.physicalModel,
					apiKeyId,
					apiKeyName,
					body,
					true,
					undefined,
					ledger,
					{
						routeCandidateId: candidate.id,
						prepareFinalResponse: true,
						implicitFallbacksEnabled: false,
						isFinalSemanticAttempt: () => true,
						canReplayContextOverflow: () => false,
						recomputeServerToolCapability: true,
						qualityAttempt: hooks,
					},
					degraded,
				);
				if (isAnthropicDegradedSendDenied(result)) {
					return result.retainedTrustedResponse ?? unavailable("circuit-open");
				}
				if (noWork) {
					if (result) {
						if (isPreparedProxyAccountResponse(result)) await result.discard();
						else await result.body?.cancel();
					}
					if (!(await settle({ kind: "failed" })))
						return unavailable("unresolved-settlement");
					continue;
				}
				if (result && !dispatched) {
					if (isPreparedProxyAccountResponse(result)) await result.discard();
					else await result.body?.cancel();
					recordSkip(candidate.target.lane, "request-preservation-unknown");
					continue;
				}
				if (result) {
					return isPreparedProxyAccountResponse(result)
						? await result.commit()
						: result;
				}
				if (dispatched) return unavailable("ambiguous-upstream-outcome");
				if (fenced) {
					await settle({ kind: "failed" });
					return unavailable("pre-dispatch-state-changed");
				}
			} catch (error) {
				if (noWork && (await settle({ kind: "failed" }))) continue;
				if (dispatched) return unavailable("ambiguous-upstream-outcome");
				if (fenced) {
					await settle({ kind: "failed" });
					return unavailable("pre-dispatch-state-changed");
				}
				// The dispatch backstop rejects a non-first-party account before any
				// wire exists. That is a skip, never a whole-request failure.
				if (
					error instanceof ServerToolCandidateCapabilityError &&
					error.reason === "provider_unavailable" &&
					nativeRequirement
				) {
					advisorSkipped = true;
					recordSkip(candidate.target.lane, "tools-unsupported");
					continue;
				}
				if (!(error instanceof QualityAttemptRejected))
					return unavailable("attempt-unavailable");
			} finally {
				// Only a definitely unsent attempt can withdraw its reservation.
				// Ambiguous sends retain bounded ownership for a possible late callback;
				// neither memory cleanup nor a missing response supplies an outcome.
				if (!dispatched)
					(
						settlement as ReturnType<typeof service.reserveObservedSettlement>
					)?.release();
			}
		}
		if (nativeRequirement && advisorSkipped)
			return await refuseServerTool(
				createNativeAnthropicToolRoutingError(nativeRequirement),
			);
		await persistRejection();
		const response = unavailable(lastAdmissionReason);
		void recordRoutingTerminalRequest({
			collector: tryGetUsageCollector(),
			requestMeta: meta,
			requestHeaders: req.headers,
			response,
			providerName: ctx.provider.name,
			terminalKind: "quality_route_unavailable",
			upstreamAttempts: ledger.attemptedCount,
			apiKeyId,
			apiKeyName,
		});
		return response;
	} catch {
		return unavailable("durable-state-unavailable");
	}
}
