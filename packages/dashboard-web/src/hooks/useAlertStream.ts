import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const RECONNECT_MAX_DELAY = 30_000;

export interface AlertStreamEvent {
	type: "alert";
	payload: {
		id: string;
		timestamp: number;
		type: string;
		severity: string;
		title: string;
		message: string;
		value: number | null;
		threshold: number | null;
		account: string | null;
		model: string | null;
		project: string | null;
		requestId: string | null;
		acknowledged: boolean;
	};
}

interface UseAlertStreamOptions {
	enabled?: boolean;
	onAlert?: (event: AlertStreamEvent) => void;
}

export function useAlertStream(options: UseAlertStreamOptions = {}) {
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const onAlertRef = useRef(options.onAlert);

	// Keep ref current without causing re-renders
	useEffect(() => {
		onAlertRef.current = options.onAlert;
	}, [options.onAlert]);

	useEffect(() => {
		setConnected(false);
		setError(null);
		// Opt-out only when explicitly disabled.
		if (options.enabled === false) return;

		let evtSource: EventSource | null = null;
		let alive = true;
		let generation = 0;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const clearRetry = () => {
			if (retryTimer !== null) clearTimeout(retryTimer);
			retryTimer = null;
		};
		const closeConnection = () => {
			const previous = evtSource;
			evtSource = null;
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
			if (!alive) return;
			clearRetry();
			closeConnection();
			setConnected(false);
			setError(null);
			const currentGeneration = ++generation;
			const isAttemptCurrent = () => alive && generation === currentGeneration;
			void api.createEventSource("alerts").then(
				(source) => {
					if (!isAttemptCurrent()) {
						source.close();
						return;
					}
					evtSource = source;
					const isCurrent = () => isAttemptCurrent() && evtSource === source;
					source.addEventListener("connected", () => {
						if (!isCurrent()) return;
						attempt = 0;
						setConnected(true);
						setError(null);
					});
					source.onmessage = (event) => {
						if (!isCurrent()) return;
						try {
							const data = JSON.parse(event.data) as AlertStreamEvent;
							onAlertRef.current?.(data);
						} catch (err) {
							console.warn("Malformed alert event:", err);
						}
					};
					source.onerror = () => {
						if (!isCurrent()) return;
						setError("Connection lost — reconnecting…");
						setConnected(false);
						// Browser retries reuse a consumed token; mint afresh instead.
						scheduleRetry();
					};
				},
				(err: unknown) => {
					if (!isAttemptCurrent()) return;
					setError(err instanceof Error ? err.message : String(err));
					scheduleRetry();
				},
			);
		};

		connect();

		return () => {
			alive = false;
			clearRetry();
			closeConnection();
		};
	}, [options.enabled]);

	return { connected, error };
}
