import { StrategyName } from "@better-ccflare/core";
import type { RoutingAttemptSummaryResponse } from "@better-ccflare/types";
import {
	useModelCapacityRouting,
	useRoutingAttemptSummary,
	useSetModelCapacityRouting,
	useSetStrategy,
	useStrategy,
} from "../../hooks/queries";
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
import { Switch } from "../ui/switch";

// Only session-class strategies are offered from the dashboard. Per-request
// spreading strategies (least-used, session-affinity) can trip Claude's
// anti-abuse systems and get accounts banned, so they remain deliberately
// hidden even though StrategyName defines them. Values come from the shared
// StrategyName enum so this list cannot drift from the authoritative values.
const STRATEGY_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: "Session", value: StrategyName.Session },
	{
		label: "Session — drain soonest",
		value: StrategyName.SessionDrainSoonest,
	},
	{
		label: "Session — drain soonest (strict)",
		value: StrategyName.SessionDrainSoonestStrict,
	},
];

export interface StrategySelectItem {
	label: string;
	value: string;
	disabled?: boolean;
}

/**
 * Build the strategy Select's item list. The dashboard only offers the
 * session-class strategies above, but the server's effective strategy
 * (getStrategy()) can be any StrategyName value — settable via
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

export type RoutingAttemptSummaryViewState =
	| { status: "loading" | "error" }
	| { status: "success"; data: RoutingAttemptSummaryResponse };

export interface RoutingCardViewProps {
	strategy: string;
	onStrategyChange: (strategy: string) => void;
	strategyDisabled: boolean;
	strategySource: "env" | "file" | "default";
	capacityMode: "off" | "exhausted";
	capacitySource: "env" | "file" | "default";
	onCapacityChange: (mode: "off" | "exhausted") => void;
	capacityDisabled: boolean;
	routingAttempts?: RoutingAttemptSummaryViewState;
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
	capacityMode,
	capacitySource,
	onCapacityChange,
	capacityDisabled,
	routingAttempts = { status: "loading" },
}: RoutingCardViewProps) {
	const strategyEnvLocked = strategySource === "env";
	const capacityEnvLocked = capacitySource === "env";
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
							one account for the session duration.{" "}
							<span className="font-medium">Session — drain soonest</span> is
							sticky: its affinity owner is never preempted; weekly-reset
							ranking only orders fresh selection and failover.{" "}
							<span className="font-medium">
								Session — drain soonest (strict)
							</span>{" "}
							orders candidates within each authorized routing class by earliest
							future weekly reset; an active session only breaks ties, while
							explicit owner-retention and route-circuit decisions remain
							authoritative.
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

					<div className="flex items-center justify-between gap-3">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Label htmlFor="routing-capacity">
									Model-scoped capacity routing
								</Label>
								{capacityEnvLocked && (
									<Badge
										variant="outline"
										title="Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable; change the env var to edit this."
									>
										env-locked
									</Badge>
								)}
							</div>
							<div className="text-sm text-muted-foreground">
								Exhausted per-model accounts are skipped; remaining eligible
								accounts can still handle the request. A retryable 503
								model_pool_exhausted occurs only if capacity filtering leaves no
								eligible account instead of guaranteed-failure retries.
							</div>
						</div>
						<Switch
							id="routing-capacity"
							disabled={capacityDisabled || capacityEnvLocked}
							checked={capacityMode === "exhausted"}
							onCheckedChange={(checked) =>
								onCapacityChange(checked ? "exhausted" : "off")
							}
						/>
					</div>

					<section
						className="space-y-2 border-t pt-4"
						aria-labelledby="routing-attempt-summary-heading"
					>
						<div className="space-y-1">
							<h4
								id="routing-attempt-summary-heading"
								className="text-sm font-medium"
							>
								Routing attempts (last 24 hours)
							</h4>
							<p className="text-xs text-muted-foreground">
								These are upstream routing events, not terminal client failures.
								Telemetry is post-deployment only; historical routing attempts
								were not backfilled.
							</p>
						</div>
						{routingAttempts.status === "loading" && (
							<p className="text-sm text-muted-foreground" role="status">
								Loading routing-attempt summary…
							</p>
						)}
						{routingAttempts.status === "error" && (
							<p className="text-sm text-muted-foreground" role="alert">
								Routing-attempt summary is unavailable.
							</p>
						)}
						{routingAttempts.status === "success" &&
							(routingAttempts.data.totalAttempts === 0 ? (
								<p className="text-sm text-muted-foreground">
									No upstream routing attempts in this window.
								</p>
							) : (
								<div className="space-y-2 text-sm">
									<p>
										{routingAttempts.data.totalAttempts} attempts across{" "}
										{routingAttempts.data.distinctRequests} logical requests
									</p>
									<p className="text-muted-foreground">
										{routingAttempts.data.recoveredRequests} recovered;{" "}
										{routingAttempts.data.terminalFailureRequests} terminal
										failure; {routingAttempts.data.awaitingTerminalRequests}{" "}
										awaiting terminal
									</p>
									{routingAttempts.data.firstObservedAt && (
										<p className="text-muted-foreground">
											First observed{" "}
											<time dateTime={routingAttempts.data.firstObservedAt}>
												{new Date(
													routingAttempts.data.firstObservedAt,
												).toLocaleString()}
											</time>
										</p>
									)}
									<ul
										className="space-y-1"
										aria-label="Routing attempt reason and scope outcomes"
									>
										{routingAttempts.data.byReasonScope.map((row) => (
											<li key={`${row.reason}:${row.scope}`}>
												<span className="font-medium">
													{row.reason} · {row.scope}
												</span>{" "}
												{row.attemptCount} attempts; {row.recoveredRequests}{" "}
												recovered; {row.terminalFailureRequests} terminal
												failure; {row.awaitingTerminalRequests} awaiting
												terminal
											</li>
										))}
									</ul>
								</div>
							))}
					</section>
				</div>
			</CardContent>
		</Card>
	);
}

export function RoutingCard() {
	const { data: strategyData, isLoading: strategyLoading } = useStrategy();
	const setStrategy = useSetStrategy();
	const { data: capacity, isLoading: capacityLoading } =
		useModelCapacityRouting();
	const setCapacity = useSetModelCapacityRouting();
	const routingAttempts = useRoutingAttemptSummary("24h");
	const routingAttemptsView: RoutingAttemptSummaryViewState =
		routingAttempts.isError
			? { status: "error" }
			: routingAttempts.data
				? { status: "success", data: routingAttempts.data }
				: { status: "loading" };

	return (
		<RoutingCardView
			strategy={strategyData?.strategy ?? "session"}
			strategySource={strategyData?.strategySource ?? "default"}
			onStrategyChange={(value) => setStrategy.mutate(value)}
			strategyDisabled={strategyLoading || setStrategy.isPending}
			capacityMode={capacity?.mode ?? "off"}
			capacitySource={capacity?.source ?? "default"}
			onCapacityChange={(mode) => setCapacity.mutate(mode)}
			capacityDisabled={capacityLoading || setCapacity.isPending}
			routingAttempts={routingAttemptsView}
		/>
	);
}
