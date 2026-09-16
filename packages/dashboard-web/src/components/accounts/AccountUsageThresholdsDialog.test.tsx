import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Account } from "../../api";

// Install the DOM before importing React DOM/Radix, which detect DOM support
// on import. Restore globals after this file so non-DOM suites stay isolated.
const window = new Window({ url: "http://localhost/" });
const domGlobals = {
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Node: window.Node,
	NodeFilter: window.NodeFilter,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
	MutationObserver: window.MutationObserver,
	getComputedStyle: window.getComputedStyle.bind(window),
	requestAnimationFrame: window.requestAnimationFrame.bind(window),
	cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
	IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
	Object.keys(domGlobals).map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
for (const [key, value] of Object.entries(domGlobals)) {
	Object.defineProperty(globalThis, key, {
		configurable: true,
		writable: true,
		value,
	});
}
const { createRoot } = await import("react-dom/client");
const { AccountUsageThresholdsDialog } = await import(
	"./AccountUsageThresholdsDialog"
);

const account = {
	id: "account-1",
	name: "Primary",
	provider: "anthropic",
	usagePauseFiveHourThreshold: 70,
	usagePauseWeeklyThreshold: 90,
	usagePauseFiveHourEnabled: true,
	usagePauseWeeklyEnabled: false,
} as Account;

let root: Root;
let container: HTMLDivElement;
let update = mock(async (_id: string, _five: unknown, _weekly: unknown) => {});
let openChange = mock((_open: boolean) => {});

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	update = mock(async (_id: string, _five: unknown, _weekly: unknown) => {});
	openChange = mock((_open: boolean) => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	mock.restore();
});

afterAll(async () => {
	await window.happyDOM.close();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function render(nextAccount = account) {
	await act(async () => {
		root.render(
			<AccountUsageThresholdsDialog
				account={nextAccount}
				isOpen
				onOpenChange={openChange}
				onUpdateThresholds={update}
			/>,
		);
	});
}

function field(windowName: "5h" | "weekly") {
	const input = document.querySelector<HTMLInputElement>(
		`#usage-threshold-${windowName}`,
	);
	if (!input) throw new Error("Missing threshold field");
	return input;
}

async function changeField(windowName: "5h" | "weekly", value: string) {
	await act(async () => {
		const input = field(windowName);
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

function button(text: string) {
	const found = [...document.querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}

async function click(element: HTMLButtonElement) {
	await act(async () => element.click());
}

async function toggle(windowName: "5-hour" | "weekly") {
	const control = document.querySelector<HTMLButtonElement>(
		`button[title="Pause on the ${windowName} window"]`,
	);
	if (!control) throw new Error("Missing threshold switch");
	await click(control);
}

describe("AccountUsageThresholdsDialog", () => {
	it.each([
		"",
		"0",
		"101",
		"80.5",
	])("rejects an enabled invalid or empty percentage: %s", async (value) => {
		await render();
		await changeField("5h", value);
		expect(button("Save Thresholds").disabled).toBe(true);
		expect(document.body.textContent).toContain(
			value === ""
				? "A window that is switched on needs a percentage."
				: "Percentages must be whole numbers between 1 and 100.",
		);
		await click(button("Save Thresholds"));
		expect(update).not.toHaveBeenCalled();
		expect(openChange).not.toHaveBeenCalled();
	});

	it("saves independent window switches while retaining the disabled percentage", async () => {
		await render();
		await changeField("5h", "81");
		await toggle("5-hour");
		await toggle("weekly");
		await click(button("Save Thresholds"));
		expect(update).toHaveBeenCalledWith(
			account.id,
			{ enabled: false, percent: 81 },
			{ enabled: true, percent: 90 },
		);
		expect(openChange).toHaveBeenCalledWith(false);
	});

	it("keeps the dialog and edited values on a rejected save", async () => {
		spyOn(console, "error").mockImplementation(() => {});
		update.mockImplementation(async () => {
			throw new Error("save failed");
		});
		await render();
		await changeField("weekly", "93");
		await click(button("Save Thresholds"));
		expect(update).toHaveBeenCalledTimes(1);
		expect(openChange).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(field("weekly").value).toBe("93");
		expect(button("Save Thresholds").disabled).toBe(false);
	});

	it("resets unsaved fields and switches when another account has the same stored settings", async () => {
		await render();
		await changeField("5h", "20");
		await changeField("weekly", "30");
		await toggle("5-hour");
		await toggle("weekly");
		await render({ ...account, id: "account-2", name: "Secondary" });
		expect(field("5h").value).toBe("70");
		expect(field("weekly").value).toBe("90");
		await click(button("Save Thresholds"));
		expect(update).toHaveBeenCalledWith(
			"account-2",
			{ enabled: true, percent: 70 },
			{ enabled: false, percent: 90 },
		);
	});

	it("allows closing during a pending save, which still completes for its original account", async () => {
		let resolveSave: () => void = () => {};
		update.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveSave = resolve;
				}),
		);
		await render();
		await click(button("Save Thresholds"));
		expect(button("Saving...").disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(false);
		await click(button("Cancel"));
		expect(openChange).toHaveBeenCalledWith(false);
		expect(update).toHaveBeenCalledTimes(1);
		await act(async () => resolveSave());
		expect(update.mock.calls[0]?.[0]).toBe(account.id);
	});
});
