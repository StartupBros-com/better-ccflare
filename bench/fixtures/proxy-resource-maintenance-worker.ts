import { Database } from "bun:sqlite";
// Dedicated diagnostic worker: only the disposable fixture database is supplied.
self.onmessage = (event) => {
	const { kind, generation, jobId, path } = event.data;
	if (kind === "retire") {
		self.postMessage({ kind: "retired", generation, closed: true });
		return;
	}
	let db;
	try {
		db = new Database(path, { strict: true });
		db.exec("PRAGMA busy_timeout=25");
		const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
		db.close();
		db = undefined;
		self.postMessage({
			generation,
			jobId,
			closed: true,
			ok: true,
			walBusy: Number(result?.busy ?? 0),
		});
	} catch {
		db?.close();
		self.postMessage({
			generation,
			jobId,
			closed: true,
			ok: false,
			error: "disposable maintenance failure",
		});
	}
};
