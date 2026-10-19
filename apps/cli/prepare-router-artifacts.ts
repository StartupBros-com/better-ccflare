#!/usr/bin/env bun
import { prepareArtifacts } from "./router-artifacts";

try {
	const args = process.argv.slice(2);
	if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
		throw new Error(
			"Usage: bun run apps/cli/prepare-router-artifacts.ts <new-output-directory>",
		);
	}
	prepareArtifacts(args[0]);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Preparation failed");
	process.exitCode = 1;
}
