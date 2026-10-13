import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as React from "react";
import type { RequestPayload, RequestSummary } from "../api";
import * as queries from "../hooks/queries";

let hooks: unknown[] = [];
let cursor = 0;
let onSummary: ((summary: RequestSummary) => void) | undefined;
let data: {
	requests: RequestPayload[];
	detailsMap: Map<string, RequestSummary>;
};
mock.module("react", () => ({
	...React,
	useMemo: <T,>(create: () => T) => create(),
	useRef: <T,>(initial: T) => {
		const index = cursor++;
		if (!(index in hooks)) hooks[index] = { current: initial };
		return hooks[index];
	},
	useState: <T,>(initial: T) => {
		const index = cursor++;
		if (!(index in hooks)) hooks[index] = initial;
		return [
			hooks[index],
			(next: T) => {
				hooks[index] = next;
			},
		];
	},
}));
mock.module("../hooks/queries", () => ({
	...queries,
	useRequests: () => ({
		data,
		isLoading: false,
		error: null,
		refetch: () => {},
	}),
	useAccounts: () => ({ data: [] }),
	useApiKeys: () => ({ data: [] }),
}));
mock.module("../hooks/useRequestStream", () => ({
	useRequestStream: (
		_limit: number,
		listener?: (summary: RequestSummary) => void,
	) => {
		onSummary = listener;
	},
}));
function Modal() {
	return null;
}
mock.module("./RequestDetailsModal", () => ({ RequestDetailsModal: Modal }));
const { RequestsTab } = await import("./RequestsTab");
type Element = React.ReactElement<Record<string, unknown>>;
function find(
	node: unknown,
	predicate: (element: Element) => boolean,
): Element | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = find(child, predicate);
			if (found) return found;
		}
		return;
	}
	if (!React.isValidElement(node)) return;
	const element = node as Element;
	if (predicate(element)) return element;
	return find(element.props.children, predicate);
}
function render() {
	cursor = 0;
	return RequestsTab();
}
function request(id: string): RequestPayload {
	return {
		id,
		request: { headers: {}, body: null },
		response: null,
		meta: {
			timestamp: 1,
			path: "/v1/messages",
			method: "POST",
			pending: true,
			bodiesOmitted: true,
		},
	} as RequestPayload;
}
function summary(id: string, statusCode: number): RequestSummary {
	return {
		id,
		timestamp: new Date(1).toISOString(),
		model: "test-model",
		statusCode,
		success: statusCode === 200,
		inputTokens: 1,
		outputTokens: 2,
	} as RequestSummary;
}
function select() {
	const button = find(
		render(),
		(element) => element.props.title === "View Details",
	);
	expect(button).toBeDefined();
	if (!button) throw new Error("Details button is missing");
	(button.props.onClick as () => void)();
}
function modal() {
	const element = find(render(), (element) => element.type === Modal);
	if (!element) throw new Error("Details modal is missing");
	return element;
}

beforeEach(() => {
	hooks = [];
	cursor = 0;
	data = {
		requests: [request("first")],
		detailsMap: new Map([["first", summary("first", 0)]]),
	};
});

describe("RequestsTab SSE modal retention", () => {
	it("completes an open pending modal after 50 newer starts evict its row", () => {
		select();
		modal();
		data = {
			requests: Array.from({ length: 50 }, (_, index) =>
				request(`newer-${index}`),
			),
			detailsMap: new Map(),
		};
		expect((modal().props.request as RequestPayload).meta.pending).toBe(true);
		const latest = {
			...summary("first", 429),
			rateLimited: true,
			errorMessage: "rate limited",
			agentUsed: "reviewer",
			agentAttributionSource: "header_agent" as const,
			inputTokens: 21,
			outputTokens: 13,
			costUsd: 0.04,
		};
		onSummary?.(latest);
		expect(modal().props.summary).toBe(latest);
		expect(modal().props.request).toMatchObject({
			id: "first",
			response: { status: 429 },
			error: "rate limited",
			meta: {
				pending: false,
				rateLimited: true,
				bodiesOmitted: true,
				agentUsed: "reviewer",
				agentAttributionSource: "header_agent",
			},
		});
		expect(data.requests).toHaveLength(50);
		expect(data.detailsMap.size).toBe(0);
	});
	it("ignores late completions immediately after close and selection change", () => {
		select();
		const selected = modal();
		(selected.props.onClose as () => void)();
		onSummary?.(summary("first", 429));
		expect(find(render(), (element) => element.type === Modal)).toBeUndefined();
		data = { requests: [request("second")], detailsMap: new Map() };
		select();
		onSummary?.(summary("first", 500));
		expect((modal().props.request as RequestPayload).id).toBe("second");
		expect(modal().props.summary).toBeUndefined();
	});
	it("retains the last live payload and summary after bounded-list eviction", () => {
		select();
		expect((modal().props.summary as RequestSummary).id).toBe("first");
		const completed = {
			...request("first"),
			response: { status: 200, headers: {}, body: null },
			meta: { ...request("first").meta, pending: false },
		};
		const latest = summary("first", 200);
		data = { requests: [completed], detailsMap: new Map([["first", latest]]) };
		expect(modal().props.request).toBe(completed);
		expect(modal().props.summary).toBe(latest);
		data = {
			requests: [request("second")],
			detailsMap: new Map([["second", summary("second", 0)]]),
		};
		expect(modal().props.summary).toBe(latest);
		expect((modal().props.request as RequestPayload).meta.pending).toBe(false);
		expect(modal().props.request).toBe(completed);

		const refreshed = {
			...completed,
			meta: { ...completed.meta, accountName: "refreshed-account" },
		};
		data = { requests: [refreshed], detailsMap: new Map() };
		expect(modal().props.request).toBe(refreshed);
		expect(modal().props.summary).toBe(latest);
		data = { requests: [], detailsMap: new Map() };
		expect(modal().props.request).toBe(refreshed);
	});
	it("never carries an evicted summary into a different request's modal", () => {
		select();
		modal();
		(modal().props.onClose as () => void)();
		render();
		data = { requests: [request("second")], detailsMap: new Map() };
		select();
		expect(modal().props.summary).toBeUndefined();
		expect((modal().props.request as RequestPayload).id).toBe("second");
	});
	it("discards retained payload and summary when changing the selected request", () => {
		select();
		modal();
		const second = request("second");
		data = { requests: [second], detailsMap: new Map() };
		select();
		expect(modal().props.request).toBe(second);
		expect(modal().props.summary).toBeUndefined();
		data = { requests: [], detailsMap: new Map() };
		expect(modal().props.request).toBe(second);
		expect(modal().props.summary).toBeUndefined();
	});
	it("clears retained data on close before reopening the same request ID", () => {
		select();
		const completed = {
			...request("first"),
			meta: { ...request("first").meta, pending: false },
		};
		data = {
			requests: [completed],
			detailsMap: new Map([["first", summary("first", 200)]]),
		};
		expect(modal().props.request).toBe(completed);
		(modal().props.onClose as () => void)();
		render();
		const reopened = request("first");
		data = { requests: [reopened], detailsMap: new Map() };
		select();
		data = { requests: [], detailsMap: new Map() };
		expect(modal().props.request).toBe(reopened);
		expect(modal().props.summary).toBeUndefined();
	});
});
