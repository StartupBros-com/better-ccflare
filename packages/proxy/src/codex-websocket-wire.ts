import {
	CODEX_RESPONSES_HTTP_URL,
	type CodexWebSocketFactory,
	type CodexWebSocketFailureCategory,
	type CodexWebSocketLike,
	type CodexWebSocketOptions,
} from "./codex-websocket-contract";

const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const SSE_ENCODER = new TextEncoder();

const STRIPPED_HANDSHAKE_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"cookie",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"x-codex-turn-state",
]);

export const CODEX_WEBSOCKET_TERMINAL_EVENT_TYPES = new Set([
	"error",
	"response.completed",
	"response.failed",
	"response.incomplete",
]);

export const CODEX_WEBSOCKET_ERROR_EVENT_TYPES = new Set([
	"error",
	"response.failed",
]);

export class CodexWebSocketPreWriteFailure extends Error {
	constructor(
		readonly category:
			| "handshake_close"
			| "handshake_error"
			| "handshake_timeout",
	) {
		super(category);
		this.name = "CodexWebSocketPreWriteFailure";
	}
}

export function getCodexWebSocketResponseId(
	event: Record<string, unknown>,
): string | null {
	const direct = event.response_id;
	if (typeof direct === "string" && direct) return direct;
	const response = event.response;
	if (response && typeof response === "object") {
		const id = (response as Record<string, unknown>).id;
		if (typeof id === "string" && id) return id;
	}
	return null;
}

export function isCodexWebSocketOutputEvent(type: string): boolean {
	return (
		type.startsWith("response.output_") ||
		type === "response.content_part.added"
	);
}

export function getCodexWebSocketCloseCode(event: Event): number | null {
	const value = (event as Event & { code?: unknown }).code;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function closeCodexWebSocketSafely(
	socket: CodexWebSocketLike,
	code = 1000,
): void {
	try {
		socket.close(code, "ccflare_transport_retired");
	} catch {
		// Best effort only: eviction must never destabilize request routing.
	}
}

export function createCodexWebSocketNoReplayResponse(
	status: 502 | 504,
	category: CodexWebSocketFailureCategory,
): Response {
	return Response.json(
		{
			type: "error",
			error: {
				type: "api_error",
				message:
					status === 504
						? "Codex WebSocket response stalled before meaningful progress. The request was not replayed."
						: "Codex WebSocket transport ended after the request was sent. The request was not replayed.",
				code: `codex_websocket_${category}`,
			},
		},
		{ status },
	);
}

export const defaultCodexWebSocketFactory: CodexWebSocketFactory = (
	url: string,
	options: CodexWebSocketOptions,
): CodexWebSocketLike => {
	const BunWebSocket = WebSocket as unknown as new (
		url: string,
		options: Bun.WebSocketOptions,
	) => CodexWebSocketLike;
	return new BunWebSocket(url, options as Bun.WebSocketOptions);
};

export function buildCodexWebSocketHandshakeHeaders(
	request: Request,
	applyCloudflareCookies: (url: string, headers: Headers) => void,
): Headers {
	const headers = new Headers(request.headers);
	for (const name of [...headers.keys()]) {
		if (
			STRIPPED_HANDSHAKE_HEADERS.has(name.toLowerCase()) ||
			name.toLowerCase().startsWith("sec-websocket-") ||
			name.toLowerCase().startsWith("x-better-ccflare-")
		) {
			headers.delete(name);
		}
	}
	headers.set("openai-beta", RESPONSES_WEBSOCKET_BETA);
	applyCloudflareCookies(CODEX_RESPONSES_HTTP_URL, headers);
	return headers;
}

export async function codexWebSocketMessageText(
	data: unknown,
): Promise<string> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		);
	}
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
	throw new Error("unsupported websocket frame");
}

export function encodeCodexWebSocketSseEvent(
	type: string,
	event: Record<string, unknown>,
): Uint8Array {
	return SSE_ENCODER.encode(
		`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
	);
}
