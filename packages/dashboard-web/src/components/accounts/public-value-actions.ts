/** Minimal slice of the API client the public-value actions need. */
export interface PublicValueApi {
	setAccountPublicValue(
		accountId: string,
		enabled: boolean,
		label?: string,
	): Promise<unknown>;
}

export type PublicValueToggleOutcome =
	| { kind: "open-dialog" }
	| { kind: "unpublished" };

/**
 * Switch-flip decision. Turning on never writes: it opens the label dialog,
 * because publishing needs a label. Turning off writes `enabled:false` only.
 * Rejects with the API error so the caller can surface it.
 */
export async function togglePublicValue(
	account: { id: string; publicValueEnabled?: boolean },
	api: PublicValueApi,
): Promise<PublicValueToggleOutcome> {
	if (!account.publicValueEnabled) return { kind: "open-dialog" };
	await api.setAccountPublicValue(account.id, false);
	return { kind: "unpublished" };
}

export type PublicValueSaveOutcome =
	| { ok: true }
	| { ok: false; error: string };

/** Publishes with a label; a refusal is returned so the dialog stays open. */
export async function savePublicValue(
	account: { id: string },
	label: string,
	api: PublicValueApi,
	formatError: (err: unknown) => string,
): Promise<PublicValueSaveOutcome> {
	try {
		await api.setAccountPublicValue(account.id, true, label);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: formatError(err) };
	}
}
