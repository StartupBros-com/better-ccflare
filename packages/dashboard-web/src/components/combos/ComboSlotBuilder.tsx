import type {
	ComboFamilyAssignment,
	ComboWithSlots,
} from "@better-ccflare/types";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import { useRef, useState } from "react";
import {
	useAccounts,
	useAddComboSlot,
	useEffectiveRouting,
	useExcludeAccountFromFamily,
	useFamilies,
	useRemoveComboSlot,
	useReorderComboSlots,
	useRestoreAccountToFamily,
	useUpdateComboSlot,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	COMBO_REORDER_WARNING,
	getDefaultComboSlotPriority,
	parseComboSlotPriority,
} from "./combo-slot-priority";
import {
	type FamilyRoutingProjection,
	projectFamilyRoutings,
} from "./family-routing";
import { ManagedExclusionList } from "./ManagedExclusionList";
import {
	ManagedMemberList,
	type ManagedRoutingTarget,
} from "./ManagedMemberList";
import {
	type ManualMemberRoutingFact,
	ManualMemberRow,
} from "./ManualMemberRow";

interface SortableManualMemberRowProps {
	slot: ComboWithSlots["slots"][number];
	index: number;
	accountName: string;
	provider: string;
	routingFacts: readonly ManualMemberRoutingFact[];
	onPriorityChange: (priority: number) => void;
	onRemove: () => void;
	isUpdatingPriority: boolean;
	isRemoving: boolean;
	priorityError?: string | null;
	removeError?: string | null;
}

function SortableManualMemberRow({
	slot,
	index,
	accountName,
	provider,
	routingFacts,
	onPriorityChange,
	onRemove,
	isUpdatingPriority,
	isRemoving,
	priorityError,
	removeError,
}: SortableManualMemberRowProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: slot.id });
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div ref={setNodeRef} style={style}>
			<ManualMemberRow
				slot={slot}
				index={index}
				accountName={accountName}
				provider={provider}
				routingFacts={routingFacts}
				onPriorityChange={onPriorityChange}
				onRemove={onRemove}
				isUpdatingPriority={isUpdatingPriority}
				isRemoving={isRemoving}
				priorityError={priorityError}
				removeError={removeError}
				dragHandle={
					<button
						type="button"
						aria-label={`Reorder ${accountName}`}
						className="mt-1 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVertical className="h-4 w-4" />
					</button>
				}
			/>
		</div>
	);
}

interface ComboSlotBuilderProps {
	combo: ComboWithSlots;
}

export interface SerializedTargetMutation<TTarget> {
	isLocked: () => boolean;
	run: (target: TTarget) => Promise<"started" | "ignored">;
}

/**
 * Keep one mutation observer from switching targets while a request is in
 * flight. The synchronous lock also covers a second click before React can
 * render the observer's pending state.
 */
export function createSerializedTargetMutation<TTarget>(
	execute: (target: TTarget) => Promise<unknown>,
): SerializedTargetMutation<TTarget> {
	let locked = false;
	return {
		isLocked: () => locked,
		run: async (target) => {
			if (locked) return "ignored";
			locked = true;
			try {
				await execute(target);
				return "started";
			} finally {
				locked = false;
			}
		},
	};
}

function useSerializedTargetMutation<TTarget>(
	execute: (target: TTarget) => Promise<unknown>,
): SerializedTargetMutation<TTarget> {
	const executeRef = useRef(execute);
	executeRef.current = execute;
	const mutationRef = useRef<SerializedTargetMutation<TTarget> | null>(null);
	if (!mutationRef.current) {
		mutationRef.current = createSerializedTargetMutation((target) =>
			executeRef.current(target),
		);
	}
	return mutationRef.current;
}

interface ComboEditorFamilyRoutingState {
	family: ComboFamilyAssignment["family"];
	assignment: ComboFamilyAssignment;
	projection?: FamilyRoutingProjection;
}

/**
 * Prefer the coherent routing snapshot over the independently refreshed family
 * list, while keeping a listed assignment visible when no snapshot exists.
 */
function buildComboEditorFamilyRoutingStates(
	comboId: string,
	assignments: readonly ComboFamilyAssignment[],
	projections: readonly FamilyRoutingProjection[],
): ComboEditorFamilyRoutingState[] {
	const projectionByFamily = new Map(
		projections.map((projection) => [projection.family, projection]),
	);
	const statesByFamily = new Map<
		ComboFamilyAssignment["family"],
		ComboEditorFamilyRoutingState
	>();

	for (const listedAssignment of assignments) {
		if (listedAssignment.combo_id !== comboId) continue;
		const projection = projectionByFamily.get(listedAssignment.family);
		if (projection && projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(listedAssignment.family, {
			family: listedAssignment.family,
			assignment: projection?.assignment ?? listedAssignment,
			projection,
		});
	}

	for (const projection of projections) {
		if (projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(projection.family, {
			family: projection.family,
			assignment: projection.assignment,
			projection,
		});
	}

	return [...statesByFamily.values()];
}

function manualRoutingFactsBySlot(
	projections: readonly FamilyRoutingProjection[],
): Map<string, ManualMemberRoutingFact[]> {
	const factsBySlot = new Map<string, ManualMemberRoutingFact[]>();

	for (const projection of projections) {
		const overrideReasonsByAccountId = new Map(
			projection.decisions
				.filter(({ decision }) => decision.reason === "manual_override")
				.map(({ decision, reasonLabel }) => [decision.account_id, reasonLabel]),
		);
		for (const projected of projection.manualMembers) {
			const slotId = projected.member.slot_id;
			if (!slotId) continue;
			const overrideReason = overrideReasonsByAccountId.get(
				projected.member.account_id,
			);
			const isManualOverride = overrideReason !== undefined;
			const fact: ManualMemberRoutingFact = {
				family: projection.family,
				reasonLabel: overrideReason ?? projected.reasonLabel,
				availabilityLabel: projected.availabilityLabel,
				isManualOverride,
			};
			const existing = factsBySlot.get(slotId);
			if (existing) existing.push(fact);
			else factsBySlot.set(slotId, [fact]);
		}
	}

	return factsBySlot;
}

export function ComboSlotBuilder({ combo }: ComboSlotBuilderProps) {
	const [showAddForm, setShowAddForm] = useState(false);
	const [newAccountId, setNewAccountId] = useState("");
	const [newModel, setNewModel] = useState("");
	const [newPriority, setNewPriority] = useState("0");

	const accountsQuery = useAccounts();
	const familiesQuery = useFamilies();
	const effectiveRoutingQuery = useEffectiveRouting();
	const addSlot = useAddComboSlot();
	const updateSlot = useUpdateComboSlot();
	const removeSlot = useRemoveComboSlot();
	const reorderSlots = useReorderComboSlots();
	const excludeAccount = useExcludeAccountFromFamily();
	const restoreAccount = useRestoreAccountToFamily();
	const serializedExclude = useSerializedTargetMutation<ManagedRoutingTarget>(
		(target) => excludeAccount.mutateAsync(target),
	);
	const serializedRestore = useSerializedTargetMutation<ManagedRoutingTarget>(
		(target) => restoreAccount.mutateAsync(target),
	);

	const accounts = accountsQuery.data ?? [];
	const families = familiesQuery.data?.families ?? [];
	const effectiveRoutingUnavailable =
		effectiveRoutingQuery.isError || effectiveRoutingQuery.isRefetchError;
	// TanStack deliberately retains successful data after a refetch failure. Do
	// not combine that stale snapshot with newer combo or family query results.
	const effectiveData = effectiveRoutingUnavailable
		? undefined
		: effectiveRoutingQuery.data;
	const effectiveViews = effectiveData
		? Array.isArray(effectiveData)
			? effectiveData
			: [effectiveData]
		: [];
	const projections = projectFamilyRoutings(effectiveViews);
	const assignedFamilyStates = buildComboEditorFamilyRoutingStates(
		combo.id,
		families,
		projections,
	);
	const assignedProjections = assignedFamilyStates.flatMap(({ projection }) =>
		projection ? [projection] : [],
	);
	const coherentPolicyProjection = assignedFamilyStates.find(
		({ projection }) => projection !== undefined,
	)?.projection;
	// The dialog combo is a fallback for an unassigned or unavailable effective
	// snapshot only. Never mix its independently refetched slots with one.
	const persistedManualSlots =
		coherentPolicyProjection?.manualSlots ?? combo.slots;
	const slotRoutingFacts = manualRoutingFactsBySlot(assignedProjections);
	const excludePendingTarget: ManagedRoutingTarget | null =
		excludeAccount.isPending && excludeAccount.variables
			? excludeAccount.variables
			: null;
	const restorePendingTarget: ManagedRoutingTarget | null =
		restoreAccount.isPending && restoreAccount.variables
			? restoreAccount.variables
			: null;
	const excludeErrorTarget: ManagedRoutingTarget | null =
		excludeAccount.isError && excludeAccount.variables
			? excludeAccount.variables
			: null;
	const restoreErrorTarget: ManagedRoutingTarget | null =
		restoreAccount.isError && restoreAccount.variables
			? restoreAccount.variables
			: null;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);

	const getAccountInfo = (accountId: string) => {
		const account = accounts.find((a) => a.id === accountId);
		return {
			name: account?.name ?? accountId,
			provider: account?.provider ?? "unknown",
		};
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const oldIndex = persistedManualSlots.findIndex((s) => s.id === active.id);
		const newIndex = persistedManualSlots.findIndex((s) => s.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;

		const reordered = [...persistedManualSlots];
		const [moved] = reordered.splice(oldIndex, 1);
		reordered.splice(newIndex, 0, moved);

		reorderSlots.mutate({
			comboId: combo.id,
			slotIds: reordered.map((s) => s.id),
		});
	};

	const handleAddSlot = () => {
		const priority = parseComboSlotPriority(newPriority);
		if (!newAccountId || !newModel.trim() || priority === null) return;
		addSlot.mutate(
			{
				comboId: combo.id,
				params: {
					account_id: newAccountId,
					model: newModel.trim(),
					priority,
				},
			},
			{
				onSuccess: () => {
					setNewAccountId("");
					setNewModel("");
					setNewPriority("0");
					setShowAddForm(false);
				},
			},
		);
	};

	const closeAddForm = () => {
		addSlot.reset();
		setShowAddForm(false);
		setNewAccountId("");
		setNewModel("");
		setNewPriority("0");
	};

	const toggleAddForm = () => {
		if (showAddForm) {
			closeAddForm();
			return;
		}
		setNewPriority(String(getDefaultComboSlotPriority(persistedManualSlots)));
		addSlot.reset();
		setShowAddForm(true);
	};

	const parsedNewPriority = parseComboSlotPriority(newPriority);
	const excludeManagedAccount = (target: ManagedRoutingTarget) => {
		if (effectiveRoutingUnavailable) return;
		void serializedExclude.run(target).catch(() => undefined);
	};
	const restoreManagedAccount = (target: ManagedRoutingTarget) => {
		if (effectiveRoutingUnavailable) return;
		void serializedRestore.run(target).catch(() => undefined);
	};

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">
						Persisted Manual slots ({persistedManualSlots.length})
					</CardTitle>
					<Button variant="outline" size="sm" onClick={toggleAddForm}>
						<Plus className="mr-1 h-3 w-3" />
						Add Manual slot
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				<div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
					Lower-numbered tiers route first. Slots sharing a tier dynamically
					balance by comparable quota pressure. {COMBO_REORDER_WARNING}
				</div>
				{effectiveRoutingUnavailable && (
					<div
						className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2"
						role="alert"
					>
						<div className="space-y-1">
							<p className="text-sm font-medium text-destructive">
								Authoritative routing could not be refreshed.
							</p>
							<p className="text-xs text-muted-foreground">
								Manual slot editing is using the current combo and family
								configuration. Managed membership and exception actions are
								unavailable until retry succeeds.
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							aria-label="Retry authoritative routing"
							onClick={() => void effectiveRoutingQuery.refetch()}
							disabled={effectiveRoutingQuery.isFetching}
						>
							{effectiveRoutingQuery.isFetching
								? "Retrying…"
								: "Retry authoritative routing"}
						</Button>
					</div>
				)}
				{assignedFamilyStates.length > 0 && (
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span>Assigned families:</span>
						{assignedFamilyStates.map(({ family, assignment }) => (
							<Badge
								key={family}
								variant="default"
								className="text-xs capitalize"
							>
								{family} · {assignment.membership_mode}
							</Badge>
						))}
					</div>
				)}
				{showAddForm && (
					<div className="space-y-3 rounded-md border border-dashed p-3">
						<div className="space-y-1.5">
							<Label>Account</Label>
							<Select value={newAccountId} onValueChange={setNewAccountId}>
								<SelectTrigger>
									<SelectValue placeholder="Select account...">
										{newAccountId &&
											(() => {
												const acc = accounts.find((a) => a.id === newAccountId);
												return acc ? acc.name : newAccountId;
											})()}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{accounts.map((account) => (
										<SelectItem key={account.id} value={account.id}>
											<span className="flex items-center gap-2">
												<Badge variant="secondary" className="text-xs">
													{account.provider}
												</Badge>
												{account.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label>Model</Label>
							<Input
								value={newModel}
								onChange={(e) => setNewModel(e.target.value)}
								placeholder="claude-3-opus"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="new-combo-slot-priority">Priority tier</Label>
							<Input
								id="new-combo-slot-priority"
								type="number"
								min={0}
								max={100}
								step={1}
								value={newPriority}
								onChange={(event) => setNewPriority(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Use the same tier for accounts that should dynamically share
								this lane.
							</p>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="outline" size="sm" onClick={closeAddForm}>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={handleAddSlot}
								disabled={
									!newAccountId ||
									!newModel.trim() ||
									parsedNewPriority === null ||
									addSlot.isPending
								}
							>
								{addSlot.isPending ? "Adding..." : "Add"}
							</Button>
						</div>
						{addSlot.isError && (
							<p className="text-xs text-destructive" role="alert">
								Could not add this Manual slot. No persisted slots were changed.
							</p>
						)}
					</div>
				)}

				{persistedManualSlots.length === 0 && !showAddForm && (
					<p className="py-2 text-center text-sm text-muted-foreground">
						No slots yet. Add a slot to define the fallback chain.
					</p>
				)}

				{persistedManualSlots.length > 0 && (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={persistedManualSlots.map((s) => s.id)}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-1">
								{persistedManualSlots.map((slot, index) => {
									const { name, provider } = getAccountInfo(slot.account_id);
									return (
										<SortableManualMemberRow
											key={slot.id}
											slot={slot}
											accountName={name}
											provider={provider}
											index={index + 1}
											routingFacts={slotRoutingFacts.get(slot.id) ?? []}
											onPriorityChange={(priority) =>
												updateSlot.mutate({
													comboId: combo.id,
													slotId: slot.id,
													params: { priority },
												})
											}
											onRemove={() =>
												removeSlot.mutate({
													comboId: combo.id,
													slotId: slot.id,
												})
											}
											isRemoving={
												removeSlot.isPending &&
												removeSlot.variables?.slotId === slot.id
											}
											isUpdatingPriority={
												updateSlot.isPending &&
												updateSlot.variables?.slotId === slot.id
											}
											priorityError={
												updateSlot.isError &&
												updateSlot.variables?.slotId === slot.id
													? "Could not update this Manual slot tier."
													: null
											}
											removeError={
												removeSlot.isError &&
												removeSlot.variables?.slotId === slot.id
													? "Could not remove this Manual slot."
													: null
											}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>
				)}
				{reorderSlots.isError && (
					<p className="text-xs text-destructive" role="alert">
						Could not reorder Manual slots. The persisted order is unchanged.
					</p>
				)}

				<div className="space-y-4 border-t pt-4">
					<div>
						<h3 className="text-sm font-medium">Resolved family routing</h3>
						<p className="text-xs text-muted-foreground">
							Authoritative membership is shown separately for every family
							assigned to this combo. Managed members do not change the
							persisted slot count.
						</p>
					</div>

					{assignedFamilyStates.length === 0 && (
						<p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
							This combo is not assigned to a model family.
						</p>
					)}

					{assignedFamilyStates.map(
						({ family, assignment: policyAssignment, projection }) => {
							const managedActive =
								policyAssignment.membership_mode === "managed" &&
								policyAssignment.enabled;
							return (
								<div key={family} className="space-y-3 rounded-md border p-3">
									<div className="flex flex-wrap items-center gap-2">
										<Badge className="capitalize">{family}</Badge>
										<Badge variant="outline" className="capitalize">
											{policyAssignment.membership_mode}
										</Badge>
										{policyAssignment.managed_model && (
											<span className="font-mono text-xs text-muted-foreground">
												{policyAssignment.managed_model}
											</span>
										)}
									</div>

									{projection && managedActive ? (
										<>
											<ManagedMemberList
												family={family}
												members={projection.managedMembers}
												onExclude={excludeManagedAccount}
												pendingTarget={excludePendingTarget}
												errorTarget={excludeErrorTarget}
												mutationPending={excludeAccount.isPending}
											/>
											<ManagedExclusionList
												family={family}
												decisions={projection.decisions}
												exclusions={projection.exclusions}
												accountNameFor={(accountId) =>
													getAccountInfo(accountId).name
												}
												onRestore={restoreManagedAccount}
												pendingTarget={restorePendingTarget}
												errorTarget={restoreErrorTarget}
												mutationPending={restoreAccount.isPending}
											/>
										</>
									) : projection ? (
										<div className="space-y-3">
											<p className="text-xs text-muted-foreground">
												{policyAssignment.membership_mode === "manual"
													? "Managed routing is off. Only persisted enabled Manual slots can route."
													: "This family is disabled. No resolved members can route."}
											</p>
											<p className="text-xs text-muted-foreground">
												{projection.rules.length} saved{" "}
												{projection.rules.length === 1 ? "rule" : "rules"}
												{" · "}
												{projection.exclusions.length} saved{" "}
												{projection.exclusions.length === 1
													? "exclusion"
													: "exclusions"}
											</p>
											<ManagedExclusionList
												family={family}
												decisions={[]}
												exclusions={projection.exclusions}
												accountNameFor={(accountId) =>
													getAccountInfo(accountId).name
												}
												onRestore={restoreManagedAccount}
												pendingTarget={restorePendingTarget}
												errorTarget={restoreErrorTarget}
												mutationPending={restoreAccount.isPending}
											/>
										</div>
									) : (
										<p className="text-xs text-muted-foreground">
											{effectiveRoutingQuery.isLoading
												? "Loading authoritative routing…"
												: "Authoritative routing is unavailable for this family."}
										</p>
									)}
								</div>
							);
						},
					)}
				</div>
			</CardContent>
		</Card>
	);
}
