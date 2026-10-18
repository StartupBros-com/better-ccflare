/**
 * Process-local roster generation for the DB-backed public subscription value
 * feed. The admin write endpoint bumps it; the feed handler folds it into its
 * cache key and refuses to cache or serve a refresh that straddled a bump, so
 * an unpublish takes effect on the next request instead of after the 60 s
 * cache window.
 */
let generation = 0;

export function getPublicRosterGeneration(): number {
	return generation;
}

export function bumpPublicRosterGeneration(): number {
	generation += 1;
	return generation;
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes roster writes so the read-validate-write sequence behind the
 * label-uniqueness and 16-account cap rules cannot interleave.
 */
export function runExclusiveRosterWrite<T>(task: () => Promise<T>): Promise<T> {
	const run = writeQueue.then(task, task);
	writeQueue = run.catch(() => undefined);
	return run;
}
