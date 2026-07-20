import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	CACHE_DIAG_ENV,
	handleCacheDiagnosisRequest,
	listDiagnosisSessions,
	recordDiagnosisCandidate,
	resetCacheDiagnosis,
} from "../cache-diagnosis";

afterEach(() => {
	resetCacheDiagnosis();
	delete process.env[CACHE_DIAG_ENV];
});

const encode = (v: unknown) => {
	const bytes = new TextEncoder().encode(JSON.stringify(v));
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
};

function capture(session: string, marker: string): void {
	recordDiagnosisCandidate(
		session,
		encode({
			model: "claude-opus-4-8",
			max_tokens: 32000,
			stream: true,
			messages: [{ role: "user", content: marker }],
		}),
		new Headers({
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "sensitive-beta",
			authorization: "Bearer secret",
			"x-raw-session": session,
		}),
	);
}

describe("privacy-safe cache diagnosis metadata", () => {
	test("does not retain anything when disabled", () => {
		capture("raw-session-key", "raw prompt body");
		expect(listDiagnosisSessions()).toEqual([]);
	});

	test("tracks only opaque bounded metadata, never request material", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		const rawSession = "raw-session-key-that-must-not-be-retained";
		const rawBody = "private prompt that must not be retained";

		capture(rawSession, rawBody);
		capture(rawSession, `${rawBody} second turn`);

		const sessions = listDiagnosisSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.session_id).toMatch(/^diag_[a-f0-9]{64}$/);
		expect(sessions[0]?.request_count).toBe(2);
		expect(sessions[0]?.has_pair).toBe(true);

		const exposed = JSON.stringify(sessions);
		expect(exposed).not.toContain(rawSession);
		expect(exposed).not.toContain(rawBody);
		expect(exposed).not.toContain("Bearer secret");
		expect(exposed).not.toContain("sensitive-beta");
	});

	test("evicts the least-recent session beyond the fixed cap", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		capture("session-0", "first");
		const evictedId = listDiagnosisSessions()[0]?.session_id;
		for (let i = 1; i < 9; i++) capture(`session-${i}`, `prompt-${i}`);

		const sessions = listDiagnosisSessions();
		expect(sessions).toHaveLength(8);
		expect(sessions.some((session) => session.session_id === evictedId)).toBe(
			false,
		);
	});

	test("reset removes all retained metadata", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		capture("session", "prompt");
		expect(listDiagnosisSessions()).toHaveLength(1);
		resetCacheDiagnosis();
		expect(listDiagnosisSessions()).toEqual([]);
	});
});

describe("cache diagnosis debug endpoint", () => {
	test("is metadata-only and never performs an inference replay", async () => {
		process.env[CACHE_DIAG_ENV] = "1";
		const rawSession = "session-that-must-stay-private";
		const rawBody = "prompt-that-must-stay-private";
		capture(rawSession, rawBody);

		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(async () => {
			throw new Error("cache diagnosis must never call fetch");
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;
		try {
			const response = await handleCacheDiagnosisRequest(
				new Request("http://localhost/api/debug/cache-diagnosis", {
					method: "POST",
					body: JSON.stringify({ session: rawSession, body: rawBody }),
				}),
			);
			expect(response.status).toBe(200);
			const payload = await response.json();
			expect(payload.status).toBe("metadata_only");
			expect(payload.replay_enabled).toBe(false);
			expect(payload.sessions).toHaveLength(1);
			expect(fetchSpy).not.toHaveBeenCalled();

			const exposed = JSON.stringify(payload);
			expect(exposed).not.toContain(rawSession);
			expect(exposed).not.toContain(rawBody);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("reports disabled without reading or replaying the request", async () => {
		const response = await handleCacheDiagnosisRequest(
			new Request("http://localhost/api/debug/cache-diagnosis", {
				method: "POST",
				body: "not-json-and-must-not-be-read",
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			status: "disabled",
			replay_enabled: false,
			sessions: [],
		});
	});
});
