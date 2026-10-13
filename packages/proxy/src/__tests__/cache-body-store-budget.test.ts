import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { cacheBodyStore, hasCacheControlHint } from "../cache-body-store";

const MiB = 1024 * 1024;
const headers = new Headers();
function stage(id: string, body: ArrayBuffer) {
	cacheBodyStore.stageRequest(
		id,
		id,
		body,
		headers,
		"/v1/messages",
		body,
		true,
	);
}
function stagedBytes() {
	return (cacheBodyStore as unknown as { stagingBytes: number }).stagingBytes;
}
beforeEach(() => {
	cacheBodyStore.setEnabled(false);
	cacheBodyStore.setEnabled(true);
});
afterEach(() => {
	mock.restore();
	cacheBodyStore.setEnabled(false);
});

describe("cache body staging byte budget", () => {
	it("evicts the oldest body when aggregate staging would exceed 64 MiB", () => {
		const body = new ArrayBuffer(24 * MiB);
		stage("a", body);
		stage("b", body);
		stage("c", body);
		for (const id of ["a", "b", "c"]) cacheBodyStore.onSummary(id, 1);
		expect(cacheBodyStore.getLastCachedRequest("a")).toBeNull();
		expect(cacheBodyStore.getLastCachedRequest("b")?.body.byteLength).toBe(
			body.byteLength,
		);
		expect(cacheBodyStore.getLastCachedRequest("c")?.body.byteLength).toBe(
			body.byteLength,
		);
	});
	it("rejects an oversized replacement after clearing its stale predecessor, without evicting useful entries", () => {
		stage("keep", new ArrayBuffer(5));
		stage("replace", new ArrayBuffer(5));
		stage("replace", new ArrayBuffer(64 * MiB + 1));
		cacheBodyStore.onSummary("replace", 1);
		cacheBodyStore.onSummary("keep", 1);
		expect(cacheBodyStore.getLastCachedRequest("replace")).toBeNull();
		expect(cacheBodyStore.getLastCachedRequest("keep")?.body.byteLength).toBe(
			5,
		);
	});
	it("balances replacement, rejection, discard, promotion, expiry and disable accounting", () => {
		let now = Date.now();
		spyOn(Date, "now").mockImplementation(() => now);
		stage("a", new ArrayBuffer(10));
		stage("a", new ArrayBuffer(20));
		expect(stagedBytes()).toBe(20);
		cacheBodyStore.stageRequest("a", "a", null, headers, "/v1/messages");
		expect(stagedBytes()).toBe(0);
		stage("a", new ArrayBuffer(10));
		cacheBodyStore.discardStaged("a");
		expect(stagedBytes()).toBe(0);
		stage("a", new ArrayBuffer(10));
		cacheBodyStore.onSummary("a", 1);
		expect(stagedBytes()).toBe(0);
		stage("b", new ArrayBuffer(10));
		now += 5 * 60 * 1000 + 1;
		cacheBodyStore.sweepStagingByAge();
		expect(stagedBytes()).toBe(0);
		stage("c", new ArrayBuffer(10));
		cacheBodyStore.setEnabled(false);
		expect(stagedBytes()).toBe(0);
	});
	it("preserves exact marker matching across non-ASCII prefixes and near misses", () => {
		const encode = (text: string) =>
			new TextEncoder().encode(text).buffer as ArrayBuffer;
		expect(hasCacheControlHint(encode('😀 "cache_control"'))).toBe(true);
		expect(hasCacheControlHint(encode('"cache-control"'))).toBe(true);
		expect(
			hasCacheControlHint(encode('cache_control "cache_controlled"')),
		).toBe(false);
		expect(hasCacheControlHint(new ArrayBuffer(0))).toBe(false);
	});
});
