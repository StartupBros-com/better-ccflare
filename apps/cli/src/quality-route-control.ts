import { randomUUID } from "node:crypto";

export interface QualityRouteCommand {
	action: "status" | "retry-preferred";
	sessionId: string;
	origin: string;
	credentialEnv: string;
}
const flags = {
	"--quality-routing-status": "status",
	"--quality-routing-retry-preferred": "retry-preferred",
} as const;
const usage =
	"Use --quality-routing-status <session> or --quality-routing-retry-preferred <session> with --origin <loopback-origin> --credential-env <ENV_NAME>.";
function validateOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error("Invalid loopback origin.");
	}
	// Compare the original spelling too: URL normalizes 127.1, hex IPv4, userinfo,
	// dot paths and backslashes. None is authority to send a credential.
	if (
		!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?\/?$/.test(
			origin,
		) ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(
			"Explicit loopback origin required; URL credentials, paths and redirects are forbidden.",
		);
	return url.origin;
}
export function parseQualityRouteCommand(
	args: string[],
): QualityRouteCommand | null {
	if (!args.some((arg) => arg.startsWith("--quality-routing"))) return null;
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		const value = args[i + 1];
		if (key === undefined) throw new Error(usage);
		if (!(key in flags) && key !== "--origin" && key !== "--credential-env")
			throw new Error(usage);
		if (!value || value.startsWith("--") || values.has(key))
			throw new Error(usage);
		values.set(key, value);
	}
	const actionFlags = Object.keys(flags).filter((key) => values.has(key));
	if (actionFlags.length !== 1 || values.size !== 3) throw new Error(usage);
	const actionFlag = actionFlags[0];
	if (
		actionFlag !== "--quality-routing-status" &&
		actionFlag !== "--quality-routing-retry-preferred"
	)
		throw new Error(usage);
	const sessionId = values.get(actionFlag);
	const credentialEnv = values.get("--credential-env");
	const origin = values.get("--origin");
	if (!credentialEnv || !origin) throw new Error(usage);
	if (
		!sessionId ||
		sessionId.length > 256 ||
		[...sessionId].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x20 || code === 0x7f || "/%\\?#".includes(character);
		}) ||
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)
	)
		throw new Error(usage);
	return {
		action: flags[actionFlag],
		sessionId,
		origin: validateOrigin(origin),
		credentialEnv,
	};
}
interface Dependencies {
	getEnv?: (name: string) => string | undefined;
	fetch?: (request: Request) => Promise<Response>;
}
export async function runQualityRouteCommand(
	command: QualityRouteCommand,
	dependencies: Dependencies = {},
): Promise<{ exitCode: 0 | 1; data: unknown }> {
	// Revalidate for programmatic callers before reading the one named variable.
	const parsed = parseQualityRouteCommand([
		command.action === "status"
			? "--quality-routing-status"
			: "--quality-routing-retry-preferred",
		command.sessionId,
		"--origin",
		command.origin,
		"--credential-env",
		command.credentialEnv,
	]);
	if (!parsed) throw new Error(usage);
	// Bun 1.3 can proxy even loopback requests and does not honor newer
	// proxy:false semantics. Fail closed before reading a credential, rather
	// than mutating process env or trusting NO_PROXY/redirect flags as authority.
	// These are six known transport settings, not a credential-store scan.
	if (
		!dependencies.fetch &&
		(process.env.HTTP_PROXY ||
			process.env.http_proxy ||
			process.env.HTTPS_PROXY ||
			process.env.https_proxy ||
			process.env.ALL_PROXY ||
			process.env.all_proxy)
	)
		return { exitCode: 1, data: { status: "proxy-environment-denied" } };
	const credential = (dependencies.getEnv ?? ((name) => process.env[name]))(
		parsed.credentialEnv,
	);
	if (!credential || /[\r\n]/.test(credential))
		return { exitCode: 1, data: { status: "missing-credential" } };
	const send = dependencies.fetch ?? ((request: Request) => fetch(request));
	const url = `${parsed.origin}/v1/quality-routing/sessions/${encodeURIComponent(parsed.sessionId)}`;
	const headers = {
		authorization: `Bearer ${credential}`,
		"content-type": "application/json",
	};
	async function request(target: string, body?: string) {
		return send(
			new Request(target, {
				method: body === undefined ? "GET" : "POST",
				headers,
				body,
				redirect: "error",
				signal: AbortSignal.timeout(10000),
			}),
		);
	}
	async function failure(
		response: Response,
	): Promise<{ exitCode: 1; data: unknown }> {
		let status =
			response.status === 401 || response.status === 403
				? "denied"
				: response.status === 404
					? "unknown"
					: response.status === 409
						? "conflict"
						: response.status === 429
							? "capacity"
							: "control-failed";
		try {
			const body = (await response.json()) as { status?: unknown };
			const allowed =
				response.status === 404
					? ["disabled", "unknown"]
					: response.status === 409
						? ["stale", "conflict", "unresolved"]
						: [];
			if (typeof body.status === "string" && allowed.includes(body.status))
				status = body.status;
		} catch {
			/* Arbitrary server error text is deliberately discarded. */
		}
		return { exitCode: 1, data: { status, httpStatus: response.status } };
	}
	function safe(data: unknown) {
		return JSON.parse(
			JSON.stringify(data).replaceAll(
				JSON.stringify(credential).slice(1, -1),
				"[redacted]",
			),
		);
	}
	try {
		const statusResponse = await request(url);
		if (!statusResponse.ok || statusResponse.redirected)
			return failure(statusResponse);
		const state = (await statusResponse.json()) as Record<string, unknown>;
		if (
			state.status !== "known" ||
			typeof state.incarnation !== "string" ||
			typeof state.intentRevision !== "number" ||
			!Number.isSafeInteger(state.intentRevision)
		)
			return { exitCode: 1, data: { status: "invalid-response" } };
		if (parsed.action === "status") return { exitCode: 0, data: safe(state) };
		// One operation per invocation. A single transport redelivery uses identical
		// bytes/token, even if the first request committed but its response was lost.
		const body = JSON.stringify({
			incarnation: state.incarnation,
			expectedIntentRevision: state.intentRevision,
			idempotencyToken: randomUUID(),
		});
		let response: Response;
		try {
			response = await request(`${url}/retry-preferred`, body);
		} catch {
			response = await request(`${url}/retry-preferred`, body);
		}
		if (!response.ok || response.redirected) return failure(response);
		const outcome = (await response.json()) as Record<string, unknown>;
		if (outcome.status !== "ready")
			return { exitCode: 1, data: { status: "invalid-response" } };
		return { exitCode: 0, data: safe(outcome) };
	} catch {
		// Never surface fetch/URL/server messages: they can contain credentials.
		return { exitCode: 1, data: { status: "transport-failed" } };
	}
}
