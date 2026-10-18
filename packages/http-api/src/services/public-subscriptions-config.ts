export interface PublicSubscriptionMapping {
	accountId: string;
	accountCreatedAt: number;
	id: string;
	label: string;
}

export type PublicSubscriptionsConfig =
	| { status: "disabled" }
	| { status: "invalid"; reason: string; index?: number }
	| { status: "enabled"; mappings: PublicSubscriptionMapping[] };

const invalid = (
	reason: string,
	index?: number,
): PublicSubscriptionsConfig => ({
	status: "invalid",
	reason,
	...(index === undefined ? {} : { index }),
});

/** Pure parser: never loads environment, account names, credentials, or files. */
export function parsePublicSubscriptionsConfig(
	raw: string | undefined,
): PublicSubscriptionsConfig {
	if (raw === undefined || raw === "") return { status: "disabled" };
	if (new TextEncoder().encode(raw).byteLength > 16 * 1024)
		return invalid("too_large");
	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch {
		return invalid("not_json");
	}
	if (!Array.isArray(entries)) return invalid("not_array");
	if (entries.length > 16) return invalid("too_many");
	for (const [index, entry] of entries.entries()) {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			Object.keys(entry).sort().join(",") !==
				"accountCreatedAt,accountId,id,label"
		)
			return invalid("bad_keys", index);
	}
	// Tokenize strings before punctuation so colons inside labels do not count.
	// Each allowed object has exactly four keys; JSON.parse alone drops duplicate keys.
	const keyCount = (raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? []).filter(
		(token) => token === ":",
	).length;
	if (keyCount !== entries.length * 4) return invalid("duplicate_key");
	const ids = new Set<string>();
	const accounts = new Set<string>();
	const mappings: PublicSubscriptionMapping[] = [];
	for (const [index, entry] of entries.entries()) {
		const { accountId, accountCreatedAt, id, label } = entry;
		if (
			typeof accountId !== "string" ||
			accountId.length === 0 ||
			accountId.trim() !== accountId ||
			/\p{Cc}/u.test(accountId)
		)
			return invalid("bad_account_id", index);
		if (!Number.isSafeInteger(accountCreatedAt) || accountCreatedAt < 0)
			return invalid("bad_account_created_at", index);
		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(id)
		)
			return invalid("bad_id", index);
		if (
			id.toLowerCase().includes(accountId.toLowerCase()) ||
			accountId.toLowerCase().includes(id.toLowerCase())
		)
			return invalid("id_overlaps_account_id", index);
		if (
			typeof label !== "string" ||
			Array.from(label).length < 1 ||
			Array.from(label).length > 80 ||
			label.trim() !== label ||
			/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)
		)
			return invalid("bad_label", index);
		if (ids.has(id)) return invalid("duplicate_id", index);
		if (accounts.has(accountId)) return invalid("duplicate_account_id", index);
		ids.add(id);
		accounts.add(accountId);
		mappings.push({ accountId, accountCreatedAt, id, label });
	}
	return { status: "enabled", mappings };
}
