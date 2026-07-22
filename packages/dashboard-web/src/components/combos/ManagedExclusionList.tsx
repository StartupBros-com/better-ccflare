import type {
	ComboFamily,
	ComboMembershipExclusion,
} from "@better-ccflare/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	familyRoutingReasonLabel,
	type projectFamilyRouting,
} from "./family-routing";
import type { ManagedRoutingTarget } from "./ManagedMemberList";

export type ManagedDecisionProjection = ReturnType<
	typeof projectFamilyRouting
>["decisions"][number];

interface ManagedExclusionListProps {
	family: ComboFamily;
	decisions: readonly ManagedDecisionProjection[];
	exclusions?: readonly ComboMembershipExclusion[];
	accountNameFor?: (accountId: string) => string;
	onRestore: (target: ManagedRoutingTarget) => void;
	pendingTarget?: ManagedRoutingTarget | null;
	errorTarget?: ManagedRoutingTarget | null;
	mutationPending?: boolean;
}

function familyLabel(family: ComboFamily): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

function isPendingTarget(
	pending: ManagedRoutingTarget | null | undefined,
	target: ManagedRoutingTarget,
): boolean {
	return (
		pending?.family === target.family && pending.accountId === target.accountId
	);
}

export function ManagedExclusionList({
	family,
	decisions,
	exclusions = [],
	accountNameFor = () => "Unknown account",
	onRestore,
	pendingTarget,
	errorTarget,
	mutationPending = false,
}: ManagedExclusionListProps) {
	const label = familyLabel(family);
	const rejected = decisions.filter(
		({ decision, isRejected }) =>
			isRejected && decision.reason !== "manual_override",
	);
	const resolvedExclusionAccountIds = new Set(
		rejected
			.filter(({ isExcluded }) => isExcluded)
			.map(({ decision }) => decision.account_id),
	);
	const storedOnlyExclusions = exclusions.filter(
		(exclusion) =>
			exclusion.family === family &&
			!resolvedExclusionAccountIds.has(exclusion.account_id),
	);

	if (rejected.length === 0 && storedOnlyExclusions.length === 0) return null;

	return (
		<section
			className="space-y-2"
			aria-label={`${label} excluded and rejected accounts`}
			aria-busy={mutationPending}
		>
			<div>
				<h4 className="text-sm font-medium">Excluded and rejected accounts</h4>
				<p className="text-xs text-muted-foreground">
					Server-owned reasons explain why each managed candidate is absent.
				</p>
			</div>
			<div className="space-y-1">
				{rejected.map(
					({ decision, reasonLabel, availabilityLabel, isExcluded }) => {
						const target = { family, accountId: decision.account_id };
						const isPending = isPendingTarget(pendingTarget, target);
						const hasError = isPendingTarget(errorTarget, target);
						return (
							<div
								key={`${family}:${decision.account_id}:${decision.rule_id ?? decision.reason}`}
								className="flex items-start gap-3 rounded-md border border-dashed px-3 py-2"
								data-reason={decision.reason}
							>
								<div className="min-w-0 flex-1 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate text-sm font-medium">
											{decision.account_name}
										</span>
										<Badge variant="secondary" className="text-xs">
											Managed candidate
										</Badge>
										{decision.tier !== null && (
											<Badge variant="outline" className="text-xs">
												Tier {decision.tier}
											</Badge>
										)}
									</div>
									{decision.logical_model && (
										<div className="font-mono text-xs text-muted-foreground">
											{decision.logical_model}
										</div>
									)}
									<div className="text-xs text-muted-foreground">
										{reasonLabel} · {availabilityLabel}
									</div>
									{isExcluded && hasError && (
										<p className="text-xs text-destructive" role="alert">
											Could not restore {decision.account_name}; the stored
											exclusion is unchanged.
										</p>
									)}
								</div>
								{isExcluded && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => onRestore(target)}
										disabled={mutationPending || isPending}
										aria-label={`Restore ${decision.account_name} to ${label} managed routing`}
									>
										{isPending ? "Restoring…" : "Restore"}
									</Button>
								)}
							</div>
						);
					},
				)}
				{storedOnlyExclusions.map((exclusion) => {
					const accountName = accountNameFor(exclusion.account_id);
					const target = { family, accountId: exclusion.account_id };
					const isPending = isPendingTarget(pendingTarget, target);
					const hasError = isPendingTarget(errorTarget, target);
					return (
						<div
							key={exclusion.id}
							className="flex items-start gap-3 rounded-md border border-dashed px-3 py-2"
							data-reason="excluded"
						>
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="truncate text-sm font-medium">
										{accountName}
									</span>
									<Badge variant="secondary" className="text-xs">
										Stored exclusion
									</Badge>
								</div>
								<div className="text-xs text-muted-foreground">
									{familyRoutingReasonLabel("excluded")} · Availability not
									currently resolved
								</div>
								{hasError && (
									<p className="text-xs text-destructive" role="alert">
										Could not restore {accountName}; the stored exclusion is
										unchanged.
									</p>
								)}
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => onRestore(target)}
								disabled={mutationPending || isPending}
								aria-label={`Restore ${accountName} to ${label} managed routing`}
							>
								{isPending ? "Restoring…" : "Restore"}
							</Button>
						</div>
					);
				})}
			</div>
		</section>
	);
}
