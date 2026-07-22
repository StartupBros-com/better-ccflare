import type { ComboFamily } from "@better-ccflare/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { projectFamilyRouting } from "./family-routing";

export type ManagedMemberProjection = ReturnType<
	typeof projectFamilyRouting
>["managedMembers"][number];

export interface ManagedRoutingTarget {
	family: ComboFamily;
	accountId: string;
}

interface ManagedMemberListProps {
	family: ComboFamily;
	members: readonly ManagedMemberProjection[];
	onExclude: (target: ManagedRoutingTarget) => void;
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

export function ManagedMemberList({
	family,
	members,
	onExclude,
	pendingTarget,
	errorTarget,
	mutationPending = false,
}: ManagedMemberListProps) {
	const label = familyLabel(family);

	return (
		<section
			className="space-y-2"
			aria-label={`${label} managed members`}
			aria-busy={mutationPending}
		>
			<div>
				<h4 className="text-sm font-medium">{label} managed members</h4>
				<p className="text-xs text-muted-foreground">
					Resolved by current policy. Their tier follows account priority.
				</p>
			</div>

			{members.length === 0 ? (
				<p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
					No resolved managed members.
				</p>
			) : (
				<div className="space-y-1">
					{members.map(
						({ member, sourceLabel, reasonLabel, availabilityLabel }) => {
							const target = { family, accountId: member.account_id };
							const isPending = isPendingTarget(pendingTarget, target);
							const hasError = isPendingTarget(errorTarget, target);
							return (
								<div
									key={member.id ?? `${family}:${member.account_id}`}
									className="flex items-start gap-3 rounded-md border bg-card px-3 py-2"
									data-account-id={member.account_id}
									data-source={member.source}
								>
									<div className="min-w-0 flex-1 space-y-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="truncate text-sm font-medium">
												{member.account_name}
											</span>
											<Badge variant="default" className="text-xs">
												{sourceLabel}
											</Badge>
											<Badge variant="outline" className="text-xs">
												Tier {member.tier}
											</Badge>
										</div>
										<div className="font-mono text-xs text-muted-foreground">
											{member.logical_model}
										</div>
										<div className="text-xs text-muted-foreground">
											{reasonLabel} · {availabilityLabel}
										</div>
										{hasError && (
											<p className="text-xs text-destructive" role="alert">
												Could not exclude {member.account_name}; authoritative
												membership is unchanged.
											</p>
										)}
									</div>
									<Button
										variant="outline"
										size="sm"
										onClick={() => onExclude(target)}
										disabled={mutationPending || isPending}
										aria-label={`Exclude ${member.account_name} from ${label} managed routing`}
									>
										{isPending ? "Excluding…" : "Exclude"}
									</Button>
								</div>
							);
						},
					)}
				</div>
			)}
		</section>
	);
}
