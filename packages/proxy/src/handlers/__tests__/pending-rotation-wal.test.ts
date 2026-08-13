import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingRotationWal } from "../pending-rotation-wal";

const SECRET = "pending-rotation-test-secret-with-enough-entropy";
const rotation = {
	accessToken: "access-secret",
	expiresAt: 2_000_000_000_000,
	refreshToken: "refresh-secret",
	attemptedRefreshToken: "consumed-secret",
	recordedAt: 1_700_000_000_000,
};

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "better-ccflare-pending-wal-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("pending rotation WAL", () => {
	it("stores ciphertext with restrictive permissions and restores it after restart", async () => {
		const wal = createPendingRotationWal({ directory, secret: SECRET });
		await wal.save("account-1", rotation);

		const files = readdirSync(directory).filter((name) =>
			name.endsWith(".wal"),
		);
		expect(files).toHaveLength(1);
		const path = join(directory, files[0] as string);
		const stored = readFileSync(path, "utf8");
		expect(stored).not.toContain(rotation.accessToken);
		expect(stored).not.toContain(rotation.refreshToken);
		expect(stored).not.toContain(rotation.attemptedRefreshToken);
		expect(statSync(path).mode & 0o077).toBe(0);

		const restored = await createPendingRotationWal({
			directory,
			secret: SECRET,
		}).load();
		expect(restored).toEqual([{ accountId: "account-1", rotation }]);
	});

	it("atomically replaces an account entry and removes it after persistence", async () => {
		const wal = createPendingRotationWal({ directory, secret: SECRET });
		await wal.save("account-1", rotation);
		const replacement = {
			...rotation,
			accessToken: "access-new",
			refreshToken: "refresh-new",
		};
		await wal.save("account-1", replacement);

		expect(await wal.load()).toEqual([
			{ accountId: "account-1", rotation: replacement },
		]);
		expect(
			readdirSync(directory).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);

		await wal.remove("account-1");
		expect(await wal.load()).toEqual([]);
	});

	it("rejects a WAL encrypted with another key", async () => {
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation,
		);

		await expect(
			createPendingRotationWal({
				directory,
				secret: "different-secret",
			}).load(),
		).rejects.toThrow();
	});

	it("rejects tampered ciphertext instead of dropping the rotation", async () => {
		await createPendingRotationWal({ directory, secret: SECRET }).save(
			"account-1",
			rotation,
		);
		const file = readdirSync(directory).find((name) => name.endsWith(".wal"));
		expect(file).toBeDefined();
		const path = join(directory, file as string);
		const envelope = JSON.parse(readFileSync(path, "utf8")) as {
			ciphertext: string;
		};
		envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
		writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
		chmodSync(path, 0o600);

		await expect(
			createPendingRotationWal({ directory, secret: SECRET }).load(),
		).rejects.toThrow();
	});
});
