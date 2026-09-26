import type { DatabaseOperations } from "@better-ccflare/database";
import type { ModelRouteProfile } from "@better-ccflare/proxy";
import {
	applyCodexModelMigration,
	CODEX_MIGRATION_FAMILIES,
	type CodexMigrationFamily,
	type CodexModelMigrationApplyInput,
	type CodexModelMigrationSelection,
	previewCodexModelMigration,
} from "../services/codex-model-migration";
import { BadRequest, errorResponse } from "../utils/http-error";

async function readObjectBody(
	req: Request,
	options: { optional: boolean },
): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (!text.trim()) {
		if (options.optional) return {};
		throw BadRequest("request body must be a JSON object");
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw BadRequest("request body must contain valid JSON");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw BadRequest("request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isMigrationFamily(value: unknown): value is CodexMigrationFamily {
	return (
		typeof value === "string" &&
		(CODEX_MIGRATION_FAMILIES as readonly string[]).includes(value)
	);
}

function parsePreviewAccountIds(
	body: Record<string, unknown>,
): string[] | undefined {
	const value = body.accountIds;
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every(isNonEmptyString)
	) {
		throw BadRequest(
			"accountIds must be a non-empty array of account ids; omit it for every Codex account",
		);
	}
	return [...new Set(value)];
}

function parseApplyInput(
	body: Record<string, unknown>,
): CodexModelMigrationApplyInput {
	const revision = body.expected_revision;
	if (
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0
	) {
		throw BadRequest("expected_revision must be a non-negative safe integer");
	}
	if (!Array.isArray(body.selections) || body.selections.length === 0) {
		// Selections are never implied: an empty list is not "everything".
		throw BadRequest("selections must be a non-empty array");
	}
	const seen = new Set<string>();
	const selections = body.selections.map(
		(value): CodexModelMigrationSelection => {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw BadRequest("each selection must be an object");
			}
			const selection = value as Record<string, unknown>;
			if (!isNonEmptyString(selection.accountId)) {
				throw BadRequest("selection accountId must be a non-empty string");
			}
			if (!isMigrationFamily(selection.family)) {
				throw BadRequest(
					`selection family must be one of ${CODEX_MIGRATION_FAMILIES.join(", ")}`,
				);
			}
			if (
				!Object.hasOwn(selection, "expected_old_value") ||
				(selection.expected_old_value !== null &&
					typeof selection.expected_old_value !== "string")
			) {
				throw BadRequest(
					"selection expected_old_value must be the previewed raw model_mappings string or null",
				);
			}
			const key = JSON.stringify([selection.accountId, selection.family]);
			if (seen.has(key)) throw BadRequest("duplicate selection");
			seen.add(key);
			return {
				accountId: selection.accountId,
				family: selection.family,
				expected_old_value: selection.expected_old_value as string | null,
			};
		},
	);
	return { expected_revision: revision, selections };
}

/**
 * POST /api/codex/model-migration/preview — read-only "pin → automatic"
 * preview for every Codex account, or the optional `accountIds` subset.
 */
export function createCodexModelMigrationPreviewHandler(
	dbOps: DatabaseOperations,
	options: { routeProfiles?: readonly ModelRouteProfile[] } = {},
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await readObjectBody(req, { optional: true });
			const data = await previewCodexModelMigration(dbOps, {
				accountIds: parsePreviewAccountIds(body),
				routeProfiles: options.routeProfiles,
			});
			return Response.json({ success: true, data });
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/codex/model-migration/apply — remove exactly the selected family
 * pins. 409 `stale_codex_migration_preview` on any revision or row conflict,
 * 409 `codex_migration_selection_not_applicable` when a selection no longer
 * re-verifies; nothing is written in either case.
 */
export function createCodexModelMigrationApplyHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await readObjectBody(req, { optional: false });
			const data = await applyCodexModelMigration(dbOps, parseApplyInput(body));
			return Response.json({ success: true, data });
		} catch (error) {
			return errorResponse(error);
		}
	};
}
