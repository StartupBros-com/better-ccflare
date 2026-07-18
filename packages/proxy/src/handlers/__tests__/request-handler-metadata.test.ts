/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { GUARD_REQUEST_ID_HEADER } from "../internal-transport-headers";
import { createRequestMetadata } from "../request-handler";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeRequest(value?: string): Request {
	const headers = new Headers();
	if (value !== undefined) headers.set(GUARD_REQUEST_ID_HEADER, value);
	return new Request("http://127.0.0.1:8789/v1/messages", { headers });
}

describe("createRequestMetadata guard correlation", () => {
	it("reuses a canonical UUID v4 supplied by the local guard", () => {
		const guardId = "76110a75-9e91-4ab9-89a7-3e5d25a318fc";
		const request = makeRequest(guardId);

		const metadata = createRequestMetadata(request, new URL(request.url));

		expect(metadata.id).toBe(guardId);
	});

	it.each([
		"client-controlled-id",
		"76110a75-9e91-1ab9-89a7-3e5d25a318fc",
		"76110A75-9E91-4AB9-89A7-3E5D25A318FC",
		"76110a75-9e91-4ab9-79a7-3e5d25a318fc",
		"76110a75-9e91-4ab9-89a7-3e5d25a318fc, spoofed",
	])("does not trust malformed direct-port value %s", (untrustedId) => {
		const request = makeRequest(untrustedId);

		const metadata = createRequestMetadata(request, new URL(request.url));

		expect(metadata.id).not.toBe(untrustedId);
		expect(metadata.id).toMatch(UUID_V4_PATTERN);
	});

	it("generates an ID for direct requests that bypass the guard", () => {
		const request = makeRequest();

		const metadata = createRequestMetadata(request, new URL(request.url));

		expect(metadata.id).toMatch(UUID_V4_PATTERN);
	});
});
