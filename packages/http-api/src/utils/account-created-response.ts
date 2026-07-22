import { jsonResponse } from "@better-ccflare/http-common";

/** Preserve one immutable post-create lookup key across every account flow. */
export function accountCreatedResponse<T extends Record<string, unknown>>(
	accountId: string,
	payload: T,
): Response {
	return jsonResponse({ ...payload, success: true, accountId });
}
