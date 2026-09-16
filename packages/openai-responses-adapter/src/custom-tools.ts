import { createHash } from "node:crypto";
import type {
	ResponsesRequest,
	ResponsesTool,
	ResponsesToolChoice,
} from "./types";

/** Shape validation shared by admission and direct translation; never coerces identity. */
export function isNamedToolChoice(
	value: unknown,
): value is ResponsesToolChoice {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const choice = value as Record<string, unknown>;
	return (
		(choice.type === "function" || choice.type === "custom") &&
		typeof choice.name === "string" &&
		choice.name.length > 0 &&
		(choice.namespace === undefined ||
			(typeof choice.namespace === "string" && choice.namespace.length > 0))
	);
}

/** Collect Responses Lite tool declarations without changing native input. */
export function getRequestTools(
	req: Pick<ResponsesRequest, "tools" | "input">,
): ResponsesTool[] {
	const declarations: ResponsesTool[] = [];
	if (Array.isArray(req.input)) {
		for (const item of req.input) {
			if (
				item &&
				item.type === "additional_tools" &&
				Array.isArray(item.tools)
			) {
				declarations.push(
					...item.tools.filter(
						(tool) =>
							tool &&
							(tool.type === "function" ||
								tool.type === "custom" ||
								tool.type === "namespace"),
					),
				);
			}
		}
	}
	if (Array.isArray(req.tools)) declarations.push(...req.tools);
	return flattenTools(declarations);
}

function flattenTools(tools: ResponsesTool[]): ResponsesTool[] {
	const result = new Map<string, ResponsesTool>();
	const visit = (
		declarations: ResponsesTool[],
		namespace?: string,
		description?: string,
		depth = 0,
	): void => {
		if (depth > 64) throw new Error("Tool namespace nesting exceeds the limit");
		for (const tool of declarations) {
			if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
				result.set(`malformed_${result.size}`, tool);
				continue;
			}
			if (tool.type === "namespace") {
				if (!Array.isArray(tool.tools)) continue;
				visit(
					tool.tools,
					namespace ? `${namespace}.${tool.name}` : tool.name,
					[description, tool.description].filter(Boolean).join("\n\n"),
					depth + 1,
				);
			} else if (tool.type === "function" || tool.type === "custom") {
				const effectiveNamespace = namespace ?? tool.namespace;
				const effectiveTool = effectiveNamespace
					? {
							...tool,
							namespace: effectiveNamespace,
							description: [description, tool.description]
								.filter(Boolean)
								.join("\n\n"),
						}
					: tool;
				result.set(
					JSON.stringify([effectiveNamespace, tool.name]),
					effectiveTool,
				);
			} else {
				result.set(JSON.stringify([namespace, tool.type]), tool);
			}
		}
	};
	visit(tools);
	return [...result.values()];
}

/** Anthropic names are flat and limited to 64 ASCII identifier characters. */
export function getTranslatedToolName(
	name: string,
	namespace?: string,
): string {
	if (!namespace) return name;
	const digest = createHash("sha256")
		.update(JSON.stringify([namespace, name]))
		.digest("hex")
		.slice(0, 24);
	return `ns_${digest}_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36)}`;
}

export function getResponseToolIdentity(
	name: string,
	tools: ResponsesTool[] = [],
): { name: string; namespace?: string } {
	for (const tool of flattenTools(tools)) {
		if (
			(tool.type === "function" || tool.type === "custom") &&
			getTranslatedToolName(tool.name, tool.namespace) === name
		) {
			return tool.namespace
				? { name: tool.name, namespace: tool.namespace }
				: { name: tool.name };
		}
	}
	return { name };
}

export function getCustomToolNames(tools: ResponsesTool[] = []): Set<string> {
	return new Set(
		flattenTools(tools)
			.filter((tool) => tool.type === "custom")
			.map((tool) => getTranslatedToolName(tool.name, tool.namespace)),
	);
}

/** Unwrap the JSON schema bridge without changing the tool's raw text. */
export function unwrapCustomToolInput(input: unknown): string {
	if (
		input !== null &&
		typeof input === "object" &&
		"input" in input &&
		typeof input.input === "string"
	) {
		return input.input;
	}
	throw new Error("Upstream custom tool call did not contain a text input");
}
