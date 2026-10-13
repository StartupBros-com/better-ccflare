import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as reactQuery from "@tanstack/react-query";
import { api } from "../../api";
import { captureRequestUpdates } from "../useRequestStream";

const queryClient = new reactQuery.QueryClient();

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
type Options = reactQuery.FetchQueryOptions<{
	requests: { id: string }[];
	detailsMap: Map<string, unknown>;
}> & {
	refetchInterval?: false | number;
	refetchOnWindowFocus?: boolean;
};
const summary = (id: string) =>
	({
		id,
		timestamp: 1,
		statusCode: 200,
		success: true,
		inputTokens: 0,
		outputTokens: 0,
	}) as Awaited<ReturnType<typeof api.getRequestsSummary>>[number];
afterEach(() => {
	sequence = 0;
	queryClient.clear();
	mock.restore();
});

describe("SSE-backed query configuration", () => {
	it("explicitly disables global request/log polling and log focus refetches", () => {
		expect((useRequests(10) as unknown as Options).refetchInterval).toBe(false);
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
