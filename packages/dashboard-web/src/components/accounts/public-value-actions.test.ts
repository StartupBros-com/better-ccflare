import { describe, expect, it } from "bun:test";
import { savePublicValue, togglePublicValue } from "./public-value-actions";

function fakeApi(fail?: Error) {
	const calls: Array<[string, boolean, string | undefined]> = [];
	return {
		calls,
		api: {
			async setAccountPublicValue(
				id: string,
				enabled: boolean,
				label?: string,
			) {
				calls.push([id, enabled, label]);
				if (fail) throw fail;
			},
		},
	};
}

describe("togglePublicValue", () => {
	it("opens the dialog without any write when enabling", async () => {
		const { api, calls } = fakeApi();
		for (const publicValueEnabled of [false, undefined]) {
			expect(
				await togglePublicValue({ id: "a", publicValueEnabled }, api),
			).toEqual({ kind: "open-dialog" });
		}
		expect(calls).toEqual([]);
	});

	it("writes enabled:false with no label when disabling", async () => {
		const { api, calls } = fakeApi();
		expect(
			await togglePublicValue({ id: "a", publicValueEnabled: true }, api),
		).toEqual({ kind: "unpublished" });
		expect(calls).toEqual([["a", false, undefined]]);
		expect(calls[0]).toHaveLength(3);
	});

	it("propagates a failed unpublish", async () => {
		const { api } = fakeApi(new Error("boom"));
		await expect(
			togglePublicValue({ id: "a", publicValueEnabled: true }, api),
		).rejects.toThrow("boom");
	});
});

describe("savePublicValue", () => {
	it("publishes with the label", async () => {
		const { api, calls } = fakeApi();
		expect(await savePublicValue({ id: "a" }, "Team", api, String)).toEqual({
			ok: true,
		});
		expect(calls).toEqual([["a", true, "Team"]]);
	});

	it("returns the server message on refusal so the dialog stays open", async () => {
		const { api } = fakeApi(
			new Error("Label must not contain the account name"),
		);
		expect(
			await savePublicValue(
				{ id: "a" },
				"work",
				api,
				(e) => (e as Error).message,
			),
		).toEqual({ ok: false, error: "Label must not contain the account name" });
	});
});
