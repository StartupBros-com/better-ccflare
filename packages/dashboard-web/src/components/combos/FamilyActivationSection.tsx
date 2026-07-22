import { getModelDisplayName } from "@better-ccflare/core";
import type {
	ComboFamily,
	ComboFamilyAssignment,
	ComboRoutingPreviewResult,
} from "@better-ccflare/types";
import { useMemo, useRef, useState } from "react";
import {
	type UpdateFamilyPolicyVariables,
	useApplyFamilyRoutingProposal,
	useCombos,
	useFamilies,
	useModelOptions,
	usePreviewFamilyRouting,
	useUpdateFamilyPolicy,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import {
	type FamilyRoutingModelOption,
	familyModelOptions as filterFamilyModelOptions,
} from "./family-routing";
import {
	type ManagedFamilyApplyCommand,
	ManagedFamilyConversionDialog,
	managedFamilyConversionError,
	proposalRequiresExplicitReview,
} from "./ManagedFamilyConversionDialog";

const FAMILIES: ComboFamily[] = ["fable", "opus", "sonnet", "haiku"];

const FAMILY_LABELS: Record<ComboFamily, string> = {
	fable: "Fable",
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

export interface PendingManagedConversion {
	family: ComboFamily;
	managedModel: string;
}

type FamilyPolicyUpdater = (
	params: UpdateFamilyPolicyVariables,
) => Promise<unknown>;

export function buildManualFamilyPolicyUpdate(
	family: ComboFamily,
): UpdateFamilyPolicyVariables {
	return { family, membershipMode: "manual" };
}

export function runManualFamilyRollback(
	family: ComboFamily,
	update: FamilyPolicyUpdater,
): Promise<unknown> {
	return update(buildManualFamilyPolicyUpdate(family));
}

export function runSerializedFamilyPolicyUpdate(
	lock: { current: boolean },
	family: ComboFamily,
	params: UpdateFamilyPolicyVariables,
	update: FamilyPolicyUpdater,
	onAccepted: (family: ComboFamily) => void,
): Promise<void> | null {
	if (lock.current) return null;
	lock.current = true;
	onAccepted(family);

	let request: Promise<unknown>;
	try {
		request = update(params);
	} catch {
		lock.current = false;
		return Promise.resolve();
	}

	return request
		.then(
			() => undefined,
			() => undefined,
		)
		.finally(() => {
			lock.current = false;
		});
}

export function getManagedModelOptions(
	liveOptions: readonly FamilyRoutingModelOption[],
	storedModel?: string | null,
): FamilyRoutingModelOption[] {
	if (storedModel && !liveOptions.some(({ id }) => id === storedModel)) {
		return [
			{ id: storedModel, displayName: getModelDisplayName(storedModel) },
			...liveOptions,
		];
	}
	return [...liveOptions];
}

export function resolveAuthoritativeManagedModel(
	assignment: ComboFamilyAssignment | undefined,
	liveOptions: readonly FamilyRoutingModelOption[],
): string {
	return assignment?.managed_model ?? liveOptions[0]?.id ?? "";
}

export function previewMatchesPendingConversion(
	preview: ComboRoutingPreviewResult | null | undefined,
	pending: PendingManagedConversion | null,
): preview is ComboRoutingPreviewResult {
	return Boolean(
		preview &&
			pending &&
			preview.family === pending.family &&
			preview.managed_model === pending.managedModel,
	);
}

export function defaultManagedProposalId(
	preview: ComboRoutingPreviewResult,
): string | null {
	return (
		preview.proposals.find(
			(proposal) =>
				proposal.selected_by_default &&
				!proposalRequiresExplicitReview(proposal),
		)?.proposal_id ?? null
	);
}

const GENERIC_FAMILY_POLICY_ERROR =
	"The family policy was not changed. Try again.";

export function familyPolicyMutationErrorMessage(
	error: unknown,
	mutationFamily: ComboFamily | null,
	family: ComboFamily,
): string | null {
	if (!error || mutationFamily !== family) return null;
	const failure = managedFamilyConversionError(error);
	if (
		failure?.code === "managed_route_empty" ||
		failure?.code === "stale_routing_preview"
	) {
		return failure.message;
	}
	return GENERIC_FAMILY_POLICY_ERROR;
}

export function FamilyActivationSection() {
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const updateFamilyPolicy = useUpdateFamilyPolicy();
	const previewFamilyRouting = usePreviewFamilyRouting();
	const applyFamilyRoutingProposal = useApplyFamilyRoutingProposal();
	const liveModelOptions = useModelOptions();
	const familyModelOptions = useMemo<
		Record<ComboFamily, FamilyRoutingModelOption[]>
	>(
		() => ({
			fable: filterFamilyModelOptions("fable", liveModelOptions),
			opus: filterFamilyModelOptions("opus", liveModelOptions),
			sonnet: filterFamilyModelOptions("sonnet", liveModelOptions),
			haiku: filterFamilyModelOptions("haiku", liveModelOptions),
		}),
		[liveModelOptions],
	);
	const [pendingConversion, setPendingConversion] =
		useState<PendingManagedConversion | null>(null);
	const [reviewedPreview, setReviewedPreview] =
		useState<ComboRoutingPreviewResult | null>(null);
	const [previewRequestError, setPreviewRequestError] = useState<unknown>(null);
	const [previewRequestLoading, setPreviewRequestLoading] = useState(false);
	const previewRequestSequence = useRef(0);
	const familyPolicyWriteLock = useRef(false);
	const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
		null,
	);
	const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
	const [policyMutationFamily, setPolicyMutationFamily] =
		useState<ComboFamily | null>(null);
	const familyPolicyWritePending =
		familyPolicyWriteLock.current || updateFamilyPolicy.isPending;

	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];
	const enabledCombos = combos.filter((combo) => combo.enabled);

	const getFamilyAssignment = (
		family: ComboFamily,
	): ComboFamilyAssignment | undefined =>
		families.find((assignment) => assignment.family === family);

	const closeConversion = () => {
		previewRequestSequence.current += 1;
		setPendingConversion(null);
		setReviewedPreview(null);
		setPreviewRequestError(null);
		setPreviewRequestLoading(false);
		setSelectedProposalId(null);
		setReviewAcknowledged(false);
		previewFamilyRouting.reset();
		applyFamilyRoutingProposal.reset();
	};

	const requestPreview = (conversion: PendingManagedConversion) => {
		const requestSequence = previewRequestSequence.current + 1;
		previewRequestSequence.current = requestSequence;
		setReviewedPreview(null);
		setPreviewRequestError(null);
		setPreviewRequestLoading(true);
		setSelectedProposalId(null);
		setReviewAcknowledged(false);
		applyFamilyRoutingProposal.reset();
		previewFamilyRouting.reset();
		previewFamilyRouting.mutate(conversion, {
			onSuccess: (preview) => {
				if (previewRequestSequence.current !== requestSequence) return;
				if (!previewMatchesPendingConversion(preview, conversion)) {
					setPreviewRequestError({
						message: "The preview does not match the requested family policy.",
						details: { code: "stale_routing_preview" },
					});
					return;
				}
				setReviewedPreview(preview);
				setSelectedProposalId(defaultManagedProposalId(preview));
			},
			onError: (error) => {
				if (previewRequestSequence.current !== requestSequence) return;
				setPreviewRequestError(error);
			},
			onSettled: () => {
				if (previewRequestSequence.current !== requestSequence) return;
				setPreviewRequestLoading(false);
			},
		});
	};

	const openManagedConversion = (family: ComboFamily, managedModel: string) => {
		const conversion = { family, managedModel };
		setPendingConversion(conversion);
		requestPreview(conversion);
	};

	const handleToggle = (family: ComboFamily, enabled: boolean) => {
		void runSerializedFamilyPolicyUpdate(
			familyPolicyWriteLock,
			family,
			{ family, enabled },
			updateFamilyPolicy.mutateAsync,
			setPolicyMutationFamily,
		);
	};

	const handleComboSelect = (family: ComboFamily, comboId: string) => {
		void runSerializedFamilyPolicyUpdate(
			familyPolicyWriteLock,
			family,
			{
				family,
				comboId: comboId === "none" ? null : comboId,
			},
			updateFamilyPolicy.mutateAsync,
			setPolicyMutationFamily,
		);
	};

	const handleManualMode = (family: ComboFamily) => {
		void runSerializedFamilyPolicyUpdate(
			familyPolicyWriteLock,
			family,
			buildManualFamilyPolicyUpdate(family),
			updateFamilyPolicy.mutateAsync,
			setPolicyMutationFamily,
		);
	};

	const handleModelSelect = (family: ComboFamily, managedModel: string) => {
		openManagedConversion(family, managedModel);
	};

	const handleApply = (command: ManagedFamilyApplyCommand) => {
		if (
			!pendingConversion ||
			command.family !== pendingConversion.family ||
			command.managedModel !== pendingConversion.managedModel
		) {
			return;
		}
		applyFamilyRoutingProposal.mutate(command, {
			onSuccess: () => closeConversion(),
		});
	};

	const handleRetryPreview = () => {
		if (pendingConversion) requestPreview(pendingConversion);
	};

	const currentPreview = previewMatchesPendingConversion(
		reviewedPreview,
		pendingConversion,
	)
		? reviewedPreview
		: null;

	if (familiesQuery.isLoading || combosQuery.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Family Activation</CardTitle>
					<CardDescription>
						Assign combos and choose Manual or Managed routing per family
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground" aria-live="polite">
						Loading family policies…
					</p>
				</CardContent>
			</Card>
		);
	}

	if (familiesQuery.isError || combosQuery.isError) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Family Activation</CardTitle>
					<CardDescription>
						Assign combos and choose Manual or Managed routing per family
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<p className="text-sm text-destructive" role="alert">
						Failed to load family policies. Existing routing was not changed.
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void Promise.all([
								familiesQuery.refetch(),
								combosQuery.refetch(),
							]);
						}}
					>
						Retry
					</Button>
				</CardContent>
			</Card>
		);
	}

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>Family Activation</CardTitle>
					<CardDescription>
						Manual uses only persisted slots. Managed adds server-resolved
						members without deleting those slots.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-3">
						{FAMILIES.map((family) => {
							const assignment = getFamilyAssignment(family);
							const isEnabled = assignment?.enabled ?? false;
							const activeComboId = assignment?.combo_id ?? null;
							const membershipMode = assignment?.membership_mode ?? "manual";
							const modelOptions = getManagedModelOptions(
								familyModelOptions[family],
								assignment?.managed_model,
							);
							const managedModel = resolveAuthoritativeManagedModel(
								assignment,
								modelOptions,
							);
							const policyPending =
								familyPolicyWritePending && policyMutationFamily === family;
							const policyErrorMessage = updateFamilyPolicy.isError
								? familyPolicyMutationErrorMessage(
										updateFamilyPolicy.error,
										updateFamilyPolicy.variables?.family ?? null,
										family,
									)
								: null;
							const managedAvailable = isEnabled && activeComboId !== null;

							return (
								<div key={family} className="space-y-3 rounded-lg border p-3">
									<div className="grid gap-3 lg:grid-cols-[5rem_auto_minmax(12rem,1fr)_auto] lg:items-center">
										<Label className="font-medium">
											{FAMILY_LABELS[family]}
										</Label>
										<Switch
											checked={isEnabled}
											onCheckedChange={(checked) =>
												handleToggle(family, checked)
											}
											disabled={familyPolicyWritePending}
											aria-label={`Enable ${FAMILY_LABELS[family]} family`}
										/>
										<Select
											value={activeComboId ?? "none"}
											onValueChange={(value) =>
												handleComboSelect(family, value)
											}
											disabled={!isEnabled || familyPolicyWritePending}
										>
											<SelectTrigger
												className={!isEnabled ? "opacity-40" : ""}
												aria-label={`${FAMILY_LABELS[family]} active combo`}
											>
												<SelectValue placeholder="Select combo…" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="none">None</SelectItem>
												{enabledCombos.map((combo) => (
													<SelectItem key={combo.id} value={combo.id}>
														{combo.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<div className="min-w-20 text-right">
											{isEnabled && activeComboId && (
												<Badge variant="default">Active</Badge>
											)}
										</div>
									</div>

									<div className="grid gap-3 border-t pt-3 md:grid-cols-[auto_minmax(14rem,1fr)] md:items-end">
										<fieldset className="space-y-1">
											<legend className="text-sm font-medium">
												{FAMILY_LABELS[family]} routing mode
											</legend>
											<div className="flex gap-2">
												<Button
													type="button"
													size="sm"
													variant={
														membershipMode === "manual" ? "default" : "outline"
													}
													onClick={() => handleManualMode(family)}
													disabled={
														membershipMode === "manual" ||
														familyPolicyWritePending
													}
												>
													Manual
												</Button>
												<Button
													type="button"
													size="sm"
													variant={
														membershipMode === "managed" ? "default" : "outline"
													}
													onClick={() =>
														openManagedConversion(family, managedModel)
													}
													disabled={
														!managedAvailable ||
														previewRequestLoading ||
														applyFamilyRoutingProposal.isPending
													}
												>
													{membershipMode === "managed"
														? "Review Managed"
														: "Managed"}
												</Button>
											</div>
										</fieldset>

										<div className="space-y-1">
											<Label htmlFor={`${family}-managed-model`}>
												Managed logical model
											</Label>
											<Select
												value={managedModel}
												onValueChange={(value) =>
													handleModelSelect(family, value)
												}
												disabled={
													!managedAvailable ||
													previewRequestLoading ||
													applyFamilyRoutingProposal.isPending
												}
											>
												<SelectTrigger
													id={`${family}-managed-model`}
													aria-label={`${FAMILY_LABELS[family]} managed logical model`}
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{modelOptions.map((model) => (
														<SelectItem key={model.id} value={model.id}>
															{model.displayName}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<p className="text-xs text-muted-foreground">
												Changing this model opens a fresh server preview before
												it can be applied.
											</p>
										</div>
									</div>

									{!managedAvailable && (
										<p className="text-xs text-muted-foreground">
											Enable this family and select an active combo before
											previewing Managed mode.
										</p>
									)}
									{policyPending && (
										<p
											className="text-xs text-muted-foreground"
											aria-live="polite"
										>
											Saving family policy…
										</p>
									)}
									{policyErrorMessage && (
										<p className="text-xs text-destructive" role="alert">
											{policyErrorMessage}
										</p>
									)}
								</div>
							);
						})}
					</div>
				</CardContent>
			</Card>

			{pendingConversion && (
				<ManagedFamilyConversionDialog
					open
					family={pendingConversion.family}
					managedModel={pendingConversion.managedModel}
					preview={currentPreview}
					selectedProposalId={selectedProposalId}
					reviewAcknowledged={reviewAcknowledged}
					isPreviewLoading={previewRequestLoading}
					previewError={previewRequestError}
					isApplying={applyFamilyRoutingProposal.isPending}
					applyError={applyFamilyRoutingProposal.error}
					onOpenChange={(open) => {
						if (!open && !applyFamilyRoutingProposal.isPending) {
							closeConversion();
						}
					}}
					onProposalSelect={(proposalId) => {
						setSelectedProposalId(proposalId);
						setReviewAcknowledged(false);
					}}
					onReviewAcknowledgedChange={setReviewAcknowledged}
					onRetry={handleRetryPreview}
					onApply={handleApply}
				/>
			)}
		</>
	);
}
