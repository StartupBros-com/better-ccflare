// Bun test preload (see bunfig.toml). Production runs on the same host and
// user as developers and shares os.tmpdir() paths (pricing cache, model
// catalog cache, app.log), so tests must never write there. Give each test
// process its own tmpdir, which covers every tmpdir() consumer in-process. The
// two log/cache overrides are pinned too, so a shell that exports them cannot
// redirect tests at real locations. Subprocesses see these only when spawned
// with `env: process.env`: Bun (1.3) hands a child the startup environment by
// default, not later process.env changes.
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
