import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { api } from "./api";

const descriptors = new Map(
	["fetch", "EventSource", "localStorage", "window"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
class Source extends EventTarget {
	static instances: Source[] = [];
	constructor(readonly url: string) {
		super();
		Source.instances.push(this);
	}
}
const fetchMock = mock(async (_url: unknown, _init?: RequestInit) =>
	Response.json({ token: "ephemeral/token+" }),
);
beforeEach(() => {
	const storage = new Map<string, string>();
	for (const [key, value] of [
		["fetch", fetchMock],
		["EventSource", Source],
		["window", new EventTarget()],
		[
			"localStorage",
			{
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
				removeItem: (key: string) => storage.delete(key),
			},
		],
	] as const)
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(Response.json({ token: "ephemeral/token+" }));
});
afterEach(() => {
	Source.instances = [];
	for (const [key, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
describe("authenticated EventSource factory", () => {
	for (const audience of ["logs", "requests"] as const) {
		it(`${audience}: sends the durable key only in the mint header`, async () => {
			api.setApiKey("durable-secret");
			const source = await api.createEventSource(audience);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`/api/${audience}/stream/token`);
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("x-api-key")).toBe(
				"durable-secret",
			);
			expect((source as unknown as Source).url).toBe(
				`/api/${audience}/stream?stream_token=ephemeral%2Ftoken%2B`,
			);
		});
		it(`${audience}: opens a bare endpoint without a stored key`, async () => {
			await api.createEventSource(audience);
			expect(Source.instances[0].url).toBe(`/api/${audience}/stream`);
			expect(fetchMock).not.toHaveBeenCalled();
		});
		it(`${audience}: rejects mint failure without opening an unauthenticated source`, async () => {
			api.setApiKey("durable-secret");
			fetchMock.mockResolvedValue(
				Response.json({ error: "Unauthorized" }, { status: 401 }),
			);
			await expect(api.createEventSource(audience)).rejects.toThrow();
			expect(Source.instances).toHaveLength(0);
		});
	}
	it("preserves Logs callback filtering", async () => {
		const onLog = mock(() => {});
		const source = await api.streamLogs(onLog);
		for (const data of [
			'{"type":"connected"}',
			"not-json",
			'{"ts":1,"level":"INFO","msg":"hello"}',
		]) {
			source.dispatchEvent(new MessageEvent("message", { data }));
		}
		expect(onLog).toHaveBeenCalledTimes(1);
		expect(onLog).toHaveBeenCalledWith({ ts: 1, level: "INFO", msg: "hello" });
	});
});
