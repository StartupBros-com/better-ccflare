import type { DatabaseOperations } from "@better-ccflare/database";
import {
	initiateCodexDeviceFlow,
	pollCodexForToken,
} from "@better-ccflare/providers/codex";
import {
	initiateDeviceFlow as initiateQwenDeviceFlow,
	pollForToken as pollQwenForToken,
} from "@better-ccflare/providers/qwen";
import { createServerOwnedAccountRoutingFinalizer } from "./account-routing-operations";
import {
	createDeviceSetupCoordinator,
	type DeviceSetupCoordinator,
} from "./device-setup-jobs";

function normalizeQwenBaseUrl(url: string): string {
	let normalized = url.trim();
	if (!normalized.startsWith("http")) normalized = `https://${normalized}`;
	if (!normalized.endsWith("/v1")) normalized = `${normalized}/v1`;
	return normalized;
}

function authorizationFailure(error: unknown): Error & { code: string } {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	const code = message.includes("denied")
		? "authorization_denied"
		: message.includes("expired") || message.includes("timed out")
			? "authorization_interrupted"
			: "authorization_failed";
	return Object.assign(new Error("Device authorization failed"), { code });
}

function requireDeviceCredential(value: unknown): {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	resource_url?: string;
} {
	if (!value || typeof value !== "object") {
		throw authorizationFailure(undefined);
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.access_token !== "string" ||
		!candidate.access_token ||
		typeof candidate.refresh_token !== "string" ||
		!candidate.refresh_token ||
		typeof candidate.expires_in !== "number" ||
		!Number.isFinite(candidate.expires_in) ||
		candidate.expires_in <= 0 ||
		(candidate.resource_url !== undefined &&
			typeof candidate.resource_url !== "string")
	) {
		throw authorizationFailure(undefined);
	}
	return candidate as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		resource_url?: string;
	};
}

/** Server composition root for one durable Qwen/Codex setup coordinator. */
export function createServerDeviceSetupCoordinator(
	dbOps: DatabaseOperations,
): DeviceSetupCoordinator {
	const finalizeRouting = createServerOwnedAccountRoutingFinalizer(dbOps);
	return createDeviceSetupCoordinator({
		repository: dbOps.getDeviceSetupJobRepository(),
		providers: {
			qwen: {
				initiate: async () => {
					const flow = await initiateQwenDeviceFlow();
					return {
						verificationUrl:
							flow.verificationUriComplete || flow.verificationUri,
						userCode: flow.userCode,
						continuation: {
							deviceCode: flow.deviceCode,
							pkce: flow.pkce,
							interval: flow.interval,
						},
					};
				},
				poll: async (continuation) => {
					try {
						const state = continuation as {
							deviceCode: string;
							pkce: Parameters<typeof pollQwenForToken>[1];
							interval: number;
						};
						return await pollQwenForToken(
							state.deviceCode,
							state.pkce,
							state.interval,
							60,
						);
					} catch (error) {
						throw authorizationFailure(error);
					}
				},
			},
			codex: {
				initiate: async () => {
					const flow = await initiateCodexDeviceFlow();
					return {
						verificationUrl: flow.verificationUrl,
						userCode: flow.userCode,
						continuation: {
							deviceAuthId: flow.deviceAuthId,
							userCode: flow.userCode,
							interval: flow.interval,
						},
					};
				},
				poll: async (continuation) => {
					try {
						const state = continuation as {
							deviceAuthId: string;
							userCode: string;
							interval: number;
						};
						return await pollCodexForToken(
							state.deviceAuthId,
							state.userCode,
							state.interval,
							180,
						);
					} catch (error) {
						throw authorizationFailure(error);
					}
				},
			},
		},
		commitAuthorizedAccount: async ({
			provider,
			accountId,
			name,
			priority,
			credential,
		}) => {
			const tokens = requireDeviceCredential(credential);
			const now = Date.now();
			const customEndpoint =
				provider === "qwen" && tokens.resource_url
					? normalizeQwenBaseUrl(tokens.resource_url)
					: null;
			await dbOps.getAdapter().run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority,
					custom_endpoint, model_mappings, model_fallbacks
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					provider,
					null,
					tokens.refresh_token,
					tokens.access_token,
					now + tokens.expires_in * 1000,
					now,
					priority,
					customEndpoint,
					null,
					null,
				],
			);
		},
		accountExists: async (accountId) =>
			Boolean(
				await dbOps
					.getAdapter()
					.get<{ id: string }>("SELECT id FROM accounts WHERE id = ?", [
						accountId,
					]),
			),
		finalizeRouting,
	});
}
