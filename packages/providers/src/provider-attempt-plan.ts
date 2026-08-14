import type { Account, ServerToolReplayAtom } from "@better-ccflare/types";
import type {
	CacheReplayModelStrategy,
	Provider,
	ProviderAttemptDataRetryPolicy,
	ProviderAttemptNoExecutionDecision,
	ProviderAttemptNoExecutionSnapshot,
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
	ProviderServerToolHistoryProjector,
	ProviderServerToolReplayIssuer,
	ProviderUsageInfo,
	RateLimitInfo,
} from "./types";

const REPLAY_ATOMS = new Set<ServerToolReplayAtom>([
	"native-Anthropic",
	"proxy-evidence-v1",
]);
const MAX_CUSTOM_RETRY_ATTEMPTS = 16;
export const MAX_PROVIDER_NO_EXECUTION_BODY_BYTES = 64 * 1024;
const PROVIDER_NO_EXECUTION_SNAPSHOT_BRAND = Symbol(
	"ProviderAttemptNoExecutionSnapshot",
);
const PROVIDER_NO_EXECUTION_SNAPSHOTS = new WeakSet<object>();
const EXECUTING_OR_AMBIGUOUS: ProviderAttemptNoExecutionDecision =
	Object.freeze({ decision: "executing_or_ambiguous" });
const NO_DATA_RETRY: ProviderAttemptDataRetryPolicy = Object.freeze({
	mode: "none",
	maxAttempts: 0,
});

type UnknownRecord = Record<string, unknown>;

interface CapturedProviderDescriptor {
	readonly providerName: string;
	readonly cacheReplayModelStrategy: CacheReplayModelStrategy;
	readonly createAttemptPlan: Provider["createAttemptPlan"];
	readonly prepareRequest: Provider["prepareRequest"];
	readonly buildUrl: Provider["buildUrl"];
	readonly prepareHeaders: Provider["prepareHeaders"];
	readonly transformRequestBody: Provider["transformRequestBody"];
	readonly processResponse: Provider["processResponse"];
	readonly parseRateLimit: Provider["parseRateLimit"];
	readonly parseRateLimitFromBody: Provider["parseRateLimitFromBody"];
	readonly isStreamingResponse: Provider["isStreamingResponse"];
	readonly extractTierInfo: Provider["extractTierInfo"];
	readonly extractUsageInfo: Provider["extractUsageInfo"];
	readonly parseUsage: Provider["parseUsage"];
}

type ValidatedProviderAttemptPlanContext = Readonly<{
	request: Request;
	requestBodyBuffer: ArrayBuffer | null;
	account: Account;
	path: string;
	query: string;
	physicalModel: string | null;
	capabilityProofKey: string | null;
	inputReplayMode: readonly ServerToolReplayAtom[];
	outputReplayMode: readonly ServerToolReplayAtom[];
	beforePhysicalTransport?: () => void;
	serverToolHistoryProjector?: ProviderServerToolHistoryProjector;
	serverToolReplayIssuer?: ProviderServerToolReplayIssuer;
}>;

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Invalid provider attempt plan ${field}`);
	}
	return value;
}

function normalizeNullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireNonEmptyString(value, field);
}

function normalizeReplayMode(value: unknown): readonly ServerToolReplayAtom[] {
	if (!Array.isArray(value)) {
		throw new TypeError("Invalid provider attempt plan replay mode");
	}
	const replayMode: ServerToolReplayAtom[] = [];
	const seen = new Set<ServerToolReplayAtom>();
	for (const atom of value) {
		if (!REPLAY_ATOMS.has(atom as ServerToolReplayAtom) || seen.has(atom)) {
			throw new TypeError("Invalid provider attempt plan replay mode");
		}
		seen.add(atom as ServerToolReplayAtom);
		replayMode.push(atom as ServerToolReplayAtom);
	}
	return Object.freeze(replayMode);
}

function normalizeDataRetryPolicy(
	value: unknown,
): ProviderAttemptDataRetryPolicy {
	if (!isRecord(value)) {
		throw new TypeError("Invalid provider attempt plan retry policy");
	}
	if (value.mode === "none" && value.maxAttempts === 0) {
		return NO_DATA_RETRY;
	}
	if (
		value.mode === "reuse-same-plan" &&
		Number.isInteger(value.maxAttempts) &&
		(value.maxAttempts as number) >= 1 &&
		(value.maxAttempts as number) <= MAX_CUSTOM_RETRY_ATTEMPTS
	) {
		return Object.freeze({
			mode: "reuse-same-plan",
			maxAttempts: value.maxAttempts as number,
		});
	}
	throw new TypeError("Invalid provider attempt plan retry policy");
}

function normalizeCacheReplayModelStrategy(
	value: unknown,
): CacheReplayModelStrategy {
	if (value === "normalized-source" || value === "transformed-body") {
		return value;
	}
	throw new TypeError("Invalid provider attempt plan cache replay strategy");
}

function requireFunction<T extends (...args: never[]) => unknown>(
	value: unknown,
	field: string,
): T {
	if (typeof value !== "function") {
		throw new TypeError(`Invalid provider attempt plan ${field}`);
	}
	return value as T;
}

function optionalFunction<T extends (...args: never[]) => unknown>(
	value: unknown,
	field: string,
): T | undefined {
	if (value === undefined) return undefined;
	return requireFunction<T>(value, field);
}

function snapshotServerToolHistoryProjector(
	value: unknown,
): ProviderServerToolHistoryProjector | undefined {
	const projector = optionalFunction<ProviderServerToolHistoryProjector>(
		value,
		"serverToolHistoryProjector",
	);
	if (projector === undefined) return undefined;
	return Object.freeze((messages: unknown) =>
		Reflect.apply(projector, undefined, [messages]),
	);
}

function snapshotServerToolReplayIssuer(
	value: unknown,
): ProviderServerToolReplayIssuer | undefined {
	const issuer = optionalFunction<ProviderServerToolReplayIssuer>(
		value,
		"serverToolReplayIssuer",
	);
	if (issuer === undefined) return undefined;
	return Object.freeze((binding, payload) =>
		Reflect.apply(issuer, undefined, [binding, payload]),
	);
}

function captureProviderDescriptor(
	provider: Provider,
): Readonly<CapturedProviderDescriptor> {
	const providerName = requireNonEmptyString(provider.name, "providerName");
	const rawCacheReplayModelStrategy = provider.cacheReplayModelStrategy;
	const createAttemptPlan = optionalFunction<
		NonNullable<Provider["createAttemptPlan"]>
	>(provider.createAttemptPlan, "createAttemptPlan");
	const prepareRequest = optionalFunction<
		NonNullable<Provider["prepareRequest"]>
	>(provider.prepareRequest, "prepareRequest");
	const buildUrl = requireFunction<Provider["buildUrl"]>(
		provider.buildUrl,
		"buildUrl",
	);
	const prepareHeaders = requireFunction<Provider["prepareHeaders"]>(
		provider.prepareHeaders,
		"prepareHeaders",
	);
	const transformRequestBody = optionalFunction<
		NonNullable<Provider["transformRequestBody"]>
	>(provider.transformRequestBody, "transformRequestBody");
	const processResponse = requireFunction<Provider["processResponse"]>(
		provider.processResponse,
		"processResponse",
	);
	const parseRateLimit = requireFunction<Provider["parseRateLimit"]>(
		provider.parseRateLimit,
		"parseRateLimit",
	);
	const parseRateLimitFromBody = optionalFunction<
		NonNullable<Provider["parseRateLimitFromBody"]>
	>(provider.parseRateLimitFromBody, "parseRateLimitFromBody");
	const isStreamingResponse = optionalFunction<
		NonNullable<Provider["isStreamingResponse"]>
	>(provider.isStreamingResponse, "isStreamingResponse");
	const extractTierInfo = optionalFunction<
		NonNullable<Provider["extractTierInfo"]>
	>(provider.extractTierInfo, "extractTierInfo");
	const extractUsageInfo = optionalFunction<
		NonNullable<Provider["extractUsageInfo"]>
	>(provider.extractUsageInfo, "extractUsageInfo");
	const parseUsage = optionalFunction<NonNullable<Provider["parseUsage"]>>(
		provider.parseUsage,
		"parseUsage",
	);

	return Object.freeze({
		providerName,
		cacheReplayModelStrategy:
			rawCacheReplayModelStrategy === undefined
				? "normalized-source"
				: normalizeCacheReplayModelStrategy(rawCacheReplayModelStrategy),
		createAttemptPlan,
		prepareRequest,
		buildUrl,
		prepareHeaders,
		transformRequestBody,
		processResponse,
		parseRateLimit,
		parseRateLimitFromBody,
		isStreamingResponse,
		extractTierInfo,
		extractUsageInfo,
		parseUsage,
	});
}

function requireStableProviderDescriptor(
	provider: Provider,
	expected: Readonly<CapturedProviderDescriptor>,
): void {
	const current = captureProviderDescriptor(provider);
	if (
		current.providerName !== expected.providerName ||
		current.cacheReplayModelStrategy !== expected.cacheReplayModelStrategy ||
		current.createAttemptPlan !== expected.createAttemptPlan ||
		current.prepareRequest !== expected.prepareRequest ||
		current.buildUrl !== expected.buildUrl ||
		current.prepareHeaders !== expected.prepareHeaders ||
		current.transformRequestBody !== expected.transformRequestBody ||
		current.processResponse !== expected.processResponse ||
		current.parseRateLimit !== expected.parseRateLimit ||
		current.parseRateLimitFromBody !== expected.parseRateLimitFromBody ||
		current.isStreamingResponse !== expected.isStreamingResponse ||
		current.extractTierInfo !== expected.extractTierInfo ||
		current.extractUsageInfo !== expected.extractUsageInfo ||
		current.parseUsage !== expected.parseUsage
	) {
		throw new TypeError("Provider attempt descriptor changed during planning");
	}
}

function normalizeTargetUrl(
	value: unknown,
	legacyProviderName?: string,
): string {
	const targetUrl = requireNonEmptyString(value, "targetUrl");
	// Bedrock's legacy adapter dispatches through the AWS SDK and uses this
	// provider-owned scheme only as the Request-compatible transport target.
	const isLegacyBedrockTarget =
		legacyProviderName === "bedrock" && targetUrl.startsWith("bedrock://");
	let parsed: URL;
	try {
		parsed = new URL(targetUrl);
	} catch {
		throw new TypeError("Invalid provider attempt plan targetUrl");
	}
	if (
		parsed.protocol !== "http:" &&
		parsed.protocol !== "https:" &&
		!(
			isLegacyBedrockTarget &&
			parsed.protocol === "bedrock:" &&
			parsed.hostname.length > 0 &&
			parsed.username.length === 0 &&
			parsed.password.length === 0 &&
			parsed.hash.length === 0
		)
	) {
		throw new TypeError("Invalid provider attempt plan targetUrl");
	}
	return targetUrl;
}

function normalizeNoExecutionDecision(
	value: unknown,
): ProviderAttemptNoExecutionDecision {
	if (!isRecord(value)) {
		throw new TypeError("Invalid provider no-execution decision");
	}
	if (value.decision === "executing_or_ambiguous") {
		return EXECUTING_OR_AMBIGUOUS;
	}
	if (value.decision === "proven_no_execution") {
		return Object.freeze({
			decision: "proven_no_execution",
			reason: requireNonEmptyString(value.reason, "no-execution reason"),
		});
	}
	throw new TypeError("Invalid provider no-execution decision");
}

function normalizeNoExecutionHeaders(
	headersInit: HeadersInit,
): readonly (readonly [name: string, value: string])[] {
	const headers = new Headers(headersInit);
	const entries: Array<readonly [string, string]> = [];
	headers.forEach((value, name) => {
		entries.push(Object.freeze([name, value] as const));
	});
	entries.sort(([leftName, leftValue], [rightName, rightValue]) => {
		const nameOrder = leftName.localeCompare(rightName);
		return nameOrder === 0 ? leftValue.localeCompare(rightValue) : nameOrder;
	});
	return Object.freeze(entries);
}

/**
 * Canonicalize already-bounded response metadata without retaining or reading
 * a live Response. Callers must choose and record truncation before invoking
 * provider-owned classification.
 */
export function createProviderAttemptNoExecutionSnapshot(input: {
	readonly status: number;
	readonly headers: HeadersInit;
	readonly bodyText: string;
	readonly bodyTruncated: boolean;
}): ProviderAttemptNoExecutionSnapshot {
	if (!isRecord(input)) {
		throw new TypeError("Invalid provider no-execution snapshot");
	}
	if (
		!Number.isInteger(input.status) ||
		input.status < 100 ||
		input.status > 599
	) {
		throw new TypeError("Invalid provider no-execution snapshot status");
	}
	if (typeof input.bodyText !== "string") {
		throw new TypeError("Invalid provider no-execution snapshot body");
	}
	if (
		new TextEncoder().encode(input.bodyText).byteLength >
		MAX_PROVIDER_NO_EXECUTION_BODY_BYTES
	) {
		throw new TypeError("Provider no-execution snapshot body exceeds limit");
	}
	if (typeof input.bodyTruncated !== "boolean") {
		throw new TypeError("Invalid provider no-execution snapshot truncation");
	}

	const snapshot = {
		status: input.status,
		headers: normalizeNoExecutionHeaders(input.headers),
		bodyText: input.bodyText,
		bodyTruncated: input.bodyTruncated,
		[PROVIDER_NO_EXECUTION_SNAPSHOT_BRAND]: true,
	};
	PROVIDER_NO_EXECUTION_SNAPSHOTS.add(snapshot);
	return Object.freeze(
		snapshot,
	) as unknown as ProviderAttemptNoExecutionSnapshot;
}

function requireNoExecutionSnapshot(
	value: unknown,
): asserts value is ProviderAttemptNoExecutionSnapshot {
	if (
		!isRecord(value) ||
		(
			value as UnknownRecord & {
				[PROVIDER_NO_EXECUTION_SNAPSHOT_BRAND]?: unknown;
			}
		)[PROVIDER_NO_EXECUTION_SNAPSHOT_BRAND] !== true ||
		!PROVIDER_NO_EXECUTION_SNAPSHOTS.has(value) ||
		!Object.isFrozen(value)
	) {
		throw new TypeError("Invalid provider no-execution snapshot brand");
	}
}

function isThenable(value: unknown): boolean {
	return (
		(value !== null &&
			(typeof value === "object" || typeof value === "function") &&
			typeof (value as { then?: unknown }).then === "function") ||
		false
	);
}

function sameReplayMode(
	left: readonly ServerToolReplayAtom[],
	right: readonly ServerToolReplayAtom[],
): boolean {
	return (
		left.length === right.length &&
		left.every((atom, index) => atom === right[index])
	);
}

function readOwnAccountValue(account: Account, field: keyof Account): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(account, field);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return descriptor.value;
}

function readAccountString(account: Account, field: keyof Account): string {
	const value = readOwnAccountValue(account, field);
	if (typeof value !== "string") {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return value;
}

function readAccountNullableString(
	account: Account,
	field: keyof Account,
): string | null {
	const value = readOwnAccountValue(account, field);
	if (value !== null && typeof value !== "string") {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return value;
}

function readAccountNumber(account: Account, field: keyof Account): number {
	const value = readOwnAccountValue(account, field);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return value;
}

function readAccountNullableNumber(
	account: Account,
	field: keyof Account,
): number | null {
	const value = readOwnAccountValue(account, field);
	if (
		value !== null &&
		(typeof value !== "number" || !Number.isFinite(value))
	) {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return value;
}

function readAccountBoolean(account: Account, field: keyof Account): boolean {
	const value = readOwnAccountValue(account, field);
	if (typeof value !== "boolean") {
		throw new TypeError(`Invalid provider attempt account field ${field}`);
	}
	return value;
}

function createScalarAccountView(account: Account): Account {
	const accountView: Account = {
		id: readAccountString(account, "id"),
		name: readAccountString(account, "name"),
		provider: readAccountString(account, "provider"),
		api_key: readAccountNullableString(account, "api_key"),
		refresh_token: readAccountNullableString(account, "refresh_token"),
		access_token: readAccountNullableString(account, "access_token"),
		expires_at: readAccountNullableNumber(account, "expires_at"),
		request_count: readAccountNumber(account, "request_count"),
		total_requests: readAccountNumber(account, "total_requests"),
		last_used: readAccountNullableNumber(account, "last_used"),
		created_at: readAccountNumber(account, "created_at"),
		rate_limited_until: readAccountNullableNumber(
			account,
			"rate_limited_until",
		),
		rate_limited_reason: readAccountNullableString(
			account,
			"rate_limited_reason",
		) as Account["rate_limited_reason"],
		rate_limited_at: readAccountNullableNumber(account, "rate_limited_at"),
		session_start: readAccountNullableNumber(account, "session_start"),
		session_request_count: readAccountNumber(account, "session_request_count"),
		paused: readAccountBoolean(account, "paused"),
		requires_reauth: readAccountBoolean(account, "requires_reauth"),
		rate_limit_reset: readAccountNullableNumber(account, "rate_limit_reset"),
		rate_limit_status: readAccountNullableString(account, "rate_limit_status"),
		rate_limit_remaining: readAccountNullableNumber(
			account,
			"rate_limit_remaining",
		),
		priority: readAccountNumber(account, "priority"),
		auto_fallback_enabled: readAccountBoolean(account, "auto_fallback_enabled"),
		auto_refresh_enabled: readAccountBoolean(account, "auto_refresh_enabled"),
		auto_pause_on_overage_enabled: readAccountBoolean(
			account,
			"auto_pause_on_overage_enabled",
		),
		peak_hours_pause_enabled: readAccountBoolean(
			account,
			"peak_hours_pause_enabled",
		),
		custom_endpoint: readAccountNullableString(account, "custom_endpoint"),
		model_mappings: readAccountNullableString(account, "model_mappings"),
		cross_region_mode: readAccountNullableString(account, "cross_region_mode"),
		model_fallbacks: readAccountNullableString(account, "model_fallbacks"),
		billing_type: readAccountNullableString(account, "billing_type"),
		pause_reason: readAccountNullableString(account, "pause_reason"),
		refresh_token_issued_at: readAccountNullableNumber(
			account,
			"refresh_token_issued_at",
		),
		consecutive_rate_limits: readAccountNumber(
			account,
			"consecutive_rate_limits",
		),
	};
	return accountView;
}

function validateLegacyAccountView(
	accountView: Account,
	accountSchemaKeys: ReadonlySet<PropertyKey>,
): void {
	createScalarAccountView(accountView);
	for (const key of Reflect.ownKeys(accountView)) {
		if (accountSchemaKeys.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(accountView, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			throw new TypeError("Invalid provider attempt account temporary field");
		}
		const value = descriptor.value;
		if (
			(value !== null && typeof value === "object") ||
			typeof value === "function"
		) {
			throw new TypeError("Invalid provider attempt account temporary field");
		}
	}
}

function validateContext(
	context: ProviderAttemptPlanContext,
): ValidatedProviderAttemptPlanContext {
	if (!isRecord(context) || !(context.request instanceof Request)) {
		throw new TypeError("Invalid provider attempt plan context");
	}
	if (
		context.requestBodyBuffer !== null &&
		!(context.requestBodyBuffer instanceof ArrayBuffer)
	) {
		throw new TypeError("Invalid provider attempt plan request body");
	}
	if (!isRecord(context.account)) {
		throw new TypeError("Invalid provider attempt plan account");
	}
	return {
		request: context.request,
		requestBodyBuffer: context.requestBodyBuffer,
		account: context.account,
		path: requireNonEmptyString(context.path, "path"),
		query:
			typeof context.query === "string"
				? context.query
				: requireNonEmptyString(context.query, "query"),
		physicalModel: normalizeNullableString(
			context.physicalModel,
			"physicalModel",
		),
		capabilityProofKey: normalizeNullableString(
			context.capabilityProofKey,
			"capabilityProofKey",
		),
		inputReplayMode: normalizeReplayMode(context.inputReplayMode),
		outputReplayMode: normalizeReplayMode(context.outputReplayMode),
		beforePhysicalTransport:
			context.beforePhysicalTransport === undefined
				? undefined
				: requireFunction<() => void>(
						context.beforePhysicalTransport,
						"beforePhysicalTransport",
					),
		serverToolHistoryProjector: snapshotServerToolHistoryProjector(
			context.serverToolHistoryProjector,
		),
		serverToolReplayIssuer: snapshotServerToolReplayIssuer(
			context.serverToolReplayIssuer,
		),
	};
}

function copyPlanningInputs(
	context: ValidatedProviderAttemptPlanContext,
): ValidatedProviderAttemptPlanContext {
	if (context.request.bodyUsed) {
		throw new TypeError("Unable to copy provider attempt plan request");
	}
	let requestBodyBuffer: ArrayBuffer | null = null;
	if (context.requestBodyBuffer !== null) {
		try {
			requestBodyBuffer = new Uint8Array(context.requestBodyBuffer).slice()
				.buffer;
		} catch {
			throw new TypeError("Unable to copy provider attempt plan request body");
		}
	}
	let request: Request;
	try {
		request = context.request.clone();
	} catch {
		throw new TypeError("Unable to copy provider attempt plan request");
	}
	return {
		...context,
		request,
		requestBodyBuffer,
	};
}

function materializeCustomPlan(
	provider: Provider,
	context: ValidatedProviderAttemptPlanContext,
	providerDescriptor: Readonly<CapturedProviderDescriptor>,
): ProviderAttemptPlan {
	const planningContext: ProviderAttemptPlanContext = Object.freeze({
		...context,
		account: Object.freeze(createScalarAccountView(context.account)),
	});
	const createAttemptPlan = providerDescriptor.createAttemptPlan;
	if (createAttemptPlan === undefined) {
		throw new TypeError(
			"Provider attempt descriptor missing createAttemptPlan",
		);
	}
	const candidate = Reflect.apply(createAttemptPlan, provider, [
		planningContext,
	]) as unknown;
	requireStableProviderDescriptor(provider, providerDescriptor);
	if (isThenable(candidate)) {
		throw new TypeError("Provider attempt planner must be synchronous");
	}
	if (!isRecord(candidate)) {
		throw new TypeError("Invalid provider attempt plan");
	}

	const providerName = requireNonEmptyString(
		candidate.providerName,
		"providerName",
	);
	if (providerName !== providerDescriptor.providerName) {
		throw new TypeError("Provider attempt plan providerName mismatch");
	}
	const physicalModel = normalizeNullableString(
		candidate.physicalModel,
		"physicalModel",
	);
	const capabilityProofKey = normalizeNullableString(
		candidate.capabilityProofKey,
		"capabilityProofKey",
	);
	const inputReplayMode = normalizeReplayMode(candidate.inputReplayMode);
	const outputReplayMode = normalizeReplayMode(candidate.outputReplayMode);
	if (
		physicalModel !== context.physicalModel ||
		capabilityProofKey !== context.capabilityProofKey ||
		!sameReplayMode(inputReplayMode, context.inputReplayMode) ||
		!sameReplayMode(outputReplayMode, context.outputReplayMode)
	) {
		throw new TypeError("Provider attempt plan context mismatch");
	}

	const rawClassifier = requireFunction<
		(snapshot: ProviderAttemptNoExecutionSnapshot) => unknown
	>(candidate.classifyNoExecution, "classifyNoExecution");
	const rawPrepareHeaders = requireFunction<
		(headers: Headers, accessToken?: string, apiKey?: string) => Headers
	>(candidate.prepareHeaders, "prepareHeaders");
	const rawTransformRequestBody = requireFunction<
		(request: Request) => Promise<Request>
	>(candidate.transformRequestBody, "transformRequestBody");
	const rawProcessResponse = requireFunction<
		(response: Response, requestHeaders?: Headers) => Promise<Response>
	>(candidate.processResponse, "processResponse");
	const rawParseRateLimit = requireFunction<
		(response: Response) => RateLimitInfo
	>(candidate.parseRateLimit, "parseRateLimit");
	const rawParseRateLimitFromBody = optionalFunction<
		(response: Response) => Promise<number | undefined>
	>(candidate.parseRateLimitFromBody, "parseRateLimitFromBody");
	const rawIsStreamingResponse = optionalFunction<
		(response: Response) => boolean
	>(candidate.isStreamingResponse, "isStreamingResponse");
	const rawExtractTierInfo = optionalFunction<
		(response: Response) => Promise<number | null>
	>(candidate.extractTierInfo, "extractTierInfo");
	const rawExtractUsageInfo = optionalFunction<
		(response: Response) => Promise<ProviderUsageInfo | null>
	>(candidate.extractUsageInfo, "extractUsageInfo");
	const rawParseUsage = optionalFunction<
		(response: Response) => Promise<ProviderUsageInfo | null>
	>(candidate.parseUsage, "parseUsage");

	let plan: ProviderAttemptPlan;
	plan = {
		providerName,
		targetUrl: normalizeTargetUrl(candidate.targetUrl),
		apiFamily: requireNonEmptyString(candidate.apiFamily, "apiFamily"),
		physicalModel,
		capabilityProofKey,
		inputReplayMode,
		outputReplayMode,
		dataRetryPolicy: normalizeDataRetryPolicy(candidate.dataRetryPolicy),
		classifyNoExecution: async (snapshot) => {
			requireNoExecutionSnapshot(snapshot);
			return normalizeNoExecutionDecision(
				await Reflect.apply(rawClassifier, plan, [snapshot]),
			);
		},
		cacheReplayModelStrategy: normalizeCacheReplayModelStrategy(
			candidate.cacheReplayModelStrategy,
		),
		prepareHeaders: (headers, accessToken, apiKey) =>
			Reflect.apply(rawPrepareHeaders, plan, [headers, accessToken, apiKey]),
		transformRequestBody: (request) =>
			Reflect.apply(rawTransformRequestBody, plan, [request]),
		processResponse: (response, requestHeaders) =>
			Reflect.apply(rawProcessResponse, plan, [response, requestHeaders]),
		parseRateLimit: (response) =>
			Reflect.apply(rawParseRateLimit, plan, [response]),
		...(rawParseRateLimitFromBody
			? {
					parseRateLimitFromBody: (response: Response) =>
						Reflect.apply(rawParseRateLimitFromBody, plan, [response]),
				}
			: {}),
		...(rawIsStreamingResponse
			? {
					isStreamingResponse: (response: Response) =>
						Reflect.apply(rawIsStreamingResponse, plan, [response]),
				}
			: {}),
		...(rawExtractTierInfo
			? {
					extractTierInfo: (response: Response) =>
						Reflect.apply(rawExtractTierInfo, plan, [response]),
				}
			: {}),
		...(rawExtractUsageInfo
			? {
					extractUsageInfo: (response: Response) =>
						Reflect.apply(rawExtractUsageInfo, plan, [response]),
				}
			: {}),
		...(rawParseUsage
			? {
					parseUsage: (response: Response) =>
						Reflect.apply(rawParseUsage, plan, [response]),
				}
			: {}),
	};
	return Object.freeze(plan);
}

function materializeLegacyPlan(
	provider: Provider,
	context: ValidatedProviderAttemptPlanContext,
	providerDescriptor: Readonly<CapturedProviderDescriptor>,
): ProviderAttemptPlan {
	const accountView = createScalarAccountView(context.account);
	const accountSchemaKeys = new Set<PropertyKey>(Reflect.ownKeys(accountView));
	const {
		prepareRequest,
		buildUrl,
		prepareHeaders,
		transformRequestBody,
		processResponse,
		parseRateLimit,
		parseRateLimitFromBody,
		isStreamingResponse,
		extractTierInfo,
		extractUsageInfo,
		parseUsage,
	} = providerDescriptor;

	let targetUrl: string;
	try {
		if (prepareRequest) {
			const prepared = Reflect.apply(prepareRequest, provider, [
				context.request,
				context.requestBodyBuffer,
				accountView,
			]);
			if (isThenable(prepared)) {
				throw new TypeError(
					"Legacy provider prepareRequest must be synchronous",
				);
			}
			validateLegacyAccountView(accountView, accountSchemaKeys);
			requireStableProviderDescriptor(provider, providerDescriptor);
		}
		targetUrl = Reflect.apply(buildUrl, provider, [
			context.path,
			context.query,
			accountView,
		]);
		validateLegacyAccountView(accountView, accountSchemaKeys);
		requireStableProviderDescriptor(provider, providerDescriptor);
	} finally {
		Object.freeze(accountView);
	}

	const plan: ProviderAttemptPlan = {
		providerName: providerDescriptor.providerName,
		targetUrl: normalizeTargetUrl(targetUrl, providerDescriptor.providerName),
		apiFamily: `legacy:${providerDescriptor.providerName}`,
		physicalModel: context.physicalModel,
		capabilityProofKey: context.capabilityProofKey,
		inputReplayMode: context.inputReplayMode,
		outputReplayMode: context.outputReplayMode,
		dataRetryPolicy: NO_DATA_RETRY,
		classifyNoExecution: async (snapshot) => {
			requireNoExecutionSnapshot(snapshot);
			return EXECUTING_OR_AMBIGUOUS;
		},
		cacheReplayModelStrategy: providerDescriptor.cacheReplayModelStrategy,
		prepareHeaders: (headers, accessToken, apiKey) =>
			Reflect.apply(prepareHeaders, provider, [headers, accessToken, apiKey]),
		transformRequestBody: transformRequestBody
			? (request) =>
					Reflect.apply(transformRequestBody, provider, [
						request,
						accountView,
						context.beforePhysicalTransport,
					])
			: async (request) => request,
		processResponse: (response, requestHeaders) =>
			Reflect.apply(processResponse, provider, [
				response,
				accountView,
				requestHeaders,
			]),
		parseRateLimit: (response) =>
			Reflect.apply(parseRateLimit, provider, [response]),
		...(parseRateLimitFromBody
			? {
					parseRateLimitFromBody: (response: Response) =>
						Reflect.apply(parseRateLimitFromBody, provider, [response]),
				}
			: {}),
		...(isStreamingResponse
			? {
					isStreamingResponse: (response: Response) =>
						Reflect.apply(isStreamingResponse, provider, [response]),
				}
			: {}),
		...(extractTierInfo
			? {
					extractTierInfo: (response: Response) =>
						Reflect.apply(extractTierInfo, provider, [response]),
				}
			: {}),
		...(extractUsageInfo
			? {
					extractUsageInfo: (response: Response) =>
						Reflect.apply(extractUsageInfo, provider, [response]),
				}
			: {}),
		...(parseUsage
			? {
					parseUsage: (response: Response) =>
						Reflect.apply(parseUsage, provider, [response]),
				}
			: {}),
	};
	return Object.freeze(plan);
}

/**
 * Materialize one immutable transport decision before credential refresh or
 * dispatch. This function is intentionally synchronous; a Promise or thenable
 * planner is rejected instead of letting request-scoped state escape.
 */
export function materializeProviderAttemptPlan(
	provider: Provider,
	context: ProviderAttemptPlanContext,
): ProviderAttemptPlan {
	const validatedContext = validateContext(context);
	const providerDescriptor = captureProviderDescriptor(provider);
	requireStableProviderDescriptor(provider, providerDescriptor);
	const useCustomPlanner =
		validatedContext.capabilityProofKey !== null &&
		providerDescriptor.createAttemptPlan !== undefined;
	// Defensive body-sized copies exist only for hooks that can observe them.
	const planningContext =
		useCustomPlanner || providerDescriptor.prepareRequest !== undefined
			? copyPlanningInputs(validatedContext)
			: validatedContext;
	if (useCustomPlanner) {
		return materializeCustomPlan(provider, planningContext, providerDescriptor);
	}
	return materializeLegacyPlan(provider, planningContext, providerDescriptor);
}
