import { describe, expect, test } from "bun:test";
import {
	assertDestructiveTargetsAbsent,
	buildRehearsalPlan,
	type RehearsalTargets,
	redactDatabaseUrl,
	runGuardedRehearsal,
	validateRehearsalTargets,
} from "../rehearse-upstream-sync-migrations";

function targets(overrides: Partial<RehearsalTargets> = {}): RehearsalTargets {
	return {
		sqlite: {
			source: "/tmp/ccflare-rehearsal-test-source.sqlite",
			candidate: "/tmp/ccflare-rehearsal-test-candidate.sqlite",
			generatedChild: "/tmp/ccflare-rehearsal-test-candidate-child.sqlite",
			rollback: "/tmp/ccflare-rehearsal-test-rollback.sqlite",
		},
		postgres: {
			source: "postgresql://fixture:secret@localhost:5432/ccflare_source_test",
			candidate:
				"postgresql://fixture:secret@127.0.0.1:5432/ccflare_candidate_test",
			generatedChild:
				"postgresql://fixture:secret@[::1]:5432/ccflare_candidate_test_child",
			rollback:
				"postgresql://fixture:secret@localhost:5432/ccflare_rollback_test",
		},
		...overrides,
	};
}

describe("guarded upstream-sync migration rehearsal", () => {
	test("builds a validation-only redacted plan from explicitly distinct test targets", () => {
		const plan = buildRehearsalPlan(targets());

		expect(plan.mode).toBe("validate-only");
		expect(plan.steps).toEqual([
			"validate explicit identities",
			"verify destructive targets are absent",
			"record redacted forward-and-restore rehearsal plan",
		]);
		expect(plan.targets.postgres.source).toContain("localhost");
		expect(JSON.stringify(plan)).not.toContain("fixture");
		expect(JSON.stringify(plan)).not.toContain("secret");
		expect(JSON.stringify(plan)).not.toContain("postgresql://");
	});

	test("rejects an unsafe target before a target-existence callback can run", () => {
		let probes = 0;
		const unsafe = targets({
			postgres: {
				...targets().postgres,
				candidate:
					"postgresql://fixture:secret@db.example.com:5432/ccflare_test",
			},
		});

		expect(() => {
			const plan = buildRehearsalPlan(unsafe);
			assertDestructiveTargetsAbsent(plan, () => {
				probes++;
				return false;
			});
		}).toThrow("loopback host");
		expect(probes).toBe(0);
	});

	test("rejects unsafe execution requests before connector or executor callbacks", async () => {
		let callbacks = 0;
		await expect(
			runGuardedRehearsal(
				{
					execute: true,
					targets: targets({
						postgres: {
							...targets().postgres,
							candidate:
								"postgresql://fixture:secret@db.example.com:5432/ccflare_candidate_test",
						},
					}),
				},
				{
					targetExists: () => {
						callbacks++;
						return false;
					},
					execute: () => {
						callbacks++;
					},
				},
			),
		).rejects.toThrow("loopback host");
		expect(callbacks).toBe(0);
	});

	test("rejects missing, duplicate, source-as-target, non-test, and unsafe child identities", () => {
		expect(() =>
			validateRehearsalTargets({ ...targets(), sqlite: undefined } as never),
		).toThrow("sqlite identities are required");
		expect(() =>
			validateRehearsalTargets(
				targets({
					sqlite: {
						...targets().sqlite,
						candidate: "/tmp/ccflare-rehearsal-test-source.sqlite",
					},
				}),
			),
		).toThrow("must be distinct");
		expect(() =>
			validateRehearsalTargets(
				targets({
					postgres: {
						...targets().postgres,
						rollback:
							"postgresql://fixture:secret@localhost:5432/ccflare_candidate_test",
					},
				}),
			),
		).toThrow("must be distinct");
		expect(() =>
			validateRehearsalTargets(
				targets({
					postgres: {
						...targets().postgres,
						candidate:
							"postgresql://fixture:secret@localhost:5432/ccflare_candidate",
					},
				}),
			),
		).toThrow("test marker");
		expect(() =>
			validateRehearsalTargets(
				targets({
					postgres: {
						...targets().postgres,
						generatedChild:
							"postgresql://fixture:secret@localhost:5432/ccflare_test_candidate",
					},
				}),
			),
		).toThrow("generated child");
	});

	test("rejects a pre-existing candidate or rollback target without probing sources", () => {
		const plan = buildRehearsalPlan(targets());
		const checked: string[] = [];

		expect(() =>
			assertDestructiveTargetsAbsent(plan, (target) => {
				checked.push(target.identity);
				return target.role === "candidate";
			}),
		).toThrow("candidate target already exists");
		expect(checked).toEqual(["/tmp/ccflare-rehearsal-test-candidate.sqlite"]);
	});

	test("redacts userinfo and every query value from URLs and validation errors", () => {
		const url =
			"postgresql://fixture:secret@localhost:5432/ccflare_source_test?sslmode=require&token=abc";
		expect(redactDatabaseUrl(url)).toBe(
			"postgresql://***:***@localhost:5432/ccflare_source_test?sslmode=***&token=***",
		);
		expect(() =>
			validateRehearsalTargets(
				targets({
					postgres: {
						...targets().postgres,
						source: url.replace("localhost", "db.example.com"),
					},
				}),
			),
		).toThrow("postgres.source must use a loopback host");
	});
});
