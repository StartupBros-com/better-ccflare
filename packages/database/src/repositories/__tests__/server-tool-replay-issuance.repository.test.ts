import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import {
	SERVER_TOOL_REPLAY_ISSUANCE_MAX,
	ServerToolReplayIssuanceDataIntegrityError,
	ServerToolReplayIssuanceLimitError,
	ServerToolReplayIssuanceRepository,
} from "../server-tool-replay-issuance.repository";

const COUNTER_IDENTITY =
	"better-ccflare.aes-256-gcm.keyfp.v1.test-opaque-counter";

describe("ServerToolReplayIssuanceRepository", () => {
	let db: Database;
	let repository: ServerToolReplayIssuanceRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new ServerToolReplayIssuanceRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("atomically increments a portable counter and preserves first metadata", async () => {
		const first = await repository.reserveReplayIssuance({
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-r1",
			buildSha: "build-a",
			decoderRevision: "decoder-r1",
			now: 1_000,
		});
		const second = await repository.reserveReplayIssuance({
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-r2",
			buildSha: "build-b",
			decoderRevision: "decoder-r2",
			now: 2_000,
		});

		expect(first.issuanceCount).toBe(1);
		expect(second).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			issuanceCount: 2,
			firstIssuedAt: 1_000,
			lastIssuedAt: 2_000,
			firstWriterRevision: "writer-r1",
			firstBuildSha: "build-a",
			firstDecoderRevision: "decoder-r1",
			lastWriterRevision: "writer-r2",
			lastBuildSha: "build-b",
			lastDecoderRevision: "decoder-r2",
		});
	});

	it("serializes concurrent reservations into unique monotonic counts", async () => {
		const reservations = await Promise.all(
			Array.from({ length: 32 }, (_, index) =>
				repository.reserveReplayIssuance({
					counterIdentity: COUNTER_IDENTITY,
					writerRevision: `writer-${index % 2}`,
					buildSha: `build-${index % 3}`,
					decoderRevision: `decoder-${index % 2}`,
					now: 10_000 + index,
				}),
			),
		);

		expect(
			reservations.map((row) => row.issuanceCount).sort((a, b) => a - b),
		).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toMatchObject({
			issuanceCount: 32,
			firstIssuedAt: 10_000,
			lastIssuedAt: 10_031,
		});
	});

	it("propagates an unavailable atomic reservation without a fallback write", async () => {
		let calls = 0;
		const unavailableAdapter = {
			runReturningOne: async () => {
				calls += 1;
				throw new Error("database unavailable");
			},
		};
		const unavailableRepository = new ServerToolReplayIssuanceRepository(
			unavailableAdapter as unknown as BunSqlAdapter,
		);

		await expect(
			unavailableRepository.reserveReplayIssuance({
				counterIdentity: COUNTER_IDENTITY,
				writerRevision: "writer-r1",
				buildSha: "build-a",
				decoderRevision: "decoder-r1",
				now: 1_000,
			}),
		).rejects.toThrow("database unavailable");
		expect(calls).toBe(1);
	});

	it("does not let a late older timestamp roll back last-writer metadata", async () => {
		await repository.reserveReplayIssuance({
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-new",
			buildSha: "build-new",
			decoderRevision: "decoder-new",
			now: 2_000,
		});
		const result = await repository.reserveReplayIssuance({
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-old",
			buildSha: "build-old",
			decoderRevision: "decoder-old",
			now: 1_000,
		});

		expect(result).toMatchObject({
			issuanceCount: 2,
			lastIssuedAt: 2_000,
			lastWriterRevision: "writer-new",
			lastBuildSha: "build-new",
			lastDecoderRevision: "decoder-new",
		});
	});

	it("returns the final value at the portable cap and then fails closed", async () => {
		db.run(
			`INSERT INTO server_tool_replay_issuance (
				counter_identity, issuance_count, first_issued_at, last_issued_at,
				first_writer_revision, first_build_sha, first_decoder_revision,
				last_writer_revision, last_build_sha, last_decoder_revision
			) VALUES (?, ?, 1, 1, 'writer-r1', 'build-a', 'decoder-r1',
				'writer-r1', 'build-a', 'decoder-r1')`,
			[COUNTER_IDENTITY, SERVER_TOOL_REPLAY_ISSUANCE_MAX - 1],
		);

		const final = await repository.reserveReplayIssuance({
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-r2",
			buildSha: "build-b",
			decoderRevision: "decoder-r2",
			now: 2,
		});
		expect(final.issuanceCount).toBe(SERVER_TOOL_REPLAY_ISSUANCE_MAX);

		await expect(
			repository.reserveReplayIssuance({
				counterIdentity: COUNTER_IDENTITY,
				writerRevision: "writer-r3",
				buildSha: "build-c",
				decoderRevision: "decoder-r3",
				now: 3,
			}),
		).rejects.toBeInstanceOf(ServerToolReplayIssuanceLimitError);
	});

	it("rejects unbounded, padded, controlled, or invalid-time input before SQL", async () => {
		const valid = {
			counterIdentity: COUNTER_IDENTITY,
			writerRevision: "writer-r1",
			buildSha: "build-a",
			decoderRevision: "decoder-r1",
			now: 1_000,
		};
		for (const input of [
			{ ...valid, counterIdentity: "" },
			{ ...valid, counterIdentity: ` ${COUNTER_IDENTITY}` },
			{ ...valid, counterIdentity: "x".repeat(513) },
			{ ...valid, writerRevision: "writer\nrevision" },
			{ ...valid, writerRevision: "x".repeat(257) },
			{ ...valid, buildSha: "x".repeat(257) },
			{ ...valid, decoderRevision: "" },
			{ ...valid, decoderRevision: "x".repeat(257) },
			{ ...valid, now: -1 },
			{ ...valid, now: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			await expect(
				repository.reserveReplayIssuance(input),
			).rejects.toBeInstanceOf(TypeError);
		}
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toBeNull();
	});

	it("rejects non-canonical portable integer output", async () => {
		const corruptAdapter = {
			get: async () => ({
				counter_identity: COUNTER_IDENTITY,
				issuance_count_text: "1e3",
				first_issued_at_text: "1000",
				last_issued_at_text: "1000",
				first_writer_revision: "writer",
				first_build_sha: "build",
				first_decoder_revision: "decoder",
				last_writer_revision: "writer",
				last_build_sha: "build",
				last_decoder_revision: "decoder",
			}),
		};
		const corruptRepository = new ServerToolReplayIssuanceRepository(
			corruptAdapter as unknown as BunSqlAdapter,
		);

		await expect(
			corruptRepository.getReplayIssuance(COUNTER_IDENTITY),
		).rejects.toBeInstanceOf(ServerToolReplayIssuanceDataIntegrityError);
	});
});

const configuredPostgresUrl = process.env.BETTER_CCFLARE_TEST_POSTGRES_URL;

function requireSafeTestPostgresUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
		url.hostname,
	);
	const isTestDatabase = /(?:^|[_-])test(?:$|[_-])/i.test(databaseName);
	if (!isLoopback || !isTestDatabase) {
		throw new Error(
			"BETTER_CCFLARE_TEST_POSTGRES_URL must target a loopback-hosted database with 'test' in its name",
		);
	}
	return url.toString();
}

const postgresUrl = configuredPostgresUrl
	? requireSafeTestPostgresUrl(configuredPostgresUrl)
	: undefined;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres("ServerToolReplayIssuanceRepository PostgreSQL parity", () => {
	it("creates the upgrade-safe table and reserves concurrent monotonic counts", async () => {
		if (!postgresUrl) throw new Error("PostgreSQL integration URL is required");
		const databaseName = `ccflare_replay_${randomUUID().replaceAll("-", "")}`;
		const adminSql = new SQL({ url: postgresUrl, max: 1, prepare: false });
		const databaseUrl = new URL(postgresUrl);
		databaseUrl.pathname = `/${databaseName}`;
		let adapter: BunSqlAdapter | undefined;
		let databaseCreated = false;
		try {
			await adminSql.unsafe(`CREATE DATABASE ${databaseName}`);
			databaseCreated = true;
			const sql = new SQL({
				url: databaseUrl.toString(),
				max: 8,
				prepare: false,
			});
			adapter = new BunSqlAdapter(sql, false);
			await ensureSchemaPg(adapter);
			await runMigrationsPg(adapter);
			const repository = new ServerToolReplayIssuanceRepository(adapter);
			const rows = await Promise.all(
				Array.from({ length: 16 }, (_, index) =>
					repository.reserveReplayIssuance({
						counterIdentity: COUNTER_IDENTITY,
						writerRevision: `writer-${index}`,
						buildSha: `build-${index}`,
						decoderRevision: `decoder-${index}`,
						now: 20_000 + index,
					}),
				),
			);
			expect(
				rows.map((row) => row.issuanceCount).sort((a, b) => a - b),
			).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
			expect(
				await repository.getReplayIssuance(COUNTER_IDENTITY),
			).toMatchObject({
				issuanceCount: 16,
				firstIssuedAt: 20_000,
				lastIssuedAt: 20_015,
			});
		} finally {
			await adapter?.close();
			if (databaseCreated) {
				await adminSql.unsafe(
					`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
				);
			}
			await adminSql.end();
		}
	});
});
