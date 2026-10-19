import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";

export interface CodexUsageFile {
	path: string;
	home: string;
	sourceDir: string;
}
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
export interface CodexDiscoveryOptions {
	onUnreadable?: (dir: string, error: unknown) => void;
}
async function collect(
	dir: string,
	options: CodexDiscoveryOptions,
): Promise<string[]> {
	const files: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
		options.onUnreadable?.(dir, error);
		return files;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collect(path, options)));
		else if (
			entry.isFile() &&
			/\.jsonl(?:\.zst)?$/.test(basename(path)) &&
			!/^(?:auth|credentials{0,1}|secrets{0,1})(?:[.\-_]|$)/i.test(
				basename(path),
			)
		)
			files.push(path);
	}
	return files.sort();
}
/** Mirrors ccusage v20.0.19 paths.rs, with the additional compressed-twin rule. */
export async function discoverCodexFiles(
	homes: readonly string[],
	options: CodexDiscoveryOptions = {},
): Promise<CodexUsageFile[]> {
	const out: CodexUsageFile[] = [];
	const seen = new Set<string>();
	for (const home of new Set(homes.map((path) => resolve(path)))) {
		const sessions = join(home, "sessions");
		const archived = join(home, "archived_sessions");
		const roots = [];
		if (await exists(sessions)) roots.push(sessions);
		if (await exists(archived)) roots.push(archived);
		if (!roots.length) roots.push(home);
		const groups = await Promise.all(
			roots.map(async (sourceDir) => ({
				sourceDir,
				files: await collect(sourceDir, options),
			})),
		);

		for (const group of groups)
			for (const path of group.files) {
				const rel = relative(group.sourceDir, path);
				const logical = rel.replace(/\.zst$/, "");
				if (path.endsWith(".zst") && group.files.includes(path.slice(0, -4)))
					continue;
				const key = `${home}\0${logical}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ path, sourceDir: group.sourceDir, home });
			}
	}
	return out;
}
/** Only opens selected rollout files. Message bodies are never retained. */
export async function* streamCodexLines(path: string): AsyncGenerator<string> {
	const file = createReadStream(path);
	const input = path.endsWith(".zst")
		? file.pipe(createZstdDecompress())
		: file;
	// Forward file failures to the transform so iteration rejects rather than hanging.
	if (input !== file) file.on("error", (error) => input.destroy(error));
	input.setEncoding("utf8");
	let pending = "";
	let count = 0;
	try {
		for await (const chunk of input) {
			pending += String(chunk);
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				yield line.endsWith("\r") ? line.slice(0, -1) : line;
				if (++count % 256 === 0)
					await new Promise<void>((resolve) => setImmediate(resolve));
				newline = pending.indexOf("\n");
			}
		}
		if (pending) yield pending;
	} finally {
		input.destroy();
		file.destroy();
	}
}
