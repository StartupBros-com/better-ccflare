/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import {
	createGuardCorrelationEnvelope,
	createGuardCorrelationVerifier,
} from "../guard-correlation-auth";
import { GUARD_REQUEST_ID_HEADER } from "../internal-transport-headers";
import { createRequestMetadata } from "../request-handler";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const VERIFY = createGuardCorrelationVerifier(SECRET);

function makeRequest(value?: string): Request {
	const headers = new Headers();
	if (value !== undefined) headers.set(GUARD_REQUEST_ID_HEADER, value);
	return new Request("http://127.0.0.1:8789/v1/messages", { headers });
}

describe("createRequestMetadata guard correlation", () => {
	it("reuses only an authenticated UUID and captures its guard attempt", () => {
		const guardId = "76110a75-9e91-4ab9-89a7-3e5d25a318fc";
		const request = makeRequest(
			createGuardCorrelationEnvelope(SECRET, guardId, 2),
		);

		const metadata = createRequestMetadata(
			request,
			new URL(request.url),
			VERIFY,
		);

		expect(metadata.id).toBe(guardId);
		expect(metadata.guardAttemptOrdinal).toBe(2);
	});

	it.each([
		"client-controlled-id",
		"76110a75-9e91-1ab9-89a7-3e5d25a318fc",
		"76110A75-9E91-4AB9-89A7-3E5D25A318FC",
		"76110a75-9e91-4ab9-79a7-3e5d25a318fc",
		"76110a75-9e91-4ab9-89a7-3e5d25a318fc, spoofed",
	])("does not trust malformed direct-port value %s", (untrustedId) => {
		const request = makeRequest(untrustedId);

		const metadata = createRequestMetadata(
			request,
			new URL(request.url),
			VERIFY,
		);

		expect(metadata.id).not.toBe(untrustedId);
		expect(metadata.id).toMatch(UUID_V4_PATTERN);
		expect(metadata.guardAttemptOrdinal).toBeUndefined();
	});

	it("generates an ID for direct requests that bypass the guard", () => {
		const request = makeRequest();

		const metadata = createRequestMetadata(
			request,
			new URL(request.url),
			VERIFY,
		);

		expect(metadata.id).toMatch(UUID_V4_PATTERN);
		expect(metadata.guardAttemptOrdinal).toBeUndefined();
	});

	it("does not trust a correctly shaped signed envelope without the injected verifier", () => {
		const guardId = "76110a75-9e91-4ab9-89a7-3e5d25a318fc";
		const request = makeRequest(
			createGuardCorrelationEnvelope(SECRET, guardId, 1),
		);

		const metadata = createRequestMetadata(request, new URL(request.url));

		expect(metadata.id).not.toBe(guardId);
		expect(metadata.id).toMatch(UUID_V4_PATTERN);
		expect(metadata.guardAttemptOrdinal).toBeUndefined();
	});
});
