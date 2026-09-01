import { providerAcceptsClientModel } from "@better-ccflare/core";
import type { ComboResolverDependencies } from "@better-ccflare/core/managed-routing";
import {
	getAllowedModelsMessage,
	getModelFamily,
	isFamilyAliasModel,
	resolveEffectiveComboMembership,
	resolveFamilyAliasModel,
} from "@better-ccflare/core/managed-routing";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	Conflict,
	NotFound,
	UnprocessableEntity,
} from "@better-ccflare/errors";
import type {
	AccountRoutingOpportunityView,
	AccountRoutingOverview,
	ComboFamily,
	ComboFamilyAssignment,
	ComboFamilyPolicyChanges,
	ComboFamilyPolicyUpdateInput,
	ComboRoutingAccountDraft,
	ComboRoutingPolicySnapshot,
	ComboRoutingPreviewScope,
	ComboRoutingPreviewSubject,
	ComboWithSlots,
	EffectiveComboRoutingView,
	FamilyAliasPolicyApplyInput,
	FamilyAliasPolicySelection,
} from "@better-ccflare/types";
import {
	COMBO_SLOT_PRIORITY_MAX,
	isComboSlotPriority,
} from "@better-ccflare/types";
import {
	applyRoutingProposal,
	coherentSnapshot,
	computeRoutingPreview,
	defaultManagedRoutingDependencies,
	type ManagedRoutingDependencies,
	omitAccountNames,
	previewAccountRoutingForFamily,
	readCoherentRoutingInputs,
	readEffectiveRouting,
	resolvePreviewSubject,
	toEffectiveRoutingView,
} from "../services/account-routing-operations";
import { errorResponse } from "../utils/http-error";

/**
 * A slot without a model (passthrough) only makes sense on a provider whose
 * upstream natively accepts Claude model ids: the model the client asked for
 * arrives intact and is understood on the other side.
 *
 * On any other provider, passthrough would hand a Claude name to an upstream
 * that does not know it, and translation would fall to the embedded default
 * map — the path that produced `400 gpt-5.3-codex ... ChatGPT account`.
 *
 * The list moved to core so that "force account model", which needs the same
 * answer when deciding whether an account can serve a Claude id untranslated,
 * cannot drift from it.
 */
function _allowsClientModel(provider: string | null | undefined): boolean {
	return providerAcceptsClientModel(provider);
}

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
 * Canonicalize a stored managed_model/slot-model value: if it is a bare
 * family alias (e.g. "opus"), store the lowercase family word itself so
 * later reads compare consistently; otherwise return the trimmed value
 * unchanged. This never resolves the alias to a concrete model — storing the
 * alias literal is the point of the feature (it lets future model releases
 * propagate via a models.ts bump instead of a data migration).
 */
function normalizeManagedModelValue(
	value: string,
	family: ComboFamily,
): string {
	const trimmed = value.trim();
	return isFamilyAliasModel(trimmed, family) ? family : trimmed;
}

/**
 * Validate and normalize a slot's model against the family (if any) that the
 * slot's combo is currently assigned to. Combos not yet assigned to any
 * family accept any non-empty model unchanged (no family context to check
 * against). A combo assigned to one or more families must have its slot
 * models belong to at least one of those families (concrete model or bare
 * family alias); the matched family's alias spelling is canonicalized.
 */
async function normalizeSlotModelForCombo(
	dbOps: DatabaseOperations,
	comboId: string,
	rawModel: string,
): Promise<{ ok: true; model: string } | { ok: false; message: string }> {
	const trimmed = rawModel.trim();
	if (!trimmed) {
		return { ok: false, message: "model must be a non-empty string" };
	}
	const assignments = await dbOps.getFamilyAssignments();
	const assignedFamilies = assignments
		.filter((assignment) => assignment.combo_id === comboId)
		.map((assignment) => assignment.family);
	if (assignedFamilies.length === 0) {
		return { ok: true, model: trimmed };
	}
	const matchedFamily = assignedFamilies.find(
		(family) => getModelFamily(trimmed) === family,
	);
	if (!matchedFamily) {
		return {
			ok: false,
			message: `model must belong to a family assigned to this combo (${assignedFamilies.join(", ")}). ${getAllowedModelsMessage()}`,
		};
	}
	return {
		ok: true,
		model: normalizeManagedModelValue(trimmed, matchedFamily),
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

			const normalizedModelResult = await normalizeSlotModelForCombo(
				dbOps,
				comboId,
				model,
			);
			if (!normalizedModelResult.ok) {
				return errorResponse(BadRequest(normalizedModelResult.message));
			}
			const normalizedModel = normalizedModelResult.model;

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
				normalizedModel,
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
		comboId: string,
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
				const normalizedModelResult = await normalizeSlotModelForCombo(
					dbOps,
					comboId,
					model,
				);
				if (!normalizedModelResult.ok) {
					return errorResponse(BadRequest(normalizedModelResult.message));
				}
				fields.model = normalizedModelResult.model;
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

function isStaleRoutingRevisionError(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "stale_routing_preview"
	);
}

async function applyFamilyPolicyChange(
	dbOps: DatabaseOperations,
	changes: ComboFamilyPolicyChanges,
): Promise<void> {
	try {
		await dbOps.applyFamilyPolicyChanges(changes);
	} catch (error) {
		if (isStaleRoutingRevisionError(error)) {
			throw Conflict(
				"Routing policy changed; review the current family policy",
				{
					code: "stale_routing_preview",
				},
			);
		}
		throw error;
	}
}

/**
 * PUT /api/families/:family — Assign or unassign a combo to a family
 */
export function createFamilyAssignHandler(
	dbOps: DatabaseOperations,
	dependencies: ComboResolverDependencies = defaultManagedRoutingDependencies,
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
				const inputs = await readCoherentRoutingInputs(dbOps, [typedFamily]);
				const current = coherentSnapshot(inputs, typedFamily);
				const fields: ComboFamilyPolicyUpdateInput = {
					...(combo_id !== undefined ? { combo_id: safeComboId } : {}),
					...(bodyEnabled !== undefined ? { enabled } : {}),
					...(membershipMode !== undefined
						? { membership_mode: membershipMode }
						: {}),
					...(managedModel !== undefined
						? {
								managed_model:
									managedModel === null
										? null
										: normalizeManagedModelValue(managedModel, typedFamily),
							}
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
					const resolution = resolveEffectiveComboMembership(
						proposedSnapshot,
						inputs.accounts,
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
				await applyFamilyPolicyChange(dbOps, {
					family: typedFamily,
					expected_revision: inputs.revision,
					assignment: fields,
				});
			} else {
				// Preserve the legacy write shape, while preventing an already-managed
				// assignment from bypassing the authoritative zero-candidate guard.
				const inputs = await readCoherentRoutingInputs(dbOps, [typedFamily]);
				const current = coherentSnapshot(inputs, typedFamily);
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
					const resolution = resolveEffectiveComboMembership(
						proposedSnapshot,
						inputs.accounts,
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
				await applyFamilyPolicyChange(dbOps, {
					family: typedFamily,
					expected_revision: inputs.revision,
					assignment: { combo_id: safeComboId, enabled },
				});
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

/**
 * New clients echo both the resolved preview value and its exact persistence
 * intent. Older clients can only apply a concrete value, where those values
 * are necessarily identical; accepting an omitted alias here would turn it
 * into a concrete pin.
 */
function parsePolicyManagedModel(
	value: unknown,
	family: ComboFamily,
	managedModel: string,
): string {
	if (value === undefined) {
		if (resolveFamilyAliasModel(managedModel, family) !== managedModel) {
			throw BadRequest(
				"policy_managed_model is required when managed_model is an alias",
			);
		}
		return managedModel;
	}
	const policyManagedModel = parseManagedModel(value, family, true);
	if (
		policyManagedModel === undefined ||
		resolveFamilyAliasModel(policyManagedModel, family) !== managedModel
	) {
		throw BadRequest(
			"policy_managed_model must resolve to the reviewed managed_model",
		);
	}
	return policyManagedModel;
}

/** GET /api/routing/effective and GET /api/routing/effective/:family. */
export function createEffectiveRoutingHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
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

/**
 * GET /api/routing/accounts.
 *
 * Account cards need current effective membership plus server-owned warnings
 * for compatible accounts outside a route. Build both from one coherent input
 * snapshot so the dashboard never fans out one full preview request per
 * account and never receives repeated preview payloads or account names.
 */
export function createAccountRoutingOverviewHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
) {
	return async (): Promise<Response> => {
		try {
			const inputs = await readCoherentRoutingInputs(dbOps);
			const fullEffectiveByFamily = new Map<
				ComboFamily,
				EffectiveComboRoutingView
			>();
			for (const family of inputs.families) {
				const currentSnapshot = coherentSnapshot(inputs, family);
				const currentResolution = resolveEffectiveComboMembership(
					currentSnapshot,
					inputs.accounts,
					dependencies,
				);
				fullEffectiveByFamily.set(
					family,
					toEffectiveRoutingView(
						currentSnapshot,
						inputs.accounts,
						currentResolution,
						dependencies,
					),
				);
			}

			const opportunities: AccountRoutingOpportunityView[] = [];
			for (const account of [...inputs.accounts].sort((left, right) =>
				left.id.localeCompare(right.id),
			)) {
				for (const family of inputs.families) {
					const current = fullEffectiveByFamily.get(family);
					if (!current) continue;
					if (
						current.resolution.members.some(
							(member) => member.account_id === account.id,
						)
					) {
						continue;
					}

					const preview = computeRoutingPreview(
						coherentSnapshot(inputs, family),
						inputs.accounts,
						inputs.revision,
						family,
						{
							scope: "account",
							subject: { account_id: account.id },
						},
						dependencies,
					);
					for (const proposal of preview.proposals) {
						if (!proposal.high_confidence) continue;
						const joinsProposedRoute =
							proposal.proposed_effective.resolution.members.some(
								(member) => member.account_id === account.id,
							);
						if (!joinsProposedRoute) continue;
						opportunities.push({
							account_id: account.id,
							family,
							proposal_id: proposal.proposal_id,
							combo_id: proposal.combo_id,
							managed_model: proposal.managed_model,
							tier_source: proposal.tier_source,
							reason: proposal.reason,
						});
					}
				}
			}

			const data: AccountRoutingOverview = {
				effective: inputs.families.map((family) => {
					const view = fullEffectiveByFamily.get(family);
					if (!view)
						throw new Error(`Missing effective routing view: ${family}`);
					return omitAccountNames(view);
				}),
				opportunities,
			};
			return Response.json({ success: true, data });
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** POST /api/routing/preview. */
export function createRoutingPreviewHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
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
				return Response.json({
					success: true,
					data: await previewAccountRoutingForFamily(dbOps, dependencies, {
						family,
						subject,
						managedModel,
					}),
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
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
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
			if (managedModel === undefined) {
				throw BadRequest("managed_model is required");
			}
			const policyManagedModel = parsePolicyManagedModel(
				body.policy_managed_model,
				family,
				managedModel,
			);
			const scope = parsePreviewScope(body.scope);
			let subject: ComboRoutingPreviewSubject | undefined;
			if (scope === "family") {
				if (body.subject !== undefined) {
					throw BadRequest(
						"family-scoped apply does not accept an account subject",
					);
				}
			} else {
				if (
					!body.subject ||
					typeof body.subject !== "object" ||
					Array.isArray(body.subject)
				) {
					throw BadRequest("subject is required");
				}
				subject = parsePreviewSubject(body.subject as Record<string, unknown>);
			}
			const data = await applyRoutingProposal(dbOps, dependencies, {
				family,
				previewId: body.preview_id,
				proposalId: body.proposal_id,
				managedModel,
				policyManagedModel,
				scope,
				subject,
			});
			return Response.json({ success: true, data });
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** POST /api/routing/exclusions/:family. */
export function createMembershipExclusionCreateHandler(
	dbOps: DatabaseOperations,
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
) {
	return async (req: Request, familyValue: string): Promise<Response> => {
		try {
			const family = parseFamily(familyValue);
			const body = await parseObjectBody(req);
			if (typeof body.account_id !== "string" || !body.account_id) {
				throw BadRequest("account_id is required");
			}
			const inputs = await readCoherentRoutingInputs(dbOps, [family]);
			const snapshot = coherentSnapshot(inputs, family);
			const account = inputs.accounts.find(
				(current) => current.id === body.account_id,
			);
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
			await applyFamilyPolicyChange(dbOps, {
				family,
				expected_revision: inputs.revision,
				create_exclusions: [
					{
						combo_id: snapshot.assignment.combo_id,
						account_id: account.id,
					},
				],
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
	dependencies: ManagedRoutingDependencies = defaultManagedRoutingDependencies,
) {
	return async (familyValue: string, accountId: string): Promise<Response> => {
		try {
			const family = parseFamily(familyValue);
			const inputs = await readCoherentRoutingInputs(dbOps, [family]);
			const snapshot = coherentSnapshot(inputs, family);
			if (!snapshot.assignment.combo_id)
				throw NotFound("Assigned combo not found");
			const exclusion = snapshot.exclusions.find(
				(current) =>
					current.combo_id === snapshot.assignment.combo_id &&
					current.account_id === accountId,
			);
			if (!exclusion) {
				throw NotFound("Membership exclusion not found");
			}
			await applyFamilyPolicyChange(dbOps, {
				family,
				expected_revision: inputs.revision,
				delete_exclusion_ids: [exclusion.id],
			});
			return Response.json({
				success: true,
				data: await readEffectiveRouting(dbOps, family, dependencies),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

async function parseFamilyAliasPreviewInput(
	req: Request,
): Promise<{ include_pinned_family?: ComboFamily }> {
	const text = await req.text();
	if (!text) return {};
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw BadRequest("request body must contain valid JSON");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw BadRequest("request body must be a JSON object");
	}
	const value = (body as Record<string, unknown>).include_pinned_family;
	if (value === undefined) return {};
	if (typeof value !== "string") {
		throw BadRequest("include_pinned_family must be a family");
	}
	return { include_pinned_family: parseFamily(value) };
}

/** POST /api/routing/family-aliases/preview — local-control candidate read. */
export function createFamilyAliasPreviewHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			return Response.json({
				success: true,
				data: await dbOps.previewFamilyAliasPolicy(
					await parseFamilyAliasPreviewInput(req),
				),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

function parseFamilyAliasApplyInput(
	body: Record<string, unknown>,
): FamilyAliasPolicyApplyInput {
	if (
		!Number.isSafeInteger(body.expected_revision) ||
		(body.expected_revision as number) < 0
	) {
		throw BadRequest("expected_revision must be a non-negative safe integer");
	}
	if (!Array.isArray(body.selections))
		throw BadRequest("selections must be an array");
	const includePinnedFamily =
		body.include_pinned_family === undefined
			? undefined
			: typeof body.include_pinned_family === "string"
				? parseFamily(body.include_pinned_family)
				: (() => {
						throw BadRequest("include_pinned_family must be a family");
					})();
	const selections: FamilyAliasPolicySelection[] = body.selections.map(
		(value) => {
			if (!value || typeof value !== "object")
				throw BadRequest("invalid policy selection");
			const selection = value as Record<string, unknown>;
			if (
				typeof selection.family !== "string" ||
				typeof selection.expected_old_value !== "string"
			) {
				throw BadRequest(
					"selection family and expected_old_value are required",
				);
			}
			const family = parseFamily(selection.family);
			const identity = selection.identity;
			if (!identity || typeof identity !== "object")
				throw BadRequest("selection identity is required");
			const rawIdentity = identity as Record<string, unknown>;
			if (
				rawIdentity.kind === "family_assignment" &&
				typeof rawIdentity.family === "string"
			) {
				return {
					identity: {
						kind: "family_assignment",
						family: parseFamily(rawIdentity.family),
					},
					family,
					expected_old_value: selection.expected_old_value,
				};
			}
			if (
				rawIdentity.kind === "combo_slot" &&
				typeof rawIdentity.slot_id === "string" &&
				rawIdentity.slot_id
			) {
				return {
					identity: { kind: "combo_slot", slot_id: rawIdentity.slot_id },
					family,
					expected_old_value: selection.expected_old_value,
				};
			}
			throw BadRequest("invalid policy selection identity");
		},
	);
	return {
		expected_revision: body.expected_revision as number,
		...(includePinnedFamily === undefined
			? {}
			: { include_pinned_family: includePinnedFamily }),
		selections,
	};
}

/** POST /api/routing/family-aliases/apply — atomic local-control conversion. */
export function createFamilyAliasApplyHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await parseObjectBody(req);
			const result = await dbOps.applyFamilyAliasPolicy(
				parseFamilyAliasApplyInput(body),
			);
			return Response.json({ success: true, data: result });
		} catch (error) {
			return errorResponse(error);
		}
	};
}
