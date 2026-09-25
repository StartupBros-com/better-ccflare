import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { ComboRepository } from "../combo.repository";

// Fictitious accounts and next-generation model names only.
const ALPHA_OLD = JSON.stringify({
	opus: "gpt-6-astra",
	sonnet: ["gpt-6-sol", "gpt-6-sol-mini"],
	"claude-opus-4-8": "gpt-6-astra",
});
const BETA_OLD = JSON.stringify({ haiku: "gpt-6-luna" });

describe("ComboRepository guarded model_mappings writes", () => {
	let db: Database;
	let repo: ComboRepository;

	const mappings = (id: string): string | null =>
		db
			.query<{ model_mappings: string | null }, [string]>(
				"SELECT model_mappings FROM accounts WHERE id = ?",
			)
			.get(id)?.model_mappings ?? null;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at, model_mappings) VALUES (?, ?, 'codex', 1, ?), (?, ?, 'codex', 1, ?), (?, ?, 'codex', 1, NULL)",
			[
				"codex-alpha",
				"alpha",
				ALPHA_OLD,
				"codex-beta",
				"beta",
				BETA_OLD,
				"codex-gamma",
				"gamma",
			],
		);
		repo = new ComboRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	it("writes every guarded row in one batch and advances the revision exactly once", async () => {
		const revision = await repo.getRoutingPolicyRevision();
		const alphaNew = JSON.stringify({
			sonnet: ["gpt-6-sol", "gpt-6-sol-mini"],
			"claude-opus-4-8": "gpt-6-astra",
		});

		const result = await repo.applyGuardedModelMappingsWrites({
			expected_revision: revision,
			writes: [
				{
					account_id: "codex-alpha",
					expected_old_value: ALPHA_OLD,
					new_value: alphaNew,
				},
				{
					account_id: "codex-beta",
					expected_old_value: BETA_OLD,
					new_value: null,
				},
			],
		});

		expect(result).toEqual({ revision: revision + 1, written: 2 });
		expect(await repo.getRoutingPolicyRevision()).toBe(revision + 1);
		expect(mappings("codex-alpha")).toBe(alphaNew);
		expect(mappings("codex-beta")).toBeNull();
		expect(mappings("codex-gamma")).toBeNull();
	});

	it("rejects a stale revision with a revision conflict and leaves every row untouched", async () => {
		const revision = await repo.getRoutingPolicyRevision();
		// Any unrelated routing-policy write advances the revision.
		db.run("UPDATE accounts SET priority = 7 WHERE id = 'codex-gamma'");
		expect(await repo.getRoutingPolicyRevision()).toBe(revision + 1);

		await expect(
			repo.applyGuardedModelMappingsWrites({
				expected_revision: revision,
				writes: [
					{
						account_id: "codex-alpha",
						expected_old_value: ALPHA_OLD,
						new_value: null,
					},
				],
			}),
		).rejects.toMatchObject({
			code: "stale_model_mappings_write",
			reason: "revision",
		});
		expect(mappings("codex-alpha")).toBe(ALPHA_OLD);
		expect(await repo.getRoutingPolicyRevision()).toBe(revision + 1);
	});

	it("rejects a stale row with a row conflict and rolls back the rows written before it", async () => {
		// A changed row without a revision advance models an upgraded PostgreSQL
		// install whose account update trigger was not (re)installed: the per-row
		// guard is then the only thing standing between the preview and the write.
		db.run("UPDATE accounts SET model_mappings = ? WHERE id = 'codex-beta'", [
			JSON.stringify({ haiku: "gpt-7-luna" }),
		]);
		db.run(
			"UPDATE routing_policy_revision SET revision = 40 WHERE scope = 'global'",
		);

		await expect(
			repo.applyGuardedModelMappingsWrites({
				expected_revision: 40,
				writes: [
					{
						account_id: "codex-alpha",
						expected_old_value: ALPHA_OLD,
						new_value: null,
					},
					{
						account_id: "codex-beta",
						expected_old_value: BETA_OLD,
						new_value: null,
					},
				],
			}),
		).rejects.toMatchObject({
			code: "stale_model_mappings_write",
			reason: "row",
			accountId: "codex-beta",
		});
		expect(mappings("codex-alpha")).toBe(ALPHA_OLD);
		expect(mappings("codex-beta")).toBe(
			JSON.stringify({ haiku: "gpt-7-luna" }),
		);
		expect(await repo.getRoutingPolicyRevision()).toBe(40);
	});

	it("compares the old value null-safely in both directions", async () => {
		const revision = await repo.getRoutingPolicyRevision();
		// A NULL row never matches a non-null expectation...
		await expect(
			repo.applyGuardedModelMappingsWrites({
				expected_revision: revision,
				writes: [
					{
						account_id: "codex-gamma",
						expected_old_value: "{}",
						new_value: BETA_OLD,
					},
				],
			}),
		).rejects.toMatchObject({ reason: "row", accountId: "codex-gamma" });
		// ...and a non-null row never matches a NULL expectation.
		await expect(
			repo.applyGuardedModelMappingsWrites({
				expected_revision: revision,
				writes: [
					{
						account_id: "codex-beta",
						expected_old_value: null,
						new_value: ALPHA_OLD,
					},
				],
			}),
		).rejects.toMatchObject({ reason: "row", accountId: "codex-beta" });
		expect(mappings("codex-gamma")).toBeNull();
		expect(mappings("codex-beta")).toBe(BETA_OLD);
		expect(await repo.getRoutingPolicyRevision()).toBe(revision);

		// A NULL expectation does match a NULL row (plain `=` never would).
		const result = await repo.applyGuardedModelMappingsWrites({
			expected_revision: revision,
			writes: [
				{
					account_id: "codex-gamma",
					expected_old_value: null,
					new_value: BETA_OLD,
				},
			],
		});
		expect(result.revision).toBe(revision + 1);
		expect(mappings("codex-gamma")).toBe(BETA_OLD);
	});

	it("rejects a missing account as a stale row", async () => {
		const revision = await repo.getRoutingPolicyRevision();
		await expect(
			repo.applyGuardedModelMappingsWrites({
				expected_revision: revision,
				writes: [
					{
						account_id: "codex-missing",
						expected_old_value: ALPHA_OLD,
						new_value: null,
					},
				],
			}),
		).rejects.toMatchObject({ reason: "row", accountId: "codex-missing" });
		expect(await repo.getRoutingPolicyRevision()).toBe(revision);
	});

	it("refuses malformed batches before touching the database", async () => {
		const revision = await repo.getRoutingPolicyRevision();
		const write = {
			account_id: "codex-alpha",
			expected_old_value: ALPHA_OLD,
			new_value: null,
		};
		for (const input of [
			{ expected_revision: revision, writes: [] },
			{ expected_revision: -1, writes: [write] },
			{ expected_revision: 1.5, writes: [write] },
			// One account is one guarded write: grouping happens before the batch.
			{ expected_revision: revision, writes: [write, write] },
			// A no-op write could not prove its guard through a revision advance.
			{
				expected_revision: revision,
				writes: [{ ...write, new_value: ALPHA_OLD }],
			},
			{ expected_revision: revision, writes: [{ ...write, account_id: "" }] },
		]) {
			await expect(
				repo.applyGuardedModelMappingsWrites(input),
			).rejects.toThrow();
		}
		expect(mappings("codex-alpha")).toBe(ALPHA_OLD);
		expect(await repo.getRoutingPolicyRevision()).toBe(revision);
	});
});
