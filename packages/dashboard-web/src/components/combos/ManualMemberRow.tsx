import type { ComboFamily, ComboSlot } from "@better-ccflare/types";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	handleComboSlotPriorityKeyDown,
	parseComboSlotPriority,
} from "./combo-slot-priority";

export interface ManualMemberRoutingFact {
	family: ComboFamily;
	reasonLabel: string;
	availabilityLabel: string;
	isManualOverride: boolean;
}

interface ManualMemberRowProps {
	slot: ComboSlot;
	index: number;
	accountName: string;
	provider: string;
	dragHandle?: ReactNode;
	routingFacts?: readonly ManualMemberRoutingFact[];
	onPriorityChange: (priority: number) => void;
	onRemove: () => void;
	isUpdatingPriority: boolean;
	isRemoving: boolean;
	priorityError?: string | null;
	removeError?: string | null;
}

function familyLabel(family: ComboFamily): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

export function ManualMemberRow({
	slot,
	index,
	accountName,
	provider,
	dragHandle,
	routingFacts = [],
	onPriorityChange,
	onRemove,
	isUpdatingPriority,
	isRemoving,
	priorityError,
	removeError,
}: ManualMemberRowProps) {
	const [priorityText, setPriorityText] = useState(String(slot.priority));

	useEffect(() => {
		setPriorityText(String(slot.priority));
	}, [slot.priority]);

	const savePriority = () => {
		const priority = parseComboSlotPriority(priorityText);
		if (priority === null) {
			setPriorityText(String(slot.priority));
			return;
		}
		if (priority !== slot.priority) onPriorityChange(priority);
	};
	const isManualOverride = routingFacts.some((fact) => fact.isManualOverride);

	return (
		<div
			className="flex items-start gap-2 rounded-md border bg-card px-3 py-2"
			data-account-id={slot.account_id}
			data-source="manual"
		>
			<span className="w-4 shrink-0 pt-1 text-center text-xs font-medium text-muted-foreground">
				{index}
			</span>
			{dragHandle}

			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="secondary" className="shrink-0 text-xs">
						{provider}
					</Badge>
					<span className="truncate text-sm font-medium">{accountName}</span>
					<Badge variant="default" className="text-xs">
						Manual
					</Badge>
					{isManualOverride && (
						<Badge variant="outline" className="text-xs">
							Manual override
						</Badge>
					)}
				</div>
				<div className="font-mono text-xs text-muted-foreground">
					{slot.model}
				</div>
				{routingFacts.map((fact) => (
					<div key={fact.family} className="text-xs text-muted-foreground">
						{familyLabel(fact.family)} · {fact.reasonLabel} ·{" "}
						{fact.availabilityLabel}
					</div>
				))}
				{priorityError && (
					<p className="text-xs text-destructive" role="alert">
						{priorityError}
					</p>
				)}
				{removeError && (
					<p className="text-xs text-destructive" role="alert">
						{removeError}
					</p>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-1 pt-0.5">
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
