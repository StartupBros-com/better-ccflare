export interface CodexCustomToolCall {
	type: "custom_tool_call";
	call_id: string;
	name: string;
	namespace?: string;
	input: string;
	status?: "in_progress" | "completed" | "incomplete";
}

export interface CodexCustomToolOutput {
	type: "custom_tool_call_output";
	call_id: string;
	output: string;
	status?: "in_progress" | "completed" | "incomplete";
}

export type NativeToolChoice =
	| "auto"
	| "required"
	| "none"
	| { type: "function" | "custom"; name: string; namespace?: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Keep the provider's current-tool policy when restoring native declarations. */
export function filterNativeTools(
	tools: unknown[],
	filteredNames: readonly string[],
): unknown[] {
	return tools.filter((tool) => {
		const value = record(tool);
		return (
			!value ||
			value.type === "namespace" ||
			value.namespace !== undefined ||
			!filteredNames.includes(String(value.name))
		);
	});
}

export function nativeToolChoice(
	choice: unknown,
	filteredNames: readonly string[],
): NativeToolChoice | undefined {
	if (choice === "auto" || choice === "required" || choice === "none")
		return choice;
	const value = record(choice);
	if (
		!value ||
		(value.type !== "function" && value.type !== "custom") ||
		typeof value.name !== "string" ||
		!value.name ||
		(value.namespace !== undefined &&
			(typeof value.namespace !== "string" || !value.namespace))
	)
		return undefined;
	if (value.namespace === undefined && filteredNames.includes(value.name))
		return undefined;
	return {
		type: value.type,
		name: value.name,
		...(typeof value.namespace === "string"
			? { namespace: value.namespace }
			: {}),
	};
}

/**
 * Restore only identities of calls/results the adapter actually emitted. Arguments,
 * results, ordering, IDs and elision still come from ordinary provider conversion.
 * Call before continuation ownership/digests inspect the final native input.
 */
export function restoreNativeToolReplay(
	input: unknown[],
	metadata: unknown,
): void {
	const replay = record(metadata);
	if (!replay) return;
	const calls = new Map<string, Record<string, unknown>>();
	if (Array.isArray(replay.calls)) {
		for (const item of replay.calls) {
			const value = record(item);
			if (
				value &&
				typeof value.call_id === "string" &&
				typeof value.bridge_name === "string" &&
				typeof value.name === "string" &&
				(value.type === "function" || value.type === "custom") &&
				(value.namespace === undefined || typeof value.namespace === "string")
			)
				calls.set(value.call_id, value);
		}
	}
	const customOutputs = new Set(
		Array.isArray(replay.custom_output_ids)
			? replay.custom_output_ids.filter(
					(id): id is string => typeof id === "string",
				)
			: [],
	);
	for (const item of input) {
		const value = record(item);
		if (!value || typeof value.call_id !== "string") continue;
		if (
			value.type === "function_call_output" &&
			customOutputs.has(value.call_id)
		)
			value.type = "custom_tool_call_output";
		if (value.type !== "function_call") continue;
		const identity = calls.get(value.call_id);
		if (!identity || identity.bridge_name !== value.name) continue;
		if (identity.type === "custom") {
			if (typeof value.arguments !== "string") continue;
			let args: Record<string, unknown> | undefined;
			try {
				args = record(JSON.parse(value.arguments));
			} catch {
				continue;
			}
			if (typeof args?.input !== "string") continue;
			value.type = "custom_tool_call";
			value.input = args.input;
			delete value.arguments;
		}
		value.name = identity.name;
		if (identity.namespace !== undefined) value.namespace = identity.namespace;
	}
}
