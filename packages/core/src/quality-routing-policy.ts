import { createHash } from "node:crypto";
import type {
	QualityAccountEnrollment,
	QualityApprovedLine,
	QualityLane,
	QualityLineAssignment,
	QualityPermittedFallback,
	QualityPolicyRevision,
	QualityProvider,
	QualityRootPreference,
	QualityRouteChoice,
	QualityRoutingPolicy,
	QualitySpendGrant,
	QualitySuccessorTarget,
} from "@better-ccflare/types";

// Operator assignments, not model capability claims or catalog ordinal roles.
const APPROVED_LINES: Readonly<
	Record<QualityApprovedLine, { lane: QualityLane; provider: QualityProvider }>
> = {
	"claude-fable": { lane: "fable", provider: "anthropic" },
	"gpt-astra": { lane: "astra", provider: "codex" },
	"claude-opus": { lane: "opus", provider: "anthropic" },
	"gpt-sol": { lane: "opus", provider: "codex" },
	"claude-sonnet": { lane: "standard", provider: "anthropic" },
	"claude-haiku": { lane: "lightweight", provider: "anthropic" },
};
const LANES: readonly QualityLane[] = [
	"fable",
	"astra",
	"opus",
	"standard",
	"lightweight",
];

const LINE_LABELS: Readonly<Record<QualityApprovedLine, string>> = {
	"claude-fable": "Fable",
	"gpt-astra": "Astra",
	"claude-opus": "Opus",
	"gpt-sol": "Sol",
	"claude-sonnet": "Sonnet",
	"claude-haiku": "Haiku",
};
const MAIN_LADDERS: Readonly<
	Record<QualityRootPreference, readonly QualityLane[]>
> = {
	auto: ["fable", "astra", "opus"],
	fable: ["fable", "astra", "opus"],
	astra: ["astra", "opus"],
	opus: ["opus"],
};

/**
 * One-line picker description of a main choice's flow, built from the compiled
 * policy only (never account ids). Claude Code cuts descriptions at 100 chars;
 * the worst case (four steps plus the spend note) is 96.
 */
function describeMainLadder(
	policy: Pick<QualityRoutingPolicy, "lanes" | "accounts" | "spendGrants">,
	preference: QualityRootPreference,
): string {
	const enrolled = new Set(policy.accounts.flatMap((account) => account.lines));
	const steps = MAIN_LADDERS[preference]
		.flatMap((laneName) => policy.lanes[laneName])
		.filter((approved) => enrolled.has(approved));
	if (steps.length === 0)
		return "No enrolled account on this ladder · requests fail";
	const paid = policy.spendGrants.some((grant) => steps.includes(grant.line));
	const spend = paid ? "paid use only where approved" : "subscription only";
	return `${steps.map((step) => LINE_LABELS[step]).join(" → ")}, then error · keeps last working model · ${spend}`;
}

function invalid(path: string, message: string): never {
	throw new Error(
		`quality_routing_policy${path ? `.${path}` : ""}: ${message}`,
	);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		invalid(path, "must be an object");
	}
	return value as Record<string, unknown>;
}

function fields(
	value: Record<string, unknown>,
	names: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!names.includes(key)) invalid(path, `unknown field ${key}`);
	}
	for (const name of names) {
		if (!Object.hasOwn(value, name)) invalid(path, `missing field ${name}`);
	}
}

function list(value: unknown, path: string, max: number): unknown[] {
	if (!Array.isArray(value)) invalid(path, "must be an array");
	if (value.length > max) invalid(path, `must contain at most ${max} entries`);
	return value;
}

function text(value: unknown, path: string, max: number): string {
	if (typeof value !== "string") invalid(path, "must be a string");
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > max ||
		Array.from(normalized).some(
			(character) =>
				character.charCodeAt(0) <= 0x20 ||
				character.charCodeAt(0) === 0x7f ||
				character === "*" ||
				/\s/u.test(character),
		)
	) {
		invalid(
			path,
			`must be 1-${max} characters without whitespace, control characters or wildcards`,
		);
	}
	return normalized;
}

function priority(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		invalid(path, "must be a nonnegative safe integer");
	return value === 0 ? 0 : value;
}

function line(value: unknown, path: string): QualityApprovedLine {
	if (typeof value !== "string" || !Object.hasOwn(APPROVED_LINES, value))
		invalid(path, "unknown approved line");
	return value as QualityApprovedLine;
}

function lane(value: unknown, path: string): QualityLane {
	if (typeof value !== "string" || !LANES.includes(value as QualityLane))
		invalid(path, "unknown lane");
	return value as QualityLane;
}

function unique(seen: Set<string>, value: string, path: string): void {
	if (seen.has(value)) invalid(path, "duplicate entry");
	seen.add(value);
}

// Code-point ordering is stable across host locale and object serialization order.
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function parseAssignments(value: unknown): QualityLineAssignment[] {
	const seen = new Set<string>();
	return list(value, "assignments", 6)
		.map((item, index): QualityLineAssignment => {
			const path = `assignments[${index}]`;
			const entry = record(item, path);
			fields(entry, ["line", "lane", "priority", "upgrade"], path);
			const approvedLine = line(entry.line, `${path}.line`);
			unique(seen, approvedLine, path);
			const assignedLane = lane(entry.lane, `${path}.lane`);
			if (assignedLane !== APPROVED_LINES[approvedLine].lane)
				invalid(path, "unapproved line/lane assignment");
			if (
				entry.upgrade !== "same-line-supported" &&
				entry.upgrade !== "exact-only"
			)
				invalid(path, "upgrade must be same-line-supported or exact-only");
			return {
				line: approvedLine,
				lane: assignedLane,
				priority: priority(entry.priority, `${path}.priority`),
				upgrade: entry.upgrade,
			};
		})
		.sort((a, b) => compare(a.line, b.line));
}

function parseAccounts(
	value: unknown,
	assignments: readonly QualityLineAssignment[],
): QualityAccountEnrollment[] {
	const seen = new Set<string>();
	const approved = new Set(assignments.map((assignment) => assignment.line));
	return list(value, "accounts", 256)
		.map((item, index): QualityAccountEnrollment => {
			const path = `accounts[${index}]`;
			const entry = record(item, path);
			fields(entry, ["accountId", "provider", "lines", "priority"], path);
			const accountId = text(entry.accountId, `${path}.accountId`, 128);
			unique(seen, accountId, path);
			if (entry.provider !== "anthropic" && entry.provider !== "codex")
				invalid(path, "unapproved provider");
			const seenLines = new Set<string>();
			const lines = list(entry.lines, `${path}.lines`, 6)
				.map((value) => {
					const approvedLine = line(value, `${path}.lines`);
					unique(seenLines, approvedLine, `${path}.lines`);
					if (!approved.has(approvedLine))
						invalid(path, "unapproved line enrollment");
					if (APPROVED_LINES[approvedLine].provider !== entry.provider)
						invalid(path, "line does not belong to enrolled provider");
					return approvedLine;
				})
				.sort(compare);
			if (!lines.length)
				invalid(path, "must enroll at least one approved line");
			return {
				accountId,
				provider: entry.provider,
				lines,
				priority: priority(entry.priority, `${path}.priority`),
			};
		})
		.sort(
			(a, b) => a.priority - b.priority || compare(a.accountId, b.accountId),
		);
}

function parseFallbacks(value: unknown): QualityPermittedFallback[] {
	const seen = new Set<string>();
	const edges = list(value, "fallbacks", 10).map((item, index) => {
		const path = `fallbacks[${index}]`;
		const entry = record(item, path);
		fields(entry, ["from", "to"], path);
		const from = lane(entry.from, path);
		const to = lane(entry.to, path);
		unique(seen, `${from}:${to}`, path);
		return { from, to };
	});
	const visited = new Set<QualityLane>();
	const visiting = new Set<QualityLane>();
	function visit(current: QualityLane): void {
		if (visiting.has(current)) invalid("fallbacks", "cycle is not permitted");
		if (visited.has(current)) return;
		visiting.add(current);
		for (const edge of edges) if (edge.from === current) visit(edge.to);
		visiting.delete(current);
		visited.add(current);
	}
	for (const current of LANES) visit(current);
	// These exact edges preserve every main preference's approved suffix and
	// prevent workers from silently escalating, dropping roles or using a parent.
	if (edges.length !== 2 || !seen.has("fable:astra") || !seen.has("astra:opus"))
		invalid("fallbacks", "must be exactly fable -> astra and astra -> opus");
	return edges.sort((a, b) => compare(a.from, b.from));
}

function parseGrants(
	value: unknown,
	accounts: readonly QualityAccountEnrollment[],
): QualitySpendGrant[] {
	const seen = new Set<string>();
	return list(value, "spendGrants", 1536)
		.map((item, index): QualitySpendGrant => {
			const path = `spendGrants[${index}]`;
			const entry = record(item, path);
			fields(entry, ["accountId", "line", "authorization", "scope"], path);
			const accountId = text(entry.accountId, `${path}.accountId`, 128);
			const approvedLine = line(entry.line, `${path}.line`);
			if (
				!accounts.some(
					(account) =>
						account.accountId === accountId &&
						account.lines.includes(approvedLine),
				)
			)
				invalid(path, "grant requires an enrolled account and line");
			if (
				entry.authorization !== "operator-approved" ||
				entry.scope !== "outside-subscription"
			)
				invalid(
					path,
					"requires explicit operator-approved outside-subscription authorization",
				);
			unique(seen, JSON.stringify([accountId, approvedLine]), path);
			return {
				accountId,
				line: approvedLine,
				authorization: entry.authorization,
				scope: entry.scope,
			};
		})
		.sort(
			(a, b) => compare(a.accountId, b.accountId) || compare(a.line, b.line),
		);
}

/**
 * Compile trusted operator configuration only. No catalog, environment, clock,
 * provider, DB, home or retry access. Empty input is disabled. Validation is
 * structural enrollment approval; account existence/capability is checked by
 * later admission against that account's evidence, never inferred here.
 */
export function compileQualityRoutingPolicy(
	raw: unknown,
): QualityRoutingPolicy | null {
	if (raw === undefined || (typeof raw === "string" && raw.trim() === ""))
		return null;
	const input = record(raw, "");
	if (Object.keys(input).length === 0) return null;
	fields(
		input,
		["version", "assignments", "accounts", "fallbacks", "spendGrants"],
		"",
	);
	if (input.version !== 1) invalid("version", "must be 1");
	const assignments = parseAssignments(input.assignments);
	const accounts = parseAccounts(input.accounts, assignments);
	const fallbacks = parseFallbacks(input.fallbacks);
	const spendGrants = parseGrants(input.spendGrants, accounts);
	const effective = {
		version: 1 as const,
		assignments,
		accounts,
		fallbacks,
		spendGrants,
	};
	const revision: QualityPolicyRevision = `quality-policy-v1:${createHash("sha256").update(JSON.stringify(effective)).digest("hex")}`;
	const lanes: Record<QualityLane, QualityApprovedLine[]> = {
		fable: [],
		astra: [],
		opus: [],
		standard: [],
		lightweight: [],
	};
	for (const assignment of [...assignments].sort(
		(a, b) => a.priority - b.priority || compare(a.line, b.line),
	))
		lanes[assignment.lane].push(assignment.line);
	const flow = (preference: QualityRootPreference) =>
		describeMainLadder({ lanes, accounts, spendGrants }, preference);
	const choices: QualityRouteChoice[] =
		accounts.length === 0
			? []
			: [
					{
						preference: "auto",
						publicModelId: "claude-bccf-quality-auto",
						displayName: "Auto",
						description: flow("auto"),
						listed: true,
					},
					{
						preference: "fable",
						publicModelId: "claude-bccf-quality-fable",
						displayName: "Fable-preferred",
						description: flow("fable"),
						listed: false,
					},
					{
						preference: "astra",
						publicModelId: "claude-bccf-quality-astra",
						displayName: "Astra-preferred",
						description: flow("astra"),
						listed: true,
					},
					{
						preference: "opus",
						publicModelId: "claude-bccf-quality-opus",
						displayName: "Opus-latest",
						description: flow("opus"),
						listed: true,
					},
				];
	return freeze({
		...effective,
		revision,
		choices,
		lanes,
		mainLadders: MAIN_LADDERS,
		workerLanes: {
			standard: ["standard"],
			lightweight: ["lightweight"],
			fable: ["fable"],
			astra: ["astra"],
			opus: ["opus"],
		},
	});
}

/**
 * Check approval against evidence already verified by the account evidence
 * adapter. This checks provenance bindings, not the truth of a provider claim;
 * never call it with client-supplied evidence as an authorization shortcut.
 */
export function isApprovedQualitySuccessor(
	policy: QualityRoutingPolicy,
	target: QualitySuccessorTarget,
	evidence: unknown,
): boolean {
	const assignment = policy.assignments.find(
		(entry) => entry.line === target.line,
	);
	const account = policy.accounts.find(
		(entry) => entry.accountId === target.accountId,
	);
	if (
		assignment?.upgrade !== "same-line-supported" ||
		!account?.lines.includes(target.line)
	)
		return false;
	try {
		const entry = record(evidence, "evidence");
		fields(
			entry,
			[
				"accountId",
				"line",
				"predecessorModel",
				"successorModel",
				"provider",
				"source",
				"catalogRevision",
				"evidenceRef",
				"supported",
			],
			"evidence",
		);
		for (const key of [
			"predecessorModel",
			"successorModel",
			"catalogRevision",
			"evidenceRef",
		])
			text(entry[key], `evidence.${key}`, 256);
		return (
			entry.supported === true &&
			(entry.source === "provider-catalog" ||
				entry.source === "authoritative-release") &&
			entry.accountId === target.accountId &&
			entry.provider === account.provider &&
			entry.line === target.line &&
			entry.predecessorModel === target.predecessorModel &&
			entry.successorModel === target.successorModel &&
			target.predecessorModel !== target.successorModel
		);
	} catch {
		return false;
	}
}
