import { randomBytes } from "node:crypto";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	bumpPublicRosterGeneration,
	runExclusiveRosterWrite,
} from "../services/public-subscription-roster";
import {
	isValidPublicId,
	isValidPublicLabel,
	MAX_PUBLIC_SUBSCRIPTIONS,
} from "../services/public-subscriptions-config";

const log = new Logger("AccountPublicValueHandler");

const CONFLICT_MESSAGE =
	"Another published account already uses this label, or the published-account limit was reached";

/** SQLite SQLITE_CONSTRAINT_UNIQUE or PostgreSQL 23505. */
function isUniqueViolation(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const e = error as { code?: unknown; errno?: unknown; message?: unknown };
	return (
		e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
		e.code === "23505" ||
		e.errno === "23505" ||
		(typeof e.message === "string" && /UNIQUE constraint/i.test(e.message))
	);
}

/** Opaque, never derived from the account id or name. */
function generatePublicId(accountId: string, taken: Set<string>): string {
	const lowerAccountId = accountId.toLowerCase();
	for (let attempt = 0; attempt < 16; attempt++) {
		const candidate = `sub-${randomBytes(8).toString("hex")}`;
		if (
			!isValidPublicId(candidate) ||
			taken.has(candidate) ||
			candidate.includes(lowerAccountId) ||
			lowerAccountId.includes(candidate)
		)
			continue;
		return candidate;
	}
	throw new Error("Could not generate a public id");
}

/** True when a public label would reveal the account's name or id. */
export function labelRevealsAccount(
	label: string,
	account: { id: string; name: string },
): boolean {
	const lower = label.toLowerCase();
	return (
		lower.includes(account.name.toLowerCase()) ||
		lower.includes(account.id.toLowerCase())
	);
}

/** Label rules that depend on the account; the shared validator covers the rest. */
function labelProblem(
	label: unknown,
	account: { id: string; name: string },
): string | null {
	if (!isValidPublicLabel(label))
		return "Label must be 1-80 characters with no surrounding whitespace, '<', '>' or control characters";
	if (labelRevealsAccount(label, account))
		return "Label must not contain the account name or id";
	return null;
}

/**
 * POST /api/accounts/:id/public-value  { enabled: boolean, label?: string }
 *
 * Publishes, unpublishes or relabels an account on the public subscription
 * value feed. Every refusal writes nothing. Success invalidates the feed cache.
 */
export function createAccountPublicValueHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(BadRequest("Request body must be valid JSON"));
			}
			if (!body || typeof body !== "object" || Array.isArray(body))
				return errorResponse(BadRequest("Request body must be a JSON object"));
			const { enabled, label } = body as { enabled?: unknown; label?: unknown };
			if (typeof enabled !== "boolean")
				return errorResponse(BadRequest("enabled must be a boolean"));
			if (label !== undefined && typeof label !== "string")
				return errorResponse(BadRequest("label must be a string"));

			return await runExclusiveRosterWrite(async () => {
				const account = await dbOps.getAccount(accountId);
				if (!account) return errorResponse(NotFound("Account not found"));

				if (label !== undefined) {
					const problem = labelProblem(label, account);
					if (problem) return errorResponse(BadRequest(problem));
				}
				const effectiveLabel = label ?? account.public_value_label ?? null;
				let publicId = account.public_value_id ?? null;

				if (enabled) {
					if (effectiveLabel === null)
						return errorResponse(BadRequest("A label is required to publish"));
					// A stored label can predate a rename, so re-check it on publish.
					const problem = labelProblem(effectiveLabel, account);
					if (problem) return errorResponse(BadRequest(problem));
					const published = await dbOps.listPublishedPublicValue(
						MAX_PUBLIC_SUBSCRIPTIONS + 1,
					);
					const others = published.filter((row) => row.id !== account.id);
					if (
						others.some(
							(row) =>
								row.public_value_label?.toLowerCase() ===
								effectiveLabel.toLowerCase(),
						)
					)
						return errorResponse(
							BadRequest("Another published account already uses this label"),
						);
					if (others.length >= MAX_PUBLIC_SUBSCRIPTIONS)
						return errorResponse(
							BadRequest(
								`At most ${MAX_PUBLIC_SUBSCRIPTIONS} accounts can be published`,
							),
						);
					if (publicId === null || !isValidPublicId(publicId))
						publicId = generatePublicId(
							account.id,
							new Set(
								published.flatMap((row) =>
									row.public_value_id ? [row.public_value_id] : [],
								),
							),
						);
				}

				// Invalidate on both sides of the write so a refresh that overlaps it
				// can neither be cached nor served.
				bumpPublicRosterGeneration();
				let changed: boolean;
				try {
					changed = await dbOps.setPublicValue(
						account.id,
						{ enabled, label: effectiveLabel, publicId },
						MAX_PUBLIC_SUBSCRIPTIONS,
					);
				} catch (error) {
					if (isUniqueViolation(error)) changed = false;
					else throw error;
				} finally {
					bumpPublicRosterGeneration();
				}
				// The write itself enforces the cap and label uniqueness, so a
				// refusal means another writer got there first.
				if (!changed && enabled)
					return errorResponse(BadRequest(CONFLICT_MESSAGE));
				if (!changed) return errorResponse(NotFound("Account not found"));
				return jsonResponse({
					success: true,
					publicValueEnabled: enabled,
					publicValueLabel: effectiveLabel,
				});
			});
		} catch (error) {
			log.error("Account public-value update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update public value"),
			);
		}
	};
}
