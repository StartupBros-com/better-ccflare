import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	githubTransport,
	ROUTER_REPOSITORY,
	validateDraft,
} from "./router-release";

export const ASSET_NAMES = [
	"SHA256SUMS",
	"better-ccflare-linux-amd64",
	"release-manifest.json",
].sort();
const ATTESTED = ["better-ccflare-linux-amd64", "release-manifest.json"];
const FOUNDATION = {
	name: "Managed Routing Foundation Gate",
	path: ".github/workflows/managed-routing-postgres.yml",
};
const SHA = /^[a-f0-9]{40}$/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface EventContext {
	repository: string;
	eventName: string;
	ref: string;
	sha: string;
	event: {
		workflow_run?: {
			name?: string;
			path?: string;
			event?: string;
			status?: string;
			conclusion?: string;
			head_branch?: string;
			head_sha?: string;
			repository?: { full_name?: string };
			head_repository?: { full_name?: string };
		};
		inputs?: { source_sha?: string; version?: string };
	};
}
export interface ArtifactIdentity {
	repository: string;
	sha: string;
	version: string;
	ref: string;
	releaseId: number;
}

/** Coordinator trigger gate: only exact-repo foundation push success on main, or an explicit bounded retry. */
export function assertCoordinatorEvent(ctx: EventContext) {
	if (ctx.repository !== ROUTER_REPOSITORY)
		throw new Error("Wrong repository for Router release");
	if (ctx.ref !== "refs/heads/main")
		throw new Error("Router release coordinator runs only from main");
	if (ctx.eventName === "workflow_run") {
		const run = ctx.event?.workflow_run;
		if (
			run?.name !== FOUNDATION.name ||
			run.path !== FOUNDATION.path ||
			run.event !== "push" ||
			run.status !== "completed" ||
			run.conclusion !== "success" ||
			run.head_branch !== "main" ||
			run.repository?.full_name !== ROUTER_REPOSITORY ||
			run.head_repository?.full_name !== ROUTER_REPOSITORY ||
			!SHA.test(run.head_sha ?? "")
		)
			throw new Error("Foundation run is not exact-repo successful main push");
		return { sha: run.head_sha as string };
	}
	if (ctx.eventName === "workflow_dispatch") {
		const inputs = ctx.event?.inputs ?? {};
		if (
			!SHA.test(inputs.source_sha ?? "") ||
			!STABLE.test(inputs.version ?? "")
		)
			throw new Error("Draft retry requires source_sha and stable version");
		return {
			sha: inputs.source_sha as string,
			version: inputs.version as string,
		};
	}
	throw new Error(`Unsupported coordinator event ${ctx.eventName}`);
}

/** Tag-run gate: GitHub's actual run SHA/ref must be the release identity. */
export function assertArtifactEvent(
	ctx: EventContext,
	identity: ArtifactIdentity,
) {
	if (
		ctx.repository !== ROUTER_REPOSITORY ||
		identity.repository !== ROUTER_REPOSITORY ||
		ctx.eventName !== "workflow_dispatch" ||
		!SHA.test(identity.sha) ||
		!STABLE.test(identity.version) ||
		identity.ref !== `refs/tags/v${identity.version}` ||
		!Number.isSafeInteger(identity.releaseId) ||
		ctx.sha !== identity.sha ||
		ctx.ref !== identity.ref
	)
		throw new Error("Artifact run identity does not match release tag/source");
}

export function attestationArguments(
	subject: string,
	identity: ArtifactIdentity,
) {
	return [
		"attestation",
		"verify",
		subject,
		"--repo",
		identity.repository,
		"--source-digest",
		identity.sha,
		"--source-ref",
		identity.ref,
		"--cert-identity",
		`https://github.com/${identity.repository}/.github/workflows/router-release-artifacts.yml@${identity.ref}`,
		"--signer-digest",
		identity.sha,
		"--deny-self-hosted-runners",
	];
}

export interface RemoteAsset {
	id: number;
	name: string;
}
export interface AssetTransport {
	/** Re-read release id/tag/source/draft state; throws on any mismatch. */
	validate(): Promise<void>;
	list(): Promise<RemoteAsset[]>;
	download(asset: RemoteAsset): Promise<Uint8Array>;
	upload(name: string, bytes: Uint8Array): Promise<void>;
	authenticate(name: string, bytes: Uint8Array): Promise<void>;
	smoke(files: Map<string, Uint8Array>): Promise<void>;
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

/** Upload only missing trusted bytes, then verify fresh downloads before any execution. */
export async function reconcileAssets(
	transport: AssetTransport,
	local: Map<string, Uint8Array>,
) {
	if (!isDeepStrictEqual([...local.keys()].sort(), ASSET_NAMES))
		throw new Error("Trusted build outputs are not the exact three assets");
	await transport.validate();
	const check = async (assets: RemoteAsset[]) => {
		for (const asset of assets) {
			const expected = local.get(asset.name);
			if (!expected) throw new Error(`Unexpected release asset ${asset.name}`);
			if (!same(await transport.download(asset), expected))
				throw new Error(`Existing asset differs from build: ${asset.name}`);
		}
	};
	const existing = await transport.list();
	if (new Set(existing.map((a) => a.name)).size !== existing.length)
		throw new Error("Duplicate release asset names");
	await check(existing);
	const present = new Set(existing.map((a) => a.name));
	for (const name of ASSET_NAMES)
		if (!present.has(name)) {
			await transport.validate();
			await transport.upload(name, local.get(name) as Uint8Array);
		}
	await transport.validate();
	const final = await transport.list();
	if (!isDeepStrictEqual(final.map((a) => a.name).sort(), ASSET_NAMES))
		throw new Error("Remote inventory is not exactly the expected assets");
	const fresh = new Map<string, Uint8Array>();
	for (const asset of final) {
		const bytes = await transport.download(asset);
		if (!same(bytes, local.get(asset.name) as Uint8Array))
			throw new Error(`Downloaded asset differs from build: ${asset.name}`);
		fresh.set(asset.name, bytes);
	}
	for (const name of ATTESTED)
		await transport.authenticate(name, fresh.get(name) as Uint8Array);
	await transport.smoke(fresh);
	await transport.validate();
	return ASSET_NAMES;
}

const api = (path: string) =>
	`https://api.github.com/repos/${ROUTER_REPOSITORY}/${path}`;
async function ghFetch(token: string, url: string, init: RequestInit = {}) {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.headers as Record<string, string> | undefined),
		},
	});
	if (!response.ok)
		throw new Error(
			`GitHub ${init.method ?? "GET"} failed: HTTP ${response.status}`,
		);
	return response;
}

async function githubAssets(
	token: string,
	identity: ArtifactIdentity,
	root: string,
): Promise<AssetTransport & { url(): Promise<string> }> {
	const release = await githubTransport(token);
	const cleanEnv = (home: string) => ({
		PATH: process.env.PATH ?? "",
		HOME: home,
	});
	return {
		validate: async () => {
			const result = await validateDraft(release, identity);
			if (result.releaseId !== identity.releaseId)
				throw new Error("Release id does not match dispatched identity");
		},
		list: async () => {
			const assets: RemoteAsset[] = [];
			for (let page = 1; ; page++) {
				const rows = (await (
					await ghFetch(
						token,
						api(
							`releases/${identity.releaseId}/assets?per_page=100&page=${page}`,
						),
					)
				).json()) as { id: number; name: string; state: string }[];
				for (const row of rows) {
					if (row.state !== "uploaded")
						throw new Error(`Asset not uploaded: ${row.name}`);
					assets.push({ id: row.id, name: row.name });
				}
				if (rows.length < 100) return assets;
			}
		},
		download: async (asset) =>
			new Uint8Array(
				await (
					await ghFetch(token, api(`releases/assets/${asset.id}`), {
						headers: { Accept: "application/octet-stream" },
					})
				).arrayBuffer(),
			),
		upload: async (name, bytes) => {
			await ghFetch(
				token,
				`https://uploads.github.com/repos/${ROUTER_REPOSITORY}/releases/${identity.releaseId}/assets?name=${encodeURIComponent(name)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: new Blob([bytes as BlobPart]),
				},
			);
		},
		authenticate: async (name, bytes) => {
			const directory = mkdtempSync(join(root, "attest-"));
			writeFileSync(join(directory, name), bytes);
			execFileSync(
				"gh",
				attestationArguments(join(directory, name), identity),
				{
					env: { ...cleanEnv(directory), GH_TOKEN: token },
					stdio: ["ignore", 2, 2],
				},
			);
		},
		smoke: async (files) => {
			const directory = mkdtempSync(join(root, "download-"));
			for (const [name, bytes] of files)
				writeFileSync(join(directory, name), bytes);
			// No token in the executable verification environment.
			execFileSync(
				"bun",
				[
					"--no-env-file",
					"run",
					"apps/cli/prepare-router-release.ts",
					"verify",
					directory,
					identity.repository,
					identity.version,
					identity.ref,
					identity.sha,
				],
				{ env: cleanEnv(directory), stdio: ["ignore", 2, 2] },
			);
		},
		url: async () =>
			(
				(await (
					await ghFetch(token, api(`releases/${identity.releaseId}`))
				).json()) as {
					html_url: string;
				}
			).html_url,
	};
}

function eventContext(): EventContext {
	return {
		repository: process.env.GITHUB_REPOSITORY ?? "",
		eventName: process.env.GITHUB_EVENT_NAME ?? "",
		ref: process.env.GITHUB_REF ?? "",
		sha: process.env.GITHUB_SHA ?? "",
		event: JSON.parse(
			readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
		),
	};
}
function identityFromEnvironment(): ArtifactIdentity {
	return {
		repository: process.env.ROUTER_REPOSITORY ?? "",
		sha: process.env.ROUTER_SHA ?? "",
		version: process.env.ROUTER_VERSION ?? "",
		ref: process.env.ROUTER_REF ?? "",
		releaseId: Number(process.env.ROUTER_RELEASE_ID),
	};
}

if (import.meta.main) {
	const [command, directory] = process.argv.slice(2);
	if (command === "coordinator-event")
		console.log(JSON.stringify(assertCoordinatorEvent(eventContext())));
	else if (command === "artifact-event")
		assertArtifactEvent(eventContext(), identityFromEnvironment());
	else if (command === "stage" && directory) {
		const identity = identityFromEnvironment();
		assertArtifactEvent(eventContext(), identity);
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN required");
		const source = resolve(directory);
		const files = new Map(
			readdirSync(source).map(
				(name) =>
					[name, new Uint8Array(readFileSync(join(source, name)))] as const,
			),
		);
		const root = mkdtempSync(join(tmpdir(), "router-stage-"));
		mkdirSync(root, { recursive: true });
		try {
			const transport = await githubAssets(token, identity, root);
			await reconcileAssets(transport, files);
			console.log(
				JSON.stringify({
					draftUrl: await transport.url(),
					...identity,
					verified: true,
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	} else
		throw new Error(
			"Usage: router-release-assets.ts coordinator-event|artifact-event|stage DIRECTORY",
		);
}
