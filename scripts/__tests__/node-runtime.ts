import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** Resolve an actual Node runtime, never Bun's Node-compatible process facade. */
export function resolveNodeExecutable(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const candidate = env.GUARD_NODE_BIN || "node";
	const result = spawnSync(
		candidate,
		[
			"--eval",
			"if (process.versions.bun || process.release.name !== 'node') process.exit(1); process.stdout.write(process.execPath);",
		],
		{
			env,
			encoding: "utf8",
			windowsHide: true,
			timeout: 5_000,
		},
	);
	const executable = result.stdout?.trim();
	if (
		result.error ||
		result.status !== 0 ||
		!executable ||
		!isAbsolute(executable)
	) {
		throw new Error(
			"Native guard fixtures require Node on PATH or an explicit GUARD_NODE_BIN pointing to Node",
		);
	}
	return executable;
}
