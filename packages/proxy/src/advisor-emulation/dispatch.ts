import { projectAdvisorHistoryForCodex } from "./history";
import {
	buildAdvisorSubCallBody,
	classifyAdvisorSubCallFailure,
	deriveAdvisorCacheKey,
	extractAdvisorText,
	extractAdvisorUsage,
} from "./sub-call";
import type {
	AdvisorEmulationDecision,
	AdvisorEmulationStreamDeps,
	AdvisorOutcome,
	AdvisorRoundInput,
	AnthropicBlock,
} from "./types";

/**
 * Pure parts of the internal dispatch (plan KTD5). The proxy supplies `send`,
 * which pushes one Anthropic-format body through the provider on the worker's
 * own account (headers, hosted transform, fetch, hosted response processing).
 * Nothing here retries, fails over, or touches routing state.
 */
export interface InternalDispatchRequest {
	/** Anthropic Messages body; the provider transform converts it. */
	body: Record<string, unknown>;
	kind: "adv" | "cont";
	/** 1-based, per kind, within this client request. */
	ordinal: number;
	/** Physical model to pin via x-better-ccflare-final-model, when known. */
	finalModel: string | undefined;
	signal: AbortSignal;
}

export interface AdvisorDispatchOptions {
	/** The worker's request body after the declaration rewrite and projection. */
	workerBody: Record<string, unknown>;
	decision: AdvisorEmulationDecision;
	/** Stable per-session seed for the advisor's own prompt_cache_key. */
	cacheKeySeed: string;
	/** Physical model the worker call ran on; the continuation reuses it. */
	workerModel: string | undefined;
	send(request: InternalDispatchRequest): Promise<Response>;
}

export function deriveInternalRequestId(
	requestId: string,
	kind: "adv" | "cont",
	ordinal: number,
): string {
	return `${requestId}:${kind}${ordinal}`;
}

/**
 * The continuation request: the worker body with the in-flight assistant
 * message appended, then projected exactly as a later client turn will be
 * (plan R10), so the next turn reproduces this prefix byte for byte.
 */
export function buildContinuationBody(
	workerBody: Record<string, unknown>,
	inflightAssistantContent: readonly AnthropicBlock[],
): Record<string, unknown> {
	const messages = Array.isArray(workerBody.messages)
		? (workerBody.messages as unknown[])
		: [];
	const extended = {
		...workerBody,
		messages: [
			...messages,
			{ role: "assistant", content: [...inflightAssistantContent] },
		],
	};
	return projectAdvisorHistoryForCodex(extended) ?? extended;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function readCappedText(response: Response, cap = 64 * 1024) {
	try {
		const text = await response.text();
		return text.length > cap ? text.slice(0, cap) : text;
	} catch {
		return "";
	}
}

function failure(
	model: string,
	input: Parameters<typeof classifyAdvisorSubCallFailure>[0],
): AdvisorOutcome {
	return {
		content: {
			type: "advisor_tool_result_error",
			error_code: classifyAdvisorSubCallFailure(input),
		},
		model,
	};
}

/** Map the sub-call's HTTP response (success or failure) to an outcome. */
export async function interpretAdvisorSubCallResponse(
	response: Response,
	advisorModel: string,
): Promise<AdvisorOutcome> {
	const text = await readCappedText(response);
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	if (!response.ok) {
		const error = isRecord(json) && isRecord(json.error) ? json.error : {};
		const message =
			typeof error.message === "string"
				? error.message
				: isRecord(json) && typeof json.detail === "string"
					? json.detail
					: text.slice(0, 500);
		return failure(advisorModel, {
			status: response.status,
			errorType: typeof error.type === "string" ? error.type : undefined,
			errorCode: typeof error.code === "string" ? error.code : undefined,
			message,
		});
	}
	if (isRecord(json) && json.type === "error") {
		const error = isRecord(json.error) ? json.error : {};
		return failure(advisorModel, {
			errorType: typeof error.type === "string" ? error.type : undefined,
			errorCode: typeof error.code === "string" ? error.code : undefined,
			message: typeof error.message === "string" ? error.message : undefined,
		});
	}
	const advice = extractAdvisorText(json);
	if (advice === null) return failure(advisorModel, {});
	const usage = extractAdvisorUsage(json);
	return {
		content: { type: "advisor_result", text: advice },
		model: advisorModel,
		...(usage ? { usage } : {}),
	};
}

export function createAdvisorEmulationDispatch(
	options: AdvisorDispatchOptions,
): Pick<
	AdvisorEmulationStreamDeps,
	"runAdvisor" | "runContinuation" | "advisorModel"
> {
	const advisorModel = options.decision.advisorModel;
	const cacheKey = deriveAdvisorCacheKey(
		`${options.cacheKeySeed}:${advisorModel}`,
	);
	let advisorOrdinal = 0;
	let continuationOrdinal = 0;
	return {
		advisorModel,
		async runAdvisor(input: AdvisorRoundInput): Promise<AdvisorOutcome> {
			const body = buildAdvisorSubCallBody({
				body: options.workerBody,
				inflightAssistantContent: input.inflightAssistantContent,
				advisorModel,
				cacheKey,
			});
			let response: Response;
			try {
				response = await options.send({
					body,
					kind: "adv",
					ordinal: ++advisorOrdinal,
					finalModel: advisorModel,
					signal: input.signal,
				});
			} catch (error) {
				// The interceptor owns the timeout and the abort; anything thrown
				// here is a transport failure.
				if (input.signal.aborted) throw error;
				return failure(advisorModel, {});
			}
			return interpretAdvisorSubCallResponse(response, advisorModel);
		},
		runContinuation(input: AdvisorRoundInput): Promise<Response> {
			return options.send({
				body: {
					...buildContinuationBody(
						options.workerBody,
						input.inflightAssistantContent,
					),
					stream: true,
				},
				kind: "cont",
				ordinal: ++continuationOrdinal,
				finalModel: options.workerModel,
				signal: input.signal,
			});
		},
	};
}
