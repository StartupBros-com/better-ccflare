import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	Logger,
	LogLevel,
	logBus,
	logFileWriter,
	setConsoleLogging,
} from "./index";

let savedLevel: string | undefined;
beforeEach(() => {
	savedLevel = process.env.LOG_LEVEL;
	delete process.env.LOG_LEVEL;
	setConsoleLogging(false);
});
afterEach(() => {
	mock.restore();
	setConsoleLogging(null);
	if (savedLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = savedLevel;
});

describe("logger sink laziness", () => {
	it("skips console formatting and event emission without those sinks, but still writes every level", () => {
		if (!logFileWriter) throw new Error("file writer unavailable");
		const writer = spyOn(logFileWriter, "write").mockImplementation(() => {});
		const emit = spyOn(logBus, "emit");
		expect(logBus.listenerCount("log")).toBe(0);
		const logger = new Logger("sinks", LogLevel.DEBUG);
		const format = spyOn(
			logger as unknown as {
				formatMessage(level: string, message: string, data?: unknown): string;
			},
			"formatMessage",
		);
		for (const method of ["debug", "info", "warn", "error"] as const)
			logger[method]("message", { a: 1 });
		expect(writer).toHaveBeenCalledTimes(4);
		expect(format).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});
	it("retains error normalization for file and event consumers when console is silent", () => {
		if (!logFileWriter) throw new Error("file writer unavailable");
		const writer = spyOn(logFileWriter, "write").mockImplementation(() => {});
		const listener = mock(() => {});
		logBus.on("log", listener);
		try {
			new Logger("sinks").error(
				"failed",
				new Error("outer", { cause: new Error("inner") }),
			);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(writer).toHaveBeenCalledWith(
				expect.objectContaining({
					level: "ERROR",
					msg: "failed",
					data: expect.objectContaining({
						message: "outer",
						cause: expect.objectContaining({ message: "inner" }),
					}),
				}),
			);
		} finally {
			logBus.off("log", listener);
		}
	});
	it("keeps the headless console override for WARN/ERROR without debug mode", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const error = spyOn(console, "error").mockImplementation(() => {});
		setConsoleLogging(true);
		const logger = new Logger("headless", LogLevel.WARN);
		logger.warn("warning", { a: 1 });
		logger.error("failure");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('WARN: [headless] warning {"a":1}'),
		);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("ERROR: [headless] failure"),
		);
	});
});
