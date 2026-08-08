import { BaseRepository } from "./base.repository";

export const SERVER_TOOL_REPLAY_ISSUANCE_MAX = 2 ** 31;

const PORTABLE_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface ServerToolReplayIssuance {
	counterIdentity: string;
	issuanceCount: number;
	firstIssuedAt: number;
	lastIssuedAt: number;
	firstWriterRevision: string;
	firstBuildSha: string;
	firstDecoderRevision: string;
	lastWriterRevision: string;
	lastBuildSha: string;
	lastDecoderRevision: string;
}

export interface ReserveReplayIssuanceInput {
	counterIdentity: string;
	writerRevision: string;
	buildSha: string;
	decoderRevision: string;
	now: number;
}

interface ReplayIssuanceRow {
	counter_identity: string;
	issuance_count_text: string;
	first_issued_at_text: string;
	last_issued_at_text: string;
	first_writer_revision: string;
	first_build_sha: string;
	first_decoder_revision: string;
	last_writer_revision: string;
	last_build_sha: string;
	last_decoder_revision: string;
}

const REPLAY_ISSUANCE_COLUMNS = `
	counter_identity,
	CAST(issuance_count AS TEXT) AS issuance_count_text,
	CAST(first_issued_at AS TEXT) AS first_issued_at_text,
	CAST(last_issued_at AS TEXT) AS last_issued_at_text,
	first_writer_revision,
	first_build_sha,
	first_decoder_revision,
	last_writer_revision,
	last_build_sha,
	last_decoder_revision`;

export class ServerToolReplayIssuanceLimitError extends Error {
	constructor() {
		super("Server-tool replay issuance is unavailable");
		this.name = "ServerToolReplayIssuanceLimitError";
	}
}

export class ServerToolReplayIssuanceDataIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ServerToolReplayIssuanceDataIntegrityError";
	}
}

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

function requireOpaqueText(
	value: string,
	field: string,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > maxLength ||
		value.trim() !== value ||
		hasControlCharacter(value)
	) {
		throw new TypeError(`${field} must be bounded opaque text`);
	}
	return value;
}

function requireEpochMs(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(
			`${field} must be a non-negative safe epoch-ms integer`,
		);
	}
	return value;
}

function parsePortableInteger(
	value: unknown,
	field: string,
	max: number,
): number {
	if (typeof value !== "string" || !PORTABLE_UNSIGNED_INTEGER.test(value)) {
		throw new ServerToolReplayIssuanceDataIntegrityError(
			`${field} is not canonical portable integer text`,
		);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
		throw new ServerToolReplayIssuanceDataIntegrityError(
			`${field} is outside its portable integer range`,
		);
	}
	return parsed;
}

function toReplayIssuance(row: ReplayIssuanceRow): ServerToolReplayIssuance {
	return {
		counterIdentity: row.counter_identity,
		issuanceCount: parsePortableInteger(
			row.issuance_count_text,
			"issuance_count",
			SERVER_TOOL_REPLAY_ISSUANCE_MAX,
		),
		firstIssuedAt: parsePortableInteger(
			row.first_issued_at_text,
			"first_issued_at",
			Number.MAX_SAFE_INTEGER,
		),
		lastIssuedAt: parsePortableInteger(
			row.last_issued_at_text,
			"last_issued_at",
			Number.MAX_SAFE_INTEGER,
		),
		firstWriterRevision: row.first_writer_revision,
		firstBuildSha: row.first_build_sha,
		firstDecoderRevision: row.first_decoder_revision,
		lastWriterRevision: row.last_writer_revision,
		lastBuildSha: row.last_build_sha,
		lastDecoderRevision: row.last_decoder_revision,
	};
}

export class ServerToolReplayIssuanceRepository extends BaseRepository<never> {
	async reserveReplayIssuance(
		input: ReserveReplayIssuanceInput,
	): Promise<ServerToolReplayIssuance> {
		const counterIdentity = requireOpaqueText(
			input.counterIdentity,
			"counterIdentity",
			512,
		);
		const writerRevision = requireOpaqueText(
			input.writerRevision,
			"writerRevision",
			256,
		);
		const buildSha = requireOpaqueText(input.buildSha, "buildSha", 256);
		const decoderRevision = requireOpaqueText(
			input.decoderRevision,
			"decoderRevision",
			256,
		);
		const now = requireEpochMs(input.now, "now");
		const row = await this.runReturningOne<ReplayIssuanceRow>(
			`INSERT INTO server_tool_replay_issuance (
				counter_identity, issuance_count, first_issued_at, last_issued_at,
				first_writer_revision, first_build_sha, first_decoder_revision,
				last_writer_revision, last_build_sha, last_decoder_revision
			) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (counter_identity) DO UPDATE SET
				issuance_count = server_tool_replay_issuance.issuance_count + 1,
				last_issued_at = CASE
					WHEN excluded.last_issued_at >= server_tool_replay_issuance.last_issued_at
					THEN excluded.last_issued_at
					ELSE server_tool_replay_issuance.last_issued_at
				END,
				last_writer_revision = CASE
					WHEN excluded.last_issued_at >= server_tool_replay_issuance.last_issued_at
					THEN excluded.last_writer_revision
					ELSE server_tool_replay_issuance.last_writer_revision
				END,
				last_build_sha = CASE
					WHEN excluded.last_issued_at >= server_tool_replay_issuance.last_issued_at
					THEN excluded.last_build_sha
					ELSE server_tool_replay_issuance.last_build_sha
				END,
				last_decoder_revision = CASE
					WHEN excluded.last_issued_at >= server_tool_replay_issuance.last_issued_at
					THEN excluded.last_decoder_revision
					ELSE server_tool_replay_issuance.last_decoder_revision
				END
			WHERE server_tool_replay_issuance.issuance_count < ${SERVER_TOOL_REPLAY_ISSUANCE_MAX}
			RETURNING ${REPLAY_ISSUANCE_COLUMNS}`,
			[
				counterIdentity,
				now,
				now,
				writerRevision,
				buildSha,
				decoderRevision,
				writerRevision,
				buildSha,
				decoderRevision,
			],
		);
		if (!row) throw new ServerToolReplayIssuanceLimitError();
		return toReplayIssuance(row);
	}

	async getReplayIssuance(
		counterIdentity: string,
	): Promise<ServerToolReplayIssuance | null> {
		requireOpaqueText(counterIdentity, "counterIdentity", 512);
		const row = await this.get<ReplayIssuanceRow>(
			`SELECT ${REPLAY_ISSUANCE_COLUMNS}
			 FROM server_tool_replay_issuance WHERE counter_identity = ?`,
			[counterIdentity],
		);
		return row ? toReplayIssuance(row) : null;
	}
}
