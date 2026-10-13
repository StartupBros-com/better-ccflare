import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogFileWriter } from "./file-writer";

let dir: string, saved: string | undefined, writer: LogFileWriter;
beforeEach(() => {
	saved = process.env.BETTER_CCFLARE_LOG_DIR;
	dir = mkdtempSync(join(tmpdir(), "log-tail-"));
	process.env.BETTER_CCFLARE_LOG_DIR = dir;
	writer = new LogFileWriter();
	writer.close();
});
afterEach(() => {
	mock.restore();
	writer.close();
	rmSync(dir, { recursive: true, force: true });
	if (saved === undefined) delete process.env.BETTER_CCFLARE_LOG_DIR;
	else process.env.BETTER_CCFLARE_LOG_DIR = saved;
});
const ev = (ts: number, msg = "message") =>
	JSON.stringify({ ts, level: "INFO", msg });
function seed(text: string) {
	writeFileSync(join(dir, "app.log"), text);
}
function previous(text: string, limit: number) {
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.slice(-limit)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((value) => value !== null);
}

describe("bounded log tail reading", () => {
	it("reads a tail slice, not the entire large file, for a small limit", async () => {
		seed(
			`${Array.from({ length: 4000 }, (_, i) => ev(i, "x".repeat(200))).join("\n")}\n`,
		);
		const file = Bun.file(join(dir, "app.log"));
		const whole = spyOn(file, "text");
		const slice = spyOn(file, "slice");
		spyOn(Bun, "file").mockReturnValue(file);
		expect((await writer.readLogs(3)).map((row) => row.ts)).toEqual([
			3997, 3998, 3999,
		]);
		expect(whole).not.toHaveBeenCalled();
		expect(slice).toHaveBeenCalled();
		expect(slice.mock.calls[0][0]).toBeGreaterThan(0);
	});
	it("preserves full-file slice semantics for unusual limits and whitespace/malformed entries", async () => {
		const text = ` \n${ev(1)}\n \nmalformed\n\n${ev(2)}\nnull\n${ev(3)}\n  `;
		seed(text);
		for (const limit of [0, -1, -2.7, 0.8, 1, 1.8, 2, 4, 1000, Infinity, NaN]) {
			expect(await writer.readLogs(limit)).toEqual(previous(text, limit));
		}
	});
	it("expands to retain oversized UTF-8 lines and does not require a trailing newline", async () => {
		const text = `${ev(1)}\n${ev(2, "😀".repeat(100000))}\n${ev(3, "終わり")}`;
		seed(text);
		expect(await writer.readLogs(2)).toEqual(previous(text, 2));
	});
	it("rereads the current file when truncation races the size snapshot", async () => {
		seed(`${ev(0, "x".repeat(400000))}\n${ev(1)}\n`);
		const file = Bun.file(join(dir, "app.log"));
		const slice = file.slice.bind(file);
		spyOn(file, "slice").mockImplementationOnce((start, end, type) => {
			seed(`${ev(2)}\n${ev(3)}\n`);
			return slice(start, end, type);
		});
		spyOn(Bun, "file").mockReturnValue(file);
		expect((await writer.readLogs(2)).map((row) => row.ts)).toEqual([2, 3]);
	});
	it("counts interior whitespace lines before parsing rather than backfilling older events", async () => {
		const text = `${ev(0, "x".repeat(400000))}\n${ev(1)}\n \n${ev(2)}\n`;
		seed(text);
		expect(await writer.readLogs(2)).toEqual(previous(text, 2));
	});
});
