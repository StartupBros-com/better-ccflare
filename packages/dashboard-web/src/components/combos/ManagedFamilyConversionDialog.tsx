import type {
	ComboFamily,
	ComboRoutingPreviewMemberState,
	ComboRoutingPreviewResult,
	ComboRoutingProposalPreview,
} from "@better-ccflare/types";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { projectFamilyConversionPreview } from "./family-routing";

export interface ManagedFamilyApplyCommand {
	family: ComboFamily;
	previewId: string;
	proposalId: string;
	managedModel: string;
}

export interface ManagedFamilyConversionErrorView {
	code: string | null;
	message: string;
	retryable: boolean;
}

export interface ManagedFamilyConversionReviewProps {
	family: ComboFamily;
	managedModel: string;
	preview: ComboRoutingPreviewResult;
	selectedProposalId: string | null;
	reviewAcknowledged: boolean;
	onProposalSelect: (proposalId: string) => void;
	onReviewAcknowledgedChange: (acknowledged: boolean) => void;
}

export interface ManagedFamilyConversionDialogProps
	extends Omit<ManagedFamilyConversionReviewProps, "preview"> {
	open: boolean;
	preview: ComboRoutingPreviewResult | null;
	isPreviewLoading: boolean;
	previewError: unknown;
	isApplying: boolean;
	applyError: unknown;
	onOpenChange: (open: boolean) => void;
	onRetry: () => void;
	onApply: (command: ManagedFamilyApplyCommand) => void;
}

export interface ManagedFamilyConversionBodyProps
	extends Omit<ManagedFamilyConversionReviewProps, "preview"> {
	preview: ComboRoutingPreviewResult | null;
	isPreviewLoading: boolean;
	previewError: unknown;
	isApplying: boolean;
	applyError: unknown;
	onRetry: () => void;
}

const FAMILY_LABELS: Record<ComboFamily, string> = {
	fable: "Fable",
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

function errorCode(error: unknown): string | null {
	if (!error || typeof error !== "object" || !("details" in error)) {
		return null;
	}
	const details = (error as { details?: unknown }).details;
	if (!details || typeof details !== "object" || !("code" in details)) {
		return null;
	}
	return typeof (details as { code?: unknown }).code === "string"
		? ((details as { code: string }).code ?? null)
		: null;
}

export function managedFamilyConversionError(
	error: unknown,
): ManagedFamilyConversionErrorView | null {
	if (!error) return null;
	const code = errorCode(error);
	if (code === "managed_route_empty") {
		return {
			code,
			message:
				"Managed mode was not enabled because the server found zero effective candidates. The family remains in its previous mode.",
			retryable: true,
		};
	}
	if (code === "stale_routing_preview") {
		return {
			code,
			message:
				"This preview is stale because routing changed. Refresh and review the current server proposal before applying.",
			retryable: true,
		};
	}
	return {
		code,
		message:
			error instanceof Error
				? error.message
				: "The managed-routing request failed. Refresh the server preview and try again.",
		retryable: true,
	};
}

export function proposalRequiresExplicitReview(
	proposal: ComboRoutingProposalPreview,
): boolean {
	return !proposal.high_confidence || proposal.reason !== "included";
}

export function isManagedFamilyPreviewCurrent(
	preview: ComboRoutingPreviewResult,
	family: ComboFamily,
	managedModel: string,
): boolean {
	return preview.family === family && preview.managed_model === managedModel;
}

function selectedProposal(
	preview: ComboRoutingPreviewResult,
	proposalId: string | null,
): ComboRoutingProposalPreview | null {
	if (!proposalId) return null;
	return (
		preview.proposals.find(
			(proposal) =>
				proposal.proposal_id === proposalId &&
				proposal.family === preview.family &&
				proposal.managed_model === preview.managed_model,
		) ?? null
	);
}

export function buildManagedFamilyApplyCommand(
	preview: ComboRoutingPreviewResult,
	proposalId: string | null,
	expectedFamily: ComboFamily = preview.family,
	expectedManagedModel: string = preview.managed_model,
): ManagedFamilyApplyCommand | null {
	if (
		!isManagedFamilyPreviewCurrent(
			preview,
			expectedFamily,
			expectedManagedModel,
		)
	) {
		return null;
	}
	const proposal = selectedProposal(preview, proposalId);
	if (!proposal || proposal.managed_model !== preview.managed_model)
		return null;
	return {
		family: preview.family,
		previewId: preview.preview_id,
		proposalId: proposal.proposal_id,
		managedModel: preview.managed_model,
	};
}

export function canApplyManagedFamilyConversion(
	preview: ComboRoutingPreviewResult,
	proposalId: string | null,
	reviewAcknowledged: boolean,
	expectedFamily: ComboFamily = preview.family,
	expectedManagedModel: string = preview.managed_model,
): boolean {
	if (
		!isManagedFamilyPreviewCurrent(
			preview,
			expectedFamily,
			expectedManagedModel,
		)
	) {
		return false;
	}
	const proposal = selectedProposal(preview, proposalId);
	if (!proposal) return false;
	if (proposal.managed_model !== preview.managed_model) return false;
	if (proposal.proposed_effective.resolution.members.length === 0) return false;
	return !proposalRequiresExplicitReview(proposal) || reviewAcknowledged;
}

function titleCase(value: string): string {
	return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function memberStateLabel(
	state: ComboRoutingPreviewMemberState | null,
): string {
	if (!state) return "None";
	return `${titleCase(state.source)} · ${state.logical_model} · tier ${state.tier}`;
}

function proposalWarning(proposal: ComboRoutingProposalPreview): string | null {
	if (proposal.reason === "new_billing_class") {
		return "The server marked this as a new billing class. Applying may introduce paid traffic.";
	}
	if (!proposal.high_confidence) {
		return "The server marked this proposal as low confidence. Confirm the provider and route class before applying.";
	}
	if (proposal.reason === "ambiguous") {
		return "The server marked this proposal as ambiguous. Confirm the provider, route class, and effective-member delta before applying.";
	}
	if (proposal.reason !== "included") {
		return `The server marked this proposal as ${proposal.reason}. Review its capability and effective-member delta before applying.`;
	}
	return null;
}

function hasTierChange(proposal: ComboRoutingProposalPreview): boolean {
	return proposal.member_delta.some((delta) => {
		if (delta.status === "added") return delta.after !== null;
		if (delta.status !== "changed" || !delta.before || !delta.after) {
			return false;
		}
		return delta.before.tier !== delta.after.tier;
	});
}

export function ManagedFamilyConversionReview({
	family,
	managedModel,
	preview,
	selectedProposalId,
	reviewAcknowledged,
	onProposalSelect,
	onReviewAcknowledgedChange,
}: ManagedFamilyConversionReviewProps) {
	const conversion = projectFamilyConversionPreview(preview);
	const selectedProjection = conversion.proposals.find(
		({ proposal }) => proposal.proposal_id === selectedProposalId,
	);
	const selected = selectedProposal(preview, selectedProposalId);
	const selectedWarning = selected ? proposalWarning(selected) : null;
	const selectedIsEmpty =
		selected?.proposed_effective.resolution.members.length === 0;

	return (
		<div className="space-y-4" aria-live="polite">
			<div>
				<h3 className="font-semibold">
					Review {FAMILY_LABELS[family]} managed routing
				</h3>
				<p className="text-sm text-muted-foreground">
					This is the current server-owned preview for {managedModel}. No manual
					slots will be deleted.
				</p>
			</div>

			<div className="space-y-2">
				<h4 className="text-sm font-medium">Server proposals</h4>
				{conversion.proposals.length === 0 ? (
					<p className="rounded border p-3 text-sm text-muted-foreground">
						The server returned no conversion proposal. Refresh after checking
						the active combo and its manual peers.
					</p>
				) : (
					conversion.proposals.map(({ proposal }) => (
						<label
							key={proposal.proposal_id}
							className="flex cursor-pointer items-start gap-3 rounded border p-3"
							data-proposal-id={proposal.proposal_id}
						>
							<input
								type="radio"
								name={`${family}-managed-proposal`}
								value={proposal.proposal_id}
								checked={selectedProposalId === proposal.proposal_id}
								onChange={() => onProposalSelect(proposal.proposal_id)}
								aria-label={`Select ${proposal.provider} ${proposal.route_class} proposal`}
							/>
							<span className="min-w-0 flex-1 space-y-1 text-sm">
								<span className="flex flex-wrap items-center gap-2">
									<strong>{proposal.provider}</strong>
									<code>{proposal.route_class}</code>
									<Badge
										variant={proposal.high_confidence ? "default" : "secondary"}
									>
										{proposal.high_confidence
											? "High confidence"
											: "Low confidence"}
									</Badge>
								</span>
								<span className="block text-xs text-muted-foreground">
									Proposed rule · {proposal.provider} / {proposal.route_class} ·{" "}
									{proposal.managed_model} · tier source: account priority
								</span>
								<span className="block text-xs">
									Server reason: <code>{proposal.reason}</code>
								</span>
							</span>
						</label>
					))
				)}
			</div>

			{selected && selectedProjection && (
				<div className="space-y-3 rounded border bg-muted/20 p-3">
					<div>
						<h4 className="text-sm font-medium">
							Exact effective-member delta
						</h4>
						{selectedProjection.memberDelta.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								The server reports no member changes.
							</p>
						) : (
							<ul className="mt-2 space-y-2">
								{selectedProjection.memberDelta.map((delta) => (
									<li
										key={delta.key}
										className="rounded bg-background p-2 text-xs"
									>
										<div className="font-medium">
											{delta.after?.account_id ??
												delta.before?.account_id ??
												delta.key}
											{" · "}
											{titleCase(delta.status)}
										</div>
										<div className="text-muted-foreground">
											Before: {memberStateLabel(delta.before)}
										</div>
										<div>After: {memberStateLabel(delta.after)}</div>
									</li>
								))}
							</ul>
						)}
					</div>

					<div>
						<h4 className="text-sm font-medium">
							{selectedProjection.proposedRouting.manualSlots.length}{" "}
							{selectedProjection.proposedRouting.manualSlots.length === 1
								? "manual slot"
								: "manual slots"}{" "}
							preserved
						</h4>
						{selectedProjection.proposedRouting.manualSlots.map((slot) => (
							<div key={slot.id} className="text-xs text-muted-foreground">
								{slot.account_id} · {slot.model} · tier {slot.priority} ·{" "}
								{slot.enabled ? "Enabled" : "Disabled"}
							</div>
						))}
					</div>
				</div>
			)}

			{selected && hasTierChange(selected) && (
				<p className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
					<span>
						The server preview includes a new or changed account-priority tier.
						Review the exact member delta above.
					</span>
				</p>
			)}

			{selectedWarning && (
				<div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<p className="flex gap-2 font-medium">
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
						Explicit review required
					</p>
					<p>{selectedWarning}</p>
					<label className="flex cursor-pointer items-start gap-2">
						<input
							type="checkbox"
							checked={reviewAcknowledged}
							onChange={(event) =>
								onReviewAcknowledgedChange(event.currentTarget.checked)
							}
						/>
						<span>
							I reviewed this server proposal, including its route class and
							billing warning.
						</span>
					</label>
				</div>
			)}

			{selectedIsEmpty && (
				<p className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
					Managed mode cannot be enabled: this authoritative preview has zero
					effective candidates. The existing family mode will be preserved.
				</p>
			)}
		</div>
	);
}

export function ManagedFamilyConversionBody({
	family,
	managedModel,
	preview,
	selectedProposalId,
	reviewAcknowledged,
	isPreviewLoading,
	previewError,
	isApplying,
	applyError,
	onProposalSelect,
	onReviewAcknowledgedChange,
	onRetry,
}: ManagedFamilyConversionBodyProps) {
	const previewFailure = managedFamilyConversionError(previewError);
	const applyFailure = managedFamilyConversionError(applyError);

	return (
		<div className="space-y-3" aria-live="polite">
			{isPreviewLoading && (
				<p className="text-sm text-muted-foreground">
					Loading the current server preview…
				</p>
			)}
			{previewFailure && (
				<p className="text-sm text-destructive" role="alert">
					{previewFailure.message}
				</p>
			)}
			{!isPreviewLoading && !previewFailure && preview && (
				<ManagedFamilyConversionReview
					family={family}
					managedModel={managedModel}
					preview={preview}
					selectedProposalId={selectedProposalId}
					reviewAcknowledged={reviewAcknowledged}
					onProposalSelect={onProposalSelect}
					onReviewAcknowledgedChange={onReviewAcknowledgedChange}
				/>
			)}
			{applyFailure && (
				<p className="text-sm text-destructive" role="alert">
					{applyFailure.message}
				</p>
			)}
			{(previewFailure || applyFailure?.retryable) && (
				<Button
					variant="outline"
					onClick={onRetry}
					disabled={isPreviewLoading || isApplying}
				>
					<RefreshCw />
					Refresh preview
				</Button>
			)}
		</div>
	);
}

export function ManagedFamilyConversionDialog({
	open,
	family,
	managedModel,
	preview,
	selectedProposalId,
	reviewAcknowledged,
	isPreviewLoading,
	previewError,
	isApplying,
	applyError,
	onOpenChange,
	onProposalSelect,
	onReviewAcknowledgedChange,
	onRetry,
	onApply,
}: ManagedFamilyConversionDialogProps) {
	const previewIdentityError =
		preview && !isManagedFamilyPreviewCurrent(preview, family, managedModel)
			? {
					message: "The preview does not match the open family policy.",
					details: { code: "stale_routing_preview" },
				}
			: null;
	const currentPreview = previewIdentityError ? null : preview;
	const previewFailure = managedFamilyConversionError(
		previewError ?? previewIdentityError,
	);
	const applyFailure = managedFamilyConversionError(applyError);
	const command = currentPreview
		? buildManagedFamilyApplyCommand(
				currentPreview,
				selectedProposalId,
				family,
				managedModel,
			)
		: null;
	const canApply =
		currentPreview !== null &&
		canApplyManagedFamilyConversion(
			currentPreview,
			selectedProposalId,
			reviewAcknowledged,
			family,
			managedModel,
		) &&
		!isApplying &&
		!previewFailure &&
		applyFailure?.code !== "stale_routing_preview" &&
		applyFailure?.code !== "managed_route_empty";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader className="sr-only">
					<DialogTitle>
						Review {FAMILY_LABELS[family]} managed routing
					</DialogTitle>
					<DialogDescription>
						Review the authoritative server proposal before enabling managed
						routing.
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto py-1">
					<ManagedFamilyConversionBody
						family={family}
						managedModel={managedModel}
						preview={currentPreview}
						selectedProposalId={selectedProposalId}
						reviewAcknowledged={reviewAcknowledged}
						isPreviewLoading={isPreviewLoading}
						previewError={previewError ?? previewIdentityError}
						isApplying={isApplying}
						applyError={applyError}
						onProposalSelect={onProposalSelect}
						onReviewAcknowledgedChange={onReviewAcknowledgedChange}
						onRetry={onRetry}
					/>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isApplying}
					>
						Cancel
					</Button>
					<Button
						onClick={() => command && onApply(command)}
						disabled={!canApply || !command}
					>
						{isApplying ? "Applying…" : "Enable Managed"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
