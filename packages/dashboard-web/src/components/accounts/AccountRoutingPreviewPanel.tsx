import type { ComboRoutingPreviewResult } from "@better-ccflare/types";
import type {
	AccountRoutingOutcome,
	AccountRoutingSelection,
} from "./account-routing";
import {
	routingOutcomeReasonLabel,
	routingReasonLabel,
	routingSelectionKey,
} from "./account-routing";

export interface AccountRoutingPreviewPanelProps {
	previews: readonly ComboRoutingPreviewResult[];
	selections: readonly AccountRoutingSelection[];
	onSelectionChange?: (selections: AccountRoutingSelection[]) => void;
	outcomes?: readonly AccountRoutingOutcome[];
	isLoading?: boolean;
	error?: string | null;
}

export function AccountRoutingPreviewPanel({
	previews,
	selections,
	onSelectionChange,
	outcomes = [],
	isLoading = false,
	error = null,
}: AccountRoutingPreviewPanelProps) {
	const selectedKeys = new Set(selections.map(routingSelectionKey));
	const toggleSelection = (
		selection: AccountRoutingSelection,
		selected: boolean,
	) => {
		if (!onSelectionChange) return;
		const key = routingSelectionKey(selection);
		onSelectionChange(
			selected
				? [
						...selections.filter(
							(candidate) => routingSelectionKey(candidate) !== key,
						),
						selection,
					]
				: selections.filter(
						(candidate) => routingSelectionKey(candidate) !== key,
					),
		);
	};

	return (
		<section className="space-y-3 rounded-lg border p-4" aria-live="polite">
			<div>
				<h3 className="font-medium">Routing preview</h3>
				<p className="text-xs text-muted-foreground">
					Server-reviewed family changes. Credentials and endpoints are never
					sent to this preview.
				</p>
			</div>

			{isLoading && (
				<p className="text-sm text-muted-foreground">Previewing…</p>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{!isLoading && !error && previews.length === 0 && (
				<p className="text-sm text-muted-foreground">
					No authoritative routing proposals are available.
				</p>
			)}

			{previews.map((preview) => (
				<div key={preview.family} className="space-y-2 rounded border p-3">
					<div className="flex items-center justify-between gap-3">
						<strong className="capitalize">{preview.family}</strong>
						<span className="text-xs text-muted-foreground">
							{preview.effective.policy.combo?.name ?? "No active combo"}
						</span>
					</div>
					{preview.proposals.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No server proposal for this family.
						</p>
					) : (
						preview.proposals.map((proposal) => {
							const selection = {
								family: preview.family,
								proposalId: proposal.proposal_id,
							};
							const key = routingSelectionKey(selection);
							const selected =
								proposal.high_confidence && selectedKeys.has(key);
							return (
								<label
									key={key}
									className="flex items-start gap-3 rounded bg-muted/30 p-2"
									data-selection-key={key}
									data-selected={selected}
								>
									<input
										type="checkbox"
										checked={selected}
										disabled={!proposal.high_confidence || !onSelectionChange}
										onChange={(event) =>
											toggleSelection(selection, event.currentTarget.checked)
										}
										aria-label={`Select ${preview.family} routing proposal`}
									/>
									<span className="space-y-1 text-sm">
										<span className="block font-medium">
											{proposal.managed_model}
										</span>
										<span className="block text-xs text-muted-foreground">
											Account priority · {proposal.provider} ·{" "}
											{proposal.route_class}
										</span>
										<span className="block text-xs">
											{routingReasonLabel(proposal.reason)}
											{proposal.high_confidence
												? proposal.selected_by_default
													? " · Recommended"
													: " · High confidence"
												: " · Action required"}
										</span>
									</span>
								</label>
							);
						})
					)}
				</div>
			))}

			{outcomes.length > 0 && (
				<div className="space-y-2 border-t pt-3">
					<h4 className="text-sm font-medium">Routing outcomes</h4>
					{outcomes.map((outcome) => (
						<div key={routingSelectionKey(outcome)} className="text-sm">
							<strong className="capitalize">{outcome.family}</strong>:{" "}
							<span>
								{outcome.status === "joined" ? "Joined" : "Action required"}
							</span>
							<span className="text-muted-foreground">
								{" — "}
								{routingOutcomeReasonLabel(outcome.reason)}
							</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
