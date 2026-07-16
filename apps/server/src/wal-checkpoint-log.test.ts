import { describe, expect, it } from "bun:test";
import { formatWalCheckpointLog, WAL_SIZE_WARN_MIB } from "./server";

describe("formatWalCheckpointLog", () => {
	it("logs at debug when the WAL stays small after a successful run", () => {
		const { level, message } = formatWalCheckpointLog(
			{ ok: true, skipped: false },
			10 * 1024 * 1024, // 10 MiB
		);
		expect(level).toBe("debug");
		expect(message).toContain("ran");
		expect(message).toContain("10.0MiB");
	});

	it("logs at debug when a tick is skipped for lock contention and the WAL is small", () => {
		const { level, message } = formatWalCheckpointLog(
			{ ok: true, skipped: true },
			1024 * 1024, // 1 MiB
		);
		expect(level).toBe("debug");
		expect(message).toContain("skipped (DB busy)");
	});

	it("escalates to warn when the WAL exceeds the threshold, even on a successful run", () => {
		const walBytes = (WAL_SIZE_WARN_MIB + 1) * 1024 * 1024;
		const { level, message } = formatWalCheckpointLog(
			{ ok: true, skipped: false },
			walBytes,
		);
		expect(level).toBe("warn");
		expect(message).toContain("exceeds");
		expect(message).toContain("long-lived reader");
	});

	it("respects a custom warn threshold override", () => {
		const belowDefaultButAboveCustom = formatWalCheckpointLog(
			{ ok: true, skipped: false },
			5 * 1024 * 1024, // 5 MiB, well under the 256 MiB default
			1, // 1 MiB custom threshold
		);
		expect(belowDefaultButAboveCustom.level).toBe("warn");
	});

	it("logs at warn (not error, and does not throw) when the worker itself failed", () => {
		const { level, message } = formatWalCheckpointLog(
			{ ok: false, skipped: false, error: "database is locked" },
			0,
		);
		expect(level).toBe("warn");
		expect(message).toContain("database is locked");
	});

	it("does not divide by zero or produce NaN when walBytes is 0", () => {
		const { message } = formatWalCheckpointLog({ ok: true, skipped: false }, 0);
		expect(message).not.toContain("NaN");
		expect(message).toContain("0.0MiB");
	});

	it("surfaces the optimize/checkpoint duration when the worker reports one", () => {
		// analysis_limit bounds PRAGMA optimize's ANALYZE to milliseconds; a
		// regression back to an unbounded scan shows up here as durationMs
		// climbing into the hundreds/thousands, so it must be visible in the log.
		const { message } = formatWalCheckpointLog(
			{ ok: true, skipped: false, durationMs: 42 },
			1024 * 1024,
		);
		expect(message).toContain("in 42ms");
	});

	it("omits the duration segment when the worker didn't report one", () => {
		const { message } = formatWalCheckpointLog(
			{ ok: true, skipped: false },
			1024 * 1024,
		);
		expect(message).not.toContain(" in ");
		expect(message).not.toContain("undefinedms");
	});
});
