import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import {
	SERVER_TOOL_REPLAY_ISSUANCE_MAX,
	SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
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

	it("atomically reserves the requested bounded range", async () => {
		const first = await repository.reserveReplayIssuanceRange({
			counterIdentity: COUNTER_IDENTITY,
			reservationSize: 7,
		});
		const second = await repository.reserveReplayIssuanceRange({
			counterIdentity: COUNTER_IDENTITY,
			reservationSize: 9,
		});

		expect(first).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			firstIssuanceCount: 1,
			lastIssuanceCount: 7,
		});
		expect(second).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			firstIssuanceCount: 8,
			lastIssuanceCount: 16,
		});
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			issuanceCount: 16,
		});
	});

	it("serializes concurrent reservation amounts into disjoint monotonic ranges", async () => {
		const reservations = await Promise.all(
			Array.from({ length: 32 }, () =>
				repository.reserveReplayIssuanceRange({
					counterIdentity: COUNTER_IDENTITY,
					reservationSize: 3,
				}),
			),
		);
		const claimed = reservations
			.flatMap((range) =>
				Array.from(
					{
						length: range.lastIssuanceCount - range.firstIssuanceCount + 1,
					},
					(_, index) => range.firstIssuanceCount + index,
				),
			)
			.sort((a, b) => a - b);

		expect(claimed).toEqual(
			Array.from({ length: 96 }, (_, index) => index + 1),
		);
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			issuanceCount: 96,
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
			unavailableRepository.reserveReplayIssuanceRange({
				counterIdentity: COUNTER_IDENTITY,
				reservationSize: 7,
			}),
		).rejects.toThrow("database unavailable");
		expect(calls).toBe(1);
	});

	it("reserves the final aligned block at the global cap and then fails closed", async () => {
		db.run(
			`INSERT INTO server_tool_replay_issuance (counter_identity, issuance_count)
			 VALUES (?, ?)`,
			[
				COUNTER_IDENTITY,
				SERVER_TOOL_REPLAY_ISSUANCE_MAX -
					SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
			],
		);

		const final = await repository.reserveReplayIssuanceRange({
			counterIdentity: COUNTER_IDENTITY,
			reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
		});
		expect(final).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			firstIssuanceCount:
				SERVER_TOOL_REPLAY_ISSUANCE_MAX -
				SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX +
				1,
			lastIssuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_MAX,
		});

		await expect(
			repository.reserveReplayIssuanceRange({
				counterIdentity: COUNTER_IDENTITY,
				reservationSize: 1,
			}),
		).rejects.toBeInstanceOf(ServerToolReplayIssuanceLimitError);
	});

	it("enforces the global cap across independent stores", async () => {
		db.run(
			`INSERT INTO server_tool_replay_issuance (counter_identity, issuance_count)
			 VALUES (?, ?)`,
			[
				COUNTER_IDENTITY,
				SERVER_TOOL_REPLAY_ISSUANCE_MAX -
					SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
			],
		);
		const secondStore = new ServerToolReplayIssuanceRepository(
			new BunSqlAdapter(db),
		);
		const outcomes = await Promise.allSettled([
			repository.reserveReplayIssuanceRange({
				counterIdentity: COUNTER_IDENTITY,
				reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
			}),
			secondStore.reserveReplayIssuanceRange({
				counterIdentity: COUNTER_IDENTITY,
				reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
			}),
		]);

		expect(
			outcomes.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		const rejected = outcomes.find(({ status }) => status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: expect.any(ServerToolReplayIssuanceLimitError),
		});
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toEqual({
			counterIdentity: COUNTER_IDENTITY,
			issuanceCount: SERVER_TOOL_REPLAY_ISSUANCE_MAX,
		});
	});

	it("rejects invalid identities and reservation sizes before SQL", async () => {
		const valid = {
			counterIdentity: COUNTER_IDENTITY,
			reservationSize: 7,
		};
		for (const input of [
			{ ...valid, counterIdentity: "" },
			{ ...valid, counterIdentity: ` ${COUNTER_IDENTITY}` },
			{ ...valid, counterIdentity: "x".repeat(513) },
			{ ...valid, reservationSize: 0 },
			{ ...valid, reservationSize: 1.5 },
			{
				...valid,
				reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX + 1,
			},
		]) {
			await expect(
				repository.reserveReplayIssuanceRange(input),
			).rejects.toBeInstanceOf(TypeError);
		}
		expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toBeNull();
	});

	it("rejects non-canonical portable integer output", async () => {
		const corruptAdapter = {
			get: async () => ({
				counter_identity: COUNTER_IDENTITY,
				issuance_count_text: "1e3",
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
	it("creates the upgrade-safe table and atomically reserves concurrent amounts", async () => {
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
				Array.from({ length: 16 }, () =>
					repository.reserveReplayIssuanceRange({
						counterIdentity: COUNTER_IDENTITY,
						reservationSize: 7,
					}),
				),
			);
			const claimed = rows
				.flatMap((range) =>
					Array.from(
						{
							length: range.lastIssuanceCount - range.firstIssuanceCount + 1,
						},
						(_, index) => range.firstIssuanceCount + index,
					),
				)
				.sort((a, b) => a - b);
			expect(claimed).toEqual(
				Array.from({ length: 16 * 7 }, (_, index) => index + 1),
			);
			expect(await repository.getReplayIssuance(COUNTER_IDENTITY)).toEqual({
				counterIdentity: COUNTER_IDENTITY,
				issuanceCount: 16 * 7,
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
