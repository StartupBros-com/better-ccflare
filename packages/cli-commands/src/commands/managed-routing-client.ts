import type {
	AccountResponse,
	AccountRoutingOverview,
	ComboFamily,
	ComboFamilyAssignment,
	ComboRoutingPreviewResult,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";

export const DEFAULT_MANAGED_ROUTING_API_URL = "http://127.0.0.1:8788";

export interface ManagedRoutingClientEnvironment {
	BETTER_CCFLARE_API_URL?: string;
	BETTER_CCFLARE_ADMIN_API_KEY?: string;
}

export interface ManagedRoutingClientOptions {
	/** Explicit injection point for the CLI's --api-url flag. */
	baseUrl?: string;
	env?: ManagedRoutingClientEnvironment;
	fetch?: typeof globalThis.fetch;
}

export interface PreviewFamilyRoutingInput {
	family: ComboFamily;
	managedModel?: string;
}

export interface PreviewAccountRoutingInput {
	accountId: string;
	family?: ComboFamily;
	managedModel?: string;
}

export interface AccountRoutingPreviewCollection {
	families: ComboRoutingPreviewResult[];
}

export interface ApplyFamilyRoutingProposalInput {
	family: ComboFamily;
	previewId: string;
	proposalId: string;
	managedModel: string;
}

export interface ApplyAccountRoutingProposalInput
	extends ApplyFamilyRoutingProposalInput {
	accountId: string;
}

/**
 * Thin live control-plane boundary used by the CLI. It deliberately exposes no
 * local resolver, database, or provider-capability dependency.
 */
export interface ManagedRoutingControlPlane {
	getAccounts(): Promise<AccountResponse[]>;
	getAccountRoutingOverview(): Promise<AccountRoutingOverview>;
	listEffectiveRouting(): Promise<EffectiveComboRoutingView[]>;
	getEffectiveRouting(family: ComboFamily): Promise<EffectiveComboRoutingView>;
	previewAccountRouting(
		input: PreviewAccountRoutingInput,
	): Promise<ComboRoutingPreviewResult | AccountRoutingPreviewCollection>;
	previewFamilyRouting(
		input: PreviewFamilyRoutingInput,
	): Promise<ComboRoutingPreviewResult>;
	applyAccountRoutingProposal(
		input: ApplyAccountRoutingProposalInput,
	): Promise<EffectiveComboRoutingView>;
	applyFamilyRoutingProposal(
		input: ApplyFamilyRoutingProposalInput,
	): Promise<EffectiveComboRoutingView>;
	rollbackFamilyToManual(family: ComboFamily): Promise<ComboFamilyAssignment>;
}

export interface ManagedRoutingHttpErrorOptions {
	status?: number | null;
	code?: string | null;
	message?: string;
}

export class ManagedRoutingHttpError extends Error {
	readonly status: number | null;
	readonly code: string | null;

	constructor(options: ManagedRoutingHttpErrorOptions = {}) {
		const status = options.status ?? null;
		const code = options.code ?? null;
		super(options.message ?? safeHttpErrorMessage(status, code));
		this.name = "ManagedRoutingHttpError";
		this.status = status;
		this.code = code;
	}
}

interface ApiEnvelope<T> {
	success: true;
	data: T;
}

const SAFE_SERVER_ERROR_CODES = new Set([
	"managed_route_empty",
	"stale_routing_preview",
]);

function safeHttpErrorMessage(
	status: number | null,
	code: string | null,
): string {
	switch (code) {
		case "managed_route_empty":
			return "The server rejected managed mode because the reviewed route has no effective candidates.";
		case "stale_routing_preview":
			return "The reviewed routing preview is stale. Create and review a new preview before applying it.";
		case "redirect_rejected":
			return "The credentialed managed-routing request was redirected and has been rejected.";
		case "invalid_response":
			return "The managed-routing API returned an invalid response.";
		case "network_error":
			return "The managed-routing API request could not be completed.";
		default:
			return status === null
				? "The managed-routing API request failed."
				: `The managed-routing API request failed (HTTP ${status}).`;
	}
}

function resolveBaseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Managed-routing API URL must be a valid loopback URL.");
	}

	if (url.username || url.password) {
		throw new Error("Managed-routing API URL must not contain credentials.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Managed-routing API URL must use HTTP or HTTPS.");
	}
	if (!new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(url.hostname)) {
		throw new Error("Managed-routing API URL must use a loopback host.");
	}
	if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
		throw new Error(
			"Managed-routing API URL must not include a path, query, or fragment.",
		);
	}

	url.pathname = "/";
	return url;
}

function apiUrl(baseUrl: URL, path: string): URL {
	return new URL(path.replace(/^\/+/, ""), baseUrl);
}

function safeServerCode(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const details = (payload as { details?: unknown }).details;
	if (!details || typeof details !== "object") return null;
	const code = (details as { code?: unknown }).code;
	return typeof code === "string" && SAFE_SERVER_ERROR_CODES.has(code)
		? code
		: null;
}

async function parseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ManagedRoutingHttpError({
			status: response.status,
			code: "invalid_response",
		});
	}
}

function envelopeData<T>(payload: unknown): T {
	if (
		!payload ||
		typeof payload !== "object" ||
		(payload as Partial<ApiEnvelope<T>>).success !== true ||
		!("data" in payload)
	) {
		throw new ManagedRoutingHttpError({ code: "invalid_response" });
	}
	return (payload as ApiEnvelope<T>).data;
}

export function createManagedRoutingClient(
	options: ManagedRoutingClientOptions = {},
): ManagedRoutingControlPlane {
	const env = options.env ?? process.env;
	const baseUrl = resolveBaseUrl(
		options.baseUrl ??
			env.BETTER_CCFLARE_API_URL ??
			DEFAULT_MANAGED_ROUTING_API_URL,
	);
	const adminApiKey = env.BETTER_CCFLARE_ADMIN_API_KEY?.trim() || undefined;
	const fetchImplementation = options.fetch ?? globalThis.fetch;

	async function request(
		path: string,
		init: RequestInit = {},
	): Promise<unknown> {
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		if (init.body !== undefined)
			headers.set("content-type", "application/json");
		if (adminApiKey) headers.set("x-api-key", adminApiKey);

		let response: Response;
		try {
			response = await fetchImplementation(apiUrl(baseUrl, path), {
				...init,
				headers,
				redirect: adminApiKey ? "manual" : "follow",
			});
		} catch {
			throw new ManagedRoutingHttpError({ code: "network_error" });
		}

		if (adminApiKey && response.status >= 300 && response.status < 400) {
			throw new ManagedRoutingHttpError({
				status: response.status,
				code: "redirect_rejected",
			});
		}

		const payload = await parseJson(response);
		if (!response.ok) {
			throw new ManagedRoutingHttpError({
				status: response.status,
				code: safeServerCode(payload),
			});
		}
		return payload;
	}

	return {
		async getAccounts() {
			return (await request("/api/accounts", {
				method: "GET",
			})) as AccountResponse[];
		},
		async getAccountRoutingOverview() {
			return envelopeData<AccountRoutingOverview>(
				await request("/api/routing/accounts", { method: "GET" }),
			);
		},
		async listEffectiveRouting() {
			return envelopeData<EffectiveComboRoutingView[]>(
				await request("/api/routing/effective", { method: "GET" }),
			);
		},
		async getEffectiveRouting(family) {
			return envelopeData<EffectiveComboRoutingView>(
				await request(`/api/routing/effective/${family}`, { method: "GET" }),
			);
		},
		async previewAccountRouting({ accountId, family, managedModel }) {
			return envelopeData<
				ComboRoutingPreviewResult | AccountRoutingPreviewCollection
			>(
				await request("/api/routing/preview", {
					method: "POST",
					body: JSON.stringify({
						scope: "account",
						account_id: accountId,
						...(family === undefined ? {} : { family }),
						...(managedModel === undefined
							? {}
							: { managed_model: managedModel }),
					}),
				}),
			);
		},
		async previewFamilyRouting({ family, managedModel }) {
			return envelopeData<ComboRoutingPreviewResult>(
				await request("/api/routing/preview", {
					method: "POST",
					body: JSON.stringify({
						scope: "family",
						family,
						...(managedModel === undefined
							? {}
							: { managed_model: managedModel }),
					}),
				}),
			);
		},
		async applyAccountRoutingProposal({
			family,
			accountId,
			previewId,
			proposalId,
			managedModel,
		}) {
			return envelopeData<EffectiveComboRoutingView>(
				await request(`/api/routing/apply/${family}`, {
					method: "POST",
					body: JSON.stringify({
						scope: "account",
						preview_id: previewId,
						proposal_id: proposalId,
						managed_model: managedModel,
						subject: { account_id: accountId },
					}),
				}),
			);
		},
		async applyFamilyRoutingProposal({
			family,
			previewId,
			proposalId,
			managedModel,
		}) {
			return envelopeData<EffectiveComboRoutingView>(
				await request(`/api/routing/apply/${family}`, {
					method: "POST",
					body: JSON.stringify({
						scope: "family",
						preview_id: previewId,
						proposal_id: proposalId,
						managed_model: managedModel,
					}),
				}),
			);
		},
		async rollbackFamilyToManual(family) {
			return envelopeData<ComboFamilyAssignment>(
				await request(`/api/families/${family}`, {
					method: "PUT",
					body: JSON.stringify({ membership_mode: "manual" }),
				}),
			);
		},
	};
}
