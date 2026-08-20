const OFFICIAL_CODEX_MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> =
	[
		[/^gpt-5\.6-sol(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-sol"],
		[/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-terra"],
		[/^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.6-luna"],
		[/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.5"],
		[/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4-mini"],
		[/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.4"],
		[/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/, "gpt-5.3-codex"],
	];

/** Classify a physical Codex model without echoing private custom model names. */
export function classifyCodexModelFamily(
	model: string | null | undefined,
): string {
	if (!model) return "unknown";
	for (const [pattern, family] of OFFICIAL_CODEX_MODEL_FAMILIES) {
		if (pattern.test(model)) return family;
	}
	return "other_or_custom";
}
