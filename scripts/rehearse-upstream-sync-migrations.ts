#!/usr/bin/env bun

import { isAbsolute, normalize } from "node:path";

const ROLES = ["source", "candidate", "generatedChild", "rollback"] as const;
const DESTRUCTIVE_ROLES = ["candidate", "generatedChild", "rollback"] as const;

type TargetRole = (typeof ROLES)[number];
type Dialect = "sqlite" | "postgres";

type RoleMap = Record<TargetRole, string>;

export interface RehearsalTargets {
	sqlite: RoleMap;
	postgres: RoleMap;
}

export interface ValidatedTarget {
	dialect: Dialect;
	role: TargetRole;
	/** Safe identity only: a normalized file path or host/database pair. */
	identity: string;
}

export interface ValidatedRehearsalTargets {
	sqlite: Record<TargetRole, ValidatedTarget>;
	postgres: Record<TargetRole, ValidatedTarget>;
}

export interface RehearsalPlan {
	mode: "validate-only";
	manifest: "docs/plans/2026-08-24-issue-260-v3.5.67-database-acceptance.json";
	targets: {
		sqlite: Record<TargetRole, string>;
		postgres: Record<TargetRole, string>;
	};
	steps: string[];
	immutableSources: string[];
	destructiveTargets: ValidatedTarget[];
}

export interface RehearsalRequest {
	targets: RehearsalTargets;
	execute?: boolean;
}

export interface RehearsalCallbacks {
	targetExists: (target: ValidatedTarget) => boolean | Promise<boolean>;
	execute?: (plan: RehearsalPlan) => void | Promise<void>;
}

function fail(message: string): never {
	throw new Error(message);
}

function assertRoleMap(
	value: unknown,
	label: string,
): asserts value is RoleMap {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} identities are required`);
	}
	for (const role of ROLES) {
		if (typeof (value as Record<string, unknown>)[role] !== "string") {
			fail(`${label}.${role} must be an explicitly supplied string`);
		}
	}
}

function assertTestMarker(value: string, label: string): void {
	if (!/test/i.test(value)) {
		fail(`${label} must contain an unambiguous test marker`);
	}
}

function assertGeneratedChild(value: string, label: string): void {
	if (!/child/i.test(value)) {
		fail(`${label} must identify a generated child`);
	}
}

function assertDistinct(
	targets: Record<TargetRole, ValidatedTarget>,
	dialect: Dialect,
): void {
	const seen = new Set<string>();
	for (const role of ROLES) {
		const identity = targets[role].identity;
		// A database name identifies the destructive PostgreSQL target even when
		// localhost is spelled through different loopback aliases.
		const collisionKey =
			dialect === "postgres"
				? identity.slice(identity.lastIndexOf("/") + 1)
				: identity;
		if (seen.has(collisionKey)) {
			fail(
				`${dialect} source, candidate, generated child, and rollback must be distinct`,
			);
		}
		seen.add(collisionKey);
	}
}

function validateSqlitePath(role: TargetRole, value: string): ValidatedTarget {
	const label = `sqlite.${role}`;
	if (
		value.trim() === "" ||
		!isAbsolute(value) ||
		value.includes("\0") ||
		value.split(/[\\/]+/).includes("..")
	) {
		fail(`${label} must be an absolute, traversal-free path`);
	}
	const identity = normalize(value);
	assertTestMarker(identity, label);
	if (role === "generatedChild") assertGeneratedChild(identity, label);
	return { dialect: "sqlite", role, identity };
}

function parsePostgresUrl(role: TargetRole, value: string): ValidatedTarget {
	const label = `postgres.${role}`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail(`${label} must be an unambiguous PostgreSQL URL`);
	}
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		fail(`${label} must be a PostgreSQL URL`);
	}
	if (
		url.hash !== "" ||
		url.pathname.length < 2 ||
		url.pathname.includes("%")
	) {
		fail(`${label} must contain exactly one unescaped database name`);
	}
	const databaseName = url.pathname.slice(1);
	if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(databaseName)) {
		fail(`${label} database name is unsafe`);
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
		fail(`${label} must use a loopback host`);
	}
	assertTestMarker(databaseName, label);
	if (role === "generatedChild") assertGeneratedChild(databaseName, label);
	const port = url.port === "" ? "default" : url.port;
	return {
		dialect: "postgres",
		role,
		identity: `${hostname}:${port}/${databaseName}`,
	};
}

/**
 * Removes credentials and all query values before a URL can reach plans or errors.
 */
export function redactDatabaseUrl(value: string): string {
	try {
		const url = new URL(value);
		const authority =
			url.username !== "" || url.password !== "" ? "***:***@" : "";
		const port = url.port === "" ? "" : `:${url.port}`;
		const query = [...url.searchParams.keys()]
			.map((key) => `${encodeURIComponent(key)}=***`)
			.join("&");
		return `${url.protocol}//${authority}${url.hostname}${port}${url.pathname}${query === "" ? "" : `?${query}`}`;
	} catch {
		return "[invalid PostgreSQL URL]";
	}
}

/**
 * Validates identities without opening files, sockets, databases, or subprocesses.
 */
export function validateRehearsalTargets(
	targets: RehearsalTargets,
): ValidatedRehearsalTargets {
	if (targets === null || typeof targets !== "object") {
		fail("rehearsal targets are required");
	}
	assertRoleMap(targets.sqlite, "sqlite");
	assertRoleMap(targets.postgres, "postgres");

	const sqlite = {} as Record<TargetRole, ValidatedTarget>;
	const postgres = {} as Record<TargetRole, ValidatedTarget>;
	for (const role of ROLES) {
		sqlite[role] = validateSqlitePath(role, targets.sqlite[role]);
		postgres[role] = parsePostgresUrl(role, targets.postgres[role]);
	}
	assertDistinct(sqlite, "sqlite");
	assertDistinct(postgres, "postgres");
	return { sqlite, postgres };
}

/**
 * Builds the default non-mutating plan. It deliberately has no ambient config,
 * database driver, filesystem probe, subprocess, or fallback target.
 */
export function buildRehearsalPlan(targets: RehearsalTargets): RehearsalPlan {
	const validated = validateRehearsalTargets(targets);
	const postgres = {} as Record<TargetRole, string>;
	const sqlite = {} as Record<TargetRole, string>;
	for (const role of ROLES) {
		sqlite[role] = validated.sqlite[role].identity;
		postgres[role] = validated.postgres[role].identity;
	}
	return {
		mode: "validate-only",
		manifest:
			"docs/plans/2026-08-24-issue-260-v3.5.67-database-acceptance.json",
		targets: { sqlite, postgres },
		steps: [
			"validate explicit identities",
			"verify destructive targets are absent",
			"record redacted forward-and-restore rehearsal plan",
		],
		immutableSources: [sqlite.source, postgres.source],
		destructiveTargets: [
			...DESTRUCTIVE_ROLES.map((role) => validated.sqlite[role]),
			...DESTRUCTIVE_ROLES.map((role) => validated.postgres[role]),
		],
	};
}

/**
 * Checks only distinct destructive candidates. Callers supply the probe so the
 * pure planner never opens a filesystem path or a database connection.
 */
export function assertDestructiveTargetsAbsent(
	plan: RehearsalPlan,
	targetExists: (target: ValidatedTarget) => boolean,
): void {
	for (const target of plan.destructiveTargets) {
		if (targetExists(target)) {
			fail(`${target.dialect}.${target.role} target already exists`);
		}
	}
}

/**
 * Guard ordering for a future executor. No execution implementation is shipped:
 * callers must explicitly request execution and inject a previously-reviewed
 * executor after validation and absence checks succeed.
 */
export async function runGuardedRehearsal(
	request: RehearsalRequest,
	callbacks: RehearsalCallbacks,
): Promise<RehearsalPlan> {
	const plan = buildRehearsalPlan(request.targets);
	for (const target of plan.destructiveTargets) {
		if (await callbacks.targetExists(target)) {
			fail(`${target.dialect}.${target.role} target already exists`);
		}
	}
	if (request.execute !== true) return plan;
	if (!callbacks.execute) {
		fail("execution requires an explicitly supplied executor");
	}
	await callbacks.execute(plan);
	return plan;
}

function parseCliArgs(argv: string[]): RehearsalRequest {
	const targetsIndex = argv.indexOf("--targets-json");
	if (targetsIndex === -1 || argv[targetsIndex + 1] === undefined) {
		fail(
			"supply explicit --targets-json; no ambient database configuration is used",
		);
	}
	let targets: unknown;
	try {
		targets = JSON.parse(argv[targetsIndex + 1]);
	} catch {
		fail("--targets-json must contain valid JSON");
	}
	return {
		targets: targets as RehearsalTargets,
		execute: argv.includes("--execute"),
	};
}

if (import.meta.main) {
	try {
		const request = parseCliArgs(process.argv.slice(2));
		if (request.execute) {
			fail(
				"execution is unavailable in this safety-only harness; no mutation was attempted",
			);
		}
		console.log(JSON.stringify(buildRehearsalPlan(request.targets), null, 2));
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "invalid rehearsal request";
		console.error(`rehearsal guard: ${message}`);
		process.exitCode = 1;
	}
}
