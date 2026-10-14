import type { AgentAttributionSource } from "@better-ccflare/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
	type Account,
	api,
	type RequestPayload,
	type RequestResponse,
} from "../api";
import { queryKeys } from "../lib/query-keys";

interface RequestsData {
	requests: RequestPayload[];
	detailsMap: Map<string, RequestResponse> | RequestResponse[];
}

interface StreamSubscriber {
	queryClient: QueryClient;
	handleMessage: (event: MessageEvent) => void;
}

interface PooledConnection {
	subscribers: Set<StreamSubscriber>;
	connect: () => void;
	dispose: () => void;
}

interface RequestSnapshotUpdate {
	id: string;
	timestamp: number;
	sequence: number;
	request?: RequestPayload;
	summary?: RequestResponse;
}

const SNAPSHOT_LISTENERS = new WeakMap<
	QueryClient,
	Map<number, Set<(update: RequestSnapshotUpdate) => void>>
>();

// Keep only the newest visible requests while a snapshot is in flight. Summaries
// are captured even without a cached row (including the initial empty cache).
export function captureRequestUpdates(queryClient: QueryClient, limit: number) {
	let byLimit = SNAPSHOT_LISTENERS.get(queryClient);
	if (!byLimit) {
		byLimit = new Map();
		SNAPSHOT_LISTENERS.set(queryClient, byLimit);
	}
	let listeners = byLimit.get(limit);
	if (!listeners) {
		listeners = new Set();
		byLimit.set(limit, listeners);
	}
	const updates = new Map<string, RequestSnapshotUpdate>();
	let disposed = false;
	const capture = (update: RequestSnapshotUpdate) => {
		const previous = updates.get(update.id);
		updates.set(update.id, {
			...update,
			request: update.request ?? previous?.request,
			summary: update.summary ?? previous?.summary,
		});
		if (updates.size > limit) {
			const oldest = [...updates.values()].reduce((left, right) =>
				left.timestamp <= right.timestamp ? left : right,
			);
			updates.delete(oldest.id);
		}
	};
	// Pending rows predate persistence and can already exist before this fetch.
	// Seed only those rows; a snapshot must still be able to remove old history.
	const cached = queryClient.getQueryData<RequestsData>(
		queryKeys.requests(limit),
	);
	for (const request of cached?.requests ?? []) {
		if (request.meta?.pending)
			capture({
				id: request.id,
				timestamp: request.meta.timestamp,
				sequence: requestsSseSeq,
				request,
			});
	}
	listeners.add(capture);
	return {
		updates,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			listeners.delete(capture);
			if (listeners.size === 0) byLimit.delete(limit);
			if (byLimit.size === 0) SNAPSHOT_LISTENERS.delete(queryClient);
			updates.clear();
		},
	};
}

const CONNECTION_POOL = new Map<string, PooledConnection>();
const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_MAX_DELAY = 30_000;
const HIDDEN_RECONNECT_THRESHOLD = 30_000;
let requestsSseSeq = 0;

export function getRequestsSseSeq(): number {
	return requestsSseSeq;
}

function pruneDetailsMap(
	map: Map<string, RequestResponse>,
	requests: RequestPayload[],
): Map<string, RequestResponse> {
	const ids = new Set(requests.map((request) => request.id));
	if ([...map.keys()].every((id) => ids.has(id))) return map;
	return new Map([...map].filter(([id]) => ids.has(id)));
}

// The pool owns recovery, not the component that happened to connect first.
// Keep subscribers while reconnecting so one unmount cannot orphan the others.
function createPooledConnection(key: string, limit: number): PooledConnection {
	const subscribers = new Set<StreamSubscriber>();
	let connection: EventSource | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let attempt = 0;
	let generation = 0;
	let hiddenAt: number | null =
		document.visibilityState === "hidden" ? Date.now() : null;

	const forEachClient = (visit: (subscriber: StreamSubscriber) => void) => {
		const seen = new Set<QueryClient>();
		for (const subscriber of subscribers) {
			if (seen.has(subscriber.queryClient)) continue;
			seen.add(subscriber.queryClient);
			visit(subscriber);
		}
	};
	const invalidate = () =>
		forEachClient(({ queryClient }) => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.requests(limit),
			});
		});
	const clearRetry = () => {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	};
	const closeConnection = () => {
		const previous = connection;
		connection = null;
		previous?.close();
	};
	const scheduleRetry = () => {
		clearRetry();
		closeConnection();
		const base = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_DELAY);
		attempt++;
		retryTimer = setTimeout(
			() => {
				retryTimer = null;
				connect();
			},
			Math.round(base + Math.random() * base * 0.25),
		);
	};
	const connect = () => {
		if (disposed || subscribers.size === 0) return;
		clearRetry();
		closeConnection();
		const currentGeneration = ++generation;
		const isAttemptCurrent = () =>
			!disposed && generation === currentGeneration;
		void api.createEventSource("requests").then(
			(es) => {
				if (!isAttemptCurrent()) {
					es.close();
					return;
				}
				connection = es;
				const isCurrent = () => isAttemptCurrent() && connection === es;
				es.addEventListener("open", () => {
					if (!isCurrent()) return;
					// A fresh pool can still have Infinity-stale history retained in cache.
					invalidate();
					attempt = 0;
				});
				es.addEventListener("message", (event) => {
					if (isCurrent())
						forEachClient(({ handleMessage }) => handleMessage(event));
				});
				es.addEventListener("error", () => {
					if (!isCurrent()) return;
					// Disable browser retries; each new attempt must mint a fresh token.
					scheduleRetry();
				});
			},
			() => {
				if (isAttemptCurrent()) scheduleRetry();
			},
		);
	};
	const recover = (hiddenMs: number, online: boolean) => {
		if (disposed) return;
		invalidate();
		if (
			connection?.readyState !== EventSource.OPEN ||
			online ||
			hiddenMs > HIDDEN_RECONNECT_THRESHOLD
		) {
			attempt = 0;
			connect();
		}
	};
	const onVisibilityChange = () => {
		if (document.visibilityState === "hidden") {
			hiddenAt = Date.now();
			return;
		}
		const hiddenMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
		hiddenAt = null;
		recover(hiddenMs, false);
	};
	const onOnline = () => recover(0, true);
	document.addEventListener("visibilitychange", onVisibilityChange);
	window.addEventListener("online", onOnline);
	const heartbeat = setInterval(() => {
		// CONNECTING belongs to the current handshake, not a dead connection.
		if (connection?.readyState === EventSource.CLOSED) connect();
	}, HEARTBEAT_INTERVAL);

	const pooled: PooledConnection = {
		subscribers,
		connect: () => connect(),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			clearRetry();
			clearInterval(heartbeat);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("online", onOnline);
			closeConnection();
			subscribers.clear();
			if (CONNECTION_POOL.get(key) === pooled) CONNECTION_POOL.delete(key);
		},
	};
	return pooled;
}

export function useRequestStream(limit = 200) {
	const queryClient = useQueryClient();
	const connectionKey = `requests-stream-${limit}`;

	// Safe message handler with try-catch that directly updates React Query cache
	const handleMessage = useCallback(
		(ev: MessageEvent) => {
			try {
				const evt = JSON.parse(ev.data) as
					| {
							type: "start";
							id: string;
							method: string;
							path: string;
							timestamp: number;
							accountId: string | null;
							statusCode: number;
							agentUsed: string | null;
							agentAttributionSource?: AgentAttributionSource | null;
					  }
					| { type: "summary"; payload: RequestResponse };

				requestsSseSeq++;
				const data = queryClient.setQueryData<RequestsData>(
					queryKeys.requests(limit),
					(current) => {
						if (!current) {
							if (evt.type !== "start") return current;
							current = { requests: [], detailsMap: new Map() };
						}

						// Ensure detailsMap is a Map
						const currentDetailsMap =
							current.detailsMap instanceof Map
								? current.detailsMap
								: new Map(current.detailsMap.map((s) => [s.id, s]));

						if (evt.type === "start") {
							// Look up account name from cache
							const accounts = queryClient.getQueryData<Account[]>(
								queryKeys.accounts(),
							);
							const account = accounts?.find((a) => a.id === evt.accountId);

							// Create a lightweight placeholder payload.
							// `bodiesOmitted: true` is required so that opening the
							// details modal or pressing Copy-as-JSON triggers the
							// lazy /api/requests/payload/:id fetch — without it the
							// modal shows empty headers/body and the copy returns
							// nulled-out bodies.
							//
							// `response: null` when no status is known yet so the
							// status chip (guarded by `statusCode != null`) does NOT
							// render a "0" before the response lands. The summary
							// handler below patches response.status from
							// `evt.payload.statusCode` once the request completes.
							const hasStatus = evt.statusCode > 0;
							const placeholder: RequestPayload = {
								id: evt.id,
								request: { headers: {}, body: null },
								response: hasStatus
									? {
											status: evt.statusCode,
											headers: {},
											body: null,
										}
									: null,
								meta: {
									timestamp: evt.timestamp,
									path: evt.path,
									method: evt.method,
									accountId: evt.accountId || undefined,
									accountName: account?.name,
									success: false,
									pending: true,
									agentUsed: evt.agentUsed || undefined,
									agentAttributionSource:
										evt.agentAttributionSource || undefined,
									rateLimited: evt.statusCode === 429,
									bodiesOmitted: true,
								},
							};

							// Check if this request already exists
							const existingIndex = current.requests.findIndex(
								(r) => r.id === evt.id,
							);
							if (existingIndex >= 0) {
								// Update existing placeholder
								const newRequests = [...current.requests];
								newRequests[existingIndex] = placeholder;
								return {
									...current,
									requests: newRequests,
									detailsMap: currentDetailsMap,
								};
							}

							// Add new placeholder at the beginning.
							const nextRequests = [placeholder, ...current.requests].slice(
								0,
								limit,
							);
							return {
								...current,
								requests: nextRequests,
								detailsMap: pruneDetailsMap(currentDetailsMap, nextRequests),
							};
						}
						const requestIndex = current.requests.findIndex(
							(r) => r.id === evt.payload.id,
						);
						if (requestIndex < 0) {
							const detailsMap = pruneDetailsMap(
								currentDetailsMap,
								current.requests,
							);
							return detailsMap === current.detailsMap
								? current
								: { ...current, detailsMap };
						}

						const map = new Map(currentDetailsMap);
						map.set(evt.payload.id, evt.payload);
						const newRequests = [...current.requests];
						// Update meta to remove pending status. Preserve
						// `bodiesOmitted: true` so consumers continue to lazy-
						// load bodies, and refresh `rateLimited` from the final
						// statusCode (the placeholder set it from `evt.statusCode`
						// which is 0 until the response lands).
						if (newRequests[requestIndex].meta) {
							newRequests[requestIndex] = {
								...newRequests[requestIndex],
								// Refresh response.status from the final summary —
								// the start placeholder set it to 0 before the HTTP
								// response landed, and the new header-row chip uses
								// a `statusCode != null` guard (0 is not null), so
								// without this every SSE-completed request would
								// permanently display a grey "0" chip.
								response:
									evt.payload.statusCode != null
										? {
												...(newRequests[requestIndex].response ?? {
													headers: {},
													body: null,
												}),
												status: evt.payload.statusCode,
											}
										: null,
								meta: {
									...newRequests[requestIndex].meta,
									pending: false,
									success: evt.payload.success,
									rateLimited: evt.payload.rateLimited,
									bodiesOmitted: true,
								},
							};
						}
						return {
							...current,
							requests: newRequests,
							detailsMap: pruneDetailsMap(map, newRequests),
						};
					},
				);
				const listeners = SNAPSHOT_LISTENERS.get(queryClient)?.get(limit);
				if (listeners?.size) {
					const id = evt.type === "start" ? evt.id : evt.payload.id;
					const request = data?.requests.find((item) => item.id === id);
					const timestamp =
						evt.type === "start"
							? evt.timestamp
							: new Date(evt.payload.timestamp).getTime();
					for (const listener of listeners)
						listener({
							id,
							sequence: requestsSseSeq,
							timestamp: Number.isFinite(timestamp) ? timestamp : 0,
							request,
							summary: evt.type === "summary" ? evt.payload : undefined,
						});
				}
			} catch (error) {
				console.error("Error parsing SSE message:", error);
			}
		},
		[queryClient, limit],
	);

	useEffect(() => {
		let pooled = CONNECTION_POOL.get(connectionKey);
		const isNew = !pooled;
		if (!pooled) {
			pooled = createPooledConnection(connectionKey, limit);
			CONNECTION_POOL.set(connectionKey, pooled);
		}
		const subscriber = { queryClient, handleMessage };
		pooled.subscribers.add(subscriber);
		if (isNew) pooled.connect();

		return () => {
			pooled.subscribers.delete(subscriber);
			if (pooled.subscribers.size === 0) pooled.dispose();
		};
	}, [connectionKey, limit, queryClient, handleMessage]);
}

// Export global cleanup function for app shutdown, including pending retries.
export const cleanupRequestStream = () => {
	for (const pooled of CONNECTION_POOL.values()) pooled.dispose();
};
