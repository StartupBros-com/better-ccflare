export const MODEL_ROUTE_PROFILES_ENV =
	"CCFLARE_MODEL_ROUTE_PROFILES_JSON" as const;
export const MODEL_ROUTE_PROFILE_MODEL_PREFIX = "claude-bccf-route-" as const;

const MAX_PROFILES = 32;
const MAX_ID_LENGTH = 48;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ACCOUNT_ID_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 64;
const DEFAULT_TTL_MS = 5 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;

const PROFILE_KEYS = new Set([
	"id",
	"displayName",
	"description",
	"accountId",
	"selection",
	"logicalModel",
	"defaultEffort",
	"expectedProvider",
	"expectedPhysicalModel",
	"exclusiveAccount",
	"contextWindow",
	"maxOutputTokens",
]);

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelRouteEffort = (typeof EFFORTS)[number];

/**
 * How a route profile chooses its upstream account.  Profiles created before
 * capability routing existed omit this field and retain their exact-account
 * semantics.  Capability profiles deliberately carry no account id: the
 * selector resolves the current eligible account pool at request time.
 */
export type ModelRouteSelection = "capability";

export interface ModelRouteProfile {
	readonly id: string;
	readonly publicModelId: string;
	readonly displayName: string;
	readonly description?: string;
	readonly accountId?: string;
	readonly selection?: ModelRouteSelection;
	readonly logicalModel: string;
	readonly defaultEffort?: ModelRouteEffort;
	readonly expectedProvider?: string;
	readonly expectedPhysicalModel?: string;
	/** An account reserved for exact configured route profiles. */
	readonly exclusiveAccount?: boolean;
	/** Maximum total input and output tokens for an explicit bounded profile. */
	readonly contextWindow?: number;
	/** Maximum response tokens for an explicit bounded profile. */
	readonly maxOutputTokens?: number;
}

export type BoundedModelRouteProfile = ModelRouteProfile & {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
};

export function isBoundedModelRouteProfile(
	profile: ModelRouteProfile,
): profile is BoundedModelRouteProfile {
	return (
		profile.contextWindow !== undefined && profile.maxOutputTokens !== undefined
	);
}

function configError(message: string): Error {
	return new Error(`${MODEL_ROUTE_PROFILES_ENV}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function requiredString(
	entry: Record<string, unknown>,
	key: string,
	index: number,
	maxLength: number,
): string {
	const value = entry[key];
	if (typeof value !== "string") {
		throw configError(`profile ${index} field ${key} must be a string`);
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength) {
		throw configError(
			`profile ${index} field ${key} must be 1-${maxLength} characters`,
		);
	}
	return trimmed;
}

function optionalString(
	entry: Record<string, unknown>,
	key: string,
	index: number,
	maxLength: number,
): string | undefined {
	if (!(key in entry)) return undefined;
	return requiredString(entry, key, index, maxLength);
}

function optionalBoolean(
	entry: Record<string, unknown>,
	key: string,
	index: number,
): boolean | undefined {
	if (!(key in entry)) return undefined;
	const value = entry[key];
	if (typeof value !== "boolean") {
		throw configError(`profile ${index} field ${key} must be a boolean`);
	}
	return value;
}

function optionalPositiveInteger(
	entry: Record<string, unknown>,
	key: string,
	index: number,
): number | undefined {
	if (!(key in entry)) return undefined;
	const value = entry[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw configError(
			`profile ${index} field ${key} must be a positive integer`,
		);
	}
	return value;
}

/**
 * Parse restart-scoped route profiles from their environment representation.
 * A malformed non-empty value is a startup error: silently dropping an
 * operator-requested force route could send traffic to an unintended account.
 */
export function parseModelRouteProfiles(
	raw: string | undefined = typeof process === "undefined"
		? undefined
		: process.env[MODEL_ROUTE_PROFILES_ENV],
): readonly ModelRouteProfile[] {
	if (raw === undefined || raw.trim() === "") return [];

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw configError(
			`must be valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!Array.isArray(value)) {
		throw configError("must be a JSON array");
	}
	if (value.length > MAX_PROFILES) {
		throw configError(`must contain at most ${MAX_PROFILES} profiles`);
	}

	const ids = new Set<string>();
	const publicIds = new Set<string>();
	return value.map((candidate, index) => {
		if (!isPlainObject(candidate)) {
			throw configError(`profile ${index} must be an object`);
		}
		for (const key of Object.keys(candidate)) {
			if (!PROFILE_KEYS.has(key)) {
				throw configError(`profile ${index} contains unknown field ${key}`);
			}
		}

		const id = requiredString(candidate, "id", index, MAX_ID_LENGTH);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
			throw configError(
				`profile ${index} field id must be a lowercase kebab-case slug`,
			);
		}
		const publicModelId = `${MODEL_ROUTE_PROFILE_MODEL_PREFIX}${id}`;
		if (ids.has(id) || publicIds.has(publicModelId)) {
			throw configError(`duplicate profile or public model id: ${id}`);
		}
		ids.add(id);
		publicIds.add(publicModelId);

		const defaultEffortValue = candidate.defaultEffort;
		let defaultEffort: ModelRouteEffort | undefined;
		if (defaultEffortValue !== undefined) {
			if (
				typeof defaultEffortValue !== "string" ||
				!(EFFORTS as readonly string[]).includes(defaultEffortValue)
			) {
				throw configError(
					`profile ${index} field defaultEffort must be one of ${EFFORTS.join(", ")}`,
				);
			}
			defaultEffort = defaultEffortValue as ModelRouteEffort;
		}

		const selectionValue = candidate.selection;
		let selection: ModelRouteSelection | undefined;
		if (selectionValue !== undefined) {
			if (selectionValue !== "capability") {
				throw configError(
					`profile ${index} field selection must be capability`,
				);
			}
			selection = selectionValue;
		}
		const accountId = optionalString(
			candidate,
			"accountId",
			index,
			MAX_ACCOUNT_ID_LENGTH,
		);
		if (selection === "capability" && accountId !== undefined) {
			throw configError(
				`profile ${index} capability selection must omit accountId`,
			);
		}
		if (selection !== "capability" && accountId === undefined) {
			throw configError(
				`profile ${index} accountId is required unless selection is capability`,
			);
		}

		const exclusiveAccount = optionalBoolean(
			candidate,
			"exclusiveAccount",
			index,
		);
		if (selection === "capability" && exclusiveAccount !== undefined) {
			throw configError(
				`profile ${index} capability selection must omit exclusiveAccount`,
			);
		}

		const contextWindow = optionalPositiveInteger(
			candidate,
			"contextWindow",
			index,
		);
		const maxOutputTokens = optionalPositiveInteger(
			candidate,
			"maxOutputTokens",
			index,
		);
		if ((contextWindow === undefined) !== (maxOutputTokens === undefined)) {
			throw configError(
				`profile ${index} fields contextWindow and maxOutputTokens must be provided together`,
			);
		}
		if (selection === "capability" && contextWindow !== undefined) {
			throw configError(
				`profile ${index} capability selection must omit contextWindow and maxOutputTokens`,
			);
		}
		if (
			contextWindow !== undefined &&
			maxOutputTokens !== undefined &&
			maxOutputTokens >= contextWindow
		) {
			throw configError(
				`profile ${index} field maxOutputTokens must be less than contextWindow`,
			);
		}

		const expectedProvider = optionalString(
			candidate,
			"expectedProvider",
			index,
			MAX_PROVIDER_LENGTH,
		)?.toLowerCase();
		const expectedPhysicalModel = optionalString(
			candidate,
			"expectedPhysicalModel",
			index,
			MAX_MODEL_ID_LENGTH,
		);
		if (selection === "capability") {
			if (!expectedProvider) {
				throw configError(
					`profile ${index} capability selection requires expectedProvider`,
				);
			}
			if (!expectedPhysicalModel) {
				throw configError(
					`profile ${index} capability selection requires expectedPhysicalModel`,
				);
			}
		}

		return {
			id,
			publicModelId,
			displayName: requiredString(
				candidate,
				"displayName",
				index,
				MAX_DISPLAY_NAME_LENGTH,
			),
			description: optionalString(
				candidate,
				"description",
				index,
				MAX_DESCRIPTION_LENGTH,
			),
			...(accountId === undefined ? {} : { accountId }),
			...(selection === undefined ? {} : { selection }),
			...(exclusiveAccount === undefined ? {} : { exclusiveAccount }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
			logicalModel: requiredString(
				candidate,
				"logicalModel",
				index,
				MAX_MODEL_ID_LENGTH,
			),
			defaultEffort,
			expectedProvider,
			expectedPhysicalModel,
		};
	});
}

interface ModelRouteSessionState {
	readonly profile: ModelRouteProfile;
	readonly touchedAt: number;
}

interface ModelRouteRootIntentState {
	readonly generation: number;
	readonly reservedAt: number;
}

export interface ModelRouteRootIntentInput {
	/** Stable non-secret identity derived by the authenticated caller layer. */
	readonly callerIdentity: string | null | undefined;
	readonly sessionId: string | null | undefined;
	/** Server-derived Claude Code child-agent classification. */
	readonly isSubagent: boolean;
}

export interface ModelRouteResolutionInput {
	/** Stable non-secret identity derived by the authenticated caller layer. */
	readonly callerIdentity: string | null | undefined;
	readonly requestModel: string | null | undefined;
	readonly sessionId: string | null | undefined;
	/** Server-derived Claude Code child-agent classification. */
	readonly isSubagent: boolean;
}

export type ModelRouteResolution =
	| {
			readonly kind: "route";
			readonly source: "explicit";
			readonly profile: ModelRouteProfile;
			/** Null only when no stable caller/session key exists. */
			readonly generation: number | null;
	  }
	| {
			readonly kind: "route";
			readonly source: "inherited";
			readonly profile: ModelRouteProfile;
	  }
	| {
			readonly kind: "unavailable";
			readonly reason: "unbound_child_profile";
	  }
	| { readonly kind: "native" };

export interface ModelRouteSessionRegistryOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
}

/**
 * Bounded process-local bindings for one Claude Code session tree. Route
 * choices are scoped by a stable authenticated caller identity so spoofing a
 * session header cannot change another caller's account route.
 */
export class ModelRouteSessionRegistry {
	private readonly profilesByPublicModelId: ReadonlyMap<
		string,
		ModelRouteProfile
	>;
	private readonly profileOnlyAccountIds: ReadonlySet<string>;
	private readonly sessions = new Map<string, ModelRouteSessionState>();
	private readonly rootIntents = new Map<string, ModelRouteRootIntentState>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private lastGeneration = 0;

	constructor(
		profiles: readonly ModelRouteProfile[],
		options: ModelRouteSessionRegistryOptions = {},
	) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
		if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
			throw new Error("Model route session TTL must be a positive number");
		}
		if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
			throw new Error(
				"Model route session entry cap must be a positive integer",
			);
		}
		const profileOnlyAccountIds = new Set<string>();
		for (const profile of profiles) {
			if (
				profile.exclusiveAccount &&
				profile.selection === undefined &&
				profile.accountId !== undefined
			) {
				profileOnlyAccountIds.add(profile.accountId);
			}
		}
		this.profileOnlyAccountIds = profileOnlyAccountIds;
		this.profilesByPublicModelId = new Map(
			profiles.map((profile) => [profile.publicModelId, profile]),
		);
	}

	get size(): number {
		return this.sessions.size;
	}

	get hasProfiles(): boolean {
		return this.profilesByPublicModelId.size > 0;
	}

	hasPublicModelId(modelId: string): boolean {
		return this.profilesByPublicModelId.has(modelId);
	}

	isProfileOnlyAccount(accountId: string): boolean {
		return this.profileOnlyAccountIds.has(accountId);
	}

	isExactProfileAccount(
		profile: ModelRouteProfile,
		accountId: string,
	): boolean {
		return profile.selection === undefined && profile.accountId === accountId;
	}

	getDiscoveryModels(): ReadonlyArray<{
		readonly id: string;
		readonly display_name: string;
	}> {
		return Array.from(this.profilesByPublicModelId.values(), (profile) => ({
			id: profile.publicModelId,
			display_name: profile.displayName,
		}));
	}

	/**
	 * Capture root-request order before body buffering or interception can await and
	 * reorder requests. Children and request-scoped callers never reserve intent.
	 */
	beginRootIntent(input: ModelRouteRootIntentInput): number | null {
		if (!this.hasProfiles || input.isSubagent) return null;
		const key = this.bindingKey(input.callerIdentity, input.sessionId);
		if (!key) return null;
		const now = this.now();
		const existing = this.getRootIntentState(key, now);
		if (!existing) this.evictOldestIfFull(this.rootIntents);
		const generation = this.nextGeneration();
		// Map insertion order is the O(1) recency index used by bounded eviction.
		this.rootIntents.delete(key);
		this.rootIntents.set(key, { generation, reservedAt: now });
		return generation;
	}

	resolve(
		input: ModelRouteResolutionInput,
		rootIntentGeneration: number | null = null,
	): ModelRouteResolution {
		const requestModel = input.requestModel?.trim() ?? "";
		const explicitProfile = this.profilesByPublicModelId.get(requestModel);
		const bindingKey = this.bindingKey(input.callerIdentity, input.sessionId);
		if (input.isSubagent) {
			if (bindingKey) {
				const inherited = this.getBinding(bindingKey);
				if (inherited) {
					return {
						kind: "route",
						source: "inherited",
						profile: inherited,
					};
				}
			}
			return explicitProfile
				? { kind: "unavailable", reason: "unbound_child_profile" }
				: { kind: "native" };
		}

		if (explicitProfile) {
			const generation = bindingKey
				? this.prepareExplicitRootIntent(bindingKey, rootIntentGeneration)
				: null;
			return {
				kind: "route",
				source: "explicit",
				profile: explicitProfile,
				generation,
			};
		}

		if (
			bindingKey &&
			this.isCurrentRootIntent(bindingKey, rootIntentGeneration, this.now())
		) {
			this.sessions.delete(bindingKey);
		}
		return { kind: "native" };
	}

	/** Commit an explicit root selection only after its exact route is admitted. */
	commitExplicit(
		input: ModelRouteResolutionInput,
		resolution: ModelRouteResolution,
	): void {
		if (
			input.isSubagent ||
			resolution.kind !== "route" ||
			resolution.source !== "explicit"
		) {
			return;
		}
		const bindingKey = this.bindingKey(input.callerIdentity, input.sessionId);
		if (!bindingKey || resolution.generation === null) return;
		const now = this.now();
		if (!this.isCurrentRootIntent(bindingKey, resolution.generation, now)) {
			return;
		}
		const state = this.getSessionState(bindingKey, now, false);
		if (!state) this.evictOldestIfFull(this.sessions);
		this.setSessionState(bindingKey, {
			profile: resolution.profile,
			touchedAt: now,
		});
	}

	private bindingKey(
		callerIdentity: string | null | undefined,
		sessionId: string | null | undefined,
	): string | null {
		const caller = callerIdentity?.trim();
		const session = sessionId?.trim();
		if (!caller || !session) return null;
		return JSON.stringify([caller, session]);
	}

	private prepareExplicitRootIntent(
		key: string,
		generation: number | null,
	): number | null {
		const now = this.now();
		if (!this.isCurrentRootIntent(key, generation, now)) return null;
		return generation;
	}

	private isCurrentRootIntent(
		key: string,
		generation: number | null,
		now: number,
	): generation is number {
		if (generation === null) return false;
		return this.getRootIntentState(key, now)?.generation === generation;
	}

	private getRootIntentState(
		key: string,
		now: number,
	): ModelRouteRootIntentState | undefined {
		const state = this.rootIntents.get(key);
		if (!state) return undefined;
		if (now - state.reservedAt >= this.ttlMs) {
			this.rootIntents.delete(key);
			return undefined;
		}
		return state;
	}

	private getBinding(key: string): ModelRouteProfile | undefined {
		const now = this.now();
		const state = this.getSessionState(key, now, true);
		return state?.profile;
	}

	private getSessionState(
		key: string,
		now: number,
		touchBinding: boolean,
	): ModelRouteSessionState | undefined {
		const state = this.sessions.get(key);
		if (!state) return undefined;
		if (now - state.touchedAt >= this.ttlMs) {
			this.sessions.delete(key);
			return undefined;
		}
		if (touchBinding) {
			const touched = { ...state, touchedAt: now };
			this.setSessionState(key, touched);
			return touched;
		}
		return state;
	}

	private nextGeneration(): number {
		if (this.lastGeneration >= Number.MAX_SAFE_INTEGER) {
			throw new Error("Model route intent generation exhausted");
		}
		this.lastGeneration += 1;
		return this.lastGeneration;
	}

	private setSessionState(key: string, state: ModelRouteSessionState): void {
		this.sessions.delete(key);
		this.sessions.set(key, state);
	}

	private evictOldestIfFull<T>(map: Map<string, T>): void {
		if (map.size < this.maxEntries) return;
		const oldestKey = map.keys().next().value;
		if (oldestKey !== undefined) map.delete(oldestKey);
	}
}
