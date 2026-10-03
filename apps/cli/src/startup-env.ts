import { dirname, join, resolve } from "node:path";
import { config } from "dotenv";

let attempted = false;

/** The compiled entrypoint supplies execPath; source startup supplies argv[1]. */
export function loadCliDotenv(entrypoint: string | undefined): void {
	if (
		attempted ||
		process.argv.slice(2).some((arg) => arg.startsWith("--quality-routing"))
	)
		return;
	attempted = true;

	// Preserve legacy ordering and dotenv's non-overriding process-env semantics.
	const paths = [".env", "../../.env"];
	if (entrypoint) paths.push(join(dirname(resolve(entrypoint)), ".env"));
	for (const path of paths) {
		const result = config({ path, quiet: true });
		if (result.parsed && Object.keys(result.parsed).length > 0) break;
	}
}
