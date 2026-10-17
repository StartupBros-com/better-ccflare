export interface PublicSubscriptionMapping {
	accountId: string;
	accountCreatedAt: number;
	id: string;
	label: string;
}

export type PublicSubscriptionsConfig =
	| { status: "disabled" }
	| { status: "invalid" }
	| { status: "enabled"; mappings: PublicSubscriptionMapping[] };

const hasControlCharacters = (value: string): boolean =>
	Array.from(value).some(
		(character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
	);

/** Pure parser: never loads environment, account names, credentials, or files. */
export function parsePublicSubscriptionsConfig(
	raw: string | undefined,
): PublicSubscriptionsConfig {
	if (raw === undefined || raw === "") return { status: "disabled" };
	if (new TextEncoder().encode(raw).byteLength > 16 * 1024)
		return { status: "invalid" };
	try {
		const entries: unknown = JSON.parse(raw);
		if (!Array.isArray(entries) || entries.length > 16)
			return { status: "invalid" };
		// Tokenize strings before punctuation so colons inside labels do not count.
		// Each allowed object has exactly four keys; JSON.parse alone drops duplicate keys.
		const keyCount = (raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? []).filter(
			(token) => token === ":",
		).length;
		if (keyCount !== entries.length * 4) return { status: "invalid" };
		const ids = new Set<string>();
		const accounts = new Set<string>();
		const mappings: PublicSubscriptionMapping[] = [];
		for (const entry of entries) {
			if (
				!entry ||
				typeof entry !== "object" ||
				Array.isArray(entry) ||
				Object.keys(entry).sort().join(",") !==
					"accountCreatedAt,accountId,id,label"
			)
				return { status: "invalid" };
			const { accountId, accountCreatedAt, id, label } = entry;
			if (
				typeof accountId !== "string" ||
				accountId.length === 0 ||
				accountId.trim() !== accountId ||
				hasControlCharacters(accountId) ||
				!Number.isSafeInteger(accountCreatedAt) ||
				accountCreatedAt < 0 ||
				typeof id !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(id) ||
				id === accountId ||
				typeof label !== "string" ||
				label.length < 1 ||
				label.length > 80 ||
				label.trim() !== label ||
				/[<>]/.test(label) ||
				hasControlCharacters(label) ||
				ids.has(id) ||
				accounts.has(accountId)
			)
				return { status: "invalid" };
			ids.add(id);
			accounts.add(accountId);
			mappings.push({ accountId, accountCreatedAt, id, label });
		}
		return { status: "enabled", mappings };
	} catch {
		return { status: "invalid" };
	}
}
