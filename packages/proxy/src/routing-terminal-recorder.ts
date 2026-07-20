import { randomUUID } from "node:crypto";
import { sanitizeRequestHeaders } from "@better-ccflare/http-common";
import type { RequestMeta } from "@better-ccflare/types";
import {
	type EndMessage,
	isModelRewrite,
	type StartMessage,
} from "./worker-messages";

export interface RoutingTerminalCollector {
	handleStart(message: StartMessage): void;
	handleEnd(message: EndMessage): Promise<void>;
}

export interface RoutingTerminalRecordOptions {
	collector: RoutingTerminalCollector | null;
	requestMeta: RequestMeta;
	requestHeaders: Headers;
	response: Response;
	providerName: string;
	terminalKind: string;
	upstreamAttempts: number;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	skip?: boolean;
	onError?: (error: unknown) => void;
}

export type RequestLifecycleState = "unclaimed" | "started" | "finalized";

interface RequestLifecycleStartOptions {
	collector: RoutingTerminalCollector;
	message: StartMessage;
	onError?: (error: unknown) => void;
}

/**
 * One request-scoped owner for the usage start/end pair.
 *
 * Anthropic pre-commit rescue may commit its outer HTTP-200 SSE response before
 * the privately routed response resolves. In that interval forwardToClient is
 * allowed to start analytics, but its success/cancel terminal is held until the
 * outer coordinator decides whether the native response will be forwarded or
 * translated. State transitions happen synchronously; observer work is isolated
 * behind promises so a losing terminal can never race back in or affect delivery.
 */
export class RequestLifecycleCoordinator {
	state: RequestLifecycleState = "unclaimed";

	private collector: RoutingTerminalCollector | null = null;
	private onError: ((error: unknown) => void) | undefined;
	private finalizationDeferred = false;
	private pendingEnd: EndMessage | null = null;
	private completion: Promise<void> = Promise.resolve();

	deferFinalization(): void {
		if (this.state !== "finalized") this.finalizationDeferred = true;
	}

	start(options: RequestLifecycleStartOptions): boolean {
		if (this.state !== "unclaimed") return false;
		this.state = "started";
		this.collector = options.collector;
		this.onError = options.onError;
		try {
			options.collector.handleStart(options.message);
		} catch (error) {
			reportRecorderFailure(this.onError, error);
		}
		return true;
	}

	finalize(message: EndMessage): Promise<void> {
		if (this.state !== "started") return this.completion;
		if (this.finalizationDeferred) {
			this.pendingEnd ??= message;
			return this.completion;
		}
		return this.commitFinalization(message);
	}

	finalizeImmediately(message: EndMessage): Promise<void> {
		if (this.state !== "started") return this.completion;
		this.finalizationDeferred = false;
		this.pendingEnd = null;
		return this.commitFinalization(message);
	}

	releaseFinalization(): Promise<void> {
		this.finalizationDeferred = false;
		const pendingEnd = this.pendingEnd;
		this.pendingEnd = null;
		return pendingEnd ? this.finalize(pendingEnd) : this.completion;
	}

	private commitFinalization(message: EndMessage): Promise<void> {
		if (this.state !== "started") return this.completion;
		this.state = "finalized";
		const collector = this.collector;
		this.completion = Promise.resolve()
			.then(() => collector?.handleEnd(message))
			.then(() => undefined)
			.catch((error: unknown) => {
				reportRecorderFailure(this.onError, error);
			});
		return this.completion;
	}
}

// RequestMeta is shared by the route executor and every forwardToClient call.
// WeakMap preserves the request lifetime without retaining completed metadata.
const requestLifecycles = new WeakMap<
	RequestMeta,
	RequestLifecycleCoordinator
>();

export function getRequestLifecycleCoordinator(
	requestMeta: RequestMeta,
): RequestLifecycleCoordinator {
	let coordinator = requestLifecycles.get(requestMeta);
	if (!coordinator) {
		coordinator = new RequestLifecycleCoordinator();
		requestLifecycles.set(requestMeta, coordinator);
	}
	return coordinator;
}

function reportRecorderFailure(
	onError: RoutingTerminalRecordOptions["onError"],
	error: unknown,
): void {
	try {
		onError?.(error);
	} catch {
		// Analytics observers are isolated from the response path too.
	}
}

/**
 * Complete the normal request-history lifecycle for a locally generated
 * routing terminal that has no serving account.
 *
 * This intentionally records the native terminal response before any outer
 * transport adapter (notably Anthropic pre-commit rescue) can translate a
 * delayed 503 into an HTTP-200 SSE error. It does not consume or wrap the
 * response body, so direct and rescued callers retain their existing wire
 * semantics.
 */
export function recordRoutingTerminalRequest(
	options: RoutingTerminalRecordOptions,
): Promise<void> {
	if (options.skip === true) return Promise.resolve();
	const coordinator = getRequestLifecycleCoordinator(options.requestMeta);
	if (coordinator.state === "finalized") return Promise.resolve();

	try {
		const { requestMeta } = options;
		if (coordinator.state === "unclaimed") {
			const { collector } = options;
			if (!collector) return Promise.resolve();
			const modelRewritten = isModelRewrite(
				requestMeta.originalModel,
				requestMeta.appliedModel,
			);
			const sanitizedHeaders = sanitizeRequestHeaders(options.requestHeaders);
			const failoverAttempts = Math.max(
				0,
				Math.floor(options.upstreamAttempts) - 1,
			);

			coordinator.start({
				collector,
				onError: options.onError,
				message: {
					type: "start",
					messageId: randomUUID(),
					requestId: requestMeta.id,
					accountId: null,
					method: requestMeta.method,
					path: requestMeta.path,
					timestamp: requestMeta.timestamp,
					requestHeaders: Object.fromEntries(sanitizedHeaders.entries()),
					requestBody: null,
					project: requestMeta.project ?? null,
					projectAttributionSource:
						requestMeta.projectAttributionSource ?? "none",
					agentAttributionSource: requestMeta.agentAttributionSource ?? "none",
					responseStatus: options.response.status,
					responseHeaders: Object.fromEntries(
						options.response.headers.entries(),
					),
					isStream:
						options.response.headers
							.get("content-type")
							?.toLowerCase()
							.includes("text/event-stream") === true,
					providerName: options.providerName,
					accountBillingType: null,
					accountAutoPauseOnOverageEnabled: 0,
					accountName: null,
					agentUsed: requestMeta.agentUsed ?? null,
					originalModel: modelRewritten
						? (requestMeta.originalModel as string)
						: null,
					appliedModel: modelRewritten
						? (requestMeta.appliedModel as string)
						: null,
					comboName: requestMeta.comboName ?? null,
					apiKeyId: options.apiKeyId ?? null,
					apiKeyName: options.apiKeyName ?? null,
					retryAttempt: 0,
					failoverAttempts,
				},
			});
		}

		// A native local terminal is already authoritative (for example the 503
		// after all routes fail). A rescue terminal may instead replace a deferred
		// forwardToClient success/cancel. Both paths finalize the same start once.
		return coordinator.finalizeImmediately({
			type: "end",
			requestId: requestMeta.id,
			success: false,
			error: options.terminalKind,
		});
	} catch (error) {
		reportRecorderFailure(options.onError, error);
		return Promise.resolve();
	}
}
