/**
 * P2 review fix (U8 OAuth control-plane hotfix): render-level coverage for
 * R25 -- reauthentication must read as the PRIMARY action for a terminal
 * auth pause (pauseReason "oauth_invalid_grant"), while every other pause
 * reason (a known non-terminal reason like "manual", or any unrecognized/
 * legacy string) must fall back to generic "Paused" copy with no reauth
 * emphasis. pause-status.test.ts already unit-tests pauseStatusDisplay()
 * itself; this file proves AccountListItem actually wires that result into
 * the rendered markup (copy + which button reads as primary), the same
 * renderToStaticMarkup pattern RateLimitProgress.test.tsx uses in this
 * directory.
 */
import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountList } from "./AccountList";
import { AccountListItem } from "./AccountListItem";
import type { AccountFamilyRoutingState } from "./account-routing";

function noop() {}
async function noopAsync() {}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "acc-1",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: true,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		...overrides,
	};
}

const requiredHandlers = {
	onPauseToggle: noop,
	onForceResetRateLimit: noop,
	onRefreshUsage: noopAsync,
	onRemove: noop,
	onRename: noop,
	onPriorityChange: noop,
	onAutoFallbackToggle: noop,
	onAutoRefreshToggle: noop,
	onBillingTypeToggle: noop,
};

function routingState(
	overrides: Partial<AccountFamilyRoutingState> = {},
): AccountFamilyRoutingState {
	return {
		family: "opus",
		comboId: "combo-opus",
		comboName: "Opus priority",
		active: true,
		membershipLabel: "Managed",
		tier: 0,
		logicalModel: "claude-opus-4-8",
		reason: "included",
		reasonLabel: "Included",
		availability: "available",
		availabilityLabel: "Available",
		managedRouteAvailable: false,
		...overrides,
	};
}

describe("AccountListItem (P2 review: pause-reason rendering)", () => {
	it("renders the derived requiresReauth signal as the same primary recovery action", () => {
		const account = makeAccount({
			requiresReauth: true,
			pauseReason: "oauth_invalid_grant",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Re-authentication required");
		expect(html).toContain("Refresh token invalid — re-authenticate");
		expect(html).toContain(">Re-authenticate<");
		expect(html).toContain("bg-primary text-primary-foreground");
	});

	it("renders reauth-required copy and a primary Re-authenticate button for oauth_invalid_grant", () => {
		const account = makeAccount({ pauseReason: "oauth_invalid_grant" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Re-authentication required");
		// The visible button label (as opposed to its static tooltip title,
		// which always reads "Re-authenticate this Anthropic account..."
		// regardless of pause reason) -- ">Re-authenticate<" only appears when
		// pauseStatus.reauthRequired renders the label text inside the button.
		expect(html).toContain(">Re-authenticate<");
		// variant="default" (primary) styling on the reauth button, not the
		// muted "ghost" styling it gets for a non-terminal/unknown reason. The
		// full cva class combination is asserted (rather than the bare
		// "bg-primary" substring) because the unrelated Auto-fallback/
		// Auto-refresh <Switch> elements always statically include
		// "data-[state=checked]:bg-primary" in their class list regardless of
		// pause reason, which would make a bare "bg-primary" check meaningless.
		expect(html).toContain("bg-primary text-primary-foreground");
	});

	it("renders generic Paused copy with no reauth emphasis for a manual pause", () => {
		const account = makeAccount({ pauseReason: "manual" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain("Re-authentication required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(html).not.toContain("bg-primary text-primary-foreground");
	});

	it("shows a human-readable known automatic pause reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ pauseReason: "failure_threshold" })}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused (failure threshold)");
	});

	it("renders generic Paused copy with no reauth emphasis for an unrecognized pause reason", () => {
		const account = makeAccount({
			pauseReason: "some_future_reason_this_build_does_not_know_about",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain(
			"some future reason this build does not know about",
		);
		expect(html).not.toContain("Re-authentication required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(html).not.toContain("bg-primary text-primary-foreground");
	});
});

describe("AccountListItem authoritative family routing", () => {
	it("renders server-owned Managed source, model, effective tier, and reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[routingState()]}
			/>,
		);

		expect(html).toContain("Family routing");
		expect(html).toContain("Opus");
		expect(html).toContain("Managed");
		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("Tier 0");
		expect(html).toContain("Included");
	});

	it("renders a Manual membership without duplicating manual_override as a warning", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: "Manual",
						reason: "manual_override",
						reasonLabel: "Manual override",
						tier: 7,
					}),
				]}
			/>,
		);

		expect(html).toContain(">Manual<");
		expect(html).toContain("Tier 7");
		expect(html).not.toContain("Manual override");
		expect(html).not.toContain("Action required");
	});

	for (const [availability, expected] of [
		["paused", "Paused"],
		["requires_reauth", "Needs authentication"],
		["rate_limited", "Rate limited"],
		["model_exhausted", "Model exhausted"],
	] as const) {
		it(`renders the distinct ${availability} operational overlay`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false })}
					{...requiredHandlers}
					routingStates={[routingState({ availability })]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html).toContain("membership is unchanged");
		});
	}

	for (const [reason, expected, actionRequired] of [
		["excluded", "Excluded from managed routing", false],
		["unsupported", "Logical model unsupported", false],
		["unknown", "Capability unknown", false],
		["disabled", "Family routing disabled", false],
		["ambiguous", "Ambiguous server proposal", true],
		["new_billing_class", "New billing class requires review", true],
	] as const) {
		it(`renders ${reason} only from the supplied server decision`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false, priority: 0 })}
					{...requiredHandlers}
					routingStates={[
						routingState({
							membershipLabel: null,
							tier: null,
							reason,
							reasonLabel: expected,
						}),
					]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html.includes("Action required")).toBe(actionRequired);
		});
	}

	it("does not infer an outside-route warning from account priority", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false, priority: 0 })}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("Family routing");
		expect(html).not.toContain("Outside active route");
		expect(html).not.toContain("Action required");
	});

	it("directs an outside-route account with a server-approved proposal to Combos without claiming membership", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: null,
						tier: null,
						reason: "unknown",
						reasonLabel: "Capability unknown",
						managedRouteAvailable: true,
					}),
				]}
			/>,
		);

		expect(html).toContain("Managed route available");
		expect(html).toContain("Review in Combos");
		expect(html).toContain("Capability unknown");
		expect(html).not.toContain(">Managed<");
		expect(html).not.toContain("Already a managed member");
	});

	it("keys cards and resolves routing state by immutable account ID", () => {
		const firstRouting = [routingState({ family: "opus" })];
		const secondRouting = [routingState({ family: "fable" })];
		const tree = AccountList({
			accounts: [
				makeAccount({ id: "account-a", name: "duplicate-name" }),
				makeAccount({ id: "account-b", name: "duplicate-name" }),
			],
			routingByAccountId: {
				"account-a": firstRouting,
				"account-b": secondRouting,
			},
			...requiredHandlers,
		}) as React.ReactElement<{
			children: React.ReactElement<{
				routingStates?: readonly AccountFamilyRoutingState[];
			}>[];
		}>;
		const children = tree.props.children;

		expect(children.map((child) => child.key)).toEqual([
			"account-a",
			"account-b",
		]);
		expect(children[0]?.props.routingStates).toBe(firstRouting);
		expect(children[1]?.props.routingStates).toBe(secondRouting);
	});
});

describe("AccountListItem codex usage extras", () => {
	// plan_type / credits_balance are polling-only extras from the free
	// wham/usage endpoint (see api-usage.ts) -- NOT part of the public
	// FullUsageData union, so callers cast. Live traffic can overwrite the
	// cached snapshot and drop them at any moment, so every read must be
	// null-safe and simply omit the element when absent (see
	// RateLimitProgress.tsx's CodexUsageExtras for the sibling code_review_*
	// extras, which follow the same contract).
	function codexUsageData(
		extras: Record<string, unknown>,
	): NonNullable<Account["usageData"]> {
		return {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			...extras,
		} as unknown as FullUsageData;
	}

	it("renders a plan_type badge near the account name when present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ plan_type: "pro" }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain(">pro<");
	});

	it("omits the plan_type badge when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
	});

	it("renders credits_balance as a compact stat when positive", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 1234 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain("1,234 credits");
	});

	it("omits the credits_balance stat when it is zero (noise, not a real balance)", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 0 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
		expect(html).not.toContain("0 credits");
	});

	it("omits the credits_balance stat when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("omits the credits_balance stat when null", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: null }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("does not render plan_type or credits_balance extras for non-codex providers even if the shape is present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "anthropic",
					usageData: codexUsageData({
						plan_type: "pro",
						credits_balance: 1234,
					}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
		expect(html).not.toContain("1,234 credits");
	});
});
