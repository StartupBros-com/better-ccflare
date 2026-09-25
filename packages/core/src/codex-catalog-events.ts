import { EventEmitter } from "node:events";

/**
 * Codex catalog, pin and client-identity conditions observed by the proxy and
 * turned into alerts by AlertService (packages/http-api/src/services/alerts.ts).
 *
 * The bus lives in core for the same reason as auth-failure-events.ts: the
 * proxy must emit without importing http-api, which already depends on the
 * proxy. Payloads carry account ids/names, family names and model slugs only —
 * never credentials, file paths or account emails.
 */
export type CodexCatalogFamily = "fable" | "opus" | "sonnet" | "haiku";

export const CODEX_CATALOG_FAMILIES: readonly CodexCatalogFamily[] = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
];

/** An account's own catalog now puts a different model at a family's role. */
export interface CodexRoleTargetChangedEvt {
	type: "role_target_changed";
	accountId: string;
	accountName: string;
	family: CodexCatalogFamily;
	from: string;
	to: string;
}

/**
 * One successful publication of an account's OWN catalog. Pin status is
 * classified by the subscriber, which owns the pin-attribution resolver.
 */
export interface CodexOwnCatalogPublishedEvt {
	type: "own_catalog_published";
	accountId: string;
	accountName: string;
	/** Listed model slugs, provider priority order. */
	models: readonly string[];
	/** The role target per family, derived exactly as routing derives it. */
	roleTargets: Readonly<Partial<Record<CodexCatalogFamily, string>>>;
}

/** The last successful own fetch is old and the latest attempt failed. */
export interface CodexCatalogStaleEvt {
	type: "catalog_stale";
	accountId: string;
	accountName: string;
	ageMs: number;
}

export type CodexRouteRoleFailureReason =
	| "catalog_role_unavailable"
	| "catalog_role_mismatch";

/** A catalog-role route profile failed closed. */
export interface CodexRouteRoleUnavailableEvt {
	type: "route_role_unavailable";
	profileId: string;
	/** Present when the profile pins one account; absent for a pool profile. */
	accountId?: string;
	reason: CodexRouteRoleFailureReason;
}

/** Safe status codes from the Codex client-identity resolver, never a path. */
export type CodexIdentityRecordError =
	| "stale_record"
	| "unavailable_record"
	| "invalid_record"
	| "invalid_path";

/** A configured verified Codex CLI version record is stale or unreadable. */
export interface CodexIdentityRecordStaleEvt {
	type: "identity_record_stale";
	error: CodexIdentityRecordError;
	/** The client version ccflare is advertising right now. */
	version: string;
	/** When the record that is still in use was verified, if any. */
	verifiedAt?: string;
}

export type CodexCatalogEvt =
	| CodexRoleTargetChangedEvt
	| CodexOwnCatalogPublishedEvt
	| CodexCatalogStaleEvt
	| CodexRouteRoleUnavailableEvt
	| CodexIdentityRecordStaleEvt;

class CodexCatalogEventBus extends EventEmitter {}
export const codexCatalogEvents = new CodexCatalogEventBus();

codexCatalogEvents.setMaxListeners(200);

/**
 * Emit from a proxy path without letting a synchronous listener failure reach
 * the caller: catalog publication and fail-closed responses must not depend on
 * whether alerting works.
 */
export function emitCodexCatalogEvent(event: CodexCatalogEvt): void {
	try {
		codexCatalogEvents.emit("event", event);
	} catch {
		// Subscribers contain and log their own failures.
	}
}
