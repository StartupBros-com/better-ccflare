/**
 * Tests for the shared project attribution extraction helper (U2).
 *
 * These tests are written BEFORE `../project-attribution` exists (or before
 * its exports are implemented) so the initial run is expected to fail (red),
 * per the plan's test-first execution note for U2. Once
 * `packages/proxy/src/project-attribution.ts` is implemented, these should
 * pass (green) without modification.
 *
 * Covers the plan's U2 scenarios (docs/plans/2026-07-08-001-feature-attribution-source-tags-plan.md):
 *  - namespaced header precedence over legacy header
 *  - legacy `x-project` header still works
 *  - control-char stripping + length cap (64) preserved
 *  - workspace path inference (/home, /Users) -> path_project
 *  - H1 heading inference -> heading_project
 *  - "claude"-prefixed heading rejected
 *  - secret-like headings rejected via isLowRiskProjectSlug -> none
 *  - no header/path/heading -> none
 *  - usage-collector base64 fallback path (extractProjectAttributionFromParts)
 *    returns the same source labels as the parsed-body path
 */
import { describe, expect, it } from "bun:test";
import {
	extractProjectAttributionFromParts,
	extractProjectAttributionFromRequest,
	isLowRiskProjectSlug,
} from "../project-attribution";

describe("extractProjectAttributionFromRequest", () => {
	it("prefers x-better-ccflare-project over x-project when both are present", () => {
		const headers = new Headers({
			"x-better-ccflare-project": "ns-project",
			"x-project": "legacy-project",
		});
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBe("ns-project");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("falls back to x-project when the namespaced header is absent", () => {
		const headers = new Headers({ "x-project": "legacy-only" });
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBe("legacy-only");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("strips control characters and caps header-derived project length at 64", () => {
		const raw = `\x01\x02${"x".repeat(80)}\n`;
		const headers = new Headers({ "x-project": raw });
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).not.toBeNull();
		expect(result.project?.length).toBeLessThanOrEqual(64);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
		expect(result.project ?? "").not.toMatch(/[\x00-\x1F\x7F]/);
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("infers a sanitized repo slug from a /home workspace path in the system prompt", () => {
		const headers = new Headers();
		const body = {
			system: "context at /home/will/projects/better-ccflare/foo.ts done",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("better-ccflare");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	it("infers a sanitized repo slug from a /Users workspace path in the system prompt", () => {
		const headers = new Headers();
		const body = {
			system: "working at /Users/will/Desktop/MyProj/file.txt now",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("MyProj");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	it("uses the first eligible non-Claude H1 heading as the project when no header/path match", () => {
		const headers = new Headers();
		const body = { system: "# Harness\nWelcome to the project." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("Harness");
		expect(result.projectAttributionSource).toBe("heading_project");
	});

	it("rejects an H1 heading that starts with 'claude' (case-insensitive)", () => {
		const headers = new Headers();
		const body = { system: "# Claude Code Instructions\nSome content." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	it("returns none when there is no header, path, or heading", () => {
		const headers = new Headers();
		const body = { system: "Just a plain system prompt with no markers." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	it("returns none for a completely empty request (no headers, no body)", () => {
		const headers = new Headers();
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	describe("secret-like headings are rejected (isLowRiskProjectSlug -> false)", () => {
		const cases: Array<[string, string]> = [
			["bearer-ish token", "# Authorization: Bearer sk_live_abc123456789"],
			["URL", "# https://example.com/secret-path"],
			["email address", "# Contact will@example.com for help"],
			["sk- style API key", "# sk-ABCDEFGHIJ1234567890"],
			["AKIA-style AWS key", "# AKIAIOSFODNN7EXAMPLE"],
			[
				"long random base64-ish token",
				"# aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q123456",
			],
			[
				"sentence/incident-shaped (>6 words)",
				"# This is a very long sentence about an incident that happened today",
			],
		];

		for (const [label, system] of cases) {
			it(`rejects: ${label}`, () => {
				const headers = new Headers();
				const result = extractProjectAttributionFromRequest(headers, {
					system,
				});
				expect(result.project).toBeNull();
				expect(result.projectAttributionSource).toBe("none");
			});
		}
	});
});

describe("isLowRiskProjectSlug", () => {
	it("accepts ordinary repo-name-shaped labels", () => {
		expect(isLowRiskProjectSlug("better-ccflare")).toBe(true);
		expect(isLowRiskProjectSlug("Harness")).toBe(true);
		expect(isLowRiskProjectSlug("eval-suite")).toBe(true);
		expect(isLowRiskProjectSlug("My Project")).toBe(true);
	});

	it("rejects URL-shaped, email-shaped, and secret-shaped values", () => {
		expect(isLowRiskProjectSlug("https://example.com")).toBe(false);
		expect(isLowRiskProjectSlug("www.example.com")).toBe(false);
		expect(isLowRiskProjectSlug("me@example.com")).toBe(false);
		expect(isLowRiskProjectSlug("Bearer sk_live_abc123456789")).toBe(false);
	});
});

describe("extractProjectAttributionFromParts (usage-collector base64 fallback)", () => {
	it("returns header_project from a lowercased Record<string,string> header map", () => {
		const result = extractProjectAttributionFromParts(
			{ "X-Better-Ccflare-Project": "MyProj" },
			null,
		);
		expect(result.project).toBe("MyProj");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("returns path_project from a base64-encoded body, matching the parsed-body path", () => {
		const body = {
			system: "context at /home/will/repos/eval-suite/index.ts done",
		};
		const requestBodyBase64 = Buffer.from(JSON.stringify(body)).toString(
			"base64",
		);
		const result = extractProjectAttributionFromParts({}, requestBodyBase64);
		expect(result.project).toBe("eval-suite");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	it("returns heading_project from a base64-encoded body, matching the parsed-body path", () => {
		const body = { system: "# eval-suite\nDetails here." };
		const requestBodyBase64 = Buffer.from(JSON.stringify(body)).toString(
			"base64",
		);
		const result = extractProjectAttributionFromParts({}, requestBodyBase64);
		expect(result.project).toBe("eval-suite");
		expect(result.projectAttributionSource).toBe("heading_project");
	});

	it("returns none when headers are null/undefined and body is null", () => {
		const result = extractProjectAttributionFromParts(null, null);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});
});
