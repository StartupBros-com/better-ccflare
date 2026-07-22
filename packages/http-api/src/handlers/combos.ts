import { createHash } from "node:crypto";
import type { ComboResolverDependencies } from "@better-ccflare/core/managed-routing";
import {
	getModelFamily,
	proposeComboEnrollmentRules,
	proposeComboFamilyConversionRules,
	resolveComboProposalManagedModel,
	resolveEffectiveComboMembership,
} from "@better-ccflare/core/managed-routing";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	Conflict,
	NotFound,
	UnprocessableEntity,
} from "@better-ccflare/errors";
import {
	createComboRouteClassDraftProbe,
	deriveComboRouteClass,
	resolveAccountLogicalModelCapability,
} from "@better-ccflare/providers/request-capabilities";
import { usageCache } from "@better-ccflare/providers/usage-cache";
import { evaluateHardCapacity } from "@better-ccflare/proxy/usage-throttling";
import type {
	Account,
	ComboEnrollmentRuleProposal,
	ComboFamily,
	ComboFamilyAssignment,
	ComboFamilyPolicyChanges,
	ComboMembershipResolution,
	ComboRouteClass,
	ComboRoutingAccountDraft,
	ComboRoutingAvailabilitySummary,
	ComboRoutingMemberDelta,
	ComboRoutingPolicySnapshot,
	ComboRoutingPreviewMemberState,
	ComboRoutingPreviewResult,
	ComboRoutingPreviewScope,
	ComboRoutingPreviewSubject,
	ComboWithSlots,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import {
	COMBO_SLOT_PRIORITY_MAX,
	isComboSlotPriority,
} from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

/**
 * GET /api/combos — List all combos with slot counts (lightweight)
 */
export function createCombosListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const combos = await dbOps.listCombos();
			const data = await Promise.all(
				combos.map(async (combo) => {
					const slots = await dbOps.getComboSlots(combo.id);
					return {
						id: combo.id,
						name: combo.name,
						description: combo.description,
						enabled: combo.enabled,
						slot_count: slots.length,
					};
				}),
			);
			const response = {
				success: true,
				data,
				count: data.length,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/combos — Create a new combo
 */
export function createComboCreateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { name, description } = body;

			if (!name || typeof name !== "string" || name.trim().length === 0) {
				return errorResponse(
					BadRequest("name is required and must be a non-empty string"),
				);
			}

			const combo = await dbOps.createCombo(name.trim(), description ?? null);
			const response = {
				success: true,
				data: combo,
			};

			return new Response(JSON.stringify(response), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * GET /api/combos/:id — Get combo detail with populated slots
 */
export function createComboGetHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const slots = await dbOps.getComboSlots(id);
			const data: ComboWithSlots = { ...combo, slots };
			const response = {
				success: true,
				data,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id — Update combo fields
 */
export function createComboUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const body = await req.json();
			const { name, description, enabled } = body;

			const fields: Partial<{
				name: string;
				description: string | null;
				enabled: boolean;
			}> = {};

			if (name !== undefined) {
				if (typeof name !== "string" || name.trim().length === 0) {
					return errorResponse(BadRequest("name must be a non-empty string"));
				}
				fields.name = name.trim();
			}

			if (description !== undefined) {
				fields.description = description;
			}

			if (enabled !== undefined) {
				fields.enabled = enabled;
			}

			const updated = await dbOps.updateCombo(id, fields);
			const response = {
				success: true,
				data: updated,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * DELETE /api/combos/:id — Delete combo (cascades slots via DB)
 */
export function createComboDeleteHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			await dbOps.deleteCombo(id);
			const response = {
				success: true,
				message: "Combo deleted successfully",
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/combos/:id/slots — Add a slot to a combo
 */
export function createSlotAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request, comboId: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(comboId);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const body = await req.json();
			const { account_id, model, priority } = body;

			if (
				!account_id ||
				typeof account_id !== "string" ||
				account_id.trim().length === 0
			) {
				return errorResponse(BadRequest("account_id and model are required"));
			}

			if (!model || typeof model !== "string" || model.trim().length === 0) {
				return errorResponse(BadRequest("account_id and model are required"));
			}

			if (priority !== undefined && !isComboSlotPriority(priority)) {
				return errorResponse(
					BadRequest("priority must be an integer between 0 and 100"),
				);
			}

			const existingSlots = await dbOps.getComboSlots(comboId);
			const nextPriority =
				priority ?? Math.min(existingSlots.length, COMBO_SLOT_PRIORITY_MAX);
			const newSlot = await dbOps.addComboSlot(
				comboId,
				account_id,
				model.trim(),
				nextPriority,
			);

			return new Response(JSON.stringify({ success: true, data: newSlot }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id/slots/:slotId — Update a slot's model, priority, or enabled status
 */
export function createSlotUpdateHandler(dbOps: DatabaseOperations) {
	return async (
		req: Request,
		_comboId: string,
		slotId: string,
	): Promise<Response> => {
		try {
			const body = await req.json();
			const { model, priority, enabled } = body;

			const fields: Partial<{
				model: string;
				priority: number;
				enabled: boolean;
			}> = {};

			if (model !== undefined) {
				if (typeof model !== "string" || model.trim().length === 0) {
					return errorResponse(BadRequest("model must be a non-empty string"));
				}
				fields.model = model.trim();
			}

			if (enabled !== undefined) {
				if (typeof enabled !== "boolean") {
					return errorResponse(BadRequest("enabled must be a boolean"));
				}
				fields.enabled = enabled;
			}

			if (priority !== undefined) {
				if (!isComboSlotPriority(priority)) {
					return errorResponse(
						BadRequest("priority must be an integer between 0 and 100"),
					);
				}
				fields.priority = priority;
			}

			const updatedSlot = await dbOps.updateComboSlot(slotId, fields);

			return new Response(
				JSON.stringify({ success: true, data: updatedSlot }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * DELETE /api/combos/:id/slots/:slotId — Remove a slot from a combo
 */
export function createSlotRemoveHandler(dbOps: DatabaseOperations) {
	return async (_comboId: string, slotId: string): Promise<Response> => {
		try {
			await dbOps.removeComboSlot(slotId);

			return new Response(
				JSON.stringify({ success: true, message: "Slot removed" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id/slots/reorder — Reorder slots by priority
 */
export function createSlotReorderHandler(dbOps: DatabaseOperations) {
	return async (req: Request, comboId: string): Promise<Response> => {
		try {
			const body = await req.json();
			const { slotIds } = body;

			if (!Array.isArray(slotIds)) {
				return errorResponse(
					BadRequest("slotIds must be an array of slot IDs"),
				);
			}

			await dbOps.reorderComboSlots(comboId, slotIds);

			return new Response(
				JSON.stringify({ success: true, message: "Slots reordered" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * GET /api/families — List all family-to-combo assignments
 */
export function createFamiliesListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const assignments: ComboFamilyAssignment[] =
				await dbOps.getFamilyAssignments();

			return new Response(
				JSON.stringify({ success: true, data: assignments }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/families/:family — Assign or unassign a combo to a family
 */
export function createFamilyAssignHandler(
	dbOps: DatabaseOperations,
	dependencies: ComboResolverDependencies = defaultResolverDependencies,
) {
	return async (req: Request, family: string): Promise<Response> => {
		try {
			const validFamilies: ComboFamily[] = ["fable", "opus", "sonnet", "haiku"];
			if (!validFamilies.includes(family as ComboFamily)) {
				return errorResponse(
					BadRequest("family must be one of: fable, opus, sonnet, haiku"),
				);
			}

			const body = await req.json();
			if (body === null || typeof body !== "object" || Array.isArray(body)) {
				return errorResponse(BadRequest("request body must be an object"));
			}
			const {
				combo_id,
				enabled: bodyEnabled,
				membership_mode: membershipMode,
				managed_model: managedModel,
			} = body;
			const typedFamily = family as ComboFamily;
			const hasComboId = Object.hasOwn(body, "combo_id");
			const hasRecognizedField =
				hasComboId ||
				bodyEnabled !== undefined ||
				membershipMode !== undefined ||
				managedModel !== undefined;
			if (!hasRecognizedField) {
				return errorResponse(
					BadRequest("at least one family policy field is required"),
				);
			}

			if (bodyEnabled !== undefined && typeof bodyEnabled !== "boolean") {
				return errorResponse(BadRequest("enabled must be a boolean"));
			}

			if (
				membershipMode !== undefined &&
				membershipMode !== "manual" &&
				membershipMode !== "managed"
			) {
				return errorResponse(
					BadRequest("membership_mode must be manual or managed"),
				);
			}
			if (
				managedModel !== undefined &&
				managedModel !== null &&
				(typeof managedModel !== "string" ||
					getModelFamily(managedModel) !== typedFamily)
			) {
				return errorResponse(
					BadRequest("managed_model must belong to the assigned family"),
				);
			}

			let safeComboId: string | null = null;
			if (combo_id !== undefined && combo_id !== null) {
				if (typeof combo_id !== "string") {
					return errorResponse(BadRequest("combo_id must be a string"));
				}
				safeComboId = combo_id;
			}

			const enabled =
				bodyEnabled !== undefined ? bodyEnabled : safeComboId !== null;

			const usePartialPolicyUpdate =
				!hasComboId ||
				membershipMode !== undefined ||
				managedModel !== undefined;
			if (usePartialPolicyUpdate) {
				const current = await dbOps.getComboRoutingPolicy(typedFamily);
				const fields = {
					...(combo_id !== undefined ? { combo_id: safeComboId } : {}),
					...(bodyEnabled !== undefined ? { enabled } : {}),
					...(membershipMode !== undefined
						? { membership_mode: membershipMode }
						: {}),
					...(managedModel !== undefined
						? { managed_model: managedModel }
						: {}),
				};
				let proposedSnapshot: ComboRoutingPolicySnapshot = {
					...current,
					assignment: { ...current.assignment, ...fields },
				};
				if (
					combo_id !== undefined &&
					safeComboId !== current.assignment.combo_id
				) {
					if (safeComboId === null) {
						proposedSnapshot = {
							...proposedSnapshot,
							combo: null,
							slots: [],
							rules: [],
							exclusions: [],
						};
					} else {
						const [combo, slots, rules, exclusions] = await Promise.all([
							dbOps.getCombo(safeComboId),
							dbOps.getComboSlots(safeComboId),
							dbOps.getComboEnrollmentRules(typedFamily, safeComboId),
							dbOps.getComboMembershipExclusions(typedFamily, safeComboId),
						]);
						if (!combo) {
							return errorResponse(NotFound("Combo not found"));
						}
						proposedSnapshot = {
							...proposedSnapshot,
							combo,
							slots,
							rules,
							exclusions,
						};
					}
				}
				if (
					proposedSnapshot.assignment.enabled &&
					proposedSnapshot.assignment.combo_id !== null &&
					proposedSnapshot.assignment.membership_mode === "managed"
				) {
					const accounts = await dbOps.getAllAccounts();
					const resolution = resolveEffectiveComboMembership(
						proposedSnapshot,
						accounts,
						dependencies,
					);
					if (resolution.members.length === 0) {
						return errorResponse(
							UnprocessableEntity(
								"Managed mode requires at least one effective candidate",
								{ code: "managed_route_empty" },
							),
						);
					}
				}
				await dbOps.setFamilyPolicy(typedFamily, fields);
			} else {
				// Preserve the legacy write shape, while preventing an already-managed
				// assignment from bypassing the authoritative zero-candidate guard.
				const current = await dbOps.getComboRoutingPolicy(typedFamily);
				if (
					current.assignment.membership_mode === "managed" &&
					enabled &&
					safeComboId !== null
				) {
					let proposedSnapshot: ComboRoutingPolicySnapshot = {
						...current,
						assignment: {
							...current.assignment,
							combo_id: safeComboId,
							enabled,
						},
					};
					if (safeComboId !== current.assignment.combo_id) {
						const [combo, slots, rules, exclusions] = await Promise.all([
							dbOps.getCombo(safeComboId),
							dbOps.getComboSlots(safeComboId),
							dbOps.getComboEnrollmentRules(typedFamily, safeComboId),
							dbOps.getComboMembershipExclusions(typedFamily, safeComboId),
						]);
						if (!combo) return errorResponse(NotFound("Combo not found"));
						proposedSnapshot = {
							...proposedSnapshot,
							combo,
							slots,
							rules,
							exclusions,
						};
					}
					const accounts = await dbOps.getAllAccounts();
					const resolution = resolveEffectiveComboMembership(
						proposedSnapshot,
						accounts,
						dependencies,
					);
					if (resolution.members.length === 0) {
						return errorResponse(
							UnprocessableEntity(
								"Managed mode requires at least one effective candidate",
								{ code: "managed_route_empty" },
							),
						);
					}
				}
				await dbOps.setFamilyCombo(typedFamily, safeComboId, enabled);
			}
			const assignment = (await dbOps.getComboRoutingPolicy(typedFamily))
				.assignment;

			return new Response(
				JSON.stringify({
					success: true,
					message: "Family assignment updated",
					data: assignment,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

const VALID_FAMILIES: readonly ComboFamily[] = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
];
const VALID_ROUTE_CLASSES: readonly ComboRouteClass[] = [
	"oauth-subscription",
	"api-key",
	"local",
	"cloud-credential",
];
const PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID = "routing-preview-draft";
const PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID = "preview:draft";
const ROUTING_PREVIEW_COHERENCE_ATTEMPTS = 3;

interface ManagedRoutingDependencies extends ComboResolverDependencies {
	isLogicalModelExhausted?: (
		account: Account,
		logicalModel: string,
		now: number,
	) => boolean;
}

function isLogicalModelExhausted(
	account: Account,
	logicalModel: string,
	now: number,
): boolean {
	if (
		usageCache.getModelScopedExhaustion(account.id, logicalModel, null, now) !==
			null ||
		usageCache.getFamilyScopedExhaustion(account.id, logicalModel, now) !== null
	) {
		return true;
	}

	const snapshot = usageCache.getSnapshot(account.id);
	if (snapshot === null) return false;
	return !evaluateHardCapacity(snapshot.data, {
		requestModel: logicalModel,
		observedAt: snapshot.observedAt,
		provider: account.provider,
		now,
	}).eligible;
}

const defaultResolverDependencies: ManagedRoutingDependencies = {
	deriveRouteClass: deriveComboRouteClass,
	resolveCapability: resolveAccountLogicalModelCapability,
	isLogicalModelExhausted,
};

function parseFamily(value: string): ComboFamily {
	if (!VALID_FAMILIES.includes(value as ComboFamily)) {
		throw BadRequest("family must be one of: fable, opus, sonnet, haiku");
	}
	return value as ComboFamily;
}

async function parseObjectBody(req: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = await req.json();
	} catch {
		throw BadRequest("request body must contain valid JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw BadRequest("request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function parseManagedModel(
	value: unknown,
	family: ComboFamily,
	required: boolean,
): string | undefined {
	if (value === undefined) {
		if (required) throw BadRequest("managed_model is required");
		return undefined;
	}
	if (
		typeof value !== "string" ||
		!value.trim() ||
		getModelFamily(value.trim()) !== family
	) {
		throw BadRequest("managed_model must belong to the preview family");
	}
	return value.trim();
}

function availabilityFor(
	account: Account,
	logicalModel: string | null,
	dependencies: ManagedRoutingDependencies,
	now: number,
): ComboRoutingAvailabilitySummary {
	if (account.requires_reauth) {
		return { available: false, reason: "requires_reauth" };
	}
	if (account.paused) return { available: false, reason: "paused" };
	if (
		logicalModel !== null &&
		(dependencies.isLogicalModelExhausted ?? isLogicalModelExhausted)(
			account,
			logicalModel,
			now,
		)
	) {
		return { available: false, reason: "model_exhausted" };
	}
	if (account.rate_limited_until !== null && account.rate_limited_until > now) {
		return { available: false, reason: "rate_limited" };
	}
	return { available: true, reason: "available" };
}

function toEffectiveRoutingView(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	resolution: ComboMembershipResolution,
	dependencies: ManagedRoutingDependencies,
): EffectiveComboRoutingView {
	const accountsById = new Map(
		accounts.map((account) => [account.id, account]),
	);
	const now = Date.now();
	const decorate = <
		T extends { account_id: string; logical_model: string | null },
	>(
		item: T,
	) => {
		const account = accountsById.get(item.account_id);
		return {
			...item,
			account_name: account?.name ?? item.account_id,
			availability: account
				? availabilityFor(account, item.logical_model, dependencies, now)
				: { available: false, reason: "requires_reauth" as const },
			identity_provisional: false,
		};
	};
	return {
		family: snapshot.assignment.family,
		policy: snapshot,
		resolution: {
			...resolution,
			members: resolution.members.map(decorate),
			decisions: resolution.decisions.map(decorate),
		},
	};
}

async function readEffectiveRouting(
	dbOps: DatabaseOperations,
	family: ComboFamily,
	dependencies: ManagedRoutingDependencies,
	preloadedAccounts?: readonly Account[],
): Promise<EffectiveComboRoutingView> {
	const snapshot = await dbOps.getComboRoutingPolicy(family);
	const accounts = preloadedAccounts ?? (await dbOps.getAllAccounts());
	const resolution = resolveEffectiveComboMembership(
		snapshot,
		accounts,
		dependencies,
	);
	return toEffectiveRoutingView(snapshot, accounts, resolution, dependencies);
}

/** GET /api/routing/effective and GET /api/routing/effective/:family. */
export function createEffectiveRoutingHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultResolverDependencies,
) {
	return async (family?: string): Promise<Response> => {
		try {
			if (family !== undefined) {
				return Response.json({
					success: true,
					data: await readEffectiveRouting(
						dbOps,
						parseFamily(family),
						dependencies,
					),
				});
			}
			const [assignments, accounts] = await Promise.all([
				dbOps.getFamilyAssignments(),
				dbOps.getAllAccounts(),
			]);
			const views = await Promise.all(
				assignments
					.map((assignment) => assignment.family)
					.sort()
					.map((current) =>
						readEffectiveRouting(dbOps, current, dependencies, accounts),
					),
			);
			return Response.json({ success: true, data: views, count: views.length });
		} catch (error) {
			return errorResponse(error);
		}
	};
}

function validateModelMappings(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw BadRequest("model_mappings must be an object when provided");
	}
	const sanitized: Record<string, string | string[]> = {};
	for (const [key, mapping] of Object.entries(value)) {
		if (!key.trim()) throw BadRequest("model_mappings keys must be non-empty");
		if (typeof mapping === "string" && mapping.trim()) {
			sanitized[key] = mapping.trim();
			continue;
		}
		if (
			Array.isArray(mapping) &&
			mapping.length > 0 &&
			mapping.every((item) => typeof item === "string" && item.trim())
		) {
			sanitized[key] = mapping.map((item) => item.trim());
			continue;
		}
		throw BadRequest(
			"model_mappings values must be non-empty strings or arrays",
		);
	}
	return JSON.stringify(sanitized);
}

function draftToAccount(draft: ComboRoutingAccountDraft): Account {
	if (!draft.provider || typeof draft.provider !== "string") {
		throw BadRequest("draft.provider is required");
	}
	if (!isComboSlotPriority(draft.priority)) {
		throw BadRequest("draft.priority must be an integer between 0 and 100");
	}
	if (!VALID_ROUTE_CLASSES.includes(draft.auth_shape)) {
		throw BadRequest("draft.auth_shape is unknown");
	}
	if (
		draft.billing_type !== undefined &&
		draft.billing_type !== null &&
		draft.billing_type !== "plan" &&
		draft.billing_type !== "api"
	) {
		throw BadRequest("draft.billing_type must be plan, api, or null");
	}
	const billingType =
		draft.billing_type ??
		(draft.auth_shape === "oauth-subscription"
			? "plan"
			: draft.auth_shape === "api-key"
				? "api"
				: null);
	const routeProbe = createComboRouteClassDraftProbe({
		provider: draft.provider,
		routeClass: draft.auth_shape,
		billingType,
	});
	if (!routeProbe) {
		throw BadRequest("draft auth shape is incompatible with the provider");
	}
	const account: Account = {
		id: PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID,
		name: "Routing preview draft",
		provider: draft.provider,
		api_key: routeProbe.api_key,
		refresh_token: routeProbe.refresh_token,
		access_token: routeProbe.access_token,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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
		priority: draft.priority,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: validateModelMappings(draft.model_mappings),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: routeProbe.billing_type,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
	if (deriveComboRouteClass(account) !== draft.auth_shape) {
		throw BadRequest("draft auth shape is incompatible with the provider");
	}
	return account;
}

function parsePreviewSubject(
	body: Record<string, unknown>,
): ComboRoutingPreviewSubject {
	const hasAccountId =
		typeof body.account_id === "string" && body.account_id.length > 0;
	const hasDraft = body.draft !== undefined;
	if (hasAccountId === hasDraft) {
		throw BadRequest("exactly one of account_id or draft is required");
	}
	if (hasAccountId) return { account_id: body.account_id as string };
	if (
		!body.draft ||
		typeof body.draft !== "object" ||
		Array.isArray(body.draft)
	) {
		throw BadRequest("draft must be an object");
	}
	return { draft: body.draft as ComboRoutingAccountDraft };
}

function parsePreviewScope(value: unknown): ComboRoutingPreviewScope {
	if (value === undefined || value === "account") return "account";
	if (value === "family") return "family";
	throw BadRequest("scope must be account or family");
}

type RoutingPreviewInput =
	| { scope: "account"; subject: ComboRoutingPreviewSubject }
	| { scope: "family" };

interface CoherentRoutingInputs {
	revision: number;
	families: ComboFamily[];
	accounts: readonly Account[];
	snapshots: Map<ComboFamily, ComboRoutingPolicySnapshot>;
}

async function readCoherentRoutingInputs(
	dbOps: DatabaseOperations,
	requestedFamilies?: readonly ComboFamily[],
): Promise<CoherentRoutingInputs> {
	for (
		let attempt = 0;
		attempt < ROUTING_PREVIEW_COHERENCE_ATTEMPTS;
		attempt++
	) {
		const before = await dbOps.getRoutingPolicyRevision();
		const families = requestedFamilies
			? [...new Set(requestedFamilies)].sort()
			: (await dbOps.getFamilyAssignments())
					.map((assignment) => assignment.family)
					.sort();
		const [accounts, ...snapshots] = await Promise.all([
			dbOps.getAllAccounts(),
			...families.map((family) => dbOps.getComboRoutingPolicy(family)),
		]);
		const after = await dbOps.getRoutingPolicyRevision();
		if (before === after) {
			return {
				revision: after,
				families,
				accounts,
				snapshots: new Map(
					families.map((family, index) => [family, snapshots[index]]),
				),
			};
		}
	}
	throw Conflict("Routing policy changed while building the preview; retry", {
		code: "stale_routing_preview",
	});
}

function coherentSnapshot(
	inputs: CoherentRoutingInputs,
	family: ComboFamily,
): ComboRoutingPolicySnapshot {
	const snapshot = inputs.snapshots.get(family);
	if (!snapshot)
		throw new Error(`Missing coherent routing snapshot: ${family}`);
	return snapshot;
}

function isPersistedPreviewSubject(
	subject: ComboRoutingPreviewSubject,
): subject is { account_id: string; draft?: never } {
	return typeof subject.account_id === "string";
}

function resolvePreviewSubject(
	subject: ComboRoutingPreviewSubject,
	accounts: readonly Account[],
): Account {
	if (isPersistedPreviewSubject(subject)) {
		const found = accounts.find((account) => account.id === subject.account_id);
		if (!found) throw NotFound("Preview account not found");
		return found;
	}
	return draftToAccount(subject.draft);
}

function hypotheticalSnapshot(
	snapshot: ComboRoutingPolicySnapshot,
	proposal: ComboEnrollmentRuleProposal,
): ComboRoutingPolicySnapshot {
	const rules = snapshot.rules.map((rule) =>
		rule.id === proposal.existing_rule_id ? { ...rule, enabled: true } : rule,
	);
	if (!proposal.existing_rule_id) {
		rules.push({
			id: createReviewedRuleId(proposal),
			family: proposal.family,
			combo_id: proposal.combo_id,
			provider: proposal.provider,
			route_class: proposal.route_class,
			enabled: true,
			created_at: 0,
			updated_at: 0,
		});
	}
	return {
		...snapshot,
		assignment: {
			...snapshot.assignment,
			membership_mode: "managed",
			managed_model: proposal.managed_model,
		},
		rules,
	};
}

function createReviewedRuleId(proposal: ComboEnrollmentRuleProposal): string {
	return `managed-rule:${createHash("sha256")
		.update(proposal.proposal_id)
		.digest("hex")}`;
}

function createPreviewId(value: unknown): string {
	return `preview:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function publicProposalView(
	view: EffectiveComboRoutingView,
	hasDraftSubject: boolean,
): EffectiveComboRoutingView {
	if (!hasDraftSubject) return view;
	return {
		...view,
		resolution: {
			...view.resolution,
			members: view.resolution.members.map((member) =>
				member.account_id === PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID
					? {
							...member,
							id: null,
							account_id: PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID,
							account_name: "Draft account",
							identity_provisional: true,
						}
					: member,
			),
			decisions: view.resolution.decisions.map((decision) =>
				decision.account_id === PREVIEW_DRAFT_INTERNAL_ACCOUNT_ID
					? {
							...decision,
							account_id: PREVIEW_DRAFT_PUBLIC_ACCOUNT_ID,
							account_name: "Draft account",
							identity_provisional: true,
						}
					: decision,
			),
		},
	};
}

function previewMemberState(
	member: EffectiveComboRoutingView["resolution"]["members"][number],
): ComboRoutingPreviewMemberState {
	const ownership = {
		subject: member.identity_provisional ? "draft" : "persisted",
		account_id: member.identity_provisional ? null : member.account_id,
		candidate_id: member.identity_provisional ? null : member.id,
		source: member.source,
	};
	const key = `member:${createHash("sha256")
		.update(JSON.stringify(ownership))
		.digest("hex")}`;
	return {
		key,
		account_id: ownership.account_id,
		candidate_id: ownership.candidate_id,
		identity_provisional: member.identity_provisional,
		source: member.source,
		tier: member.tier,
		logical_model: member.logical_model,
		reason: member.reason,
	};
}

function samePreviewMemberState(
	left: ComboRoutingPreviewMemberState,
	right: ComboRoutingPreviewMemberState,
): boolean {
	return (
		left.account_id === right.account_id &&
		left.candidate_id === right.candidate_id &&
		left.identity_provisional === right.identity_provisional &&
		left.source === right.source &&
		left.tier === right.tier &&
		left.logical_model === right.logical_model &&
		left.reason === right.reason
	);
}

function memberDelta(
	before: EffectiveComboRoutingView,
	after: EffectiveComboRoutingView,
): ComboRoutingMemberDelta[] {
	const beforeByKey = new Map(
		before.resolution.members
			.map(previewMemberState)
			.map((member) => [member.key, member]),
	);
	const afterByKey = new Map(
		after.resolution.members
			.map(previewMemberState)
			.map((member) => [member.key, member]),
	);
	return [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
		.sort()
		.map((key) => {
			const previous = beforeByKey.get(key) ?? null;
			const next = afterByKey.get(key) ?? null;
			return {
				key,
				status:
					previous === null
						? "added"
						: next === null
							? "removed"
							: samePreviewMemberState(previous, next)
								? "unchanged"
								: "changed",
				before: previous,
				after: next,
			};
		});
}

function computeRoutingPreview(
	snapshot: ComboRoutingPolicySnapshot,
	accounts: readonly Account[],
	revision: number,
	family: ComboFamily,
	input: RoutingPreviewInput,
	dependencies: ManagedRoutingDependencies,
	options: {
		managedModel?: string;
		draftAccount?: Account;
	} = {},
): ComboRoutingPreviewResult {
	const managedModel = resolveComboProposalManagedModel(
		snapshot,
		options.managedModel,
	);
	const previewAccount =
		input.scope === "account"
			? (options.draftAccount ?? resolvePreviewSubject(input.subject, accounts))
			: null;
	const baseProposals =
		input.scope === "account"
			? proposeComboEnrollmentRules(
					snapshot,
					accounts,
					previewAccount as Account,
					dependencies,
					{ managedModel },
				)
			: proposeComboFamilyConversionRules(snapshot, accounts, dependencies, {
					managedModel,
				});
	const currentResolution = resolveEffectiveComboMembership(
		snapshot,
		accounts,
		dependencies,
	);
	const effective = toEffectiveRoutingView(
		snapshot,
		accounts,
		currentResolution,
		dependencies,
	);
	const hasDraftSubject =
		input.scope === "account" && !isPersistedPreviewSubject(input.subject);
	const proposedAccounts =
		hasDraftSubject && previewAccount !== null
			? [...accounts, previewAccount]
			: accounts;
	const proposed = baseProposals.map((proposal) => {
		const proposedSnapshot = hypotheticalSnapshot(snapshot, proposal);
		const resolution = resolveEffectiveComboMembership(
			proposedSnapshot,
			proposedAccounts,
			dependencies,
		);
		const proposedEffective = publicProposalView(
			toEffectiveRoutingView(
				proposedSnapshot,
				proposedAccounts,
				resolution,
				dependencies,
			),
			hasDraftSubject,
		);
		return {
			proposal: {
				...proposal,
				proposed_effective: proposedEffective,
				member_delta: memberDelta(effective, proposedEffective),
			},
			resolution,
		};
	});
	const safeSubject =
		input.scope === "family"
			? null
			: isPersistedPreviewSubject(input.subject)
				? { account_id: input.subject.account_id }
				: {
						draft: {
							provider: input.subject.draft.provider,
							priority: input.subject.draft.priority,
							auth_shape: input.subject.draft.auth_shape,
							billing_type: input.subject.draft.billing_type ?? null,
						},
					};
	const previewId = createPreviewId({
		revision,
		scope: input.scope,
		family,
		managed_model: managedModel,
		subject: safeSubject,
		policy: snapshot,
		proposals: baseProposals,
		current: currentResolution,
		proposed: proposed.map((entry) => entry.resolution),
	});
	return {
		preview_id: previewId,
		scope: input.scope,
		family,
		managed_model: managedModel,
		proposals: proposed.map((entry) => entry.proposal),
		effective,
	};
}

/** POST /api/routing/preview. */
export function createRoutingPreviewHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultResolverDependencies,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await parseObjectBody(req);
			const scope = parsePreviewScope(body.scope);
			if (scope === "family") {
				if (body.family === undefined) {
					throw BadRequest("family is required for family-scoped preview");
				}
				if (body.account_id !== undefined || body.draft !== undefined) {
					throw BadRequest(
						"family-scoped preview does not accept an account subject",
					);
				}
				const family = parseFamily(String(body.family));
				const managedModel = parseManagedModel(
					body.managed_model,
					family,
					false,
				);
				const inputs = await readCoherentRoutingInputs(dbOps, [family]);
				return Response.json({
					success: true,
					data: computeRoutingPreview(
						coherentSnapshot(inputs, family),
						inputs.accounts,
						inputs.revision,
						family,
						{ scope: "family" },
						dependencies,
						{ managedModel },
					),
				});
			}

			const subject = parsePreviewSubject(body);
			if (body.family !== undefined) {
				const family = parseFamily(String(body.family));
				const managedModel = parseManagedModel(
					body.managed_model,
					family,
					false,
				);
				const inputs = await readCoherentRoutingInputs(dbOps, [family]);
				return Response.json({
					success: true,
					data: computeRoutingPreview(
						coherentSnapshot(inputs, family),
						inputs.accounts,
						inputs.revision,
						family,
						{ scope: "account", subject },
						dependencies,
						{ managedModel },
					),
				});
			}
			if (body.managed_model !== undefined) {
				throw BadRequest("family is required with managed_model");
			}
			const inputs = await readCoherentRoutingInputs(dbOps);
			const draftAccount = resolvePreviewSubject(subject, inputs.accounts);
			const families = inputs.families.map((family) =>
				computeRoutingPreview(
					coherentSnapshot(inputs, family),
					inputs.accounts,
					inputs.revision,
					family,
					{ scope: "account", subject },
					dependencies,
					{ draftAccount },
				),
			);
			return Response.json({ success: true, data: { families } });
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** POST /api/routing/apply/:family. */
export function createRoutingApplyHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultResolverDependencies,
) {
	return async (req: Request, familyValue: string): Promise<Response> => {
		try {
			const family = parseFamily(familyValue);
			const body = await parseObjectBody(req);
			if (typeof body.preview_id !== "string" || !body.preview_id) {
				throw BadRequest("preview_id is required");
			}
			if (typeof body.proposal_id !== "string" || !body.proposal_id) {
				throw BadRequest("proposal_id is required");
			}
			const managedModel = parseManagedModel(body.managed_model, family, true);
			const scope = parsePreviewScope(body.scope);
			const inputs = await readCoherentRoutingInputs(dbOps, [family]);
			const accounts = inputs.accounts;
			const policySnapshot = coherentSnapshot(inputs, family);
			let current: ComboRoutingPreviewResult;
			if (scope === "family") {
				if (body.subject !== undefined) {
					throw BadRequest(
						"family-scoped apply does not accept an account subject",
					);
				}
				current = computeRoutingPreview(
					policySnapshot,
					accounts,
					inputs.revision,
					family,
					{ scope: "family" },
					dependencies,
					{ managedModel },
				);
			} else {
				if (!body.subject || typeof body.subject !== "object") {
					throw BadRequest("subject is required");
				}
				const subject = parsePreviewSubject(
					body.subject as Record<string, unknown>,
				);
				if (!isPersistedPreviewSubject(subject)) {
					throw BadRequest(
						"Draft routing previews cannot be applied; create the account first",
					);
				}
				const persistedAccount = resolvePreviewSubject(subject, accounts);
				current = computeRoutingPreview(
					policySnapshot,
					accounts,
					inputs.revision,
					family,
					{ scope: "account", subject },
					dependencies,
					{
						managedModel,
						draftAccount: persistedAccount,
					},
				);
			}
			if (current.preview_id !== body.preview_id) {
				throw Conflict(
					"Routing preview is stale; review the current proposal",
					{
						code: "stale_routing_preview",
						preview_id: current.preview_id,
					},
				);
			}
			const proposal = current.proposals.find(
				(candidate) => candidate.proposal_id === body.proposal_id,
			);
			if (!proposal) throw BadRequest("proposal_id is not in this preview");

			const snapshot = current.effective.policy;
			const proposedSnapshot = hypotheticalSnapshot(snapshot, proposal);
			const proposedResolution = resolveEffectiveComboMembership(
				proposedSnapshot,
				accounts,
				dependencies,
			);
			if (proposedResolution.members.length === 0) {
				throw UnprocessableEntity(
					"Managed mode requires at least one effective candidate",
					{ code: "managed_route_empty" },
				);
			}
			const existingRule = proposal.existing_rule_id
				? snapshot.rules.find((rule) => rule.id === proposal.existing_rule_id)
				: null;
			if (
				snapshot.assignment.membership_mode === "managed" &&
				snapshot.assignment.managed_model === proposal.managed_model &&
				existingRule?.enabled === true
			) {
				if ((await dbOps.getRoutingPolicyRevision()) !== inputs.revision) {
					throw Conflict(
						"Routing preview is stale; review the current proposal",
						{ code: "stale_routing_preview" },
					);
				}
				return Response.json({
					success: true,
					data: current.effective,
				});
			}

			const changes: ComboFamilyPolicyChanges = {
				family,
				expected_revision: inputs.revision,
				assignment: {
					membership_mode: "managed",
					managed_model: proposal.managed_model,
				},
				...(proposal.existing_rule_id
					? {
							update_rules: [
								{ id: proposal.existing_rule_id, fields: { enabled: true } },
							],
						}
					: {
							create_rules: [
								{
									id: createReviewedRuleId(proposal),
									combo_id: proposal.combo_id,
									provider: proposal.provider,
									route_class: proposal.route_class,
									enabled: true,
								},
							],
						}),
			};
			try {
				await dbOps.applyFamilyPolicyChanges(changes);
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error as { code?: unknown }).code === "stale_routing_preview"
				) {
					throw Conflict(
						"Routing preview is stale; review the current proposal",
						{ code: "stale_routing_preview" },
					);
				}
				throw error;
			}
			return Response.json({
				success: true,
				data: await readEffectiveRouting(dbOps, family, dependencies),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** POST /api/routing/exclusions/:family. */
export function createMembershipExclusionCreateHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultResolverDependencies,
) {
	return async (req: Request, familyValue: string): Promise<Response> => {
		try {
			const family = parseFamily(familyValue);
			const body = await parseObjectBody(req);
			if (typeof body.account_id !== "string" || !body.account_id) {
				throw BadRequest("account_id is required");
			}
			const [snapshot, account] = await Promise.all([
				dbOps.getComboRoutingPolicy(family),
				dbOps.getAccount(body.account_id),
			]);
			if (!snapshot.assignment.enabled || !snapshot.combo?.enabled) {
				throw UnprocessableEntity(
					"Cannot exclude from a disabled family route",
					{
						code: "family_route_disabled",
					},
				);
			}
			if (!snapshot.assignment.combo_id || !account) {
				throw NotFound(
					!account ? "Account not found" : "Assigned combo not found",
				);
			}
			if (
				snapshot.exclusions.some(
					(exclusion) => exclusion.account_id === account.id,
				)
			) {
				throw Conflict("Account is already excluded from this family");
			}
			await dbOps.createComboMembershipExclusion({
				family,
				combo_id: snapshot.assignment.combo_id,
				account_id: account.id,
			});
			return new Response(
				JSON.stringify({
					success: true,
					data: await readEffectiveRouting(dbOps, family, dependencies),
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** DELETE /api/routing/exclusions/:family/:accountId. */
export function createMembershipExclusionRestoreHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultResolverDependencies,
) {
	return async (familyValue: string, accountId: string): Promise<Response> => {
		try {
			const family = parseFamily(familyValue);
			const snapshot = await dbOps.getComboRoutingPolicy(family);
			if (!snapshot.assignment.combo_id)
				throw NotFound("Assigned combo not found");
			if (
				!snapshot.exclusions.some(
					(exclusion) =>
						exclusion.combo_id === snapshot.assignment.combo_id &&
						exclusion.account_id === accountId,
				)
			) {
				throw NotFound("Membership exclusion not found");
			}
			await dbOps.restoreComboMembership(
				family,
				snapshot.assignment.combo_id,
				accountId,
			);
			return Response.json({
				success: true,
				data: await readEffectiveRouting(dbOps, family, dependencies),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
