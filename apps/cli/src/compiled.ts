import { loadCliDotenv } from "./startup-env";

// This entrypoint MUST be compiled with --no-compile-autoload-dotenv. Controls
// must reach application code with only the environment supplied by the caller.
// Ordinary commands retain Bun's native dotenv semantics before app imports.
if (!process.argv.slice(2).some((arg) => arg.startsWith("--quality-routing"))) {
	// A compiled executable also contains the Bun CLI. Use that exact runtime's
	// loader rather than approximating its NODE_ENV/local precedence or expansion.
	// This child only loads ordinary-mode configuration; it never runs the app.
	const loaded = Bun.spawnSync(
		[
			process.execPath,
			"--eval",
			"process.stdout.write(JSON.stringify(process.env))",
		],
		{
			env: { ...process.env, BUN_BE_BUN: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (loaded.exitCode !== 0) {
		// Configuration can contain credentials; never relay the child's output.
		throw new Error("Unable to load ordinary CLI environment");
	}
	const environment: Record<string, string> = JSON.parse(
		new TextDecoder().decode(loaded.stdout),
	);
	for (const [name, value] of Object.entries(environment)) {
		if (name !== "BUN_BE_BUN" && process.env[name] === undefined) {
			process.env[name] = value;
		}
	}
}

// argv[1] names Bun's virtual bundled entrypoint, not the deployed executable.
// Load fallbacks once, using the physical path, before app modules snapshot env.
loadCliDotenv(process.execPath);

// The dynamic import is important: app modules may snapshot env at import time.
const { startCli } = await import("./main");
startCli();
