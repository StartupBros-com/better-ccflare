// Bun test preload (see bunfig.toml). Production runs on the same host and
// user as developers and shares os.tmpdir() paths (pricing cache, model
// catalog cache, app.log), so tests must never write there. Give each test
// process its own tmpdir: every tmpdir() consumer and spawned subprocess is
// covered at once. The two log/cache overrides are pinned too, so a shell that
// exports them cannot redirect tests at real locations.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ccflare-test-"));
process.env.TMPDIR = dir;
process.env.BETTER_CCFLARE_LOG_DIR = join(dir, "logs");
process.env.BETTER_CCFLARE_MODELS_CACHE_DIR = join(dir, "models-cache");

function cleanup(): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

// bun test can exit without emitting "exit", so also clean up after the file.
process.on("exit", cleanup);
afterAll(cleanup);
