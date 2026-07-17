import type { ComboSlot, ComboWithSlots } from "@better-ccflare/types";
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
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	useAccounts,
	useAddComboSlot,
	useFamilies,
	useRemoveComboSlot,
	useReorderComboSlots,
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
	handleComboSlotPriorityKeyDown,
	parseComboSlotPriority,
} from "./combo-slot-priority";

interface SortableSlotRowProps {
	slot: ComboSlot;
	index: number;
	accountName: string;
	provider: string;
	onPriorityChange: (priority: number) => void;
	onRemove: () => void;
	isUpdatingPriority: boolean;
	isRemoving: boolean;
}

function SortableSlotRow({
	slot,
	index,
	accountName,
	provider,
	onPriorityChange,
	onRemove,
	isUpdatingPriority,
	isRemoving,
}: SortableSlotRowProps) {
	const [priorityText, setPriorityText] = useState(String(slot.priority));

	useEffect(() => {
		setPriorityText(String(slot.priority));
	}, [slot.priority]);

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
	const savePriority = () => {
		const priority = parseComboSlotPriority(priorityText);
		if (priority === null) {
			setPriorityText(String(slot.priority));
			return;
		}
		if (priority !== slot.priority) onPriorityChange(priority);
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
		>
			<span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">
				{index}
			</span>
			<button
				type="button"
				aria-label={`Reorder ${accountName}`}
				className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVertical className="h-4 w-4" />
			</button>

			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Badge variant="secondary" className="shrink-0 text-xs">
					{provider}
				</Badge>
				<span className="truncate text-sm font-medium">{accountName}</span>
			</div>

			<span className="shrink-0 font-mono text-xs text-muted-foreground">
				{slot.model}
			</span>

			<div className="flex shrink-0 items-center gap-1">
				<Label
					htmlFor={`combo-slot-priority-${slot.id}`}
					className="text-[10px] text-muted-foreground"
				>
					Tier
				</Label>
				<Input
					id={`combo-slot-priority-${slot.id}`}
					aria-label={`Priority tier for ${accountName}`}
					type="number"
					min={0}
					max={100}
					step={1}
					value={priorityText}
					onChange={(event) => setPriorityText(event.target.value)}
					onBlur={savePriority}
					onKeyDown={(event) => {
						handleComboSlotPriorityKeyDown(event.key, slot.priority, {
							reset: setPriorityText,
							requestCommit: () => event.currentTarget.blur(),
						});
					}}
					disabled={isUpdatingPriority}
					className="h-7 w-16 px-2 text-xs"
				/>
			</div>

			<Button
				variant="ghost"
				size="sm"
				aria-label={`Remove ${accountName}`}
				onClick={onRemove}
				disabled={isRemoving}
				className="shrink-0 text-destructive hover:text-destructive"
			>
				<Trash2 className="h-4 w-4" />
			</Button>
		</div>
	);
}

interface ComboSlotBuilderProps {
	combo: ComboWithSlots;
}

export function ComboSlotBuilder({ combo }: ComboSlotBuilderProps) {
	const [showAddForm, setShowAddForm] = useState(false);
	const [newAccountId, setNewAccountId] = useState("");
	const [newModel, setNewModel] = useState("");
	const [newPriority, setNewPriority] = useState("0");

	const accountsQuery = useAccounts();
	const familiesQuery = useFamilies();
	const addSlot = useAddComboSlot();
	const updateSlot = useUpdateComboSlot();
	const removeSlot = useRemoveComboSlot();
	const reorderSlots = useReorderComboSlots();

	const accounts = accountsQuery.data ?? [];
	const families = familiesQuery.data?.families ?? [];
	const assignedFamily = families.find((f) => f.combo_id === combo.id);

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

		const oldIndex = combo.slots.findIndex((s) => s.id === active.id);
		const newIndex = combo.slots.findIndex((s) => s.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;

		const reordered = [...combo.slots];
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
		setNewPriority(String(getDefaultComboSlotPriority(combo.slots)));
		setShowAddForm(true);
	};

	const parsedNewPriority = parseComboSlotPriority(newPriority);

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">Slots</CardTitle>
					<Button variant="outline" size="sm" onClick={toggleAddForm}>
						<Plus className="mr-1 h-3 w-3" />
						Add Slot
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				<div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
					Lower-numbered tiers route first. Slots sharing a tier dynamically
					balance by comparable quota pressure. {COMBO_REORDER_WARNING}
				</div>
				{assignedFamily && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span>Assigned to:</span>
						<Badge variant="default" className="text-xs">
							{assignedFamily.family.charAt(0).toUpperCase() +
								assignedFamily.family.slice(1)}
						</Badge>
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
					</div>
				)}

				{combo.slots.length === 0 && !showAddForm && (
					<p className="py-2 text-center text-sm text-muted-foreground">
						No slots yet. Add a slot to define the fallback chain.
					</p>
				)}

				{combo.slots.length > 0 && (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={combo.slots.map((s) => s.id)}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-1">
								{combo.slots.map((slot, index) => {
									const { name, provider } = getAccountInfo(slot.account_id);
									return (
										<SortableSlotRow
											key={slot.id}
											slot={slot}
											accountName={name}
											provider={provider}
											index={index + 1}
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
											isRemoving={removeSlot.isPending}
											isUpdatingPriority={updateSlot.isPending}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>
				)}
			</CardContent>
		</Card>
	);
}
