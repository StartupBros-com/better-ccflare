import { describe, expect, mock, test } from "bun:test";

import { deriveServerToolRequirement } from "../../providers/src/server-tool-capabilities";

// RequestBodyContext imports the providers facade, whose production side effects
// are outside this lifecycle unit test. Keep only the pure classifier seam here.
mock.module("@better-ccflare/providers", () => ({
	deriveServerToolRequirement,
}));

const { RequestBodyContext } = await import("./request-body-context");

function encodeBody(body: Record<string, unknown>): ArrayBuffer {
	const encoded = new TextEncoder().encode(JSON.stringify(body));
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

function assertPresent<T>(value: T | null | undefined): asserts value is T {
	if (value === null || value === undefined) {
		throw new Error("Expected value to be present");
	}
}

function countIterations<T>(
	values: T[],
	visits: Record<string, number>,
	key: string,
): T[] {
	return new Proxy(values, {
		get(target, property, receiver) {
			if (property === Symbol.iterator) {
				return function* countedIterator() {
					visits[key] = (visits[key] ?? 0) + 1;
					yield* target;
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

type MutableSemanticBody = Record<string, unknown> & {
	model: string;
	tools: Array<Record<string, unknown>>;
	messages: Array<{
		role: string;
		content: Array<Record<string, unknown>>;
	}>;
	tool_choice: Record<string, unknown>;
};

function makeMutableSemanticBody(): MutableSemanticBody {
	return {
		model: "stable-model",
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 2,
				allowed_domains: ["example.com/docs"],
			},
		],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "original message" }],
			},
		],
		tool_choice: { type: "auto" },
	};
}

describe("RequestBodyContext server-tool finalization", () => {
	test("derives from the current parsed body rather than the original buffer", () => {
		const context = new RequestBodyContext(
			encodeBody({
				model: "original-model",
				tools: [{ name: "ordinary", input_schema: { type: "object" } }],
			}),
		);

		expect(context.getParsedJson()).not.toBeNull();
		expect(
			context.mutateParsedJson((body) => {
				body.tools = [
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 2,
						allowed_domains: ["example.com/docs"],
					},
				];
			}),
		).toBe(true);

		const requirements = context.finalizeServerToolRequirements();

		expect(requirements).toMatchObject({
			revision: 2,
			declarations: [
				{
					type: "web_search_20250305",
					maxUses: 2,
					allowedDomains: ["example.com/docs"],
				},
			],
			replay: { input: [], output: [], requiresOutputReplay: true },
		});
	});

	test("returns the same frozen requirement identity on repeated finalization", () => {
		const context = new RequestBodyContext(
			encodeBody({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
		);

		const first = context.finalizeServerToolRequirements();
		const second = context.finalizeServerToolRequirements();

		expect(second).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.declarations)).toBe(true);
	});

	test("derives and protects tools and history in one traversal", () => {
		const visits: Record<string, number> = {};
		const citations = countIterations(
			[
				{
					type: "web_search_result_location",
					encrypted_index: "bccf1.A256GCM.proxy-envelope",
				},
			],
			visits,
			"citations",
		);
		const resultContent = countIterations(
			[
				{
					type: "web_search_result",
					encrypted_content: "bccf1.A256GCM.proxy-envelope",
				},
			],
			visits,
			"resultContent",
		);
		const messageContent = countIterations(
			[
				{
					type: "web_search_tool_result",
					content: resultContent,
				},
				{ type: "text", text: "cited answer", citations },
			],
			visits,
			"messageContent",
		);
		const body = {
			tools: countIterations(
				[{ type: "web_search_20250305", name: "web_search" }],
				visits,
				"tools",
			),
			messages: countIterations(
				[{ role: "assistant", content: messageContent }],
				visits,
				"messages",
			),
		};
		const context = RequestBodyContext.fromParsed(null, body);

		expect(context.finalizeServerToolRequirements()?.replay.output).toEqual([
			"proxy-evidence-v1",
		]);
		expect(visits).toEqual({
			tools: 1,
			messages: 1,
			messageContent: 1,
			resultContent: 1,
			citations: 1,
		});
		expect(Object.isFrozen(body)).toBe(true);
		expect(Object.isFrozen(body.tools)).toBe(true);
		expect(Object.isFrozen(body.messages)).toBe(true);
		expect(Object.isFrozen(messageContent)).toBe(true);
		expect(Object.isFrozen(resultContent)).toBe(true);
		expect(Object.isFrozen(resultContent[0])).toBe(true);
		expect(Object.isFrozen(citations)).toBe(true);
		expect(Object.isFrozen(citations[0])).toBe(true);
	});

	test("rejects every mutation entry point before stale metadata can be created", () => {
		const context = new RequestBodyContext(
			encodeBody({
				model: "stable-model",
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
		);
		context.finalizeServerToolRequirements();
		const before = JSON.stringify(context.getParsedJson());
		let mutationCallbackRan = false;

		expect(() => context.setModel("mutated-model")).toThrow();
		expect(() =>
			context.mutateParsedJson((body) => {
				mutationCallbackRan = true;
				body.model = "mutated-model";
			}),
		).toThrow();
		expect(() => context.markDirty()).toThrow();

		expect(mutationCallbackRan).toBe(false);
		expect(context.isDirty).toBe(false);
		expect(JSON.stringify(context.getParsedJson())).toBe(before);
	});

	const aliasMutationCases: Array<{
		name: string;
		mutate: (body: MutableSemanticBody) => void;
	}> = [
		{
			name: "top-level tools replacement",
			mutate: (body) => {
				body.tools = [{ name: "replacement", input_schema: {} }];
			},
		},
		{
			name: "nested tool mutation",
			mutate: (body) => {
				const tool = body.tools[0];
				assertPresent(tool);
				tool.max_uses = 8;
			},
		},
		{
			name: "top-level messages replacement",
			mutate: (body) => {
				body.messages = [
					{ role: "assistant", content: [{ type: "text", text: "changed" }] },
				];
			},
		},
		{
			name: "nested message mutation",
			mutate: (body) => {
				const message = body.messages[0];
				assertPresent(message);
				const content = message.content[0];
				assertPresent(content);
				content.text = "changed";
			},
		},
		{
			name: "top-level tool choice replacement",
			mutate: (body) => {
				body.tool_choice = { type: "tool", name: "web_search" };
			},
		},
		{
			name: "nested tool choice mutation",
			mutate: (body) => {
				body.tool_choice.type = "tool";
			},
		},
	];

	for (const aliasCase of aliasMutationCases) {
		test(`rejects retained fromParsed alias ${aliasCase.name}`, () => {
			const retainedBody = makeMutableSemanticBody();
			const context = RequestBodyContext.fromParsed(null, retainedBody);
			const requirements = context.finalizeServerToolRequirements();
			const bodyBefore = JSON.stringify(context.getParsedJson());
			const requirementsBefore = JSON.stringify(requirements);

			expect(() => aliasCase.mutate(retainedBody)).toThrow();
			expect(JSON.stringify(context.getParsedJson())).toBe(bodyBefore);
			expect(context.finalizeServerToolRequirements()).toBe(requirements);
			expect(JSON.stringify(requirements)).toBe(requirementsBefore);
		});
	}

	test("keeps shared child semantics frozen while allowing child top-level replacement", () => {
		const retainedBody = makeMutableSemanticBody();
		const parent = RequestBodyContext.fromParsed(null, retainedBody);
		const parentRequirements = parent.finalizeServerToolRequirements();
		const parentBody = parent.getParsedJson() as MutableSemanticBody;
		const child = parent.withPatchedModel("child-model");
		expect(child).not.toBeNull();
		assertPresent(child);
		const childBody = child.getParsedJson() as MutableSemanticBody;

		expect(childBody.tools).toBe(parentBody.tools);
		expect(childBody.messages).toBe(parentBody.messages);
		const childTool = childBody.tools[0];
		assertPresent(childTool);
		expect(() => {
			childTool.max_uses = 8;
		}).toThrow();
		const childMessage = childBody.messages[0];
		assertPresent(childMessage);
		const childContent = childMessage.content[0];
		assertPresent(childContent);
		expect(() => {
			childContent.text = "changed";
		}).toThrow();

		expect(
			child.mutateParsedJson((body) => {
				body.tools = [{ name: "child-only", input_schema: {} }];
			}),
		).toBe(true);
		expect(child.getParsedJson()?.tools).toEqual([
			{ name: "child-only", input_schema: {} },
		]);
		expect(parent.getParsedJson()?.tools).toBe(parentBody.tools);
		expect(parent.finalizeServerToolRequirements()).toBe(parentRequirements);
	});
});
