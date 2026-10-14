export function createTtlCache<T>(ttlMs: number, now = Date.now) {
	const values = new Map<string, { value: T; expiresAt: number }>();
	const pending = new Map<string, Promise<T>>();

	return {
		get(key: string, load: () => Promise<T>): Promise<T> {
			const cached = values.get(key);
			if (cached && cached.expiresAt > now())
				return Promise.resolve(cached.value);
			values.delete(key);
			const running = pending.get(key);
			if (running) return running;

			let loading: Promise<T>;
			try {
				loading = load();
			} catch (error) {
				return Promise.reject(error);
			}
			const promise = loading
				.then((value) => {
					// clear() retires old loads; their callers can still receive the result.
					if (pending.get(key) === promise) {
						values.set(key, { value, expiresAt: now() + ttlMs });
						if (values.size > 32) {
							const oldest = values.keys().next().value;
							if (oldest !== undefined) values.delete(oldest);
						}
					}
					return value;
				})
				.finally(() => {
					if (pending.get(key) === promise) pending.delete(key);
				});
			pending.set(key, promise);
			return promise;
		},
		clear() {
			values.clear();
			pending.clear();
		},
	};
}
