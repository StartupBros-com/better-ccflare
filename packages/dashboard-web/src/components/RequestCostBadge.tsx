import {
	processTokenUsage,
	type TokenUsageData,
} from "@better-ccflare/ui-common";
import { Badge } from "./ui/badge";

interface RequestCostBadgeProps {
	summary: Pick<TokenUsageData, "costUsd"> | undefined;
	pending?: boolean;
	className?: string;
}

export function RequestCostBadge({
	summary,
	pending,
	className,
}: RequestCostBadgeProps) {
	const cost = processTokenUsage(
		summary ? { costUsd: summary.costUsd, pending } : undefined,
	).sections.cost;
	if (!cost) return null;

	const unknown = summary?.costUsd == null;
	return (
		<Badge
			variant={unknown ? "outline" : "default"}
			className={className}
			title={
				unknown
					? "No cost was recorded for this request."
					: "Recorded cost may be an estimate; it is not proof of an upstream charge."
			}
		>
			{unknown ? "Cost unknown" : cost.value}
		</Badge>
	);
}
