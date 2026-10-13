import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
	spyOn,
} from "bun:test";
import * as reactQuery from "@tanstack/react-query";
import { api } from "../../api";
import { REFRESH_INTERVALS } from "../../constants";
import { captureRequestUpdates } from "../useRequestStream";

const queryClient = new reactQuery.QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchInterval: REFRESH_INTERVALS.default },
	},
});
const cleanups: Array<() => void> = [];
const originalIsServer = reactQuery.environmentManager.isServer();

let sequence = 0;
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useQuery: (options: unknown) => options,
}));
mock.module("../useRequestStream", () => ({
	getRequestsSseSeq: () => sequence,
	captureRequestUpdates,
}));
const { useRequests, useLogHistory } = await import("../queries");
type Options = reactQuery.QueryObserverOptions<{
	requests: { id: string }[];
	detailsMap: Map<string, unknown>;
}>;
const summary = (id: string) =>
	({
		id,
		timestamp: 1,
		statusCode: 200,
		success: true,
		inputTokens: 0,
		outputTokens: 0,
	}) as Awaited<ReturnType<typeof api.getRequestsSummary>>[number];
beforeEach(() => {
	spyOn(api, "hasApiKey").mockReturnValue(false);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	sequence = 0;
	queryClient.clear();
	jest.useRealTimers();
	reactQuery.environmentManager.setIsServer(() => originalIsServer);
	reactQuery.focusManager.setFocused(undefined);
	mock.restore();
});

describe("SSE-backed query configuration", () => {
	it("disables global request polling without a key and preserves the log policy", () => {
		expect((useRequests(10) as unknown as Options).refetchInterval).toBe(false);
		const logs = useLogHistory() as unknown as Options;
		expect(logs.refetchInterval).toBe(false);
		expect(logs.refetchOnWindowFocus).toBe(false);
	});
	it("uses the shared polling fallback only when an API key is present", () => {
		spyOn(api, "hasApiKey").mockReturnValue(true);
		const requests = useRequests(10) as unknown as Options;
		expect(requests.refetchInterval).toBe(REFRESH_INTERVALS.default);
		expect(requests.staleTime).toBe(Infinity);
		const logs = useLogHistory() as unknown as Options;
		expect(logs.refetchInterval).toBe(false);
		expect(logs.refetchOnWindowFocus).toBe(false);
	});
	it("refetches a snapshot when SSE arrived while it was being fetched", async () => {
		let calls = 0;
		const fetch = spyOn(api, "getRequestsSummary").mockImplementation(
			async () => {
				calls++;
				if (calls === 1) sequence++;
				return [summary(calls === 1 ? "stale" : "fresh")];
			},
		);
		const result = await queryClient.fetchQuery({
			...(useRequests(10) as unknown as Options),
			staleTime: 0,
			retry: false,
		});
		expect(result.requests.map((request) => request.id)).toEqual(["fresh"]);
		expect([...result.detailsMap.keys()]).toEqual(["fresh"]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("bounds continuously overlapping snapshot fetches at three attempts", async () => {
		let calls = 0;
		spyOn(api, "getRequestsSummary").mockImplementation(async () => {
			sequence++;
			return [summary(String(++calls))];
		});
		const result = await queryClient.fetchQuery({
			...(useRequests(10) as unknown as Options),
			staleTime: 0,
			retry: false,
		});
		expect(calls).toBe(3);
		expect(result.requests[0].id).toBe("3");
	});
	it("fetches once without events and propagates fetch errors", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([
			summary("one"),
		]);
		await queryClient.fetchQuery({
			...(useRequests(10) as unknown as Options),
			staleTime: 0,
			retry: false,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockRejectedValue(new Error("offline"));
		await expect(
			queryClient.fetchQuery({
				...(useRequests(10) as unknown as Options),
				staleTime: 0,
				retry: false,
			}),
		).rejects.toThrow("offline");
	});
});

async function flush() {
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}
async function advance(milliseconds: number) {
	jest.advanceTimersByTime(milliseconds);
	await flush();
}
function RequestsQueryTestComponent() {
	return useRequests(10) as unknown as Options;
}
function observeRequests() {
	const observer = new reactQuery.QueryObserver(
		queryClient,
		RequestsQueryTestComponent(),
	);
	const unsubscribe = observer.subscribe(() => {});
	cleanups.push(unsubscribe);
	return observer;
}

describe("Requests polling fallback with real QueryObserver", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		// QueryObserver intentionally skips interval timers in a server runtime.
		reactQuery.environmentManager.setIsServer(() => false);
		reactQuery.focusManager.setFocused(true);
	});

	it("repeatedly fetches fresh authenticated snapshots while SSE delivers nothing", async () => {
		spyOn(api, "hasApiKey").mockReturnValue(true);
		let calls = 0;
		const fetch = spyOn(api, "getRequestsSummary").mockImplementation(
			async () => [summary(`snapshot-${++calls}`)],
		);
		const observer = observeRequests();
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);
		await advance(REFRESH_INTERVALS.default - 1);
		expect(fetch).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(observer.getCurrentResult().data?.requests[0].id).toBe("snapshot-2");
		await advance(REFRESH_INTERVALS.default);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(observer.getCurrentResult().data?.requests[0].id).toBe("snapshot-3");
		expect(sequence).toBe(0);
	});

	it("keeps no-key requests off global polling over multiple intervals", async () => {
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([
			summary("sse-only"),
		]);
		observeRequests();
		await flush();
		await advance(REFRESH_INTERVALS.default);
		await advance(REFRESH_INTERVALS.default);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("starts and stops fallback polling after credential-presence rerenders", async () => {
		const hasApiKey = spyOn(api, "hasApiKey").mockReturnValue(false);
		const fetch = spyOn(api, "getRequestsSummary").mockResolvedValue([]);
		const observer = observeRequests();
		await flush();
		await advance(REFRESH_INTERVALS.default);
		expect(fetch).toHaveBeenCalledTimes(1);
		hasApiKey.mockReturnValue(true);
		observer.setOptions(useRequests(10) as unknown as Options);
		await advance(REFRESH_INTERVALS.default);
		expect(fetch).toHaveBeenCalledTimes(2);
		hasApiKey.mockReturnValue(false);
		observer.setOptions(useRequests(10) as unknown as Options);
		await advance(REFRESH_INTERVALS.default);
		await advance(REFRESH_INTERVALS.default);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
