import { beforeEach, describe, expect, it } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import {
	clearSession,
	getServedAccount,
	recordServedAccount,
	SessionAccountObserver,
} from "../session-account-observer";

/**
 * A controllable clock so TTL / eviction scenarios run without touching the
 * global `Date.now`, mirroring SessionAffinityStrategy's injectable bounds.
 */
function makeClock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (ms: number) => {
			now = ms;
		},
	};
}

describe("SessionAccountObserver", () => {
	it("records then gets the account id for a session (happy path)", () => {
		const obs = new SessionAccountObserver();
		obs.record("session-a", "acc-1");
		expect(obs.get("session-a")).toBe("acc-1");
	});

	it("overwrites on a second record for the same session (failover, R2)", () => {
		const obs = new SessionAccountObserver();
		obs.record("session-a", "acc-1");
		obs.record("session-a", "acc-2");
		expect(obs.get("session-a")).toBe("acc-2");
		expect(obs.size).toBe(1);
	});

	it("returns undefined for a session that was never recorded", () => {
		const obs = new SessionAccountObserver();
		expect(obs.get("missing")).toBeUndefined();
	});

	it("ignores an empty session id on record (no-header case, AE4)", () => {
		const obs = new SessionAccountObserver();
		obs.record("", "acc-1");
		expect(obs.size).toBe(0);
		expect(obs.get("")).toBeUndefined();
	});

	it("ignores an empty account id on record", () => {
		const obs = new SessionAccountObserver();
		obs.record("session-a", "");
		expect(obs.size).toBe(0);
		expect(obs.get("session-a")).toBeUndefined();
	});

	it("sweeps an entry older than the TTL on access", () => {
		const clock = makeClock();
		const ttlMs = 1_000;
		const obs = new SessionAccountObserver({ ttlMs, now: clock.now });
		obs.record("session-a", "acc-1");
		expect(obs.get("session-a")).toBe("acc-1");

		// Exactly at the TTL boundary the entry is considered expired.
		clock.advance(ttlMs);
		expect(obs.get("session-a")).toBeUndefined();
		expect(obs.size).toBe(0);
	});

	it("keeps an entry still within the TTL", () => {
		const clock = makeClock();
		const ttlMs = 1_000;
		const obs = new SessionAccountObserver({ ttlMs, now: clock.now });
		obs.record("session-a", "acc-1");
		clock.advance(ttlMs - 1);
		expect(obs.get("session-a")).toBe("acc-1");
	});

	it("evicts the oldest entry (not the newest) when at capacity", () => {
		const clock = makeClock();
		const obs = new SessionAccountObserver({
			maxEntries: 3,
			now: clock.now,
		});
		obs.record("s1", "acc-1");
		clock.advance(1);
		obs.record("s2", "acc-2");
		clock.advance(1);
		obs.record("s3", "acc-3");
		expect(obs.size).toBe(3);

		// Inserting a 4th at capacity evicts s1 (oldest), keeps s2/s3 and adds s4.
		clock.advance(1);
		obs.record("s4", "acc-4");
		expect(obs.size).toBe(3);
		expect(obs.get("s1")).toBeUndefined();
		expect(obs.get("s2")).toBe("acc-2");
		expect(obs.get("s3")).toBe("acc-3");
		expect(obs.get("s4")).toBe("acc-4");
	});

	it("does not evict when overwriting an existing key at capacity", () => {
		const clock = makeClock();
		const obs = new SessionAccountObserver({
			maxEntries: 2,
			now: clock.now,
		});
		obs.record("s1", "acc-1");
		clock.advance(1);
		obs.record("s2", "acc-2");
		expect(obs.size).toBe(2);

		// Re-recording an existing key must not evict a different session.
		clock.advance(1);
		obs.record("s1", "acc-1b");
		expect(obs.size).toBe(2);
		expect(obs.get("s1")).toBe("acc-1b");
		expect(obs.get("s2")).toBe("acc-2");

		// ...and the overwrite refreshed s1's recency, so the NEXT eviction round at
		// capacity drops s2 (the genuinely older entry), not the just-refreshed s1.
		clock.advance(1);
		obs.record("s3", "acc-3");
		expect(obs.size).toBe(2);
		expect(obs.get("s2")).toBeUndefined();
		expect(obs.get("s1")).toBe("acc-1b");
		expect(obs.get("s3")).toBe("acc-3");
	});

	it("does not let an older request's record or clear override a newer one", () => {
		const obs = new SessionAccountObserver();
		// A newer request (version 20) records acc-new.
		obs.record("s", "acc-new", 20);
		expect(obs.get("s")).toBe("acc-new");

		// An older request (version 10) completing late must NOT overwrite it.
		obs.record("s", "acc-old", 10);
		expect(obs.get("s")).toBe("acc-new");

		// ...and an older request's clear must NOT wipe the newer mapping.
		obs.clear("s", 10);
		expect(obs.get("s")).toBe("acc-new");

		// A same-or-newer clear does remove it.
		obs.clear("s", 20);
		expect(obs.get("s")).toBeUndefined();
	});

	it("clears an existing entry and is a no-op for an absent session", () => {
		const obs = new SessionAccountObserver();
		obs.record("session-a", "acc-1");
		obs.clear("session-a");
		expect(obs.get("session-a")).toBeUndefined();
		// Clearing an absent session id must not throw.
		expect(() => obs.clear("never-existed")).not.toThrow();
		expect(() => obs.clear("")).not.toThrow();
	});

	it("defaults the TTL to the Anthropic session duration", () => {
		const clock = makeClock();
		const obs = new SessionAccountObserver({ now: clock.now });
		obs.record("session-a", "acc-1");
		// Just under the 5h default is still live.
		clock.advance(TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT - 1);
		expect(obs.get("session-a")).toBe("acc-1");
		clock.advance(1);
		expect(obs.get("session-a")).toBeUndefined();
	});
});

describe("session-account-observer module singleton", () => {
	beforeEach(() => {
		// Keep the shared singleton clean between assertions.
		clearSession("mod-session");
	});

	it("records, reads, and clears through the exported functions", () => {
		recordServedAccount("mod-session", "acc-9");
		expect(getServedAccount("mod-session")).toBe("acc-9");
		clearSession("mod-session");
		expect(getServedAccount("mod-session")).toBeUndefined();
	});
});
