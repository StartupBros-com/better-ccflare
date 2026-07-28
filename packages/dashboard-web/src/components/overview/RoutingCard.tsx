import { StrategyName } from "@better-ccflare/core";
import { useSetStrategy, useStrategy } from "../../hooks/queries";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

// Only session-class strategies are offered from the dashboard. Per-request
// spreading strategies (least-used, session-affinity) can trip Claude's
// anti-abuse systems and get accounts banned, so they are deliberately not
// listed here even though StrategyName defines them. Values come from the
// shared StrategyName enum (not hardcoded strings) so this list can never
// drift from the authoritative 3 values in @better-ccflare/core.
//
// Upstream also offers "session-drain-soonest" here; this fork does not carry
// that strategy (see packages/load-balancer/src/strategies), so it is omitted.
const STRATEGY_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: "Session", value: StrategyName.Session },
];

export interface StrategySelectItem {
	label: string;
	value: string;
	disabled?: boolean;
}

/**
 * Build the strategy Select's item list. The dashboard only offers the
 * session-class strategy above, but the server's effective strategy
 * (getStrategy()) can be any of the StrategyName values — settable via
 * LB_STRATEGY, an older config file, or a hand-edited one. An out-of-list
 * value used to leave the Select's trigger blank with no indication it was
 * active, and selecting a listed option would silently overwrite it
 * with no recovery path (routing-settings-ui-2026-07-20 review, rank 1).
 * When the current strategy isn't one of the listed options, it is
 * appended as a disabled item labelled "<value> (current)" so its state is
 * visible without being re-selectable; the deliberate options stay
 * selectable.
 */
export function getStrategySelectItems(
	strategy: string,
): readonly StrategySelectItem[] {
	const isListed = STRATEGY_OPTIONS.some((opt) => opt.value === strategy);
	if (isListed) {
		return STRATEGY_OPTIONS;
	}
	return [
		...STRATEGY_OPTIONS,
		{ label: `${strategy} (current)`, value: strategy, disabled: true },
	];
}

export interface RoutingCardViewProps {
	strategy: string;
	onStrategyChange: (strategy: string) => void;
	strategyDisabled: boolean;
	strategySource: "env" | "file" | "default";
}

/**
 * Presentational routing settings card. Kept free of data hooks so it can be
 * rendered with plain props in tests (renderToStaticMarkup); RoutingCard wires
 * it to react-query.
 */
export function RoutingCardView({
	strategy,
	onStrategyChange,
	strategyDisabled,
	strategySource,
}: RoutingCardViewProps) {
	const strategyEnvLocked = strategySource === "env";
	const strategyItems = getStrategySelectItems(strategy);

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Routing</CardTitle>
				<CardDescription>
					Choose how requests are spread across accounts and whether accounts
					that have exhausted a model's weekly capacity are skipped.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<Label htmlFor="routing-strategy">Load-balancing strategy</Label>
							{strategyEnvLocked && (
								<Badge
									variant="outline"
									title="Set by the LB_STRATEGY environment variable; change the env var to edit this."
								>
									env-locked
								</Badge>
							)}
						</div>
						<div className="text-sm text-muted-foreground">
							<span className="font-medium">Session</span> keeps each client on
							one account for the session duration. Weekly-window capacity is
							handled separately by this fork's hard-capacity routing, which
							excludes accounts whose model lane is exhausted rather than
							reordering the pool by reset time.
						</div>
						<Select
							disabled={strategyDisabled || strategyEnvLocked}
							value={strategy}
							onValueChange={onStrategyChange}
						>
							<SelectTrigger id="routing-strategy" className="w-64">
								<SelectValue placeholder="Select strategy..." />
							</SelectTrigger>
							<SelectContent>
								{strategyItems.map((opt) => (
									<SelectItem
										key={opt.value}
										value={opt.value}
										disabled={opt.disabled}
									>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="text-xs text-muted-foreground">
							⚠️ Only session-class strategies are shown. Strategies that spread
							individual requests across accounts can trigger Claude's
							anti-abuse systems and risk account bans.
						</div>
					</div>

					<div className="space-y-1">
						<Label>Model-scoped capacity routing</Label>
						<div className="text-sm text-muted-foreground">
							Always on. Accounts whose per-model weekly cap is exhausted are
							skipped, so clients get a fast model_pool_exhausted response
							instead of failover retries that are guaranteed to fail. This fork
							has no on/off toggle for it — unlike upstream, capacity routing is
							part of the routing pipeline itself.
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function RoutingCard() {
	const { data: strategyData, isLoading: strategyLoading } = useStrategy();
	const setStrategy = useSetStrategy();

	return (
		<RoutingCardView
			strategy={strategyData?.strategy ?? "session"}
			strategySource={strategyData?.strategySource ?? "default"}
			onStrategyChange={(value) => setStrategy.mutate(value)}
			strategyDisabled={strategyLoading || setStrategy.isPending}
		/>
	);
}
