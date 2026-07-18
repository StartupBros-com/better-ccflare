/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */

import { GUARD_REQUEST_ID_HEADER } from "@better-ccflare/http-common";

export { GUARD_REQUEST_ID_HEADER } from "@better-ccflare/http-common";

/**
 * Private hop-by-hop correlation metadata installed by the local guard.
 *
 * The guard overwrites this header at the public listener before forwarding.
 * The proxy consumes it only when it is the exact UUIDv4 shape produced by
 * `crypto.randomUUID()`, then strips it with the other internal transport
 * headers before any provider request.
 */
const CANONICAL_UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function getGuardRequestId(headers: Headers): string | undefined {
	const candidate = headers.get(GUARD_REQUEST_ID_HEADER);
	return candidate && CANONICAL_UUID_V4_PATTERN.test(candidate)
		? candidate
		: undefined;
}
