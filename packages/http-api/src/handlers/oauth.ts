import crypto from "node:crypto";
import { Config } from "@better-ccflare/config";
import {
	patterns,
	validatePriority,
	validateString,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	Conflict,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
	ServiceUnavailable,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
import {
	initiateCodexDeviceFlow,
	pollCodexForToken,
} from "@better-ccflare/providers/codex";
import {
	initiateDeviceFlow as initiateQwenDeviceFlow,
	pollForToken as pollQwenForToken,
} from "@better-ccflare/providers/qwen";
import { clearAccountRefreshCache } from "@better-ccflare/proxy";
import type { DeviceSetupCoordinator } from "../services/device-setup-jobs";
import {
	DeviceSetupAuthorizationUnavailableError,
	DeviceSetupIdempotencyConflictError,
	DeviceSetupValidationError,
} from "../services/device-setup-jobs";

const log = new Logger("OAuthHandler");

// In-memory session store for Qwen device flow
type QwenSession =
	| { status: "pending"; accountName: string; accountId?: string }
	| { status: "complete"; accountName: string; accountId: string }
	| { status: "error"; accountName: string; accountId?: string; error: string };

const qwenSessions = new Map<string, QwenSession>();

function normalizeQwenBaseUrl(url: string): string {
	let normalized = url.trim();
	if (!normalized.startsWith("http")) {
		normalized = `https://${normalized}`;
	}
	if (!normalized.endsWith("/v1")) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

async function readDeviceSetupBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new DeviceSetupValidationError("Request body must be valid JSON");
	}
}

function deviceSetupErrorResponse(error: unknown): Response {
	if (error instanceof DeviceSetupValidationError) {
		return errorResponse(BadRequest(error.message));
	}
	if (error instanceof DeviceSetupIdempotencyConflictError) {
		return errorResponse(Conflict(error.message));
	}
	if (error instanceof DeviceSetupAuthorizationUnavailableError) {
		return errorResponse(ServiceUnavailable(error.message));
	}
	return errorResponse(
		InternalServerError("Failed to initialize durable device setup"),
	);
}

/** Authenticated recovery list for durable device-setup jobs. */
export function createDeviceSetupJobsListHandler(
	coordinator: DeviceSetupCoordinator,
) {
	return async (url: URL): Promise<Response> => {
		try {
			const rawLimit = url.searchParams.get("limit");
			const limit = rawLimit === null ? undefined : Number(rawLimit);
			return jsonResponse(await coordinator.listRecent(limit));
		} catch (error) {
			return deviceSetupErrorResponse(error);
		}
	};
}

/** Authenticated, secret-free view of one durable device-setup job. */
export function createDeviceSetupJobGetHandler(
	coordinator: DeviceSetupCoordinator,
) {
	return async (jobId: string): Promise<Response> => {
		const job = await coordinator.get(jobId);
		return job
			? jsonResponse(job)
			: errorResponse(NotFound("Device setup job not found"));
	};
}

/**
 * Create a Qwen device flow initialization handler.
 * Returns the durable job plus transient authorization fields. The coordinator
 * owns background polling and finalization independently of client reads.
 */
export function createQwenDeviceFlowInitHandler(
	coordinator: DeviceSetupCoordinator,
) {
	return async (req: Request): Promise<Response> => {
		try {
			return jsonResponse(
				await coordinator.initQwen(await readDeviceSetupBody(req)),
			);
		} catch (error) {
			return deviceSetupErrorResponse(error);
		}
	};
}

/**
 * Create a Qwen device flow status handler.
 * Returns { status, error? } for the given sessionId.
 */
export function createQwenDeviceFlowStatusHandler() {
	return (sessionId: string): Response => {
		const session = qwenSessions.get(sessionId);
		if (!session) {
			return errorResponse(NotFound("Session not found or expired"));
		}
		if (session.status === "error") {
			return jsonResponse({
				status: "error",
				error: session.error,
				...(session.accountId ? { accountId: session.accountId } : {}),
			});
		}
		return jsonResponse({
			status: session.status,
			...(session.accountId ? { accountId: session.accountId } : {}),
		});
	};
}

/**
 * Create a Qwen re-authentication handler.
 * Re-runs the device flow for an existing account, updating tokens in-place.
 * Returns { authUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createQwenReauthHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
				custom_endpoint: string | null;
			}>(
				"SELECT id, name, provider, custom_endpoint FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "qwen") {
				return errorResponse(
					BadRequest(
						"Re-authentication via device flow is only supported for Qwen accounts",
					),
				);
			}

			let deviceFlow: Awaited<ReturnType<typeof initiateQwenDeviceFlow>>;
			try {
				deviceFlow = await initiateQwenDeviceFlow();
			} catch (err) {
				log.error("Qwen reauth device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Qwen device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			qwenSessions.set(sessionId, {
				status: "pending",
				accountName: account.name,
				accountId: account.id,
			});

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollQwenForToken(
						deviceFlow.deviceCode,
						deviceFlow.pkce,
						deviceFlow.interval,
						60,
					);

					const resourceUrl = tokens.resource_url
						? normalizeQwenBaseUrl(tokens.resource_url)
						: account.custom_endpoint;
					const refreshedAt = Date.now();

					await dbOps.getAdapter().run(
						`UPDATE accounts SET
							refresh_token = ?,
							access_token = ?,
							expires_at = ?,
							custom_endpoint = ?,
							refresh_token_issued_at = ?,
							requires_reauth = 0
						WHERE id = ?`,
						[
							tokens.refresh_token,
							tokens.access_token,
							refreshedAt + tokens.expires_in * 1000,
							resourceUrl,
							refreshedAt,
							account.id,
						],
					);
					clearAccountRefreshCache(account.id);

					// Auto-resume an oauth_invalid_grant pause and drop stale refresh
					// backoff so the account returns to rotation immediately.
					// Best-effort: the tokens were already updated, so a resume failure
					// must not fail the reauth or skip the cache clear.
					try {
						await dbOps.resumeAccountIfNeedsReauth(account.id);
					} catch (resumeErr) {
						log.error(
							`Failed to auto-resume needs-reauth pause for '${account.name}':`,
							resumeErr,
						);
					}
					clearAccountRefreshCache(account.id);

					qwenSessions.set(sessionId, {
						status: "complete",
						accountName: account.name,
						accountId: account.id,
					});
					log.info(
						`Qwen account '${account.name}' re-authenticated via web device flow`,
					);

					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Qwen reauth polling failed for '${account.name}':`, err);
					qwenSessions.set(sessionId, {
						status: "error",
						accountName: account.name,
						accountId: account.id,
						error: (err as Error).message,
					});
					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				authUrl:
					deviceFlow.verificationUriComplete || deviceFlow.verificationUri,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Qwen reauth error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Qwen re-authentication"),
			);
		}
	};
}

// In-memory session store for Codex device flow
type CodexSession =
	| { status: "pending"; accountName: string; accountId?: string }
	| { status: "complete"; accountName: string; accountId: string }
	| { status: "error"; accountName: string; accountId?: string; error: string };

const codexSessions = new Map<string, CodexSession>();

/**
 * Create a Codex device flow initialization handler.
 * Returns the durable job plus transient authorization fields. The coordinator
 * owns background polling and finalization independently of client reads.
 */
export function createCodexDeviceFlowInitHandler(
	coordinator: DeviceSetupCoordinator,
) {
	return async (req: Request): Promise<Response> => {
		try {
			return jsonResponse(
				await coordinator.initCodex(await readDeviceSetupBody(req)),
			);
		} catch (error) {
			return deviceSetupErrorResponse(error);
		}
	};
}

/**
 * Create a Codex re-authentication handler.
 * Re-runs the device flow for an existing Codex account, updating tokens in-place.
 * Returns { verificationUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createCodexReauthHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
			}>("SELECT id, name, provider FROM accounts WHERE id = ?", [accountId]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Re-authentication via device flow is only supported for Codex accounts",
					),
				);
			}

			let deviceFlow: Awaited<ReturnType<typeof initiateCodexDeviceFlow>>;
			try {
				deviceFlow = await initiateCodexDeviceFlow();
			} catch (err) {
				log.error("Codex reauth device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Codex device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			codexSessions.set(sessionId, {
				status: "pending",
				accountName: account.name,
				accountId: account.id,
			});

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollCodexForToken(
						deviceFlow.deviceAuthId,
						deviceFlow.userCode,
						deviceFlow.interval,
						180,
					);

					await dbOps.getAdapter().run(
						`UPDATE accounts SET
							refresh_token = ?,
							access_token = ?,
							expires_at = ?,
							requires_reauth = 0
						WHERE id = ?`,
						[
							tokens.refresh_token,
							tokens.access_token,
							Date.now() + tokens.expires_in * 1000,
							account.id,
						],
					);
					clearAccountRefreshCache(account.id);

					// Auto-resume an oauth_invalid_grant pause and drop stale refresh
					// backoff so the account returns to rotation immediately.
					// Best-effort: the tokens were already updated, so a resume failure
					// must not fail the reauth or skip the cache clear.
					try {
						await dbOps.resumeAccountIfNeedsReauth(account.id);
					} catch (resumeErr) {
						log.error(
							`Failed to auto-resume needs-reauth pause for '${account.name}':`,
							resumeErr,
						);
					}
					clearAccountRefreshCache(account.id);

					codexSessions.set(sessionId, {
						status: "complete",
						accountName: account.name,
						accountId: account.id,
					});
					log.info(
						`Codex account '${account.name}' re-authenticated via web device flow`,
					);

					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Codex reauth polling failed for '${account.name}':`, err);
					codexSessions.set(sessionId, {
						status: "error",
						accountName: account.name,
						accountId: account.id,
						error: (err as Error).message,
					});
					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				verificationUrl: deviceFlow.verificationUrl,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Codex reauth error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Codex re-authentication"),
			);
		}
	};
}

/**
 * Create a Codex device flow status handler.
 * Returns { status, error? } for the given sessionId.
 */
export function createCodexDeviceFlowStatusHandler() {
	return (sessionId: string): Response => {
		const session = codexSessions.get(sessionId);
		if (!session) {
			return errorResponse(NotFound("Session not found or expired"));
		}
		if (session.status === "error") {
			return jsonResponse({
				status: "error",
				error: session.error,
				...(session.accountId ? { accountId: session.accountId } : {}),
			});
		}
		return jsonResponse({
			status: session.status,
			...(session.accountId ? { accountId: session.accountId } : {}),
		});
	};
}

/**
 * Create an Anthropic re-authentication init handler.
 * Starts an OAuth flow for an existing Anthropic (claude-oauth) account.
 * Returns { authUrl, sessionId } immediately.
 */
export function createAnthropicReauthInitHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
				refresh_token: string | null;
			}>(
				"SELECT id, name, provider, refresh_token FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest(
						"Re-authentication is only supported for Anthropic OAuth accounts",
					),
				);
			}

			const oauthFlow = await createOAuthFlow(dbOps, config);

			try {
				const flowResult = await oauthFlow.begin({
					name: account.name,
					mode: "claude-oauth",
					skipAccountCheck: true,
				});

				// Store session; use accountName field so callback can look it up by name
				dbOps.createOAuthSession(
					flowResult.sessionId,
					account.name,
					flowResult.pkce.verifier,
					"claude-oauth",
					undefined, // customEndpoint
					0, // priority — reauth preserves existing account's priority via UPDATE, this is unused
					10, // ttlMinutes
				);

				return jsonResponse({
					success: true,
					authUrl: flowResult.authUrl,
					sessionId: flowResult.sessionId,
				});
			} catch (error) {
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			log.error("Anthropic reauth init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Anthropic re-authentication"),
			);
		}
	};
}

/**
 * Create an Anthropic re-authentication callback handler.
 * Exchanges the authorization code and UPDATEs existing account tokens in place.
 */
export function createAnthropicReauthCallbackHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (req: Request): Promise<Response> => {
		if (req.method !== "POST") {
			return errorResponse(
				BadRequest("Only POST requests are supported for OAuth callback"),
			);
		}

		try {
			const body = await req.json();

			const sessionId = validateString(body.sessionId, "sessionId", {
				required: true,
				pattern: patterns.uuid,
			});
			if (!sessionId) {
				return errorResponse(BadRequest("Valid sessionId is required"));
			}

			const code = validateString(body.code, "code", {
				required: true,
				minLength: 1,
			});
			if (!code) {
				return errorResponse(BadRequest("Valid code is required"));
			}

			// Get stored session
			const oauthSession = await dbOps.getOAuthSession(sessionId);
			if (!oauthSession) {
				return errorResponse(
					BadRequest("OAuth session expired or invalid. Please try again."),
				);
			}

			const { accountName: name, verifier } = oauthSession;

			// Look up the account by name to get its id for the UPDATE
			const account = await dbOps
				.getAdapter()
				.get<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [name]);
			if (!account) {
				return errorResponse(
					BadRequest(`Account '${name}' not found. It may have been deleted.`),
				);
			}

			try {
				const oauthFlow = await createOAuthFlow(dbOps, config);

				const oauthProvider = await import("@better-ccflare/providers").then(
					(m) => m.getOAuthProvider("anthropic"),
				);
				if (!oauthProvider) {
					throw new Error("OAuth provider not found");
				}
				const runtime = config.getRuntime();
				const oauthConfig = oauthProvider.getOAuthConfig("claude-oauth");
				oauthConfig.clientId = runtime.clientId;

				const flowData = {
					sessionId,
					authUrl: "",
					pkce: { verifier, challenge: "" },
					oauthConfig,
					mode: "claude-oauth" as const,
				};

				log.debug(`Completing Anthropic reauth for account '${name}'`);

				await oauthFlow.completeReauth(
					{ sessionId, code, name, id: account.id },
					flowData,
				);
				clearAccountRefreshCache(account.id);

				dbOps.deleteOAuthSession(sessionId);

				// Drop any stale refresh backoff/failure state so the just-installed
				// token is used immediately instead of waiting out the backoff window
				// (completeReauth already lifted any oauth_invalid_grant pause).
				clearAccountRefreshCache(account.id);

				log.info(`Successfully re-authenticated Anthropic account '${name}'`);

				return jsonResponse({
					success: true,
					message: `Account '${name}' re-authenticated successfully!`,
				});
			} catch (error) {
				log.error(
					`Anthropic reauth callback failed for account '${name}':`,
					error,
				);
				return errorResponse(
					error instanceof Error
						? error
						: new Error("Failed to complete Anthropic re-authentication"),
				);
			}
		} catch (error) {
			log.error("Anthropic reauth callback validation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to process Anthropic reauth callback"),
			);
		}
	};
}

/**
 * Create an OAuth initialization handler
 */
export function createOAuthInitHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
			});

			if (!name) {
				return errorResponse(BadRequest("Valid account name is required"));
			}

			// Validate mode (with backward compatibility for deprecated "max" mode)
			let mode = (validateString(body.mode, "mode", {
				allowedValues: ["claude-oauth", "console", "max"] as const,
			}) || "claude-oauth") as "claude-oauth" | "console" | "max";

			// Handle deprecated "max" mode with warning
			if (mode === "max") {
				log.warn(
					'Deprecated mode "max" detected, treating as "claude-oauth". Please update to use "claude-oauth" instead.',
				);
				mode = "claude-oauth";
			}

			// Validate custom endpoint
			const customEndpoint = validateString(
				body.customEndpoint,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			// Validate priority (0-100, defaults to 0)
			const priority = validatePriority(body.priority ?? 0, "priority");

			const config = new Config();
			const oauthFlow = await createOAuthFlow(dbOps, config);

			try {
				// Begin OAuth flow using consolidated logic
				const flowResult = await oauthFlow.begin({
					name,
					mode,
				});

				// Store custom endpoint and priority in session so the callback
				// can forward them to oauthFlow.complete() when creating the account.
				dbOps.createOAuthSession(
					flowResult.sessionId,
					name,
					flowResult.pkce.verifier,
					mode,
					customEndpoint,
					priority,
					10, // 10 minute TTL
				);

				return jsonResponse({
					success: true,
					authUrl: flowResult.authUrl,
					sessionId: flowResult.sessionId,
					step: "authorize",
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes("already exists")
				) {
					return errorResponse(BadRequest(error.message));
				}
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			log.error("OAuth init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize OAuth"),
			);
		}
	};
}

/**
 * Create an OAuth callback handler
 */
export function createOAuthCallbackHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		// Validate HTTP method - only POST is supported
		if (req.method !== "POST") {
			return errorResponse(
				BadRequest("Only POST requests are supported for OAuth callback"),
			);
		}

		try {
			const body = await req.json();

			// Validate session ID - validateString throws ValidationError if invalid
			const sessionId = validateString(body.sessionId, "sessionId", {
				required: true,
				pattern: patterns.uuid,
			});

			// Validate code - validateString throws ValidationError if invalid
			const code = validateString(body.code, "code", {
				required: true,
				minLength: 1,
			});

			// Get stored PKCE verifier from database
			const oauthSession = await dbOps.getOAuthSession(sessionId);
			if (!oauthSession) {
				return errorResponse(
					BadRequest("OAuth session expired or invalid. Please try again."),
				);
			}

			const {
				accountName: name,
				verifier,
				mode: savedMode,
				customEndpoint: savedCustomEndpoint,
				priority: savedPriority,
			} = oauthSession;

			try {
				// Create OAuth flow instance
				const config = new Config();
				const oauthFlow = await createOAuthFlow(dbOps, config);

				// We need to reconstruct the flow data since we can't pass the full BeginResult through HTTP
				// The OAuth flow will handle the token exchange and account creation
				const oauthProvider = await import("@better-ccflare/providers").then(
					(m) => m.getOAuthProvider("anthropic"),
				);
				if (!oauthProvider) {
					throw new Error("OAuth provider not found");
				}
				const runtime = config.getRuntime();
				const oauthConfig = oauthProvider.getOAuthConfig(savedMode);
				oauthConfig.clientId = runtime.clientId;

				const flowData = {
					sessionId,
					authUrl: "", // Not needed for complete
					pkce: { verifier, challenge: "" }, // Only verifier is needed
					oauthConfig,
					mode: savedMode || "claude-oauth", // Add mode to match BeginResult type
				};

				log.debug(
					`Completing OAuth flow for account '${name}' in ${savedMode} mode`,
				);

				const createdAccount = await oauthFlow.complete(
					{
						sessionId,
						code,
						name,
						priority: savedPriority,
						customEndpoint: savedCustomEndpoint,
					},
					flowData,
				);

				// Clean up OAuth session from database
				dbOps.deleteOAuthSession(sessionId);

				log.info(`Successfully added account '${name}' via OAuth`);

				return jsonResponse({
					success: true,
					accountId: createdAccount.id,
					message: `Account '${name}' added successfully!`,
					mode:
						savedMode === "claude-oauth"
							? "Claude CLI OAuth"
							: "Claude Console",
				});
			} catch (error) {
				log.error(`OAuth flow completion failed for account '${name}':`, error);
				return errorResponse(
					error instanceof Error
						? error
						: new Error("Failed to complete OAuth flow"),
				);
			}
		} catch (error) {
			log.error("OAuth callback validation error:", error);
			// Return the validation error as-is to show the specific error message
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to process OAuth callback"),
			);
		}
	};
}
