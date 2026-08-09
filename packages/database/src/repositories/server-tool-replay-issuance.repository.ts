import { BaseRepository } from "./base.repository";

export const SERVER_TOOL_REPLAY_ISSUANCE_MAX = 2 ** 31;

/**
 * A small upper bound keeps crash-burn waste negligible while removing one
 * durable write from every replay envelope. The runtime currently reserves the
 * full 256-slot block; smaller requests remain available for boundary tests and
 * future staged rollouts.
 */
export const SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX = 256;

const PORTABLE_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface ServerToolReplayIssuance {
	counterIdentity: string;
	issuanceCount: number;
}

export interface ServerToolReplayIssuanceRange {
	counterIdentity: string;
	firstIssuanceCount: number;
	lastIssuanceCount: number;
}

export interface ReserveReplayIssuanceRangeInput {
	counterIdentity: string;
	reservationSize: number;
}

interface ReplayIssuanceRow {
	counter_identity: string;
	issuance_count_text: string;
}

const REPLAY_ISSUANCE_COLUMNS = `
	counter_identity,
	CAST(issuance_count AS TEXT) AS issuance_count_text`;

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

function requireReservationSize(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX
	) {
		throw new TypeError(
			`reservationSize must be an integer between 1 and ${SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX}`,
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
	};
}

export class ServerToolReplayIssuanceRepository extends BaseRepository<never> {
	async reserveReplayIssuanceRange(
		input: ReserveReplayIssuanceRangeInput,
	): Promise<ServerToolReplayIssuanceRange> {
		const counterIdentity = requireOpaqueText(
			input.counterIdentity,
			"counterIdentity",
			512,
		);
		const reservationSize = requireReservationSize(input.reservationSize);
		const row = await this.runReturningOne<ReplayIssuanceRow>(
			`INSERT INTO server_tool_replay_issuance (
				counter_identity, issuance_count
			) VALUES (?, ?)
			ON CONFLICT (counter_identity) DO UPDATE SET
				issuance_count = server_tool_replay_issuance.issuance_count + excluded.issuance_count
			WHERE server_tool_replay_issuance.issuance_count
				<= ${SERVER_TOOL_REPLAY_ISSUANCE_MAX} - excluded.issuance_count
			RETURNING ${REPLAY_ISSUANCE_COLUMNS}`,
			[counterIdentity, reservationSize],
		);
		if (!row) throw new ServerToolReplayIssuanceLimitError();

		const replayIssuance = toReplayIssuance(row);
		const firstIssuanceCount =
			replayIssuance.issuanceCount - reservationSize + 1;
		if (
			replayIssuance.counterIdentity !== counterIdentity ||
			!Number.isSafeInteger(firstIssuanceCount) ||
			firstIssuanceCount < 1
		) {
			throw new ServerToolReplayIssuanceDataIntegrityError(
				"reserved issuance range is invalid",
			);
		}
		return {
			counterIdentity: replayIssuance.counterIdentity,
			firstIssuanceCount,
			lastIssuanceCount: replayIssuance.issuanceCount,
		};
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
