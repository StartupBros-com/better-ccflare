import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { APIContext } from "../../types";

const scratch = mkdtempSync(join(tmpdir(), "ccflare-public-roster-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "isolated.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "isolated-config.json");
process.env.DATABASE_URL = "";
const { DatabaseOperations } = await import("@better-ccflare/database");
const { createPublicSubscriptionValueHandler } = await import(
	"../public-subscription-value"
);
const { createAccountPublicValueHandler } = await import(
	"../account-public-value"
);
const { getPublicRosterGeneration } = await import(
	"../../services/public-subscription-roster"
);
const { isValidPublicId } = await import(
	"../../services/public-subscriptions-config"
);
const { APIRouter } = await import("../../router");
const { createAccountRenameHandler } = await import("../accounts");

const db = new DatabaseOperations(":memory:");
const context = { dbOps: db } as APIContext;
const write = createAccountPublicValueHandler(db);
let now = 1000;
let feed: ReturnType<typeof createPublicSubscriptionValueHandler>;
let warn: ReturnType<typeof spyOn<Logger, "warn">>;
let info: ReturnType<typeof spyOn<Logger, "info">>;
let error: ReturnType<typeof spyOn<Logger, "error">>;

async function addAccount(id: string, name: string, createdAt = 100) {
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, ?, 'anthropic', ?)",
			[id, name, createdAt],
		);
}
function post(accountId: string, body: unknown) {
	return write(
		new Request(`http://localhost/api/accounts/${accountId}/public-value`, {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		accountId,
	);
}
interface PublicRow {
	public_value_enabled: number;
	public_value_label: string | null;
	public_value_id: string | null;
}
async function row(id: string): Promise<PublicRow> {
	return (await db
		.getAdapter()
		.get<PublicRow>(
			"SELECT public_value_enabled, public_value_label, public_value_id FROM accounts WHERE id = ?",
			[id],
		)) as PublicRow;
}
async function snapshot(): Promise<string> {
	return JSON.stringify(
		await db
			.getAdapter()
			.query(
				"SELECT id, public_value_enabled, public_value_label, public_value_id FROM accounts ORDER BY id",
			),
	);
}
async function feedBody() {
	now++;
	const response = await feed();
	return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
	await db.getAdapter().run("DELETE FROM usage_windows");
	await db.getAdapter().run("DELETE FROM usage_snapshots");
	await db.getAdapter().run("DELETE FROM accounts");
	now = 1000;
	feed = createPublicSubscriptionValueHandler(context, {
		getConfig: () => "accounts",
		now: () => now,
	});
	warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
	info = spyOn(Logger.prototype, "info").mockImplementation(() => undefined);
	error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	warn.mockRestore();
	info.mockRestore();
	error.mockRestore();
});
afterAll(async () => {
	await db.close();
	rmSync(scratch, { recursive: true, force: true });
});

describe("public-value write endpoint", () => {
	it("publishes with a label, generates an opaque id and reports the state", async () => {
		await addAccount("acct-1", "private-name");
		const response = await post("acct-1", { enabled: true, label: "Weekly A" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			publicValueEnabled: true,
			publicValueLabel: "Weekly A",
		});
		const stored = await row("acct-1");
		expect(stored.public_value_enabled).toBe(1);
		expect(stored.public_value_label).toBe("Weekly A");
		expect(isValidPublicId(stored.public_value_id)).toBe(true);
		expect(stored.public_value_id).toMatch(/^sub-[0-9a-f]{16}$/);
		expect(stored.public_value_id).not.toContain("acct-1");
	});

	it("returns 404 for an unknown account and 400 for malformed bodies, writing nothing", async () => {
		await addAccount("acct-1", "private-name");
		const before = await snapshot();
		expect((await post("nope", { enabled: false })).status).toBe(404);
		for (const body of [
			"{not json",
			"[]",
			"null",
			{},
			{ enabled: 1 },
			{ enabled: "true" },
			{ enabled: true, label: 5 },
			{ enabled: true, label: null },
		]) {
			expect((await post("acct-1", body)).status).toBe(400);
		}
		expect(await snapshot()).toBe(before);
	});

	it("refuses (400, nothing written) a missing, untrimmed, name- or id-bearing or invalid label", async () => {
		await addAccount("acct-1", "Private Name");
		const before = await snapshot();
		const bad = [
			{ enabled: true },
			{ enabled: true, label: " padded" },
			{ enabled: true, label: "padded " },
			{ enabled: true, label: "" },
			{ enabled: true, label: "has <tag>" },
			{ enabled: true, label: "tab\tchar" },
			{ enabled: true, label: "x".repeat(81) },
			{ enabled: true, label: "My private name sub" },
			{ enabled: true, label: "ACCT-1 plan" },
			{ enabled: false, label: " padded" },
			{ enabled: false, label: "contains PRIVATE NAME" },
		];
		for (const body of bad) {
			expect((await post("acct-1", body)).status).toBe(400);
		}
		expect(await snapshot()).toBe(before);
	});

	it("refuses a duplicate label case-insensitively but allows re-labelling itself", async () => {
		await addAccount("zq-1", "name-one");
		await addAccount("zq-2", "name-two");
		expect(
			(await post("zq-1", { enabled: true, label: "Plan X" })).status,
		).toBe(200);
		const before = await snapshot();
		expect(
			(await post("zq-2", { enabled: true, label: "plan x" })).status,
		).toBe(400);
		expect(await snapshot()).toBe(before);
		expect(
			(await post("zq-1", { enabled: true, label: "PLAN X" })).status,
		).toBe(200);
		// An unpublished account's label does not reserve the name.
		expect((await post("zq-1", { enabled: false })).status).toBe(200);
		expect(
			(await post("zq-2", { enabled: true, label: "Plan X" })).status,
		).toBe(200);
		// ...but it cannot be re-published into a collision.
		expect((await post("zq-1", { enabled: true })).status).toBe(400);
	});

	it("refuses the 17th published account and writes nothing", async () => {
		for (let i = 0; i < 17; i++) await addAccount(`a${i}`, `name-${i}`);
		for (let i = 0; i < 16; i++)
			expect(
				(await post(`a${i}`, { enabled: true, label: `Sub ${i}` })).status,
			).toBe(200);
		const before = await snapshot();
		expect((await post("a16", { enabled: true, label: "Sub 16" })).status).toBe(
			400,
		);
		expect(await snapshot()).toBe(before);
		// An already-published account can still be edited at the cap.
		expect((await post("a0", { enabled: true, label: "Renamed" })).status).toBe(
			200,
		);
	});

	it("keeps the public id across relabel, unpublish and republish; unpublish keeps the label", async () => {
		await addAccount("acct-1", "private-name");
		await post("acct-1", { enabled: true, label: "First" });
		const id = (await row("acct-1")).public_value_id;
		await post("acct-1", { enabled: true, label: "Second" });
		expect((await row("acct-1")).public_value_id).toBe(id);
		const off = await post("acct-1", { enabled: false });
		expect(await off.json()).toMatchObject({
			publicValueEnabled: false,
			publicValueLabel: "Second",
		});
		expect(await row("acct-1")).toMatchObject({
			public_value_enabled: 0,
			public_value_label: "Second",
			public_value_id: id,
		});
		await post("acct-1", { enabled: true });
		expect(await row("acct-1")).toMatchObject({
			public_value_enabled: 1,
			public_value_label: "Second",
			public_value_id: id,
		});
	});

	it("stores a valid label for an unpublished account and generates distinct ids", async () => {
		await addAccount("zq-1", "name-one");
		await addAccount("zq-2", "name-two");
		await post("zq-1", { enabled: false, label: "Stored only" });
		expect(await row("zq-1")).toMatchObject({
			public_value_enabled: 0,
			public_value_label: "Stored only",
			public_value_id: null,
		});
		await post("zq-1", { enabled: true });
		await post("zq-2", { enabled: true, label: "Other" });
		expect((await row("zq-1")).public_value_id).not.toBe(
			(await row("zq-2")).public_value_id,
		);
	});

	it("bumps the roster generation on a successful write only", async () => {
		await addAccount("acct-1", "private-name");
		const start = getPublicRosterGeneration();
		await post("acct-1", { enabled: true });
		expect(getPublicRosterGeneration()).toBe(start);
		await post("acct-1", { enabled: true, label: "Ok" });
		expect(getPublicRosterGeneration()).toBeGreaterThan(start);
	});
});

describe("public-value write authorization", () => {
	it("answers 401 to an unauthenticated write while an API key is active", async () => {
		const router = new APIRouter({
			dbOps: {
				getAdapter: () => ({}),
				countActiveApiKeys: async () => 1,
				getActiveApiKeys: async () => [],
			},
			config: {},
		} as unknown as APIContext);
		const url = new URL("http://localhost/api/accounts/acct-1/public-value");
		const response = await router.handleRequest(
			url,
			new Request(url, {
				method: "POST",
				body: JSON.stringify({ enabled: true, label: "X" }),
			}),
		);
		expect(response?.status).toBe(401);
	});
});

describe("public-value route dispatch", () => {
	it("routes an authorized POST to the handler instead of falling through", async () => {
		const router = new APIRouter({
			dbOps: {
				getAdapter: () => ({}),
				countActiveApiKeys: async () => 0,
				getActiveApiKeys: async () => [],
			},
			config: {},
		} as unknown as APIContext);
		const url = new URL("http://localhost/api/accounts/acct-1/public-value");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "POST", body: "{}" }),
		);
		expect(response?.status).toBe(400);
	});
});

describe("public subscription value feed, accounts mode", () => {
	it("serves an empty roster with 200 and exact schema keys", async () => {
		const { status, body } = await feedBody();
		expect(status).toBe(200);
		expect(body).toEqual({
			schemaVersion: 1,
			valueBasis: "api_equivalent_usd",
			windowKey: "seven_day",
			generatedAt: now,
			subscriptions: [],
		});
	});

	it("publishes only enabled accounts, ordered by label then created_at, with public ids only", async () => {
		await addAccount("zq-1", "name-one", 300);
		await addAccount("zq-2", "name-two", 200);
		await addAccount("zq-3", "name-three", 100);
		await addAccount("zq-4", "name-four", 50);
		await post("zq-1", { enabled: true, label: "beta" });
		await post("zq-2", { enabled: true, label: "Alpha" });
		await post("zq-3", { enabled: true, label: "Gamma" });
		const { status, body } = await feedBody();
		expect(status).toBe(200);
		expect(body.subscriptions.map((s: { label: string }) => s.label)).toEqual([
			"Alpha",
			"beta",
			"Gamma",
		]);
		const text = JSON.stringify(body);
		for (const secret of ["zq-", "name-"]) expect(text).not.toContain(secret);
		expect(body.subscriptions[0].id).toBe((await row("zq-2")).public_value_id);
	});

	it("fails closed on labels that differ only by case", async () => {
		await addAccount("late", "name-late", 500);
		await addAccount("early", "name-early", 100);
		await post("late", { enabled: true, label: "Same" });
		await db
			.getAdapter()
			.run(
				"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'SAME', public_value_id = 'sub-dup0000000000001' WHERE id = 'early'",
			);
		// Duplicate labels (case-insensitive) fail the whole feed closed.
		expect((await feedBody()).status).toBe(503);
	});

	it("keeps the public id stable across relabel and republish in the feed", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const first = (await feedBody()).body.subscriptions[0].id;
		await post("zq-1", { enabled: true, label: "Uno" });
		await post("zq-1", { enabled: false });
		await post("zq-1", { enabled: true });
		const again = (await feedBody()).body.subscriptions[0];
		expect(again.id).toBe(first);
		expect(again.label).toBe("Uno");
	});

	it("never serves an unpublished account, even inside the cache window", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "Visible" });
		expect((await feedBody()).body.subscriptions).toHaveLength(1);
		// Still well inside the 60 s window.
		await post("zq-1", { enabled: false });
		const after = await feedBody();
		expect(after.status).toBe(200);
		expect(after.body.subscriptions).toEqual([]);
		expect(JSON.stringify(after.body)).not.toContain("Visible");
	});

	it("serves a label change on the next request", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "Before" });
		await feedBody();
		await post("zq-1", { enabled: true, label: "After" });
		expect((await feedBody()).body.subscriptions[0].label).toBe("After");
	});

	it("reads the roster only on a cache miss", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const read = spyOn(db, "listPublishedPublicValue");
		try {
			expect((await feedBody()).status).toBe(200);
			expect(read).toHaveBeenCalledTimes(1);
			expect((await feedBody()).status).toBe(200);
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			read.mockRestore();
		}
	});

	it("omits an account deleted and recreated under the same name until republished", async () => {
		await addAccount("old-id", "same-name", 100);
		await post("old-id", { enabled: true, label: "Mine" });
		expect((await feedBody()).body.subscriptions).toHaveLength(1);
		await db.getAdapter().run("DELETE FROM accounts WHERE id = 'old-id'");
		await addAccount("new-id", "same-name", 900);
		// A direct DB delete does not bump; the TTL bound applies, then it is gone.
		now += 61_000;
		const gone = await feedBody();
		expect(gone.status).toBe(200);
		expect(gone.body.subscriptions).toEqual([]);
		await post("new-id", { enabled: true, label: "Mine" });
		const back = await feedBody();
		expect(back.body.subscriptions).toHaveLength(1);
		expect(back.body.subscriptions[0].id).not.toBe("old-id");
	});

	it("fails closed (generic 503) on invalid stored values, more than 16 rows, and duplicate ids", async () => {
		const adapter = db.getAdapter();
		await addAccount("zq-1", "name-one");
		await adapter.run(
			"UPDATE accounts SET public_value_enabled = 1, public_value_label = ' bad', public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-1'",
		);
		let result = await feedBody();
		expect(result.status).toBe(503);
		expect(result.body).toEqual({ error: "Unavailable" });

		await adapter.run(
			"UPDATE accounts SET public_value_label = 'Fine', public_value_id = 'bad id!' WHERE id = 'zq-1'",
		);
		expect((await feedBody()).status).toBe(503);

		await adapter.run(
			"UPDATE accounts SET public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-1'",
		);
		await addAccount("zq-2", "name-two");
		await adapter.run(
			"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'Fine 2', public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-2'",
		);
		expect((await feedBody()).status).toBe(503);

		await adapter.run("DELETE FROM accounts");
		for (let i = 0; i < 17; i++) {
			await addAccount(`m${i}`, `n${i}`);
			await adapter.run(
				"UPDATE accounts SET public_value_enabled = 1, public_value_label = ?, public_value_id = ? WHERE id = ?",
				[`L${i}`, `sub-${String(i).padStart(16, "0")}`, `m${i}`],
			);
		}
		result = await feedBody();
		expect(result.status).toBe(503);
		expect(result.body).toEqual({ error: "Unavailable" });
	});

	it("does not cache or serve a refresh that straddles a roster write", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		// Gate a feed-only read so the concurrent admin write is not blocked.
		const original = db.getLatestUsageSnapshot.bind(db);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const spy = spyOn(db, "getLatestUsageSnapshot").mockImplementation(
			async (...args) => {
				await gate;
				return original(...args);
			},
		);
		try {
			now++;
			const pending = feed();
			await new Promise((resolve) => setTimeout(resolve, 10));
			await post("zq-1", { enabled: false });
			release();
			expect((await pending).status).toBe(503);
		} finally {
			spy.mockRestore();
		}
		const next = await feedBody();
		expect(next.status).toBe(200);
		expect(next.body.subscriptions).toEqual([]);
	});

	it("rejects a row whose published state changed between roster read and re-fetch", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const original = db.getAccount.bind(db);
		const spy = spyOn(db, "getAccount").mockImplementation(async (id) => {
			const account = await original(id);
			return account && { ...account, public_value_label: "Changed" };
		});
		try {
			expect((await feedBody()).status).toBe(503);
		} finally {
			spy.mockRestore();
		}
	});

	it("uses an injected roster generation and a key distinct from env raw values", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		let generation = 1;
		const injected = createPublicSubscriptionValueHandler(context, {
			getConfig: () => "accounts",
			now: () => now,
			getRosterGeneration: () => generation,
		});
		expect((await injected()).status).toBe(200);
		await db
			.getAdapter()
			.run("UPDATE accounts SET public_value_enabled = 0 WHERE id = 'zq-1'");
		now++;
		expect((await (await injected()).json()).subscriptions).toHaveLength(1);
		generation = 2;
		now++;
		expect((await (await injected()).json()).subscriptions).toEqual([]);
	});

	it("keeps env-array mode and the disabled state unchanged", async () => {
		const env = createPublicSubscriptionValueHandler(context, {
			getConfig: () => undefined,
			now: () => now,
		});
		expect((await env()).status).toBe(404);
		const spyRead = spyOn(db, "listPublishedPublicValue");
		try {
			const array = createPublicSubscriptionValueHandler(context, {
				getConfig: () => "[]",
				now: () => now,
			});
			const response = await array();
			expect(response.status).toBe(200);
			expect((await response.json()).subscriptions).toEqual([]);
			expect(spyRead).not.toHaveBeenCalled();
		} finally {
			spyRead.mockRestore();
		}
	});
});

describe("renaming a published account", () => {
	function rename(accountId: string, name: string) {
		return createAccountRenameHandler(db)(
			new Request(`http://localhost/api/accounts/${accountId}/rename`, {
				method: "POST",
				body: JSON.stringify({ name }),
			}),
			accountId,
		);
	}

	it("refuses a rename into a name its public label contains, writing nothing", async () => {
		await addAccount("rn-1", "work");
		expect(
			(await post("rn-1", { enabled: true, label: "Team Alpha" })).status,
		).toBe(200);
		const before = await snapshot();
		const generation = getPublicRosterGeneration();
		const response = await rename("rn-1", "alpha");
		expect(response.status).toBe(400);
		expect(await snapshot()).toBe(before);
		const name = await db
			.getAdapter()
			.get<{ name: string }>("SELECT name FROM accounts WHERE id = ?", [
				"rn-1",
			]);
		expect(name?.name).toBe("work");
		expect(getPublicRosterGeneration()).toBe(generation);
	});

	it("allows a harmless rename of a published account and invalidates the feed", async () => {
		await addAccount("rn-2", "work");
		await post("rn-2", { enabled: true, label: "Team Alpha" });
		const generation = getPublicRosterGeneration();
		expect((await rename("rn-2", "other")).status).toBe(200);
		expect(getPublicRosterGeneration()).toBeGreaterThan(generation);
	});

	it("allows any rename of an unpublished account", async () => {
		await addAccount("rn-3", "work");
		await post("rn-3", { enabled: true, label: "Team Alpha" });
		await post("rn-3", { enabled: false });
		expect((await rename("rn-3", "alpha")).status).toBe(200);
	});

	it("fails the feed closed when a stored label comes to contain the account name", async () => {
		await addAccount("rn-4", "work");
		await post("rn-4", { enabled: true, label: "Team Alpha" });
		expect((await feedBody()).status).toBe(200);
		await db
			.getAdapter()
			.run("UPDATE accounts SET name = 'alpha' WHERE id = 'rn-4'");
		now += 10 * 60 * 1000;
		expect((await feedBody()).status).toBe(503);
	});
});
